const express = require('express');
const axios = require('axios');
const config = require('../config');
const db = require('../db/queries');
const twilioDB = require('../db/twilioQueries');
const whatsappDB = require('../db/whatsappQueries');

const router = express.Router();

router.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Authorization code is missing.');
    }

    try {
        const data = new URLSearchParams({
            client_id: config.GHL_CLIENT_ID,
            client_secret: config.GHL_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            user_type: 'Location',
            redirect_uri: `https://${req.headers.host}/oauth/callback`
        }).toString();

        const tokenRes = await axios.post('https://services.leadconnectorhq.com/oauth/token', data, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token, refresh_token, expires_in, locationId } = tokenRes.data;

        // Ensure the location exists in either Android or Twilio DB
        const tenant = await db.getTenantByLocationId(locationId);
        const twilioTenants = await twilioDB.getTwilioTenantsByLocationId(locationId);
        const whatsappTenants = await whatsappDB.getWhatsappTenantsByLocationId(locationId);
        
        let savedSuccessfully = false;

        // 1. Save to Android (if configured)
        if (tenant) {
            console.log(`[OAuth] Saving tokens for Android tenant at location ${locationId}`);
            await db.updateTenantOAuthTokens(locationId, access_token, refresh_token, expires_in);
            savedSuccessfully = true;
        }

        // 2. Save to Twilio (if configured)
        if (twilioTenants && twilioTenants.length > 0) {
            console.log(`[OAuth] Saving tokens for Twilio tenant at location ${locationId}`);
            await twilioDB.updateTwilioTenantOAuthTokens(locationId, access_token, refresh_token, expires_in);
            savedSuccessfully = true;
        }

        // 3. Save to WhatsApp (if configured — including soft-deleted rows)
        // We check ALL rows (active + inactive) because soft-deleted rows still
        // hold tokens that new numbers will inherit from.
        if ((whatsappTenants && whatsappTenants.length > 0) || tenant || (twilioTenants && twilioTenants.length > 0)) {
            // Always try to update — updateWhatsappTenantOAuthTokens doesn't filter by is_active
            console.log(`[OAuth] Saving tokens for WhatsApp tenant(s) at location ${locationId}`);
            try {
                await whatsappDB.updateWhatsappTenantOAuthTokens(locationId, access_token, refresh_token, expires_in);
            } catch (e) {
                // Non-fatal: no WA rows exist yet, that's fine
                console.log(`[OAuth] No WhatsApp rows to update for ${locationId} (will be inherited when number is added)`);
            }
            savedSuccessfully = true;
        }

        // 4. Auto-provision WhatsApp Placeholder if no gateway is setup yet
        // This prevents the "not registered" error for users who ONLY want WhatsApp
        if (!savedSuccessfully) {
            console.log(`[OAuth] No gateway found for ${locationId}. Auto-provisioning WhatsApp placeholder.`);
            const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
            await whatsappDB.addWhatsappTenant({
                business_name: `Location ${locationId}`,
                ghl_location_id: locationId,
                whatsapp_phone_number: 'pending',
                whatsapp_instance_id: `wa_${locationId.substring(0, 10)}_${Date.now()}`,
                whatsapp_api_key: 'built-in',
                whatsapp_base_url: 'built-in',
                ghl_access_token: access_token,
                ghl_refresh_token: refresh_token,
                ghl_token_expires_at: expiresAt
            });
            savedSuccessfully = true;
        }

        if (savedSuccessfully) {
            return res.send(`<h2>Success! GoHighLevel successfully connected for Location ID: ${locationId}</h2><p>You can close this window now.</p>`);
        } else {
            return res.status(404).send(`<h2>Error</h2><p>Location ID ${locationId} has not been registered in your Admin Dashboard yet. Go add the business or Twilio number first, then click Connect!</p>`);
        }
    } catch (error) {
        const errorDetails = error.response?.data || error.message;
        console.error('OAuth Error:', errorDetails);
        res.status(500).send(`<h2>OAuth failed</h2><p><strong>Error Details:</strong> <pre>${JSON.stringify(errorDetails, null, 2)}</pre></p><p>Check if your GHL_CLIENT_ID/SECRET and redirect URI match exactly what is in your GHL App Settings.</p>`);
    }
});

module.exports = router;
