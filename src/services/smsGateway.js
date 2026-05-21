const axios = require('axios');

/**
 * Sends an SMS out via the Android SMS Gateway app
 */
async function sendSmsViaGateway(tenant, toNumber, body) {
    try {
        let endpointUrl = '';
        let payload = {};

        // If using the official Cloud Server (sms-gate.app), use the 3rd-party API format
        if (tenant.gateway_base_url.includes('sms-gate.app')) {
            endpointUrl = `${tenant.gateway_base_url}/3rdparty/v1/message`;
            payload = {
                message: body,
                phoneNumbers: [toNumber]
            };
            if (tenant.sim_number) payload.simNumber = tenant.sim_number;
        } else {
            // CapCom6 generic/local network push API v3 format
            endpointUrl = `${tenant.gateway_base_url}/api/v3/messages`;
            payload = {
                messages: [
                    { phone: toNumber, message: body }
                ]
            };
        }

        const response = await axios.post(
            endpointUrl,
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
