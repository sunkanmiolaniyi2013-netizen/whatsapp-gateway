require('dotenv').config();
const { handleSmsInbound } = require('./src/services/router');
const db = require('./src/db/queries');

async function test() {
    const payload = {"id":"WGlUEG1uT8gK3Xp8VuJft","event":"sms:received","payload":{"sender":"+33783969547","message":"Yes it does work, why asking?","messageId":"d75297f2","recipient":"+33652705031","simNumber":2,"receivedAt":"2026-03-24T12:45:02.000+01:00","phoneNumber":"+33783969547"},"deviceId":"hYA7kRaSyymAslhYfxYkz","webhookId":"Pc-ej0uFYREpThlW0Omk4"};
    
    try {
        console.log('Simulating inbound SMS...');
        const result = await handleSmsInbound(payload);
        console.log('SUCCESS:', result);
    } catch (e) {
        console.error('CRASHED EXACTLY HERE:', e.message);
        if (e.response) {
            console.error('API Response Data:', e.response.data);
        }
    }
}
test();
