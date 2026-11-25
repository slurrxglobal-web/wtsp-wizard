import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

// Standard emulator ADB ports: BlueStacks (5555, 5565...), LDPlayer (5555, 5557...), Nox (62001...)
const COMMON_EMULATOR_PORTS = [5555, 5565, 5575, 5585, 5595, 5605, 5615, 5625, 62001, 21503];

export class AdbFleetBridge extends EventEmitter {
  constructor() {
    super();
    this.adbPath = this.resolveAdbBinary();
    this.devices = new Map(); // serial -> { serial, model, resolution: { width, height }, status, isCapturing }
    this.masterSerial = null;
    this.streamInterval = null;
    this.isStreaming = false;

    console.log(`[AdbFleetBridge] Initialized ADB bridge using binary: ${this.adbPath}`);
  }

  /**
   * Resolves available ADB executable path (BlueStacks HD-Adb or System ADB)
   */
  resolveAdbBinary() {
    const candidates = [
      'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
      'C:\\Program Files\\BlueStacks\\HD-Adb.exe',
      'adb'
    ];

    for (const p of candidates) {
      if (p !== 'adb' && fs.existsSync(p)) {
        return `"${p}"`;
      }
    }
    return 'adb';
  }

  /**
   * Auto-connects to localhost emulator ports and scans for devices
   */
  async scanDevices() {
    // 1. Proactively connect to localhost emulator ports
    for (const port of COMMON_EMULATOR_PORTS) {
      try {
        await execAsync(`${this.adbPath} connect 127.0.0.1:${port}`, { timeout: 1000 });
      } catch (_) {}
    }

    // 2. Fetch list of connected devices
    try {
      const { stdout } = await execAsync(`${this.adbPath} devices -l`, { timeout: 5000 });
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const foundSerials = new Set();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('device') && !line.includes('offline') && !line.includes('unauthorized')) {
          const parts = line.split(/\s+/);
          const serial = parts[0];
          foundSerials.add(serial);

          if (!this.devices.has(serial)) {
            const model = this.extractProp(line, 'model:') || (await this.fetchDeviceModel(serial));
            const resolution = await this.fetchDeviceResolution(serial);

            const devData = {
              serial,
              model: model || 'Android Device',
              resolution: resolution || { width: 1080, height: 1920 },
              status: 'online',
              type: 'android',
              isCapturing: false,
              connectedAt: Date.now()
            };

            this.devices.set(serial, devData);
            console.log(`[AdbFleetBridge] Discovered Android unit: ${serial} (${devData.model})`);
            this.emit('device_connected', devData);
          }
        }
      }

      // 3. Clean up disconnected devices
      for (const [serial] of this.devices) {
        if (!foundSerials.has(serial)) {
          this.devices.delete(serial);
          console.log(`[AdbFleetBridge] Device disconnected: ${serial}`);
          this.emit('device_disconnected', serial);
        }
      }

      // Auto-elect Master if none set
      if (!this.masterSerial || !this.devices.has(this.masterSerial)) {
        const remaining = Array.from(this.devices.keys());
        this.masterSerial = remaining.length > 0 ? remaining[0] : null;
      }

