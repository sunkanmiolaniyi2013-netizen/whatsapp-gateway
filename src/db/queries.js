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
    // Standardize phone string slightly, looking for mostly matched ends
    // Gateway app usually passes local format or international. 
    // Best practice: store 'phone_number' in DB exactly as Android app receives emails/texts.
    const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('is_active', true);
        
    if (error || !data) return null;
    
    // Simple matching: find if the incoming phone ends with the tenant phone, or vice versa
    for (const tenant of data) {
        const tPhone = tenant.phone_number.replace(/\D/g, '');
        const iPhone = phoneStr.replace(/\D/g, '');
        // E.g., match last 9 digits to ignore country code quirks
        if (tPhone.slice(-9) === iPhone.slice(-9)) {
            return tenant;
        }
    }
    return null;
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

module.exports = {
    getTenantByLocationId,
    getTenantByPhonePattern,
    logMessage,
    logEvent
};
