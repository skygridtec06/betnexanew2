/**
 * Database Service
 * Handles database connections (using Supabase)
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://eaqogmybihiqzivuwyav.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

console.log('🔧 Database initialization:');
console.log('   SUPABASE_URL:', supabaseUrl ? '✓ configured' : '❌ missing');
console.log('   URL value:', supabaseUrl);
console.log('   SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✓ configured' : '❌ missing');
console.log('   SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✓ configured' : '❌ missing');
console.log('   Using key type:', process.env.SUPABASE_SERVICE_KEY ? 'SERVICE_KEY' : (process.env.SUPABASE_ANON_KEY ? 'ANON_KEY' : '❌ NO KEY AVAILABLE'));

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Warning: Missing SUPABASE_URL or SUPABASE_KEY');
  console.warn('   Games API will return empty results');
}

let supabase = null;

try {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'x-connection-pool': 'true' },
      fetch: (url, options) => fetch(url, { ...options, keepalive: true }),
    },
    db: { schema: 'public' },
  });
  console.log('✅ Supabase client initialized successfully');
  
  // Test connection immediately with better error diagnostics
  (async () => {
    try {
      console.log('🔍 Testing Supabase connection...');
      const { data, error } = await supabase.from('games').select('*', { count: 'exact', head: true }).limit(1);
      
      if (error) {
        console.error('❌ Initial Supabase connection test FAILED:');
        console.error('   Full Error:', JSON.stringify(error, null, 2));
        console.error('   Message:', error.message || 'No message');
        console.error('   Code:', error.code || 'No code');
        console.error('   Status:', error.status || 'No status');
        console.error('   Hint:', error.hint || 'No hint');
        console.error('   Details:', error.details || 'No details');
      } else {
        console.log('✅ Initial Supabase connection test PASSED');
        console.log('   Tables accessible: games table is reachable');
      }
    } catch (err) {
      console.error('❌ Connection test exception:', err.message || err);
      console.error('   Stack:', err.stack);
      console.error('   Type:', err.constructor.name);
    }
  })();
} catch (error) {
  console.error('❌ Supabase initialization FAILED:', error.message);
  console.warn('   Games API will return empty results');
}

module.exports = supabase;
