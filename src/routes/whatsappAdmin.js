const express = require('express');
const router = express.Router();
const whatsappDB = require('../db/whatsappQueries');
const { requireAdmin } = require('../middleware/auth');
const wa = require('../services/whatsappBailey');

// Protect all routes with the shared admin middleware (uses x-admin-key header)
router.use(requireAdmin);

// ── Tenant CRUD ───────────────────────────────────────────────────────────────

router.get('/tenants', async (req, res) => {
    try {
        const allTenants = await whatsappDB.getAllWhatsappTenants();
        // Only return active tenants (soft-deleted ones are hidden but preserve OAuth tokens)
        const tenants = allTenants.filter(t => t.is_active !== false);
        res.json(tenants);
    } catch (error) {
        console.error('Error fetching whatsapp tenants:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/register', async (req, res) => {
    try {
        const { business_name, ghl_location_id, ghl_api_key, whatsapp_phone_number, whatsapp_instance_id, whatsapp_api_key, whatsapp_base_url } = req.body;

        if (!business_name || !ghl_location_id || !whatsapp_phone_number || !whatsapp_instance_id) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const newTenant = await whatsappDB.addWhatsappTenant({
            business_name,
            ghl_location_id,
            ghl_api_key: ghl_api_key || null,
            whatsapp_phone_number,
            whatsapp_instance_id,
            whatsapp_api_key: whatsapp_api_key || 'built-in',
            whatsapp_base_url: whatsapp_base_url || 'built-in'
        });

        res.json({ success: true, tenant: newTenant });
    } catch (error) {
        console.error('Error registering whatsapp tenant:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

router.delete('/tenant/:id', async (req, res) => {
    try {
        // Look up the tenant first to get its instance_id for session cleanup
        const allTenants = await whatsappDB.getAllWhatsappTenants();
        const tenant = allTenants.find(t => t.id === req.params.id);

        // Disconnect the Baileys session so it disappears from memory immediately
        if (tenant && tenant.whatsapp_instance_id) {
            try {
                await wa.deleteSession(tenant.whatsapp_instance_id);
                console.log(`[WA Admin] Disconnected Baileys session: ${tenant.whatsapp_instance_id}`);
            } catch (e) {
                console.log(`[WA Admin] Session cleanup skipped (already gone): ${e.message}`);
            }
        }

        // Soft-delete the tenant row (preserves OAuth tokens for future numbers)
        await whatsappDB.deleteWhatsappTenant(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting whatsapp tenant:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

router.put('/tenant/:id', async (req, res) => {
    try {
        const { business_name, ghl_location_id, whatsapp_phone_number, ghl_api_key } = req.body;
        const updated = await whatsappDB.updateWhatsappTenant(req.params.id, {
            business_name,
            ghl_location_id,
            whatsapp_phone_number,
            ghl_api_key
        });
        res.json({ success: true, tenant: updated });
    } catch (error) {
        console.error('Error updating whatsapp tenant:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

// ── Built-in WhatsApp Bridge (Baileys) ────────────────────────────────────────
// No external Evolution API server required. Baileys handles everything in-process.

// Start a session and get QR code (waits up to 15s)
router.post('/bridge/start', async (req, res) => {
    const { instance_name } = req.body;
    if (!instance_name) return res.status(400).json({ error: 'instance_name is required' });

    const current = wa.getStatus(instance_name);
    if (current === 'open') {
        return res.json({ status: 'open', phone: wa.getPhone(instance_name) });
    }

    // Start session (async, non-blocking)
    wa.startSession(instance_name, {
        onConnected: (phone) => console.log(`[WA] ${instance_name} connected: ${phone}`),
        onDisconnected: () => console.log(`[WA] ${instance_name} disconnected`),
    });

    // Wait up to 15s for QR
    const qrBase64 = await wa.getQR(instance_name);
    if (qrBase64) return res.json({ status: 'qr', qr: qrBase64 });

    const newStatus = wa.getStatus(instance_name);
    res.json({ status: newStatus, phone: wa.getPhone(instance_name) });
});

// Refresh / get current QR
router.post('/bridge/get-qr', async (req, res) => {
    const { instance_name } = req.body;
    const status = wa.getStatus(instance_name);
    if (status === 'open') return res.json({ status: 'open', phone: wa.getPhone(instance_name) });
    const qrBase64 = await wa.getQR(instance_name);
    res.json({ status: qrBase64 ? 'qr' : status, qr: qrBase64 });
});

// Check status
router.post('/bridge/status', async (req, res) => {
    const { instance_name } = req.body;
    res.json({ status: wa.getStatus(instance_name), phone: wa.getPhone(instance_name) });
});

// Logout / delete session
router.delete('/bridge/:instanceId', async (req, res) => {
    await wa.deleteSession(req.params.instanceId);
    res.json({ success: true });
});

// List all sessions
router.get('/bridge/sessions', async (req, res) => {
    res.json(wa.listSessions());
});

module.exports = router;
