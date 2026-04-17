const express = require('express');
const router = express.Router();
const twilioDB = require('../db/twilioQueries');
const twilioService = require('../services/twilioService');
const ghlService = require('../services/ghl');
const axios = require('axios');

// ─── Route 1: GHL Custom SMS Provider → Send via Twilio ──────────────────────
// Configure this URL in GHL: https://your-railway.app/twilio/provider/send-message
router.post('/provider/send-message', async (req, res) => {
    try {
        const { locationId, phone: toNumber, message: body, messageId } = req.body;
        await twilioDB.logTwilioEvent('twilio_provider_send_received', null, req.body);

        if (!locationId || !toNumber || !body) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Find the Twilio tenant for this GHL location
        const tenant = await twilioDB.getTwilioTenantByLocationId(locationId);
        if (!tenant) {
            console.error(`[Twilio Provider] No tenant for locationId: ${locationId}`);
            await twilioDB.logTwilioEvent('twilio_tenant_not_found', null, { locationId });
            return res.status(404).json({ success: false, message: 'No Twilio number configured for this location' });
        }

        console.log(`[Twilio Provider] Sending from ${tenant.phone_number} to ${toNumber}`);

        // Send via Twilio
        const result = await twilioService.sendSmsViaTwilio(tenant, toNumber, body);

        // Update delivery status in GHL so the bubble turns green
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
// Paste this URL in Twilio Console → Phone Numbers → Messaging Webhook
// https://your-railway.app/twilio/inbound
router.post('/inbound', async (req, res) => {
    // Respond to Twilio instantly with empty TwiML to stop retries
    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

    // Process asynchronously in background
    setImmediate(async () => {
        try {
            const { From: sender, To: recipient, Body: body, MessageSid: messageSid } = req.body;
            console.log(`[Twilio Inbound] Reply from ${sender} to ${recipient}: "${body}"`);

            await twilioDB.logTwilioEvent('twilio_inbound_received', null, { sender, recipient, body, messageSid });

            // Find which GHL location owns this Twilio number
            const tenant = await twilioDB.getTwilioTenantByPhone(recipient);
            if (!tenant) {
                console.warn(`[Twilio Inbound] No tenant found for Twilio number ${recipient} — ignoring`);
                return;
            }

            // Push the reply into GHL Conversations
            await ghlService.pushInboundMessageToGHL(tenant, sender, body);
            console.log(`[Twilio Inbound] ✅ Reply from ${sender} pushed to GHL for location ${tenant.ghl_location_id}`);
        } catch (error) {
            console.error('[Twilio Inbound] Error processing reply:', error.response?.data || error.message);
            await twilioDB.logTwilioEvent('twilio_inbound_error', null, { error: error.response?.data || error.message });
        }
    });
});

module.exports = router;
