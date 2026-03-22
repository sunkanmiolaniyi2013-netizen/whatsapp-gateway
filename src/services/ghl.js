const axios = require('axios');

/**
 * Pushes an inbound SMS reply into GoHighLevel's conversation inbox
 */
async function pushInboundMessageToGHL(tenant, fromNumber, body) {
    try {
        const payload = {
            type: 'SMS',
            to: tenant.phone_number, // The Android phone number
            from: fromNumber,        // The contact who replied
            message: body
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

        return response.data;
    } catch (error) {
        console.error('Error posting inbound message to GHL:', error?.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    pushInboundMessageToGHL
};
