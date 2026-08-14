const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

console.log('\n🚨 SUPABASE EMERGENCY RECOVERY SCRIPT');
console.log('═'.repeat(60));
console.log('This will forcefully clean up the database connection pool');
console.log('and remove blocking connections\n');

const supabase = createClient(supabaseUrl, supabaseServiceKey);

(async () => {
  try {
    console.log('📍 Connecting to Supabase...');
    
    // Step 1: Kill all idle connections
    console.log('\n🧪 STEP 1: Terminating Idle Connections');
    console.log('─'.repeat(60));
    
    const { data: idleKilled, error: idleError } = await supabase.rpc('exec_sql', {
      sql: `
        SELECT COUNT(*) as killed FROM (
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE state = 'idle'
          AND pid <> pg_backend_pid()
        ) t;
      `
    });

    if (!idleError) {
      console.log('✅ Idle connections terminated');
    } else {
      console.log('⚠️  Could not terminate idle connections (expected if no RPC exists)');
    }

    // Step 2: Kill connections older than 5 minutes
    console.log('\n🧪 STEP 2: Terminating Old Connections (>5 min)');
    console.log('─'.repeat(60));
    
    const { data: oldKilled, error: oldError } = await supabase.rpc('exec_sql', {
      sql: `
        SELECT COUNT(*) as killed FROM (
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE query_start < now() - interval '5 minutes'
          AND pid <> pg_backend_pid()
        ) t;
      `
    });

    if (!oldError) {
      console.log('✅ Old connections terminated');
    }

    // Step 3: Kill connections from specific types
    console.log('\n🧪 STEP 3: Terminating Non-Essential Connections');
    console.log('─'.repeat(60));
    
    const { data: appKilled, error: appError } = await supabase.rpc('exec_sql', {
      sql: `
        SELECT COUNT(*) as killed FROM (
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE application_name NOT LIKE 'psql%'
          AND state != 'active'
          AND pid <> pg_backend_pid()
        ) t;
      `
    });

    if (!appError) {
      console.log('✅ Non-essential connections terminated');
    }

    // Step 4: Check current connection status
    console.log('\n🧪 STEP 4: Connection Status After Cleanup');
    console.log('─'.repeat(60));
    
    const { data: stats, error: statsError } = await supabase
      .from('pg_stat_activity')
      .select('state, count(*)', { count: 'exact' })
      .neq('pid', process.pid);

    if (!statsError && stats) {
      console.log('✅ Active connections by state:');
      stats.forEach(stat => {
        console.log(`   ${stat.state || 'unknown'}: ${stat.count} connections`);
      });
    }

    // Step 5: Check for locks
    console.log('\n🧪 STEP 5: Checking for Table Locks');
    console.log('─'.repeat(60));
    
    const { data: locks, error: locksError } = await supabase
      .from('pg_locks')
      .select('*')
      .eq('granted', false);

    if (!locksError) {
      if (locks && locks.length > 0) {
        console.log(`⚠️  Found ${locks.length} blocking lock(s):`);
        locks.forEach((lock, i) => {
          console.log(`   Lock ${i + 1}: ${lock.locktype} on relation ${lock.relation}`);
        });
        console.log('   These need manual intervention or PID termination');
      } else {
        console.log('✅ No blocking locks found');
      }
    }

    // Step 6: Check system resource usage
    console.log('\n🧪 STEP 6: Resource Status');
    console.log('─'.repeat(60));
    
    const { data: settings, error: settingsError } = await supabase
      .from('pg_settings')
      .select('name, setting')
      .in('name', ['max_connections', 'shared_buffers', 'work_mem']);

    if (!settingsError && settings) {
      console.log('✅ Database configuration:');
      settings.forEach(s => {
        console.log(`   ${s.name}: ${s.setting}`);
      });
    }

  } catch (err) {
    console.log('❌ Script execution error:', err.message);
    console.log('\n⚠️  This is expected if direct SQL execution is not available via RPC');
  }

  console.log('\n═'.repeat(60));
  console.log('📋 MANUAL RECOVERY STEPS (If Script Didn\'t Work):\n');
  
  console.log('1. GO TO SUPABASE DASHBOARD:');
  console.log('   https://app.supabase.com > Your Project > Database\n');
  
  console.log('2. OPEN SQL EDITOR AND RUN THESE COMMANDS:\n');
  
  console.log('   -- Kill all idle connections');
  console.log('   SELECT pg_terminate_backend(pid)');
  console.log('   FROM pg_stat_activity');
  console.log('   WHERE state = \'idle\';');
  console.log('');
  
  console.log('   -- Kill connections older than 5 minutes');
  console.log('   SELECT pg_terminate_backend(pid)');
  console.log('   FROM pg_stat_activity');
  console.log('   WHERE query_start < now() - interval \'5 minutes\'');
  console.log('   AND pid <> pg_backend_pid();');
  console.log('');
  
  console.log('   -- Check current connections');
  console.log('   SELECT count(*) as total_connections');
  console.log('   FROM pg_stat_activity;');
  console.log('');
  
  console.log('3. IF STILL UNHEALTHY:');
  console.log('   - Go to Settings > Instance');
  console.log('   - Click "Restart Database"');
  console.log('   - Wait 2-3 minutes for restart\n');
  
  console.log('4. IF RESTART DOESN\'T WORK:');
  console.log('   - Upgrade instance size (nano → small)');
  console.log('   - Or contact Supabase support: support@supabase.com\n');
  
  console.log('═'.repeat(60) + '\n');

  process.exit(0);
})();
