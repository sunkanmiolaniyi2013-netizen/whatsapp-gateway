require('dotenv').config();
const supabase = require('./src/db/supabase');

async function checkLogs() {
    const { data: logs, error } = await supabase
        .from('logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);

    if (error) {
        console.error("Error fetching logs:", error);
        return;
    }

    console.log("=== LATEST 5 LOGS ===");
    logs.forEach(log => {
        console.log(`\nEVENT: ${log.event} | TIME: ${log.created_at}`);
        console.log(`Payload:`, JSON.stringify(log.payload, null, 2));
        if (log.error) console.log(`ERROR: ${log.error}`);
    });
}

checkLogs();