      const all = this.getAllDevices();
      this.emit('devices_updated', all);
      return all;
    } catch (err) {
      console.error('[AdbFleetBridge] Error scanning ADB devices:', err.message);
      return this.getAllDevices();
    }
  }

  setMaster(serial) {
    if (this.devices.has(serial)) {
      this.masterSerial = serial;
      this.emit('master_changed', serial);
      console.log(`[AdbFleetBridge] ⭐ Master Android device set to: ${serial}`);
    }
  }

  getMaster() {
    return this.masterSerial;
  }

  extractProp(line, key) {
    const match = line.match(new RegExp(`${key}([^\\s]+)`));
    return match ? match[1].replace(/_/g, ' ') : null;
  }

  async fetchDeviceModel(serial) {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} shell getprop ro.product.model`, { timeout: 2000 });
      return stdout.trim() || 'Android Emulator';
    } catch {
      return 'Android Emulator';
    }
  }

  async fetchDeviceResolution(serial) {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} shell wm size`, { timeout: 2000 });
      const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/);
      if (match) {
        return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
      }
    } catch {
      // ignore
    }
    return { width: 1080, height: 1920 };
  }

  /**
   * Single Tap on a specific Android device (No Mirroring)
   */
  async singleTap(serial, xPct, yPct) {
    const dev = this.devices.get(serial);
    if (!dev) return { success: false, message: 'Device not found' };

    const width = dev.resolution?.width || 1080;
    const height = dev.resolution?.height || 1920;
    const realX = Math.round((xPct / 100) * width);
    const realY = Math.round((yPct / 100) * height);

    try {
      await execAsync(`${this.adbPath} -s ${serial} shell input tap ${realX} ${realY}`);
      this.schedulePostActionCapture(serial);
      return { success: true, serial, x: realX, y: realY };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Normalized Master Tap Sync across all (or specified) Android devices.
   */
  async mirrorTap(xPct, yPct, targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false, message: 'No Android devices connected' };

    const promises = targets.map(async (serial) => {
      const dev = this.devices.get(serial);
      const width = dev?.resolution?.width || 1080;
      const height = dev?.resolution?.height || 1920;
      const realX = Math.round((xPct / 100) * width);
      const realY = Math.round((yPct / 100) * height);

      try {
        await execAsync(`${this.adbPath} -s ${serial} shell input tap ${realX} ${realY}`);
      } catch (_) {}
    });

    await Promise.all(promises);
    this.schedulePostActionCapture(this.masterSerial);
    return { success: true };
  }

  /**
   * Mirrors keystrokes / text input across all Android devices.
   */
  async mirrorText(text, targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false };

    // Escape special shell characters for input text
    const sanitized = text.replace(/([\\"'`$&*?|#()<>~;])/g, '\\$1').replace(/\s/g, '%s');

    const promises = targets.map(async (serial) => {
      try {
        await execAsync(`${this.adbPath} -s ${serial} shell input text "${sanitized}"`);
      } catch (_) {}
    });

    await Promise.all(promises);
    this.schedulePostActionCapture(this.masterSerial);
    return { success: true };
  }

  /**
   * Mirrors Android system keys (Back: 4, Home: 3, Enter: 66, AppSwitch: 187, Backspace: 67)
   */
  async mirrorKey(keyCode, targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false };

    const promises = targets.map(async (serial) => {
      try {
        await execAsync(`${this.adbPath} -s ${serial} shell input keyevent ${keyCode}`);
      } catch (_) {}
    });

    await Promise.all(promises);
    this.schedulePostActionCapture(this.masterSerial);
    return { success: true };
  }

  /**
   * Mirrors swipe gestures (scroll / drag)
   */
  async mirrorSwipe(x1Pct, y1Pct, x2Pct, y2Pct, durationMs = 300, targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false };

    const promises = targets.map(async (serial) => {
      const dev = this.devices.get(serial);
      const width = dev?.resolution?.width || 1080;
      const height = dev?.resolution?.height || 1920;

      const x1 = Math.round((x1Pct / 100) * width);
      const y1 = Math.round((y1Pct / 100) * height);
      const x2 = Math.round((x2Pct / 100) * width);
      const y2 = Math.round((y2Pct / 100) * height);

      try {
        await execAsync(`${this.adbPath} -s ${serial} shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
      } catch (_) {}
    });

    await Promise.all(promises);
    this.schedulePostActionCapture(this.masterSerial);
    return { success: true };
  }

  /**
   * Launch WhatsApp Mobile App directly on Android devices
   */
  async launchWhatsApp(targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false, message: 'No devices connected' };

    const promises = targets.map(async (serial) => {
      try {
        await execAsync(`${this.adbPath} -s ${serial} shell monkey -p com.whatsapp -c android.intent.category.LAUNCHER 1`);
      } catch (_) {}
    });

    await Promise.all(promises);
    this.schedulePostActionCapture(this.masterSerial);
    return { success: true, count: targets.length };
  }

  /**
   * Captures screen buffer as base64 PNG data URL with lock protection
   */
  async captureScreenshot(serial) {
    const dev = this.devices.get(serial);
    if (!dev || dev.isCapturing) return null;

    dev.isCapturing = true;
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} exec-out screencap -p`, {
        encoding: 'buffer',
        maxBuffer: 15 * 1024 * 1024,
        timeout: 4000
      });
      return `data:image/png;base64,${stdout.toString('base64')}`;
    } catch (_) {
      return null;
    } finally {
      if (dev) dev.isCapturing = false;
    }
  }

  /**
   * Immediate screen capture following a tap/key/text event
   */
  schedulePostActionCapture(primarySerial) {
    setTimeout(async () => {
      if (primarySerial) {
        const frame = await this.captureScreenshot(primarySerial);
        if (frame) this.emit('screenshot', { serial: primarySerial, screenshot: frame });
      }
      for (const serial of this.devices.keys()) {
        if (serial !== primarySerial) {
          const frame = await this.captureScreenshot(serial);
          if (frame) this.emit('screenshot', { serial, screenshot: frame });
        }
      }
    }, 150);
  }

  /**
   * Starts background streaming of live screens to connected clients
   */
  startStreaming(intervalMs = 1200) {
    if (this.isStreaming) return;
    this.isStreaming = true;

    let tick = 0;
    const poll = async () => {
      tick++;
      for (const [serial, dev] of this.devices) {
        const isMaster = (serial === this.masterSerial);
        // Slaves refresh every 2 ticks (~2.4s) to conserve CPU
        if (!isMaster && tick % 2 !== 0) continue;

        try {
          const frame = await this.captureScreenshot(serial);
          if (frame) {
            this.emit('screenshot', { serial, screenshot: frame });
          }
        } catch (_) {}
      }
    };

    this.streamInterval = setInterval(poll, intervalMs);
    // Initial scan and stream
    this.scanDevices().then(() => poll());
  }

  stopStreaming() {
    if (this.streamInterval) {
      clearInterval(this.streamInterval);
      this.streamInterval = null;
    }
    this.isStreaming = false;
  }

  getAllDevices() {
    return Array.from(this.devices.values()).map(d => ({
      serial: d.serial,
      model: d.model,
      resolution: d.resolution,
      status: d.status,
      type: 'android',
      isMaster: (d.serial === this.masterSerial)
    }));
  }
}
