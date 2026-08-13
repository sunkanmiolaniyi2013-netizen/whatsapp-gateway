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
// Returns 200 IMMEDIATELY so GHL never times out.
// Actual routing + sending happens asynchronously in the background.
router.post('/provider/send-message', async (req, res) => {
    const payload = req.body;
    const locationId = payload.locationId;
    const toNumber = payload.phone;
    const messageId = payload.messageId;

    console.log('[WhatsApp Route] Outbound Payload received:', JSON.stringify(payload, null, 2));

    if (!locationId || !toNumber) {
        return res.status(400).json({ success: false, message: 'Missing locationId or phone' });
    }

    // ── Return 200 immediately — GHL will NEVER timeout ──
    res.status(200).json({ success: true, messageId, status: 'queued' });

    // ── Process asynchronously in the background ──
    processWhatsappSend(payload).catch(err => {
        console.error('[WhatsApp Async] Unhandled background error:', err.message);
    });
});

/**
 * Updates a GHL message's delivery status.
 * Called after async processing completes (success or failure).
 */
async function updateGhlMessageStatus(locationId, messageId, status) {
    if (!messageId) return;
    try {
        const token = await ghlService.getValidAccessToken({ ghl_location_id: locationId });
        await axios.put(
            `https://services.leadconnectorhq.com/conversations/messages/${messageId}/status`,
            { status },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Version': '2021-04-15',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        console.log(`[WhatsApp Async] ✅ GHL status updated: ${messageId} → ${status}`);
    } catch (e) {
        console.error(`[WhatsApp Async] Failed to update GHL status for ${messageId}:`, e.response?.data || e.message);
    }
}

/**
 * Background async processor for WhatsApp outbound messages.
 * Takes as long as needed — no timeout pressure from GHL.
 * Handles: tenant routing → socket reconnection → retries → GHL status update.
 */
async function processWhatsappSend(payload) {
    const locationId = payload.locationId;
    const toNumber = payload.phone;
    const body = payload.message;
    const messageId = payload.messageId;
    const attachments = payload.attachments || [];

    try {
        // ── Step 1: Find active WhatsApp tenants ──
        const tenants = await whatsappDB.getWhatsappTenantsByLocationId(locationId);
        if (!tenants || tenants.length === 0) {
            console.error(`[WhatsApp Async] No active tenant for location ${locationId}`);
            await updateGhlMessageStatus(locationId, messageId, 'failed');
            return;
        }

        // ── Step 2: Route to the correct tenant (assigned user → sticky → round robin) ──
        let tenant = null;

        try {
            // Check if contact has an assigned user
            const token = await ghlService.getValidAccessToken({ ghl_location_id: locationId });
            const contact = await ghlService.findContactByPhone(token, locationId, toNumber);

            if (contact && contact.assignedTo) {
                const assignedTenant = tenants.find(t => t.ghl_assigned_user_id === contact.assignedTo);
                if (assignedTenant) {
                    tenant = assignedTenant;
                    console.log(`[WhatsApp Async] Assigned Routing: ${toNumber} → user ${contact.assignedTo} → instance ${tenant.whatsapp_instance_id}`);
                }
            }
        } catch (e) {
            console.error(`[WhatsApp Async] Assigned routing lookup failed (non-fatal): ${e.message}`);
        }

        // Sticky routing fallback
        if (!tenant) {
            const tracked = convoTracker.lookupInbound(toNumber, null);
            if (tracked && tracked.instanceId) {
                const stickyTenant = tenants.find(t => t.whatsapp_instance_id === tracked.instanceId);
                if (stickyTenant) {
                    tenant = stickyTenant;
                    console.log(`[WhatsApp Async] Sticky Routing: ${toNumber} → instance ${tenant.whatsapp_instance_id}`);
                }
            }
        }

        // Round robin fallback
        if (!tenant) {
            const genericTenants = tenants.filter(t => !t.ghl_assigned_user_id);
            const pool = genericTenants.length > 0 ? genericTenants : tenants;
            const randomIndex = Math.floor(Math.random() * pool.length);
            tenant = pool[randomIndex];
            console.log(`[WhatsApp Async] Round Robin: ${toNumber} → instance ${tenant.whatsapp_instance_id}`);
        }

        const instanceId = tenant.whatsapp_instance_id;

        // ── Step 3: Send with retries (no time pressure — we have unlimited time) ──
        const MAX_SEND_ATTEMPTS = 5;
        const BASE_RETRY_DELAY_MS = 2000; // Exponential: 2s, 4s, 8s, 16s, 32s (~62s total)
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
            let currentStatus = wa.getStatus(instanceId);

            // If socket is not open, trigger reconnection and wait
            if (currentStatus !== 'open') {
                console.log(`[WhatsApp Async] Attempt ${attempt}/${MAX_SEND_ATTEMPTS}: Instance ${instanceId} status='${currentStatus}'. Restoring session...`);
                wa.startSession(instanceId, { onConnected: () => {}, onDisconnected: () => {} }).catch(() => {});

                // Poll for connection to open (up to 10 seconds per attempt)
                for (let poll = 0; poll < 20; poll++) {
                    await new Promise(r => setTimeout(r, 500));
                    currentStatus = wa.getStatus(instanceId);
                    if (currentStatus === 'open') break;
                }
            }

            if (currentStatus === 'open') {
                try {
                    await wa.sendMessage(instanceId, toNumber, body, attachments);

                    // ── Success! Track conversation + log + update GHL status ──
                    convoTracker.trackOutbound({
                        toNumber,
                        contactId: payload.contactId || null,
                        conversationId: payload.conversationId || null,
                        locationId,
                        instanceId
                    });

                    await db.logMessage({
                        tenant_id: tenant.id,
                        direction: 'outbound',
                        from_number: tenant.whatsapp_phone_number,
                        to_number: toNumber,
                        body,
                        ghl_conversation_id: payload.conversationId || null,
                        status: 'sent'
                    });

                    console.log(`[WhatsApp Async] ✅ Sent to ${toNumber} (attempt ${attempt})`);
                    await updateGhlMessageStatus(locationId, messageId, 'delivered');
                    return; // Done!
                } catch (sendErr) {
                    console.warn(`[WhatsApp Async] Attempt ${attempt}/${MAX_SEND_ATTEMPTS} send error: ${sendErr.message}`);
                    lastError = sendErr;
                }
            } else {
                console.warn(`[WhatsApp Async] Attempt ${attempt}/${MAX_SEND_ATTEMPTS}: Session not open (status: ${currentStatus})`);
                lastError = new Error(`WhatsApp instance status: ${currentStatus}`);
            }

            // Wait before next attempt (exponential backoff)
            if (attempt < MAX_SEND_ATTEMPTS) {
                const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                console.log(`[WhatsApp Async] Waiting ${delay}ms before attempt ${attempt + 1}...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        // ── All attempts exhausted ──
        console.error(`[WhatsApp Async] ❌ All ${MAX_SEND_ATTEMPTS} attempts failed for ${toNumber} on instance ${instanceId}`);
        await updateGhlMessageStatus(locationId, messageId, 'failed');

        await db.logMessage({
            tenant_id: tenant.id,
            direction: 'outbound',
            from_number: tenant.whatsapp_phone_number,
            to_number: toNumber,
            body,
            ghl_conversation_id: payload.conversationId || null,
            status: 'failed'
        });

    } catch (error) {
        console.error('[WhatsApp Async] Background processing error:', error.message);
        await updateGhlMessageStatus(locationId, messageId, 'failed');
    }
}

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

// Check status using location_id (with optional user_id for staff isolation)
router.get('/setup/status', async (req, res) => {
    try {
        const { location_id, user_id } = req.query;
        if (!location_id) return res.status(400).json({ error: 'Missing location_id' });

        // Verify if tenant exists
        let tenants = await whatsappDB.getWhatsappTenantsByLocationId(location_id);
        if (!tenants || tenants.length === 0) {
            return res.json({ devices: [] });
        }

        // Staff Isolation: If user_id is provided, filter to show only this user's assigned device(s)
        if (user_id) {
            const userTenants = tenants.filter(t => t.ghl_assigned_user_id === user_id);
            if (userTenants.length > 0) {
                tenants = userTenants;
            } else {
                // If user has no device assigned yet, check for an unassigned tenant or show empty
                const unassignedTenants = tenants.filter(t => !t.ghl_assigned_user_id);
                if (unassignedTenants.length > 0) {
                    tenants = [unassignedTenants[0]];
                } else {
                    tenants = [];
                }
            }
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
        const { location_id, user_id, forceNew, instance_id } = req.body;
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
                ghl_assigned_user_id: user_id || null,
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
            // Pick tenant assigned to user_id, or unassigned, or default to first tenant
            if (user_id) {
                tenant = tenants.find(t => t.ghl_assigned_user_id === user_id) || tenants.find(t => !t.ghl_assigned_user_id) || tenants[0];
            } else {
                tenant = tenants[0];
            }
        }

        const instanceToStart = tenant.whatsapp_instance_id;
        
        // Auto-assign to user_id if provided and not yet assigned
        if (user_id && !tenant.ghl_assigned_user_id) {
            await whatsappDB.assignWhatsappTenantUser(instanceToStart, user_id);
        }

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
