const supabase = require('./src/db/supabase');

async function check() {
    console.log('Checking Tenants Table...');
    const { data: tenants, error: tErr } = await supabase.from('tenants').select('*');
    if (tErr) {
        console.error('Error fetching tenants:', tErr);
    } else {
        console.log(`Found ${tenants.length} tenants.`, tenants);
    }

    // Try a test insert
    console.log('\nTrying a test insert...');
    const payload = {
        business_name: 'Test Business',
        ghl_location_id: 'test-loc-id-' + Date.now(),
        ghl_api_key: 'test-api-key',
        phone_number: '+1234567890',
        gateway_device_id: 'test-dev',
        gateway_api_key: 'test-key',
        gateway_base_url: 'https://test.com',
        is_active: true
    };
    const { data: insertData, error: insertErr } = await supabase.from('tenants').insert([payload]).select();
    if (insertErr) {
        console.error('Insert Error:', insertErr);
    } else {
        console.log('Insert Success:', insertData);
        // Clean up
        await supabase.from('tenants').delete().eq('id', insertData[0].id);
        console.log('Cleaned up test insert.');
    }
}

check();
