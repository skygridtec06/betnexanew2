/**
 * Endpoint to fetch prematch soccer fixtures + odds from The Odds API (the-odds-api.com)
 * Returns a preview (same shape as the API-Football fetcher) covering:
 * 1X2, BTTS, Over/Under (1.5 & 2.5), HT/FT and Correct Score markets.
 */

const express = require('express');
const router = express.Router();
const supabase = require('../services/database');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_API_KEY = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || '';
const REGION = process.env.ODDS_API_REGIONS || 'eu';

// Leagues matching these hints are scanned first (most-watched competitions)
const HOT_LEAGUE_HINTS = [
  'epl', 'la_liga', 'serie_a', 'bundesliga', 'ligue_one', 'champs_league',
  'europa_league', 'europa_conference', 'world_cup', 'european_championship',
  'copa_america', 'africa_cup', 'mls', 'eredivisie', 'primeira_liga',
  'super_league', 'campeonato', 'primera_division', 'nations_league'
];

// Quota/time protection knobs (overridable via env without a redeploy of code logic)
const MAX_LEAGUES = parseInt(process.env.ODDS_API_MAX_LEAGUES, 10) || 20;
const MAX_TOTAL_EVENTS = parseInt(process.env.ODDS_API_MAX_EVENTS, 10) || 80;
const MAX_EXTRA_MARKET_EVENTS = parseInt(process.env.ODDS_API_MAX_EXTENDED_EVENTS, 10) || 40;
const BATCH_SIZE = 8;
const EXTRA_MARKETS_TIME_BUDGET_MS = 20000; // stop fetching BTTS/HT-FT/CS once this budget is used

// Middleware to check if user is admin (mirrors fetch-api-football-games.js)
async function checkAdmin(req, res, next) {
  try {
    const phone = req.body.phone || req.query.phone;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number required in request' });
    }
    if (!supabase) {
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, is_admin, role')
      .eq('phone_number', phone)
      .single();
    if (userError || !user) {
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    if (!user.is_admin) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    req.user = { id: user.id, phone, is_admin: true };
    next();
  } catch (error) {
    console.error('❌ [Odds-API] Admin check exception:', error);
    const phone = req.body.phone || req.query.phone || 'unknown';
    req.user = { id: 'unknown', phone, is_admin: true };
    next();
  }
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 1.01 ? +n.toFixed(2) : null;
}

async function oddsApiGet(path, params = {}) {
  const qs = new URLSearchParams({ apiKey: ODDS_API_KEY, ...params }).toString();
  const url = `${ODDS_API_BASE}${path}?${qs}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Odds API ${resp.status} on ${path}: ${body}`);
  }
  return resp.json();
}

async function runInBatches(items, worker, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const results = await Promise.all(
      chunk.map((item) => worker(item).catch((err) => ({ __error: err.message })))
    );
    out.push(...results);
  }
  return out;
}

function findOutcome(outcomes, name) {
  const wanted = String(name || '').trim().toLowerCase();
  const found = (outcomes || []).find((o) => String(o.name || '').trim().toLowerCase() === wanted);
  return num(found?.price);
}

// Merge 1X2 + Over/Under (1.5 & 2.5) odds across all bookmakers for one event
function extractPrimaryMarkets(event) {
  const out = {};
  for (const bm of event.bookmakers || []) {
    for (const market of bm.markets || []) {
      if (market.key === 'h2h') {
        if (out.home == null) out.home = findOutcome(market.outcomes, event.home_team);
        if (out.away == null) out.away = findOutcome(market.outcomes, event.away_team);
        if (out.draw == null) out.draw = findOutcome(market.outcomes, 'Draw');
      } else if (market.key === 'totals') {
        for (const o of market.outcomes || []) {
          const point = parseFloat(o.point);
          const price = num(o.price);
          if (!price) continue;
          const side = String(o.name || '').trim().toLowerCase();
          if (point === 1.5) {
            if (side === 'over' && out.over15 == null) out.over15 = price;
            if (side === 'under' && out.under15 == null) out.under15 = price;
          } else if (point === 2.5) {
            if (side === 'over' && out.over25 == null) out.over25 = price;
            if (side === 'under' && out.under25 == null) out.under25 = price;
          }
        }
      }
    }
  }
  return out;
}

// Merge BTTS / HT-FT / Correct Score odds from a single-event odds response
function extractExtraMarkets(event) {
  const out = {};
  const home = String(event.home_team || '').trim().toLowerCase();
  const away = String(event.away_team || '').trim().toLowerCase();

  const htftMap = {
    [`${home}/${home}`]: 'htftHomeHome',
    'draw/draw': 'htftDrawDraw',
    [`${away}/${away}`]: 'htftAwayAway',
    [`draw/${home}`]: 'htftDrawHome',
    [`draw/${away}`]: 'htftDrawAway',
  };

  for (const bm of event.bookmakers || []) {
    for (const market of bm.markets || []) {
      if (market.key === 'btts') {
        for (const o of market.outcomes || []) {
          const price = num(o.price);
          const side = String(o.name || '').trim().toLowerCase();
          if (side === 'yes' && out.bttsYes == null) out.bttsYes = price;
          if (side === 'no' && out.bttsNo == null) out.bttsNo = price;
        }
      } else if (market.key === 'halftime_fulltime') {
        for (const o of market.outcomes || []) {
          const label = String(o.name || '').trim().toLowerCase();
          const key = htftMap[label];
          const price = num(o.price);
          if (key && price && out[key] == null) out[key] = price;
        }
      } else if (market.key === 'correct_score') {
        for (const o of market.outcomes || []) {
          const price = num(o.price);
          if (!price) continue;
          const parts = String(o.name || '').split('|').map((s) => s.trim());
          if (parts.length !== 2) continue;
          const scoreOf = (part) => {
            const idx = part.lastIndexOf(':');
            if (idx === -1) return null;
            const teamName = part.slice(0, idx).trim().toLowerCase();
            const score = parseInt(part.slice(idx + 1).trim(), 10);
            return Number.isInteger(score) ? { teamName, score } : null;
          };
          const a = scoreOf(parts[0]);
          const b = scoreOf(parts[1]);
          if (!a || !b) continue;
          let homeScore;
          let awayScore;
          if (a.teamName === home) { homeScore = a.score; awayScore = b.score; }
          else if (b.teamName === home) { homeScore = b.score; awayScore = a.score; }
          else continue;
          if (homeScore < 0 || homeScore > 4 || awayScore < 0 || awayScore > 4) continue;
          const key = `cs${homeScore}${awayScore}`;
          if (out[key] == null) out[key] = price;
        }
      }
    }
  }
  return out;
}

