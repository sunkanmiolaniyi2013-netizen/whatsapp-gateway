require('dotenv').config();
const supabase = require('./src/db/supabase');
async function run() {
    const { data: logs } = await supabase.from('logs').select('*')
        .order('created_at', { ascending: false })
        .limit(10);
    logs.forEach(l => {
        let details = '';
        if (l.event === 'webhook_gateway_received') {
            details = `MSG: ${l.payload?.payload?.message || l.payload?.message} | ID: ${l.payload?.payload?.messageId || l.payload?.id}`;
        } else if (l.event === 'webhook_inbound_error') {
            details = `ERR: ${JSON.stringify(l.payload || l.error)}`;
        } else if (l.event === 'sms_inbound_ignored') {
            details = `REASON: ${JSON.stringify(l.payload)}`;
        }
        console.log(`TIME: ${l.created_at} | EVENT: ${l.event} | ${details}`);
    });
}
run();
