const express = require('express');
const axios = require('axios');
const config = require('../config');
const db = require('../db/queries');

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

        // Ensure the tenant row exists in our DB
        const tenant = await db.getTenantByLocationId(locationId);
        if (tenant) {
            await db.updateTenantOAuthTokens(locationId, access_token, refresh_token, expires_in);
            return res.send(`<h2>Success! GoHighLevel successfully connected for Location ID: ${locationId}</h2><p>You can close this window now.</p>`);
        } else {
            return res.status(404).send(`<h2>Error</h2><p>Location ID ${locationId} has not been registered in your Admin Dashboard yet. Go add the business first, then click Connect!</p>`);
        }
    } catch (error) {
        console.error('OAuth Error:', error.response?.data || error.message);
        res.status(500).send('OAuth failed. Check server logs.');
    }
});

module.exports = router;
