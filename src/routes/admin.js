const express = require('express');
const router = express.Router();
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
    const { business_name, ghl_location_id, ghl_api_key, phone_number, gateway_device_id, gateway_api_key, gateway_base_url } = req.body;
    
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
        is_active: true
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// 3. Update active status
router.put('/tenants/:id', async (req, res) => {
    const { is_active } = req.body;
    const { data, error } = await supabase.from('tenants')
        .update({ is_active })
        .eq('id', req.params.id)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 4. Delete tenant
router.delete('/tenants/:id', async (req, res) => {
    const { error } = await supabase.from('tenants').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

module.exports = router;
