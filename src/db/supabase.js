const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('⚠️  Supabase environment variables are missing. Database queries will fail.');
}

const supabase = createClient(
    config.SUPABASE_URL || 'https://placeholder.supabase.co',
    config.SUPABASE_SERVICE_ROLE_KEY || 'placeholder'
);

module.exports = supabase;
