/**
 * Payment Routes
 * Handles deposit requests and payment status checks
 */

const express = require('express');
const router = express.Router();
const { initiatePayment } = require('../services/paymentService.js');
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
        console.log(`\n⏰ [TIMEOUT CHECK] Checking payment: ${externalReference}`);
        
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
          console.warn('⚠️ Timeout check DB error:', dbError.message);
          // Fall back to cache
          const cachedPayment = paymentCache.getPayment(externalReference);
          if (cachedPayment) {
            currentPaymentStatus = cachedPayment.status;
          }
        }

        if (currentPaymentStatus === 'PENDING') {
          // Do NOT auto-fail deposits after short delays; users can take time to enter PIN.
          // Final state should come from callback or live status polling.
          console.log(`⏳ [TIMEOUT CHECK] Payment still pending after 10 seconds: ${externalReference}. Leaving as pending.`);
        } else {
          console.log(`✅ [TIMEOUT CHECK] Payment ${externalReference} has status: ${currentPaymentStatus} - No timeout needed\n`);
        }
        
        resolve();
      } catch (error) {
        console.error('❌ [TIMEOUT] Error in timeout handler:', error);
        resolve();
      }
    }, 10000); // 10 seconds
  });
}

/**
 * POST /api/payments/initiate
 * Initiate a new payment
 */
