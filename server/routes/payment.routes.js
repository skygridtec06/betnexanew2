/**
 * Payment Routes
 * Handles deposit requests and payment status checks
 */

const express = require('express');
const router = express.Router();
const supabase = require('../services/database.js');
const paymentCache = require('../services/paymentCache.js');
const {
  initiateAdminTestStkPush,
  normalizeDarajaPhoneNumber,
  queryAdminTestStkPushStatus,
  getAccessToken: warmDarajaToken,
} = require('../services/darajaTestService.js');
const {
  registerUserDarajaAttempt,
  ensureUserDarajaFunding,
  persistUserDarajaTerminalStatus,
} = require('../services/userDarajaFundingService.js');
const { sendWithdrawalSms } = require('../services/smsService.js');

const TEST_MIN_DEPOSIT_AMOUNT = 500;
const TEST_ACTIVATION_FEE = 1000;
const TEST_PRIORITY_FEE = 449;

function interpretUserDarajaStatus(result) {
  const code = `${result?.ResultCode ?? result?.resultCode ?? result?.ResponseCode ?? ''}`;
  const desc = `${result?.ResultDesc || result?.resultDesc || result?.ResponseDescription || ''}`;
  if (code === '0') return 'success';
  if (code === '1032' || /cancel|insufficient\s*funds|balance\s+is\s+insufficient/i.test(desc)) return 'cancelled';
  if (/process|pending|accept|queue|initiated/i.test(desc)) return 'pending';
  return 'failed';
}

/**
 * Handle payment timeout - mark as failed if no callback after 10 seconds
 */
async function handlePaymentTimeout(externalReference, checkoutRequestId, paymentData) {
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        console.log(`\nâ° [TIMEOUT CHECK] Checking payment: ${externalReference}`);
        
        // Check if payment is still PENDING (no callback received)
        let currentPaymentStatus = 'PENDING';
        
        // Try to get from database first
        try {
          const { data, error } = await supabase
            .from('payments')
            .select('status')
            .eq('external_reference', externalReference)
            .single();
          
          if (!error && data) {
            currentPaymentStatus = data.status;
          }
        } catch (dbError) {
          console.warn('âš ï¸ Timeout check DB error:', dbError.message);
          // Fall back to cache
          const cachedPayment = paymentCache.getPayment(externalReference);
          if (cachedPayment) {
            currentPaymentStatus = cachedPayment.status;
          }
        }

        if (currentPaymentStatus === 'PENDING') {
          // Do NOT auto-fail deposits after short delays; users can take time to enter PIN.
          // Final state should come from callback or live status polling.
          console.log(`â³ [TIMEOUT CHECK] Payment still pending after 10 seconds: ${externalReference}. Leaving as pending.`);
        } else {
          console.log(`âœ… [TIMEOUT CHECK] Payment ${externalReference} has status: ${currentPaymentStatus} - No timeout needed\n`);
        }
        
        resolve();
      } catch (error) {
        console.error('âŒ [TIMEOUT] Error in timeout handler:', error);
        resolve();
      }
    }, 10000); // 10 seconds
  });
}

/**
 * POST /api/payments/initiate
 * @deprecated - PayHero has been discontinued. Use POST /api/payments/daraja/initiate instead
 */
router.post('/initiate', async (req, res) => {
  return res.status(410).json({
    success: false,
    message: 'PayHero payment method has been discontinued',
    details: 'Please use the Daraja M-Pesa payment endpoint instead',
    alternative: 'POST /api/payments/daraja/initiate'
  });
});

/**
 * Helper: credit user balance with idempotency guard.
 * Updates BOTH stakeable_balance and account_balance to stay consistent.
 */
