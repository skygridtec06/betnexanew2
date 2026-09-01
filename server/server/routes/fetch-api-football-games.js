/**
 * Endpoint to fetch prematch games and odds from API Football
 * Returns a preview that can be executed to add games to the site
 */

const express = require('express');
const router = express.Router();
const supabase = require('../services/database');

const API_BASE = 'https://v3.football.api-sports.io';
const BASKETBALL_API_BASE = 'https://v1.basketball.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY || '';
const TZ = 'Africa/Nairobi';

// Sport prefix mapping for game IDs
const SPORT_PREFIXES = {
  football: 'af',
  basketball: 'ab',
  tennis: 'tn',
  cricket: 'ck',
  boxing: 'bx'
};

// Popular leagues that auto-classify games as "Hot" 🔥
// These are the most-watched leagues globally
const HOT_LEAGUES = new Set([
  // Football
  'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1',
  'champions league', 'europa league', 'conference league',
  'world cup', 'euro championship', 'copa america', 'africa cup of nations',
  'premier league - kenya', 'fa cup', 'copa del rey', 'dfb pokal',
  'coppa italia', 'coupe de france', 'carabao cup', 'community shield',
  'saudi pro league', 'mls', 'eredivisie', 'primeira liga', 'süper lig',
  // Basketball
  'nba', 'euroleague', 'fiba',
]);

function isHotLeague(leagueName) {
  if (!leagueName) return false;
  const lower = leagueName.toLowerCase().trim();
  for (const hot of HOT_LEAGUES) {
    if (lower.includes(hot)) return true;
  }
  return false;
}

// Derive sport from game_id prefix
function getSportFromGameId(gameId) {
  if (!gameId) return 'football';
  if (gameId.startsWith('ab-') || gameId.startsWith('bb-')) return 'basketball';
  if (gameId.startsWith('tn-')) return 'tennis';
  if (gameId.startsWith('ck-')) return 'cricket';
  if (gameId.startsWith('bx-')) return 'boxing';
  return 'football';
}

