require('dotenv').config();
const supabase = require('./src/db/supabase');

async function test() {
    const locationId = 'm2G2bfb79Bnj3ArHvLCq';
    const { data, error } = await supabase
        .from('tenants')
        .update({ ghl_access_token: 'test' })
        .eq('ghl_location_id', locationId)
        .select()
        .single();
        
    console.log("Error:", error);
}
test();