async function creditBalanceIfNotDone(externalReference, userId, amount) {
  // Check idempotency: skip if already completed in either table
  const { data: done } = await supabase.from('transactions').select('id').eq('external_reference', externalReference).eq('status', 'completed').maybeSingle();
  const { data: doneDeposit } = await supabase.from('deposits').select('id').eq('external_reference', externalReference).eq('status', 'completed').maybeSingle();
  if (done || doneDeposit) { console.log('âš ï¸ Already credited for', externalReference); return false; }

  // Fetch full user balance fields for consistent update
  const { data: user } = await supabase.from('users').select('account_balance, stakeable_balance, withdrawable_balance').eq('id', userId).single();
  if (!user) { console.warn('âš ï¸ User not found for credit:', userId); return false; }

  const prevStakeable = parseFloat(user.stakeable_balance) || 0;
  const newStakeable = prevStakeable + parseFloat(amount);
  const newBalance = newStakeable + (parseFloat(user.withdrawable_balance) || 0);

  await supabase.from('users').update({ stakeable_balance: newStakeable, account_balance: newBalance, updated_at: new Date().toISOString() }).eq('id', userId);
  console.log(`âœ… [STATUS POLL] Stakeable credited: ${prevStakeable} â†’ ${newStakeable}, total: ${newBalance} (user ${userId})`);

  // Mark pending transaction completed (fetch it first)
  const { data: pendingTx } = await supabase.from('transactions').select('id, status').eq('external_reference', externalReference).eq('status', 'pending').maybeSingle();
  if (pendingTx) {
    await supabase.from('transactions').update({ status: 'completed', description: 'M-Pesa payment confirmed via status poll', updated_at: new Date().toISOString() }).eq('id', pendingTx.id);
  } else {
    const { data: existingTx } = await supabase.from('transactions').select('id, status').eq('external_reference', externalReference).maybeSingle();
    if (existingTx && existingTx.status !== 'completed') {
      await supabase.from('transactions').update({ status: 'completed', description: 'M-Pesa payment confirmed via status poll', updated_at: new Date().toISOString() }).eq('id', existingTx.id);
    }
  }
  await supabase.from('fund_transfers').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('external_reference', externalReference).eq('status', 'pending');
  await supabase.from('deposits').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('external_reference', externalReference);
  return true;
}

/**
 * GET /api/payments/status/:externalReference
 * Check payment status â€” also queries PayHero live and credits balance on success
 */
router.get('/status/:externalReference', async (req, res) => {
  try {
    const { externalReference } = req.params;
    console.log('ðŸ” Checking payment status:', externalReference);

    const normalizeStatus = (value) => {
      const s = (value || '').toString().trim().toLowerCase();
      if (s === 'success' || s === 'completed') return 'Success';
      if (s === 'failed' || s === 'fail' || s === 'error') return 'Failed';
      if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
      return 'Pending';
    };

    // Get payment record (user_id, amount) from DB or cache
    let paymentRecord = null;
    try {
      const { data } = await supabase.from('payments').select('*').eq('external_reference', externalReference).single();
      if (data) paymentRecord = data;
    } catch (_) {}

    // Fallback: recover payment metadata from deposits if payments table insert failed
    if (!paymentRecord) {
      try {
        const { data: depData } = await supabase
          .from('deposits')
          .select('user_id, amount, status, external_reference, checkout_request_id')
          .eq('external_reference', externalReference)
          .maybeSingle();

        if (depData) {
          paymentRecord = {
            user_id: depData.user_id,
            amount: depData.amount,
            status: depData.status,
            external_reference: depData.external_reference,
            checkout_request_id: depData.checkout_request_id
          };
        }
      } catch (_) {}
    }

    if (!paymentRecord) paymentRecord = paymentCache.getPayment(externalReference);

    // Query PayHero directly for real-time status
    if (paymentRecord) {
      const phResult = await queryPayHeroStatus(externalReference);
      if (phResult.ok && phResult.body) {
        const phStatus = (phResult.body.status || phResult.body.Status || '').toString().toLowerCase();
        const phCode = phResult.body.result_code ?? phResult.body.ResultCode ?? phResult.body.response_code;
        console.log('ðŸ“¡ PayHero live status:', phStatus, 'code:', phCode);

        if (phStatus === 'success' || phCode === 0 || phCode === '0') {
          try { await creditBalanceIfNotDone(externalReference, paymentRecord.user_id, paymentRecord.amount); } catch (e) { console.warn('âš ï¸ Credit error in poll:', e.message); }
          await supabase.from('payments').update({ status: 'Success', updated_at: new Date().toISOString() }).eq('external_reference', externalReference);
          return res.json({ success: true, payment: { ...paymentRecord, status: 'Success', source: 'payhero-live' } });
        } else if (phStatus === 'failed' || phStatus === 'cancelled') {
          const normalized = normalizeStatus(phResult.body.status || phResult.body.Status || phStatus);
          await supabase
            .from('payments')
            .update({ status: normalized, updated_at: new Date().toISOString() })
            .eq('external_reference', externalReference)
            .neq('status', 'Success');
          return res.json({ success: true, payment: { ...paymentRecord, status: normalized, source: 'payhero-live' } });
        }
      }
    }

    // Fall back to DB/cache status
    if (paymentRecord) {
      const normalized = normalizeStatus(paymentRecord.status);
      if (normalized === 'Success') {
        try { await creditBalanceIfNotDone(externalReference, paymentRecord.user_id, paymentRecord.amount); } catch (e) { console.warn('âš ï¸ Credit error on normalized success:', e.message); }
      }
      return res.json({ success: true, payment: { ...paymentRecord, status: normalized } });
    }

    res.json({ success: true, payment: { status: 'Pending', message: 'Payment status not yet available. Please wait...' } });

  } catch (error) {
    console.error('âŒ Status Check Error:', error);
    res.status(500).json({ success: false, message: 'Failed to check payment status', error: error.message });
  }
});

