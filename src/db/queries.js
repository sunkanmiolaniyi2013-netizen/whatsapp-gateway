const supabase = require('./supabase');

async function getTenantByLocationId(locationId) {
    const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('is_active', true)
        .limit(1)
        .single();
    
    if (error) {
        if (error.code !== 'PGRST116') console.error('Error fetching tenant by location ID:', error);
        return null;
    }
    return data;
}

// Phase 3: Fetch ALL active phones for a location (Number Pooling)
async function getTenantsByLocationId(locationId) {
    const { data } = await supabase
        .from('tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('is_active', true);
    return data || [];
}

// Phase 3: Fetch a SPECIFIC tenant physical phone for a location
async function getTenantByExactPhone(locationId, phone) {
    const { data } = await supabase
        .from('tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('phone_number', phone)
        .eq('is_active', true)
        .limit(1)
        .single();
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

/**
 * Phase 4 Load Balancing:
 * Counts the outbound messages sent by each provided tenant in the last 1 hour.
 */
async function getTenantVolumes(tenantIds) {
    if (!tenantIds || tenantIds.length === 0) return {};

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('messages')
        .select('tenant_id')
        .eq('direction', 'outbound')
        .in('tenant_id', tenantIds)
        .gte('created_at', oneHourAgo);

    const counts = {};
    tenantIds.forEach(id => counts[id] = 0);
    
    if (error) {
        console.error("Error fetching tenant volumes:", error);
        return counts;
    }

    if (data) {
        data.forEach(row => counts[row.tenant_id]++);
    }
    return counts;
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
        .select();
    if (error) console.error("Error saving OAuth tokens:", error);
    return data ? data[0] : null;
}

// Phase 3: Sticky Router Functions --------------------------

async function getStickyRoute(locationId, contactPhone) {
    const { data } = await supabase
        .from('sticky_routes')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('contact_phone', contactPhone)
        .limit(1)
        .single();
    return data || null;
}

async function saveStickyRoute(locationId, contactPhone, gatewayPhone) {
    // Upsert the route
    const { error } = await supabase
        .from('sticky_routes')
        .upsert(
            { ghl_location_id: locationId, contact_phone: contactPhone, gateway_phone: gatewayPhone },
            { onConflict: 'ghl_location_id,contact_phone' }
        );
    if (error) console.error("Error saving sticky route:", error);
}

/**
 * Phase 3 Inbound Multi-Tenancy Fix
 * Finds which Location ID owns the conversation mathematically
 */
async function getTenantByStickyInbound(contactPhone, gatewayPhone) {
    // 1. Ask sticky_routes: Who owns this conversation?
    const { data: route } = await supabase
        .from('sticky_routes')
        .select('ghl_location_id')
        .eq('contact_phone', contactPhone)
        .eq('gateway_phone', gatewayPhone)
        .limit(1)
        .single();
    
    if (route) {
        // 2. We found the owner! Fetch their specific tenant config
        return await getTenantByExactPhone(route.ghl_location_id, gatewayPhone);
    }
    return null; // No sticky route exists
}

/**
 * Pre-flight check: Does this location have ANY active Android phone
 * whose country code prefix matches the destination number?
 * Uses the same longest-prefix logic as determineGatewayNumber — but
 * does NOT create a sticky route. Just returns true/false.
 */
async function hasAndroidCoverageForCountry(locationId, contactPhone) {
    const { data } = await supabase
        .from('tenants')
        .select('phone_number')
        .eq('ghl_location_id', locationId)
        .eq('is_active', true);

    if (!data || data.length === 0) return false;

    for (const tenant of data) {
        const gwPhone = tenant.phone_number;
        let matchLen = 0;
        for (let i = 0; i < Math.min(contactPhone.length, gwPhone.length); i++) {
            if (contactPhone[i] === gwPhone[i]) matchLen++;
            else break;
        }
        // matchLen >= 2 means at least '+' and first country digit match (e.g. '+1', '+3')
        if (matchLen >= 2) return true;
    }
    return false;
}

module.exports = {
    getTenantByLocationId,
    getTenantsByLocationId,
    getTenantByExactPhone,
    getTenantByPhonePattern,
    getTenantByStickyInbound,
    getStickyRoute,
    saveStickyRoute,
    getTenantVolumes,
    getAllTenants,
    addTenant,
    logMessage,
    logEvent,
    updateTenantOAuthTokens,
    hasAndroidCoverageForCountry
};
