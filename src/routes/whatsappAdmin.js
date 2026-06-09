const express = require('express');
const router = express.Router();
const whatsappDB = require('../db/whatsappQueries');
const config = require('../config');

// Middleware to protect admin routes
router.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.ADMIN_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

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

module.exports = router;
