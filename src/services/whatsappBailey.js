/**
 * whatsappBailey.js
 * Built-in WhatsApp bridge using @whiskeysockets/baileys
 * No external Evolution API server needed.
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

// In-memory registry of active sessions
// instanceId -> { socket, status, qrBase64, phone }
const sessions = {};

// Callbacks waiting for QR
const qrWaiters = {};

// Where to store auth files (Railway ephemeral FS - sessions persist until redeploy)
const AUTH_DIR = path.join(process.cwd(), '.wa_sessions');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

/**
 * Start or resume a WhatsApp session for a given instanceId.
 * Calls onQR(base64) when a QR code is available.
 * Calls onConnected(phoneNumber) when successfully connected.
 * Calls onDisconnected() if the session is lost.
 */
async function startSession(instanceId, { onQR, onConnected, onDisconnected, onMessage }) {
    // Avoid duplicate sessions
    if (sessions[instanceId]?.socket) {
        const s = sessions[instanceId];
        if (s.status === 'open') {
            if (onConnected) onConnected(s.phone);
            return;
        }
        if (s.status === 'qr' && s.qrBase64 && onQR) {
            onQR(s.qrBase64);
            return;
        }
    }

    const authDir = path.join(AUTH_DIR, instanceId);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }),
        browser: ['GHL Gateway', 'Chrome', '120.0.0'],
    });

    sessions[instanceId] = { socket: sock, status: 'connecting', qrBase64: null, phone: null };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            try {
                const base64 = await QRCode.toDataURL(qr);
                sessions[instanceId].status = 'qr';
                sessions[instanceId].qrBase64 = base64;
                if (onQR) onQR(base64);
                // Notify any waiting HTTP requests
                if (qrWaiters[instanceId]) {
                    qrWaiters[instanceId].forEach(resolve => resolve(base64));
                    delete qrWaiters[instanceId];
                }
            } catch (e) {
                console.error('[Baileys] QR encode error:', e.message);
            }
        }

        if (connection === 'open') {
            const phone = sock.user?.id?.split(':')[0] || 'unknown';
            sessions[instanceId].status = 'open';
            sessions[instanceId].phone = phone;
            sessions[instanceId].qrBase64 = null;
            console.log(`[Baileys] ✅ Connected: ${instanceId} (${phone})`);
            if (onConnected) onConnected(phone);
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`[Baileys] ❌ Disconnected: ${instanceId}, reason=${reason}, reconnect=${shouldReconnect}`);
            sessions[instanceId].status = 'disconnected';

            if (shouldReconnect) {
                // Wait 3s then reconnect
                setTimeout(() => startSession(instanceId, { onQR, onConnected, onDisconnected, onMessage }), 3000);
            } else {
                // Logged out - delete auth files
                fs.rmSync(path.join(AUTH_DIR, instanceId), { recursive: true, force: true });
                delete sessions[instanceId];
                if (onDisconnected) onDisconnected();
            }
        }
    });

    // Forward incoming messages to webhook handler
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type === 'notify' && onMessage) {
            messages.forEach(msg => {
                if (!msg.key.fromMe) onMessage(msg);
            });
        }
    });
}

/**
 * Get the current QR code for an instance as base64 data URL.
 * Waits up to 15 seconds if QR isn't ready yet.
 */
async function getQR(instanceId) {
    const session = sessions[instanceId];
    if (session?.qrBase64) return session.qrBase64;
    if (session?.status === 'open') return null; // already connected

    // Wait for QR
    return new Promise((resolve) => {
        if (!qrWaiters[instanceId]) qrWaiters[instanceId] = [];
        qrWaiters[instanceId].push(resolve);
        setTimeout(() => resolve(null), 15000); // timeout after 15s
    });
}

/**
 * Get the status of a session.
 */
function getStatus(instanceId) {
    const s = sessions[instanceId];
    if (!s) return 'not_started';
    return s.status; // 'connecting' | 'qr' | 'open' | 'disconnected'
}

/**
 * Get the connected phone number for an instance.
 */
function getPhone(instanceId) {
    return sessions[instanceId]?.phone || null;
}

/**
 * Send a WhatsApp message.
 * @param {string} instanceId - The session instance
 * @param {string} to - Phone number with country code (e.g. 447911123456)
 * @param {string} text - Message text
 */
async function sendMessage(instanceId, to, text) {
    const session = sessions[instanceId];
    if (!session || session.status !== 'open') {
        throw new Error(`WhatsApp instance ${instanceId} is not connected`);
    }

    // Normalize JID format
    const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    await session.socket.sendMessage(jid, { text });
}

/**
 * Delete (logout) an instance.
 */
async function deleteSession(instanceId) {
    const session = sessions[instanceId];
    if (session?.socket) {
        try { await session.socket.logout(); } catch (e) { /* ignore */ }
    }
    fs.rmSync(path.join(AUTH_DIR, instanceId), { recursive: true, force: true });
    delete sessions[instanceId];
}

/**
 * List all known instance IDs and their statuses.
 */
function listSessions() {
    return Object.entries(sessions).map(([id, s]) => ({
        instanceId: id,
        status: s.status,
        phone: s.phone
    }));
}

module.exports = { startSession, getQR, getStatus, getPhone, sendMessage, deleteSession, listSessions };
