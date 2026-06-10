const axios = require('axios');
const config = require('../config');
const supabase = require('../db/supabase');

/**
 * Ensures the tenant has a valid Access Token.
 * Priority: OAuth (primary) → PIT bypass (fallback for tenants configured with pit- key)
 * Tokens are refreshed automatically if expired. A background job in tokenRefreshJob.js
 * keeps all tokens warm proactively so they never expire during periods of inactivity.
 */
async function getValidAccessToken(tenant) {
    // PIT Bypass: If this tenant has a Private Integration Token, use it directly.
    // This is a per-tenant fallback — not the primary auth method.
    if (tenant.ghl_api_key && tenant.ghl_api_key.startsWith('pit-')) {
        console.log(`[API] Using Private Integration Token for Location ${tenant.ghl_location_id}`);
        return tenant.ghl_api_key;
    }

    // Determine which table this tenant lives in so we can save refreshed tokens back
    let tableName = 'twilio_tenants';
    if (tenant.gateway_device_id !== undefined) tableName = 'tenants';
    else if (tenant.whatsapp_instance_id !== undefined) tableName = 'whatsapp_tenants';

    // ── Sibling Token Lookup ─────────────────────────────────────────────────
    // If this specific row has no refresh token yet, look for one from a sibling
    // tenant on the same location (e.g. a Twilio tenant inheriting from Android).
    if (!tenant.ghl_refresh_token) {
        console.log(`[OAuth] Row ${tenant.id} has no tokens. Searching siblings for location ${tenant.ghl_location_id}...`);

        // ── Fallback 1: PIT Key Sibling ───────────────────────────────────────
        // If any Android tenant for this location has a Private Integration Token,
        // return it immediately. This covers BOTH Android and Twilio inbound paths
        // when OAuth tokens are missing — the ultimate bulletproof fallback.
        const { data: pitSiblings } = await supabase
            .from('tenants')
            .select('ghl_api_key')
            .eq('ghl_location_id', tenant.ghl_location_id)
            .like('ghl_api_key', 'pit-%')
            .limit(1);

        if (pitSiblings && pitSiblings.length > 0) {
            console.log(`[OAuth] ✅ PIT fallback: using Android sibling PIT key for location ${tenant.ghl_location_id}`);
            return pitSiblings[0].ghl_api_key;
        }

        // ── Fallback 2: OAuth Token Sibling ───────────────────────────────────
        // No PIT found — try to inherit OAuth tokens from any sibling tenant row.
        let siblingToken = null;

        // Check Android tenants first
        const { data: sibling1 } = await supabase
            .from('tenants')
            .select('ghl_access_token, ghl_refresh_token, ghl_token_expires_at')
            .eq('ghl_location_id', tenant.ghl_location_id)
            .not('ghl_refresh_token', 'is', null)
            .limit(1);
        if (sibling1 && sibling1.length > 0) siblingToken = sibling1[0];

        // Check Twilio tenants if not found in Android
        if (!siblingToken) {
            const { data: sibling2 } = await supabase
                .from('twilio_tenants')
                .select('ghl_access_token, ghl_refresh_token, ghl_token_expires_at')
                .eq('ghl_location_id', tenant.ghl_location_id)
                .not('ghl_refresh_token', 'is', null)
                .limit(1);
            if (sibling2 && sibling2.length > 0) siblingToken = sibling2[0];
        }

        // Check WhatsApp tenants if not found in Twilio
        if (!siblingToken) {
            const { data: sibling3 } = await supabase
                .from('whatsapp_tenants')
                .select('ghl_access_token, ghl_refresh_token, ghl_token_expires_at')
                .eq('ghl_location_id', tenant.ghl_location_id)
                .not('ghl_refresh_token', 'is', null)
                .limit(1);
            if (sibling3 && sibling3.length > 0) siblingToken = sibling3[0];
        }

        if (siblingToken && siblingToken.ghl_refresh_token) {
            console.log(`[OAuth] Sibling tokens found! Inheriting into row ${tenant.id}...`);
            tenant.ghl_access_token = siblingToken.ghl_access_token;
            tenant.ghl_refresh_token = siblingToken.ghl_refresh_token;
            tenant.ghl_token_expires_at = siblingToken.ghl_token_expires_at;

            // Persist them so future calls don't need to do the sibling lookup again
            await supabase.from(tableName).update({
                ghl_access_token: siblingToken.ghl_access_token,
                ghl_refresh_token: siblingToken.ghl_refresh_token,
                ghl_token_expires_at: siblingToken.ghl_token_expires_at
            }).eq('id', tenant.id);
        } else {
            throw new Error(
                `Location ${tenant.ghl_location_id} has no PIT key and no valid OAuth tokens. ` +
                `Add a PIT key to the Android tenant or re-authorize via the GHL Marketplace.`
            );
        }
    }

    // ── Token Refresh ────────────────────────────────────────────────────────
    // If the access token is expired or expiring within 15 minutes, refresh it now.
    // GHL rotates both access AND refresh tokens on every refresh call.
    const now = new Date();
    const expiresAt = new Date(tenant.ghl_token_expires_at);

    if (expiresAt.getTime() - now.getTime() < 15 * 60 * 1000) {
        console.log(`[OAuth] Token expired/expiring for ${tenant.ghl_location_id}. Refreshing...`);

        const formData = new URLSearchParams({
            client_id: config.GHL_CLIENT_ID,
            client_secret: config.GHL_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: tenant.ghl_refresh_token
        }).toString();

        const res = await axios.post('https://services.leadconnectorhq.com/oauth/token', formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const newExpiresAt = new Date(Date.now() + res.data.expires_in * 1000);

        await supabase.from(tableName).update({
            ghl_access_token: res.data.access_token,
            ghl_refresh_token: res.data.refresh_token,
            ghl_token_expires_at: newExpiresAt
        }).eq('id', tenant.id);

        tenant.ghl_access_token = res.data.access_token;
        tenant.ghl_refresh_token = res.data.refresh_token;
        console.log(`[OAuth] ✅ Token refreshed successfully for ${tenant.ghl_location_id}`);
    }

    return tenant.ghl_access_token;
}

/**
 * Pushes an inbound message reply into GoHighLevel's conversation inbox
 * Used for routing Android Gateway texts or WhatsApp back into GHL's UI natively
 */
async function pushInboundMessageToGHL(tenant, fromNumber, body, channelType = 'SMS') {
    try {
        const token = await getValidAccessToken(tenant);
        let contactId = null;

        let to_number = tenant.phone_number || tenant.whatsapp_phone_number;
        if (to_number && !to_number.startsWith('+')) to_number = '+' + to_number;
        
        let from_number = fromNumber;
        if (from_number && !from_number.startsWith('+')) from_number = '+' + from_number;

        try {
            // Find the contact in GHL to get their ID (required for inbound V2 API)
            const searchRes = await axios.get(
                `https://services.leadconnectorhq.com/contacts/?locationId=${tenant.ghl_location_id}&query=${encodeURIComponent(from_number)}`,
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
            } else {
                console.log(`[GHL] Contact not found for ${from_number}. Creating new contact...`);
                const createRes = await axios.post(
                    `https://services.leadconnectorhq.com/contacts/`,
                    {
                        locationId: tenant.ghl_location_id,
                        phone: from_number,
                        firstName: 'WhatsApp',
                        lastName: 'Lead'
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Version': '2021-07-28',
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        }
                    }
                );
                if (createRes.data?.contact?.id) {
                    contactId = createRes.data.contact.id;
                    console.log(`[GHL] Created contact: ${contactId}`);
                }
            }
        } catch (e) {
            console.error('Failed to look up or create contact ID:', e?.response?.data || e.message);
        }

        const payload = {
            type: channelType,
            to: to_number,
            from: from_number,
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
