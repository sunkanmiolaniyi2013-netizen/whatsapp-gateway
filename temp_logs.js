require('dotenv').config();
const supabase = require('./src/db/supabase');

async function run() {
    const { data: logs } = await supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(6);
    if (!logs) return console.log('No logs found');
    
    logs.forEach(l => {
        console.log('\n--- EVENT:', l.event, '| TIME:', l.created_at, '---');
        if (l.payload) console.log('Payload:', JSON.stringify(l.payload));
        if (l.error) console.log('Error:', l.error);
    });
}
run();
