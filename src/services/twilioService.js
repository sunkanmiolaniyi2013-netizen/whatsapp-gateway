const twilio = require('twilio');

/**
 * Sends an SMS via the Master Twilio Account.
 * Uses the Twilio number configured on the twilioTenant record.
 */
async function sendSmsViaTwilio(twilioTenant, toNumber, body) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in environment variables.');
    }

    const client = twilio(accountSid, authToken);

    const message = await client.messages.create({
        body: body,
        from: twilioTenant.phone_number,
        to: toNumber
    });

    console.log(`[Twilio] SMS sent from ${twilioTenant.phone_number} to ${toNumber}. SID: ${message.sid}, Status: ${message.status}`);
    return message;
}

module.exports = { sendSmsViaTwilio };
