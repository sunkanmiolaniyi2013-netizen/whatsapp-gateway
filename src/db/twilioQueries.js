const supabase = require('./supabase');

// ─── Twilio Tenant CRUD ───────────────────────────────────────────────────────

async function getAllTwilioTenants() {
    const { data, error } = await supabase.from('twilio_tenants').select('*').order('created_at', { ascending: false });
    if (error) console.error('Error fetching Twilio tenants:', error);
    return data || [];
}

async function getTwilioTenantByLocationId(locationId) {
    const { data } = await supabase
        .from('twilio_tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('is_active', true)
        .limit(1)
        .single();
    return data || null;
}

async function getTwilioTenantByPhone(twilioPhone) {
    // Normalise and match the last 9 digits to handle +1 vs 1 vs 001 variants
    const { data } = await supabase
        .from('twilio_tenants')
        .select('*')
        .eq('is_active', true);

    if (!data) return null;
    const clean = str => str.replace(/\D/g, '');
    return data.find(t => clean(t.phone_number).slice(-9) === clean(twilioPhone).slice(-9)) || null;
}

// ─── OAuth Token Management (mirrors Android tenant pattern) ─────────────────

async function updateTwilioTenantOAuthTokens(locationId, accessToken, refreshToken, expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const { data, error } = await supabase
        .from('twilio_tenants')
        .update({
            ghl_access_token: accessToken,
            ghl_refresh_token: refreshToken,
            ghl_token_expires_at: expiresAt
        })
        .eq('ghl_location_id', locationId)
        .select();
    if (error) console.error('Error saving Twilio OAuth tokens:', error);
    return data ? data[0] : null;
}

// ─── Logging (reuses shared log table) ────────────────────────────────────────

async function logTwilioEvent(event, tenantId = null, payload = null) {
    await supabase.from('logs').insert([{ tenant_id: tenantId, event, payload }]);
}

async function logTwilioMessage({ tenant_id, direction, from_number, to_number, body, ghl_conversation_id, status }) {
    const { error } = await supabase.from('messages').insert([{
        tenant_id, direction, from_number, to_number, body, ghl_conversation_id, status
    }]);
    if (error) console.error('Error logging Twilio message:', error);
}

module.exports = {
    getAllTwilioTenants,
    getTwilioTenantByLocationId,
    getTwilioTenantByPhone,
    updateTwilioTenantOAuthTokens,
    logTwilioEvent,
    logTwilioMessage
};
