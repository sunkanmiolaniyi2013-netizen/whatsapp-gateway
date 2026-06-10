const supabase = require('./supabase');

async function getWhatsappTenantsByLocationId(locationId) {
    const { data } = await supabase
        .from('whatsapp_tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('is_active', true);
    return data || [];
}

async function getWhatsappTenantByExactPhone(locationId, phone) {
    const { data } = await supabase
        .from('whatsapp_tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('whatsapp_phone_number', phone)
        .eq('is_active', true)
        .limit(1)
        .single();
    return data;
}

async function getWhatsappTenantByInstanceId(instanceId) {
    const { data } = await supabase
        .from('whatsapp_tenants')
        .select('*')
        .eq('whatsapp_instance_id', instanceId)
        .eq('is_active', true)
        .limit(1)
        .single();
    return data;
}

async function addWhatsappTenant(payload) {
    const { data, error } = await supabase.from('whatsapp_tenants').insert([payload]).select();
    if (error) throw error;
    return data[0];
}

async function getAllWhatsappTenants() {
    const { data, error } = await supabase.from('whatsapp_tenants').select('*');
    if (error) console.error('Error fetching all whatsapp tenants:', error);
    return data || [];
}

async function updateWhatsappTenantPhone(instanceId, phone) {
    const { data, error } = await supabase
        .from('whatsapp_tenants')
        .update({ whatsapp_phone_number: phone })
        .eq('whatsapp_instance_id', instanceId)
        .select();
    if (error) console.error('Error updating phone for tenant:', error);
    return data ? data[0] : null;
}

async function updateWhatsappTenantOAuthTokens(locationId, accessToken, refreshToken, expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const { data, error } = await supabase
        .from('whatsapp_tenants')
        .update({
            ghl_access_token: accessToken,
            ghl_refresh_token: refreshToken,
            ghl_token_expires_at: expiresAt
        })
        .eq('ghl_location_id', locationId)
        .select();

    if (error) {
        console.error('Error updating WhatsApp OAuth tokens:', error);
        throw error;
    }
    return data;
}

async function deleteWhatsappTenant(id) {
    const { error } = await supabase
        .from('whatsapp_tenants')
        .delete()
        .eq('id', id);
    if (error) throw error;
    return true;
}

module.exports = {
    getWhatsappTenantsByLocationId,
    getWhatsappTenantByExactPhone,
    getWhatsappTenantByInstanceId,
    addWhatsappTenant,
    getAllWhatsappTenants,
    updateWhatsappTenantPhone,
    updateWhatsappTenantOAuthTokens,
    deleteWhatsappTenant
};
