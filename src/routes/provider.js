const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db/queries');
const smsGateway = require('../services/smsGateway');
const smarterRouter = require('../services/router');
const twilioDB = require('../db/twilioQueries');
const ghlService = require('../services/ghl');
const config = require('../config');

// ─── Country-First Routing Configuration ─────────────────────────────────────
//
// TWILIO_PRIMARY_COUNTRIES: Destination numbers starting with these prefixes
// are routed DIRECTLY to Twilio — they never touch the Android gateway.
//
// To add UK later: push '+44' into this array.
//
const TWILIO_PRIMARY_COUNTRIES = ['+1']; // US only for now

// ─── Main Send Route ──────────────────────────────────────────────────────────
router.post('/send-message', async (req, res) => {
    try {
        const payload = req.body;
        const locationId = payload.locationId;
        const toNumber   = payload.phone;
        const body       = payload.message;
        const messageId  = payload.messageId;

        console.log(`[Provider] Send request — location: ${locationId}, to: ${toNumber}`);

        if (!locationId || !toNumber || !body) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        await db.logEvent('provider_send_message_received', null, payload);

        const port = config.PORT || process.env.PORT || 3000;

        // ── TIER 0: Explicit WhatsApp Routing ────────────────────────────────
        // If GHL specifies the channel as 'whatsapp', bypass SMS tiers completely
        // and send directly to the WhatsApp routes.
        if (payload.channel === 'whatsapp') {
            console.log(`[Provider] TIER 0 — Explicit WhatsApp channel requested. Routing to WhatsApp.`);
            try {
                const response = await axios.post(
                    `http://localhost:${port}/whatsapp/provider/send-message`,
                    req.body
                );
                return res.status(response.status).json(response.data);
            } catch (waErr) {
                console.error('[Provider] WhatsApp routing error:', waErr.response?.data || waErr.message);
                return res.status(waErr.response?.status || 500).json(
                    waErr.response?.data || { success: false, error: waErr.message }
                );
            }
        }

        // ── TIER 1: Twilio-Primary Countries ─────────────────────────────────
        // Destination is US (+1) or any other country we've designated as
        // Twilio-primary → send straight to Twilio.
        // determineTwilioNumber() inside twilioRoutes already handles picking
        // the correct Twilio number by country code (US number → US contact,
        // UK number → UK contact, etc.) plus sticky routing + load balancing.
        const isTwilioPrimary = TWILIO_PRIMARY_COUNTRIES.some(prefix => toNumber.startsWith(prefix));

        if (isTwilioPrimary) {
            console.log(`[Provider] TIER 1 — ${toNumber} is a Twilio-primary country. Routing to Twilio.`);
            try {
                const response = await axios.post(
                    `http://localhost:${port}/twilio/provider/send-message`,
                    req.body
                );
                return res.status(response.status).json(response.data);
            } catch (twilioErr) {
                console.error('[Provider] Twilio primary routing error:', twilioErr.response?.data || twilioErr.message);
                return res.status(twilioErr.response?.status || 500).json(
                    twilioErr.response?.data || { success: false, error: twilioErr.message }
                );
            }
        }

        // ── TIER 2: Android Gateway (country-matched) ─────────────────────────
        // Check if we have an Android phone for this location that matches the
        // destination country code. If yes, let the Android smart router handle
        // it (sticky routing + country-code pool + load balancing — all intact).
        const hasAndroidCoverage = await db.hasAndroidCoverageForCountry(locationId, toNumber);

        if (hasAndroidCoverage) {
            console.log(`[Provider] TIER 2 — Android coverage found for country of ${toNumber}. Routing to Android gateway.`);

            const tenant = await smarterRouter.determineGatewayNumber(locationId, toNumber);
            if (!tenant) {
                console.error(`[Provider] Tenant NOT FOUND for locationId: ${locationId}`);
                await db.logEvent('provider_tenant_not_found', null, { locationId });
                return res.status(404).json({ success: false, message: 'No active gateway phone found for location: ' + locationId });
            }

            console.log(`[Provider] Found tenant: ${tenant.business_name}`);
            const result = await smsGateway.sendSmsViaGateway(tenant, toNumber, body);
            console.log(`[Provider] Android gateway result:`, result?.state);

            // Mark delivered in GHL so the bubble turns green
            if (messageId) {
                try {
                    const token = await ghlService.getValidAccessToken(tenant);
                    await axios.put(
                        `https://services.leadconnectorhq.com/conversations/messages/${messageId}/status`,
                        { status: 'delivered' },
                        {
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Version': '2021-04-15',
                                'Content-Type': 'application/json',
                                'Accept': 'application/json'
                            }
                        }
                    );
                    console.log(`[Provider] Delivery status updated for messageId: ${messageId}`);
                } catch (statusError) {
                    console.error('[Provider] Failed to update delivery status:', statusError.response?.data || statusError.message);
                }
            }

            await db.logMessage({
                tenant_id: tenant.id,
                direction: 'outbound',
                from_number: tenant.phone_number,
                to_number: toNumber,
                body,
                ghl_conversation_id: payload.conversationId,
                status: 'sent'
            });

            return res.status(200).json({ success: true, messageId });
        }

        // ── TIER 3: Twilio Fallback (no Android coverage for this country) ────
        // The destination country has no Android phone configured.
        // Try Twilio as a universal fallback — determineTwilioNumber() will
        // still do its best to pick a matching Twilio number by country prefix.
        console.log(`[Provider] TIER 3 — No Android coverage for country of ${toNumber}. Attempting Twilio fallback.`);

        const twilioTenants = await twilioDB.getTwilioTenantsByLocationId(locationId);
        if (twilioTenants && twilioTenants.length > 0) {
            console.log(`[Provider] Twilio fallback available for location ${locationId}. Forwarding.`);
            try {
                const response = await axios.post(
                    `http://localhost:${port}/twilio/provider/send-message`,
                    req.body
                );
                return res.status(response.status).json(response.data);
            } catch (twilioErr) {
                console.error('[Provider] Twilio fallback error:', twilioErr.response?.data || twilioErr.message);
                return res.status(twilioErr.response?.status || 500).json(
                    twilioErr.response?.data || { success: false, error: twilioErr.message }
                );
            }
        }

        // ── TIER 4: No coverage at all ────────────────────────────────────────
        console.error(`[Provider] No gateway (Android or Twilio) available for ${toNumber} in location ${locationId}`);
        await db.logEvent('provider_no_coverage', null, { locationId, toNumber });
        return res.status(404).json({
            success: false,
            message: `No gateway configured for this destination country. Add an Android phone or Twilio number for this region.`
        });

    } catch (error) {
        console.error('[Provider] CRASH:', error.response?.data || error.message, error.stack);
        await db.logEvent('provider_send_error', null, { error: error.response?.data || error.message });
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
