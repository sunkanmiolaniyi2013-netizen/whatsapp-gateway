const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../db/supabase');
const { requireAdmin } = require('../middleware/auth');

// Protect all admin routes
router.use(requireAdmin);

// 1. Get all tenants
router.get('/tenants', async (req, res) => {
    const { data, error } = await supabase.from('tenants').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. Add a new tenant (Business)
router.post('/tenants', async (req, res) => {
    const { business_name, ghl_location_id, ghl_api_key, phone_number, gateway_device_id, gateway_api_key, gateway_base_url, sim_number } = req.body;
    
    // Basic validation (ghl_api_key is now optional - OAuth handles authentication)
    if (!business_name || !ghl_location_id || !phone_number || !gateway_base_url) {
        return res.status(400).json({ error: 'Missing required tenant fields' });
    }

    const { data, error } = await supabase.from('tenants').insert([{
        business_name,
        ghl_location_id,
        ghl_api_key,
        phone_number,
        gateway_device_id: gateway_device_id || 'default',
        gateway_api_key: gateway_api_key || '',
        gateway_base_url,
        sim_number: sim_number ? parseInt(sim_number) : null,
        is_active: true
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });
    
    // Auto-Handshake: Automatically map the Incoming Webhook to the Cloud Server!
    if (gateway_base_url && gateway_base_url.includes('sms-gate.app') && gateway_api_key) {
        try {
            await axios.post(
                'https://api.sms-gate.app/3rdparty/v1/webhooks',
                { url: 'https://sms-gateway-middleware-production.up.railway.app/webhooks/sms-inbound', event: 'sms:received' },
                { headers: { 'Authorization': gateway_api_key, 'Content-Type': 'application/json' } }
            );
            console.log(`[Admin] Successfully securely auto-registered Webhook for new Phone!`);
        } catch (whError) {
            console.error(`[Admin] Warning: Auto-Handshake to sms-gate.app failed. Webhook might already exist.`, whError?.response?.data || whError.message);
        }
    }

    res.status(201).json(data);
});

// 3. Update active status or Edit config
router.put('/tenants/:id', async (req, res) => {
    const updates = { ...req.body };
    delete updates.id; // safeguard
    if (updates.sim_number !== undefined) {
        updates.sim_number = updates.sim_number ? parseInt(updates.sim_number) : null;
    }

    const { data, error } = await supabase.from('tenants')
        .update(updates)
        .eq('id', req.params.id)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 4. Delete tenant securely
router.delete('/tenants/:id', async (req, res) => {
    const tenantId = req.params.id;

    // A. Fetch tenant to get its phone_number
    const { data: tenant, error: fetchErr } = await supabase.from('tenants').select('phone_number').eq('id', tenantId).single();
    if (fetchErr || !tenant) return res.status(404).json({ error: 'Tenant not found' });

    // B. Safely cascade delete messages and logs to satisfy Foreign Key constraints
    await supabase.from('logs').delete().eq('tenant_id', tenantId);
    await supabase.from('messages').delete().eq('tenant_id', tenantId);

    // C. Wipe sticky_routes tying conversations to this physical number (releasing the number)
    await supabase.from('sticky_routes').delete().eq('gateway_phone', tenant.phone_number);

    // D. Safe to delete tenant
    const { error: delErr } = await supabase.from('tenants').delete().eq('id', tenantId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    
    res.json({ success: true });
});

module.exports = router;
