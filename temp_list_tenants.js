require('dotenv').config();
const supabase = require('./src/db/supabase');

async function run() {
    const { data } = await supabase.from('tenants').select('*');
    if (!data) return console.log('No data');
    data.forEach(t => {
        console.log('\n--- Business:', t.business_name, '---');
        console.log('Location ID:', t.ghl_location_id);
        console.log('Phone:', t.phone_number);
        console.log('Gateway API Key:', t.gateway_api_key);
        console.log('Has OAuth?', !!t.ghl_access_token);
    });
}
run();
