/**
 * Database Service
 * Handles database connections (using Supabase)
 */

const path = require('path');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL && !process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_ANON_KEY) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
}

const supabaseUrl = process.env.SUPABASE_URL || 'https://eaqogmybihiqzivuwyav.supabase.co';
const rawServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

function isJwtLikeKey(value) {
  return typeof value === 'string' && value.trim().length > 20 && value.split('.').length === 3;
}

function isSupabaseSecretKey(value) {
  return typeof value === 'string' && value.trim().startsWith('sb_secret_') && value.trim().length > 20;
}

const supabaseServiceKey = isJwtLikeKey(rawServiceKey) || isSupabaseSecretKey(rawServiceKey) ? rawServiceKey : null;
let supabaseKeyType = supabaseServiceKey ? 'SERVICE_KEY' : (supabaseAnonKey ? 'ANON_KEY' : 'NO_KEY');
let supabaseKey = supabaseServiceKey || supabaseAnonKey;

if (rawServiceKey && !supabaseServiceKey) {
  console.warn('⚠️ Ignoring invalid SUPABASE_SERVICE_KEY value because it is not a valid JWT-style or sb_secret_ service key. Falling back to SUPABASE_ANON_KEY for live reads.');
}

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
  supabase.checkKeyValid = () => !!supabase.__isKeyValid;
  return supabase;
}

async function validateConnection(client) {
  try {
    const { data, error } = await client.from('users').select('id', { count: 'exact', head: true }).limit(1);
    const message = (error && error.message ? error.message : '').toLowerCase();
    const isInvalidKey = !!error && (
      message.includes('unregistered api key') ||
      message.includes('invalid api key') ||
      message.includes('permission denied') ||
      message.includes('jwt') ||
      message.includes('row level security') ||
      error.status === 401 ||
      error.status === 403 ||
      (!error.message && !data)
    );

    return { ok: !isInvalidKey, data, error };
  } catch (err) {
    return { ok: false, error: err };
  }
}

try {
  const globalHeaders = {};

  if (supabaseServiceKey && supabaseAnonKey) {
    globalHeaders.Authorization = `Bearer ${supabaseServiceKey}`;
    globalHeaders.apikey = supabaseAnonKey;
  } else if (supabaseAnonKey) {
    globalHeaders.apikey = supabaseAnonKey;
  }

  const primaryClient = createSupabaseClient(supabaseKey, globalHeaders);
  setSupabaseClient(primaryClient, true);
  console.log('✅ Supabase client initialized successfully');

  async function initializeSupabaseHealth() {
    const primaryCheck = await validateConnection(primaryClient);

    if (primaryCheck.ok) {
      console.log('✅ Initial Supabase connection test PASSED');
      return;
    }

    if (supabaseAnonKey && supabaseKey !== supabaseAnonKey) {
      const anonClient = createSupabaseClient(supabaseAnonKey, { 'x-connection-pool': 'true' });
      const anonCheck = await validateConnection(anonClient);

      if (anonCheck.ok) {
        supabaseKey = supabaseAnonKey;
        supabaseKeyType = 'ANON_KEY';
        setSupabaseClient(anonClient, true);
        console.warn('⚠️ Service key rejected or invalid; falling back to SUPABASE_ANON_KEY for read-only access.');
        console.log('✅ Switched active Supabase client to ANON_KEY');
      } else {
        console.error('❌ Initial Supabase connection test FAILED:');
        console.error('   Primary key error:', JSON.stringify(primaryCheck.error || {}, null, 2));
        console.error('   Anonymous fallback error:', JSON.stringify(anonCheck.error || {}, null, 2));
      }
    }
  }

  initializeSupabaseHealth().catch((error) => {
    console.error('❌ Supabase validation failed:', error);
  });
} catch (error) {
  console.error('❌ Supabase initialization FAILED:', error.message);
  console.warn('   Games API will return empty results');
}

module.exports = supabase;
