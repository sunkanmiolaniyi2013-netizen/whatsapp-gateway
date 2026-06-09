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
app.use('/whatsapp', whatsappRoutes);
app.use('/api/whatsapp-admin', whatsappAdminRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Start Server
app.listen(config.PORT, () => {
    console.log(`🚀 SMS Gateway Middleware running on port ${config.PORT}`);
    console.log(`👉 Health check: http://localhost:${config.PORT}/health`);

    // Proactive OAuth token refresh — runs every 12 hours so tokens never
    // expire during periods of inactivity (e.g. weekends, holidays).
    // Also runs immediately on boot to rescue any tokens that expired during downtime.
    const { startTokenRefreshJob } = require('./services/tokenRefreshJob');
    startTokenRefreshJob();
});

