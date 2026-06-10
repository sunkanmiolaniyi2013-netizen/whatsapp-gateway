/**
 * whatsappBailey.js
 * Built-in WhatsApp bridge using @whiskeysockets/baileys
 * No external Evolution API server needed.
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeInMemoryStore, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// In-memory registry of active sessions
// instanceId -> { socket, status, qrBase64, phone }
const sessions = {};

// Callbacks waiting for QR
const qrWaiters = {};

// Global inbound message handler (set by the app on startup)
let _globalMessageHandler = null;
function setMessageHandler(fn) { _globalMessageHandler = fn; }

// Where to store auth files (Use Railway Persistent Volume if available, else ephemeral)
const AUTH_DIR = fs.existsSync('/data') ? '/data/.wa_sessions' : path.join(process.cwd(), '.wa_sessions');
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

    // Forward incoming messages to the global handler (which pushes to GHL)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                const fromJid = msg.key.remoteJid || '';
                if (fromJid.endsWith('@g.us')) continue; // Skip group messages
                const fromNumber = '+' + fromJid.split('@')[0];

                // Extract text body
                let body = msg.message?.conversation ||
                           msg.message?.extendedTextMessage?.text ||
                           msg.message?.imageMessage?.caption ||
                           msg.message?.videoMessage?.caption ||
                           '';

                // Try to extract media if present (non-blocking — text always goes through)
                let mediaUrl = null;
                const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
                const detectedType = mediaTypes.find(t => msg.message?.[t]);

                if (detectedType) {
                    try {
                        console.log(`[Baileys] 📷 Downloading ${detectedType} from ${fromNumber}...`);
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                            logger: require('pino')({ level: 'silent' }),
                            reuploadRequest: sock.updateMediaMessage || sock.resyncMediaMessage || undefined
                        });
                        if (buffer && buffer.length > 0) {
                            const mimetype = msg.message[detectedType].mimetype || 'image/jpeg';
                            const base64 = buffer.toString('base64');
                            mediaUrl = `data:${mimetype};base64,${base64}`;
                            console.log(`[Baileys] ✅ Media downloaded: ${detectedType}, ${buffer.length} bytes`);
                        }
                        if (!body) body = `📎 ${detectedType.replace('Message', '')}`;
                    } catch (mediaErr) {
                        console.error(`[Baileys] Media download failed (non-fatal):`, mediaErr.message);
                        if (!body) body = '📎 (media received)';
                    }
                }

                if (!body && !mediaUrl) continue;

                console.log(`[Baileys] 📨 Inbound from ${fromNumber} on ${instanceId}${mediaUrl ? ' [+media]' : ''}`);
                if (_globalMessageHandler) {
                    _globalMessageHandler(instanceId, fromNumber, body, mediaUrl).catch(e =>
                        console.error('[Baileys] Message handler error:', e.message)
                    );
                }
                if (onMessage) onMessage(msg);
            } catch (outerErr) {
                console.error('[Baileys] Inbound message processing error (skipping):', outerErr.message);
            }
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
 * Send a WhatsApp text message.
 */
async function sendMessage(instanceId, to, text, attachments = []) {
    const session = sessions[instanceId];
    if (!session || session.status !== 'open') {
        throw new Error(`WhatsApp instance ${instanceId} is not connected`);
    }

    const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

    // If there are attachments, send each one as media
    if (attachments && attachments.length > 0) {
        for (const attachment of attachments) {
            const url = attachment.url || attachment;
            if (!url || typeof url !== 'string') continue;

            try {
                console.log(`[Baileys] Downloading attachment: ${url}`);
                const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
                const buffer = Buffer.from(response.data);
                const contentType = response.headers['content-type'] || 'application/octet-stream';

                let msgPayload;
                if (contentType.startsWith('image/')) {
                    msgPayload = { image: buffer, caption: text || '', mimetype: contentType };
                } else if (contentType.startsWith('video/')) {
                    msgPayload = { video: buffer, caption: text || '', mimetype: contentType };
                } else if (contentType.startsWith('audio/')) {
                    msgPayload = { audio: buffer, mimetype: contentType, ptt: false };
                } else {
                    // Send as document
                    const fileName = attachment.fileName || url.split('/').pop()?.split('?')[0] || 'file';
                    msgPayload = { document: buffer, mimetype: contentType, fileName };
                }

                await session.socket.sendMessage(jid, msgPayload);
                console.log(`[Baileys] ✅ Media sent: ${contentType}, ${buffer.length} bytes`);

                // If image/video had a caption, we already sent the text with it
                // Clear text so we don't send it again as a separate message
                text = null;
            } catch (dlErr) {
                console.error(`[Baileys] Failed to download/send attachment: ${dlErr.message}`);
                // Fall back to sending URL as text
                await session.socket.sendMessage(jid, { text: `${text || ''}\n📎 ${url}`.trim() });
                text = null;
            }
        }
    }

    // Send remaining text (if no attachment consumed it)
    if (text) {
        await session.socket.sendMessage(jid, { text });
    }
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

module.exports = { startSession, getQR, getStatus, getPhone, sendMessage, deleteSession, listSessions, setMessageHandler };
