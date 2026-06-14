const axios = require('axios');
const config = require('../config');
const supabase = require('../db/supabase');
const whatsappDB = require('../db/whatsappQueries');

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

    // To prevent GHL from automatically forcing inbound messages into the WhatsApp tab
    // (which triggers the subscription block), we want to use an SMS Provider's OAuth token
    // instead of the WhatsApp provider's OAuth token whenever possible.
    let preferSiblingSmsToken = false;
    if (tableName === 'whatsapp_tenants') preferSiblingSmsToken = true;

    // ── Sibling Token Lookup ─────────────────────────────────────────────────
    // If this specific row has no refresh token yet, look for one from a sibling
    // tenant on the same location (e.g. a Twilio tenant inheriting from Android).
    // Also handles the case where tenant.id is undefined (bare location lookups).
    if (!tenant.ghl_refresh_token) {
        const tenantLabel = tenant.id || 'no-id';
        console.log(`[OAuth] Row ${tenantLabel} has no tokens. Searching siblings for location ${tenant.ghl_location_id}...`);

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
    }

    if (!tenant.ghl_refresh_token || preferSiblingSmsToken) {
        const tenantLabel = tenant.id || 'no-id';
        if (!tenant.ghl_refresh_token) {
            console.log(`[OAuth] Row ${tenantLabel} has no tokens. Searching siblings for location ${tenant.ghl_location_id}...`);
        } else {
            console.log(`[OAuth] Forcing SMS token lookup to bypass GHL WhatsApp channel strictness for ${tenant.ghl_location_id}...`);
        }
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

        // Check WhatsApp tenants (including soft-deleted/inactive ones) if not found
        if (!siblingToken) {
            siblingToken = await whatsappDB.getWhatsappTokensByLocationId(tenant.ghl_location_id);
        }

        // If we found a sibling SMS token, use it! If not, fallback to whatever we have.
        if (siblingToken && siblingToken.ghl_refresh_token) {
            console.log(`[OAuth] Sibling tokens found! Inheriting into row ${tenantLabel}...`);
            tenant.ghl_access_token = siblingToken.ghl_access_token;
            tenant.ghl_refresh_token = siblingToken.ghl_refresh_token;
            tenant.ghl_token_expires_at = siblingToken.ghl_token_expires_at;

            // Persist them so future calls don't need to do the sibling lookup again
            // Only update if we have a valid tenant.id to target
            if (tenant.id) {
                await supabase.from(tableName).update({
                    ghl_access_token: siblingToken.ghl_access_token,
                    ghl_refresh_token: siblingToken.ghl_refresh_token,
                    ghl_token_expires_at: siblingToken.ghl_token_expires_at
                }).eq('id', tenant.id);
            }
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

        // Save refreshed tokens back — only if we have a valid row id
        if (tenant.id) {
            await supabase.from(tableName).update({
                ghl_access_token: res.data.access_token,
                ghl_refresh_token: res.data.refresh_token,
                ghl_token_expires_at: newExpiresAt
            }).eq('id', tenant.id);
        }

        tenant.ghl_access_token = res.data.access_token;
        tenant.ghl_refresh_token = res.data.refresh_token;
        console.log(`[OAuth] ✅ Token refreshed successfully for ${tenant.ghl_location_id}`);
    }

    return tenant.ghl_access_token;
}

/**
 * Searches GHL contacts using multiple phone-format strategies.
 * Returns the first matching contactId, or null.
 */
