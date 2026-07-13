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

        const { access_token, refresh_token, expires_in, locationId, companyId } = tokenRes.data;
        
        if (!locationId) {
            return res.status(400).send(`
                <h2>Installation Failed: Wrong Account Level</h2>
                <p>You selected an <strong>Agency</strong> instead of a <strong>Sub-Account</strong> during installation.</p>
                <p>Because this WhatsApp integration manages physical phone numbers per location, it <strong>must be installed on a specific Sub-Account.</strong></p>
                <p><strong>How to fix:</strong><br>
                1. Go to your GoHighLevel Agency Settings -> App Marketplace -> Installed Apps and uninstall this app.<br>
                2. Click your installation link again.<br>
                3. When the GoHighLevel authorization screen appears, <strong>select a specific Sub-Account</strong> from the dropdown list, DO NOT select the Agency.</p>
                <p><em>(If you do not see any Sub-Accounts in the dropdown, you must edit your App settings in the GoHighLevel Marketplace Developer Studio and change the "Distribution Type" to Sub-Account).</em></p>
            `);
        }

        const finalLocId = locationId;

        // Ensure the location exists in either Android or Twilio DB
        const tenant = await db.getTenantByLocationId(finalLocId);
        const twilioTenants = await twilioDB.getTwilioTenantsByLocationId(finalLocId);
        const whatsappTenants = await whatsappDB.getWhatsappTenantsByLocationId(finalLocId);
        
        let savedSuccessfully = false;

        // 1. Save to Android (if configured)
        if (tenant) {
            console.log(`[OAuth] Saving tokens for Android tenant at location ${finalLocId}`);
            await db.updateTenantOAuthTokens(finalLocId, access_token, refresh_token, expires_in);
            savedSuccessfully = true;
        }

        // 2. Save to Twilio (if configured)
        if (twilioTenants && twilioTenants.length > 0) {
            console.log(`[OAuth] Saving tokens for Twilio tenant at location ${finalLocId}`);
            await twilioDB.updateTwilioTenantOAuthTokens(finalLocId, access_token, refresh_token, expires_in);
            savedSuccessfully = true;
        }

        // 3. Save to WhatsApp (if configured — including soft-deleted rows)
        if ((whatsappTenants && whatsappTenants.length > 0) || tenant || (twilioTenants && twilioTenants.length > 0)) {
            console.log(`[OAuth] Saving tokens for WhatsApp tenant(s) at location ${finalLocId}`);
            try {
                await whatsappDB.updateWhatsappTenantOAuthTokens(finalLocId, access_token, refresh_token, expires_in);
            } catch (e) {
                console.log(`[OAuth] No WhatsApp rows to update for ${finalLocId}`);
            }
            savedSuccessfully = true;
        }

        // 4. Auto-provision WhatsApp Placeholder if no gateway is setup yet
        if (!savedSuccessfully) {
            console.log(`[OAuth] No gateway found for ${finalLocId}. Auto-provisioning WhatsApp placeholder.`);
            const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
            await whatsappDB.addWhatsappTenant({
                business_name: `Location ${finalLocId}`,
                ghl_location_id: finalLocId,
                whatsapp_phone_number: `pending_${finalLocId.substring(0, 10)}_${Date.now()}`,
                whatsapp_instance_id: `wa_${finalLocId.substring(0, 10)}_${Date.now()}`,
                whatsapp_api_key: 'built-in',
                whatsapp_base_url: 'built-in',
                ghl_access_token: access_token,
                ghl_refresh_token: refresh_token,
                ghl_token_expires_at: expiresAt
            });
            savedSuccessfully = true;
        }

        if (savedSuccessfully) {
            return res.send(`<h2>Success! GoHighLevel successfully connected for Location ID: ${finalLocId}</h2><p>You can close this window now.</p>`);
        } else {
            return res.status(404).send(`<h2>Error</h2><p>Location ID ${finalLocId} has not been registered in your Admin Dashboard yet.</p>`);
        }
    } catch (error) {
        const errorDetails = error.response?.data || error.message;
        console.error('OAuth Error:', errorDetails);
        res.status(500).send(`<h2>OAuth failed</h2><p><strong>Error Details:</strong> <pre>${JSON.stringify(errorDetails, null, 2)}</pre></p><p>Check if your GHL_CLIENT_ID/SECRET and redirect URI match exactly what is in your GHL App Settings.</p>`);
    }
});

module.exports = router;
