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

export class SessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionsDir = options.sessionsDir || path.resolve(process.cwd(), 'sessions');
    this.sessions = new Map(); // id -> { id, label, status, user, qr, sock, retryCount }
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
      const items = fs.readdirSync(this.sessionsDir);
      for (const item of items) {
        const sessionPath = path.join(this.sessionsDir, item);
        const credsFile = path.join(sessionPath, 'creds.json');
        if (fs.statSync(sessionPath).isDirectory()) {
          if (fs.existsSync(credsFile)) {
            console.log(`[SessionManager] Restoring authenticated session: ${item}`);
            await this.initSession(item, item);
          } else {
            // Clean empty unauthenticated folders
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
   * @param {string} sessionId
   * @param {string} label
   */
  async initSession(sessionId, label = '') {
    if (!sessionId) throw new Error('sessionId is required');

    // If already connected or connecting
    const existing = this.sessions.get(sessionId);
    if (existing && existing.sock && existing.status === 'connected') {
      return existing;
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
      createdAt: Date.now(),
      retryCount: 0
    };

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
            setTimeout(() => this.initSession(sessionId, label), 800);
            return;
          }

          // Case 2: Saved credentials exist (already paired or just paired) -> always auto reconnect
          if (credsFileExists) {
            console.log(`[${sessionId}] Saved credentials found. Reconnecting (Code: ${statusCode})...`);
            sessionData.status = 'connecting';
            this.emit('session_update', this.getSanitizedSession(sessionId));
            setTimeout(() => this.initSession(sessionId, label), 1500);
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
   * @param {string} sessionId
   */
  async removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

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
}
