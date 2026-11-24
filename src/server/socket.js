export function setupSocketHandlers(io, sessionManager, actionDispatcher, adbBridge) {
  // Relay session events to all connected dashboard clients
  sessionManager.on('session_update', (session) => {
    io.emit('session_update', session);
  });

  sessionManager.on('session_removed', (sessionId) => {
    io.emit('session_removed', sessionId);
  });

  sessionManager.on('qr', ({ id, qr }) => {
    io.emit('session_qr', { id, qr });
  });

  sessionManager.on('action_started', (data) => {
    io.emit('action_started', data);
  });

  sessionManager.on('action_progress', (data) => {
    io.emit('action_progress', data);
  });

  sessionManager.on('action_completed', (data) => {
    io.emit('action_completed', data);
  });

  sessionManager.on('chats_updated', ({ id, chats }) => {
    io.emit('chats_updated', { id, chats });
  });

  sessionManager.on('messages_updated', ({ id, messages }) => {
    io.emit('messages_updated', { id, messages });
  });

  // Relay ADB events
  if (adbBridge) {
    adbBridge.on('devices_updated', (devices) => {
      io.emit('adb_devices_update', devices);
    });
  }

  io.on('connection', (socket) => {
    // Send full current session list, real chats, and ADB devices on connect
    socket.emit('initial_state', {
      sessions: sessionManager.getAllSessions(),
      chats: sessionManager.getAllChats(),
      messages: sessionManager.getAllMessages(),
      adbDevices: adbBridge ? adbBridge.getAllDevices() : []
    });

    // ADB Actions
    socket.on('adb_tap', async ({ xPct, yPct, targetSerials }) => {
      if (adbBridge) {
        await adbBridge.mirrorTap(xPct, yPct, targetSerials);
      }
    });

    socket.on('adb_text', async ({ text, targetSerials }) => {
      if (adbBridge) {
        await adbBridge.mirrorText(text, targetSerials);
      }
    });

    socket.on('adb_key', async ({ keyCode, targetSerials }) => {
      if (adbBridge) {
        await adbBridge.mirrorKey(keyCode, targetSerials);
      }
    });

    socket.on('adb_refresh', async () => {
      if (adbBridge) {
        const devices = await adbBridge.scanDevices();
        socket.emit('adb_devices_update', devices);
      }
    });

    // Create / Start session
    socket.on('create_session', async ({ id, label }) => {
      try {
        await sessionManager.initSession(id, label);
      } catch (err) {
        socket.emit('operation_error', { message: err.message, id });
      }
    });

    // Remove session
    socket.on('remove_session', async ({ id }) => {
      try {
        await sessionManager.removeSession(id);
      } catch (err) {
        socket.emit('operation_error', { message: err.message, id });
      }
    });

    // Clear all unpaired sessions
    socket.on('clear_unpaired', async () => {
      try {
        const count = await sessionManager.clearUnpairedSessions();
        socket.emit('initial_state', {
          sessions: sessionManager.getAllSessions()
        });
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    // Master mirror send action
    socket.on('mirror_send', async (payload) => {
      try {
        await actionDispatcher.mirrorSendMessage(payload);
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    // Master mirror group join action
    socket.on('mirror_join', async (payload) => {
      try {
        await actionDispatcher.mirrorJoinGroup(payload);
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });

    // Master mirror emoji reaction
    socket.on('mirror_react', async (payload) => {
      try {
        await actionDispatcher.mirrorReact(payload);
      } catch (err) {
        socket.emit('operation_error', { message: err.message });
      }
    });
  });
}