router.post('/initiate', async (req, res) => {
  try {
    const { amount, phoneNumber, userId, paymentType, relatedWithdrawalId } = req.body;

    console.log('📋 Payment Initiation Request:', { amount, phoneNumber, userId, paymentType, relatedWithdrawalId });

    // Validation
    if (!amount || !phoneNumber || !userId) {
      console.log('❌ Validation failed: Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Amount, phone number, and user ID are required'
      });
    }

    const numAmount = parseFloat(amount);
    const resolvedPaymentType = paymentType || 'deposit';
    const minDepositAmount = parseFloat(process.env.MIN_DEPOSIT_AMOUNT || `${TEST_MIN_DEPOSIT_AMOUNT}`);
    // Enforce configurable minimum for regular deposits; activation/priority fees are exempt
    if (resolvedPaymentType === 'deposit' && numAmount < minDepositAmount) {
      console.log('❌ Validation failed: Deposit amount too low');
      return res.status(400).json({
        success: false,
        message: `Amount must be at least KSH ${minDepositAmount}`
      });
    }
    if (numAmount < 1) {
      return res.status(400).json({ success: false, message: 'Amount must be at least KSH 1' });
    }

    // Enforce minimum withdrawal amount
    if (resolvedPaymentType === 'withdrawal' && numAmount < 600) {
      console.log('❌ Validation failed: Withdrawal amount too low');
      return res.status(400).json({
        success: false,
        message: 'Minimum withdrawal amount is KSH 600'
      });
    }

    // If withdrawal, enforce only withdrawable_balance can be withdrawn (winnings)
    if (resolvedPaymentType === 'withdrawal') {
      // Fetch user's withdrawable_balance (winnings only)
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('withdrawable_balance, stakeable_balance')
        .eq('id', userId)
        .single();

      if (userError || !user) {
        console.log('❌ Withdrawal failed: User not found');
        return res.status(400).json({
          success: false,
          message: 'User not found for withdrawal'
        });
      }

      const withdrawableBalance = parseFloat(user.withdrawable_balance || 0);
      const stakeableBalance = parseFloat(user.stakeable_balance || 0);
      
      if (withdrawableBalance < numAmount) {
        console.log('❌ Withdrawal failed: Insufficient withdrawable balance (winnings)');
        console.log(`   Requested: KSH ${numAmount}`);
        console.log(`   Withdrawable (winnings): KSH ${withdrawableBalance}`);
        console.log(`   Stakeable (deposits): KSH ${stakeableBalance} [Not withdrawal available]`);
        return res.status(400).json({
          success: false,
          message: 'Insufficient withdrawable balance (winnings only)',
          withdrawable_balance: withdrawableBalance,
          stakeable_balance: stakeableBalance,
          requested: numAmount
        });
      }

      // Deduct from withdrawable_balance only
      const newWithdrawableBalance = withdrawableBalance - numAmount;
      const newTotalBalance = stakeableBalance + newWithdrawableBalance;
      
      const { error: updateError } = await supabase
        .from('users')
        .update({ withdrawable_balance: newWithdrawableBalance, account_balance: newTotalBalance, updated_at: new Date().toISOString() })
        .eq('id', userId);

      if (updateError) {
        console.log('❌ Withdrawal failed: Could not update withdrawable_balance');
        return res.status(500).json({
          success: false,
          message: 'Failed to update withdrawable balance for withdrawal',
          details: updateError.message
        });
      }
      
      console.log(`✅ Withdrawal deducted from withdrawable balance`);
      console.log(`   Withdrawable: KSH ${withdrawableBalance} → KSH ${newWithdrawableBalance}`);
    }

    // Generate reference
    const externalReference = `DEP-${Date.now()}-${userId}`;
    // Trim trailing whitespace/newlines that PowerShell piped env var input can add
    const baseCallbackUrl = (process.env.CALLBACK_URL || 'https://betnexarevivebackend.vercel.app').trim();
    const callbackUrl = `${baseCallbackUrl}/api/callbacks/payhero`;
    console.log('📡 Callback URL being sent to PayHero:', callbackUrl);

    console.log('🔄 Initiating payment with PayHero...');
    console.log('📞 Phone:', phoneNumber);
    console.log('💰 Amount:', numAmount);
    console.log('📝 Reference:', externalReference);

    // DEVELOPMENT MODE: Use mock payment for testing
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    if (isDevelopment && process.env.USE_MOCK_PAYMENTS === 'true') {
      console.log('🧪 [DEV MODE] Using mock payment processing...');
      console.log('✅ Mock STK Push would be sent to:', phoneNumber);
      
      const mockCheckoutRequestId = `MOCK-${Date.now()}`;
      
      // Store in cache for status checks
      paymentCache.storePayment(externalReference, mockCheckoutRequestId, {
        status: 'PENDING',
        amount: numAmount,
        phone_number: phoneNumber,
        user_id: userId,
        created_at: new Date().toISOString()
      });
      // Do NOT auto-complete - wait for actual PayHero callback
      
      return res.status(200).json({
        success: true,
        data: {
          CheckoutRequestID: mockCheckoutRequestId,
          merchant_request_id: mockCheckoutRequestId,
          response_code: '0',
          response_description: 'Success. Request accepted for processing',
          customer_message: 'Success. Request accepted for processing',
          externalReference: externalReference
        },
        externalReference: externalReference,
        statusCode: 200,
        isMockPayment: true
      });
    }

    // Initiate payment with PayHero
    let paymentResult;
    try {
      paymentResult = await initiatePayment(
        numAmount,
        phoneNumber,
        externalReference,
        callbackUrl
      );
    } catch (paymentError) {
      console.error('❌ PayHero API Error:', paymentError);
      
      // Fallback to mock payment in development if real API fails
      if (isDevelopment) {
        console.log('🔄 Falling back to mock payment...');
        const mockCheckoutRequestId = `MOCK-${Date.now()}`;
        
        // Store in cache for status checks
        paymentCache.storePayment(externalReference, mockCheckoutRequestId, {
          status: 'PENDING',
          amount: numAmount,
          phone_number: phoneNumber,
          user_id: userId,
          created_at: new Date().toISOString()
        });
        // Do NOT auto-complete - wait for actual PayHero callback
        
        return res.status(200).json({
          success: true,
          data: {
            CheckoutRequestID: mockCheckoutRequestId,
            merchant_request_id: mockCheckoutRequestId,
            response_code: '0',
            response_description: 'Success. Request accepted for processing',
            customer_message: 'Success. Request accepted for processing',
            externalReference: externalReference
          },
          externalReference: externalReference,
          statusCode: 200,
          isMockPayment: true
        });
      }
      
      return res.status(400).json({
        success: false,
        message: paymentError.message || 'Failed to initiate payment with PayHero',
        details: paymentError.error || paymentError
      });
    }

    if (!paymentResult.success) {
      console.error('❌ PayHero returned error:', paymentResult);
      return res.status(400).json(paymentResult);
    }

    const checkoutRequestId = paymentResult.data.CheckoutRequestID;
    console.log('✅ STK push initiated. CheckoutRequestID:', checkoutRequestId);

    // Store payment record in database and cache (non-blocking)
    try {
      const paymentData = {
        user_id: userId,
        amount: numAmount,
        phone_number: phoneNumber,
        external_reference: externalReference,
        checkout_request_id: checkoutRequestId,
        status: 'PENDING'
      };

      let { error } = await supabase
        .from('payments')
        .insert(paymentData);

      // Production schema fallback: if checkout_request_id is not present in payments,
      // retry insert without it so we still have a durable payment record.
      if (error && /checkout_request_id/i.test(error.message || '')) {
        const minimalPaymentData = {
          user_id: userId,
          amount: numAmount,
          phone_number: phoneNumber,
          external_reference: externalReference,
          status: 'PENDING'
        };
        const retry = await supabase.from('payments').insert(minimalPaymentData);
        error = retry.error;
      }

      if (error) {
        console.warn('⚠️ Database Storage Warning:', error.message);
        // Don't fail the payment initiation if DB storage fails
        // The payment was already sent to PayHero
      } else {
        console.log('✅ Payment record stored in database');
      }

      // Create a pending transaction record immediately (visible to admin even if payment not yet confirmed)
      try {
        console.log('📊 Creating pending deposit transaction record...');
        const depositTxData = {
          transaction_id: `DEP-${Date.now()}-${externalReference}`,
          user_id: userId,
          type: 'deposit',
          amount: numAmount,
          status: 'pending',
          external_reference: externalReference,
          method: 'M-Pesa STK Push',
          phone_number: phoneNumber,
          description: 'M-Pesa deposit - awaiting admin approval',
          created_at: new Date().toISOString()
        };

        // Try insert with all fields first
        let { error: transactionError } = await supabase
          .from('transactions')
          .insert(depositTxData);

        if (transactionError) {
          console.warn('⚠️ First insert attempt failed:', transactionError.message, '- Details:', transactionError.details);
          // Retry with minimal fields
          console.log('🔄 Retrying with minimal fields...');
          const { error: retryError } = await supabase
            .from('transactions')
            .insert({
              transaction_id: depositTxData.transaction_id,
              user_id: userId,
              type: 'deposit',
              amount: numAmount,
              status: 'pending',
              external_reference: externalReference,
              created_at: new Date().toISOString()
            });

          if (retryError) {
            console.error('❌ Deposit transaction insert FAILED:', retryError.message, retryError.details, retryError.code);
          } else {
            console.log('✅ Pending deposit transaction created (minimal fields)');
          }
        } else {
          console.log('✅ Pending deposit transaction created - visible to admin and user');
        }
      } catch (txError) {
        console.error('❌ Error creating pending deposit transaction:', txError.message);
      }

      // Create fund transfer record in the dedicated fund_transfers table
      try {
        console.log('💳 Creating fund transfer record...');
        const fundTransferData = {
          user_id: userId,
          transfer_type: 'deposit',
          amount: numAmount,
          phone_number: phoneNumber,
          status: 'pending',
          method: 'M-Pesa',
          external_reference: externalReference,
          checkout_request_id: checkoutRequestId,
          is_stk_push_sent: true,
          stk_sent_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        
        console.log('   Fund transfer data:', JSON.stringify(fundTransferData, null, 2));
        
        const { data: fundTransfer, error: fundTransferError } = await supabase
          .from('fund_transfers')
          .insert([fundTransferData])
          .select();

        if (fundTransferError) {
          console.warn('⚠️ Failed to create fund transfer record:');
          console.warn('   Error message:', fundTransferError.message);
          console.warn('   Error details:', fundTransferError.details);
          console.warn('   Error code:', fundTransferError.code);
        } else {
          console.log('✅ Fund transfer record created:', fundTransfer?.[0]?.id);
        }
      } catch (fundError) {
        console.warn('⚠️ Error creating fund transfer record:', fundError.message);
        console.warn('   Stack:', fundError.stack);
      }

      // Insert into dedicated deposits or activation_fees table based on paymentType
      const resolvedType = paymentType || 'deposit'; // default to deposit
      try {
        if (resolvedType === 'activation' || resolvedType === 'priority') {
          console.log(`📝 Creating ${resolvedType} fee record in activation_fees table...`);
          const { error: feeError } = await supabase
            .from('activation_fees')
            .insert({
              user_id: userId,
              fee_type: resolvedType,
              amount: numAmount,
              phone_number: phoneNumber,
              external_reference: externalReference,
              checkout_request_id: checkoutRequestId,
              status: 'pending',
              related_withdrawal_id: relatedWithdrawalId || null,
              method: 'M-Pesa STK Push',
              description: resolvedType === 'activation'
                ? `Withdrawal activation fee - KSH ${TEST_ACTIVATION_FEE}`
                : `Priority withdrawal fee - KSH ${TEST_PRIORITY_FEE}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            });

          if (feeError) {
            console.warn(`⚠️ Failed to insert ${resolvedType} fee record:`, feeError.message);
          } else {
            console.log(`✅ ${resolvedType} fee record created in activation_fees table`);
          }
        } else {
          console.log('📝 Creating deposit record in deposits table...');
          const { error: depositError } = await supabase
            .from('deposits')
            .insert({
              user_id: userId,
              amount: numAmount,
              phone_number: phoneNumber,
              external_reference: externalReference,
              checkout_request_id: checkoutRequestId,
              status: 'pending',
              method: 'M-Pesa STK Push',
              description: 'M-Pesa deposit - awaiting admin approval',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            });

          if (depositError) {
            console.warn('⚠️ Failed to insert deposit record:', depositError.message);
          } else {
            console.log('✅ Deposit record created in deposits table');
          }
        }
      } catch (tableError) {
        console.warn('⚠️ Error inserting into dedicated table:', tableError.message);
      }

      // Always cache the payment for fallback
      paymentCache.storePayment(externalReference, checkoutRequestId, paymentData);
      console.log('✅ Payment cached for fallback');

    } catch (dbError) {
      console.warn('⚠️ Database Error (non-blocking):', dbError.message);
      // Cache the payment even if DB fails
      try {
        const paymentData = {
          user_id: userId,
          amount: numAmount,
          phone_number: phoneNumber,
          external_reference: externalReference,
          checkout_request_id: checkoutRequestId,
          status: 'PENDING'
        };
        paymentCache.storePayment(externalReference, checkoutRequestId, paymentData);
        console.log('✅ Payment cached as fallback (DB error)');
      } catch (cacheError) {
        console.warn('⚠️ Cache Error:', cacheError.message);
      }
      // Continue - the payment was already initiated with PayHero
    }

    console.log('✅ Payment initiation completed successfully');

    // Send withdrawal SMS notification (fire-and-forget)
    if (resolvedPaymentType === 'withdrawal') {
        supabase.from('users').select('account_balance').eq('id', userId).maybeSingle()
          .then(({ data: u }) => {
            const newBal = Math.max(0, (parseFloat(u?.account_balance) || 0) - numAmount);
            sendWithdrawalSms(phoneNumber, numAmount, newBal).catch(() => {});
          })
          .catch(() => {
            sendWithdrawalSms(phoneNumber, numAmount).catch(() => {});
          });
      }
    
    // Prepare payment data for timeout handler
    const paymentDataForTimeout = {
      user_id: userId,
      amount: numAmount,
      phone_number: phoneNumber,
      external_reference: externalReference,
      checkout_request_id: checkoutRequestId,
      status: 'PENDING'
    };

    // Send response immediately
    res.json({
      success: true,
      message: 'Payment initiated successfully. STK push sent to your phone.',
      data: {
        externalReference,
        checkoutRequestId,
        amount: numAmount,
        phone: phoneNumber
      }
    });

    // Start timeout handler in background (non-blocking)
    handlePaymentTimeout(externalReference, checkoutRequestId, paymentDataForTimeout)
      .catch(err => console.error('❌ Error in background timeout handler:', err));


  } catch (error) {
    console.error('❌ Payment Initiation Error:', error);
    res.status(500).json({
      success: false,
      message: 'Payment initiation failed',
      error: error.message
    });
  }
});

/**
 * Helper: query PayHero transaction-status API directly
 */
async function queryPayHeroStatus(externalReference) {
  return new Promise((resolve) => {
    const { generateBasicAuthToken } = require('../services/paymentService.js');
    const https = require('https');
    const options = {
      hostname: 'backend.payhero.co.ke',
      port: 443,
      path: `/api/v2/transaction-status?reference=${encodeURIComponent(externalReference)}`,
      method: 'GET',
      headers: { 'Authorization': generateBasicAuthToken() },
      timeout: 10000,
      rejectUnauthorized: false
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ ok: true, body: JSON.parse(data) }); }
        catch (_) { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

/**
 * Helper: credit user balance with idempotency guard.
 * Updates BOTH stakeable_balance and account_balance to stay consistent.
 */
async function creditBalanceIfNotDone(externalReference, userId, amount) {
  // Check idempotency: skip if already completed in either table
  const { data: done } = await supabase.from('transactions').select('id').eq('external_reference', externalReference).eq('status', 'completed').maybeSingle();
  const { data: doneDeposit } = await supabase.from('deposits').select('id').eq('external_reference', externalReference).eq('status', 'completed').maybeSingle();
  if (done || doneDeposit) { console.log('⚠️ Already credited for', externalReference); return false; }

  // Fetch full user balance fields for consistent update
  const { data: user } = await supabase.from('users').select('account_balance, stakeable_balance, withdrawable_balance').eq('id', userId).single();
  if (!user) { console.warn('⚠️ User not found for credit:', userId); return false; }

  const prevStakeable = parseFloat(user.stakeable_balance) || 0;
  const newStakeable = prevStakeable + parseFloat(amount);
  const newBalance = newStakeable + (parseFloat(user.withdrawable_balance) || 0);

  await supabase.from('users').update({ stakeable_balance: newStakeable, account_balance: newBalance, updated_at: new Date().toISOString() }).eq('id', userId);
  console.log(`✅ [STATUS POLL] Stakeable credited: ${prevStakeable} → ${newStakeable}, total: ${newBalance} (user ${userId})`);

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
 * Check payment status — also queries PayHero live and credits balance on success
 */
router.get('/status/:externalReference', async (req, res) => {
  try {
    const { externalReference } = req.params;
    console.log('🔍 Checking payment status:', externalReference);

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
        console.log('📡 PayHero live status:', phStatus, 'code:', phCode);

        if (phStatus === 'success' || phCode === 0 || phCode === '0') {
          try { await creditBalanceIfNotDone(externalReference, paymentRecord.user_id, paymentRecord.amount); } catch (e) { console.warn('⚠️ Credit error in poll:', e.message); }
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
        try { await creditBalanceIfNotDone(externalReference, paymentRecord.user_id, paymentRecord.amount); } catch (e) { console.warn('⚠️ Credit error on normalized success:', e.message); }
      }
      return res.json({ success: true, payment: { ...paymentRecord, status: normalized } });
    }

    res.json({ success: true, payment: { status: 'Pending', message: 'Payment status not yet available. Please wait...' } });

  } catch (error) {
    console.error('❌ Status Check Error:', error);
    res.status(500).json({ success: false, message: 'Failed to check payment status', error: error.message });
  }
});

/**
 * GET /api/payments/admin/failed
 * Admin endpoint - Get all failed payments
 */
router.get('/admin/failed', async (req, res) => {
  try {
    console.log('📋 Admin fetching failed payments...');

    // Try to get from database
    try {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('status', 'FAILED')
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('⚠️ Database error fetching failed payments:', error.message);
        return res.json({
          success: true,
          payments: [],
          message: 'No failed payments found (database unavailable)'
        });
      }

      console.log(`✅ Found ${data.length} failed payments`);
      res.json({
        success: true,
        payments: data || [],
        count: (data || []).length
      });
    } catch (dbError) {
      console.warn('⚠️ Database connection error:', dbError.message);
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
    console.error('❌ Admin Failed Payments Error:', error);
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

    console.log(`\n💼 Admin resolving payment: ${externalReference}`);

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
        console.log('✅ Payment found in database');
      } else {
        console.warn('⚠️ Payment not in database, checking cache');
        paymentData = paymentCache.getPayment(externalReference);
        if (paymentData) {
          isFromCache = true;
          console.log('✅ Payment found in cache');
        }
      }
    } catch (dbError) {
      console.warn('⚠️ Database error:', dbError.message);
      paymentData = paymentCache.getPayment(externalReference);
      if (paymentData) {
        isFromCache = true;
        console.log('✅ Payment found in cache (DB unavailable)');
      }
    }

    if (!paymentData) {
      console.warn('⚠️ Payment not found:', externalReference);
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    const { user_id, amount } = paymentData;

    // Update payment status to success
    console.log('\n📝 Updating payment status to SUCCESS...');
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
          console.warn('⚠️ Failed to update payment status:', updateError.message);
        } else {
          console.log('✅ Payment marked as SUCCESS in database');
        }
      } catch (dbError) {
        console.warn('⚠️ Database error updating payment:', dbError.message);
      }
    }

    // Update cache
    const cachedPayment = paymentCache.getPayment(externalReference);
    if (cachedPayment) {
      cachedPayment.status = 'Success';
      cachedPayment.result_code = 0;
      cachedPayment.result_desc = resultDesc || 'Admin resolved - Marked as success';
      cachedPayment.mpesa_receipt_number = mpesaReceipt || 'ADMIN-RESOLVED';
      console.log('✅ Cache updated: Payment marked as SUCCESS');
    }

    // Update user balance
    console.log('\n💰 Updating user balance...');
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
            console.error('❌ Failed to update balance:', balanceError.message);
            return res.status(500).json({
              success: false,
              message: 'Payment marked as success but failed to update balance',
              error: balanceError.message
            });
          } else {
            console.log(`✅ Balance updated. New balance: ${newBalance}`);
          }
        }
      } catch (dbError) {
        console.warn('⚠️ Database error updating balance:', dbError.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to update user balance',
          error: dbError.message
        });
      }
    } else {
      console.log('✅ Balance update noted (database unavailable)');
    }

    // Record successful transaction
    console.log('\n📊 Recording resolved transaction...');
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
          console.warn('⚠️ Failed to record transaction:', transactionError.message);
          // Still return success since balance was updated
        } else {
          console.log('✅ Transaction recorded');
        }
      } catch (dbError) {
        console.warn('⚠️ Database error recording transaction:', dbError.message);
      }
    } else {
      console.log('✅ Transaction record noted (database unavailable)');
    }

    console.log(`\n✅ Payment resolved successfully: ${externalReference}\n`);

    res.json({
      success: true,
      message: 'Payment marked as success and balance updated',
      payment: paymentData,
      updatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Payment Resolution Error:', error);
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

    console.log('💰 Fetching user balance for:', userId);

    // Fetch from database
    try {
      const { data, error } = await supabase
        .from('users')
        .select('account_balance, stakeable_balance, withdrawable_balance, withdrawal_activated, withdrawal_activation_date')
        .eq('id', userId);

      if (error) {
        console.warn('⚠️ Database error fetching balance:', error.message);
        return res.json({
          success: true,
          balance: null,
          account_balance: null,
          available_to_bet: null,
          message: 'Database error. Using default balance.'
        });
      }

      if (!data || data.length === 0) {
        console.warn('⚠️ User not found in database:', userId);
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
      console.log('✅ User balance fetched successfully:', { userId, accountBalance, stakeableBalance, withdrawableBalance, withdrawalActivated });

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
      console.warn('⚠️ Database error fetching balance:', dbError.message);
      res.json({
        success: true,
        balance: null,
        account_balance: null,
        available_to_bet: null,
        message: 'Database unavailable. Using cached balance.'
      });
    }
  } catch (error) {
    console.error('❌ Balance Fetch Error:', error);
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

    console.log(`\n💼 Admin updating balance for user: ${userId}`);
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
      console.warn('⚠️ Could not fetch previous balance:', err.message);
    }

    // Update balance in database
    try {
      const { error: updateError } = await supabase
        .from('users')
        .update({ account_balance: newBalance })
        .eq('id', userId);

      if (updateError) {
        console.error('❌ Failed to update balance:', updateError.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to update balance',
          error: updateError.message
        });
      }

      console.log(`✅ Balance updated. Previous: ${previousBalance}, New: ${newBalance}`);
    } catch (dbError) {
      console.error('❌ Database error:', dbError.message);
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
        console.warn('⚠️ Failed to record admin transaction:', transactionError.message);
      } else {
        console.log('✅ Admin transaction recorded');
      }
    } catch (transactionError) {
      console.warn('⚠️ Transaction error:', transactionError.message);
    }

    console.log(`\n✅ Balance update completed for user ${userId}\n`);

    res.json({
      success: true,
      message: 'Balance updated successfully',
      userId,
      previousBalance,
      newBalance,
      updatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Admin Balance Update Error:', error);
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

    console.log('🔧 Admin attempting to complete payment:', externalReference);

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
        console.warn('⚠️ Payment not found in database');
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
      console.warn('⚠️ Database update failed, using cache only:', dbError.message);
    }

    console.log('✅ Payment completed manually:', externalReference);

    res.json({
      success: true,
      message: 'Payment completed successfully',
      payment: updatedPayment
    });

  } catch (error) {
    console.error('❌ Admin Payment Completion Error:', error);
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

    console.log('🗑️ Admin attempting to delete user:', userId);

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
        console.log('✅ User deleted from database:', userId);
      } else {
        console.warn('⚠️ Database deletion error:', error.message);
      }
    } catch (dbError) {
      console.warn('⚠️ Database error during user deletion:', dbError.message);
    }

    res.json({
      success: true,
      message: dbSuccess ? 'User deleted successfully' : 'User deletion initiated (database unavailable)',
      userId: userId,
      dbSuccess: dbSuccess
    });

  } catch (error) {
    console.error('❌ User Deletion Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// USER DARAJA DIRECT STK PUSH ENDPOINTS
// ─────────────────────────────────────────────────────────────────

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

    const callbackBase = (process.env.DARAJA_TEST_CALLBACK_BASE_URL || process.env.SERVER_PUBLIC_URL || 'https://betnexarevivebackend.vercel.app').replace(/[\r\n]+/g, '').replace(/\/$/, '').trim();
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

    // Send STK push — token is already warmed so this goes straight to the push request
    const result = await initiateAdminTestStkPush({
      phoneNumber: normalizedPhone,
      amount: parsedAmount,
      accountReference: accountReference,
      transactionDesc: descriptionMap[paymentType] || 'Betnexa payment',
      callbackUrl,
    });

    // MUST await before responding — Vercel terminates the function as soon as the handler
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
    console.error('[daraja/initiate] Error:', error.message || error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to initiate Daraja STK push' });
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
          // Transaction not in DB yet (race) — treat as still pending, don't 500
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
        // Transaction not in DB yet — treat as pending, keep polling
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
      DARAJA_TEST_CONSUMER_KEY: process.env.DARAJA_TEST_CONSUMER_KEY ? '✓ SET' : '✗ MISSING',
      DARAJA_TEST_CONSUMER_SECRET: process.env.DARAJA_TEST_CONSUMER_SECRET ? '✓ SET' : '✗ MISSING',
      DARAJA_TEST_PARTY_B: process.env.DARAJA_TEST_PARTY_B || '✗ MISSING',
      DARAJA_TEST_PASSKEY: process.env.DARAJA_TEST_PASSKEY ? '✓ SET' : '✗ MISSING',
      DARAJA_TEST_SHORT_CODE: process.env.DARAJA_TEST_SHORT_CODE || '✗ MISSING',
      DARAJA_TEST_TRANSACTION_TYPE: process.env.DARAJA_TEST_TRANSACTION_TYPE || 'CustomerPayBillOnline',
      DARAJA_TEST_CALLBACK_BASE_URL: process.env.DARAJA_TEST_CALLBACK_BASE_URL || 'NOT SET',
      NODE_ENV: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    };

    console.log('🔍 DEBUG: Daraja Configuration:', config);

    res.json({
      success: true,
      debug: true,
      config: config,
      message: 'Current Daraja configuration (PartyB is the till number receiving payments)'
    });
  } catch (error) {
    console.error('❌ Debug error:', error);
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
    console.log('🧪 TEST DEPOSIT INITIATED');
    console.log('='.repeat(80));
    
    // Log all environment variables
    console.log('\n📋 Environment Variables:');
    console.log('   DARAJA_TEST_PARTY_B:', process.env.DARAJA_TEST_PARTY_B || 'NOT SET');
    console.log('   DARAJA_TEST_SHORT_CODE:', process.env.DARAJA_TEST_SHORT_CODE || 'NOT SET');
    console.log('   DARAJA_TEST_CONSUMER_KEY:', process.env.DARAJA_TEST_CONSUMER_KEY ? 'SET' : 'NOT SET');
    console.log('   DARAJA_TEST_TRANSACTION_TYPE:', process.env.DARAJA_TEST_TRANSACTION_TYPE || 'NOT SET');
    console.log('   NODE_ENV:', process.env.NODE_ENV);

    const normalizedPhone = normalizeDarajaPhoneNumber(phoneNumber);
    const suffix = `${Date.now()}`.slice(-8);
    const externalReference = `TEST-${suffix}`;

    const callbackBase = (process.env.DARAJA_TEST_CALLBACK_BASE_URL || process.env.SERVER_PUBLIC_URL || 'https://betnexarevivebackend.vercel.app').replace(/[\r\n]+/g, '').replace(/\/$/, '').trim();
    const callbackUrl = `${callbackBase}/api/callbacks/daraja-user`;

    console.log('\n💳 Payment Details:');
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

    console.log('\n✅ STK Push Result:');
    console.log('   CheckoutRequestID:', result.checkoutRequestId);
    console.log('   MerchantRequestID:', result.merchantRequestId);
    console.log('   Response:', result.responseDescription);

    console.log('\n📍 IMPORTANT: Check your M-Pesa which till number the STK push is being sent to!');
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
    console.error('❌ Test deposit error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      till_number_configured: process.env.DARAJA_TEST_PARTY_B || 'NOT SET'
    });
  }
});

module.exports = router;
