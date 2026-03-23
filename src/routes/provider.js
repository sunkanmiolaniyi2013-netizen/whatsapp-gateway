const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const smsGateway = require('../services/smsGateway');

/**
 * Endpoint for GoHighLevel Conversation Provider: Send Message
 * Called when a user types in GHL UI and clicks standard "Send"
 */
router.post('/send-message', async (req, res) => {
    try {
        const payload = req.body;
        await db.logEvent('provider_send_message_received', null, payload);

        const locationId = payload.locationId;
        const toNumber = payload.phone;
        const body = payload.message;
        const messageId = payload.messageId; 

        console.log(`[Provider] Send request for location: ${locationId}, to: ${toNumber}`);

        if (!locationId || !toNumber || !body) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        const tenant = await db.getTenantByLocationId(locationId);
        if (!tenant) {
            console.error(`[Provider] Tenant NOT FOUND for locationId: ${locationId}`);
            await db.logEvent('provider_tenant_not_found', null, { locationId });
            return res.status(404).json({ success: false, message: "Tenant not found for location: " + locationId });
        }

        console.log(`[Provider] Found tenant: ${tenant.business_name}, has_refresh_token: ${!!tenant.ghl_refresh_token}`);

        // Send via Gateway
        console.log(`[Provider] Sending via gateway to ${toNumber}...`);
        const result = await smsGateway.sendSmsViaGateway(tenant, toNumber, body);
        console.log(`[Provider] Gateway result:`, result?.state);

        // Report success back to GHL native API so the bubble turns green/blue!
        const axios = require('axios');
        const ghlService = require('../services/ghl');
        try {
            const token = await ghlService.getValidAccessToken(tenant);
            await axios.put(`https://services.leadconnectorhq.com/conversations/messages/${messageId}/status`, {
                status: "delivered"
            }, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Version': '2021-04-15',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });
            console.log(`[Provider] Delivery status updated for messageId: ${messageId}`);
        } catch (statusError) {
             console.error("[Provider] Failed to update delivery status:", statusError.response?.data || statusError.message);
        }

        // Log it
        await db.logMessage({
            tenant_id: tenant.id,
            direction: 'outbound',
            from_number: tenant.phone_number,
            to_number: toNumber,
            body: body,
            ghl_conversation_id: payload.conversationId,
            status: 'sent'
        });

        return res.status(200).json({ success: true, messageId: messageId });
    } catch (error) {
        console.error('[Provider] CRASH:', error.response?.data || error.message, error.stack);
        await db.logEvent('provider_send_error', null, { error: error.response?.data || error.message });
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
