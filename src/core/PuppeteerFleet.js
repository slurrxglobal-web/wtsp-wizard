/**
 * PuppeteerFleet.js
 * Manages real WhatsApp Web sessions via Puppeteer headless Chrome.
 * Each session = one actual Chrome browser with web.whatsapp.com loaded.
 * Screenshot streaming → dashboard phone frames show real WhatsApp UI.
 * Master click/type/key → mirrored across all slave sessions.
 */

import puppeteer from 'puppeteer';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

const SESSIONS_BASE = path.resolve(process.cwd(), 'sessions', 'puppeteer');
const SCREENSHOT_INTERVAL_MS = 1000; // 1 second refresh
const VIEWPORT = { width: 1280, height: 820 };

export class PuppeteerFleet extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // id -> { browser, page, status, type: 'puppeteer' }
    this.pollers  = new Map(); // id -> intervalId
    this.master   = null;      // id of master session

    if (!fs.existsSync(SESSIONS_BASE)) {
      fs.mkdirSync(SESSIONS_BASE, { recursive: true });
    }
  }

  // ─── Session Lifecycle ────────────────────────────────────────────────────

  async createSession(id, label = '') {
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      if (existing.status === 'connected' || existing.status === 'qr_ready') {
        return this._sanitize(id);
      }
    }

    console.log(`[PuppeteerFleet] Launching real WhatsApp Web for: ${id}`);

    const userDataDir = path.join(SESSIONS_BASE, id);
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--user-data-dir=${userDataDir}`
      ]
    });

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Spoof user agent to avoid WhatsApp Web blocking headless browsers
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const sessionData = {
      id,
      label: label || id,
      browser,
      page,
      status: 'loading',
      type: 'puppeteer',
      createdAt: Date.now()
    };

    this.sessions.set(id, sessionData);
    this.emit('session_update', this._sanitize(id));

    // Navigate to real WhatsApp Web
    try {
      await page.goto('https://web.whatsapp.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    } catch (err) {
      console.error(`[PuppeteerFleet][${id}] Navigation error:`, err.message);
    }

    // Start screenshot polling + status checking
    this._startPolling(id);

    // Auto-elect first session as master if none set
    if (!this.master) this.master = id;

    return this._sanitize(id);
  }

  async closeSession(id) {
    this._stopPolling(id);
    const s = this.sessions.get(id);
    if (s) {
      try { await s.browser.close(); } catch (_) {}
      this.sessions.delete(id);
      this.emit('session_removed', id);
      console.log(`[PuppeteerFleet] Session closed: ${id}`);
    }
    if (this.master === id) {
      // Elect next master
      const remaining = Array.from(this.sessions.keys());
      this.master = remaining.length > 0 ? remaining[0] : null;
    }
  }

  // ─── Screenshot Polling ───────────────────────────────────────────────────

  _startPolling(id) {
    if (this.pollers.has(id)) return;

    const poll = async () => {
      const s = this.sessions.get(id);
      if (!s || !s.page) return;

      try {
        // Capture compressed JPEG screenshot
        const buf = await s.page.screenshot({
          type: 'jpeg',
          quality: 55,
          encoding: 'base64'
        });
        const dataUrl = `data:image/jpeg;base64,${buf}`;
        this.emit('screenshot', { id, screenshot: dataUrl });

        // Check session status
        await this._detectStatus(id, s);
      } catch (_) {}
    };

    poll(); // immediate first frame
    const interval = setInterval(poll, SCREENSHOT_INTERVAL_MS);
    this.pollers.set(id, interval);
  }

  _stopPolling(id) {
    const interval = this.pollers.get(id);
    if (interval) {
      clearInterval(interval);
      this.pollers.delete(id);
    }
  }

  async _detectStatus(id, s) {
    if (!s || !s.page) return;
    try {
      // WhatsApp Web QR code canvas
      const qrVisible = await s.page.$('canvas[aria-label="Scan this QR code to link a device"]') ||
                        await s.page.$('[data-testid="qrcode"]') ||
                        await s.page.$('canvas');

      // WhatsApp Web chat list (logged in indicator)
      const chatList  = await s.page.$('[data-testid="chat-list"]') ||
                        await s.page.$('#pane-side') ||
                        await s.page.$('.two');

      const prevStatus = s.status;

      if (chatList && s.status !== 'connected') {
        s.status = 'connected';
        console.log(`[PuppeteerFleet][${id}] Connected — WhatsApp Web logged in`);
        this.emit('session_update', this._sanitize(id));
      } else if (qrVisible && s.status !== 'qr_ready' && s.status !== 'connected') {
        s.status = 'qr_ready';
        console.log(`[PuppeteerFleet][${id}] QR ready — waiting for phone scan`);
        this.emit('session_update', this._sanitize(id));
      } else if (s.status === 'loading') {
        // Still loading — no change needed
      }
    } catch (_) {}
  }

  // ─── Master → Slave Mirroring ─────────────────────────────────────────────

  /**
   * Mirror a click from master to all slave sessions.
   * xPct, yPct are percentages of the viewport (0-100).
   */
  async mirrorClick(masterId, xPct, yPct) {
    const masterSession = this.sessions.get(masterId);
    if (!masterSession || !masterSession.page) return;

    const masterX = Math.round((xPct / 100) * VIEWPORT.width);
    const masterY = Math.round((yPct / 100) * VIEWPORT.height);

    // Click on master
    await masterSession.page.mouse.click(masterX, masterY).catch(() => {});

    // Mirror to all slaves
    const promises = [];
    for (const [id, s] of this.sessions) {
      if (id === masterId || !s.page) continue;
      const slaveX = Math.round((xPct / 100) * VIEWPORT.width);
      const slaveY = Math.round((yPct / 100) * VIEWPORT.height);
      promises.push(s.page.mouse.click(slaveX, slaveY).catch(() => {}));
    }
    await Promise.all(promises);
  }

  /**
   * Mirror keyboard typing from master to all slaves.
   */
  async mirrorType(masterId, text) {
    const masterSession = this.sessions.get(masterId);
    if (!masterSession || !masterSession.page) return;

    await masterSession.page.keyboard.type(text, { delay: 30 }).catch(() => {});

    const promises = [];
    for (const [id, s] of this.sessions) {
      if (id === masterId || !s.page) continue;
      promises.push(s.page.keyboard.type(text, { delay: 30 }).catch(() => {}));
    }
    await Promise.all(promises);
  }

  /**
   * Mirror a keyboard keypress (Enter, Backspace, Escape, etc.)
   */
  async mirrorKey(masterId, key) {
    const masterSession = this.sessions.get(masterId);
    if (!masterSession || !masterSession.page) return;

    await masterSession.page.keyboard.press(key).catch(() => {});

    const promises = [];
    for (const [id, s] of this.sessions) {
      if (id === masterId || !s.page) continue;
      promises.push(s.page.keyboard.press(key).catch(() => {}));
    }
    await Promise.all(promises);
  }

  /**
   * Mirror scroll from master to all slaves.
   */
  async mirrorScroll(masterId, xPct, yPct, deltaY) {
    const masterSession = this.sessions.get(masterId);
    if (!masterSession || !masterSession.page) return;

    const x = Math.round((xPct / 100) * VIEWPORT.width);
    const y = Math.round((yPct / 100) * VIEWPORT.height);

    await masterSession.page.mouse.wheel({ deltaY }).catch(() => {});

    const promises = [];
    for (const [id, s] of this.sessions) {
      if (id === masterId || !s.page) continue;
      promises.push(s.page.mouse.wheel({ deltaY }).catch(() => {}));
    }
    await Promise.all(promises);
  }

  // ─── Serialization ────────────────────────────────────────────────────────

  _sanitize(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      id: s.id,
      label: s.label,
      status: s.status,
      type: 'puppeteer',
      isMaster: this.master === id,
      createdAt: s.createdAt
    };
  }

  getAllSessions() {
    return Array.from(this.sessions.keys())
      .map(id => this._sanitize(id))
      .filter(Boolean);
  }

  setMaster(id) {
    if (this.sessions.has(id)) {
      this.master = id;
      console.log(`[PuppeteerFleet] Master set to: ${id}`);
    }
  }

  getMaster() {
    return this.master;
  }
}
