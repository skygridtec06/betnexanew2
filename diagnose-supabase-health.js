const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

console.log('🔍 SUPABASE HEALTH DIAGNOSTIC REPORT');
console.log('═'.repeat(50));
console.log(`📍 Project URL: ${supabaseUrl}`);
console.log('');

// Test 1: Connection with anon key
console.log('🧪 TEST 1: Anon Key Connection');
console.log('─'.repeat(50));
const supabaseAnon = createClient(supabaseUrl, supabaseKey);

(async () => {
  try {
    // Try a simple query
    const { data, error } = await supabaseAnon
      .from('users')
      .select('id')
      .limit(1)
      .timeout(5000);
    
    if (error) {
      console.log('❌ ANON KEY: Connection failed');
      console.log(`   Error: ${error.message}`);
    } else {
      console.log('✅ ANON KEY: Connection successful');
      console.log(`   Data retrieved: ${data ? data.length + ' record(s)' : 'none'}`);
    }
  } catch (err) {
    console.log('❌ ANON KEY: Exception occurred');
    console.log(`   Error: ${err.message}`);
  }

  console.log('');

  // Test 2: Connection with service role key
  console.log('🧪 TEST 2: Service Role Key Connection');
  console.log('─'.repeat(50));
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { data, error } = await supabaseService
      .from('users')
      .select('id')
      .limit(1)
      .timeout(5000);
    
    if (error) {
      console.log('❌ SERVICE KEY: Connection failed');
      console.log(`   Error: ${error.message}`);
    } else {
      console.log('✅ SERVICE KEY: Connection successful');
      console.log(`   Data retrieved: ${data ? data.length + ' record(s)' : 'none'}`);
    }
  } catch (err) {
    console.log('❌ SERVICE KEY: Exception occurred');
    console.log(`   Error: ${err.message}`);
  }

  console.log('');

  // Test 3: Check database connectivity with health endpoint
  console.log('🧪 TEST 3: Direct Database Health Check');
  console.log('─'.repeat(50));
  
  try {
    // Try to query a system table to check database health
    const { data, error } = await supabaseService
      .from('users')
      .select('count')
      .single()
      .timeout(5000);
    
    if (error) {
      console.log('⚠️  Database query test failed');
      console.log(`   Error: ${error.message}`);
    } else {
      console.log('✅ Database responds to queries');
    }
  } catch (err) {
    console.log('⚠️  Database health check error');
    console.log(`   Error: ${err.message}`);
  }

  console.log('');

  // Test 4: Check for common issues
  console.log('🧪 TEST 4: Common Issues Check');
  console.log('─'.repeat(50));

  // Check for connection pool issues
  try {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        supabaseAnon
          .from('users')
          .select('id')
          .limit(1)
          .timeout(3000)
      );
    }
    
    const results = await Promise.all(promises);
    const errors = results.filter(r => r.error);
    
    if (errors.length > 0) {
      console.log('⚠️  Connection pool issue detected');
      console.log(`   Failed concurrent requests: ${errors.length}/5`);
      errors.forEach((err, i) => {
        console.log(`   Request ${i + 1}: ${err.error.message}`);
      });
    } else {
      console.log('✅ Connection pool handling OK');
    }
  } catch (err) {
    console.log('⚠️  Concurrent connection test failed');
    console.log(`   Error: ${err.message}`);
  }

  console.log('');

  // Summary
  console.log('📋 SUMMARY');
  console.log('═'.repeat(50));
  console.log('Possible causes for "Unhealthy" status:');
  console.log('1. Connection pool exhaustion');
  console.log('2. Database storage limit reached');
  console.log('3. High CPU/memory usage on DB instance');
  console.log('4. Network connectivity issues');
  console.log('5. Query timeouts or long-running operations');
  console.log('');
  console.log('Recommendations:');
  console.log('1. Check Supabase Dashboard > Logs for errors');
  console.log('2. Monitor resource usage: CPU, memory, connections');
  console.log('3. Check for long-running or idle connections');
  console.log('4. Review recent schema changes or large migrations');
  console.log('5. Consider connection pooling configuration');
  console.log('');

  process.exit(0);
})();
