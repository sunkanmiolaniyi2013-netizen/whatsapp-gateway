const axios = require('axios');
const supabase = require('./src/db/supabase');
const ghlService = require('./src/services/ghl');
const whatsappDB = require('./src/db/whatsappQueries');

async function testGHLInbound() {
    try {
        const { data: tenants, error } = await supabase.from('whatsapp_tenants').select('*').limit(1);
        if (error || !tenants || tenants.length === 0) {
            console.error('Tenant not found', error);
            return;
        }
        const tenant = tenants[0];

        const token = await ghlService.getValidAccessToken(tenant);
        
        const payload = {
            type: 'SMS',
            to: tenant.phone_number || tenant.whatsapp_phone_number,
            from: '+33652290626', // Dave
            message: 'Test image attachment from API',
            attachments: ['https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Image_created_with_a_mobile_phone.png/1200px-Image_created_with_a_mobile_phone.png']
        };

        console.log('Sending payload:', payload);

        const response = await axios.post(
            'https://services.leadconnectorhq.com/conversations/messages/inbound',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Version': '2021-04-15',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );

        console.log('Response:', response.data);
    } catch (e) {
        console.error('Error:', e.response ? e.response.data : e.message);
    }
}

testGHLInbound();
