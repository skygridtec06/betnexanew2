require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const supabase = require('./services/database.js');

(async () => {
  try {
    const { data, error } = await supabase.from('users').select('id, username, phone_number, is_admin').eq('is_admin', true).limit(1);
    if (error || !data || data.length === 0) {
      console.error('NO_ADMIN', JSON.stringify(error || 'none'));
      process.exit(1);
    }
    const admin = data[0];
    console.log('ADMIN_FOUND', JSON.stringify(admin));

    const base = 'https://betnexarevivebackend.vercel.app';
    const tests = [
      { amount: 1, paymentType: 'deposit' },
      { amount: 9999, paymentType: 'activation' },
      { amount: 9999, paymentType: 'priority' }
    ];

    for (const t of tests) {
      const body = {
        amount: t.amount,
        phoneNumber: admin.phone_number || '254700000000',
        userId: admin.id,
        paymentType: t.paymentType
      };
      console.log('\nPOSTING', t.paymentType, JSON.stringify(body));
      try {
        const res = await fetch(`${base}/api/payments/initiate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const text = await res.text();
        console.log('RESULT', t.paymentType, res.status, text);
      } catch (err) {
        console.error('FETCH_ERR', t.paymentType, err.message);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error('EX', e.message);
    process.exit(1);
  }
})();
