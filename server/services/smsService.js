/**
 * SMS Service — TextSMS Kenya (sms.textsms.co.ke)
 *
 * Required environment variables:
 *   TEXTSMS_API_KEY    — API key from your TextSMS dashboard
 *   TEXTSMS_PARTNER_ID — Partner ID from your TextSMS dashboard
 *   TEXTSMS_SHORTCODE  — Sender name / shortcode (e.g. "BETNEXA")
 */

const https = require('https');

const TEXTSMS_ENDPOINT_HOSTNAME = 'sms.textsms.co.ke';
const TEXTSMS_ENDPOINT_PATH = '/api/services/sendsms/';

/**
 * Normalize a Kenyan phone number to 254XXXXXXXXX format.
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return '254' + digits.slice(1);
  if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return '254' + digits;
  // Return as-is if it doesn't match expected patterns (let API decide)
  return digits;
}

/**
 * Low-level HTTPS request to the TextSMS API.
 * Returns the parsed response object, or null on network error.
 */
function postToTextSmsApi(payload) {
  return new Promise((resolve) => {
    const bodyData = JSON.stringify(payload);
    const options = {
      hostname: TEXTSMS_ENDPOINT_HOSTNAME,
      path: TEXTSMS_ENDPOINT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyData),
      },
    };

    console.log(`[SMS_DEBUG] Sending request to ${TEXTSMS_ENDPOINT_HOSTNAME}${TEXTSMS_ENDPOINT_PATH}`);
    console.log(`[SMS_DEBUG] Payload: mobile=${payload.mobile}, message length=${payload.message.length}`);

    const req = https.request(options, (res) => {
      console.log(`[SMS_DEBUG] Response status code: ${res.statusCode}`);
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        console.log(`[SMS_DEBUG] Raw response: ${raw.substring(0, 500)}`);
        try {
          const parsed = JSON.parse(raw);
          console.log(`[SMS_DEBUG] Parsed response:`, JSON.stringify(parsed).substring(0, 300));
          resolve(parsed);
        } catch (e) {
          console.error(`[SMS_DEBUG] Failed to parse JSON response: ${e.message}`);
          resolve({ raw, parseError: true });
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ [SMS] HTTPS request error:', err.message);
      console.error('[SMS_DEBUG] Error details:', err);
      resolve(null);
    });

    req.setTimeout(10000, () => {
      console.error('[SMS_DEBUG] Request timeout after 10s');
      req.destroy();
      resolve(null);
    });

    req.write(bodyData);
    req.end();
  });
}

/**
 * Send an SMS message.
 * This is fire-and-forget — it never throws; it only logs on failure.
 *
 * @param {string} phone   Recipient phone (any common Kenyan format)
 * @param {string} message Text to send
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendSms(phone, message) {
  const apiKey = (process.env.TEXTSMS_API_KEY || '').trim();
  const partnerId = (process.env.TEXTSMS_PARTNER_ID || '').trim();
  const shortcode = (process.env.TEXTSMS_SHORTCODE || '').trim() || 'TextSMS';

  console.log(`\n[SMS] ========== SEND SMS ==========`);
  console.log(`[SMS] To: ${phone}`);
  console.log(`[SMS] Message length: ${message.length} chars`);
  console.log(`[SMS] API Key set: ${apiKey ? '✅ YES' : '❌ NO'}`);
  console.log(`[SMS] API Key length: ${apiKey.length}`);
  console.log(`[SMS] Partner ID set: ${partnerId ? '✅ YES' : '❌ NO'}`);
  console.log(`[SMS] Partner ID: ${partnerId}`);
  console.log(`[SMS] Shortcode: ${shortcode}`);

  if (!apiKey || !partnerId) {
    console.error('❌ [SMS] TEXTSMS_API_KEY or TEXTSMS_PARTNER_ID not set — cannot send SMS.');
    console.error(`[SMS] TEXTSMS_API_KEY env: ${process.env.TEXTSMS_API_KEY ? 'SET' : 'NOT SET'}`);
    console.error(`[SMS] TEXTSMS_PARTNER_ID env: ${process.env.TEXTSMS_PARTNER_ID ? 'SET' : 'NOT SET'}`);
    console.log(`[SMS] ================================\n`);
    return false;
  }

  const mobile = normalizePhone(phone);
  console.log(`[SMS] Phone normalization: ${phone} → ${mobile}`);

  if (!mobile || mobile.length < 10) {
    console.error(`❌ [SMS] Invalid phone number after normalization: ${phone} → ${mobile}`);
    console.log(`[SMS] ================================\n`);
    return false;
  }

  const payload = {
    apikey: apiKey,
    partnerID: String(partnerId),
    message,
    shortcode,
    mobile,
  };

  console.log(`[SMS] Payload ready - sending to TextSMS API...`);
  const result = await postToTextSmsApi(payload);

  if (!result) {
    console.error(`❌ [SMS] No response from TextSMS API for mobile: ${mobile}`);
    console.log(`[SMS] ================================\n`);
    return false;
  }

  console.log(`[SMS] Result received:`, typeof result, Object.keys(result || {}).slice(0, 5));

  // Check multiple possible response formats from TextSMS
  let success = false;
  let responseCode = null;

  // Format 1: { responses: [{ "response-code": 200 }] }
  if (result.responses && Array.isArray(result.responses) && result.responses.length > 0) {
    responseCode = result.responses[0]['response-code'] || result.responses[0].response_code || result.responses[0].status;
    console.log(`[SMS] Response format 1 detected. Code: ${responseCode}`);
    success = responseCode === 200 || responseCode === '200' || responseCode === 0 || responseCode === '0';
  }

  // Format 2: { "response-code": 200 }
  if (!success && (result['response-code'] || result.response_code || result.status)) {
    responseCode = result['response-code'] || result.response_code || result.status;
    console.log(`[SMS] Response format 2 detected. Code: ${responseCode}`);
    success = responseCode === 200 || responseCode === '200' || responseCode === 0 || responseCode === '0';
  }

  // Format 3: { status: "success" } or { success: true }
  if (!success && (result.status === 'success' || result.success === true)) {
    console.log(`[SMS] Response format 3 detected (success status).`);
    success = true;
  }

  // Format 4: String response "OK" or "Success"
  if (!success && typeof result.raw === 'string') {
    const rawUpper = (result.raw || '').toUpperCase();
    if (rawUpper.includes('SUCCESS') || rawUpper.includes('OK') || rawUpper.includes('SENT')) {
      console.log(`[SMS] Response format 4 detected (string success).`);
      success = true;
    }
  }

  if (success) {
    console.log(`✅ [SMS] Message sent successfully → ${mobile} (Code: ${responseCode})`);
    console.log(`[SMS] ================================\n`);
    return true;
  }

  console.error(`❌ [SMS] TextSMS failed for ${mobile}`);
  console.error(`[SMS] Full response:`, JSON.stringify(result).substring(0, 500));
  console.log(`[SMS] ================================\n`);
  return false;
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/**
 * Sent when a new user registers.
 */
