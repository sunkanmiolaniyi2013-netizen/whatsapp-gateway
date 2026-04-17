const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const smsGateway = require('../services/smsGateway');
const smarterRouter = require('../services/router');
const twilioDB = require('../db/twilioQueries');
const twilioRoutes = require('./twilioRoutes'); // if we want to extract logic, but let's just write the inline check.

// Actually, let's keep it clean.
router.post('/send-message', async (req, res) => {
    try {
        const payload = req.body;
        const locationId = payload.locationId;
        const toNumber = payload.phone;
        const body = payload.message;
        const messageId = payload.messageId; 

        console.log(`[Provider] Send request for location: ${locationId}, to: ${toNumber}`);

        if (!locationId || !toNumber || !body) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        // --- NEW: Unified Routing ---
        // First check if this location has Twilio configured
        const twilioTenants = await twilioDB.getTwilioTenantsByLocationId(locationId);
        
        if (twilioTenants && twilioTenants.length > 0) {
            console.log(`[Provider] Unified Routing: Twilio configuration found for location ${locationId}. Forwarding internally.`);
            
            // Re-route the request internally to the Twilio handler
            // To do this simply, we can just make an internal call or use the router.
            // But since the logic is in twilioRoutes.js, let's just make an HTTP request to ourselves, or extract the logic.
            // Since this is Express, we can pass req to the other router if we wanted.
            
            // Let's just import the handler from twilioRoutes. Wait, twilioRoutes is a Router object. 
            // Better to do a quick axios call to the localhost twilio route to keep it completely decoupled.
            const axios = require('axios');
            try {
                const config = require('../config');
                const port = config.PORT || process.env.PORT || 3000;
                // Hit the local endpoint that already handles Twilio correctly
                const response = await axios.post(`http://localhost:${port}/twilio/provider/send-message`, req.body);
                return res.status(response.status).json(response.data);
            } catch (twilioErr) {
                console.error('[Provider] Internal Twilio routing error:', twilioErr.response?.data || twilioErr.message);
                return res.status(twilioErr.response?.status || 500).json(twilioErr.response?.data || { success: false, error: twilioErr.message });
            }
        }

        // --- FALLBACK: Existing Android Logic ---
        console.log(`[Provider] Unified Routing: No Twilio config found for location ${locationId}. Falling back to Android gateway.`);
        await db.logEvent('provider_send_message_received', null, payload);

        // Phase 3: Smart Routing (Country Code + Sticky Lock)
        const tenant = await smarterRouter.determineGatewayNumber(locationId, toNumber);
        
        if (!tenant) {
            console.error(`[Provider] Tenant NOT FOUND for locationId: ${locationId}`);
            await db.logEvent('provider_tenant_not_found', null, { locationId });
            return res.status(404).json({ success: false, message: "No active gateway phone found for location: " + locationId });
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
