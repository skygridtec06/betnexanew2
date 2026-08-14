const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://eaqogmybihiqzivuwyav.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Robinson mugambi's ID (to exclude from banning)
const ROBINSON_ID = '19d20138-36fc-419f-8cf8-161073fd18f9';

async function banUsersExceptRobinson() {
  try {
    console.log('🔍 Querying users to ban...\n');

    // Query to get all users with winnings and unactivated withdrawals (except Robinson)
    const { data: usersToBan, error: queryError } = await supabase
      .from('users')
      .select('id, phone_number, username, account_balance, total_winnings')
      .gt('total_winnings', 0)
      .eq('withdrawal_activated', false)
      .neq('id', ROBINSON_ID)
      .order('total_winnings', { ascending: false });

    if (queryError) {
      console.error('❌ Error querying users:', queryError.message);
      process.exit(1);
    }

    if (!usersToBan || usersToBan.length === 0) {
      console.log('No users found to ban.');
      process.exit(0);
    }

    console.log(`📋 Found ${usersToBan.length} users to ban:\n`);
    console.log('='.repeat(100));
    usersToBan.forEach((user, index) => {
      console.log(`${(index + 1).toString().padEnd(3)} | ${user.username.padEnd(25)} | ${user.phone_number.padEnd(15)} | KSH ${user.total_winnings}`);
    });
    console.log('='.repeat(100));
    console.log(`\n⏳ Applying bans...\n`);

    // Ban each user individually by ID
    let successCount = 0;
    let failureCount = 0;

    for (const user of usersToBan) {
      const { error: banError } = await supabase
        .from('users')
        .update({ is_banned: true })
        .eq('id', user.id);

      if (banError) {
        console.error(`❌ Failed to ban ${user.username} (${user.id}): ${banError.message}`);
        failureCount++;
      } else {
        console.log(`✅ Banned: ${user.username} (${user.phone_number})`);
        successCount++;
      }
    }

    console.log(`\n📊 Ban Results:`);
    console.log(`   ✅ Successfully banned: ${successCount}`);
    console.log(`   ❌ Failed to ban: ${failureCount}`);
    console.log(`   🛡️  Excluded: Robinson mugambi\n`);

    // Verify Robinson is still unbanned
    const { data: robinson, error: robError } = await supabase
      .from('users')
      .select('id, username, phone_number, is_banned, total_winnings')
      .eq('id', ROBINSON_ID)
      .single();

    if (!robError && robinson) {
      console.log(`✅ VERIFICATION: Robinson mugambi is ${robinson.is_banned ? 'BANNED ❌' : 'UNBANNED ✓'}`);
      console.log(`   Phone: ${robinson.phone_number}`);
      console.log(`   Total Winnings: KSH ${robinson.total_winnings}\n`);
    }

    if (successCount === usersToBan.length) {
      console.log('✅ Ban operation completed successfully!');
    }

  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
    process.exit(1);
  }
}

console.log('🚨 WARNING: You are about to permanently ban 23 users!\n');
console.log('Type "BAN" to confirm the operation:\n');

process.stdin.once('data', async (input) => {
  const answer = input.toString().trim().toUpperCase();
  
  if (answer === 'BAN') {
    console.log('✅ Confirmed! Starting ban operation...\n');
    await banUsersExceptRobinson();
    process.exit(0);
  } else {
    console.log('❌ Operation cancelled. No changes made.\n');
    process.exit(0);
  }
});