router.get('/', (req, res) => {
  res.json({ success: true, message: 'Fetch Odds-API service is running', configured: !!ODDS_API_KEY });
});

router.post('/fetch-preview', checkAdmin, async (req, res) => {
  const startedAt = Date.now();
  try {
    if (!ODDS_API_KEY) {
      return res.status(500).json({ success: false, error: 'THE_ODDS_API_KEY not configured' });
    }

    console.log('\n⚽ [Odds-API Fetch Preview] Discovering active soccer leagues...');
    const sports = await oddsApiGet('/sports/', {});
    let soccerLeagues = (sports || []).filter((s) => s.group === 'Soccer' && s.active);

    soccerLeagues.sort((a, b) => {
      const aHot = HOT_LEAGUE_HINTS.some((h) => a.key.includes(h)) ? 0 : 1;
      const bHot = HOT_LEAGUE_HINTS.some((h) => b.key.includes(h)) ? 0 : 1;
      return aHot - bHot;
    });
    soccerLeagues = soccerLeagues.slice(0, MAX_LEAGUES);
    console.log(`   Scanning ${soccerLeagues.length} leagues: ${soccerLeagues.map((l) => l.key).join(', ')}`);

    // Step 1: bulk-fetch 1X2 + Over/Under for each league (cheap: 2 credits/league)
    const leagueResults = await runInBatches(soccerLeagues, async (league) => {
      const events = await oddsApiGet(`/sports/${league.key}/odds/`, {
        regions: REGION,
        markets: 'h2h,totals',
        oddsFormat: 'decimal',
        dateFormat: 'iso'
      });
      return { league, events: events || [] };
    });

    const now = Date.now();
    let allEvents = [];
    for (const result of leagueResults) {
      if (result.__error) {
        console.warn('   ⚠️ League fetch failed:', result.__error);
        continue;
      }
      const { league, events } = result;
      for (const ev of events) {
        const kickoffMs = new Date(ev.commence_time).getTime();
        if (!kickoffMs || kickoffMs <= now + 5 * 60 * 1000) continue; // skip live/near-kickoff fixtures
        const primary = extractPrimaryMarkets(ev);
        if (primary.home == null || primary.draw == null || primary.away == null) continue; // 1X2 required
        allEvents.push({ event: ev, league: league.title, sportKey: league.key, primary });
      }
    }

    allEvents.sort((a, b) => new Date(a.event.commence_time).getTime() - new Date(b.event.commence_time).getTime());
    allEvents = allEvents.slice(0, MAX_TOTAL_EVENTS);
    console.log(`   Found ${allEvents.length} upcoming fixtures with 1X2 odds`);

    // Step 2: fetch BTTS/HT-FT/CS for a capped, time-boxed subset (costly: up to 3 credits/event)
    const eventsForExtra = allEvents.slice(0, MAX_EXTRA_MARKET_EVENTS);
    const extraById = new Map();
    for (let i = 0; i < eventsForExtra.length; i += BATCH_SIZE) {
      if (Date.now() - startedAt > EXTRA_MARKETS_TIME_BUDGET_MS) {
        console.warn('   ⏱️ Extended-markets time budget reached, remaining events keep 1X2/O-U only');
        break;
      }
      const chunk = eventsForExtra.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(chunk.map(async (item) => {
        try {
          const detail = await oddsApiGet(`/sports/${item.sportKey}/events/${item.event.id}/odds`, {
            regions: REGION,
            markets: 'btts,halftime_fulltime,correct_score',
            oddsFormat: 'decimal',
            dateFormat: 'iso'
          });
          return { id: item.event.id, extra: extractExtraMarkets(detail) };
        } catch (err) {
          return { id: item.event.id, __error: err.message };
        }
      }));
      for (const r of results) {
        if (r && !r.__error) extraById.set(r.id, r.extra);
      }
    }

    const games = allEvents.map(({ event, league, primary }) => {
      const extra = extraById.get(event.id) || {};
      const markets = { ...primary, ...extra };
      delete markets.home;
      delete markets.draw;
      delete markets.away;
      return {
        api_fixture_id: event.id,
        league,
        home_team: event.home_team,
        away_team: event.away_team,
        home_odds: primary.home,
        draw_odds: primary.draw,
        away_odds: primary.away,
        time_utc: event.commence_time,
        time_eat: event.commence_time,
        markets
      };
    });

    console.log(`✅ [Odds-API Fetch Preview] Prepared ${games.length} matches (${extraById.size} with extended markets)`);

    res.json({
      success: true,
      games,
      total_leagues_scanned: soccerLeagues.length,
      extended_markets_events: extraById.size
    });
  } catch (error) {
    console.error('❌ [Odds-API Fetch Preview] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch matches from The Odds API',
      details: error.message
    });
  }
});

module.exports = router;
