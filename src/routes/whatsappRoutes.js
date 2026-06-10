const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../db/queries');
const whatsappDB = require('../db/whatsappQueries');
const wa = require('../services/whatsappBailey');
const ghlService = require('../services/ghl');
const axios = require('axios');
const convoTracker = require('../services/whatsappConversationTracker');

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

        // ── Track this conversation for inbound reply matching ────────────
        convoTracker.trackOutbound({
            toNumber,
            contactId: payload.contactId || null,
            conversationId: payload.conversationId || null,
            locationId
        });

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

        console.log(`[WhatsApp] Sent to ${toNumber} for contact ${payload.contactId || 'unknown'}`);
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

        const finalBody = `[WhatsApp] ${msgBody}`;
        await ghlService.pushInboundMessageToGHL(tenant, fromNumber, finalBody, 'SMS');

        return res.status(200).send('OK');
    } catch (error) {
        console.error('[WhatsApp Inbound] Error:', error);
        
        let tenantId = null;
        if (req.body && req.body.instanceId) {
            const t = await whatsappDB.getWhatsappTenantByInstanceId(req.body.instanceId);
            if (t) tenantId = t.id;
        }

        await db.logMessage({
            tenant_id: tenantId,
            direction: 'error',
            from_number: 'SYSTEM',
            to_number: 'GHL_API',
            body: JSON.stringify(error?.response?.data || error.message),
            status: 'failed'
        });
        
        return res.status(500).send('Internal Server Error');
    }
});

// ─── 3. Client-Facing SSO Routes (Custom Menu Link) ──────────────────────────

// Serve the UI page
router.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/whatsapp-user.html'));
});

// Check status using location_id
router.get('/setup/status', async (req, res) => {
    try {
        const { location_id } = req.query;
        if (!location_id) return res.status(400).json({ error: 'Missing location_id' });

        // Verify if tenant exists
        const tenants = await whatsappDB.getWhatsappTenantsByLocationId(location_id);
        if (!tenants || tenants.length === 0) {
            return res.status(404).json({ error: 'No setup found' });
        }

        const tenant = tenants[0];
        const status = wa.getStatus(tenant.whatsapp_instance_id);
        const phone = wa.getPhone(tenant.whatsapp_instance_id);
        
        let qr = null;
        if (status !== 'open') {
            qr = await wa.getQR(tenant.whatsapp_instance_id);
        }

        res.json({ status: qr ? 'qr' : status, phone, qr });
    } catch (error) {
        console.error('[WhatsApp Setup] Status Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start session / Generate QR
router.post('/setup/start', async (req, res) => {
    try {
        const { location_id } = req.body;
        if (!location_id) return res.status(400).json({ error: 'Missing location_id' });

        // We check if OAuth tokens exist for this location to verify they are a valid user
        let oauthTenant;
        try {
            // This throws if no valid token / location exists in the system
            await ghlService.getValidAccessToken({ ghl_location_id: location_id });
            oauthTenant = true;
        } catch (e) {
            return res.status(403).json({ error: 'OAuth setup not found. Please connect the app first.' });
        }

        const instance_name = `wa_${location_id.substring(0, 10)}_${Date.now()}`;
        
        let tenants = await whatsappDB.getWhatsappTenantsByLocationId(location_id);
        let tenant;
        
        if (!tenants || tenants.length === 0) {
            // Auto-create tenant placeholder
            tenant = await whatsappDB.addWhatsappTenant({
                business_name: `Location ${location_id}`,
                ghl_location_id: location_id,
                whatsapp_phone_number: 'pending', // Will update when connected
                whatsapp_instance_id: instance_name,
                whatsapp_api_key: 'built-in',
                whatsapp_base_url: 'built-in'
            });
        } else {
            tenant = tenants[0];
            // Start the existing instance
        }

        const instanceToStart = tenant.whatsapp_instance_id;
        
        const current = wa.getStatus(instanceToStart);
        if (current === 'open') {
            return res.json({ status: 'open', phone: wa.getPhone(instanceToStart) });
        }

        // Start session async
        wa.startSession(instanceToStart, {
            onConnected: async (phone) => {
                console.log(`[WA] Client ${location_id} connected: ${phone}`);
                await whatsappDB.updateWhatsappTenantPhone(instanceToStart, phone);
            },
            onDisconnected: () => console.log(`[WA] Client ${location_id} disconnected`),
        });

        // Wait up to 10s for QR
        const qrBase64 = await wa.getQR(instanceToStart);
        if (qrBase64) return res.json({ status: 'qr', qr: qrBase64 });

        res.json({ status: wa.getStatus(instanceToStart), phone: wa.getPhone(instanceToStart) });
    } catch (error) {
        console.error('[WhatsApp Setup] Start Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