async function sendWelcomeSms(phone, username) {
  const msg =
    `Welcome to BETNEXA, Cheers${username} ! ` +
    `You have successfully signed up. Deposit via M-Pesa to start betting. Good luck and welcome to the site of winners!`;
  return sendSms(phone, msg);
}

/**
 * Sent when a bet is placed successfully.
 */
async function sendBetPlacedSms(phone, betId, stake, potentialWin, newBalance) {
  const msg =
    `Confirmed Bet ${betId} successfully placed. ` +
    `Stake: KSH ${Number(stake).toFixed(0)}. ` +
    `Potential win: KSH ${Number(potentialWin).toFixed(0)}. ` +
    `Your BETNEXA balance: KSH ${Number(newBalance).toFixed(0)}.`;
  return sendSms(phone, msg);
}

/**
 * Sent when a bet is settled as Won.
 */
async function sendBetWonSms(phone, betId, amountWon) {
  const msg =
    `Congratulations! Your BETNEXA Bet ${betId} has WON! ` +
    `KSH ${Number(amountWon).toFixed(0)} added to your winnings balance. ` +
    `Withdraw anytime from your account.`;
  return sendSms(phone, msg);
}

/**
 * Sent after a deposit is confirmed (M-Pesa callback success).
 */
async function sendDepositSms(phone, amount, newBalance) {
  const msg =
    `Received a deposit of KSH ${Number(amount).toFixed(0)} on your Betnexa wallet. ` +
    `New balance: KSH ${Number(newBalance).toFixed(0)}. ` +
    `Place your bets now! on https://Betnexa.co.ke`;
  return sendSms(phone, msg);
}

/**
 * Sent when a withdrawal is initiated.
 */
async function sendWithdrawalSms(phone, amount, newBalance) {
  const balancePart = (newBalance !== undefined && newBalance !== null && !isNaN(Number(newBalance)))
    ? ` Your new account balance is KSH ${Number(newBalance).toFixed(0)}.`
    : '';
  const msg =
    `Hooray!!! Your Withdrawal of KSH ${Number(amount).toFixed(0)} at BETNEXA is being processed. ` +
    `Funds will arrive on your M-Pesa as soon as our team reviews it.${balancePart} Thanks for choosing Betnexa.`;
  return sendSms(phone, msg);
}

/**
 * Sent when a user's withdrawal account is activated.
 * If amount/newBalance are provided, include the activation payment credit details.
 */