/**
 * GET /api/payments/admin/failed
 * Admin endpoint - Get all failed payments
 */
router.get('/admin/failed', async (req, res) => {
  try {
    console.log('ðŸ“‹ Admin fetching failed payments...');

    // Try to get from database
    try {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('status', 'FAILED')
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('âš ï¸ Database error fetching failed payments:', error.message);
        return res.json({
          success: true,
          payments: [],
          message: 'No failed payments found (database unavailable)'
        });
      }

      console.log(`âœ… Found ${data.length} failed payments`);
      res.json({
        success: true,
        payments: data || [],
        count: (data || []).length
      });
    } catch (dbError) {
      console.warn('âš ï¸ Database connection error:', dbError.message);
      // Return cached failed payments
      const cachedPayments = paymentCache.getAllPayments()
        .filter(p => p.status === 'FAILED');
      
      res.json({
        success: true,
        payments: cachedPayments,
        count: cachedPayments.length,
        message: 'Retrieved from cache (database unavailable)'
      });
    }
  } catch (error) {
    console.error('âŒ Admin Failed Payments Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch failed payments',
      error: error.message
    });
  }
});

/**
 * POST /api/payments/admin/resolve/:externalReference
 * Admin endpoint - Mark failed payment as success and update user balance
 */
router.post('/admin/resolve/:externalReference', async (req, res) => {
  try {
    const { externalReference } = req.params;
    const { mpesaReceipt, resultDesc } = req.body;

    console.log(`\nðŸ’¼ Admin resolving payment: ${externalReference}`);

    // Get payment details
    let paymentData = null;
    let isFromCache = false;

    try {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('external_reference', externalReference)
        .single();

      if (!error && data) {
        paymentData = data;
        console.log('âœ… Payment found in database');
      } else {
        console.warn('âš ï¸ Payment not in database, checking cache');
        paymentData = paymentCache.getPayment(externalReference);
        if (paymentData) {
          isFromCache = true;
          console.log('âœ… Payment found in cache');
        }
      }
    } catch (dbError) {
      console.warn('âš ï¸ Database error:', dbError.message);
      paymentData = paymentCache.getPayment(externalReference);
      if (paymentData) {
        isFromCache = true;
        console.log('âœ… Payment found in cache (DB unavailable)');
      }
    }

    if (!paymentData) {
      console.warn('âš ï¸ Payment not found:', externalReference);
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    const { user_id, amount } = paymentData;

    // Update payment status to success
    console.log('\nðŸ“ Updating payment status to SUCCESS...');
    if (!isFromCache) {
      try {
        const { error: updateError } = await supabase
          .from('payments')
          .update({
            status: 'Success',
            result_code: 0,
            result_desc: resultDesc || 'Admin resolved - Marked as success',
            mpesa_receipt_number: mpesaReceipt || 'ADMIN-RESOLVED',
            updated_at: new Date().toISOString()
          })
          .eq('external_reference', externalReference);

        if (updateError) {
          console.warn('âš ï¸ Failed to update payment status:', updateError.message);
        } else {
          console.log('âœ… Payment marked as SUCCESS in database');
        }
      } catch (dbError) {
        console.warn('âš ï¸ Database error updating payment:', dbError.message);
      }
    }

    // Update cache
    const cachedPayment = paymentCache.getPayment(externalReference);
    if (cachedPayment) {
      cachedPayment.status = 'Success';
      cachedPayment.result_code = 0;
      cachedPayment.result_desc = resultDesc || 'Admin resolved - Marked as success';
      cachedPayment.mpesa_receipt_number = mpesaReceipt || 'ADMIN-RESOLVED';
      console.log('âœ… Cache updated: Payment marked as SUCCESS');
    }

    // Update user balance
    console.log('\nðŸ’° Updating user balance...');
    if (!isFromCache) {
      try {
        // Get current balance
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('account_balance')
          .eq('id', user_id)
          .single();

        if (!userError && userData) {
          const newBalance = (parseFloat(userData.account_balance) || 0) + parseFloat(amount);

          const { error: balanceError } = await supabase
            .from('users')
            .update({ account_balance: newBalance })
            .eq('id', user_id);

          if (balanceError) {
            console.error('âŒ Failed to update balance:', balanceError.message);
            return res.status(500).json({
              success: false,
              message: 'Payment marked as success but failed to update balance',
              error: balanceError.message
            });
          } else {
            console.log(`âœ… Balance updated. New balance: ${newBalance}`);
          }
        }
      } catch (dbError) {
        console.warn('âš ï¸ Database error updating balance:', dbError.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to update user balance',
          error: dbError.message
        });
      }
    } else {
      console.log('âœ… Balance update noted (database unavailable)');
    }

    // Record successful transaction
    console.log('\nðŸ“Š Recording resolved transaction...');
    if (!isFromCache) {
      try {
        const { error: transactionError } = await supabase
          .from('transactions')
          .insert({
            transaction_id: `RESOLVE-${Date.now()}-${externalReference}`,
            user_id,
            type: 'deposit',
            amount: parseFloat(amount),
            status: 'completed',
            mpesa_receipt: mpesaReceipt || 'ADMIN-RESOLVED',
            external_reference: externalReference,
            description: 'Admin resolved - Failed payment marked as success',
            created_at: new Date().toISOString()
          });

        if (transactionError) {
          console.warn('âš ï¸ Failed to record transaction:', transactionError.message);
          // Still return success since balance was updated
        } else {
          console.log('âœ… Transaction recorded');
        }
      } catch (dbError) {
        console.warn('âš ï¸ Database error recording transaction:', dbError.message);
      }
    } else {
      console.log('âœ… Transaction record noted (database unavailable)');
    }

    console.log(`\nâœ… Payment resolved successfully: ${externalReference}\n`);

    res.json({
      success: true,
      message: 'Payment marked as success and balance updated',
      payment: paymentData,
      updatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('âŒ Payment Resolution Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resolve payment',
      error: error.message
    });
  }
});

/**
 * GET /api/payments/user-balance/:userId
 * Get user's current account balance from database
 */
router.get('/user-balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    console.log('ðŸ’° Fetching user balance for:', userId);

    // Fetch from database
    try {
      const { data, error } = await supabase
        .from('users')
        .select('account_balance, stakeable_balance, withdrawable_balance, withdrawal_activated, withdrawal_activation_date')
        .eq('id', userId);

      if (error) {
        console.warn('âš ï¸ Database error fetching balance:', error.message);
        return res.json({
          success: true,
          balance: null,
          account_balance: null,
          available_to_bet: null,
          message: 'Database error. Using default balance.'
        });
      }

      if (!data || data.length === 0) {
        console.warn('âš ï¸ User not found in database:', userId);
        return res.json({
          success: true,
          balance: null,
          account_balance: null,
          available_to_bet: null,
          message: 'User not found. Using default balance.'
        });
      }

      const depositedBalance = parseFloat(data[0].account_balance) || 0;
      const stakeableBalance = parseFloat(data[0].stakeable_balance) || depositedBalance;
      const withdrawableBalance = parseFloat(data[0].withdrawable_balance) || 0;
      const accountBalance = depositedBalance;
      const availableToBet = stakeableBalance;
      const withdrawalActivated = data[0].withdrawal_activated || false;
      const withdrawalActivationDate = data[0].withdrawal_activation_date || null;
      console.log('âœ… User balance fetched successfully:', { userId, accountBalance, stakeableBalance, withdrawableBalance, withdrawalActivated });

      res.json({
        success: true,
        balance: accountBalance,
        account_balance: accountBalance,
        available_to_bet: availableToBet,
        stakeable_balance: stakeableBalance,
        withdrawable_balance: withdrawableBalance,
        deposited_balance: depositedBalance,
        winnings_balance: withdrawableBalance,
        withdrawalActivated,
        withdrawalActivationDate,
        userId,
        timestamp: new Date().toISOString()
      });
    } catch (dbError) {
      console.warn('âš ï¸ Database error fetching balance:', dbError.message);
      res.json({
        success: true,
        balance: null,
        account_balance: null,
        available_to_bet: null,
        message: 'Database unavailable. Using cached balance.'
      });
    }
  } catch (error) {
    console.error('âŒ Balance Fetch Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user balance',
      error: error.message
    });
  }
});

