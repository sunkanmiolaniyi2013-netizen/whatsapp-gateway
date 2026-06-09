const axios = require('axios');
const db = require('../db/queries'); // Standard queries for logging

/**
 * Sends a WhatsApp message via the Evolution API Bridge.
 */
async function sendWhatsappMessage(tenant, toPhone, body) {
    try {
        const url = `${tenant.whatsapp_base_url}/message/sendText/${tenant.whatsapp_instance_id}`;
        
        console.log(`[WhatsApp Gateway] Sending out via Evolution API (${tenant.whatsapp_instance_id}) to ${toPhone}`);

        // Format to standard international number without + for Evolution API usually
        const cleanNumber = toPhone.replace(/\\D/g, '');
        
        const payload = {
            number: cleanNumber,
            text: body,
            delay: 1200 // Add a small natural delay if Evolution supports it
        };

        const response = await axios.post(url, payload, {
            headers: {
                'apikey': tenant.whatsapp_api_key,
                'Content-Type': 'application/json'
            }
        });

        console.log('[WhatsApp Gateway] Success:', response.data);
        return response.data;
    } catch (error) {
        console.error('[WhatsApp Gateway] Error sending to Evolution API:', error?.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendWhatsappMessage
};
