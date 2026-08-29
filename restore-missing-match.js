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

const match = {
  game_id: 'manual-' + Date.now(),
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
  updated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

supabase
  .from('games')
  .insert([match])
  .select()
  .single()
  .then(({ data, error }) => {
    if (error) {
      console.error('INSERT_ERROR');
      console.error(error);
      process.exit(1);
    }

    console.log('INSERTED');
    console.log(JSON.stringify(data, null, 2));
  })
  .catch((err) => {
    console.error('EXCEPTION');
    console.error(err);
    process.exit(1);
  });
