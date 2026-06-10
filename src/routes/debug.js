const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const convoTracker = require('../services/whatsappConversationTracker');

router.get('/', async (req, res) => {
    try {
        const { data: logs } = await supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(20);
        res.json(logs);
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Show what the conversation tracker currently has in memory
router.get('/tracker', (req, res) => {
    res.json(convoTracker.getStats());
});

module.exports = router;
