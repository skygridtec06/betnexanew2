const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client with service key (for admin access)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function findUsersWithWinningsUnactivated() {
  try {
    console.log('🔍 Querying for users with winnings, unactivated withdrawals, and unbanned status...\n');

    // Query users that match criteria:
    // 1. total_winnings > 0 (has winnings)
    // 2. withdrawal_activated = false (unactivated on withdrawals)
    // 3. is_banned = false OR is_banned IS NULL (unbanned)
    const { data: users, error } = await supabase
      .from('users')
      .select('id, phone_number, username, account_balance, total_winnings, withdrawal_activated, is_banned, created_at')
      .gt('total_winnings', 0) // total_winnings > 0
      .eq('withdrawal_activated', false) // unactivated
      .or('is_banned.eq.false,is_banned.is.null') // unbanned
      .order('total_winnings', { ascending: false });

    if (error) {
      console.error('❌ Error querying users:', error);
      return;
    }

    if (!users || users.length === 0) {
      console.log('✅ No users found matching the criteria.');
      console.log('   (Users with winnings, unactivated withdrawals, and unbanned)\n');
      return;
    }

    console.log(`✅ Found ${users.length} user(s) matching criteria:\n`);
    console.log('='.repeat(120));
    console.log(
      `${'ID'.padEnd(40)} | ${'Phone'.padEnd(15)} | ${'Username'.padEnd(20)} | ${'Account Balance'.padEnd(18)} | ${'Total Winnings'.padEnd(16)} | ${'Withdrawal Act.'.padEnd(15)} | ${'Banned'.padEnd(8)} | ${'Created'.padEnd(20)}`
    );
    console.log('='.repeat(120));

    users.forEach((user, index) => {
      const createdDate = new Date(user.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      
      console.log(
        `${(user.id || 'N/A').padEnd(40)} | ${(user.phone_number || 'N/A').padEnd(15)} | ${(user.username || 'N/A').padEnd(20)} | KSH ${(user.account_balance || 0).toString().padEnd(13)} | KSH ${(user.total_winnings || 0).toString().padEnd(11)} | ${(user.withdrawal_activated ? 'YES' : 'NO').padEnd(15)} | ${(user.is_banned ? 'YES' : 'NO').padEnd(8)} | ${createdDate.padEnd(20)}`
      );
    });

    console.log('='.repeat(120));
    console.log(`\n📊 Summary:\n`);
    console.log(`   Total Users: ${users.length}`);
    
    const totalWinnings = users.reduce((sum, u) => sum + (u.total_winnings || 0), 0);
    const totalBalance = users.reduce((sum, u) => sum + (u.account_balance || 0), 0);
    
    console.log(`   Combined Total Winnings: KSH ${totalWinnings.toFixed(2)}`);
    console.log(`   Combined Account Balance: KSH ${totalBalance.toFixed(2)}`);
    console.log(`   All users are: Unactivated on Withdrawals & Unbanned\n`);

    // Export as JSON for reference
    console.log('\n📋 JSON Export:');
    console.log(JSON.stringify(users, null, 2));

  } catch (error) {
    console.error('❌ Unexpected error:', error);
  }
}

findUsersWithWinningsUnactivated();
