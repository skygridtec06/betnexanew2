/**
 * Callback Routes
 * Handles Daraja payment callbacks
 */

const express = require('express');
const router = express.Router();
const supabase = require('../services/database.js');
const paymentCache = require('../services/paymentCache.js');
const { ensureAdminDarajaTestFunding } = require('../services/adminDarajaTestFundingService');
const { ensureUserDarajaFunding, persistUserDarajaTerminalStatus } = require('../services/userDarajaFundingService');
const { sendDepositSms, sendAdminDepositNotification } = require('../services/smsService.js');
const { findUserByBetnexaId } = require('../services/betnexaIdService.js');

// PayHero callback endpoint has been removed - all deposits now use Daraja (Safaricom direct)

router.post('/daraja-admin-test', async (req, res) => {
  try {
    const stkCallback = req.body?.Body?.stkCallback || req.body?.stkCallback || req.body;
    const checkoutRequestId = stkCallback?.CheckoutRequestID;
    const merchantRequestId = stkCallback?.MerchantRequestID;
    const resultCode = stkCallback?.ResultCode;
    const resultDesc = stkCallback?.ResultDesc;
    const metadataItems = Array.isArray(stkCallback?.CallbackMetadata?.Item)
      ? stkCallback.CallbackMetadata.Item
      : [];

    const metadata = metadataItems.reduce((acc, item) => {
      if (item?.Name) {
        acc[item.Name] = item.Value;
      }
      return acc;
    }, {});

    console.log('\n🔔 Daraja Admin Test Callback Received:', JSON.stringify(req.body, null, 2));

    // Respond to Safaricom immediately — prevents timeout and retry loops
    res.json({ ResponseCode: '00000000', ResponseDesc: 'Accepted' });

    if (checkoutRequestId) {
      const isCancelled = `${resultCode}` === '1032' || /cancel|insufficient\s*funds|balance\s+is\s+insufficient/i.test(`${resultDesc || ''}`);
      const normalizedStatus = `${resultCode}` === '0'
        ? 'Success'
        : (isCancelled ? 'Cancelled' : 'Failed');

      paymentCache.storeCallback(checkoutRequestId, {
        status: normalizedStatus,
        resultCode,
        resultDesc,
        merchantRequestId,
        mpesaReceipt: metadata.MpesaReceiptNumber || null,
        amount: metadata.Amount || null,
        phoneNumber: metadata.PhoneNumber || null,
        transactionDate: metadata.TransactionDate || null,
      });

      if (normalizedStatus === 'Success') {
        const fundingResult = await ensureAdminDarajaTestFunding({
          checkoutRequestId,
          mpesaReceipt: metadata.MpesaReceiptNumber || null,
          resultCode,
          resultDesc,
          amount: metadata.Amount || null,
          phoneNumber: metadata.PhoneNumber || null,
        });

        if (!fundingResult.success) {
          console.error('Admin Daraja test funding error:', fundingResult.error || 'Unknown funding error');
        }
      }
    }
  } catch (error) {
    console.error('Daraja admin test callback error:', error.message || error);
    if (!res.headersSent) {
      res.status(200).json({ ResponseCode: '00000000', ResponseDesc: 'Accepted with error' });
    }
  }
});

/**
 * POST /api/callbacks/daraja-user
 * Receive Daraja callbacks for user deposits, activation fees, and priority fees.
 */
