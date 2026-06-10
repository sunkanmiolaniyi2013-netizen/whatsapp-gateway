const express = require('express');
const router = express.Router();
const axios = require('axios');
const whatsappDB = require('../db/whatsappQueries');
const { requireAdmin } = require('../middleware/auth');

// Protect all routes with the shared admin middleware (uses x-admin-key header)
router.use(requireAdmin);

router.get('/tenants', async (req, res) => {
    try {
        const tenants = await whatsappDB.getAllWhatsappTenants();
        res.json(tenants);
    } catch (error) {
        console.error('Error fetching whatsapp tenants:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/register', async (req, res) => {
    try {
        const { business_name, ghl_location_id, ghl_api_key, whatsapp_phone_number, whatsapp_instance_id, whatsapp_api_key, whatsapp_base_url } = req.body;

        if (!business_name || !ghl_location_id || !whatsapp_phone_number || !whatsapp_instance_id || !whatsapp_api_key || !whatsapp_base_url) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const newTenant = await whatsappDB.addWhatsappTenant({
            business_name,
            ghl_location_id,
            ghl_api_key,
            whatsapp_phone_number,
            whatsapp_instance_id,
            whatsapp_api_key,
            whatsapp_base_url
        });

        res.json({ success: true, tenant: newTenant });
    } catch (error) {
        console.error('Error registering whatsapp tenant:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

// ── Evolution API Proxy Routes (avoids browser CORS issues) ──────────────────
// These routes forward requests from the browser to Evolution API server-to-server.

// Create a new Evolution API instance
router.post('/evo/create-instance', async (req, res) => {
    const { evo_url, evo_key, instance_name } = req.body;
    if (!evo_url || !evo_key || !instance_name) {
        return res.status(400).json({ error: 'Missing evo_url, evo_key, or instance_name' });
    }
    try {
        const response = await axios.post(
            `${evo_url.replace(/\/$/, '')}/instance/create`,
            { instanceName: instance_name, qrcode: true },
            { headers: { 'apikey': evo_key, 'Content-Type': 'application/json' } }
        );
        res.json(response.data);
    } catch (e) {
        res.status(e.response?.status || 500).json({
            error: e.response?.data?.message || e.response?.data?.error || e.message || 'Evolution API error'
        });
    }
});

// Set the inbound webhook on an Evolution API instance
router.post('/evo/set-webhook', async (req, res) => {
    const { evo_url, evo_key, instance_name, webhook_url } = req.body;
    try {
        const response = await axios.post(
            `${evo_url.replace(/\/$/, '')}/webhook/set/${instance_name}`,
            { url: webhook_url, enabled: true, events: ['MESSAGES_UPSERT'] },
            { headers: { 'apikey': evo_key, 'Content-Type': 'application/json' } }
        );
        res.json(response.data);
    } catch (e) {
        res.status(e.response?.status || 500).json({
            error: e.response?.data?.message || e.response?.data?.error || e.message || 'Evolution API error'
        });
    }
});

// Get QR code for an instance
router.post('/evo/get-qr', async (req, res) => {
    const { evo_url, evo_key, instance_name } = req.body;
    try {
        const response = await axios.get(
            `${evo_url.replace(/\/$/, '')}/instance/connect/${instance_name}`,
            { headers: { 'apikey': evo_key } }
        );
        res.json(response.data);
    } catch (e) {
        res.status(e.response?.status || 500).json({
            error: e.response?.data?.message || e.response?.data?.error || e.message || 'Evolution API error'
        });
    }
});

// Check connection status of an instance
router.post('/evo/check-status', async (req, res) => {
    const { evo_url, evo_key, instance_name } = req.body;
    try {
        const response = await axios.get(
            `${evo_url.replace(/\/$/, '')}/instance/fetchInstances`,
            { headers: { 'apikey': evo_key } }
        );
        const instances = Array.isArray(response.data) ? response.data : [];
        const instance = instances.find(i => i.instance?.instanceName === instance_name);
        res.json({ state: instance?.instance?.state || 'unknown' });
    } catch (e) {
        res.status(e.response?.status || 500).json({
            error: e.response?.data?.message || e.response?.data?.error || e.message || 'Evolution API error'
        });
    }
});

module.exports = router;