/**
 * PUT /api/payments/admin/update-balance/:userId
 * Admin endpoint - Update user's account balance
 */
router.put('/admin/update-balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { newBalance, reason } = req.body;

    if (typeof newBalance !== 'number' || newBalance < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid balance amount'
      });
    }

    console.log(`\nðŸ’¼ Admin updating balance for user: ${userId}`);
    console.log(`   New Balance: ${newBalance}, Reason: ${reason}`);

    // Get current balance for the transaction record
    let previousBalance = 0;
    try {
      const { data, error } = await supabase
        .from('users')
        .select('account_balance')
        .eq('id', userId)
        .single();

      if (!error && data) {
        previousBalance = parseFloat(data.account_balance) || 0;
      }
    } catch (err) {
      console.warn('âš ï¸ Could not fetch previous balance:', err.message);
    }

    // Update balance in database
    try {
      const { error: updateError } = await supabase
        .from('users')
        .update({ account_balance: newBalance })
        .eq('id', userId);

      if (updateError) {
        console.error('âŒ Failed to update balance:', updateError.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to update balance',
          error: updateError.message
        });
      }

      console.log(`âœ… Balance updated. Previous: ${previousBalance}, New: ${newBalance}`);
    } catch (dbError) {
      console.error('âŒ Database error:', dbError.message);
      return res.status(500).json({
        success: false,
        message: 'Database error',
        error: dbError.message
      });
    }

    // Record admin transaction
    try {
      const balanceDiff = newBalance - previousBalance;
      const transactionType = balanceDiff > 0 ? 'admin_credit' : 'admin_debit';

      const { error: transactionError } = await supabase
        .from('transactions')
        .insert({
          transaction_id: `ADMIN-${Date.now()}-${userId}`,
          user_id: userId,
          type: transactionType,
          amount: Math.abs(balanceDiff),
          status: 'completed',
          external_reference: `ADMIN-${Date.now()}`,
          description: reason || 'Admin balance adjustment',
          created_at: new Date().toISOString()
        });

      if (transactionError) {
        console.warn('âš ï¸ Failed to record admin transaction:', transactionError.message);
      } else {
        console.log('âœ… Admin transaction recorded');
      }
    } catch (transactionError) {
      console.warn('âš ï¸ Transaction error:', transactionError.message);
    }

    console.log(`\nâœ… Balance update completed for user ${userId}\n`);

    res.json({
      success: true,
      message: 'Balance updated successfully',
      userId,
      previousBalance,
      newBalance,
      updatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('âŒ Admin Balance Update Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user balance',
      error: error.message
    });
  }
});

