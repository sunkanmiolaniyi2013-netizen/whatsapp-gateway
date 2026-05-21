const supabase = require('./supabase');

// ─── Twilio Tenant CRUD ───────────────────────────────────────────────────────

async function getAllTwilioTenants() {
    const { data, error } = await supabase.from('twilio_tenants').select('*').order('created_at', { ascending: false });
    if (error) console.error('Error fetching Twilio tenants:', error);
    return data || [];
}

/**
 * Returns ALL active Twilio numbers for a given GHL location.
 * Used by the sticky router to load-balance across multiple numbers.
 */
async function getTwilioTenantsByLocationId(locationId) {
    const { data } = await supabase
        .from('twilio_tenants')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('is_active', true);
    return data || [];
}

/**
 * Returns one specific Twilio number that matches both the location AND phone.
 */
async function getTwilioTenantByExactPhone(locationId, twilioPhone) {
    const clean = str => str.replace(/\D/g, '');
    const all = await getTwilioTenantsByLocationId(locationId);
    return all.find(t => clean(t.phone_number).slice(-9) === clean(twilioPhone).slice(-9)) || null;
}

/**
 * Inbound: find the tenant that owns a specific Twilio receiving number.
 * First tries sticky_routes (conversation owner), then falls back to phone match.
 */
async function getTwilioTenantByStickyInbound(contactPhone, twilioRecipient) {
    // 1. Check sticky_routes for existing conversation
    const { data: route } = await supabase
        .from('sticky_routes')
        .select('ghl_location_id')
        .eq('contact_phone', contactPhone)
        .eq('gateway_phone', twilioRecipient)
        .limit(1)
        .single();

    if (route) {
        return await getTwilioTenantByExactPhone(route.ghl_location_id, twilioRecipient);
    }
    return null;
}

/**
 * Fallback inbound: find any active tenant whose Twilio number matches recipient.
 */
async function getTwilioTenantByPhone(twilioPhone) {
    const { data } = await supabase.from('twilio_tenants').select('*').eq('is_active', true);
    if (!data) return null;
    const clean = str => str.replace(/\D/g, '');
    return data.find(t => clean(t.phone_number).slice(-9) === clean(twilioPhone).slice(-9)) || null;
}

// ─── Sticky Route Helpers (share the same sticky_routes table as Android) ─────

async function getTwilioStickyRoute(locationId, contactPhone) {
    const { data } = await supabase
        .from('sticky_routes')
        .select('*')
        .eq('ghl_location_id', locationId)
        .eq('contact_phone', contactPhone)
        .limit(1)
        .single();
    return data || null;
}

async function saveTwilioStickyRoute(locationId, contactPhone, twilioPhone) {
    const { error } = await supabase.from('sticky_routes').upsert(
        { ghl_location_id: locationId, contact_phone: contactPhone, gateway_phone: twilioPhone },
        { onConflict: 'ghl_location_id,contact_phone' }
    );
    if (error) console.error('Error saving Twilio sticky route:', error);
}

// ─── Volume / Load Balancing ──────────────────────────────────────────────────

async function getTwilioTenantVolumes(tenantIds) {
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
    if (error) { console.error('Error fetching Twilio volumes:', error); return counts; }
    if (data) data.forEach(row => counts[row.tenant_id]++);
    return counts;
}

// ─── OAuth Token Management ───────────────────────────────────────────────────

async function updateTwilioTenantOAuthTokens(locationId, accessToken, refreshToken, expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const { data, error } = await supabase
        .from('twilio_tenants')
        .update({ ghl_access_token: accessToken, ghl_refresh_token: refreshToken, ghl_token_expires_at: expiresAt })
        .eq('ghl_location_id', locationId)
        .select();
    if (error) console.error('Error saving Twilio OAuth tokens:', error);
    return data ? data[0] : null;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

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
    getTwilioTenantsByLocationId,
    getTwilioTenantByExactPhone,
    getTwilioTenantByPhone,
    getTwilioTenantByStickyInbound,
    getTwilioStickyRoute,
    saveTwilioStickyRoute,
    getTwilioTenantVolumes,
    updateTwilioTenantOAuthTokens,
    logTwilioEvent,
    logTwilioMessage
};
