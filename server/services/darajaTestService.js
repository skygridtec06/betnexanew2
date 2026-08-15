const https = require('https');

const darajaHttpsAgent = new https.Agent({ keepAlive: true });
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;
let accessTokenPromise = null;

const DARAJA_HOST = 'api.safaricom.co.ke';

function getDarajaTestConfig() {
  const clean = (value) => (typeof value === 'string' ? value.replace(/[\r\n\s]+/g, '').trim() : value);
  const cleanUrl = (value) => (typeof value === 'string' ? value.replace(/[\r\n]+/g, '').trim() : value);
  const config = {
    consumerKey: clean(process.env.DARAJA_TEST_CONSUMER_KEY) || '7vMMkeG0t2ACOhlk6TYXNVPkcG0U5cTcaUl8nHVsino5eyqc',
    consumerSecret: clean(process.env.DARAJA_TEST_CONSUMER_SECRET) || 'zZEy0bpFMkK1RzeyJoCWEYfOWh3zmr8msB7oaSNnfS46yTwO30Ond7IeuuoTZdIG',
    passkey: clean(process.env.DARAJA_TEST_PASSKEY) || '582af7323870392b818e0b7661f09700c97c8d313523b0042a971ca7f4948c89',
    shortCode: clean(process.env.DARAJA_TEST_SHORT_CODE) || '4320291',
    partyB: clean(process.env.DARAJA_TEST_PARTY_B) || '4320291',
    transactionType: clean(process.env.DARAJA_TEST_TRANSACTION_TYPE) || 'CustomerPayBillOnline',
    callbackBaseUrl: cleanUrl(process.env.DARAJA_TEST_CALLBACK_BASE_URL || process.env.SERVER_PUBLIC_URL || 'https://betnexanewbackend.vercel.app').replace(/\/$/, ''),
  };

  const missing = Object.entries(config)
    .filter(([key, value]) => !value && key !== 'transactionType')
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing Daraja test configuration: ${missing.join(', ')}`);
  }

  return config;
}

function normalizeDarajaPhoneNumber(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');

  if (/^254\d{9}$/.test(digits)) {
    return digits;
  }

  if (/^0\d{9}$/.test(digits)) {
    return `254${digits.slice(1)}`;
  }

  if (/^[17]\d{8}$/.test(digits)) {
    return `254${digits}`;
  }

  throw new Error('Phone number must be a valid Kenyan mobile number');
}

function getTimestamp() {
  const now = new Date();
  const pad = (value) => `${value}`.padStart(2, '0');

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
}

function performJsonRequest({ method, path, headers }, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;

    const req = https.request(
      {
        hostname: DARAJA_HOST,
        port: 443,
        path,
        method,
        headers: {
          ...(body
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
          ...headers,
        },
        agent: darajaHttpsAgent,
        timeout: 30000,
      },
      (res) => {
        let raw = '';

        res.on('data', (chunk) => {
          raw += chunk;
        });

        res.on('end', () => {
          let parsed = {};

          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (error) {
            reject(new Error(`Failed to parse Daraja response: ${error.message}`));
            return;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          console.error('[Daraja] HTTP', res.statusCode, 'Response:', JSON.stringify(parsed));
          const errMsg = parsed.errorMessage || parsed.ResponseDescription || parsed.errorCode || `Daraja request failed with status ${res.statusCode}`;
          reject(new Error(`${errMsg} (HTTP ${res.statusCode}, raw: ${raw.substring(0, 200)})`))
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Daraja request timed out'));
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiry > now + 30000) {
    return cachedAccessToken;
  }

  if (accessTokenPromise) {
    return accessTokenPromise;
  }

  const config = getDarajaTestConfig();
  const { consumerKey, consumerSecret } = config;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  console.log('[Daraja Auth] Key length:', consumerKey.length, 'Secret length:', consumerSecret.length);
  console.log('[Daraja Auth] Key starts:', consumerKey.substring(0, 8), 'ends:', consumerKey.slice(-4));
  console.log('[Daraja Auth] Host:', DARAJA_HOST);
  console.log('[Daraja Auth] Base64 auth length:', auth.length);

  accessTokenPromise = performJsonRequest({
    method: 'GET',
    path: '/oauth/v1/generate?grant_type=client_credentials',
    headers: {
      Authorization: `Basic ${auth}`,
    },
  })
    .then((response) => {
      if (!response.access_token) {
        throw new Error('Daraja access token was not returned');
      }

      const expiresInSeconds = Number.parseInt(response.expires_in, 10);
      const ttlMs = Number.isFinite(expiresInSeconds) ? expiresInSeconds * 1000 : 55 * 60 * 1000;

      cachedAccessToken = response.access_token;
      cachedAccessTokenExpiry = Date.now() + ttlMs;

      return cachedAccessToken;
    })
    .finally(() => {
      accessTokenPromise = null;
    });

  return accessTokenPromise;
}

async function callDaraja(path, payload) {
  const accessToken = await getAccessToken();

  return performJsonRequest(
    {
      method: 'POST',
      path,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    payload
  );
}

async function initiateAdminTestStkPush({ phoneNumber, amount, accountReference, transactionDesc, callbackUrl }) {
  const config = getDarajaTestConfig();
  const normalizedPhone = normalizeDarajaPhoneNumber(phoneNumber);
  const timestamp = getTimestamp();
  const password = Buffer.from(`${config.shortCode}${config.passkey}${timestamp}`).toString('base64');
  const partyB = config.partyB || config.shortCode;

  // Daraja limits: AccountReference max 12 chars, TransactionDesc max 13 chars
  const safeAccountRef = (accountReference || 'BETNEXA').substring(0, 12);
  const safeTransDesc = (transactionDesc || 'Payment').substring(0, 13);

  const stkPayload = {
    BusinessShortCode: config.shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: config.transactionType,
    Amount: Math.round(parseFloat(amount)),
    PartyA: normalizedPhone,
    PartyB: partyB,
    PhoneNumber: normalizedPhone,
    CallBackURL: callbackUrl,
    AccountReference: safeAccountRef,
    TransactionDesc: safeTransDesc,
  };

  console.log('[Daraja STK] Request:', JSON.stringify({
    ...stkPayload,
    Password: '***REDACTED***',
  }));

  const response = await callDaraja('/mpesa/stkpush/v1/processrequest', stkPayload);

  if (`${response.ResponseCode || ''}` !== '0') {
    throw new Error(response.ResponseDescription || 'Daraja STK push initiation failed');
  }

  return {
    checkoutRequestId: response.CheckoutRequestID,
    merchantRequestId: response.MerchantRequestID,
    responseCode: response.ResponseCode,
    responseDescription: response.ResponseDescription,
    customerMessage: response.CustomerMessage,
    normalizedPhone,
  };
}

async function queryAdminTestStkPushStatus({ checkoutRequestId }) {
  const config = getDarajaTestConfig();
  const timestamp = getTimestamp();
  const password = Buffer.from(`${config.shortCode}${config.passkey}${timestamp}`).toString('base64');

  return callDaraja('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: config.shortCode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  });
}

module.exports = {
  initiateAdminTestStkPush,
  normalizeDarajaPhoneNumber,
  queryAdminTestStkPushStatus,
  getDarajaTestConfig,
  getAccessToken,
};

