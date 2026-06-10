const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const whatsappDB = require('../db/whatsappQueries');
const wa = require('../services/whatsappBailey');
const ghlService = require('../services/ghl');
const axios = require('axios');

// ─── 1. Provider Send Route (For GHL Custom Provider) ───────────────────────
router.post('/provider/send-message', async (req, res) => {
    try {
        const payload = req.body;
        const locationId = payload.locationId;
        const toNumber = payload.phone;
        const body = payload.message;
        const messageId = payload.messageId;

        if (!locationId || !toNumber || !body) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        // Find active WhatsApp tenant for this GHL location
        const tenants = await whatsappDB.getWhatsappTenantsByLocationId(locationId);
        if (!tenants || tenants.length === 0) {
            return res.status(404).json({ success: false, message: 'No active WhatsApp tenant found for this location' });
        }
        const tenant = tenants[0];
        const instanceId = tenant.whatsapp_instance_id;

        // Ensure the Baileys session is running for this instance
        const status = wa.getStatus(instanceId);
        if (status !== 'open') {
            // Try to restore session
            await new Promise(resolve => {
                wa.startSession(instanceId, {
                    onConnected: resolve,
                    onDisconnected: () => {}
                });
                setTimeout(resolve, 5000); // Don't block more than 5s
            });
            if (wa.getStatus(instanceId) !== 'open') {
                return res.status(503).json({ success: false, message: 'WhatsApp session not connected. Please re-scan QR code.' });
            }
        }

        // Send via built-in Baileys bridge
        await wa.sendMessage(instanceId, toNumber, body);

        // Log the outbound message
        await db.logMessage({
            tenant_id: tenant.id,
            direction: 'outbound',
            from_number: tenant.whatsapp_phone_number,
            to_number: toNumber,
            body,
            ghl_conversation_id: payload.conversationId || null,
            status: 'sent'
        });

        return res.status(200).json({ success: true, messageId });
    } catch (error) {
        console.error('[WhatsApp Route] Send Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 2. Inbound Messages from Baileys (called internally by the session manager) ─
// This endpoint receives inbound WhatsApp messages and pushes them to GHL.
// It's called by registering a global message handler in whatsappBailey.js
router.post('/webhooks/inbound', async (req, res) => {
    try {
        const { instanceId, fromNumber, body: msgBody } = req.body;

        if (!instanceId || !fromNumber || !msgBody) {
            return res.status(200).send('Missing fields — ignored');
        }

        const tenant = await whatsappDB.getWhatsappTenantByInstanceId(instanceId);
        if (!tenant) {
            console.error(`[WhatsApp Inbound] Unknown instance: ${instanceId}`);
            return res.status(200).send('Tenant not found');
        }

        console.log(`[WhatsApp Inbound] ${fromNumber} → ${tenant.whatsapp_phone_number}`);

        await db.logMessage({
            tenant_id: tenant.id,
            direction: 'inbound',
            from_number: fromNumber,
            to_number: tenant.whatsapp_phone_number,
            body: msgBody,
            status: 'received'
        });

        await ghlService.pushInboundMessageToGHL(tenant, fromNumber, msgBody, 'WhatsApp');

        return res.status(200).send('OK');
    } catch (error) {
        console.error('[WhatsApp Inbound] Error:', error);
        return res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
