/**
 * whatsappConversationTracker.js
 * 
 * Tracks outbound WhatsApp conversations so that inbound replies
 * can be routed back to the SAME GHL contact/conversation.
 * 
 * Problem it solves:
 * When GHL sends a message to a contact via WhatsApp, and that contact replies,
 * the reply's phone number might not exactly match what GHL has stored (formatting
 * differences, country code issues, etc). This tracker records the outbound
 * mapping so the reply always lands on the correct contact's conversation.
 */

// In-memory map: normalizedPhone -> { contactId, conversationId, locationId, timestamp }
const conversationMap = new Map();

// Entries expire after 30 days (plenty of time for conversations)
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Normalize a phone number to digits-only for consistent lookup.
 * "+33 6 52 29 06 26" -> "33652290626"
 */
function normalize(phone) {
    return (phone || '').replace(/\D/g, '');
}

/**
 * Record an outbound message so we can match the reply later.
 * Called when GHL sends a message through our WhatsApp bridge.
 */
function trackOutbound({ toNumber, contactId, conversationId, locationId }) {
    const key = normalize(toNumber);
    if (!key) return;
    
    conversationMap.set(key, {
        contactId: contactId || null,
        conversationId: conversationId || null,
        locationId: locationId || null,
        timestamp: Date.now()
    });

    console.log(`[ConvoTracker] Tracked outbound: ${key} -> contactId=${contactId}, convId=${conversationId}`);
    
    // Cleanup old entries periodically (every 100 new entries)
    if (conversationMap.size % 100 === 0) {
        cleanup();
    }
}

/**
 * Look up a tracked conversation for an inbound reply.
 * Returns { contactId, conversationId, locationId } or null.
 */
function lookupInbound(fromNumber) {
    const key = normalize(fromNumber);
    if (!key) return null;

    const entry = conversationMap.get(key);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > EXPIRY_MS) {
        conversationMap.delete(key);
        return null;
    }

    console.log(`[ConvoTracker] ✅ Match found for ${key}: contactId=${entry.contactId}, convId=${entry.conversationId}`);
    return entry;
}

/**
 * Remove expired entries.
 */
function cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of conversationMap) {
        if (now - entry.timestamp > EXPIRY_MS) {
            conversationMap.delete(key);
            removed++;
        }
    }
    if (removed > 0) console.log(`[ConvoTracker] Cleaned up ${removed} expired entries`);
}

/**
 * Get stats for debugging.
 */
function getStats() {
    return { tracked: conversationMap.size };
}

module.exports = { trackOutbound, lookupInbound, normalize, getStats };
