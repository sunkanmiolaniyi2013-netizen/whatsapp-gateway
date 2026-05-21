const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAdmin } = require('../middleware/auth');

// Protect all Twilio admin routes
router.use(requireAdmin);

// 1. Get all Twilio tenants
router.get('/tenants', async (req, res) => {
    const { data, error } = await supabase.from('twilio_tenants').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. Add a new Twilio tenant
router.post('/tenants', async (req, res) => {
    const { business_name, ghl_location_id, phone_number } = req.body;

    if (!business_name || !ghl_location_id || !phone_number) {
        return res.status(400).json({ error: 'business_name, ghl_location_id and phone_number are required' });
    }

    const { data, error } = await supabase.from('twilio_tenants').insert([{
        business_name,
        ghl_location_id,
        phone_number,
        is_active: true
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// 3. Edit a Twilio tenant
router.put('/tenants/:id', async (req, res) => {
    const updates = { ...req.body };
    delete updates.id;

    const { data, error } = await supabase.from('twilio_tenants')
        .update(updates)
        .eq('id', req.params.id)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 4. Delete a Twilio tenant (cascade safe)
router.delete('/tenants/:id', async (req, res) => {
    const tenantId = req.params.id;

    const { data: tenant, error: fetchErr } = await supabase
        .from('twilio_tenants').select('phone_number').eq('id', tenantId).single();
    if (fetchErr || !tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Cascade: remove messages and logs that reference this tenant
    await supabase.from('logs').delete().eq('tenant_id', tenantId);
    await supabase.from('messages').delete().eq('tenant_id', tenantId);

    const { error: delErr } = await supabase.from('twilio_tenants').delete().eq('id', tenantId);
    if (delErr) return res.status(500).json({ error: delErr.message });

    res.json({ success: true });
});

module.exports = router;
