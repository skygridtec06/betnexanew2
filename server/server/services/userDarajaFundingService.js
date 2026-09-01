/**
 * User Daraja Funding Service
 * Handles creating pending DB records and idempotent balance credit
 * for user deposits, activation fees, and priority fees via Daraja (M-Pesa direct).
 */
const supabase = require('./database');
const paymentCache = require('./paymentCache');
const { sendDepositSms, sendActivationSms, sendAdminDepositNotification } = require('./smsService');

function nowIso() {
  return new Date().toISOString();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveDarajaPaymentType({ checkoutRequestId, externalReference, cachedPaymentType }) {
  if (cachedPaymentType) return cachedPaymentType;

  const queries = [];
  if (checkoutRequestId) {
    queries.push({ field: 'checkout_request_id', value: checkoutRequestId });
  }
  if (externalReference) {
    queries.push({ field: 'external_reference', value: externalReference });
  }

  for (const query of queries) {
    try {
      const { data: fee, error: feeError } = await supabase
        .from('activation_fees')
        .select('fee_type')
        .eq(query.field, query.value)
        .maybeSingle();
      if (!feeError && fee?.fee_type) {
        return fee.fee_type;
      }
    } catch (e) {
      console.warn('[resolveDarajaPaymentType] activation_fees lookup error:', e.message);
    }

    try {
      const { data: deposit, error: depositError } = await supabase
        .from('deposits')
        .select('id')
        .eq(query.field, query.value)
        .maybeSingle();
      if (!depositError && deposit) {
        return 'deposit';
      }
    } catch (e) {
      console.warn('[resolveDarajaPaymentType] deposits lookup error:', e.message);
    }
  }

  return 'deposit';
}

/**
 * Register a user Daraja STK attempt: create pending transaction + fund_transfers records.
 * paymentType: 'deposit' | 'activation' | 'priority'
 */
async function registerUserDarajaAttempt({
  userId,
  phoneNumber,
  amount,
  externalReference,
  checkoutRequestId,
  merchantRequestId,
  paymentType = 'deposit',
  relatedWithdrawalId,
}) {
  if (!supabase || !userId || !checkoutRequestId) {
    return { success: false, error: 'Missing required parameters (userId, checkoutRequestId)' };
  }

  if (!UUID_REGEX.test(userId)) {
    return { success: false, error: `Invalid userId: ${userId}` };
  }

  const timestamp = nowIso();
  const depositAmount = parseFloat(amount);

  // Check for existing transaction by checkoutRequestId (idempotency)
  const { data: existing } = await supabase
    .from('transactions')
    .select('id, user_id, amount, status, external_reference, checkout_request_id')
    .eq('checkout_request_id', checkoutRequestId)
    .maybeSingle();

  if (existing) {
    // Re-store in cache in case it was lost
    paymentCache.storePayment(externalReference, checkoutRequestId, {
      type: `USER_DARAJA_${paymentType.toUpperCase()}`,
      amount: depositAmount,
      phone_number: phoneNumber,
      user_id: userId,
      payment_type: paymentType,
      external_reference: externalReference,
      related_withdrawal_id: relatedWithdrawalId,
      merchantRequestId,
    });
    return { success: true, transaction: existing };
  }

  // Fetch current balance for balance_before / balance_after
  const { data: userRow } = await supabase
    .from('users')
    .select('account_balance')
    .eq('id', userId)
    .maybeSingle();

  const currentBalance = parseFloat(userRow?.account_balance) || 0;

  const methodLabel =
    paymentType === 'activation' ? 'Withdrawal Activation (Daraja)'
    : paymentType === 'priority'   ? 'Priority Fee (Daraja)'
    : 'M-Pesa (Daraja)';

  const description =
    paymentType === 'activation' ? 'Withdrawal activation fee via Daraja - pending'
    : paymentType === 'priority'   ? 'Priority withdrawal fee via Daraja - pending'
    : 'M-Pesa deposit via Daraja - pending';

  const insertPayload = {
    transaction_id: `DUSER-${Date.now()}-${externalReference}`,
    user_id: userId,
    type: 'deposit',
    amount: depositAmount,
    status: 'pending',
    method: methodLabel,
    phone_number: phoneNumber,
    external_reference: externalReference,
    checkout_request_id: checkoutRequestId,
    description,
    balance_before: currentBalance,
    balance_after: currentBalance + depositAmount,
    created_at: timestamp,
    updated_at: timestamp,
  };

  let { data: inserted, error: insertError } = await supabase
    .from('transactions')
    .insert(insertPayload)
    .select('id, user_id, amount, status, external_reference, checkout_request_id')
    .single();

  if (insertError) {
    console.warn('[registerUserDarajaAttempt] Insert failed, retrying without balance fields:', insertError.message);
    const minimal = {
      transaction_id: insertPayload.transaction_id,
      user_id: userId,
      type: 'deposit',
      amount: depositAmount,
      status: 'pending',
      method: methodLabel,
      phone_number: phoneNumber,
      external_reference: externalReference,
      checkout_request_id: checkoutRequestId,
      description,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const retry = await supabase
      .from('transactions')
      .insert(minimal)
      .select('id, user_id, amount, status, external_reference, checkout_request_id')
      .single();
    if (retry.error) {
      return { success: false, error: retry.error.message || 'Failed to create transaction record' };
    }
    inserted = retry.data;
  }

  // fund_transfers record (fire & forget, non-blocking)
  supabase.from('fund_transfers').insert({
    user_id: userId,
    transaction_id: inserted.id,
    transfer_type: 'deposit',
    amount: depositAmount,
    phone_number: phoneNumber,
    status: 'pending',
    method: methodLabel,
    external_reference: externalReference,
    checkout_request_id: checkoutRequestId,
    is_stk_push_sent: true,
    stk_sent_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  }).then(({ error }) => {
    if (error) console.warn('[registerUserDarajaAttempt] fund_transfers warning:', error.message);
  });

  // Cache for status polling lookup
  paymentCache.storePayment(externalReference, checkoutRequestId, {
    type: `USER_DARAJA_${paymentType.toUpperCase()}`,
    amount: depositAmount,
    phone_number: phoneNumber,
    user_id: userId,
    payment_type: paymentType,
    external_reference: externalReference,
    related_withdrawal_id: relatedWithdrawalId,
    merchantRequestId,
  });

  return { success: true, transaction: inserted };
}

/**
 * Idempotently credit a user's balance for a successful Daraja payment.
 * Called from status polling endpoint AND from the Daraja callback.
 */
async function ensureUserDarajaFunding({
  checkoutRequestId,
  mpesaReceipt,
  resultCode,
  resultDesc,
  amount,
  phoneNumber,
}) {
  if (!supabase || !checkoutRequestId) {
    return { success: false, error: 'Missing supabase or checkoutRequestId' };
  }

  // Find transaction record
  let transaction = null;

  const { data: existing } = await supabase
    .from('transactions')
    .select('id, user_id, amount, status, external_reference, checkout_request_id, phone_number')
    .eq('checkout_request_id', checkoutRequestId)
    .maybeSingle();

  if (existing) {
    transaction = existing;
  } else {
    // Try cache fallback
    const cached = paymentCache.getPayment(checkoutRequestId);
    if (!cached || !cached.user_id) {
      return { success: false, error: 'User Daraja payment record not found in DB or cache' };
    }
    const reg = await registerUserDarajaAttempt({
      userId: cached.user_id,
      phoneNumber: cached.phone_number || phoneNumber,
      amount: cached.amount || amount,
      externalReference: cached.external_reference || cached.externalReference,
      checkoutRequestId,
      merchantRequestId: cached.merchantRequestId,
      paymentType: cached.payment_type || 'deposit',
    });
    if (!reg.success) return reg;
    transaction = reg.transaction;
  }

  if (!transaction) {
    return { success: false, error: 'Transaction could not be prepared' };
  }

  // Already done? Return safely
  if (transaction.status === 'completed') {
    const { data: u } = await supabase
      .from('users').select('account_balance').eq('id', transaction.user_id).maybeSingle();
    return {
      success: true,
      alreadyProcessed: true,
      creditedAmount: parseFloat(transaction.amount) || 0,
      newBalance: parseFloat(u?.account_balance) || 0,
      userId: transaction.user_id,
    };
  }

  const timestamp = nowIso();

  // Atomic claim: only succeeds once (pending → completed)
  const { data: updatedRows, error: completeError } = await supabase
    .from('transactions')
    .update({
      status: 'completed',
      mpesa_receipt: mpesaReceipt || null,
      description: 'M-Pesa Daraja payment credited',
      completed_at: timestamp,
      updated_at: timestamp,
    })
    .eq('id', transaction.id)
    .eq('status', 'pending')
    .select('id, user_id, amount, external_reference, phone_number');

  if (completeError) {
    return { success: false, error: completeError.message };
  }

  if (!updatedRows || updatedRows.length === 0) {
    // Already processed by another request
    const { data: u } = await supabase
      .from('users').select('account_balance').eq('id', transaction.user_id).maybeSingle();
    return {
      success: true,
      alreadyProcessed: true,
      creditedAmount: parseFloat(transaction.amount) || 0,
      newBalance: parseFloat(u?.account_balance) || 0,
      userId: transaction.user_id,
    };
  }

  const completedTx = updatedRows[0];

  const cached = paymentCache.getPayment(checkoutRequestId);
  const paymentType = await resolveDarajaPaymentType({
    checkoutRequestId,
    externalReference: completedTx.external_reference,
    cachedPaymentType: cached?.payment_type || cached?.paymentType
  });

  // Fetch user for balance update
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('account_balance, stakeable_balance, withdrawable_balance, username, phone_number')
    .eq('id', completedTx.user_id)
    .single();

  if (userError || !user) {
    // Roll back transaction status
    await supabase.from('transactions')
      .update({ status: 'pending', completed_at: null, updated_at: nowIso() })
      .eq('id', completedTx.id);
    return { success: false, error: userError?.message || 'User not found for balance credit' };
  }

  const previousBalance = parseFloat(user.account_balance) || 0;
  const prevStakeable = parseFloat(user.stakeable_balance) || 0;
  const creditedAmount = parseFloat(completedTx.amount) || 0;
  const newStakeable = prevStakeable + creditedAmount;
  const newBalance = newStakeable + (parseFloat(user.withdrawable_balance) || 0);

  const userUpdate = { account_balance: newBalance, stakeable_balance: newStakeable, updated_at: nowIso() };
  if (paymentType === 'activation') {
    userUpdate.withdrawal_activated = true;
    userUpdate.withdrawal_activation_date = timestamp;
  }

  const { error: balanceError } = await supabase
    .from('users')
    .update(userUpdate)
    .eq('id', completedTx.user_id);

  if (balanceError) {
    // Roll back transaction status
    await supabase.from('transactions')
      .update({ status: 'pending', completed_at: null, updated_at: nowIso() })
      .eq('id', completedTx.id);
    return { success: false, error: balanceError.message };
  }

  // Update fund_transfers (fire & forget)
  supabase.from('fund_transfers')
    .update({ status: 'completed', completed_at: timestamp, updated_at: timestamp, mpesa_receipt: mpesaReceipt || null })
    .eq('checkout_request_id', checkoutRequestId)
    .eq('status', 'pending')
    .then(({ error }) => { if (error) console.warn('[ensureUserDarajaFunding] fund_transfers update warning:', error.message); });

  // Log to balance_history (fire & forget)
  supabase.from('balance_history').insert({
    user_id: completedTx.user_id,
    transaction_id: completedTx.id,
    amount: creditedAmount,
    balance_before: previousBalance,
    balance_after: newBalance,
    type: paymentType,
    description: `Daraja ${paymentType} funded`,
    created_at: timestamp,
  }).then(({ error }) => { if (error) console.warn('[ensureUserDarajaFunding] balance_history warning:', error.message); });

  if (paymentType === 'deposit') {
    const smsPhone = completedTx.phone_number || user.phone_number || cached?.phone_number || phoneNumber;
    if (smsPhone) {
      sendDepositSms(smsPhone, creditedAmount, newBalance)
        .then((sent) => {
          if (!sent) {
            console.warn(`[ensureUserDarajaFunding] Deposit SMS was not sent for user ${completedTx.user_id}`);
          }
        })
        .catch((error) => {
          console.warn('[ensureUserDarajaFunding] Deposit SMS error:', error.message);
        });
    } else {
      console.warn(`[ensureUserDarajaFunding] No phone number available for deposit SMS (user ${completedTx.user_id})`);
    }
  }

  if (paymentType === 'activation') {
    const smsPhone = completedTx.phone_number || user.phone_number || cached?.phone_number || phoneNumber;
    if (smsPhone) {
      sendActivationSms(smsPhone, user.username || 'User', creditedAmount, newBalance)
        .then((sent) => {
          if (!sent) {
            console.warn(`[ensureUserDarajaFunding] Activation SMS was not sent for user ${completedTx.user_id}`);
          }
        })
        .catch((error) => {
          console.warn('[ensureUserDarajaFunding] Activation SMS error:', error.message);
        });
    } else {
      console.warn(`[ensureUserDarajaFunding] No phone number available for activation SMS (user ${completedTx.user_id})`);
    }
  }

  // Send admin notification for all payment types (fire-and-forget but with logging)
  try {
    const smsPhone = completedTx.phone_number || user.phone_number || cached?.phone_number || phoneNumber;
    if (smsPhone) {
      console.log(`[ensureUserDarajaFunding] 🔔 Preparing admin notification for ${paymentType}`);
      console.log(`[ensureUserDarajaFunding] SMS Phone: ${smsPhone}, User: ${user.username}`);
      
      // Calculate total revenue from all completed deposits and fees
      const { data: totalRevenueData, error: revenueError } = await supabase
        .from('transactions')
        .select('amount')
        .eq('status', 'completed')
        .in('type', ['deposit']);
      
      const totalRevenue = !revenueError && totalRevenueData 
        ? totalRevenueData.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0)
        : 0;
      
      console.log(`[ensureUserDarajaFunding] 💰 Total revenue calculated: KSH ${totalRevenue}`);
      console.log(`[ensureUserDarajaFunding] 📝 M-Pesa Receipt: ${mpesaReceipt || 'N/A'}`);
      
      const username = user.username || 'Unknown User';
      console.log(`[ensureUserDarajaFunding] 📞 CALLING sendAdminDepositNotification...`);
      
      const smsResult = await sendAdminDepositNotification(smsPhone, username, creditedAmount, paymentType, totalRevenue, mpesaReceipt);
      
      console.log(`[ensureUserDarajaFunding] 📨 SMS Result: ${smsResult}`);
      if (smsResult) {
        console.log(`✅ [ensureUserDarajaFunding] Admin notification SMS sent successfully for ${paymentType} (Code: ${mpesaReceipt || 'N/A'})`);
      } else {
        console.error(`❌ [ensureUserDarajaFunding] Admin notification SMS FAILED for ${paymentType}`);
      }
    } else {
      console.error(`[ensureUserDarajaFunding] ❌ No phone number available for admin notification (user ${completedTx.user_id})`);
    }
  } catch (adminNotifErr) {
    console.error('[ensureUserDarajaFunding] ❌ Admin notification EXCEPTION:', adminNotifErr.message);
    console.error('[ensureUserDarajaFunding] Stack:', adminNotifErr.stack);
  }

  console.log(`✅ [ensureUserDarajaFunding] User ${completedTx.user_id} credited KSH ${creditedAmount} (${paymentType}). New balance: ${newBalance}`);

  return {
    success: true,
    alreadyProcessed: false,
    creditedAmount,
    previousBalance,
    newBalance,
    activationEnabled: paymentType === 'activation',
    externalReference: completedTx.external_reference,
    userId: completedTx.user_id,
    mpesaReceipt,
  };
}

/**
 * Persist terminal (non-success) status for a user Daraja attempt.
 * Ensures failed/cancelled attempts are not left as pending.
 */
async function persistUserDarajaTerminalStatus({
  checkoutRequestId,
  status,
  resultCode,
  resultDesc,
  mpesaReceipt,
  amount,
  phoneNumber,
}) {
  if (!supabase || !checkoutRequestId) {
    return { success: false, error: 'Missing supabase or checkoutRequestId' };
  }

  const normalized = `${status || ''}`.toLowerCase();
  if (!['failed', 'cancelled'].includes(normalized)) {
    return { success: true, skipped: true, reason: 'non-terminal or unsupported status' };
  }
  // For transaction history consistency, store all non-completed terminal outcomes as failed.
  const finalStatus = 'failed';

  let transaction = null;
  let externalReference = null;

  const { data: existing } = await supabase
    .from('transactions')
    .select('id, user_id, amount, status, external_reference, checkout_request_id, phone_number')
    .eq('checkout_request_id', checkoutRequestId)
    .maybeSingle();

  if (existing) {
    transaction = existing;
    externalReference = existing.external_reference || null;
  } else {
    const cached = paymentCache.getPayment(checkoutRequestId);
    if (cached?.user_id) {
      externalReference = cached.external_reference || cached.externalReference || null;
      const reg = await registerUserDarajaAttempt({
        userId: cached.user_id,
        phoneNumber: cached.phone_number || phoneNumber,
        amount: cached.amount || amount,
        externalReference: cached.external_reference || cached.externalReference,
        checkoutRequestId,
        merchantRequestId: cached.merchantRequestId,
        paymentType: cached.payment_type || 'deposit',
        relatedWithdrawalId: cached.related_withdrawal_id,
      });
      if (!reg.success) return reg;
      transaction = reg.transaction;
      externalReference = transaction?.external_reference || externalReference;
    }
  }

  if (!transaction) {
    // Fallback: update deposits row directly by checkout_request_id if transaction record is missing.
    const timestamp = nowIso();
    const { data: depRows, error: depError } = await supabase
      .from('deposits')
      .update({
        status: 'failed',
        result_code: resultCode ?? null,
        result_desc: resultDesc || null,
        mpesa_receipt: mpesaReceipt || null,
        updated_at: timestamp,
      })
      .eq('checkout_request_id', checkoutRequestId)
      .select('id, external_reference');

    if (depError || !depRows || depRows.length === 0) {
      return { success: false, error: 'User Daraja payment record not found in DB or cache' };
    }

    return {
      success: true,
      status: 'failed',
      originalStatus: normalized,
      userId: null,
      transactionId: null,
      updatedFrom: 'deposits_fallback',
      externalReference: depRows[0]?.external_reference || null,
    };
  }

  if (transaction.status === 'completed') {
    return { success: true, skipped: true, reason: 'already completed' };
  }

  const timestamp = nowIso();
  const description = normalized === 'cancelled'
    ? `M-Pesa Daraja payment cancelled${resultDesc ? `: ${resultDesc}` : ''}`
    : `M-Pesa Daraja payment failed${resultDesc ? `: ${resultDesc}` : ''}`;

  const { error: txError } = await supabase
    .from('transactions')
    .update({
      status: finalStatus,
      mpesa_receipt: mpesaReceipt || null,
      description,
      result_code: resultCode ?? null,
      result_desc: resultDesc || null,
      completed_at: timestamp,
      updated_at: timestamp,
    })
    .eq('id', transaction.id)
    .in('status', ['pending', 'failed', 'cancelled']);

  if (txError) {
    return { success: false, error: txError.message };
  }

  supabase.from('fund_transfers')
    .update({
      status: finalStatus,
      mpesa_receipt: mpesaReceipt || null,
      result_code: resultCode ?? null,
      result_description: resultDesc || null,
      completed_at: timestamp,
      updated_at: timestamp,
    })
    .eq('checkout_request_id', checkoutRequestId)
    .in('status', ['pending', 'failed', 'cancelled'])
    .then(({ error }) => {
      if (error) console.warn('[persistUserDarajaTerminalStatus] fund_transfers warning:', error.message);
    });

  // Keep deposits table aligned because user history merges from deposits for missing references.
  if (externalReference) {
    supabase.from('deposits')
      .update({
        status: finalStatus,
        result_code: resultCode ?? null,
        result_desc: resultDesc || null,
        mpesa_receipt: mpesaReceipt || null,
        updated_at: timestamp,
      })
      .eq('external_reference', externalReference)
      .in('status', ['pending', 'failed', 'cancelled'])
      .then(({ error }) => {
        if (error) console.warn('[persistUserDarajaTerminalStatus] deposits warning:', error.message);
      });
  }

  return {
    success: true,
    status: finalStatus,
    originalStatus: normalized,
    userId: transaction.user_id,
    transactionId: transaction.id,
  };
}

module.exports = {
  registerUserDarajaAttempt,
  ensureUserDarajaFunding,
  persistUserDarajaTerminalStatus,
};
