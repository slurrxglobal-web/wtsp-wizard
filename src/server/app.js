import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { SessionManager } from '../core/SessionManager.js';
import { ActionDispatcher } from '../core/ActionDispatcher.js';
import { PuppeteerFleet } from '../core/PuppeteerFleet.js';
import { AdbFleetBridge } from '../core/AdbFleetBridge.js';
import { setupSocketHandlers } from './socket.js';

const app = express();
const server = http.createServer(app);

// Security: Configurable CORS policy
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : (process.env.NODE_ENV === 'production' ? ['http://localhost:3000'] : '*');

const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const publicDir = path.resolve(process.cwd(), 'src', 'public');

// Security & Static Middleware
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Optional Studio API Key Protection (set STUDIO_API_KEY in environment for secure remote deployments)
const STUDIO_API_KEY = process.env.STUDIO_API_KEY;
if (STUDIO_API_KEY) {
  app.use('/api', (req, res, next) => {
    const key = req.headers['authorization'] || req.headers['x-api-key'] || req.query.apiKey;
    if (key === STUDIO_API_KEY || key === `Bearer ${STUDIO_API_KEY}`) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing STUDIO_API_KEY' });
  });
}

app.use(express.static(publicDir));

// Initialize Core Managers
const sessionManager = new SessionManager();      // Baileys — fast broadcast (headless fallback)
const actionDispatcher = new ActionDispatcher(sessionManager);
const puppeteerFleet = new PuppeteerFleet();      // Real WhatsApp Web sessions (Puppeteer)
const adbBridge = new AdbFleetBridge();           // Real WhatsApp Mobile sessions (BlueStacks / ADB)

// Start ADB background live screen capture
adbBridge.startStreaming(1400);

// Setup Socket.io real-time layer
setupSocketHandlers(io, sessionManager, actionDispatcher, adbBridge, puppeteerFleet);

// ── Puppeteer REST API ──────────────────────────────────────────────────────

// Get all real WhatsApp Web sessions
app.get('/api/puppet/sessions', (req, res) => {
  res.json({ success: true, sessions: puppeteerFleet.getAllSessions() });
});

// Create a new real WhatsApp Web session
app.post('/api/puppet/sessions', async (req, res) => {
  const { id, label } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    const session = await puppeteerFleet.createSession(id, label);
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch create Puppeteer sessions
app.post('/api/puppet/batch', async (req, res) => {
  const count = parseInt(req.body.count, 10) || 5;
  try {
    const sessions = await puppeteerFleet.batchCreate(count);
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all sessions
app.post('/api/puppet/clear', async (req, res) => {
  try {
    await puppeteerFleet.closeAllSessions();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Close a single Puppeteer session
app.delete('/api/puppet/sessions/:id', async (req, res) => {
  try {
    await puppeteerFleet.closeSession(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set master session
app.post('/api/puppet/master', (req, res) => {
  const { id } = req.body;
  puppeteerFleet.setMaster(id);
  res.json({ success: true, master: id });
});

// Mirror click (xPct, yPct as 0-100)
app.post('/api/puppet/click', async (req, res) => {
  const { masterId, xPct, yPct } = req.body;
  await puppeteerFleet.mirrorClick(masterId || puppeteerFleet.getMaster(), xPct, yPct);
  res.json({ success: true });
});

// Single click on a specific instance (No mirroring)
app.post('/api/puppet/single-click', async (req, res) => {
  const { id, xPct, yPct } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  await puppeteerFleet.singleClick(id, xPct, yPct);
  res.json({ success: true });
});

// Synchronized Broadcast across all connected instances
app.post('/api/puppet/broadcast', async (req, res) => {
  try {
    const result = await puppeteerFleet.broadcastMessage(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADB / BlueStacks REST API ───────────────────────────────────────────────

// Get all connected Android / BlueStacks devices
app.get('/api/adb/devices', (req, res) => {
  res.json({ success: true, devices: adbBridge.getAllDevices() });
});

// Scan for emulator instances and phones
app.post('/api/adb/scan', async (req, res) => {
  try {
    const devices = await adbBridge.scanDevices();
    res.json({ success: true, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mirror tap across all devices
app.post('/api/adb/tap', async (req, res) => {
  const { xPct, yPct, targetSerials } = req.body;
  const result = await adbBridge.mirrorTap(xPct, yPct, targetSerials);
  res.json(result);
});

// Single tap on specific device
app.post('/api/adb/single-tap', async (req, res) => {
  const { serial, xPct, yPct } = req.body;
  const result = await adbBridge.singleTap(serial, xPct, yPct);
  res.json(result);
});

// Mirror text typing
app.post('/api/adb/text', async (req, res) => {
  const { text, targetSerials } = req.body;
  const result = await adbBridge.mirrorText(text, targetSerials);
  res.json(result);
});

// Mirror Android key (Back: 4, Home: 3, Enter: 66, AppSwitch: 187)
app.post('/api/adb/key', async (req, res) => {
  const { keyCode, targetSerials } = req.body;
  const result = await adbBridge.mirrorKey(keyCode, targetSerials);
  res.json(result);
});

// Launch WhatsApp Mobile App directly
app.post('/api/adb/launch-wa', async (req, res) => {
  const { targetSerials } = req.body;
  const result = await adbBridge.launchWhatsApp(targetSerials);
  res.json(result);
});

// Set master device
app.post('/api/adb/master', (req, res) => {
  const { serial } = req.body;
  adbBridge.setMaster(serial);
  res.json({ success: true, master: serial });
});

// REST API Endpoints
app.get('/api/sessions', (req, res) => {
  res.json({ success: true, sessions: sessionManager.getAllSessions() });
});

app.get('/api/sessions/:id/chats', (req, res) => {
  const { id } = req.params;
  res.json({ success: true, chats: sessionManager.getSanitizedChats(id) });
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const { id } = req.params;
  const { jid } = req.query;
  res.json({ success: true, messages: sessionManager.getSanitizedMessages(id, jid) });
});

app.post('/api/sessions', async (req, res) => {
  const { id, label } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const session = await sessionManager.initSession(id, label);
    res.json({ success: true, session: sessionManager.getSanitizedSession(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const removed = await sessionManager.removeSession(id);
    res.json({ success: removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/actions/send', async (req, res) => {
  try {
    const result = await actionDispatcher.mirrorSendMessage(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/actions/join', async (req, res) => {
  try {
    const result = await actionDispatcher.mirrorJoinGroup(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/actions/react', async (req, res) => {
  try {
    const result = await actionDispatcher.mirrorReact(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Start Server
server.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`🧙‍♂️ Wtsp Wizard Server running at: http://localhost:${PORT}`);
  console.log(`======================================================\n`);

  // Restore any persistent sessions saved on disk
  await sessionManager.restoreSavedSessions();
});
