require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 3000,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'development-secret-key-change-me',
};
