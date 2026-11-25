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
import { AntiBanGuard } from './AntiBanGuard.js';

const SESSIONS_BASE = path.resolve(process.cwd(), 'data', 'puppeteer_profiles');
const SCREENSHOT_INTERVAL_MS = 1000; // 1 second refresh
const VIEWPORT = { width: 1280, height: 820 };

function sanitizeId(id) {
  if (!id) return '';
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

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

  async createSession(rawId, label = '') {
    const id = sanitizeId(rawId);
    if (!id) throw new Error('Invalid session ID');

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

  async closeSession(rawId, cleanDisk = false) {
    const id = sanitizeId(rawId);
    if (!id) return;
    this._stopPolling(id);
    const s = this.sessions.get(id);
    if (s) {
      try { await s.browser.close(); } catch (_) {}
      this.sessions.delete(id);
      this.emit('session_removed', id);
      console.log(`[PuppeteerFleet] Session closed: ${id}`);
    }

    if (cleanDisk) {
      const userDataDir = path.join(SESSIONS_BASE, id);
      if (fs.existsSync(userDataDir)) {
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
      }
    }

    if (this.master === id) {
      // Elect next master
      const remaining = Array.from(this.sessions.keys());
      this.master = remaining.length > 0 ? remaining[0] : null;
    }
  }

  async closeAllSessions(cleanDisk = false) {
    const ids = Array.from(this.sessions.keys());
    console.log(`[PuppeteerFleet] Closing all ${ids.length} sessions...`);
    for (const id of ids) {
      await this.closeSession(id, cleanDisk);
    }
    this.master = null;
    return true;
  }

  /**
   * Batch creates N sessions staggered by a delay to avoid CPU/RAM spike
   */
  async batchCreate(count = 5, staggerMs = 1200) {
    const created = [];
    const baseCount = this.sessions.size;

    for (let i = 1; i <= count; i++) {
      const num = baseCount + i;
      const id = `puppet_${String(num).padStart(2, '0')}`;
      const label = `WhatsApp ${num}`;
      
      const session = await this.createSession(id, label);
      created.push(session);

      if (i < count) {
        await new Promise(r => setTimeout(r, staggerMs));
      }
    }
    return created;
  }

  // ─── Screenshot Polling ───────────────────────────────────────────────────

  _startPolling(id) {
    if (this.pollers.has(id)) return;

    let tickCount = 0;
    const poll = async () => {
      const s = this.sessions.get(id);
      if (!s || !s.page || s.isCapturing) return;

      const isMaster = (this.master === id);
      tickCount++;

      // Slaves refresh every 3 ticks (~3s) to save CPU/RAM
      // Master refreshes every tick (~1s) for smooth visual feedback
      if (!isMaster && (tickCount % 3 !== 0)) {
        return;
      }

      s.isCapturing = true;
      try {
        // Optimized JPEG quality (42 is crisp for WhatsApp text, but 60% smaller in bytes)
        const buf = await s.page.screenshot({
          type: 'jpeg',
          quality: 42,
          encoding: 'base64'
        });
        const dataUrl = `data:image/jpeg;base64,${buf}`;
        this.emit('screenshot', { id, screenshot: dataUrl });

        // Check session status periodically
        if (tickCount % 3 === 0 || s.status === 'loading' || s.status === 'qr_ready') {
          await this._detectStatus(id, s);
        }
      } catch (_) {} finally {
        s.isCapturing = false;
      }
    };

    poll(); // immediate first frame
    const interval = setInterval(poll, 1000);
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

      if (chatList) {
        if (s.status !== 'connected') {
          s.status = 'connected';
          try {
            const profileName = await s.page.evaluate(() => {
              const el = document.querySelector('header [title]') || document.querySelector('header span[dir="auto"]');
              return el ? el.innerText || el.getAttribute('title') : '';
            });
            if (profileName) s.accountName = profileName;
          } catch (_) {}

          console.log(`[PuppeteerFleet][${id}] Connected — WhatsApp Web logged in (${s.accountName || 'Active'})`);
          this.emit('session_update', this._sanitize(id));
        }
      } else if (qrVisible) {
        if (s.status !== 'qr_ready') {
          s.status = 'qr_ready';
          s.accountName = null;
          console.log(`[PuppeteerFleet][${id}] QR ready — waiting for phone scan`);
          this.emit('session_update', this._sanitize(id));
        }
      }
    } catch (_) {}
  }

  // ─── Single Session Click (No Mirroring) ──────────────────────────────────
  async singleClick(sessionId, xPct, yPct) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.page) return;
    const realX = Math.round((xPct / 100) * VIEWPORT.width);
    const realY = Math.round((yPct / 100) * VIEWPORT.height);
    await s.page.mouse.click(realX, realY).catch(() => {});
    this.schedulePostActionScreenshots(sessionId);
  }

  // Rapid screen update helper to ensure responsiveness on actions
  async triggerImmediateScreenshot(id) {
    const s = this.sessions.get(id);
    if (!s || !s.page || s.isCapturing) return;
    s.isCapturing = true;
    try {
      const buf = await s.page.screenshot({
        type: 'jpeg',
        quality: 40,
        encoding: 'base64'
      });
      this.emit('screenshot', { id, screenshot: `data:image/jpeg;base64,${buf}` });
    } catch (_) {} finally {
      s.isCapturing = false;
    }
  }

  schedulePostActionScreenshots(primaryId) {
    setTimeout(async () => {
      await this.triggerImmediateScreenshot(primaryId);
      for (const id of this.sessions.keys()) {
        if (id !== primaryId) {
          this.triggerImmediateScreenshot(id);
        }
      }
    }, 120);
  }

  // ─── Broadcast to Fleet with Spintax, Targeting & Complete Awaiting ───────
  async broadcastMessage({ target = '', message = '', minDelay = 1000, maxDelay = 2500, simulateTyping = true }) {
    const activeSessions = Array.from(this.sessions.values()).filter(s => s.status === 'connected' && s.page);
    if (activeSessions.length === 0) {
      return { success: false, message: 'No connected WhatsApp Web sessions found.' };
    }

    const cleanPhone = target ? target.replace(/\D/g, '') : '';
    const results = [];

    this.emit('action_started', {
      type: 'broadcast',
      total: activeSessions.length,
      target: cleanPhone || 'Active Chats'
    });

    for (let i = 0; i < activeSessions.length; i++) {
      const s = activeSessions[i];
      const parsedText = AntiBanGuard.parseSpintax(message);

      try {
        if (cleanPhone) {
          // Accurate recipient routing using WhatsApp Web direct send URL
          await s.page.goto(`https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(parsedText)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });

          // Wait for send button or compose box
          const sendBtnSelector = 'span[data-icon="send"], button[aria-label="Send"], [data-testid="send"]';
          const sendBtn = await s.page.waitForSelector(sendBtnSelector, { timeout: 15000 }).catch(() => null);

          if (sendBtn) {
            await sendBtn.click().catch(() => {});
          } else {
            await s.page.keyboard.press('Enter').catch(() => {});
          }
        } else {
          // Send to currently open conversation on this instance
          const composeBox = await s.page.$('footer [contenteditable="true"], [data-testid="conversation-compose-box-input"]');
          if (composeBox) {
            await composeBox.click().catch(() => {});
            // Type full text and wait until complete
            await s.page.keyboard.type(parsedText, { delay: simulateTyping ? 25 : 5 });
            await s.page.keyboard.press('Enter').catch(() => {});
          } else {
            // Fallback: type directly and press Enter
            await s.page.keyboard.type(parsedText, { delay: simulateTyping ? 25 : 5 });
            await s.page.keyboard.press('Enter').catch(() => {});
          }
        }

        results.push({ id: s.id, status: 'sent', recipient: cleanPhone || 'Active Chat' });
        this.emit('action_progress', { current: i + 1, total: activeSessions.length, sessionId: s.id, status: 'sent' });
      } catch (err) {
        results.push({ id: s.id, status: 'failed', error: err.message });
        this.emit('action_progress', { current: i + 1, total: activeSessions.length, sessionId: s.id, status: 'failed' });
      }

      // Human Jitter Delay between sessions
      if (i < activeSessions.length - 1) {
        await AntiBanGuard.jitter(minDelay, maxDelay);
      }
    }

    this.emit('action_completed', { results });
    return { success: true, count: results.length, results };
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
    this.schedulePostActionScreenshots(masterId);
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
    this.schedulePostActionScreenshots(masterId);
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
    this.schedulePostActionScreenshots(masterId);
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
    this.schedulePostActionScreenshots(masterId);
  }

  // ─── Serialization ────────────────────────────────────────────────────────

  _sanitize(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      id: s.id,
      label: s.label,
      accountName: s.accountName || null,
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
