require('dotenv').config();
const db = require('./src/db/queries');
const ghl = require('./src/services/ghl');

async function test() {
    const payload = {
        "sender": "+33783969547",
        "message": "Yes uncle?",
        "recipient": "+33652705031",
    };
    
    // Find tenant
    let tenant = await db.getTenantByStickyInbound(payload.sender, payload.recipient);
    if (!tenant) {
        tenant = await db.getTenantByPhonePattern(payload.recipient);
    }
    
    console.log("Tenant found: ", tenant ? tenant.business_name : "None");
    if (!tenant) return;

    try {
        console.log("Pushing to GHL...");
        const res = await ghl.pushInboundMessageToGHL(tenant, payload.sender, payload.message);
        console.log("SUCCESS:", res);
    } catch (e) {
        console.log("ERROR:", e?.response?.data || e.message);
    }
}
test();
