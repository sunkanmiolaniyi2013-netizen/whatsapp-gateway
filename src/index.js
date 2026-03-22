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
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
app.use('/webhooks', webhookRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Start Server
app.listen(config.PORT, () => {
    console.log(`🚀 SMS Gateway Middleware running on port ${config.PORT}`);
    console.log(`👉 Health check: http://localhost:${config.PORT}/health`);
});
