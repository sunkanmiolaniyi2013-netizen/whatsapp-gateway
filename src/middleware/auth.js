const config = require('../config');

function requireAdmin(req, res, next) {
    const providedKey = req.headers['x-admin-key'] || req.query.key;
    if (!providedKey || providedKey !== config.ADMIN_API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Invalid Admin API Key.' });
    }
    next();
}

module.exports = { requireAdmin };
