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

module.exports = {
    getWhatsappTenantsByLocationId,
    getWhatsappTenantByExactPhone,
    getWhatsappTenantByInstanceId,
    addWhatsappTenant,
    getAllWhatsappTenants
};
