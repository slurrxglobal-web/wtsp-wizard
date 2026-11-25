import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';

function extractMessageText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    (message.buttonsResponseMessage ? message.buttonsResponseMessage.selectedDisplayText : '') ||
    (message.templateButtonReplyMessage ? message.templateButtonReplyMessage.selectedDisplayText : '') ||
    (message.reactionMessage ? `Reacted: ${message.reactionMessage.text}` : '') ||
    ''
  );
}

function sanitizeId(id) {
  if (!id) return '';
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

export class SessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionsDir = options.sessionsDir || path.resolve(process.cwd(), 'sessions', 'baileys');
    this.sessions = new Map(); // id -> { id, label, status, user, qr, sock, retryCount, reconnectTimer }
    this.logger = pino({ level: 'silent' });

    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  /**
   * Initializes and restores existing saved sessions from disk.
   */
  async restoreSavedSessions() {
    try {
      if (!fs.existsSync(this.sessionsDir)) return;
      const items = fs.readdirSync(this.sessionsDir);
      for (const item of items) {
        // Never touch puppeteer or system folders
        if (item === 'puppeteer' || item.startsWith('.')) continue;

        const sessionPath = path.join(this.sessionsDir, item);
        const credsFile = path.join(sessionPath, 'creds.json');
        if (fs.statSync(sessionPath).isDirectory()) {
          if (fs.existsSync(credsFile)) {
            console.log(`[SessionManager] Restoring authenticated session: ${item}`);
            await this.initSession(item, item);
          } else if (item.startsWith('account_')) {
            // Clean empty unauthenticated session folders
            try {
              fs.rmSync(sessionPath, { recursive: true, force: true });
            } catch (e) {}
          }
        }
      }
    } catch (err) {
      console.error('[SessionManager] Error restoring sessions:', err.message);
    }
  }

  /**
   * Initializes or connects a session with the given ID.
   * @param {string} rawSessionId
   * @param {string} label
   */
  async initSession(rawSessionId, label = '') {
    const sessionId = sanitizeId(rawSessionId);
    if (!sessionId) throw new Error('Valid sessionId is required');

    // If already connected or connecting
    const existing = this.sessions.get(sessionId);
    if (existing && existing.sock && existing.status === 'connected') {
      return existing;
    }

    // Cancel any pending reconnect timer
    if (existing && existing.reconnectTimer) {
      clearTimeout(existing.reconnectTimer);
      existing.reconnectTimer = null;
    }

    const sessionAuthPath = path.join(this.sessionsDir, sessionId);
    if (!fs.existsSync(sessionAuthPath)) {
      fs.mkdirSync(sessionAuthPath, { recursive: true });
    }

    const sessionData = {
      id: sessionId,
      label: label || sessionId,
      status: 'connecting',
      user: null,
      qr: null,
      sock: null,
      chats: new Map(),
      contacts: new Map(),
      messages: new Map(),
      createdAt: Date.now(),
      retryCount: 0,
      reconnectTimer: null
    };

    // Load any cached chats and discover contacts from stored session keys
    this.loadCachedData(sessionId, sessionData, sessionAuthPath);

    this.sessions.set(sessionId, sessionData);
    this.emit('session_update', this.getSanitizedSession(sessionId));

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionAuthPath);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
      });

      sessionData.sock = sock;

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (e) {
          console.error(`[${sessionId}] Error saving creds:`, e.message);
        }
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            sessionData.qr = await QRCode.toDataURL(qr);
            sessionData.status = 'qr_ready';
            this.emit('session_update', this.getSanitizedSession(sessionId));
            this.emit('qr', { id: sessionId, qr: sessionData.qr });
          } catch (qrErr) {
            console.error(`[${sessionId}] QR generation error:`, qrErr.message);
          }
        }

        if (connection === 'close') {
          sessionData.qr = null;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const credsFileExists = fs.existsSync(path.join(sessionAuthPath, 'creds.json'));

          console.log(`[${sessionId}] Connection closed. Code: ${statusCode}, HasCreds: ${credsFileExists}`);

          if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
            sessionData.status = 'logged_out';
            sessionData.user = null;
            try {
              fs.rmSync(sessionAuthPath, { recursive: true, force: true });
            } catch (rmErr) {
              console.error(`[${sessionId}] Failed to delete session dir:`, rmErr.message);
            }
            this.emit('session_update', this.getSanitizedSession(sessionId));
            return;
          }

          // Case 1: WhatsApp requested immediate restart right after QR scan (Code 515)
          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            console.log(`[${sessionId}] QR successfully paired! Code 515 (restartRequired). Reconnecting immediately...`);
            sessionData.status = 'connecting';
            this.emit('session_update', this.getSanitizedSession(sessionId));
            sessionData.reconnectTimer = setTimeout(() => this.initSession(sessionId, label), 800);
            return;
          }

          // Case 2: Saved credentials exist (already paired or just paired) -> always auto reconnect
          if (credsFileExists) {
            console.log(`[${sessionId}] Saved credentials found. Reconnecting (Code: ${statusCode})...`);
            sessionData.status = 'connecting';
            this.emit('session_update', this.getSanitizedSession(sessionId));
            sessionData.reconnectTimer = setTimeout(() => this.initSession(sessionId, label), 1500);
            return;
          }

          // Case 3: Pure QR timeout without scan (Code 408)
          if (statusCode === 408 || statusCode === DisconnectReason.timedOut) {
            sessionData.status = 'disconnected';
            sessionData.qr = null;
            this.emit('session_update', this.getSanitizedSession(sessionId));
            return;
          }

          // Other disconnects
          sessionData.status = 'disconnected';
          this.emit('session_update', this.getSanitizedSession(sessionId));
        } else if (connection === 'open') {
          sessionData.status = 'connected';
          sessionData.qr = null;
          sessionData.retryCount = 0;
          sessionData.user = {
            id: sock.user?.id || '',
            name: sock.user?.name || ''
          };
          console.log(`[${sessionId}] Connected successfully as: ${sock.user?.id}`);
          this.emit('session_update', this.getSanitizedSession(sessionId));
        }
      });

      // Sync Contacts
      sock.ev.on('contacts.upsert', (newContacts) => {
        for (const c of newContacts) {
          if (c.id) {
            sessionData.contacts.set(c.id, {
              id: c.id,
              name: c.name || c.notify || c.verifiedName || ''
            });
          }
        }
        this.emit('chats_updated', { id: sessionId, chats: this.getSanitizedChats(sessionId) });
      });

      // Initial History Sync from WhatsApp
      sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
        if (contacts) {
          for (const c of contacts) {
            if (c.id) sessionData.contacts.set(c.id, { id: c.id, name: c.name || c.notify || '' });
          }
        }
        if (chats) {
          for (const ch of chats) {
            if (ch.id) {
              const contact = sessionData.contacts.get(ch.id);
              const name = contact?.name || ch.name || ch.id.split('@')[0];
              sessionData.chats.set(ch.id, {
                id: ch.id,
                name: name,
                time: ch.conversationTimestamp ? new Date(Number(ch.conversationTimestamp) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
                unread: ch.unreadCount || 0,
                lastMsg: ''
              });
            }
          }
        }
        if (messages) {
          for (const m of messages) {
            const jid = m.key.remoteJid;
            if (!jid) continue;
            const text = extractMessageText(m.message);
            if (text) {
              if (!sessionData.messages.has(jid)) sessionData.messages.set(jid, []);
              const msgList = sessionData.messages.get(jid);
              const time = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              msgList.push({
                id: m.key.id,
                text,
                type: m.key.fromMe ? 'outgoing' : 'incoming',
                time
              });
              const existingChat = sessionData.chats.get(jid);
              if (existingChat) {
                existingChat.lastMsg = text;
                if (time) existingChat.time = time;
              }
            }
          }
        }
        this.emit('chats_updated', { id: sessionId, chats: this.getSanitizedChats(sessionId) });
        this.saveCachedData(sessionId, sessionData, sessionAuthPath);
      });

      // Updated or new incoming chats
      sock.ev.on('chats.upsert', (newChats) => {
        for (const ch of newChats) {
          if (!ch.id) continue;
          const contact = sessionData.contacts.get(ch.id);
          const name = contact?.name || ch.name || ch.id.split('@')[0];
          const existing = sessionData.chats.get(ch.id) || {};
          sessionData.chats.set(ch.id, {
            id: ch.id,
            name: name || existing.name || ch.id.split('@')[0],
            time: ch.conversationTimestamp ? new Date(Number(ch.conversationTimestamp) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : existing.time || '',
            unread: ch.unreadCount || 0,
            lastMsg: existing.lastMsg || ''
          });
        }
        this.emit('chats_updated', { id: sessionId, chats: this.getSanitizedChats(sessionId) });
        this.saveCachedData(sessionId, sessionData, sessionAuthPath);
      });

      // Live Messages
      sock.ev.on('messages.upsert', ({ messages: newMessages }) => {
        for (const m of newMessages) {
          const jid = m.key.remoteJid;
          if (!jid) continue;
          const text = extractMessageText(m.message);
          if (!text) continue;

          if (!sessionData.messages.has(jid)) sessionData.messages.set(jid, []);
          const msgList = sessionData.messages.get(jid);
          const time = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

          msgList.push({
            id: m.key.id,
            text,
            type: m.key.fromMe ? 'outgoing' : 'incoming',
            time
          });

          const contact = sessionData.contacts.get(jid);
          const name = contact?.name || jid.split('@')[0];
          const existing = sessionData.chats.get(jid) || { id: jid, name };
          existing.lastMsg = text;
          if (time) existing.time = time;
          sessionData.chats.set(jid, existing);
        }
        this.emit('chats_updated', { id: sessionId, chats: this.getSanitizedChats(sessionId) });
        this.emit('messages_updated', { id: sessionId, messages: this.getSanitizedMessages(sessionId) });
        this.saveCachedData(sessionId, sessionData, sessionAuthPath);
      });

      return sessionData;
    } catch (err) {
      sessionData.status = 'error';
      sessionData.error = err.message;
      this.emit('session_update', this.getSanitizedSession(sessionId));
      throw err;
    }
  }

  /**
   * Cleans all unpaired sessions from memory and disk.
   */
  async clearUnpairedSessions() {
    const toRemove = [];
    for (const [id, session] of this.sessions) {
      if (session.status !== 'connected') {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      await this.removeSession(id);
    }
    return toRemove.length;
  }

  /**
   * Deletes and cleans up a session.
   * @param {string} rawSessionId
   */
  async removeSession(rawSessionId) {
    const sessionId = sanitizeId(rawSessionId);
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    if (session.sock) {
      try {
        session.sock.end(undefined);
      } catch (e) {
        // ignore
      }
    }

    const sessionPath = path.join(this.sessionsDir, sessionId);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      } catch (err) {
        console.error(`[${sessionId}] Error removing session directory:`, err.message);
      }
    }

    this.sessions.delete(sessionId);
    this.emit('session_removed', sessionId);
    return true;
  }

  /**
   * Returns a clean representation of a session safe for UI serialization.
   * @param {string} sessionId
   */
  getSanitizedSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id,
      label: s.label,
      status: s.status,
      user: s.user,
      qr: s.qr,
      createdAt: s.createdAt
    };
  }

  /**
   * Returns all sanitized sessions.
   */
  getAllSessions() {
    const result = [];
    for (const [id] of this.sessions) {
      result.push(this.getSanitizedSession(id));
    }
    return result;
  }

  /**
   * Gets active connected socket for a session ID.
   * @param {string} sessionId
   */
  getSocket(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.status === 'connected' && session.sock) {
      return session.sock;
    }
    return null;
  }

  /**
   * Returns array of connected session IDs.
   */
  getConnectedSessionIds() {
    const connected = [];
    for (const [id, session] of this.sessions) {
      if (session.status === 'connected' && session.sock) {
        connected.push(id);
      }
    }
    return connected;
  }

  /**
   * Returns sanitized real chats list for a session.
   */
  getSanitizedChats(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.chats) return [];
    return Array.from(s.chats.values()).slice(0, 50);
  }

  /**
   * Returns messages for a session.
   */
  getSanitizedMessages(sessionId, jid = null) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.messages) return jid ? [] : {};
    if (jid) {
      return s.messages.get(jid) || [];
    }
    const result = {};
    for (const [chatId, msgs] of s.messages) {
      result[chatId] = msgs.slice(-50);
    }
    return result;
  }

  /**
   * Returns chats across all sessions.
   */
  getAllChats() {
    const result = {};
    for (const [id] of this.sessions) {
      result[id] = this.getSanitizedChats(id);
    }
    return result;
  }

  /**
   * Loads cached chats and messages from session directory, or discovers from session files
   */
  loadCachedData(sessionId, sessionData, sessionAuthPath) {
    const chatsCachePath = path.join(sessionAuthPath, 'chats_cache.json');
    const messagesCachePath = path.join(sessionAuthPath, 'messages_cache.json');

    if (fs.existsSync(chatsCachePath)) {
      try {
        const cachedChats = JSON.parse(fs.readFileSync(chatsCachePath, 'utf8'));
        for (const ch of cachedChats) {
          sessionData.chats.set(ch.id, ch);
        }
      } catch (e) {}
    }

    if (fs.existsSync(messagesCachePath)) {
      try {
        const cachedMsgs = JSON.parse(fs.readFileSync(messagesCachePath, 'utf8'));
        for (const [jid, msgs] of Object.entries(cachedMsgs)) {
          sessionData.messages.set(jid, msgs);
        }
      } catch (e) {}
    }

    // If chats are still empty, scan session files to restore contacts
    if (sessionData.chats.size === 0 && fs.existsSync(sessionAuthPath)) {
      try {
        const files = fs.readdirSync(sessionAuthPath);
        for (const file of files) {
          const matchSession = file.match(/^session-(\d+)\./);
          const matchGroup = file.match(/^sender-key-([^@]+@g\.us)/);

          if (matchSession) {
            const num = matchSession[1];
            const jid = `${num}@s.whatsapp.net`;
            if (!sessionData.chats.has(jid)) {
              sessionData.chats.set(jid, {
                id: jid,
                name: num,
                time: 'Recent',
                unread: 0,
                lastMsg: 'Tap to open chat'
              });
            }
          } else if (matchGroup) {
            const jid = matchGroup[1];
            if (!sessionData.chats.has(jid)) {
              sessionData.chats.set(jid, {
                id: jid,
                name: 'WhatsApp Group',
                time: 'Recent',
                unread: 0,
                lastMsg: 'Tap to open chat'
              });
            }
          }
        }
      } catch (e) {}
    }
  }

  /**
   * Persists current session chats and messages to disk
   */
  saveCachedData(sessionId, sessionData, sessionAuthPath) {
    try {
      if (!fs.existsSync(sessionAuthPath)) {
        fs.mkdirSync(sessionAuthPath, { recursive: true });
      }
      const chatsCachePath = path.join(sessionAuthPath, 'chats_cache.json');
      const messagesCachePath = path.join(sessionAuthPath, 'messages_cache.json');

      fs.writeFileSync(
        chatsCachePath,
        JSON.stringify(Array.from(sessionData.chats.values()), null, 2)
      );

      const msgObj = {};
      for (const [jid, msgs] of sessionData.messages) {
        msgObj[jid] = msgs;
      }
      fs.writeFileSync(messagesCachePath, JSON.stringify(msgObj, null, 2));
    } catch (e) {}
  }

  /**
   * Returns all messages across all sessions.
   */
  getAllMessages() {
    const result = {};
    for (const [id] of this.sessions) {
      result[id] = this.getSanitizedMessages(id);
    }
    return result;
  }
}
