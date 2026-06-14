const axios = require('axios');
const config = require('../config');
const supabase = require('../db/supabase');

// Run every 12 hours. GHL access tokens expire in 24h, so this keeps them
// always fresh even if no messages are sent for weeks.
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Refreshes the OAuth tokens for a single tenant row.
 * GHL rotates BOTH the access token and the refresh token on every call,
 * so we always save the new refresh token back to the database.
 */
async function refreshTenantToken(tableName, tenant) {
    if (!tenant.ghl_refresh_token) return;

    try {
        const formData = new URLSearchParams({
            client_id: config.GHL_CLIENT_ID,
            client_secret: config.GHL_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: tenant.ghl_refresh_token
        }).toString();

        const res = await axios.post(
            'https://services.leadconnectorhq.com/oauth/token',
            formData,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const newExpiresAt = new Date(Date.now() + res.data.expires_in * 1000);

        await supabase.from(tableName).update({
            ghl_access_token: res.data.access_token,
            ghl_refresh_token: res.data.refresh_token,
            ghl_token_expires_at: newExpiresAt
        }).eq('id', tenant.id);

        console.log(`[TokenJob] ✅ Refreshed token for location ${tenant.ghl_location_id} (${tableName} row ${tenant.id})`);
    } catch (err) {
        // Log but don't crash — one bad token shouldn't stop others from refreshing
        console.error(
            `[TokenJob] ❌ Failed to refresh token for location ${tenant.ghl_location_id} (${tableName} row ${tenant.id}):`,
            err.response?.data || err.message
        );
    }
}

/**
 * Runs one full refresh cycle across ALL active tenants in both tables.
 * Called on startup and then every 12 hours automatically.
 */
async function runRefreshCycle() {
    console.log('[TokenJob] 🔄 Starting proactive token refresh cycle...');

    if (!config.GHL_CLIENT_ID || !config.GHL_CLIENT_SECRET) {
        console.error(
            '[TokenJob] ❌ CRITICAL: GHL_CLIENT_ID or GHL_CLIENT_SECRET is not set in environment variables! ' +
            'Token refresh is disabled. Add these to your Railway/Render environment and redeploy.'
        );
        return;
    }

    // ── Android Tenants ────────────────────────────────────────────────────
    const { data: androidTenants, error: e1 } = await supabase
        .from('tenants')
        .select('id, ghl_location_id, ghl_refresh_token')
        .not('ghl_refresh_token', 'is', null)
        .eq('is_active', true);

    if (e1) console.error('[TokenJob] Error fetching Android tenants:', e1.message);

    for (const tenant of (androidTenants || [])) {
        await refreshTenantToken('tenants', tenant);
    }

    // ── Twilio Tenants ─────────────────────────────────────────────────────
    const { data: twilioTenants, error: e2 } = await supabase
        .from('twilio_tenants')
        .select('id, ghl_location_id, ghl_refresh_token')
        .not('ghl_refresh_token', 'is', null)
        .eq('is_active', true);

    if (e2) console.error('[TokenJob] Error fetching Twilio tenants:', e2.message);

    for (const tenant of (twilioTenants || [])) {
        await refreshTenantToken('twilio_tenants', tenant);
    }

    // ── WhatsApp Tenants ────────────────────────────────────────────────────
    const { data: whatsappTenants, error: e3 } = await supabase
        .from('whatsapp_tenants')
        .select('id, ghl_location_id, ghl_refresh_token')
        .not('ghl_refresh_token', 'is', null)
        .eq('is_active', true);

    if (e3) console.error('[TokenJob] Error fetching WhatsApp tenants:', e3.message);

    for (const tenant of (whatsappTenants || [])) {
        await refreshTenantToken('whatsapp_tenants', tenant);
    }

    const total = (androidTenants?.length || 0) + (twilioTenants?.length || 0) + (whatsappTenants?.length || 0);
    console.log(`[TokenJob] ✅ Refresh cycle complete. Processed ${total} tenant(s).`);
}

/**
 * Starts the background token refresh job.
 * Call once on server startup from index.js.
 *
 * - Runs immediately on boot (catches tokens that expired during downtime)
 * - Then runs every 12 hours automatically
 * - Tokens will NEVER expire from inactivity again
 */
function startTokenRefreshJob() {
    if (!config.GHL_CLIENT_ID || !config.GHL_CLIENT_SECRET) {
        console.error(
            '[TokenJob] ⚠️  GHL_CLIENT_ID or GHL_CLIENT_SECRET missing from environment. ' +
            'Proactive token refresh is DISABLED. Set these env vars in Railway/Render to enable it.'
        );
        return;
    }

    console.log('[TokenJob] 🚀 Proactive token refresh job started. Runs every 12 hours.');

    // Run immediately on boot — this is what rescues tokens that expired during downtime
    runRefreshCycle();

    // Schedule recurring runs
    setInterval(runRefreshCycle, REFRESH_INTERVAL_MS);
}

module.exports = { startTokenRefreshJob };
