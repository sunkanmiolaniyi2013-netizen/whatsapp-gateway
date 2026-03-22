require('dotenv').config();
const axios = require('axios');
const supabase = require('./src/db/supabase');

async function testInbound() {
    const locationId = "m2G2bfb79Bnj3ArHvLCq";
    const { data: tenant } = await supabase.from('tenants').select('*').eq('ghl_location_id', locationId).single();
    
    if (!tenant) return console.error("Tenant not found");

    try {
        const searchRes = await axios.get(
            `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent('+33783969547')}`,
            {
                headers: {
                    'Authorization': `Bearer ${tenant.ghl_api_key}`,
                    'Version': '2021-07-28',
                    'Accept': 'application/json'
                }
            }
        );
        console.log("Contacts Found:", searchRes.data.contacts.length);
        if (searchRes.data.contacts.length > 0) {
            console.log("First Contact ID:", searchRes.data.contacts[0].id);
            
            const payload = {
                type: 'SMS',
                to: tenant.phone_number,
                from: '+33783969547',
                message: 'Testing API with contactId 1111',
                contactId: searchRes.data.contacts[0].id
            };

            const response = await axios.post(
                'https://services.leadconnectorhq.com/conversations/messages/inbound',
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${tenant.ghl_api_key}`,
                        'Version': '2021-04-15',
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                }
            );
            console.log("SUCCESS!", response.data);
        }
    } catch (error) {
        console.log("ERROR STATUS:", error.response?.status);
        console.log("ERROR DATA:", JSON.stringify(error.response?.data, null, 2));
    }
}

testInbound();
