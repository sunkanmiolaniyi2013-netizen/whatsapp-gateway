const axios = require('axios');
const config = require('../config');
const supabase = require('../db/supabase');

/**
 * Ensures the tenant has a valid Access Token. If expired, automatically refreshes it.
 */
async function getValidAccessToken(tenant) {
    if (!tenant.ghl_refresh_token) {
        throw new Error(`Location ${tenant.ghl_location_id} has not completed OAuth authorization! No refresh token found.`);
    }

    const now = new Date();
    const expiresAt = new Date(tenant.ghl_token_expires_at);
    
    // If the token expires in the next 15 minutes, or is already expired, refresh it!
    if (expiresAt.getTime() - now.getTime() < 15 * 60 * 1000) {
        console.log(`Token expired/expiring for ${tenant.ghl_location_id}, refreshing now...`);
        const data = new URLSearchParams({
            client_id: config.GHL_CLIENT_ID,
            client_secret: config.GHL_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: tenant.ghl_refresh_token
        }).toString();

        const res = await axios.post('https://services.leadconnectorhq.com/oauth/token', data, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        // Save new tokens securely
        const newExpiresAt = new Date(Date.now() + (res.data.expires_in * 1000));
        await supabase.from('tenants').update({
            ghl_access_token: res.data.access_token,
            ghl_refresh_token: res.data.refresh_token,
            ghl_token_expires_at: newExpiresAt
        }).eq('id', tenant.id);
        
        tenant.ghl_access_token = res.data.access_token;
        tenant.ghl_refresh_token = res.data.refresh_token;
        console.log(`Token successfully refreshed for ${tenant.ghl_location_id}`);
    }

    return tenant.ghl_access_token;
}

/**
 * Pushes an inbound SMS reply into GoHighLevel's conversation inbox
 * Used for routing Android Gateway texts back into GHL's UI natively
 */
async function pushInboundMessageToGHL(tenant, fromNumber, body) {
    try {
        const token = await getValidAccessToken(tenant);
        let contactId = null;

        try {
            // Find the contact in GHL to get their ID (required for inbound V2 API)
            const searchRes = await axios.get(
                `https://services.leadconnectorhq.com/contacts/?locationId=${tenant.ghl_location_id}&query=${encodeURIComponent(fromNumber)}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Version': '2021-07-28',
                        'Accept': 'application/json'
                    }
                }
            );
            if (searchRes.data?.contacts?.length > 0) {
                contactId = searchRes.data.contacts[0].id;
            }
        } catch (e) {
            console.error('Failed to look up contact ID:', e.message);
        }

        const payload = {
            type: 'SMS',
            to: tenant.phone_number,
            from: fromNumber,
            message: body
        };

        if (contactId) {
            payload.contactId = contactId;
        }

        const response = await axios.post(
            'https://services.leadconnectorhq.com/conversations/messages/inbound',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Version': '2021-04-15',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error posting inbound message to GHL:', error?.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    pushInboundMessageToGHL,
    getValidAccessToken
};