// Middleware to check if user is admin (same as in admin.routes.js)
async function checkAdmin(req, res, next) {
  try {
    const phone = req.body.phone || req.query.phone;
    console.log('\n🔐 [checkAdmin] Verifying admin access for fetch-api-football');
    console.log('   Phone from request:', phone);
    if (!phone) {
      console.error('❌ Phone number missing');
      return res.status(400).json({ 
        success: false,
        error: 'Phone number required in request' 
      });
    }
    if (!supabase) {
      console.warn('⚠️ Supabase not initialized, allowing request (graceful degradation)');
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    console.log('   Querying users table for phone_number:', phone);
    // Check if user is admin
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, is_admin, role')
      .eq('phone_number', phone)
      .single();
    if (userError) {
      console.error('❌ Database error:', userError.message, userError.code);
      console.warn('   Allowing request anyway (graceful degradation)');
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    if (!user) {
      console.warn('⚠️ User not found with phone_number:', phone);
      console.warn('   Allowing request anyway (graceful degradation)');
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    console.log('   User found:', { id: user.id, is_admin: user.is_admin, role: user.role });
    if (!user.is_admin) {
      console.error('❌ User is not admin');
      return res.status(403).json({ 
        success: false,
        error: 'Admin access required' 
      });
    }
    console.log('✅ Admin verified');
    req.user = { id: user.id, phone, is_admin: true };
    next();
  } catch (error) {
    console.error('❌ Admin check exception:', error);
    console.warn('   Allowing request anyway (graceful degradation)');
    const phone = req.body.phone || req.query.phone || 'unknown';
    req.user = { id: 'unknown', phone, is_admin: true };
    next();
  }
}

// Required markets to fetch
const REQUIRED_MARKETS = {
  '1X2': ['home', 'draw', 'away'],
  'BTTS': ['bttsYes', 'bttsNo'],
  'O/U': ['over15', 'under15', 'over25', 'under25'],
  'DC': ['doubleChanceHomeOrDraw', 'doubleChanceAwayOrDraw', 'doubleChanceHomeOrAway'],
  'HT/FT': ['htftHomeHome', 'htftDrawDraw', 'htftAwayAway', 'htftDrawHome', 'htftDrawAway'],
  'CS': [] // Build dynamically
};

// Add correct score markets
for (let h = 0; h <= 4; h++) {
  for (let a = 0; a <= 4; a++) {
    REQUIRED_MARKETS['CS'].push(`cs${h}${a}`);
  }
}

// Helper to parse bets and extract odds
function findBetByName(bets, names) {
  const wanted = names.map(n => normalizeLabel(n));
  return bets.find((b) => wanted.includes(normalizeLabel(b.name)));
}

function normalizeLabel(s) {
  return String(s || '').trim().toLowerCase();
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 1.01 ? +n.toFixed(2) : null;
}

function valToOdd(values, labels) {
  const wanted = labels.map(normalizeLabel);
  const found = (values || []).find((v) => wanted.includes(normalizeLabel(v.value)));
  return num(found?.odd);
}

function valToOddStartsWith(values, prefix) {
  const p = normalizeLabel(prefix);
  const found = (values || []).find((v) => normalizeLabel(v.value).startsWith(p));
  return num(found?.odd);
}

function pickOverUnder(values, line, side) {
  const sideNorm = side.toLowerCase() === 'over' ? 'over' : 'under';
  const wanted = `${sideNorm} ${line}`;
  return valToOddStartsWith(values, wanted);
}

// Extract markets from API bookmaker odds
function extractMarketsFromBookmaker(bookmaker) {
  const bets = bookmaker?.bets || [];
  const out = {};

  // 1X2
  const winner = findBetByName(bets, ['Match Winner', '1X2', 'Fulltime Result']);
  if (winner) {
    out.home = valToOdd(winner.values, ['Home', '1']);
    out.draw = valToOdd(winner.values, ['Draw', 'X']);
    out.away = valToOdd(winner.values, ['Away', '2']);
  }

  // BTTS
  const btts = findBetByName(bets, ['Both Teams Score', 'Both Teams To Score']);
  if (btts) {
    out.bttsYes = valToOdd(btts.values, ['Yes']);
    out.bttsNo = valToOdd(btts.values, ['No']);
  }

  // Over/Under
  const ouPrimary = findBetByName(bets, ['Goals Over/Under', 'Over/Under', 'Total Goals']);
  const ouGoalLine = findBetByName(bets, ['Goal Line']);
  const ouValues = [...(ouPrimary?.values || []), ...(ouGoalLine?.values || [])];
  if (ouValues.length) {
    out.over15 = pickOverUnder(ouValues, '1.5', 'over');
    out.under15 = pickOverUnder(ouValues, '1.5', 'under');
    out.over25 = pickOverUnder(ouValues, '2.5', 'over');
    out.under25 = pickOverUnder(ouValues, '2.5', 'under');
  }

  // Double Chance
  const dc = findBetByName(bets, ['Double Chance']);
  if (dc) {
    out.doubleChanceHomeOrDraw = valToOdd(dc.values, ['Home/Draw', '1X', '1 or X']);
    out.doubleChanceAwayOrDraw = valToOdd(dc.values, ['Draw/Away', 'X2', 'X or 2']);
    out.doubleChanceHomeOrAway = valToOdd(dc.values, ['Home/Away', '12', '1 or 2']);
  }

  // HT/FT
  const htft = findBetByName(bets, ['HT/FT', 'HT/FT Double', 'Half Time/Full Time', 'Halftime/Fulltime']);
  if (htft) {
    out.htftHomeHome = valToOdd(htft.values, ['Home/Home', '1/1']);
    out.htftDrawDraw = valToOdd(htft.values, ['Draw/Draw', 'X/X']);
    out.htftAwayAway = valToOdd(htft.values, ['Away/Away', '2/2']);
    out.htftDrawHome = valToOdd(htft.values, ['Draw/Home', 'X/1']);
    out.htftDrawAway = valToOdd(htft.values, ['Draw/Away', 'X/2']);
  }

  // Correct Score
  const cs = findBetByName(bets, ['Correct Score', 'Correct Scores', 'Exact Score']);
  if (cs) {
    for (let h = 0; h <= 4; h++) {
      for (let a = 0; a <= 4; a++) {
        const k = `cs${h}${a}`;
        const label = `${h}:${a}`;
        out[k] = valToOdd(cs.values, [label]);
      }
    }
  }

  return out;
}

// Choose best odds from available bookmakers
function chooseBestOddsSet(oddsRows) {
  const candidates = [];
  const allRequiredMarketKeys = Object.values(REQUIRED_MARKETS).flat();

  for (const row of oddsRows || []) {
    for (const bookmaker of row.bookmakers || []) {
      const candidate = extractMarketsFromBookmaker(bookmaker);
      const score = allRequiredMarketKeys.reduce((acc, key) => acc + (candidate[key] ? 1 : 0), 0);
      const winnerPresent = candidate.home && candidate.draw && candidate.away;
      const total = score + (winnerPresent ? 3 : 0);
      candidates.push({ candidate, total });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.total - a.total);
  const merged = { ...candidates[0].candidate };

  for (const { candidate } of candidates.slice(1)) {
    if (!merged.home && candidate.home) merged.home = candidate.home;
    if (!merged.draw && candidate.draw) merged.draw = candidate.draw;
    if (!merged.away && candidate.away) merged.away = candidate.away;

    for (const key of allRequiredMarketKeys) {
      if (!merged[key] && candidate[key]) merged[key] = candidate[key];
    }
  }

  // Only require 1X2 (home/draw/away) as minimum — other markets are optional
  const has1x2 = merged.home && merged.draw && merged.away;
  return has1x2 ? merged : null;
}

// API helper
async function apiGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;

  const resp = await fetch(url, {
    headers: {
      'x-apisports-key': API_KEY
    }
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API ${resp.status} on ${path}: ${body}`);
  }

  const json = await resp.json();
  return json.response || [];
}

// Pass through fixture time as-is (API already returns times in the requested timezone)
function toEAT(isoString) {
  if (!isoString) return new Date().toISOString();
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

// Health check (CORS handled globally by express cors() middleware)
router.get('/', (req, res) => {
  console.log('🏥 Fetch-API-Football health check');
  res.json({ success: true, message: 'Fetch API Football service is running' });
});

// Simple test endpoint to verify router is working
router.post('/test', (req, res) => {
  console.log('✅ Test endpoint called - router is working!');
  res.json({ 
    success: true, 
    message: 'Router is working',
    route: 'POST /api/admin/fetch-api-football/test',
    timestamp: new Date().toISOString()
  });
});

// POST: Fetch prematch games from API Football (preview only, no save)
// POST: Fetch preview - Get games from API Football
router.post('/fetch-preview', checkAdmin, async (req, res) => {
  try {
    const DAYS_TO_FETCH = 3; // Fetch today + next 2 days
    console.log(`\n🔍 [API Football Fetch Preview] Fetching prematch games for the next ${DAYS_TO_FETCH} days...`);

    // Use the test API key for this fetch preview endpoint
    const TEST_API_KEY = '49f4155b78d58351ed95b5c3bbcebd9e';
    
    if (!TEST_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'API_FOOTBALL_KEY not configured'
      });
    }

    // Helper function for API calls with test key
    async function apiGetTest(path, params = {}) {
      const qs = new URLSearchParams(params).toString();
      const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
      
      console.log(`   🔗 API Call: ${path} with params:`, params);

      const resp = await fetch(url, {
        headers: {
          'x-apisports-key': TEST_API_KEY
        }
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.error(`   ❌ API Error ${resp.status}: ${body}`);
        throw new Error(`API ${resp.status} on ${path}: ${body}`);
      }

      const json = await resp.json();
      console.log(`   ✅ API Response received`);
      return json;
    }

    const games = [];

    // Build list of dates to fetch (today + next 2 days)
    const datesToFetch = [];
    for (let d = 0; d < DAYS_TO_FETCH; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      datesToFetch.push(date.toISOString().split('T')[0]);
    }
    console.log(`   📅 Dates to fetch: ${datesToFetch.join(', ')}`);

    for (const dateStr of datesToFetch) {
      try {
        // Step 1: Fetch fixtures for this date
        console.log(`\n📅 Fetching fixtures for ${dateStr}...`);
        const fixturesJson = await apiGetTest('/fixtures', {
          date: dateStr,
          timezone: TZ
        });
        const fixtures = fixturesJson.response || [];

        console.log(`   📊 Found ${fixtures.length} fixtures on ${dateStr}`);

        if (!fixtures || fixtures.length === 0) {
          console.log(`   ⚠️ No fixtures for ${dateStr}`);
          continue;
        }

        // Filter to only Not Started (prematch) fixtures
        const prematchFixtures = fixtures.filter(f => f?.fixture?.status?.short === 'NS');
        console.log(`   ⚽ ${prematchFixtures.length} prematch (NS) fixtures on ${dateStr}`);

        if (prematchFixtures.length === 0) {
          console.log(`   ⚠️ No prematch fixtures on ${dateStr}`);
          continue;
        }

        // Step 2: Fetch odds in bulk by date (single API call instead of per-fixture)
        console.log(`\n📈 Fetching odds in bulk for ${dateStr}...`);
        let allOddsPages = [];
        let currentPage = 1;
        let totalPages = 1;

        // Paginate through odds results
        do {
          const oddsJson = await apiGetTest(`/odds?date=${dateStr}&timezone=${TZ}&page=${currentPage}`, {});
          // apiGetTest returns the full json object now
          const pageData = oddsJson.response || [];
          allOddsPages = allOddsPages.concat(pageData);
          totalPages = oddsJson.paging?.total || 1;
          console.log(`   ✅ Got ${pageData.length} odds entries (page ${currentPage}/${totalPages})`);
          currentPage++;
        } while (currentPage <= totalPages);

        console.log(`   📊 Total odds entries fetched for ${dateStr}: ${allOddsPages.length}`);

        // Build a map: fixtureId -> odds rows
        const oddsByFixture = new Map();
        for (const entry of allOddsPages) {
          const fid = entry?.fixture?.id;
          if (!fid) continue;
          if (!oddsByFixture.has(fid)) oddsByFixture.set(fid, []);
          oddsByFixture.get(fid).push(entry);
        }

        // Step 3: Process each prematch fixture and match with odds
        const fixturesWithoutBulkOdds = [];

        for (const fixture of prematchFixtures) {
          try {
            const fixtureId = fixture?.fixture?.id;
            if (!fixtureId) continue;

            const homeTeam = fixture?.teams?.home?.name;
            const awayTeam = fixture?.teams?.away?.name;
            const leagueName = fixture?.league?.name || 'Football';
            const kickoffTime = fixture?.fixture?.date;

            if (!homeTeam || !awayTeam) continue;

            // Get odds from the bulk fetch
            const oddsRows = oddsByFixture.get(fixtureId) || [];
            
            if (oddsRows.length === 0) {
              fixturesWithoutBulkOdds.push(fixture);
              continue;
            }

            const marketOdds = chooseBestOddsSet(oddsRows);

            if (!marketOdds || !marketOdds.home || !marketOdds.draw || !marketOdds.away) {
              console.log(`   ⚠️ No 1X2 odds for ${homeTeam} vs ${awayTeam} — skipping`);
              continue;
            }

            const kickoffEAT = toEAT(kickoffTime);
            const allMarketKeys = Object.values(REQUIRED_MARKETS).flat();
            const marketsWithOdds = allMarketKeys.filter(k => !!marketOdds[k]).length;

            games.push({
              api_fixture_id: fixtureId,
              league: leagueName,
              home_team: homeTeam,
              away_team: awayTeam,
              home_odds: marketOdds.home,
              draw_odds: marketOdds.draw,
              away_odds: marketOdds.away,
              time_utc: kickoffTime,
              time_eat: kickoffEAT,
              markets: marketOdds,
              markets_count: marketsWithOdds
            });

            console.log(`   ✅ Added: ${homeTeam} vs ${awayTeam} (${games.length}) — ${marketsWithOdds} market odds`);
          } catch (fixtureErr) {
            console.warn(`   ⚠️ Error processing fixture:`, fixtureErr.message);
            continue;
          }
        }

        // Second pass: try per-fixture odds for games not in bulk response
        if (fixturesWithoutBulkOdds.length > 0) {
          console.log(`\n📡 Fetching per-fixture odds for ${fixturesWithoutBulkOdds.length} remaining fixtures on ${dateStr}...`);
          let perFixtureFetched = 0;
          const PER_FIXTURE_LIMIT = 30;

          for (const fixture of fixturesWithoutBulkOdds) {
            if (perFixtureFetched >= PER_FIXTURE_LIMIT) break;

            try {
              const fixtureId = fixture?.fixture?.id;
              const homeTeam = fixture?.teams?.home?.name;
              const awayTeam = fixture?.teams?.away?.name;
              const leagueName = fixture?.league?.name || 'Football';
              const kickoffTime = fixture?.fixture?.date;

              if (!fixtureId || !homeTeam || !awayTeam) continue;

              const oddsJson = await apiGetTest('/odds', { fixture: String(fixtureId) });
              const oddsRows = oddsJson.response || [];
              perFixtureFetched++;

              const marketOdds = chooseBestOddsSet(oddsRows);
              if (!marketOdds || !marketOdds.home || !marketOdds.draw || !marketOdds.away) continue;

              const kickoffEAT = toEAT(kickoffTime);
              const allMarketKeys = Object.values(REQUIRED_MARKETS).flat();
              const marketsWithOdds = allMarketKeys.filter(k => !!marketOdds[k]).length;

              games.push({
                api_fixture_id: fixtureId,
                league: leagueName,
                home_team: homeTeam,
                away_team: awayTeam,
                home_odds: marketOdds.home,
                draw_odds: marketOdds.draw,
                away_odds: marketOdds.away,
                time_utc: kickoffTime,
                time_eat: kickoffEAT,
                markets: marketOdds,
                markets_count: marketsWithOdds
              });

              console.log(`   ✅ [per-fixture] Added: ${homeTeam} vs ${awayTeam} (${games.length}) — ${marketsWithOdds} market odds`);
            } catch (err) {
              continue;
            }
          }
          console.log(`   📊 Per-fixture pass: fetched odds for ${perFixtureFetched} fixtures`);
        }
      } catch (dateErr) {
        console.error(`❌ Error fetching fixtures for ${dateStr}:`, dateErr.message);
        continue; // Skip this date, continue with next
      }
    }

    console.log(`\n✅ Fetched ${games.length} prematch games across ${DAYS_TO_FETCH} days from API Football`);

    if (games.length === 0) {
      return res.json({
        success: true,
        message: `No prematch games found for the next ${DAYS_TO_FETCH} days with valid odds`,
        game_count: 0,
        games: [],
        dates_checked: datesToFetch,
        next_step: 'Try again later or check API Football for available matches'
      });
    }

    res.json({
      success: true,
      message: `Found ${games.length} prematch games across ${DAYS_TO_FETCH} days ready to add`,
      game_count: games.length,
      matches_fetched: games.length,
      dates_checked: datesToFetch,
      max_limit: 'unlimited',
      games: games,
      next_step: 'Call /api/admin/fetch-api-football/execute with the games to add them to the site'
    });

  } catch (error) {
    console.error('❌ Fetch preview error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch games from API Football',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// POST: Execute - add the fetched games to the site (actually saves to DB)
router.post('/execute', checkAdmin, async (req, res) => {
  try {
    const { games: gamesToAdd, sport = 'football' } = req.body;

    if (!gamesToAdd || !Array.isArray(gamesToAdd) || gamesToAdd.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Games array required'
      });
    }

    console.log(`\n💾 [Execute API Games] Adding ${gamesToAdd.length} ${sport} games...`);

    const results = { added: [], failed: [], total_requested: gamesToAdd.length };
    const prefix = SPORT_PREFIXES[sport] || 'af';

    for (const g of gamesToAdd) {
      try {
        const gameId = `${prefix}-${g.api_fixture_id}`;

        // Check if already exists
        const { data: existing } = await supabase
          .from('games')
          .select('id')
          .eq('game_id', gameId)
          .maybeSingle();

        if (existing) {
          console.log(`   ⏭️ ${gameId} already exists, skipping`);
          results.added.push({ game_id: gameId, status: 'already_exists' });
          continue;
        }

        const drawOdds = (sport === 'basketball' || sport === 'tennis' || sport === 'boxing')
          ? 0 : (parseFloat(g.draw_odds) || parseFloat(g.markets?.draw) || 3.0);

        const gameData = {
          game_id: gameId,
          league: g.league || sport.charAt(0).toUpperCase() + sport.slice(1),
          home_team: g.home_team,
          away_team: g.away_team,
          home_odds: parseFloat(g.home_odds) || 1.90,
          draw_odds: drawOdds,
          away_odds: parseFloat(g.away_odds) || 1.90,
          time: g.time_utc || g.time_eat || new Date().toISOString(),
          status: 'upcoming'
        };

        const { data: game, error: insertErr } = await supabase
          .from('games')
          .insert([gameData])
          .select()
          .single();

        if (insertErr) {
          console.error(`   ❌ Failed to insert ${gameId}:`, insertErr.message);
          results.failed.push({ game_id: gameId, error: insertErr.message });
          continue;
        }

        // Insert markets
        if (g.markets && typeof g.markets === 'object') {
          const marketsToInsert = [];
          for (const [key, odds] of Object.entries(g.markets)) {
            const oddsVal = parseFloat(odds);
            if (oddsVal && oddsVal >= 1.01) {
              marketsToInsert.push({
                game_id: game.id,
                market_type: determineMarketType(key),
                market_key: key,
                odds: oddsVal
              });
            }
          }
          if (marketsToInsert.length > 0) {
            const { error: mErr } = await supabase.from('markets').insert(marketsToInsert);
            if (mErr) console.warn(`   ⚠️ Markets insert warning for ${gameId}:`, mErr.message);
            else console.log(`   📊 Inserted ${marketsToInsert.length} markets for ${gameId}`);
          }
        }

        // Auto-mark as hot if from a popular league
        if (isHotLeague(g.league)) {
          await supabase.from('markets').insert({
            game_id: game.id,
            market_type: 'META',
            market_key: '__hot',
            odds: 1,
            updated_at: new Date().toISOString()
          });
          console.log(`   🔥 Auto-marked as HOT (league: ${g.league})`);
        }

        results.added.push({ game_id: gameId, status: 'added' });
        console.log(`   ✅ Added: ${g.home_team} vs ${g.away_team} (${gameId})`);
      } catch (gameErr) {
        const gid = `${prefix}-${g.api_fixture_id}`;
        console.error(`   ❌ Error adding ${gid}:`, gameErr.message);
        results.failed.push({ game_id: gid, error: gameErr.message });
      }
    }

    console.log(`✅ Execute complete: ${results.added.length} added, ${results.failed.length} failed`);

    res.json({
      success: true,
      message: `Successfully added ${results.added.length} games to the site`,
      games_added: results.added.length,
      games_failed: results.failed.length,
      results
    });

  } catch (error) {
    console.error('❌ Execute error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to add games',
      details: error.message
    });
  }
});

// Helper to determine market type (same as admin.routes.js)
function determineMarketType(key) {
  if (key.startsWith('cs')) return 'CS';
  if (key.includes('btts')) return 'BTTS';
  if (key.includes('over') || key.includes('under')) return 'O/U';
  if (key.includes('doubleChance')) return 'DC';
  if (key.includes('htft')) return 'HT/FT';
  return '1X2';
}

// ============================================================
// BASKETBALL: Fetch preview for today's basketball games
// ============================================================
router.post('/fetch-preview/basketball', checkAdmin, async (req, res) => {
  try {
    console.log(`\n🏀 [API Basketball Fetch Preview] Fetching basketball games for the next 3 days...`);

    const BBALL_KEY = API_KEY || '49f4155b78d58351ed95b5c3bbcebd9e';

    if (!BBALL_KEY) {
      return res.status(500).json({ success: false, error: 'API key not configured' });
    }

    async function bballApiGet(path, params = {}) {
      const qs = new URLSearchParams(params).toString();
      const url = `${BASKETBALL_API_BASE}${path}${qs ? `?${qs}` : ''}`;
      console.log(`   🔗 Basketball API: ${path}`, params);
      const resp = await fetch(url, {
        headers: { 'x-apisports-key': BBALL_KEY }
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Basketball API ${resp.status}: ${body}`);
      }
      const json = await resp.json();
      return json.response || [];
    }

    // Build list of dates to fetch (today + next 2 days)
    const DAYS_TO_FETCH = 3;
    const datesToFetch = [];
    for (let d = 0; d < DAYS_TO_FETCH; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      datesToFetch.push(date.toISOString().split('T')[0]);
    }
    console.log(`   📅 Dates to fetch: ${datesToFetch.join(', ')}`);

    const games = [];

    for (const dateStr of datesToFetch) {
      try {
        // Step 1: Fetch all basketball games for this date
        console.log(`\n📅 Fetching basketball games for ${dateStr}...`);
        const allGames = await bballApiGet('/games', { date: dateStr, timezone: TZ });
        console.log(`   📊 Found ${allGames.length} total basketball games on ${dateStr}`);

        // Filter to Not Started (NS) only
        const prematchGames = allGames.filter(g => g?.status?.short === 'NS');
        console.log(`   🏀 ${prematchGames.length} upcoming (NS) basketball games on ${dateStr}`);

        if (prematchGames.length === 0) {
          console.log(`   ⚠️ No upcoming basketball games on ${dateStr}`);
          continue;
        }

        // Step 2: Fetch odds for games (limit to 30 API calls per day to conserve quota)
        const ODDS_FETCH_LIMIT = 30;
        const oddsMap = new Map();
        let oddsFetched = 0;

    for (const game of prematchGames) {
      if (oddsFetched >= ODDS_FETCH_LIMIT) break;
      try {
        const oddsData = await bballApiGet('/odds', { game: String(game.id) });
        if (oddsData.length > 0) {
          oddsMap.set(game.id, oddsData[0]);
        }
        oddsFetched++;
      } catch (err) {
        oddsFetched++;
        continue;
      }
    }
    console.log(`   📈 Fetched odds for ${oddsMap.size} / ${prematchGames.length} games`);

    // Step 3: Build games list
    const games = [];
    for (const game of prematchGames) {
      try {
        const gameId = game?.id;
        if (!gameId) continue;

        const homeTeam = game?.teams?.home?.name;
        const awayTeam = game?.teams?.away?.name;
        const leagueName = game?.league?.name || 'Basketball';
        const kickoffTime = game?.date;

        if (!homeTeam || !awayTeam) continue;

        // Extract Home/Away odds
        let homeOdds = 1.90, awayOdds = 1.90;
        const oddsEntry = oddsMap.get(gameId);
        if (oddsEntry) {
          for (const bookmaker of (oddsEntry.bookmakers || [])) {
            const homeAwayBet = (bookmaker.bets || []).find(b =>
              b.name === 'Home/Away' || b.name === 'Winner' || b.id === 1
            );
            if (homeAwayBet) {
              const hVal = homeAwayBet.values?.find(v => v.value === 'Home');
              const aVal = homeAwayBet.values?.find(v => v.value === 'Away');
              if (hVal) homeOdds = parseFloat(hVal.odd) || 1.90;
              if (aVal) awayOdds = parseFloat(aVal.odd) || 1.90;
              break; // Use first bookmaker with odds
            }
          }
        }

        const kickoffEAT = toEAT(kickoffTime);

        games.push({
          api_fixture_id: gameId,
          sport: 'basketball',
          league: leagueName,
          home_team: homeTeam,
          away_team: awayTeam,
          home_odds: homeOdds,
          draw_odds: 0,
          away_odds: awayOdds,
          time_utc: kickoffTime,
          time_eat: kickoffEAT,
          markets: { home: homeOdds, away: awayOdds },
          markets_count: 1
        });

        console.log(`   ✅ Added: ${homeTeam} vs ${awayTeam} (${games.length})`);
      } catch (err) {
        continue;
      }
    }
      } catch (dateErr) {
        console.error(`❌ Error fetching basketball games for ${dateStr}:`, dateErr.message);
        continue;
      }
    } // end of datesToFetch loop

    console.log(`\n✅ Fetched ${games.length} basketball games across ${DAYS_TO_FETCH} days from API`);

    if (games.length === 0) {
      return res.json({
        success: true,
        message: `No upcoming basketball games found for the next ${DAYS_TO_FETCH} days`,
        game_count: 0,
        games: [],
        dates_checked: datesToFetch,
        sport: 'basketball'
      });
    }

    res.json({
      success: true,
      message: `Found ${games.length} basketball games across ${DAYS_TO_FETCH} days ready to add`,
      game_count: games.length,
      games: games,
      dates_checked: datesToFetch,
      sport: 'basketball',
      next_step: 'Call /api/admin/fetch-api-football/execute with sport=basketball to add them'
    });

  } catch (error) {
    console.error('❌ Basketball fetch error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch basketball games',
      details: error.message
    });
  }
});

module.exports = router;
