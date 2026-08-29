const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const envText = fs.readFileSync('.env', 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  if (!line || line.trim().startsWith('#')) continue;
  const idx = line.indexOf('=');
  if (idx > 0) {
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
    env[key] = value;
  }
}

const gameId = 'a838c8aa-d06e-4cb2-8a40-0554fe21a3a3';

const payload = {
  id: 'bf4d3a8d-0875-4cc5-9ecf-34f70e0dd7cf',
  game_id: gameId,
  league: 'Admin Added',
  home_team: 'Vienna Chargers',
  away_team: 'Alzburg Fc',
  home_odds: 2.1,
  draw_odds: 3.2,
  away_odds: 2.7,
  time: '2026-08-28T20:00:00.000Z',
  status: 'upcoming',
  is_kickoff_started: false,
  game_paused: false,
  kickoff_start_time: null,
  kickoff_paused_at: null,
  is_halftime: false,
  minute: 0,
  home_score: null,
  away_score: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  finished_at: null,
};

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

(async () => {
  try {
    const { data: existing, error: existingErr } = await supabase
      .from('games')
      .select('id, game_id, home_team, away_team, time')
      .eq('game_id', gameId)
      .maybeSingle();

    if (existingErr) throw existingErr;
    if (existing) {
      console.log(JSON.stringify({ success: true, action: 'already_exists', game: existing }, null, 2));
      return;
    }

    const { data, error } = await supabase
      .from('games')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error(JSON.stringify({ success: false, error: error.message, code: error.code, details: error.details }, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify({ success: true, action: 'inserted', game: data }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ success: false, exception: String(err) }, null, 2));
    process.exit(1);
  }
})();
