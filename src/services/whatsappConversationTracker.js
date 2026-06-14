/**
 * whatsappConversationTracker.js
 * 
 * Tracks outbound WhatsApp conversations so inbound replies route to
 * the SAME GHL contact/conversation — even when phone numbers don't match.
 * 
 * Two lookup strategies:
 *   1. By phone number (exact match on digits)
 *   2. By instance ID (fallback: "what was the last outbound on this session?")
 */

// Phone-based map: normalizedPhone -> { contactId, conversationId, locationId, instanceId, timestamp }
const phoneMap = new Map();

// Instance-based map: instanceId -> [ { toPhone, contactId, conversationId, locationId, timestamp } ]
const instanceMap = new Map();

const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function normalize(phone) {
    return (phone || '').replace(/\D/g, '');
}

/**
 * Record an outbound message.
 */
function trackOutbound({ toNumber, contactId, conversationId, locationId, instanceId }) {
    const key = normalize(toNumber);
    if (!key) return;
    
    const entry = {
        toPhone: key,
        contactId: contactId || null,
        conversationId: conversationId || null,
        locationId: locationId || null,
        instanceId: instanceId || null,
        timestamp: Date.now()
    };

    // Track by phone
    phoneMap.set(key, entry);

    // Track by instance (keep most recent per contact)
    if (instanceId) {
        if (!instanceMap.has(instanceId)) instanceMap.set(instanceId, []);
        const list = instanceMap.get(instanceId);
        // Replace existing entry for same contact, or add new
        const idx = list.findIndex(e => e.contactId === contactId);
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
        // Keep only last 50 conversations per instance
        if (list.length > 50) list.shift();
    }

    console.log(`[ConvoTracker] Tracked: phone=${key}, instance=${instanceId}, contact=${contactId}, conv=${conversationId}`);
}

/**
 * Look up the correct GHL contact for an inbound reply.
 * Matches by phone number (normalized digits).
 * 
 * NOTE: We intentionally do NOT fall back to "last outbound on this instance"
 * because multiple different people message the same WhatsApp number.
 * That fallback caused cross-contamination (e.g., FXDTRADE's message
 * landing in a French contact's conversation).
 */
function lookupInbound(fromNumber, instanceId) {
    const key = normalize(fromNumber);

    // ── Phone match ──
    if (key) {
        const entry = phoneMap.get(key);
        if (entry && (Date.now() - entry.timestamp < EXPIRY_MS)) {
            console.log(`[ConvoTracker] ✅ Phone match: ${key} → contact=${entry.contactId}`);
            return entry;
        }
    }

    console.log(`[ConvoTracker] ❌ No match for phone=${key}`);
    return null;
}

function getStats() {
    return { 
        phoneEntries: phoneMap.size,
        instanceEntries: instanceMap.size,
        allEntries: Array.from(phoneMap.entries()).map(([k, v]) => ({ phone: k, contact: v.contactId, conv: v.conversationId }))
    };
}

/**
 * Clear a stale tracker entry by phone number.
 * Called when GHL reports a conversation as deleted/not found.
 */
function clearByPhone(phone) {
    const key = normalize(phone);
    if (key && phoneMap.has(key)) {
        const entry = phoneMap.get(key);
        phoneMap.delete(key);
        console.log(`[ConvoTracker] 🗑️ Cleared stale entry for phone=${key}, conv=${entry.conversationId}`);
    }
}

module.exports = { trackOutbound, lookupInbound, clearByPhone, normalize, getStats };
