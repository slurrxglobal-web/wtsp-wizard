import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { SessionManager } from '../core/SessionManager.js';
import { ActionDispatcher } from '../core/ActionDispatcher.js';
import { AdbFleetBridge } from '../core/AdbFleetBridge.js';
import { setupSocketHandlers } from './socket.js';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const publicDir = path.resolve(process.cwd(), 'src', 'public');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

// Initialize Core Managers
const sessionManager = new SessionManager();
const actionDispatcher = new ActionDispatcher(sessionManager);
const adbBridge = new AdbFleetBridge();

// Setup Socket.io real-time layer
setupSocketHandlers(io, sessionManager, actionDispatcher, adbBridge);

// Start background ADB auto-polling for BlueStacks / Cloud Phones
adbBridge.startAutoPoll(4000);

// REST API Endpoints
app.get('/api/adb/devices', (req, res) => {
  res.json({ success: true, devices: adbBridge.getAllDevices() });
});

// Live screen capture for a specific ADB device
app.get('/api/adb/screen/:serial', async (req, res) => {
  const { serial } = req.params;
  const screenshot = await adbBridge.captureScreenshot(serial);
  if (!screenshot) {
    return res.status(503).json({ success: false, message: 'Screenshot failed or device offline' });
  }
  res.json({ success: true, serial, screenshot });
});

app.post('/api/adb/tap', async (req, res) => {
  const { xPct, yPct, targetSerials } = req.body;
  const result = await adbBridge.mirrorTap(xPct, yPct, targetSerials);
  res.json(result);
});

app.post('/api/adb/text', async (req, res) => {
  const { text, targetSerials } = req.body;
  const result = await adbBridge.mirrorText(text, targetSerials);
  res.json(result);
});

app.post('/api/adb/key', async (req, res) => {
  const { keyCode, targetSerials } = req.body;
  const result = await adbBridge.mirrorKey(keyCode, targetSerials);
  res.json(result);
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
