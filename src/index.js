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

// Register routes
app.use('/webhooks', webhooksRoutes);
app.use('/api/admin', adminRoutes);
app.use('/oauth', oauthRoutes);
app.use('/provider', providerRoutes);
// Twilio routes (new — additive only)
app.use('/twilio', twilioRoutes);
app.use('/api/twilio-admin', twilioAdminRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Start Server
app.listen(config.PORT, () => {
    console.log(`🚀 SMS Gateway Middleware running on port ${config.PORT}`);
    console.log(`👉 Health check: http://localhost:${config.PORT}/health`);
});
