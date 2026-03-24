const db = require('../db/queries');

/**
 * Determines the absolute best physical Android phone to send a text from.
 * Applies Sticky Routing and Country Code Matching automatically.
 * 
 * @param {string} locationId GoHighLevel Sub-Account ID
 * @param {string} contactPhone The Lead's Phone Number (e.g., +1404..., +336...)
 * @returns {object} The selected tenant database row
 */
async function determineGatewayNumber(locationId, contactPhone) {
    console.log(`[Router] Determining gateway for location ${locationId}, contact: ${contactPhone}`);

    // 1. Check for an existing sticky route! (Never break a conversation)
    const existingRoute = await db.getStickyRoute(locationId, contactPhone);
    if (existingRoute) {
        console.log(`[Router] Sticky Route found! Locking to ${existingRoute.gateway_phone}`);
        // Fetch the specific tenant row that matches the location AND that specific gateway phone
        const tenant = await db.getTenantByExactPhone(locationId, existingRoute.gateway_phone);
        if (tenant && tenant.is_active) {
            return tenant;
        }
        console.log(`[Router] Sticky phone ${existingRoute.gateway_phone} is inactive/deleted. Falling back.`);
    }

    // 2. Fetch all active phones assigned to this Location ID
    const activeTenants = await db.getTenantsByLocationId(locationId);
    if (!activeTenants || activeTenants.length === 0) {
        console.error(`[Router] FATAL: No active Android phones found for location ${locationId}`);
        return null;
    }

    // If there is only 1 phone, just simply use it (Phase 1 behavior)
    if (activeTenants.length === 1) {
        const chosen = activeTenants[0];
        console.log(`[Router] Only 1 phone configured. Defaulting to ${chosen.phone_number}`);
        await db.saveStickyRoute(locationId, contactPhone, chosen.phone_number);
        return chosen;
    }

    // 3. Country Code Matching!
    // Extract the country code from contactPhone (e.g. +1, +33, +44)
    // Basic extraction: match the plus and initial digits before standard length, 
    // or just check if gateway numbers start with the same first 2-3 characters
    console.log(`[Router] Multiple phones detected. Attempting Country Code match...`);
    let chosenTenant = null;

    // We will look at prefix length progressively to find best match (e.g., +33 > +3)
    let longestPrefixMatch = 0;

    for (const tenant of activeTenants) {
        const gwPhone = tenant.phone_number;
        // Determine how many starting characters match perfectly
        let matchLen = 0;
        for (let i = 0; i < Math.min(contactPhone.length, gwPhone.length); i++) {
            if (contactPhone[i] === gwPhone[i]) matchLen++;
            else break;
        }
        
        // If it matches at least the '+' and the first country digit (e.g. '+1' or '+3')
        if (matchLen >= 2 && matchLen > longestPrefixMatch) {
            longestPrefixMatch = matchLen;
            chosenTenant = tenant;
        }
    }

    // 4. Fallback: Round Robin / Random selection if no country perfectly matches
    // In future versions, we could check a `last_used` timestamp to evenly distribute load
    if (!chosenTenant) {
        console.log(`[Router] No local country match found. Electing Random Fallback.`);
        chosenTenant = activeTenants[Math.floor(Math.random() * activeTenants.length)];
    } else {
        console.log(`[Router] Country Code MATCH! Selected ${chosenTenant.phone_number}`);
    }

    // 5. Save the route permanently so they lock together!
    await db.saveStickyRoute(locationId, contactPhone, chosenTenant.phone_number);

    return chosenTenant;
}

/**
 * Handles incoming webhooks from GHL Webhook block (Phase 1 legacy fallback)
 */
async function handleGhlOutbound(payload) {
    const locationId = payload.customData?.locationId;
    const rawToNumber = payload.customData?.phone || payload.phone;
    const body = payload.customData?.message;

    if (!locationId || !rawToNumber || !body) throw new Error("Missing required payload fields.");
    
    // Normalize phone (strip spaces/dashes)
    const toNumber = rawToNumber.replace(/\s+/g, '').replace(/-/g, '');
    const tenant = await determineGatewayNumber(locationId, toNumber);
    
    if (!tenant) throw new Error(`No active gateway phone found for location ${locationId}`);

    const smsGateway = require('./smsGateway');
    const result = await smsGateway.sendSmsViaGateway(tenant, toNumber, body);

    await db.logMessage({
        tenant_id: tenant.id,
        direction: 'outbound',
        from_number: tenant.phone_number,
        to_number: toNumber,
        body: body,
        ghl_contact_id: payload.contact_id || null,
        status: 'sent'
    });
    
    return { success: true, result };
}

/**
 * Handles inbound SMS replies from the physical Android phone
 */
async function handleSmsInbound(payload) {
    const sender = payload.payload?.sender || payload.sender;
    const recipient = payload.payload?.recipient || payload.recipient;
    const body = payload.payload?.message || payload.message;

    if (!sender || !recipient || !body) throw new Error("Invalid SMS payload from gateway");

    // Phase 3 Multi-Tenant Inbound Routing!
    // Instead of querying just by recipient (which collides if 1 phone serves 2 sub-accounts),
    // we query sticky_routes to find out EXACTLY which Location ID owns this conversation!
    let tenant = await db.getTenantByStickyInbound(sender, recipient);

    if (!tenant) {
        // Fallback: If no locked conversation exists (a totally new cold inbound text),
        // we just randomly pick any sub-account listening on this physical phone.
        console.log(`[Router] No sticky route found for ${sender} -> ${recipient}. Falling back to default pattern match.`);
        tenant = await db.getTenantByPhonePattern(recipient);
    }

    if (!tenant) {
        console.log(`[Router] No tenant found owning gateway phone ${recipient}. Ignoring message.`);
        await db.logEvent('sms_inbound_ignored', null, payload);
        return { success: true, note: "Ignored - unmapped recipient" };
    }

    // Push into GHL using this specific tenant's OAuth credentials!
    const ghlService = require('./ghl');
    await ghlService.pushInboundMessageToGHL(tenant, sender, body);

    return { success: true };
}

module.exports = {
    determineGatewayNumber,
    handleGhlOutbound,
    handleSmsInbound
};
