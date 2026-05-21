require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;

async function refreshToken(tableName, row) {
    console.log(`\n[${tableName}] Row ${row.id} | Location: ${row.ghl_location_id}`);
    
    const expiresAt = row.ghl_token_expires_at ? new Date(row.ghl_token_expires_at) : null;
    const now = new Date();
    
    if (expiresAt) {
        const diffMins = Math.round((expiresAt - now) / 60000);
        if (diffMins > 0) {
            console.log(`  Status: VALID — expires in ${diffMins} minutes`);
        } else {
            console.log(`  Status: ❌ EXPIRED ${Math.abs(diffMins)} minutes ago`);
        }
    } else {
        console.log(`  Status: ❌ No expiry date stored`);
    }

    if (!row.ghl_refresh_token) {
        console.log(`  Refresh token: MISSING — cannot refresh`);
        return;
    }

    console.log(`  Refresh token: present (${row.ghl_refresh_token.slice(0,20)}...)`);
    console.log(`  Attempting refresh...`);

    try {
        const formData = new URLSearchParams({
            client_id: GHL_CLIENT_ID,
            client_secret: GHL_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: row.ghl_refresh_token
        }).toString();

        const res = await axios.post('https://services.leadconnectorhq.com/oauth/token', formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const newExpiresAt = new Date(Date.now() + res.data.expires_in * 1000);

        await supabase.from(tableName).update({
            ghl_access_token: res.data.access_token,
            ghl_refresh_token: res.data.refresh_token,
            ghl_token_expires_at: newExpiresAt
        }).eq('id', row.id);

        console.log(`  ✅ REFRESHED! New token valid until: ${newExpiresAt.toISOString()}`);
    } catch (err) {
        console.error(`  ❌ REFRESH FAILED:`, err.response?.data || err.message);
    }
}

async function main() {
    console.log('=== GHL OAuth Token Diagnostics ===');
    console.log(`GHL_CLIENT_ID: ${GHL_CLIENT_ID ? GHL_CLIENT_ID.slice(0,10) + '...' : '❌ MISSING'}`);
    console.log(`GHL_CLIENT_SECRET: ${GHL_CLIENT_SECRET ? '✅ present' : '❌ MISSING'}`);

    if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
        console.error('\n❌ Cannot refresh: GHL_CLIENT_ID or GHL_CLIENT_SECRET missing from .env');
        process.exit(1);
    }

    // Check Android tenants
    console.log('\n--- Android Tenants (tenants table) ---');
    const { data: androidTenants, error: e1 } = await supabase
        .from('tenants')
        .select('id, ghl_location_id, ghl_refresh_token, ghl_token_expires_at, ghl_api_key, business_name')
        .eq('is_active', true);

    if (e1) { console.error('Error:', e1.message); }
    else if (!androidTenants.length) { console.log('No active Android tenants found.'); }
    else {
        for (const t of androidTenants) {
            console.log(`  Business: ${t.business_name}`);
            if (t.ghl_api_key?.startsWith('pit-')) {
                console.log(`  Auth: PIT key (no OAuth needed)`);
            } else {
                await refreshToken('tenants', t);
            }
        }
    }

    // Check Twilio tenants
    console.log('\n--- Twilio Tenants (twilio_tenants table) ---');
    const { data: twilioTenants, error: e2 } = await supabase
        .from('twilio_tenants')
        .select('id, ghl_location_id, ghl_refresh_token, ghl_token_expires_at, business_name')
        .eq('is_active', true);

    if (e2) { console.error('Error:', e2.message); }
    else if (!twilioTenants.length) { console.log('No active Twilio tenants found.'); }
    else {
        for (const t of twilioTenants) {
            console.log(`  Business: ${t.business_name}`);
            await refreshToken('twilio_tenants', t);
        }
    }

    console.log('\n=== Done ===');
}

main().catch(console.error);
