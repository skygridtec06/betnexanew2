import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://eaqogmybihiqzivuwyav.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ';

// Enhanced client with resilience features
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  },
  global: {
    headers: {
      'X-Client-Info': 'betnexa-web/1.0',
    },
    fetch: (url: RequestInfo | URL, options?: RequestInit) =>
      fetch(url, { ...options, keepalive: true }),
  },
  db: {
    schema: 'public',
  },
  realtime: {
    // Disable realtime WebSocket — avoids unnecessary connection on page load
    params: { eventsPerSecond: 0 },
  },
});

// Export connection status for UI
let isConnected = true;

export function isSupabaseConnected() {
  return isConnected;
}

export function setSupabaseConnected(connected: boolean) {
  isConnected = connected;
}

export default supabase;
