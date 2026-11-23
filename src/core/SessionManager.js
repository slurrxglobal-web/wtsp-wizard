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
        if (fs.statSync(sessionPath).isDirectory()) {
          console.log(`[SessionManager] Restoring saved session: ${item}`);
          await this.initSession(item, item);
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
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
      });

      sessionData.sock = sock;

      sock.ev.on('creds.update', saveCreds);

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
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`[${sessionId}] Connection closed. Code: ${statusCode}, Reconnect: ${shouldReconnect}`);

          if (statusCode === DisconnectReason.loggedOut) {
            sessionData.status = 'logged_out';
            sessionData.user = null;
            // Clean auth credentials
            try {
              fs.rmSync(sessionAuthPath, { recursive: true, force: true });
            } catch (rmErr) {
              console.error(`[${sessionId}] Failed to delete session dir:`, rmErr.message);
            }
          } else {
            sessionData.status = 'disconnected';
            // Auto reconnect after short delay
            if (sessionData.retryCount < 5) {
              sessionData.retryCount++;
              setTimeout(() => this.initSession(sessionId, label), 3000);
            }
          }

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
