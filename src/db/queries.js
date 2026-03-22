const supabase = require('./supabase');

async function getTenantByLocationId(locationId) {
    const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('is_active', true)
        .single();
    
    if (error) {
        if (error.code !== 'PGRST116') console.error('Error fetching tenant by location ID:', error);
        return null;
    }
    return data;
}

async function getTenantByPhonePattern(phoneStr) {
    const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('is_active', true);
        
    if (error || !data) return null;
    
    for (const tenant of data) {
        const tPhone = tenant.phone_number.replace(/\D/g, '');
        const iPhone = phoneStr.replace(/\D/g, '');
        if (tPhone.slice(-9) === iPhone.slice(-9)) {
            return tenant;
        }
    }
    return null;
}

async function getAllTenants() {
    const { data, error } = await supabase.from('tenants').select('*');
    if (error) console.error('Error fetching all tenants:', error);
    return data || [];
}

async function addTenant(payload) {
    const { data, error } = await supabase.from('tenants').insert([payload]).select();
    if (error) throw error;
    return data[0];
}

async function logMessage(msgData) {
    const { tenant_id, direction, from_number, to_number, body, ghl_contact_id, ghl_conversation_id, status } = msgData;
    const { error } = await supabase
        .from('messages')
        .insert([{
            tenant_id,
            direction,
            from_number,
            to_number,
            body,
            ghl_contact_id,
            ghl_conversation_id,
            status
        }]);
    if (error) console.error('Error logging message:', error);
}

async function logEvent(event, tenant_id = null, payload = null, errorStr = null) {
    await supabase.from('logs').insert([{
        tenant_id,
        event,
        payload,
        error: errorStr
    }]);
}

async function updateTenantOAuthTokens(locationId, accessToken, refreshToken, expiresIn) {
    const expiresAt = new Date(Date.now() + (expiresIn * 1000));
    const { data, error } = await supabase
        .from('tenants')
        .update({
            // We'll store standard tokens here.
            ghl_access_token: accessToken,
            ghl_refresh_token: refreshToken,
            ghl_token_expires_at: expiresAt
        })
        .eq('ghl_location_id', locationId)
        .select()
        .single();
    if (error) console.error("Error saving OAuth tokens:", error);
    return data;
}

module.exports = {
    getTenantByLocationId,
    getTenantByPhonePattern,
    getAllTenants,
    addTenant,
    logMessage,
    logEvent,
    updateTenantOAuthTokens
};
