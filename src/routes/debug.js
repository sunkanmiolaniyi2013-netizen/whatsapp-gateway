const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

router.get('/', async (req, res) => {
    try {
        const { data: logs } = await supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(20);
        res.json(logs);
    } catch (e) {
        res.json({ error: e.message });
    }
});
module.exports = router;
