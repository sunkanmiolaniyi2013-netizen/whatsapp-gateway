const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const whatsappDB = require('../db/whatsappQueries');
const whatsappGateway = require('../services/whatsappGateway');
const ghlService = require('../services/ghl');

// ─── 1. Provider Send Route (For GHL Custom Provider / Webhook) ───────────────
router.post('/provider/send-message', async (req, res) => {
    try {
        const payload = req.body;
        const locationId = payload.locationId;
        const toNumber = payload.phone;
        const body = payload.message;
        const messageId = payload.messageId; // optional if from custom provider

        if (!locationId || !toNumber || !body) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        // Fetch all active WhatsApp tenants for this location
        const tenants = await whatsappDB.getWhatsappTenantsByLocationId(locationId);
        if (!tenants || tenants.length === 0) {
            return res.status(404).json({ success: false, message: 'No active WhatsApp tenant found for this location' });
        }

        // Very basic load balancing/round-robin or just pick the first one.
        // For now, we pick the first available one or one matching the country code.
        const tenant = tenants[0]; // TODO: Implement number pooling logic here if needed

        const result = await whatsappGateway.sendWhatsappMessage(tenant, toNumber, body);

        // Log the message history in the central messages table
        await db.logMessage({
            tenant_id: tenant.id, // note: foreign key might be tied to generic tenants, but it's UUID
            direction: 'outbound',
            from_number: tenant.whatsapp_phone_number,
            to_number: toNumber,
            body,
            ghl_conversation_id: payload.conversationId || null,
            status: 'sent'
        });

        return res.status(200).json({ success: true, messageId, result });
    } catch (error) {
        console.error('[WhatsApp Route] Send Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 2. Inbound Webhooks from Evolution API ──────────────────────────────────
router.post('/webhooks/inbound', async (req, res) => {
    try {
        const event = req.body;
        
        // Evolution API usually sends event type (e.g., 'messages.upsert')
        if (event.event !== 'messages.upsert' && !event.data) {
            return res.status(200).send('Ignored event type');
        }

        const instanceId = event.instance;
        const messages = event.data?.messages || [];
        
        if (!instanceId || messages.length === 0) {
            return res.status(200).send('No message content');
        }

        // Find the tenant that owns this instance
        const tenant = await whatsappDB.getWhatsappTenantByInstanceId(instanceId);
        if (!tenant) {
            console.error(`[WhatsApp Webhook] Unknown instance ID: ${instanceId}`);
            return res.status(404).send('Tenant not found');
        }

        for (const msg of messages) {
            // Ignore messages sent BY the business
            if (msg.key?.fromMe) continue;
            
            const fromNumber = '+' + msg.key.remoteJid.split('@')[0]; // convert 1234@s.whatsapp.net to +1234
            
            // Extract text from Evolution API message types
            const body = msg.message?.conversation || 
                         msg.message?.extendedTextMessage?.text || 
                         "*(Media/Unsupported Message)*";

            console.log(`[WhatsApp Inbound] Message from ${fromNumber} to ${tenant.whatsapp_phone_number}`);

            // Log it
            await db.logMessage({
                tenant_id: tenant.id,
                direction: 'inbound',
                from_number: fromNumber,
                to_number: tenant.whatsapp_phone_number,
                body: body,
                status: 'received'
            });

            // Push to GHL
            await ghlService.pushInboundMessageToGHL(tenant, fromNumber, body, 'WhatsApp');
        }

        return res.status(200).send('OK');
    } catch (error) {
        console.error('[WhatsApp Webhook] Error:', error);
        return res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
