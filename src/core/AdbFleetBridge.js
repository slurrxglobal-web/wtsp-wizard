import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

export class AdbFleetBridge extends EventEmitter {
  constructor() {
    super();
    this.adbPath = this.resolveAdbBinary();
    this.devices = new Map(); // serial -> { serial, model, resolution: { width, height }, status }
    this.pollInterval = null;
    this.isPolling = false;

    console.log(`[AdbFleetBridge] Resolved ADB binary at: ${this.adbPath}`);
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
      if (p === 'adb') return 'adb';
      if (fs.existsSync(p)) return `"${p}"`;
    }
    return 'adb';
  }

  /**
   * Scans and returns connected ADB devices/emulators
   */
  async scanDevices() {
    try {
      const { stdout } = await execAsync(`${this.adbPath} devices -l`);
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      
      const foundSerials = new Set();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('device') && !line.includes('offline') && !line.includes('unauthorized')) {
          const parts = line.split(/\s+/);
          const serial = parts[0];
          foundSerials.add(serial);

          if (!this.devices.has(serial)) {
            // New device discovered
            const model = this.extractProp(line, 'model:') || (await this.fetchDeviceModel(serial));
            const resolution = await this.fetchDeviceResolution(serial);

            const devData = {
              serial,
              model: model || 'Android Device',
              resolution: resolution || { width: 1080, height: 1920 },
              status: 'online',
              type: 'android',
              connectedAt: Date.now()
            };

            this.devices.set(serial, devData);
            console.log(`[AdbFleetBridge] Discovered Android unit: ${serial} (${devData.model})`);
            this.emit('device_connected', devData);
          }
        }
      }

      // Check for disconnected devices
      for (const [serial] of this.devices) {
        if (!foundSerials.has(serial)) {
          this.devices.delete(serial);
          console.log(`[AdbFleetBridge] Device disconnected: ${serial}`);
          this.emit('device_disconnected', serial);
        }
      }

      this.emit('devices_updated', this.getAllDevices());
      return this.getAllDevices();
    } catch (err) {
      console.error('[AdbFleetBridge] Error scanning ADB devices:', err.message);
      return [];
    }
  }

  extractProp(line, key) {
    const match = line.match(new RegExp(`${key}([^\\s]+)`));
    return match ? match[1].replace(/_/g, ' ') : null;
  }

  async fetchDeviceModel(serial) {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} shell getprop ro.product.model`);
      return stdout.trim() || 'Android Emulator';
    } catch {
      return 'Android Emulator';
    }
  }

  async fetchDeviceResolution(serial) {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} shell wm size`);
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
   * Normalized Master Tap Sync across all (or specified) Android devices.
   * Maps relative coordinates (xPct: 0-100, yPct: 0-100) to each device's real resolution.
   */
  async mirrorTap(xPct, yPct, targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false, message: 'No Android devices connected' };

    const results = [];
    const promises = targets.map(async (serial) => {
      const dev = this.devices.get(serial);
      const width = dev?.resolution?.width || 1080;
      const height = dev?.resolution?.height || 1920;

      const realX = Math.round((xPct / 100) * width);
      const realY = Math.round((yPct / 100) * height);

      try {
        await execAsync(`${this.adbPath} -s ${serial} shell input tap ${realX} ${realY}`);
        results.push({ serial, success: true, x: realX, y: realY });
      } catch (err) {
        results.push({ serial, success: false, error: err.message });
      }
    });

    await Promise.all(promises);
    return { success: true, results };
  }

  /**
   * Mirrors keystrokes / text input across all Android devices.
   */
  async mirrorText(text, targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false };

    // Escape characters for ADB shell input
    const sanitized = text.replace(/([\\"'`$&*?|#()<>~;])/g, '\\$1').replace(/\s/g, '%s');

    const promises = targets.map(async (serial) => {
      try {
        await execAsync(`${this.adbPath} -s ${serial} shell input text "${sanitized}"`);
      } catch (err) {
        console.error(`[${serial}] ADB text error:`, err.message);
      }
    });

    await Promise.all(promises);
    return { success: true };
  }

  /**
   * Mirrors Android system keys (Back: 4, Home: 3, Enter: 66)
   */
  async mirrorKey(keyCode, targetSerials = null) {
    const targets = targetSerials && targetSerials.length > 0 
      ? targetSerials 
      : Array.from(this.devices.keys());

    if (targets.length === 0) return { success: false };

    const promises = targets.map(async (serial) => {
      try {
        await execAsync(`${this.adbPath} -s ${serial} shell input keyevent ${keyCode}`);
      } catch (err) {
        console.error(`[${serial}] ADB key error:`, err.message);
      }
    });

    await Promise.all(promises);
    return { success: true };
  }

  /**
   * Captures screen buffer as base64 PNG data URL
   */
  async captureScreenshot(serial) {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} exec-out screencap -p`, {
        encoding: 'buffer',
        maxBuffer: 10 * 1024 * 1024
      });
      return `data:image/png;base64,${stdout.toString('base64')}`;
    } catch (err) {
      return null;
    }
  }

  /**
   * Start auto-polling for device connects/disconnects (e.g. when BlueStacks starts)
   */
  startAutoPoll(intervalMs = 4000) {
    if (this.isPolling) return;
    this.isPolling = true;
    this.scanDevices();
    this.pollInterval = setInterval(() => this.scanDevices(), intervalMs);
  }

  stopAutoPoll() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.isPolling = false;
  }

  getAllDevices() {
    return Array.from(this.devices.values());
  }
}
