/**
 * Safaricom C2B (Customer-to-Business) Service
 * Handles offline M-Pesa payments where users pay to Paybill 4046271
 * using their BETNEXA ID as the account number.
 *
 * Flow:
 * 1. User goes to M-Pesa → Lipa na M-Pesa → Pay Bill
 * 2. Enters Business Number: 4046271
 * 3. Enters Account Number: their BETNEXA ID (e.g. K234)
 * 4. Enters amount and confirms
 * 5. Safaricom sends Validation request → we accept/reject
 * 6. Safaricom sends Confirmation request → we credit the user
 */

const { getAccessToken, getDarajaTestConfig } = require('./darajaTestService.js');
const https = require('https');

/**
 * Register C2B validation and confirmation URLs with Safaricom.
 * Must be called once (or after URL changes) to tell Safaricom where to send callbacks.
 */
async function registerC2BUrls() {
  const config = getDarajaTestConfig();
  const accessToken = await getAccessToken();

  const callbackBase = config.callbackBaseUrl || 'https://www.betnexabackend.co.ke';

  const payload = {
    ShortCode: config.shortCode,
    ResponseType: 'Completed', // 'Completed' = accept all, 'Cancelled' = use validation
    ConfirmationURL: `${callbackBase}/api/callbacks/c2b-confirmation`,
    ValidationURL: `${callbackBase}/api/callbacks/c2b-validation`,
  };

  console.log('[C2B] Registering URLs:', JSON.stringify(payload, null, 2));

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const req = https.request(
      {
        hostname: 'api.safaricom.co.ke',
        port: 443,
        path: '/mpesa/c2b/v2/registerurl',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 30000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            console.log('[C2B] Register URL Response:', JSON.stringify(parsed));
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`C2B Register URL failed: ${parsed.errorMessage || raw} (HTTP ${res.statusCode})`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse C2B response: ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('C2B register URL timed out')); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  registerC2BUrls,
};
