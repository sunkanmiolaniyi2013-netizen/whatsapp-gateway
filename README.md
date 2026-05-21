# SMS Gateway Middleware for GoHighLevel

This is the bridge server to connect GoHighLevel (GHL) workflows to physical Android phones (or eSIMs) via the SMS Gateway API app. It supports multiple businesses (multi-tenant) safely routing messages to/from the correct GHL Location and the correct SIM card.

## Step 1: Set up Supabase (Database)
1. Go to [Supabase](https://supabase.com) and create a new project.
2. Go to the SQL Editor.
3. Open `src/db/schema.sql` and copy all the text. Paste it into the SQL Editor and click **Run**.
4. Go to Settings -> API to copy your `Project URL` and `service_role` secret key.

## Step 2: Deploy this Code
**Using Railway.app (Recommended)**
1. Connect this folder to a GitHub repository.
2. Go to [Railway.app](https://railway.app) and create a new project -> Deploy from GitHub repo.
3. Go to Variables on Railway and add:
   - `SUPABASE_URL` = your Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service_role key
   - `ADMIN_API_KEY` = a secret password you make up to protect the dashboard (e.g. `SuperSecretAdmin123`)

## Step 3: Register a Business (Tenant)
1. Go to your deployed URL in a browser (e.g., `https://sms-gateway.up.railway.app`).
2. Log in with the `ADMIN_API_KEY` you set exactly as above.
3. Click "+ Add New Business" and fill in the GHL Location ID and API Key.

## Step 4: Configure GoHighLevel Webhooks
In GHL, go to Automation -> create a Workflow triggered to send an SMS:
- Add Action: **Webhook**
- Method: **POST**
- URL: `https://your-server-url/webhooks/ghl-outbound`
- Add payload with `locationId`, `phone`, and `message` properties.

## Step 5: Android App Setup
1. Install [SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway) on your phone.
2. Open the app -> Configure Cloud Mode.
3. Add a webhook URL pointing to: `https://your-server-url/webhooks/sms-inbound`