async function sendActivationSms(phone, username, amount, newBalance) {
  const hasAmount = amount !== undefined && amount !== null && !isNaN(Number(amount));
  const hasBalance = newBalance !== undefined && newBalance !== null && !isNaN(Number(newBalance));
  const depositPart = hasAmount
    ? ` Activation payment of KSH ${Number(amount).toFixed(0)} received successfully.`
    : '';
  const balancePart = hasBalance
    ? ` New wallet balance: KSH ${Number(newBalance).toFixed(0)}.`
    : '';

  const msg =
    `Hey ${username}, your BETNEXA account has been activated successfully!` +
    `${depositPart}${balancePart} Withdrawal is now enabled on your account. ` +
    `You can now withdraw your winnings directly to M-Pesa. Login now: https://Betnexa.co.ke`;
  return sendSms(phone, msg);
}

/**
 * Sent to users who have been inactive for a while (inactivity reminder cron).
 */
async function sendInactivityReminderSms(phone, username) {
  const msg =
    `Hi ${username}, we miss you at BETNEXA! ` +
    `Log in now to check today's matches and amazing odds. Big wins await! https://Betnexa.co.ke`;
  return sendSms(phone, msg);
}

/**
 * Sent to a user when their account is banned.
 */
async function sendBanSms(phone, username) {
  const msg =
    `Hi ${username}, your BETNEXA account has been suspended due to a violation of our terms and conditions. ` +
    `If you believe this is a mistake, please login your account on https://Betnexa.co.ke and reach out to support.`;
  return sendSms(phone, msg);
}

/**
 * Sent to admin whenever a user deposits (deposit, activation fee, or priority fee).
 * Contains: amount, user phone, username, time, transaction type, M-Pesa code, and new total revenue.
 */
async function sendAdminDepositNotification(userPhone, username, amount, transactionType, newTotalRevenue, mpesaReceipt) {
  const adminPhone = process.env.ADMIN_SMS_PHONE || '0740176944';
  const formattedAmount = Number(amount).toFixed(0);
  const formattedRevenue = Number(newTotalRevenue).toFixed(0);
  const timestamp = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  
  console.log(`\n[ADMIN_SMS] ========== ADMIN DEPOSIT NOTIFICATION ==========`);
  console.log(`[ADMIN_SMS] Admin Phone: ${adminPhone}`);
  console.log(`[ADMIN_SMS] User Phone: ${userPhone}`);
  console.log(`[ADMIN_SMS] Username: ${username}`);
  console.log(`[ADMIN_SMS] Amount: KSH ${formattedAmount}`);
  console.log(`[ADMIN_SMS] Transaction Type: ${transactionType}`);
  console.log(`[ADMIN_SMS] M-Pesa Receipt: ${mpesaReceipt || 'N/A'}`);
  console.log(`[ADMIN_SMS] Total Revenue Today: KSH ${formattedRevenue}`);
  
  let typeLabel = 'DEPOSIT';
  if (transactionType === 'activation') typeLabel = 'WITHDRAWAL ACTIVATION';
  else if (transactionType === 'priority') typeLabel = 'PRIORITY FEE';
  else if (transactionType === 'admin-deposit') typeLabel = 'ADMIN DEPOSIT';
  
  // Use full M-Pesa receipt code (alphanumeric like UD4T08TBZH)
  let codeDisplay = '';
  if (mpesaReceipt) {
    codeDisplay = String(mpesaReceipt).trim();
  }
  
  const msg =
    `New ${typeLabel}!\n` +
    `User: ${username}\n` +
    `Phone: ${userPhone}\n` +
    `Amount: KSH ${formattedAmount}\n` +
    `Time: ${timestamp}\n` +
    `Code: ${codeDisplay || 'N/A'}\n` +
    `Total Revenue: KSH ${formattedRevenue}`;
  
  console.log(`[ADMIN_SMS] Message prepared (${msg.length} chars)`);
  console.log(`[ADMIN_SMS] FULL MESSAGE:\n${msg}`);
  console.log(`[ADMIN_SMS] Sending to: ${adminPhone}`);
  
  try {
    const result = await sendSms(adminPhone, msg);
    console.log(`[ADMIN_SMS] ✅ sendSms returned: ${result}`);
    if (result) {
      console.log(`[ADMIN_SMS] ✅ SUCCESS - Admin notification SMS sent to ${adminPhone}`);
    } else {
      console.error(`[ADMIN_SMS] ❌ FAILED - sendSms returned false`);
    }
    console.log(`[ADMIN_SMS] ====================================================\n`);
    return result;
  } catch (err) {
    console.error(`[ADMIN_SMS] ❌ EXCEPTION:`, err.message);
    console.error(`[ADMIN_SMS] Stack:`, err.stack);
    console.log(`[ADMIN_SMS] ====================================================\n`);
    return false;
  }
}

module.exports = {
  sendSms,
  sendWelcomeSms,
  sendBetPlacedSms,
  sendBetWonSms,
  sendDepositSms,
  sendWithdrawalSms,
  sendActivationSms,
  sendInactivityReminderSms,
  sendBanSms,
  sendAdminDepositNotification,
};