async function findContactByPhone(token, locationId, rawPhone) {
    // Strategy 1: Search with the full phone number as-is
    const searchVariants = [rawPhone];

    // Strategy 2: Digits-only (no +, no spaces, no dashes)
    const digitsOnly = rawPhone.replace(/\D/g, '');
    if (digitsOnly !== rawPhone.replace('+', '')) searchVariants.push(digitsOnly);

    // Strategy 3: Last 10 digits (strips country code for matching)
    if (digitsOnly.length > 10) {
        searchVariants.push(digitsOnly.slice(-10));
    }

    // Strategy 4: Last 9 digits (some countries use 9-digit local numbers)
    if (digitsOnly.length > 9) {
        searchVariants.push(digitsOnly.slice(-9));
    }

    for (const query of searchVariants) {
        try {
            console.log(`[GHL] Contact search attempt: query="${query}" for location ${locationId}`);
            const searchRes = await axios.get(
                `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent(query)}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Version': '2021-07-28',
                        'Accept': 'application/json'
                    }
                }
            );
            if (searchRes.data?.contacts?.length > 0) {
                const contact = searchRes.data.contacts[0];
                console.log(`[GHL] ✅ Contact FOUND: "${contact.firstName || ''} ${contact.lastName || ''}" (${contact.id}) via query="${query}"`);
                return contact;
            }
        } catch (e) {
            console.error(`[GHL] Search error for query="${query}":`, e?.response?.data || e.message);
        }
    }

    console.log(`[GHL] ❌ No existing contact found for ${rawPhone} after trying ${searchVariants.length} search variants`);
    return null;
}

/**
 * Pushes an inbound message reply into GoHighLevel's conversation inbox
 * Used for routing Android Gateway texts or WhatsApp back into GHL's UI natively
 */
async function pushInboundMessageToGHL(tenant, fromNumber, body, channelType = 'SMS', instanceId = null, mediaUrl = null, pushName = null) {
    try {
        const token = await getValidAccessToken(tenant);
        const convoTracker = require('./whatsappConversationTracker');

        let to_number = tenant.phone_number || tenant.whatsapp_phone_number;
        if (to_number && !to_number.startsWith('+')) to_number = '+' + to_number;
        
        let from_number = fromNumber;
        if (from_number && !from_number.startsWith('+')) from_number = '+' + from_number;

        console.log(`[GHL] pushInbound: from=${from_number}, to=${to_number}, type=${channelType}, instance=${instanceId}`);

        let contactId = null;
        let conversationId = null;

        // ── Step 1: Check conversation tracker (by phone AND by instance) ─────
        const tracked = convoTracker.lookupInbound(from_number, instanceId);
        if (tracked) {
            contactId = tracked.contactId;
            conversationId = tracked.conversationId;
            console.log(`[GHL] ✅ Conversation tracker matched! contactId=${contactId}, convId=${conversationId}`);
        }

        // ── Step 2: If no tracker match, search GHL contacts by phone ─────────
        if (!contactId) {
            console.log(`[GHL] No tracker match. Searching GHL contacts for ${from_number}...`);
            const contact = await findContactByPhone(token, tenant.ghl_location_id, from_number);
            contactId = contact ? contact.id : null;
        }

        // ── Step 3: Only create a new contact as absolute last resort ─────────
        if (!contactId) {
            console.log(`[GHL] No existing contact matched. Creating new contact for ${from_number}...`);
            try {
                const createRes = await axios.post(
                    `https://services.leadconnectorhq.com/contacts/`,
                    {
                        locationId: tenant.ghl_location_id,
                        phone: from_number,
                        firstName: pushName ? pushName.split(' ')[0] : from_number,
                        lastName: pushName && pushName.includes(' ') ? pushName.split(' ').slice(1).join(' ') : ''
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
                    console.log(`[GHL] Created new contact: ${contactId}`);
                }
            } catch (createErr) {
                // If creation fails with "duplicate", the contact already exists — try to extract the ID
                const errData = createErr?.response?.data;
                console.error('[GHL] Contact creation error:', errData || createErr.message);
                if (errData?.meta?.contactId) {
                    contactId = errData.meta.contactId;
                    console.log(`[GHL] Recovered duplicate contactId from error response: ${contactId}`);
                }
            }
        }

        // ── Step 4: Push the inbound message ──────────────────────────────────
        const payload = {
            type: channelType,
            message: body
        };

        // If we have a conversationId from the tracker, use it — this guarantees
        // the reply lands in the EXACT same conversation thread in GHL.
        if (conversationId) {
            payload.conversationId = conversationId;
        }

        if (contactId) {
            payload.contactId = contactId;
        }

        // Always include to/from for GHL's routing
        payload.to = to_number;
        payload.from = from_number;

        // Include media attachments if present
        if (mediaUrl) {
            payload.attachments = [mediaUrl];
        }

        console.log(`[GHL] Posting inbound message:`, JSON.stringify(payload));

        try {
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
        } catch (postError) {
            const errMsg = postError?.response?.data?.message || '';

            // ── Retry: Stale conversation (deleted in GHL) ──────────────────
            // If the tracker pointed to a deleted conversation, clear it and
            // retry without the conversationId so GHL creates a fresh one.
            if (errMsg.includes('not found') || errMsg.includes('deleted')) {
                console.warn(`[GHL] ⚠️ Stale conversation detected: "${errMsg}". Clearing tracker and retrying...`);

                // Clear the stale entry from the conversation tracker
                if (conversationId) {
                    convoTracker.clearByPhone(from_number);
                }

                // Retry without conversationId
                delete payload.conversationId;
                console.log(`[GHL] Retrying inbound message (no conversationId):`, JSON.stringify(payload));

                const retryResponse = await axios.post(
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

                return retryResponse.data;
            }

            // Not a stale conversation error — rethrow
            throw postError;
        }
    } catch (error) {
        console.error('Error posting inbound message to GHL:', error?.response?.data || error.message);
        throw error;
    }
}

/**
 * Fetch all users for a given location.
 */
async function getUsers(locationId) {
    try {
        const token = await getValidAccessToken({ ghl_location_id: locationId });
        const response = await axios.get(
            `https://services.leadconnectorhq.com/users/?locationId=${locationId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Version': '2021-07-28',
                    'Accept': 'application/json'
                }
            }
        );
        return response.data.users || [];
    } catch (error) {
        console.error('[GHL] Error fetching users:', error?.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    pushInboundMessageToGHL,
    getValidAccessToken,
    findContactByPhone,
    getUsers
};