/**
 * POST /api/payments/admin/complete/:externalReference
 * Admin endpoint - Complete a pending payment manually (for testing)
 */
router.post('/admin/complete/:externalReference', async (req, res) => {
  try {
    const { externalReference } = req.params;

    console.log('ðŸ”§ Admin attempting to complete payment:', externalReference);

    // Get from cache first
    let payment = paymentCache.getPayment(externalReference);
    
    if (!payment) {
      // Try database
      try {
        const { data } = await supabase
          .from('payments')
          .select('*')
          .eq('external_reference', externalReference)
          .single();
        
        if (data) {
          payment = data;
        }
      } catch (dbError) {
        console.warn('âš ï¸ Payment not found in database');
      }
    }

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Update status to Success
    const updatedPayment = {
      ...payment,
      status: 'Success',
      result_code: '0',
      result_desc: 'Payment completed by admin',
      mpesa_receipt: `MCC${Date.now()}`, // Mock receipt number
      completed_at: new Date().toISOString()
    };

    // Update cache
    paymentCache.storePayment(externalReference, payment.CheckoutRequestID || payment.checkout_request_id, updatedPayment);

    // Try to update database
    try {
      await supabase
        .from('payments')
        .update({ 
          status: 'Success',
          result_code: '0',
          result_desc: 'Payment completed by admin',
          mpesa_receipt: updatedPayment.mpesa_receipt,
          updated_at: new Date().toISOString()
        })
        .eq('external_reference', externalReference);
    } catch (dbError) {
      console.warn('âš ï¸ Database update failed, using cache only:', dbError.message);
    }

    console.log('âœ… Payment completed manually:', externalReference);

    res.json({
      success: true,
      message: 'Payment completed successfully',
      payment: updatedPayment
    });

  } catch (error) {
    console.error('âŒ Admin Payment Completion Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete payment',
      error: error.message
    });
  }
});

/**
 * DELETE /api/payments/admin/users/:userId
 * Admin endpoint - Delete a user account permanently
 */
router.delete('/admin/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    console.log('ðŸ—‘ï¸ Admin attempting to delete user:', userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Try to delete from database
    let dbSuccess = false;
    try {
      // Delete user transactions first
      await supabase
        .from('transactions')
        .delete()
        .eq('user_id', userId);

      // Delete user payments
      await supabase
        .from('payments')
        .delete()
        .eq('user_id', userId);

      // Delete user
      const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', userId);

      if (!error) {
        dbSuccess = true;
        console.log('âœ… User deleted from database:', userId);
      } else {
        console.warn('âš ï¸ Database deletion error:', error.message);
      }
    } catch (dbError) {
      console.warn('âš ï¸ Database error during user deletion:', dbError.message);
    }

    res.json({
      success: true,
      message: dbSuccess ? 'User deleted successfully' : 'User deletion initiated (database unavailable)',
      userId: userId,
      dbSuccess: dbSuccess
    });

  } catch (error) {
    console.error('âŒ User Deletion Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message
    });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// USER DARAJA DIRECT STK PUSH ENDPOINTS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /api/payments/daraja/initiate
 * Initiate a Daraja (Safaricom direct) STK push for a regular user.
 * paymentType: 'deposit' | 'activation' | 'priority'
 */
