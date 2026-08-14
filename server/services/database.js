/**
 * Database Service
 * Handles database connections (using Supabase)
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://eaqogmybihiqzivuwyav.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
let supabaseKeyType = supabaseServiceKey ? 'SERVICE_KEY' : (supabaseAnonKey ? 'ANON_KEY' : 'NO_KEY');
let supabaseKey = supabaseServiceKey || supabaseAnonKey;

console.log('🔧 Database initialization:');
console.log('   SUPABASE_URL:', supabaseUrl ? '✓ configured' : '❌ missing');
console.log('   URL value:', supabaseUrl);
console.log('   SUPABASE_SERVICE_KEY:', supabaseServiceKey ? '✓ configured' : '❌ missing');
console.log('   SUPABASE_ANON_KEY:', supabaseAnonKey ? '✓ configured' : '❌ missing');
console.log('   Using key type:', supabaseKeyType);

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Warning: Missing SUPABASE_URL or SUPABASE_KEY');
  console.warn('   Games API will return empty results');
}

let supabase = null;

function createSupabaseClient(key, headers = {}) {
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-connection-pool': 'true', ...headers } },
    db: { schema: 'public' }
  });
}

function setSupabaseClient(client, valid = true) {
  supabase = client;
  supabase.__isKeyValid = valid;
  return supabase;
}

try {
  const globalHeaders = {};

  if (supabaseServiceKey && supabaseAnonKey) {
    globalHeaders.Authorization = `Bearer ${supabaseServiceKey}`;
    globalHeaders.apikey = supabaseAnonKey;
  }

  setSupabaseClient(createSupabaseClient(supabaseKey, globalHeaders), true);
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

        // Detect common Supabase key issues and mark client as invalid
        const msg = (error.message || '').toLowerCase();
        const isInvalidKey = msg.includes('unregistered api key') || msg.includes('invalid api key') || msg.includes('permission denied') || error.status === 401 || error.status === 403;
        if (isInvalidKey) {
          supabase.__isKeyValid = false;
          console.error('\n🚨 Supabase API key appears to be invalid or unregistered.');
          console.error('   Please check SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY in your environment or .env file.');
          console.error('   If this is a deployment (Vercel), update the project environment variables and redeploy.\n');

          if (supabaseServiceKey && supabaseAnonKey && supabaseKeyType === 'SERVICE_KEY') {
            console.warn('⚠️ Service key validation failed. Falling back to SUPABASE_ANON_KEY for read-only operations.');
            supabaseKey = supabaseAnonKey;
            supabaseKeyType = 'ANON_KEY';
            setSupabaseClient(createSupabaseClient(supabaseKey, { 'x-connection-pool': 'true' }), true);
            console.log('✅ Fallen back to SUPABASE_ANON_KEY');
            supabase.__isKeyValid = true;
          }
        }
      } else {
        console.log('✅ Initial Supabase connection test PASSED');
        console.log('   Tables accessible: games table is reachable');
        supabase.__isKeyValid = true;
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

// Helper to check whether the Supabase key validated at startup
supabase.checkKeyValid = () => !!supabase.__isKeyValid;

module.exports = supabase;