router.post('/daraja-user', async (req, res) => {
  try {
    const stkCallback = req.body?.Body?.stkCallback || req.body?.stkCallback || req.body;
    const checkoutRequestId = stkCallback?.CheckoutRequestID;
    const merchantRequestId = stkCallback?.MerchantRequestID;
    const resultCode = stkCallback?.ResultCode;
    const resultDesc = stkCallback?.ResultDesc;
    const metadataItems = Array.isArray(stkCallback?.CallbackMetadata?.Item)
      ? stkCallback.CallbackMetadata.Item
      : [];

    const metadata = metadataItems.reduce((acc, item) => {
      if (item?.Name) acc[item.Name] = item.Value;
      return acc;
    }, {});

    console.log('\n🔔 Daraja User Callback Received:', JSON.stringify(req.body, null, 2));

    // Respond to Safaricom immediately — prevents their timeout (8s) and retry loops
    // Vercel keeps the async handler alive until the Promise resolves, so processing continues.
    res.json({ ResponseCode: '00000000', ResponseDesc: 'Accepted' });

    if (checkoutRequestId) {
      const isCancelled = `${resultCode}` === '1032'
        || /cancel|insufficient\s*funds|balance\s+is\s+insufficient/i.test(`${resultDesc || ''}`);
      const normalizedStatus = `${resultCode}` === '0'
        ? 'Success'
        : (isCancelled ? 'Cancelled' : 'Failed');

      paymentCache.storeCallback(checkoutRequestId, {
        status: normalizedStatus,
        resultCode,
        resultDesc,
        merchantRequestId,
        mpesaReceipt: metadata.MpesaReceiptNumber || null,
        amount: metadata.Amount || null,
        phoneNumber: metadata.PhoneNumber || null,
        transactionDate: metadata.TransactionDate || null,
      });

      if (normalizedStatus === 'Success') {
        const fundingResult = await ensureUserDarajaFunding({
          checkoutRequestId,
          mpesaReceipt: metadata.MpesaReceiptNumber || null,
          resultCode,
          resultDesc,
          amount: metadata.Amount || null,
          phoneNumber: metadata.PhoneNumber || null,
        });

        if (!fundingResult.success) {
          console.error('User Daraja funding error in callback:', fundingResult.error || 'Unknown error');
        } else {
          console.log(`✅ User Daraja callback: Credited KSH ${fundingResult.creditedAmount} to user ${fundingResult.userId}. New balance: ${fundingResult.newBalance}`);
        }
      } else {
        const terminalStatus = normalizedStatus === 'Cancelled' ? 'cancelled' : 'failed';
        const terminalResult = await persistUserDarajaTerminalStatus({
          checkoutRequestId,
          status: terminalStatus,
          resultCode,
          resultDesc,
          mpesaReceipt: metadata.MpesaReceiptNumber || null,
          amount: metadata.Amount || null,
          phoneNumber: metadata.PhoneNumber || null,
        });

        if (!terminalResult.success) {
          console.error('User Daraja terminal status persist error:', terminalResult.error || 'Unknown error');
        } else {
          console.log(`✅ User Daraja callback: Marked transaction as ${terminalStatus} for checkout ${checkoutRequestId}`);
        }
      }
    }
  } catch (error) {
    console.error('Daraja user callback error:', error.message || error);
    if (!res.headersSent) {
      res.status(200).json({ ResponseCode: '00000000', ResponseDesc: 'Accepted with error' });
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// C2B (CUSTOMER TO BUSINESS) OFFLINE PAYMENT CALLBACKS
// ─────────────────────────────────────────────────────────────────

/**
 * POST /api/callbacks/c2b-validation
 * Safaricom sends this BEFORE completing the transaction.
 * We validate the account number (BETNEXA ID) exists.
 */
router.post('/c2b-validation', async (req, res) => {
  try {
    console.log('\n🔔 [C2B VALIDATION] Request received:', JSON.stringify(req.body, null, 2));

    const { BillRefNumber, TransAmount, MSISDN, TransID } = req.body;
    const accountNumber = (BillRefNumber || '').trim().toUpperCase();
    const amount = parseFloat(TransAmount) || 0;

    if (!accountNumber) {
      console.log('❌ [C2B VALIDATION] No account number provided');
      return res.json({ ResultCode: 'C2B00012', ResultDesc: 'Invalid Account Number' });
    }

    // Look up user by BETNEXA ID
    const user = await findUserByBetnexaId(accountNumber);

    if (!user) {
      console.log(`❌ [C2B VALIDATION] No user found for BETNEXA ID: ${accountNumber}`);
      return res.json({ ResultCode: 'C2B00012', ResultDesc: 'Invalid Account Number' });
    }

    if (amount < 1) {
      console.log(`❌ [C2B VALIDATION] Invalid amount: ${amount}`);
      return res.json({ ResultCode: 'C2B00013', ResultDesc: 'Invalid Amount' });
    }

    console.log(`✅ [C2B VALIDATION] Valid - User: ${user.username}, BETNEXA ID: ${accountNumber}, Amount: ${amount}, Phone: ${MSISDN}, TransID: ${TransID}`);

    // Accept the transaction
    return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('❌ [C2B VALIDATION] Error:', error.message);
    // Accept on error to avoid blocking payments
    return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
  }
});

/**
 * POST /api/callbacks/c2b-confirmation
 * Safaricom sends this AFTER the transaction is completed.
 * We credit the user's account and record the transaction.
 */
router.post('/c2b-confirmation', async (req, res) => {
  try {
    console.log('\n🔔 [C2B CONFIRMATION] Payment received:', JSON.stringify(req.body, null, 2));

    const {
      TransactionType,
      TransID,
      TransTime,
      TransAmount,
      BusinessShortCode,
      BillRefNumber,
      InvoiceNumber,
      OrgAccountBalance,
      ThirdPartyTransID,
      MSISDN,
      FirstName,
      MiddleName,
      LastName,
    } = req.body;

    const accountNumber = (BillRefNumber || '').trim().toUpperCase();
    const amount = parseFloat(TransAmount) || 0;
    const phoneNumber = MSISDN || '';
    const mpesaReceipt = TransID || '';
    const payerName = [FirstName, MiddleName, LastName].filter(Boolean).join(' ');

    console.log(`📋 [C2B] Account: ${accountNumber}, Amount: KSH ${amount}, Phone: ${phoneNumber}, Receipt: ${mpesaReceipt}, Payer: ${payerName}`);

    if (!accountNumber || amount <= 0) {
      console.log('❌ [C2B CONFIRMATION] Invalid data - skipping');
      return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
    }

    const externalRef = `C2B-${mpesaReceipt}`;

    // Idempotency check - don't process same TransID or duplicate external reference twice
    const { data: existingReceiptTx } = await supabase
      .from('transactions')
      .select('id, status')
      .eq('mpesa_receipt', mpesaReceipt)
      .maybeSingle();

    const { data: existingExtTx } = await supabase
      .from('transactions')
      .select('id, status')
      .eq('external_reference', externalRef)
      .maybeSingle();

    if ((existingReceiptTx && existingReceiptTx.status === 'completed') ||
        (existingExtTx && existingExtTx.status === 'completed')) {
      console.log(`⚠️ [C2B] Transaction ${mpesaReceipt} already processed - idempotency guard`);
      return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
    }

    // Find user by BETNEXA ID
    const user = await findUserByBetnexaId(accountNumber);

    if (!user) {
      console.error(`❌ [C2B CONFIRMATION] No user found for BETNEXA ID: ${accountNumber}. Cannot credit.`);
      // Still log the unmatched payment for admin review
      try {
        await supabase.from('transactions').insert({
          transaction_id: `C2B-UNMATCHED-${mpesaReceipt}`,
          user_id: null,
          type: 'deposit',
          amount,
          status: 'failed',
          method: 'M-Pesa C2B Paybill',
          phone_number: phoneNumber,
          mpesa_receipt: mpesaReceipt,
          description: `UNMATCHED C2B deposit - Account: ${accountNumber}, Payer: ${payerName}`,
          admin_notes: `No user found for BETNEXA ID "${accountNumber}". Manual resolution needed.`,
          created_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error('❌ Failed to log unmatched C2B transaction:', logErr.message);
      }
      return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
    }

    console.log(`✅ [C2B] User found: ${user.username} (ID: ${user.id})`);

    // Credit the user's balance
    const prevBalance = parseFloat(user.account_balance) || 0;
    const prevStakeable = parseFloat(user.stakeable_balance) || 0;
    const newBalance = prevBalance + amount;
    const newStakeable = prevStakeable + amount;

    const { error: updateError } = await supabase
      .from('users')
      .update({
        account_balance: newBalance,
        stakeable_balance: newStakeable,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      console.error(`❌ [C2B] Failed to update balance for user ${user.id}:`, updateError.message);
      return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
    }

    console.log(`✅ [C2B] Balance updated: KSH ${prevBalance} → KSH ${newBalance} (stakeable: ${prevStakeable} → ${newStakeable})`);

    // Record or update the transaction
    try {
      const { data: existingTx } = await supabase
        .from('transactions')
        .select('id, status')
        .or(`mpesa_receipt.eq.${mpesaReceipt},external_reference.eq.${externalRef}`)
        .maybeSingle();

      if (existingTx) {
        if (existingTx.status === 'completed') {
          console.log(`⚠️ [C2B] Existing transaction already completed: ${externalRef}`);
        } else {
          const { error: updateError } = await supabase
            .from('transactions')
            .update({
              status: 'completed',
              balance_before: prevBalance,
              balance_after: newBalance,
              mpesa_receipt: mpesaReceipt,
              description: `Offline M-Pesa deposit via Paybill (Account: ${accountNumber}, Payer: ${payerName})`,
              updated_at: new Date().toISOString(),
              completed_at: new Date().toISOString()
            })
            .eq('id', existingTx.id);

          if (updateError) {
            console.error('⚠️ [C2B] Failed to update existing transaction record:', updateError.message);
          } else {
            console.log(`✅ [C2B] Existing transaction updated to completed: ${externalRef}`);
          }
        }
      } else {
        await supabase.from('transactions').insert({
          transaction_id: externalRef,
          user_id: user.id,
          type: 'deposit',
          amount,
          balance_before: prevBalance,
          balance_after: newBalance,
          status: 'completed',
          method: 'M-Pesa C2B Paybill',
          phone_number: phoneNumber,
          mpesa_receipt: mpesaReceipt,
          external_reference: externalRef,
          description: `Offline M-Pesa deposit via Paybill (Account: ${accountNumber}, Payer: ${payerName})`,
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
        console.log(`✅ [C2B] Transaction record created: ${externalRef}`);
      }
    } catch (txErr) {
      console.error('⚠️ [C2B] Failed to create/update transaction record:', txErr.message);
    }

    // Create or update deposit record for consistency
    try {
      const { data: existingDeposit } = await supabase
        .from('deposits')
        .select('id, status')
        .eq('external_reference', externalRef)
        .maybeSingle();

      if (existingDeposit) {
        if (existingDeposit.status === 'completed') {
          console.log(`⚠️ [C2B] Existing deposit record already completed: ${externalRef}`);
        } else {
          const { error: updateDepositError } = await supabase
            .from('deposits')
            .update({
              status: 'completed',
              method: 'M-Pesa C2B Paybill',
              description: `Offline deposit - Account: ${accountNumber}, Payer: ${payerName}`,
              mpesa_receipt: mpesaReceipt,
              updated_at: new Date().toISOString()
            })
            .eq('id', existingDeposit.id);

          if (updateDepositError) {
            console.warn('⚠️ [C2B] Failed to update existing deposit record:', updateDepositError.message);
          } else {
            console.log(`✅ [C2B] Existing deposit record updated to completed: ${externalRef}`);
          }
        }
      } else {
        await supabase.from('deposits').insert({
          user_id: user.id,
          amount,
          phone_number: phoneNumber,
          external_reference: externalRef,
          status: 'completed',
          method: 'M-Pesa C2B Paybill',
          description: `Offline deposit - Account: ${accountNumber}, Payer: ${payerName}`,
          mpesa_receipt: mpesaReceipt,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        console.log(`✅ [C2B] Deposit record created`);
      }
    } catch (depErr) {
      console.warn('⚠️ [C2B] Failed to create/update deposit record:', depErr.message);
    }

    // Send SMS notification to user (fire-and-forget)
    try {
      sendDepositSms(user.phone_number, amount, newBalance).catch(() => {});
    } catch (_) {}

    // Notify admin with today's total revenue (fire-and-forget)
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const { data: revenueData, error: revErr } = await supabase
        .from('deposits')
        .select('amount')
        .eq('status', 'completed')
        .gte('created_at', todayStart.toISOString())
        .lt('created_at', todayEnd.toISOString());

      const totalRevenue = !revErr && revenueData
        ? revenueData.reduce((sum, dep) => sum + parseFloat(dep.amount || 0), 0)
        : 0;

      sendAdminDepositNotification(
        user.phone_number,
        user.username || 'Unknown',
        amount,
        'C2B Paybill',
        totalRevenue,
        mpesaReceipt,
        user.created_at,
      ).catch(() => {});
    } catch (_) {}

    console.log(`✅ [C2B CONFIRMATION] Complete - ${user.username} credited KSH ${amount}. New balance: KSH ${newBalance}`);
    return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('❌ [C2B CONFIRMATION] Error:', error.message);
    // Always return success to Safaricom to acknowledge
    return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
  }
});

module.exports = router;