router.post('/daraja/initiate', async (req, res) => {
  try {
    const { userId, phoneNumber, amount, paymentType = 'deposit', relatedWithdrawalId } = req.body;

    if (!userId || !phoneNumber || !amount) {
      return res.status(400).json({ success: false, message: 'userId, phoneNumber, and amount are required' });
    }

    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
      return res.status(400).json({ success: false, message: 'Amount must be at least KSH 1' });
    }

    // Minimum for regular deposits only
    const minDeposit = parseFloat(process.env.MIN_DEPOSIT_AMOUNT || `${TEST_MIN_DEPOSIT_AMOUNT}`);
    if (paymentType === 'deposit' && parsedAmount < minDeposit) {
      return res.status(400).json({ success: false, message: `Minimum deposit is KSH ${minDeposit}` });
    }

    const normalizedPhone = normalizeDarajaPhoneNumber(phoneNumber);
    const suffix = `${Date.now()}`.slice(-8);
    const externalReference = `DUSER-${paymentType.toUpperCase().slice(0, 3)}-${suffix}`;

    const callbackBase = (process.env.DARAJA_TEST_CALLBACK_BASE_URL || process.env.SERVER_PUBLIC_URL || 'https://www.betnexabackend.co.ke').replace(/[\r\n]+/g, '').replace(/\/$/, '').trim();
    const callbackUrl = `${callbackBase}/api/callbacks/daraja-user`;

    // Pre-warm Daraja access token AND fetch user data in parallel to eliminate sequential delay
    const [, userData] = await Promise.all([
      warmDarajaToken().catch(() => null),
      supabase.from('users').select('username, betnexa_id').eq('id', userId).maybeSingle()
        .then(({ data }) => data)
        .catch(() => null),
    ]);

    const betnexaId = userData?.betnexa_id || '';
    const username = userData?.username || '';
    const userIdentifier = betnexaId || username || userId.substring(0, 8);

    const descriptionMap = {
      deposit: 'Betnexa deposit',
      activation: 'Withdrawal activation fee',
      priority: 'Priority withdrawal fee',
    };

    let accountReference;
    if (paymentType === 'deposit') {
      accountReference = userIdentifier;
    } else if (paymentType === 'activation') {
      accountReference = `ACT${userIdentifier}`;
    } else if (paymentType === 'priority') {
      accountReference = `PRI${userIdentifier}`;
    } else {
      accountReference = userIdentifier;
    }

    // Send STK push â€” token is already warmed so this goes straight to the push request
    const result = await initiateAdminTestStkPush({
      phoneNumber: normalizedPhone,
      amount: parsedAmount,
      accountReference: accountReference,
      transactionDesc: descriptionMap[paymentType] || 'Betnexa payment',
      callbackUrl,
    });

    // MUST await before responding â€” Vercel terminates the function as soon as the handler
    // returns, so background .then() promises are killed. The DB record must exist before
    // the response reaches the client (and before any M-Pesa callback can arrive).
    const registerResult = await registerUserDarajaAttempt({
      userId,
      phoneNumber: normalizedPhone,
      amount: parsedAmount,
      externalReference,
      checkoutRequestId: result.checkoutRequestId,
      merchantRequestId: result.merchantRequestId,
      paymentType,
      relatedWithdrawalId,
    });
    if (!registerResult.success) {
      console.error('[daraja/initiate] Failed to register attempt:', registerResult.error);
    }

    return res.json({
      success: true,
      message: result.customerMessage || 'STK push sent to your phone',
      checkoutRequestId: result.checkoutRequestId,
      merchantRequestId: result.merchantRequestId,
      externalReference,
      phoneNumber: normalizedPhone,
      amount: parsedAmount,
      paymentType,
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to initiate Daraja STK push';
    console.error('[daraja/initiate] Error:', message);

    const isGatewayUnavailable = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|timed out|connect .*443|Daraja .*failed|Daraja request failed with status \d+|HTTP 400|HTTP 401|HTTP 403|api\.safaricom\.co\.ke|M-Pesa STK .* unavailable|temporarily unavailable)/i.test(message);

    if (isGatewayUnavailable) {
      return res.status(503).json({
        success: false,
        message: 'M-Pesa STK is temporarily unavailable. Please use the Paybill deposit option below instead.',
        error: message,
        fallback: 'offline_paybill',
        gatewayStatus: 'daraja_down',
        retryable: true
      });
    }

    return res.status(500).json({
      success: false,
      message: message,
      error: message,
      gatewayStatus: 'unknown_error',
      retryable: true
    });
  }
});

