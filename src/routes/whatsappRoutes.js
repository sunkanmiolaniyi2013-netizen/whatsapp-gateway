const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../db/queries');
const whatsappDB = require('../db/whatsappQueries');
const wa = require('../services/whatsappBailey');
const ghlService = require('../services/ghl');
const axios = require('axios');
const convoTracker = require('../services/whatsappConversationTracker');

router.get('/debug-db', async (req, res) => {
    try {
        const tenants = await whatsappDB.getAllWhatsappTenants();
        res.json({ tenants });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── 1. Provider Send Route (For GHL Custom Provider) ───────────────────────
router.post('/provider/send-message', async (req, res) => {
    try {
        const payload = req.body;
        const locationId = payload.locationId;
        const toNumber = payload.phone;
        const body = payload.message;
        const messageId = payload.messageId;
        console.log('[WhatsApp Route] Outbound Payload received:', JSON.stringify(payload, null, 2));

        if (!locationId || !toNumber) {
            return res.status(400).json({ success: false, message: 'Missing locationId or phone' });
        }

        // Find active WhatsApp tenant for this GHL location
        const tenants = await whatsappDB.getWhatsappTenantsByLocationId(locationId);
        if (!tenants || tenants.length === 0) {
            return res.status(404).json({ success: false, message: 'No active WhatsApp tenant found for this location' });
        }
        // ── ASSIGNED USER ROUTING ──
        let tenant = null;

        try {
            // Check if contact has an assigned user
            const token = await ghlService.getValidAccessToken({ ghl_location_id: locationId });
            const contact = await ghlService.findContactByPhone(token, locationId, toNumber);
            
            if (contact && contact.assignedTo) {
                // Find a WhatsApp tenant assigned to this specific GHL user
                const assignedTenant = tenants.find(t => t.ghl_assigned_user_id === contact.assignedTo);
                if (assignedTenant) {
                    tenant = assignedTenant;
                    console.log(`[Assigned Routing] Prospect ${toNumber} is assigned to user ${contact.assignedTo}. Selected instance ${tenant.whatsapp_instance_id}`);
                }
            }
        } catch (e) {
            console.error(`[Assigned Routing Error] Failed to fetch contact assignment: ${e.message}`);
        }

        // ── STICKY ROUTING & LOAD BALANCING (Fallback) ──
        if (!tenant) {
            // 1. Check if this prospect has a sticky connection to a specific instance
            const tracked = convoTracker.lookupInbound(toNumber, null);
            if (tracked && tracked.instanceId) {
                const stickyTenant = tenants.find(t => t.whatsapp_instance_id === tracked.instanceId);
                if (stickyTenant) {
                    tenant = stickyTenant;
                    console.log(`[Sticky Routing] Prospect ${toNumber} stuck to instance ${tenant.whatsapp_instance_id}`);
                }
            }

            // 2. If no sticky connection, pick a generic/unassigned tenant if possible, else random
            if (!tenant) {
                // Prefer tenants that are NOT assigned to specific users for generic load balancing
                const genericTenants = tenants.filter(t => !t.ghl_assigned_user_id);
                const pool = genericTenants.length > 0 ? genericTenants : tenants;
                
                const randomIndex = Math.floor(Math.random() * pool.length);
                tenant = pool[randomIndex];
                console.log(`[Round Robin] New prospect ${toNumber}, selected instance ${tenant.whatsapp_instance_id}`);
            }
        }

        const instanceId = tenant.whatsapp_instance_id;

        // Ensure the Baileys session is running for this instance
        let currentStatus = wa.getStatus(instanceId);
        if (currentStatus !== 'open') {
            console.log(`[WhatsApp Route] Instance ${instanceId} status is '${currentStatus}'. Attempting reconnection/restore...`);
            // Trigger session restore
            wa.startSession(instanceId, { onConnected: () => {}, onDisconnected: () => {} }).catch(() => {});
            
            // Poll for up to 12 seconds (24 intervals of 500ms) for connection to open
            const maxAttempts = 24;
            for (let i = 0; i < maxAttempts; i++) {
                await new Promise(r => setTimeout(r, 500));
                currentStatus = wa.getStatus(instanceId);
                if (currentStatus === 'open') {
                    console.log(`[WhatsApp Route] Session ${instanceId} re-connected successfully after ${(i + 1) * 500}ms`);
                    break;
                }
            }

            if (wa.getStatus(instanceId) !== 'open') {
                console.warn(`[WhatsApp Route] Session ${instanceId} failed to open within 12s (status: ${wa.getStatus(instanceId)})`);
                return res.status(503).json({
                    success: false,
                    isWhatsappError: true,
                    message: 'WhatsApp session is re-connecting. Please retry sending in a few seconds.'
                });
            }
        }

        // Send via built-in Baileys bridge (supports text + media attachments)
        const attachments = payload.attachments || [];
        await wa.sendMessage(instanceId, toNumber, body, attachments);

        // ── Track this conversation for inbound reply matching ────────────
        convoTracker.trackOutbound({
            toNumber,
            contactId: payload.contactId || null,
            conversationId: payload.conversationId || null,
            locationId,
            instanceId
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

        await ghlService.pushInboundMessageToGHL(tenant, fromNumber, msgBody, 'SMS', instanceId);

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
            return res.json({ devices: [] });
        }

        const devices = [];
        for (const tenant of tenants) {
            const status = wa.getStatus(tenant.whatsapp_instance_id);
            const phone = wa.getPhone(tenant.whatsapp_instance_id);
            let qr = null;
            if (status !== 'open') {
                qr = await wa.getQR(tenant.whatsapp_instance_id);
            }
            devices.push({
                id: tenant.id,
                instance_id: tenant.whatsapp_instance_id,
                status: qr ? 'qr' : status,
                phone: phone || tenant.whatsapp_phone_number,
                qr,
                ghl_assigned_user_id: tenant.ghl_assigned_user_id
            });
        }

        res.json({ devices });
    } catch (error) {
        console.error('[WhatsApp Setup] Status Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start session / Generate QR
router.post('/setup/start', async (req, res) => {
    try {
        const { location_id, forceNew, instance_id } = req.body;
        if (!location_id) return res.status(400).json({ error: 'Missing location_id' });

        // We check if OAuth tokens exist for this location to verify they are a valid user
        let oauthTenant;
        try {
            await ghlService.getValidAccessToken({ ghl_location_id: location_id });
            oauthTenant = true;
        } catch (e) {
            return res.status(403).json({ error: 'OAuth setup not found. Please connect the app first.' });
        }

        const instance_name = `wa_${location_id.substring(0, 10)}_${Date.now()}`;
        
        let tenants = await whatsappDB.getWhatsappTenantsByLocationId(location_id);
        let tenant;
        
        if (instance_id) {
            // Reconnect specific instance
            tenant = tenants.find(t => t.whatsapp_instance_id === instance_id);
            if (!tenant) return res.status(404).json({ error: 'Instance not found' });
        } else if (forceNew || !tenants || tenants.length === 0) {
            // Clean up any stale 'pending' tenant rows for this location
            // to avoid UNIQUE constraint violations on whatsapp_phone_number
            if (tenants && tenants.length > 0) {
                for (const t of tenants) {
                    if (t.whatsapp_phone_number && t.whatsapp_phone_number.startsWith('pending')) {
                        console.log(`[WhatsApp Setup] Cleaning up stale pending tenant: ${t.id}`);
                        await whatsappDB.deleteWhatsappTenant(t.id);
                    }
                }
            }

            // Auto-create tenant placeholder with unique pending ID
            // Inherit OAuth tokens from any existing (even soft-deleted) row for this location
            const inheritedTokens = await whatsappDB.getWhatsappTokensByLocationId(location_id);
            tenant = await whatsappDB.addWhatsappTenant({
                business_name: `Location ${location_id} (Num ${tenants ? tenants.length + 1 : 1})`,
                ghl_location_id: location_id,
                whatsapp_phone_number: `pending_${Date.now()}`, // Unique to avoid UNIQUE constraint collisions
                whatsapp_instance_id: instance_name,
                whatsapp_api_key: 'built-in',
                whatsapp_base_url: 'built-in',
                ...(inheritedTokens ? {
                    ghl_access_token: inheritedTokens.ghl_access_token,
                    ghl_refresh_token: inheritedTokens.ghl_refresh_token,
                    ghl_token_expires_at: inheritedTokens.ghl_token_expires_at
                } : {})
            });
        } else {
            // Default to first tenant if nothing specified (for backwards compatibility)
            tenant = tenants[0];
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

// Get GHL Users for assigning
router.get('/setup/users', async (req, res) => {
    try {
        const { location_id } = req.query;
        if (!location_id) return res.status(400).json({ error: 'Missing location_id' });
        
        const users = await ghlService.getUsers(location_id);
        res.json({ users });
    } catch (error) {
        console.error('[WhatsApp Setup] Get Users Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Assign a WhatsApp Tenant to a specific GHL User
router.put('/setup/assign', async (req, res) => {
    try {
        const { instance_id, user_id } = req.body;
        if (!instance_id) return res.status(400).json({ error: 'Missing instance_id' });
        
        await whatsappDB.assignWhatsappTenantUser(instance_id, user_id);
        res.json({ success: true });
    } catch (error) {
        console.error('[WhatsApp Setup] Assign User Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
