#!/usr/bin/env node

/**
 * Script to add environment variables to both Vercel projects
 * Backend: betnexanew2 (at https://betnexanewbackend.vercel.app)
 * Frontend: betnexanew (at https://betnexanew.vercel.app)
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

console.log('\n');
console.log('â•”' + 'â•'.repeat(78) + 'â•—');
console.log('â•‘  ðŸ” VERCEL ENVIRONMENT VARIABLES CONFIGURATION                             â•‘');
console.log('â•‘  Backend: betnexanew2 | Frontend: betnexanew                               â•‘');
console.log('â•š' + 'â•'.repeat(78) + 'â•');

// BACKEND VARIABLES (for server/.env - deployed to betnexanew2)
const backendVars = {
  'PORT': '5000',
  'NODE_ENV': 'production',
  'CALLBACK_URL': 'https://betnexanewbackend.vercel.app/api/callbacks',
  'SUPABASE_URL': 'https://eaqogmybihiqzivuwyav.supabase.co',
  'SUPABASE_ANON_KEY': 'sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ',
  'SUPABASE_SERVICE_KEY': 'sb_secret_JnzsAy2ljyd__NdzokUXhA_2k7loTgg',
  'DARAJA_TEST_CONSUMER_KEY': '7vMMkeG0t2ACOhlk6TYXNVPkcG0U5cTcaUl8nHVsino5eyqc',
  'DARAJA_TEST_CONSUMER_SECRET': 'zZEy0bpFMkK1RzeyJoCWEYfOWh3zmr8msB7oaSNnfS46yTwO30Ond7IeuuoTZdIG',
  'DARAJA_TEST_PARTY_B': '4320291',
  'DARAJA_TEST_PASSKEY': '582af7323870392b818e0b7661f09700c97c8d313523b0042a971ca7f4948c89',
  'DARAJA_TEST_SHORT_CODE': '4320291',
  'DARAJA_TEST_TRANSACTION_TYPE': 'CustomerPayBillOnline',
  'DARAJA_TEST_CALLBACK_BASE_URL': 'https://betnexanewbackend.vercel.app',
  'API_FOOTBALL_KEY': 'afc8a85f7408df5bcfbc712aeb8e7453',
  'TEXTSMS_API_KEY': '5e8a74e0f8eed3e7a9896401a91bc9a2',
  'TEXTSMS_PARTNER_ID': '15957',
  'TEXTSMS_SHORTCODE': 'TextSMS',
  'ADMIN_SMS_PHONE': '0740176944'
};

// FRONTEND VARIABLES (for root .env - deployed to betnexanew)
const frontendVars = {
  'SUPABASE_URL': 'https://eaqogmybihiqzivuwyav.supabase.co',
  'SUPABASE_SERVICE_KEY': 'sb_secret_JnzsAy2ljyd__NdzokUXhA_2k7loTgg',
  'SUPABASE_ANON_KEY': 'sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ',
  'VITE_API_URL': 'https://betnexanewbackend.vercel.app',
  'SERVER_PUBLIC_URL': 'https://betnexanewbackend.vercel.app',
  'API_FOOTBALL_KEY': 'afc8a85f7408df5bcfbc712aeb8e7453',
  'TEXTSMS_API_KEY': '5e8a74e0f8eed3e7a9896401a91bc9a2',
  'TEXTSMS_PARTNER_ID': '15957',
  'TEXTSMS_SHORTCODE': 'TextSMS',
  'ADMIN_SMS_PHONE': '0740176944'
};

let backendCount = 0;
let backendFailed = [];
let frontendCount = 0;
let frontendFailed = [];

function addEnvVar(key, value, project) {
  try {
    // Escape quotes in value
    const escapedValue = value.replace(/"/g, '\\"');
    
    // For backend, we need to explicitly specify the project or change directory
    if (project === 'backend') {
      execSync(`vercel env add ${key} production --value "${escapedValue}" --scope=betnexa-august --yes 2>&1`, {
        stdio: 'pipe',
        cwd: path.join(__dirname, 'server')
      });
    } else {
      // For frontend, use current directory
      execSync(`vercel env add ${key} production --value "${escapedValue}" --scope=betnexa-august --yes 2>&1`, {
        stdio: 'pipe'
      });
    }
    return true;
  } catch (err) {
    return false;
  }
}

// Add backend variables
console.log('\nðŸ“‹ BACKEND PROJECT: betnexanew2');
console.log('   URL: https://betnexanewbackend.vercel.app');
console.log('   Directory: server/');
console.log('   Variables: ' + Object.keys(backendVars).length);
console.log('â”€'.repeat(80));

Object.entries(backendVars).forEach(([key, value]) => {
  const success = addEnvVar(key, value, 'backend');
  if (success) {
    console.log(`   âœ… ${key}`);
    backendCount++;
  } else {
    console.log(`   âš ï¸  ${key} - Check manually or set via Dashboard`);
    backendFailed.push(key);
  }
});

// Add frontend variables
console.log('\nðŸ“‹ FRONTEND PROJECT: betnexanew');
console.log('   URL: https://betnexanew.vercel.app');
console.log('   Directory: ./');
console.log('   Variables: ' + Object.keys(frontendVars).length);
console.log('â”€'.repeat(80));

Object.entries(frontendVars).forEach(([key, value]) => {
  const success = addEnvVar(key, value, 'frontend');
  if (success) {
    console.log(`   âœ… ${key}`);
    frontendCount++;
  } else {
    console.log(`   âš ï¸  ${key} - Check manually or set via Dashboard`);
    frontendFailed.push(key);
  }
});

// Summary
console.log('\n' + 'â•”' + 'â•'.repeat(78) + 'â•—');
console.log('â•‘  ðŸ“Š SUMMARY                                                               â•‘');
console.log('â•š' + 'â•'.repeat(78) + 'â•');
console.log(`\nâœ… Backend (betnexanew2):  ${backendCount}/${Object.keys(backendVars).length} variables added`);
if (backendFailed.length > 0) {
  console.log(`   Failed: ${backendFailed.join(', ')}`);
}

console.log(`âœ… Frontend (betnexanew):  ${frontendCount}/${Object.keys(frontendVars).length} variables added`);
if (frontendFailed.length > 0) {
  console.log(`   Failed: ${frontendFailed.join(', ')}`);
}

console.log('\nðŸ“ NEXT STEPS:');
console.log('   1. If any variables failed, add them manually via Vercel Dashboard');
console.log('   2. Redeploy both projects after all variables are added');
console.log('   3. Monitor deployment logs for errors');

console.log('\nðŸ”— VERCEL DASHBOARD LINKS:');
console.log('   Backend:  https://vercel.com/betnexa-august/betnexanew2/settings/environment-variables');
console.log('   Frontend: https://vercel.com/betnexa-august/betnexanew/settings/environment-variables');

console.log('\n');


