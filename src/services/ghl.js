const axios = require('axios');

/**
 * Pushes an inbound SMS reply into GoHighLevel's conversation inbox
 */
async function pushInboundMessageToGHL(tenant, fromNumber, body) {
    try {
        let contactId = null;

        try {
            // Find the contact in GHL to get their ID (required for inbound V2 API)
            const searchRes = await axios.get(
                `https://services.leadconnectorhq.com/contacts/?locationId=${tenant.ghl_location_id}&query=${encodeURIComponent(fromNumber)}`,
                {
                    headers: {
                        'Authorization': `Bearer ${tenant.ghl_api_key}`,
                        'Version': '2021-07-28',
                        'Accept': 'application/json'
                    }
                }
            );
            if (searchRes.data?.contacts?.length > 0) {
                contactId = searchRes.data.contacts[0].id;
            }
        } catch (e) {
            console.error('Failed to look up contact ID:', e.message);
        }

        const payload = {
            type: 'SMS',
            to: tenant.phone_number, // The Android phone number
            from: fromNumber,        // The contact who replied
            message: body
        };

        if (contactId) {
            payload.contactId = contactId;
        }

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
