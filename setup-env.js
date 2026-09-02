#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Environment variables to add
const envVars = {
  SUPABASE_URL: "https://eaqogmybihiqzivuwyav.supabase.co",
  SUPABASE_SERVICE_KEY: "sb_secret_JnzsAy2ljyd__NdzokUXhA_2k7loTgg",
  SUPABASE_ANON_KEY: "sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ",
  VITE_API_URL: "https://www.betnexabackend.co.ke",
  SERVER_PUBLIC_URL: "https://www.betnexabackend.co.ke",
  API_FOOTBALL_KEY: "49f4155b78d58351ed95b5c3bbcebd9e",
  TEXTSMS_API_KEY: "5e8a74e0f8eed3e7a9896401a91bc9a2",
  TEXTSMS_PARTNER_ID: "15957",
  TEXTSMS_SHORTCODE: "TextSMS",
  ADMIN_SMS_PHONE: "0740176944"
};

// Create .env files
const rootEnv = Object.entries(envVars)
  .map(([key, value]) => `${key}=${value}`)
  .join('\n');

fs.writeFileSync('.env', rootEnv);
console.log('âœ… Created .env file');

// Backend env vars
const backendEnvVars = {
  PORT: "5000",
  NODE_ENV: "production",
  CALLBACK_URL: "https://www.betnexabackend.co.ke/api/callbacks",
  SUPABASE_URL: "https://eaqogmybihiqzivuwyav.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ",
  SUPABASE_SERVICE_KEY: "sb_secret_JnzsAy2ljyd__NdzokUXhA_2k7loTgg",
  DARAJA_TEST_CONSUMER_KEY: "7vMMkeG0t2ACOhlk6TYXNVPkcG0U5cTcaUl8nHVsino5eyqc",
  DARAJA_TEST_CONSUMER_SECRET: "zZEy0bpFMkK1RzeyJoCWEYfOWh3zmr8msB7oaSNnfS46yTwO30Ond7IeuuoTZdIG",
  DARAJA_TEST_PARTY_B: "4320291",
  DARAJA_TEST_PASSKEY: "582af7323870392b818e0b7661f09700c97c8d313523b0042a971ca7f4948c89",
  DARAJA_TEST_SHORT_CODE: "4320291",
  DARAJA_TEST_TRANSACTION_TYPE: "CustomerPayBillOnline",
  DARAJA_TEST_CALLBACK_BASE_URL: "https://www.betnexabackend.co.ke",
  API_FOOTBALL_KEY: "17ed680bbd74957dd075f7e47fcd43f2",
  TEXTSMS_API_KEY: "5e8a74e0f8eed3e7a9896401a91bc9a2",
  TEXTSMS_PARTNER_ID: "15957",
  TEXTSMS_SHORTCODE: "TextSMS",
  ADMIN_SMS_PHONE: "0740176944"
};

const backendEnv = Object.entries(backendEnvVars)
  .map(([key, value]) => `${key}=${value}`)
  .join('\n');

fs.mkdirSync('server', { recursive: true });
fs.writeFileSync('server/.env', backendEnv);
console.log('âœ… Created server/.env file');

console.log('\nðŸ“‹ Environment Variables Summary:');
console.log('================================');
console.log(`Frontend (.env): ${Object.keys(envVars).length} variables`);
console.log(`Backend (server/.env): ${Object.keys(backendEnvVars).length} variables`);
console.log('\nâœ… All environment files configured!');