/**
 * GET /api/payments/daraja/status?checkoutRequestId=...
 * Poll payment status and credit balance if successful.
 */
router.get('/daraja/status', async (req, res) => {
  const { checkoutRequestId } = req.query;
  try {
    if (!checkoutRequestId) {
      return res.status(400).json({ success: false, message: 'checkoutRequestId is required' });
    }

    // Check callback cache first (fastest path)
    const callbackData = paymentCache.getCallback(checkoutRequestId);
    if (callbackData) {
      const status = interpretUserDarajaStatus(callbackData);
      let funding = null;
      let terminal = null;

      if (status === 'success') {
        funding = await ensureUserDarajaFunding({
          checkoutRequestId,
          mpesaReceipt: callbackData.mpesaReceipt || null,
          resultCode: callbackData.resultCode,
          resultDesc: callbackData.resultDesc,
          amount: callbackData.amount || null,
          phoneNumber: callbackData.phoneNumber || null,
        });
        if (!funding.success) {
          // Transaction not in DB yet (race) â€” treat as still pending, don't 500
          console.warn('[daraja/status] ensureUserDarajaFunding not ready:', funding.error);
          return res.json({ success: true, status: 'pending', message: 'Payment processing, please wait' });
        }
      } else if (status === 'failed' || status === 'cancelled') {
        terminal = await persistUserDarajaTerminalStatus({
          checkoutRequestId,
          status,
          resultCode: callbackData.resultCode,
          resultDesc: callbackData.resultDesc,
          mpesaReceipt: callbackData.mpesaReceipt || null,
          amount: callbackData.amount || null,
          phoneNumber: callbackData.phoneNumber || null,
        });
        if (!terminal.success) {
          return res.status(500).json({ success: false, message: terminal.error || 'Failed to persist terminal status' });
        }
      }

      return res.json({ success: true, status, source: 'callback', result: callbackData, funding, terminal });
    }

    // Query Daraja live
    const queryResult = await queryAdminTestStkPushStatus({ checkoutRequestId });
    const status = interpretUserDarajaStatus(queryResult);
    let funding = null;
    let terminal = null;

    if (status === 'success') {
      funding = await ensureUserDarajaFunding({
        checkoutRequestId,
        mpesaReceipt: queryResult.MpesaReceiptNumber || queryResult.mpesaReceipt || null,
        resultCode: queryResult.ResultCode ?? queryResult.resultCode,
        resultDesc: queryResult.ResultDesc || queryResult.resultDesc,
      });
      if (!funding.success) {
        // Transaction not in DB yet â€” treat as pending, keep polling
        console.warn('[daraja/status] ensureUserDarajaFunding not ready:', funding.error);
        return res.json({ success: true, status: 'pending', message: 'Payment processing, please wait' });
      }
    } else if (status === 'failed' || status === 'cancelled') {
      terminal = await persistUserDarajaTerminalStatus({
        checkoutRequestId,
        status,
        resultCode: queryResult.ResultCode ?? queryResult.resultCode,
        resultDesc: queryResult.ResultDesc || queryResult.resultDesc,
        mpesaReceipt: queryResult.MpesaReceiptNumber || queryResult.mpesaReceipt || null,
        amount: queryResult.Amount || queryResult.amount || null,
        phoneNumber: queryResult.PhoneNumber || queryResult.phoneNumber || null,
      });
      if (!terminal.success) {
        return res.status(500).json({ success: false, message: terminal.error || 'Failed to persist terminal status' });
      }
    }

    return res.json({ success: true, status, source: 'query', result: queryResult, funding, terminal });
  } catch (error) {
    console.error('[daraja/status] Error:', error.message || error);
    // A transient query error must not become a terminal failure. Keep polling.
    return res.json({ success: true, status: 'pending', message: error.message || 'Status check retrying' });
  }
});

/**
 * GET /api/payments/debug/daraja-config
 * DEBUG ENDPOINT - Check current Daraja configuration being used
 */
