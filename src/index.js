const express = require('express');
const cors = require('cors');
const config = require('./config');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static admin dashboard
app.use(express.static('public'));

// Routes
const webhooksRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const oauthRoutes = require('./routes/oauth');
const providerRoutes = require('./routes/provider');
// Twilio (additive — zero impact on existing routes)
const twilioRoutes = require('./routes/twilioRoutes');
const twilioAdminRoutes = require('./routes/twilioAdmin');
// WhatsApp Bridge
const whatsappRoutes = require('./routes/whatsappRoutes');
const whatsappAdminRoutes = require('./routes/whatsappAdmin');

// Register routes
app.use('/webhooks', webhooksRoutes);
app.use('/api/admin', adminRoutes);
app.use('/oauth', oauthRoutes);
app.use('/provider', providerRoutes);
// Twilio routes (new — additive only)
app.use('/twilio', twilioRoutes);
app.use('/api/twilio-admin', twilioAdminRoutes);
// WhatsApp routes
app.use('/whatsapp', require('./routes/whatsappRoutes'));
app.use('/api/whatsapp-admin', whatsappAdminRoutes);
app.use('/debug-logs', require('./routes/debug'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Start Server
app.listen(config.PORT, async () => {
    console.log(`🚀 SMS Gateway Middleware running on port ${config.PORT}`);
    console.log(`👉 Health check: http://localhost:${config.PORT}/health`);

    // Proactive OAuth token refresh
    const { startTokenRefreshJob } = require('./services/tokenRefreshJob');
    startTokenRefreshJob();

    // ── WhatsApp Baileys: Register Global Inbound Message Handler ──────────────
    // When a WhatsApp message is received, push it into GHL as an inbound message.
    const wa = require('./services/whatsappBailey');
    const whatsappDB = require('./db/whatsappQueries');
    const ghlService = require('./services/ghl');
    const db = require('./db/queries');

    wa.setMessageHandler(async (instanceId, fromNumber, body) => {
        try {
            const tenant = await whatsappDB.getWhatsappTenantByInstanceId(instanceId);
            if (!tenant) return;
            await db.logMessage({
                tenant_id: tenant.id,
                direction: 'inbound',
                from_number: fromNumber,
                to_number: tenant.whatsapp_phone_number,
                body,
                status: 'received'
            });
            const finalBody = `[WhatsApp] ${body}`;
            await ghlService.pushInboundMessageToGHL(tenant, fromNumber, finalBody, 'SMS');
            console.log(`[WhatsApp] Forwarded inbound ${fromNumber} → GHL for ${tenant.business_name}`);
        } catch (e) {
            console.error('[WhatsApp] Inbound handler error:', e.message);
            await db.logMessage({
                tenant_id: tenant.id || null,
                direction: 'error',
                from_number: 'SYSTEM',
                to_number: 'GHL_API',
                body: JSON.stringify(e?.response?.data || e.message),
                status: 'failed'
            });
        }
    });

    // ── Restore active WhatsApp sessions on boot ───────────────────────────────
    // Any number that was connected before a redeploy will automatically reconnect.
    try {
        const activeTenants = await whatsappDB.getAllWhatsappTenants();
        for (const tenant of activeTenants) {
            if (tenant.is_active && tenant.whatsapp_instance_id) {
                console.log(`[WhatsApp] Restoring session: ${tenant.whatsapp_instance_id}`);
                wa.startSession(tenant.whatsapp_instance_id, {
                    onConnected: (phone) => console.log(`[WhatsApp] ✅ Restored: ${tenant.business_name} (${phone})`),
                    onDisconnected: () => console.log(`[WhatsApp] ❌ Disconnected: ${tenant.whatsapp_instance_id}`)
                }).catch(() => {}); // Non-blocking — will prompt re-scan if auth files gone
            }
        }
    } catch (e) {
        console.error('[WhatsApp] Session restore error:', e.message);
    }
});
