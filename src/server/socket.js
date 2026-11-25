export function setupSocketHandlers(io, sessionManager, actionDispatcher, adbBridge, puppeteerFleet) {

  // ── Baileys (fast broadcast) session events ────────────────────────────────
  sessionManager.on('session_update', (session) => {
    io.emit('session_update', session);
  });

  sessionManager.on('session_removed', (sessionId) => {
    io.emit('session_removed', sessionId);
  });

  sessionManager.on('qr', ({ id, qr }) => {
    io.emit('session_qr', { id, qr });
  });

  sessionManager.on('action_started',   (data) => io.emit('action_started', data));
  sessionManager.on('action_progress',  (data) => io.emit('action_progress', data));
  sessionManager.on('action_completed', (data) => io.emit('action_completed', data));
  sessionManager.on('chats_updated',    ({ id, chats }) => io.emit('chats_updated', { id, chats }));
  sessionManager.on('messages_updated', ({ id, messages }) => io.emit('messages_updated', { id, messages }));

  // ── ADB events ────────────────────────────────────────────────────────────
  if (adbBridge) {
    adbBridge.on('devices_updated', (devices) => {
      io.emit('adb_devices_update', devices);
    });
  }

  // ── Puppeteer (Real WhatsApp Web) events ──────────────────────────────────
  if (puppeteerFleet) {
    // Stream screenshots to ALL connected dashboard clients
    puppeteerFleet.on('screenshot', ({ id, screenshot }) => {
      io.emit('puppet_screenshot', { id, screenshot });
    });

    puppeteerFleet.on('session_update', (session) => {
      io.emit('puppet_session_update', session);
    });

    puppeteerFleet.on('session_removed', (id) => {
      io.emit('puppet_session_removed', id);
    });

    puppeteerFleet.on('action_started', (data) => {
      io.emit('action_started', data);
    });

    puppeteerFleet.on('action_progress', (data) => {
      io.emit('action_progress', data);
    });

    puppeteerFleet.on('action_completed', (data) => {
      io.emit('action_completed', data);
    });
  }

  // ── Socket connection handler ─────────────────────────────────────────────
  io.on('connection', (socket) => {
    // Send full state on fresh connect
    socket.emit('initial_state', {
      sessions:       sessionManager.getAllSessions(),
      chats:          sessionManager.getAllChats(),
      messages:       sessionManager.getAllMessages(),
      adbDevices:     adbBridge     ? adbBridge.getAllDevices()       : [],
      puppetSessions: puppeteerFleet ? puppeteerFleet.getAllSessions() : []
    });

    // ── Puppeteer socket events ─────────────────────────────────────────────

    socket.on('puppet_create', async ({ id, label }) => {
      try {
        if (!puppeteerFleet) return;
        await puppeteerFleet.createSession(id, label);
        socket.emit('puppet_session_update', puppeteerFleet._sanitize(id));
      } catch (err) {
        socket.emit('operation_error', { message: `Puppeteer: ${err.message}` });
      }
    });

    socket.on('puppet_batch', async ({ count = 5 }) => {
      try {
        if (!puppeteerFleet) return;
        await puppeteerFleet.batchCreate(count);
      } catch (err) {
        socket.emit('operation_error', { message: `Puppeteer Batch: ${err.message}` });
      }
    });

    socket.on('puppet_clear_all', async () => {
      try {
        if (!puppeteerFleet) return;
        await puppeteerFleet.closeAllSessions();
        io.emit('initial_state', {
          sessions: sessionManager.getAllSessions(),
          chats: sessionManager.getAllChats(),
          messages: sessionManager.getAllMessages(),
          adbDevices: [],
          puppetSessions: []
        });
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    socket.on('puppet_close', async ({ id }) => {
      try {
        if (!puppeteerFleet) return;
        await puppeteerFleet.closeSession(id);
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    socket.on('puppet_set_master', ({ id }) => {
      if (puppeteerFleet) puppeteerFleet.setMaster(id);
    });

    // Master click → mirror to all slaves
    socket.on('puppet_click', async ({ masterId, xPct, yPct }) => {
      if (!puppeteerFleet) return;
      const master = masterId || puppeteerFleet.getMaster();
      await puppeteerFleet.mirrorClick(master, xPct, yPct);
    });

    // Single click on a specific session (No mirroring)
    socket.on('puppet_single_click', async ({ id, xPct, yPct }) => {
      if (!puppeteerFleet || !id) return;
      await puppeteerFleet.singleClick(id, xPct, yPct);
    });

    // Master type → mirror to all slaves
    socket.on('puppet_type', async ({ masterId, text }) => {
      if (!puppeteerFleet) return;
      const master = masterId || puppeteerFleet.getMaster();
      await puppeteerFleet.mirrorType(master, text);
    });

    // Master key press → mirror to all slaves
    socket.on('puppet_key', async ({ masterId, key }) => {
      if (!puppeteerFleet) return;
      const master = masterId || puppeteerFleet.getMaster();
      await puppeteerFleet.mirrorKey(master, key);
    });

    // Master scroll → mirror to all slaves
    socket.on('puppet_scroll', async ({ masterId, xPct, yPct, deltaY }) => {
      if (!puppeteerFleet) return;
      const master = masterId || puppeteerFleet.getMaster();
      await puppeteerFleet.mirrorScroll(master, xPct, yPct, deltaY);
    });

    // Robust broadcast to all connected WhatsApp Web instances
    socket.on('puppet_broadcast', async (payload) => {
      if (!puppeteerFleet) return;
      try {
        await puppeteerFleet.broadcastMessage(payload);
      } catch (err) {
        socket.emit('operation_error', { message: `Broadcast: ${err.message}` });
      }
    });

    // ── Baileys session events ──────────────────────────────────────────────

    socket.on('create_session', async ({ id, label }) => {
      try {
        await sessionManager.initSession(id, label);
      } catch (err) {
        socket.emit('operation_error', { message: err.message, id });
      }
    });

    socket.on('remove_session', async ({ id }) => {
      try {
        await sessionManager.removeSession(id);
      } catch (err) {
        socket.emit('operation_error', { message: err.message, id });
      }
    });

    socket.on('clear_unpaired', async () => {
      try {
        await sessionManager.clearUnpairedSessions();
        socket.emit('initial_state', { sessions: sessionManager.getAllSessions() });
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    socket.on('mirror_send', async (payload) => {
      try {
        await actionDispatcher.mirrorSendMessage(payload);
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    socket.on('mirror_join', async (payload) => {
      try {
        await actionDispatcher.mirrorJoinGroup(payload);
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    socket.on('mirror_react', async (payload) => {
      try {
        await actionDispatcher.mirrorReact(payload);
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    socket.on('disconnect', () => {
      for (const [, id] of screenPollers) clearInterval(id);
      screenPollers.clear();
    });
  });
}