router.get('/debug/daraja-config', (req, res) => {
  try {
    const config = {
      DARAJA_TEST_CONSUMER_KEY: process.env.DARAJA_TEST_CONSUMER_KEY ? 'âœ“ SET' : 'âœ— MISSING',
      DARAJA_TEST_CONSUMER_SECRET: process.env.DARAJA_TEST_CONSUMER_SECRET ? 'âœ“ SET' : 'âœ— MISSING',
      DARAJA_TEST_PARTY_B: process.env.DARAJA_TEST_PARTY_B || 'âœ— MISSING',
      DARAJA_TEST_PASSKEY: process.env.DARAJA_TEST_PASSKEY ? 'âœ“ SET' : 'âœ— MISSING',
      DARAJA_TEST_SHORT_CODE: process.env.DARAJA_TEST_SHORT_CODE || 'âœ— MISSING',
      DARAJA_TEST_TRANSACTION_TYPE: process.env.DARAJA_TEST_TRANSACTION_TYPE || 'CustomerPayBillOnline',
      DARAJA_TEST_CALLBACK_BASE_URL: process.env.DARAJA_TEST_CALLBACK_BASE_URL || 'NOT SET',
      NODE_ENV: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    };

    console.log('ðŸ” DEBUG: Daraja Configuration:', config);

    res.json({
      success: true,
      debug: true,
      config: config,
      message: 'Current Daraja configuration (PartyB is the till number receiving payments)'
    });
  } catch (error) {
    console.error('âŒ Debug error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/test-deposit
 * TEST ENDPOINT - Make a test deposit and see which till handles it
 */
router.post('/test-deposit', async (req, res) => {
  try {
    const { phoneNumber, amount = 100 } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'phoneNumber is required' });
    }

    console.log('\n' + '='.repeat(80));
    console.log('ðŸ§ª TEST DEPOSIT INITIATED');
    console.log('='.repeat(80));
    
    // Log all environment variables
    console.log('\nðŸ“‹ Environment Variables:');
    console.log('   DARAJA_TEST_PARTY_B:', process.env.DARAJA_TEST_PARTY_B || 'NOT SET');
    console.log('   DARAJA_TEST_SHORT_CODE:', process.env.DARAJA_TEST_SHORT_CODE || 'NOT SET');
    console.log('   DARAJA_TEST_CONSUMER_KEY:', process.env.DARAJA_TEST_CONSUMER_KEY ? 'SET' : 'NOT SET');
    console.log('   DARAJA_TEST_TRANSACTION_TYPE:', process.env.DARAJA_TEST_TRANSACTION_TYPE || 'NOT SET');
    console.log('   NODE_ENV:', process.env.NODE_ENV);

    const normalizedPhone = normalizeDarajaPhoneNumber(phoneNumber);
    const suffix = `${Date.now()}`.slice(-8);
    const externalReference = `TEST-${suffix}`;

    const callbackBase = (process.env.DARAJA_TEST_CALLBACK_BASE_URL || process.env.SERVER_PUBLIC_URL || 'https://www.betnexabackend.co.ke').replace(/[\r\n]+/g, '').replace(/\/$/, '').trim();
    const callbackUrl = `${callbackBase}/api/callbacks/daraja-user`;

    console.log('\nðŸ’³ Payment Details:');
    console.log('   Phone:', normalizedPhone);
    console.log('   Amount:', amount);
    console.log('   Reference:', externalReference);
    console.log('   Callback URL:', callbackUrl);

    // Initiate STK push directly
    const result = await initiateAdminTestStkPush({
      phoneNumber: normalizedPhone,
      amount: parseFloat(amount),
      accountReference: `TEST${suffix}`,
      transactionDesc: 'Test deposit - check till number',
      callbackUrl,
    });

    console.log('\nâœ… STK Push Result:');
    console.log('   CheckoutRequestID:', result.checkoutRequestId);
    console.log('   MerchantRequestID:', result.merchantRequestId);
    console.log('   Response:', result.responseDescription);

    console.log('\nðŸ“ IMPORTANT: Check your M-Pesa which till number the STK push is being sent to!');
    console.log('   The till number should be: ' + (process.env.DARAJA_TEST_PARTY_B || 'NOT SET'));
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      message: 'Test deposit initiated successfully. Check your phone for STK push.',
      data: {
        externalReference,
        checkoutRequestId: result.checkoutRequestId,
        phoneNumber: normalizedPhone,
        amount: parseFloat(amount),
        till_number_configured: process.env.DARAJA_TEST_PARTY_B || 'NOT SET',
        note: 'Check which till number the STK push is actually being sent to.'
      }
    });

  } catch (error) {
    console.error('âŒ Test deposit error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      till_number_configured: process.env.DARAJA_TEST_PARTY_B || 'NOT SET'
    });
  }
});

module.exports = router;


