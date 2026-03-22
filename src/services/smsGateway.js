const axios = require('axios');

/**
 * Sends an SMS out via the Android SMS Gateway app
 */
async function sendSmsViaGateway(tenant, toNumber, body) {
    try {
        // capcom6/android-sms-gateway push API v3 format
        const payload = {
            messages: [
                {
                    phone: toNumber,
                    message: body
                }
            ]
        };

        const response = await axios.post(
            `${tenant.gateway_base_url}/api/v3/messages`,
            payload,
            {
                headers: {
                    'Authorization': tenant.gateway_api_key,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error sending SMS via Android Gateway:', error?.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendSmsViaGateway
};
