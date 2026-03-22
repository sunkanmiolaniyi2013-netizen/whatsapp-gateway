const express = require('express');
const router = express.Router();
const gatewayRouter = require('../services/router');
const db = require('../db/queries');

// Route 1: GHL triggers this to send an SMS out
router.post('/ghl-outbound', async (req, res) => {
    try {
        const payload = req.body;
        await db.logEvent('webhook_ghl_received', null, payload);
        
        const result = await gatewayRouter.handleGhlOutbound(payload);
        res.status(200).json(result);
    } catch (error) {
        console.error('GHL Outbound Webhook Error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// Route 2: Android Phone triggers this when an SMS is received
router.post('/sms-inbound', async (req, res) => {
    try {
        const payload = req.body;
        await db.logEvent('webhook_gateway_received', null, payload);
        
        const result = await gatewayRouter.handleSmsInbound(payload);
        res.status(200).json(result);
    } catch (error) {
        console.error('Gateway Inbound Webhook Error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

module.exports = router;
