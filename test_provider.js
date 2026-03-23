require('dotenv').config();
const db = require('./src/db/queries');
const smsGateway = require('./src/services/smsGateway');
const ghlService = require('./src/services/ghl');
const axios = require('axios');

async function testProvider() {
    const payload = {
        "type": "SMS",
        "phone": "+33783969547",
        "userId": "1MPaLXbMa8kPyiWMmXIg",
        "message": "Oh, the blood of Jesus, hola blood of Jesus",
        "contactId": "kyl3Z2rGDlMyGiwn2QlZ",
        "messageId": "FlrmovjrEPhpoWhDSfjO",
        "locationId": "m2G2bfb79Bnj3ArHvLCq"
    };

    const locationId = payload.locationId;
    const toNumber = payload.phone;
    const body = payload.message;
    const messageId = payload.messageId;

    try {
        const tenant = await db.getTenantByLocationId(locationId);
        if (!tenant) return console.error("Tenant not found");
        
        console.log("Tenant found. Gateway URL:", tenant.gateway_base_url);

        console.log("Sending via Gateway...");
        const result = await smsGateway.sendSmsViaGateway(tenant, toNumber, body);
        console.log("Gateway Result:", result);

        console.log("Updating delivery status...");
        const token = await ghlService.getValidAccessToken(tenant);
        
        const ghlRes = await axios.post('https://services.leadconnectorhq.com/conversations/messages/delivery-status', {
            messageId: messageId,
            status: "delivered"
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Version': '2021-04-15',
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        
        console.log("GHL Status Result:", ghlRes.data);
    } catch (e) {
        console.error("FATAL ERROR:", e.response?.data || e.message);
    }
}

testProvider();
