const express = require('express');
const router = express.Router();
const twilioDB = require('../db/twilioQueries');
const twilioService = require('../services/twilioService');
const ghlService = require('../services/ghl');
const axios = require('axios');

// ─── Smart Twilio Router ──────────────────────────────────────────────────────
// Mirrors the Android determineGatewayNumber() logic — sticky routing + country
// code matching + load balancing. Supports multiple Twilio numbers per location.

async function determineTwilioNumber(locationId, contactPhone) {
    console.log(`[Twilio Router] Determining number for location ${locationId}, contact: ${contactPhone}`);

    // 1. Check for existing sticky route (never break an active conversation)
    const existingRoute = await twilioDB.getTwilioStickyRoute(locationId, contactPhone);
    if (existingRoute) {
        console.log(`[Twilio Router] Sticky route found → ${existingRoute.gateway_phone}`);
        const tenant = await twilioDB.getTwilioTenantByExactPhone(locationId, existingRoute.gateway_phone);
        if (tenant && tenant.is_active) return tenant;
        console.log(`[Twilio Router] Sticky number ${existingRoute.gateway_phone} is inactive. Falling back.`);
    }

    // 2. Fetch all active Twilio numbers for this location
    const activeTenants = await twilioDB.getTwilioTenantsByLocationId(locationId);
    if (!activeTenants || activeTenants.length === 0) {
        console.error(`[Twilio Router] FATAL: No active Twilio numbers for location ${locationId}`);
        return null;
    }

    // If only one number, use it directly
    if (activeTenants.length === 1) {
        const chosen = activeTenants[0];
        console.log(`[Twilio Router] Only 1 Twilio number. Using ${chosen.phone_number}`);
        await twilioDB.saveTwilioStickyRoute(locationId, contactPhone, chosen.phone_number);
        return chosen;
    }

    // 3. Country code prefix matching (US number for US leads, UK for UK leads, etc.)
    console.log(`[Twilio Router] Multiple numbers detected. Attempting country code match...`);
    let longestPrefixMatch = 0;
    let candidates = [];

    for (const tenant of activeTenants) {
        const gwPhone = tenant.phone_number;
        let matchLen = 0;
        for (let i = 0; i < Math.min(contactPhone.length, gwPhone.length); i++) {
            if (contactPhone[i] === gwPhone[i]) matchLen++;
            else break;
        }
        if (matchLen >= 2) {
            if (matchLen > longestPrefixMatch) {
                longestPrefixMatch = matchLen;
                candidates = [tenant];
            } else if (matchLen === longestPrefixMatch) {
                candidates.push(tenant);
            }
        }
    }

    const pool = candidates.length > 0 ? candidates : activeTenants;

    // 4. Load balance within the matched pool (least used in last hour wins)
    let chosenTenant;
    if (pool.length === 1) {
        chosenTenant = pool[0];
        console.log(`[Twilio Router] 1 candidate after country match. Using ${chosenTenant.phone_number}`);
    } else {
        console.log(`[Twilio Router] Load balancing across ${pool.length} numbers...`);
        const volumes = await twilioDB.getTwilioTenantVolumes(pool.map(t => t.id));
        chosenTenant = pool.reduce((best, cur) => volumes[cur.id] < volumes[best.id] ? cur : best, pool[0]);
        console.log(`[Twilio Router] Selected ${chosenTenant.phone_number} (${volumes[chosenTenant.id]} msgs in last hour)`);
    }

    // Lock in the sticky route
    await twilioDB.saveTwilioStickyRoute(locationId, contactPhone, chosenTenant.phone_number);
    return chosenTenant;
}

// ─── Route 1: GHL Custom SMS Provider → Send via Twilio ──────────────────────
// Configure in GHL: https://your-railway.app/twilio/provider/send-message
router.post('/provider/send-message', async (req, res) => {
    try {
        const { locationId, phone: toNumber, message: body, messageId } = req.body;
        await twilioDB.logTwilioEvent('twilio_provider_send_received', null, req.body);

        if (!locationId || !toNumber || !body) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Smart routing: sticky + country match + load balance
        const tenant = await determineTwilioNumber(locationId, toNumber);
        if (!tenant) {
            console.error(`[Twilio Provider] No tenant for locationId: ${locationId}`);
            await twilioDB.logTwilioEvent('twilio_tenant_not_found', null, { locationId });
            return res.status(404).json({ success: false, message: 'No Twilio number configured for this location' });
        }

        console.log(`[Twilio Provider] Sending from ${tenant.phone_number} to ${toNumber}`);
        const result = await twilioService.sendSmsViaTwilio(tenant, toNumber, body);

        // Update GHL delivery status so the bubble turns green
        if (messageId) {
            try {
                const token = await ghlService.getValidAccessToken(tenant);
                await axios.put(
                    `https://services.leadconnectorhq.com/conversations/messages/${messageId}/status`,
                    { status: 'delivered' },
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            Version: '2021-04-15',
                            'Content-Type': 'application/json',
                            Accept: 'application/json'
                        }
                    }
                );
            } catch (statusErr) {
                console.error('[Twilio Provider] Failed to update GHL delivery status:', statusErr.response?.data || statusErr.message);
            }
        }

        await twilioDB.logTwilioMessage({
            tenant_id: tenant.id,
            direction: 'outbound',
            from_number: tenant.phone_number,
            to_number: toNumber,
            body,
            ghl_conversation_id: req.body.conversationId || null,
            status: 'sent'
        });

        return res.status(200).json({ success: true, messageSid: result.sid });
    } catch (error) {
        console.error('[Twilio Provider] CRASH:', error.response?.data || error.message);
        await twilioDB.logTwilioEvent('twilio_provider_send_error', null, { error: error.message });
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Route 2: Twilio Webhook → Push inbound reply to GHL ─────────────────────
// Paste in Twilio Console → Phone Numbers → Messaging Webhook:
// https://your-railway.app/twilio/inbound
router.post('/inbound', (req, res) => {
    // Respond instantly with empty TwiML so Twilio doesn't retry
    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

    setImmediate(async () => {
        try {
            const { From: sender, To: recipient, Body: body, MessageSid: messageSid } = req.body;
            console.log(`[Twilio Inbound] Reply from ${sender} to ${recipient}: "${body}"`);

            await twilioDB.logTwilioEvent('twilio_inbound_received', null, { sender, recipient, body, messageSid });

            // Step 1: Try sticky route first (who owns this conversation?)
            let tenant = await twilioDB.getTwilioTenantByStickyInbound(sender, recipient);

            // Step 2: Fallback — find any active tenant with that Twilio number
            if (!tenant) {
                console.log(`[Twilio Inbound] No sticky route for ${sender} → ${recipient}. Falling back to phone match.`);
                tenant = await twilioDB.getTwilioTenantByPhone(recipient);
            }

            if (!tenant) {
                console.warn(`[Twilio Inbound] No tenant owns Twilio number ${recipient}. Ignoring.`);
                await twilioDB.logTwilioEvent('twilio_inbound_ignored', null, { sender, recipient });
                return;
            }

            // Push the inbound reply into GHL Conversations
            await ghlService.pushInboundMessageToGHL(tenant, sender, body);
            console.log(`[Twilio Inbound] ✅ Reply from ${sender} pushed to GHL location ${tenant.ghl_location_id}`);
        } catch (error) {
            console.error('[Twilio Inbound] Error:', error.response?.data || error.message);
            await twilioDB.logTwilioEvent('twilio_inbound_error', null, { error: error.response?.data || error.message });
        }
    });
});

module.exports = router;
