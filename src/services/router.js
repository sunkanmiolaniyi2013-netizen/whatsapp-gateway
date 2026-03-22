const db = require('../db/queries');
const ghlService = require('./ghl');
const smsGateway = require('./smsGateway');

/**
 * Handles Webhook from GHL (Workflow action sending an SMS)
 * Expected simplified GHL payload: { locationId, contact: { phone }, customData: { message } }
 * Or standard standard GHL outbound message webhook structure depending on how it's triggered.
 */
async function handleGhlOutbound(payload) {
    try {
        const locationId = payload.location?.id || payload.locationId;
        const toNumber = payload.contact?.phone || payload.phone;
        const body = payload.message || payload.body || payload.customData?.message;

        if (!locationId || !toNumber || !body) {
            throw new Error('Missing locationId, phone, or message in GHL payload');
        }

        const tenant = await db.getTenantByLocationId(locationId);
        if (!tenant) {
            throw new Error(`No active tenant found for location ${locationId}`);
        }

        // Send via Gateway
        const result = await smsGateway.sendSmsViaGateway(tenant, toNumber, body);

        // Log it
        await db.logMessage({
            tenant_id: tenant.id,
            direction: 'outbound',
            from_number: tenant.phone_number,
            to_number: toNumber,
            body: body,
            status: 'sent'
        });

        return { success: true, message: 'Dispatched to Android Gateway', result };
    } catch (error) {
        await db.logEvent('ghl_outbound_error', null, payload, error.message);
        throw error;
    }
}

/**
 * Handles Webhook from Android Gateway App (Incoming SMS received)
 * Gateway payload usually: { event: "sms:received", payload: { phone: "+12345", message: "Hi", receiver: "+09876" } }
 */
async function handleSmsInbound(gatewayPayload) {
    try {
        // Adjust these fields based on the exact Android app webhook schema
        // Taking a generic approach that works with most gateway apps
        const eventData = gatewayPayload.payload || gatewayPayload;
        const fromNumber = eventData.phone || eventData.sender;
        const body = eventData.message || eventData.text;
        const receiverNumber = eventData.receiver || eventData.simNumberStr; // Often apps pass which SIM received it

        if (!fromNumber || !body) {
            throw new Error('Missing sender phone or message body in Gateway payload');
        }

        // Find which tenant owns the SIM that received this text
        let tenant = null;
        if (receiverNumber) {
            tenant = await db.getTenantByPhonePattern(receiverNumber);
        }
        
        // Fallback: If receiverNumber isn't provided by the app webhook, we might have to use a device ID if sent in headers/payload
        if (!tenant && gatewayPayload.deviceId) {
            const temp = await require('../db/supabase').from('tenants').select('*').eq('gateway_device_id', gatewayPayload.deviceId).single();
            if (temp.data) tenant = temp.data;
        }

        if (!tenant) {
            throw new Error(`Could not map receiving number ${receiverNumber} to a tenant`);
        }

        // Push to GHL Conversations
        const ghlResult = await ghlService.pushInboundMessageToGHL(tenant, fromNumber, body);

        // Log it
        await db.logMessage({
            tenant_id: tenant.id,
            direction: 'inbound',
            from_number: fromNumber,
            to_number: tenant.phone_number,
            body: body,
            ghl_conversation_id: ghlResult?.conversationId || ghlResult?.id,
            status: 'received'
        });

        return { success: true, message: 'Pushed to GHL', result: ghlResult };
    } catch (error) {
        await db.logEvent('sms_inbound_error', null, gatewayPayload, error.message);
        throw error;
    }
}

module.exports = {
    handleGhlOutbound,
    handleSmsInbound
};
