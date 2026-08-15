# VERCEL ENVIRONMENT VARIABLES CONFIGURATION
## Project: betnexanew2 (Frontend)
## Team: betnexa-august

# FRONTEND ENVIRONMENT VARIABLES (.env)
# Add these to Vercel Dashboard > Settings > Environment Variables

## Supabase Configuration
SUPABASE_URL=https://eaqogmybihiqzivuwyav.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_JnzsAy2ljyd__NdzokUXhA_2k7loTgg
SUPABASE_ANON_KEY=sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ

## Backend API Configuration
VITE_API_URL=https://www.betnexabackend.co.ke
SERVER_PUBLIC_URL=https://www.betnexabackend.co.ke

## Third-Party APIs
API_FOOTBALL_KEY=49f4155b78d58351ed95b5c3bbcebd9e

## SMS Configuration
TEXTSMS_API_KEY=5e8a74e0f8eed3e7a9896401a91bc9a2
TEXTSMS_PARTNER_ID=15957
TEXTSMS_SHORTCODE=TextSMS
ADMIN_SMS_PHONE=0740176944

---

# BACKEND ENVIRONMENT VARIABLES (server/.env)
# Deploy to backend service separately

PORT=5000
NODE_ENV=production
CALLBACK_URL=https://www.betnexabackend.co.ke/api/callbacks

## Supabase
SUPABASE_URL=https://eaqogmybihiqzivuwyav.supabase.co
SUPABASE_ANON_KEY=sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ
SUPABASE_SERVICE_KEY=sb_secret_JnzsAy2ljyd__NdzokUXhA_2k7loTgg

## Daraja/M-Pesa Configuration
DARAJA_TEST_CONSUMER_KEY=7vMMkeG0t2ACOhlk6TYXNVPkcG0U5cTcaUl8nHVsino5eyqc
DARAJA_TEST_CONSUMER_SECRET=zZEy0bpFMkK1RzeyJoCWEYfOWh3zmr8msB7oaSNnfS46yTwO30Ond7IeuuoTZdIG
DARAJA_TEST_PARTY_B=4320291
DARAJA_TEST_PASSKEY=582af7323870392b818e0b7661f09700c97c8d313523b0042a971ca7f4948c89
DARAJA_TEST_SHORT_CODE=4320291
DARAJA_TEST_TRANSACTION_TYPE=CustomerPayBillOnline
DARAJA_TEST_CALLBACK_BASE_URL=https://www.betnexabackend.co.ke

## APIs
API_FOOTBALL_KEY=17ed680bbd74957dd075f7e47fcd43f2

## SMS Configuration
TEXTSMS_API_KEY=5e8a74e0f8eed3e7a9896401a91bc9a2
TEXTSMS_PARTNER_ID=15957
TEXTSMS_SHORTCODE=TextSMS
ADMIN_SMS_PHONE=0740176944

---

## HOW TO ADD TO VERCEL

### Option 1: Via Vercel Dashboard (Recommended)
1. Go to https://vercel.com
2. Select Project: betnexanew2
3. Go to Settings > Environment Variables
4. Add each variable:
   - Name: SUPABASE_URL
   - Value: https://eaqogmybihiqzivuwyav.supabase.co
   - Select: Production âœ“
   - Click "Save"
5. Repeat for all variables above

### Option 2: Via Vercel CLI
```bash
vercel env add SUPABASE_URL production --value "https://eaqogmybihiqzivuwyav.supabase.co" --scope=betnexa-august --yes
```

### Option 3: Using env.json
Create a file called `env.json` with all variables and use Vercel CLI to bulk import them.

---

## DEPLOYMENT STATUS

âœ… Frontend (betnexanew2):
   - Latest Deployment: Ready for Production
   - URL: https://betnexanew2.vercel.app
   - Status: Environment variables READY

âœ… Backend (betnexabackend.co.ke):
   - Status: Already running
   - No Vercel deployment needed

---

## NOTES

- All hardcoded secrets in source code have been removed
- Backend URL updated from betnexarevivebackend.vercel.app to betnexabackend.co.ke
- Sensitive variables (keys, secrets) should be added via Vercel Dashboard only
- Never commit .env files to repository

