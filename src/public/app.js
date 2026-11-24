// Studio Socket.io Client & Master-Slave Mirror Engine
const socket = io();

// State
let sessionsState = new Map();
let currentQRModalId = null;
let masterSessionId = null;
let selectedEmoji = '❤️';

// Real WhatsApp Chat and Message Stores synced from Baileys
const realChatsState = new Map(); // sessionId -> Array of real chats [{ id, name, lastMsg, time, unread }]
const realMessagesState = new Map(); // sessionId -> Object { jid: Array of messages }
const instanceChatState = new Map(); // sessionId -> { activeContact: null, messages: [] }

function getAvatarInitials(name) {
  if (!name) return 'WA';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getSessionChats(sessionId) {
  const chats = realChatsState.get(sessionId);
  if (chats && Array.isArray(chats) && chats.length > 0) {
    return chats.map(c => ({
      id: c.id,
      name: c.name || c.id.split('@')[0],
      avatar: getAvatarInitials(c.name || c.id),
      phone: c.id.replace(/\D/g, ''),
      lastMsg: c.lastMsg || '',
      time: c.time || ''
    }));
  }
  return [];
}

// DOM Elements
const totalUnitsCountEl = document.getElementById('totalUnitsCount');
const activeUnitsCountEl = document.getElementById('activeUnitsCount');
const activeFilterCountEl = document.getElementById('activeFilterCount');
const fleetStatusTextEl = document.getElementById('fleetStatusText');
const phoneFarmGridEl = document.getElementById('phoneFarmGrid');
const feedStreamEl = document.getElementById('feedStream');
const themeSelectorEl = document.getElementById('themeSelector');

// Console Drawer Elements
const commandConsoleEl = document.getElementById('commandConsole');
const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');
const collapseConsoleBtn = document.getElementById('collapseConsoleBtn');

// Action Inputs & Buttons
const targetRecipientInput = document.getElementById('targetRecipient');
const broadcastMessageInput = document.getElementById('broadcastMessage');
const minJitterInput = document.getElementById('minJitter');
const maxJitterInput = document.getElementById('maxJitter');
const humanTypingCheck = document.getElementById('humanTypingCheck');

const fireBroadcastBtn = document.getElementById('fireBroadcastBtn');
const addSingleUnitBtn = document.getElementById('addSingleUnitBtn');
const addBatchUnitsBtn = document.getElementById('addBatchUnitsBtn');
const clearUnpairedBtn = document.getElementById('clearUnpairedBtn');

// Modal Elements
const phoneDetailModalEl = document.getElementById('phoneDetailModal');
const modalDeviceLabelEl = document.getElementById('modalDeviceLabel');
const modalQRImgEl = document.getElementById('modalQRImg');
const closePhoneModalBtn = document.getElementById('closePhoneModalBtn');

// 1. Theme Engine
function initTheme() {
  const savedTheme = localStorage.getItem('wtsp_wizard_theme') || 'midnight';
  document.documentElement.setAttribute('data-theme', savedTheme);
  if (themeSelectorEl) {
    themeSelectorEl.value = savedTheme;
  }
}

themeSelectorEl.addEventListener('change', (e) => {
  const newTheme = e.target.value;
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('wtsp_wizard_theme', newTheme);
  logFeed(`Applied visual theme: ${newTheme.toUpperCase()}`);
});

initTheme();

// 2. Feed Logger
function logFeed(msg) {
  const time = new Date().toLocaleTimeString();
  feedStreamEl.textContent = `[${time}] ${msg}`;
}

// 3. Console Toggle & Keyboard Shortcut
function toggleConsole() {
  commandConsoleEl.classList.toggle('collapsed');
}

toggleConsoleBtn.addEventListener('click', toggleConsole);
collapseConsoleBtn.addEventListener('click', toggleConsole);

document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'c' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    toggleConsole();
  }
});

// 4. Numeric ID Formatter
function getNumericId(id, fallbackIndex) {
  const digits = id.replace(/\D/g, '');
  return digits ? digits.padStart(2, '0') : String(fallbackIndex + 1).padStart(2, '0');
}

// 5. Render Phone Farm Device Grid
function renderDeviceGrid() {
  const sessions = Array.from(sessionsState.values());
  const connectedCount = sessions.filter(s => s.status === 'connected').length;

  totalUnitsCountEl.textContent = sessions.length;
  activeUnitsCountEl.textContent = connectedCount;
  activeFilterCountEl.textContent = `${connectedCount} / ${sessions.length} online`;

  if (masterSessionId && !sessionsState.has(masterSessionId)) {
    masterSessionId = null;
  }

  // Auto-elect first connected device as Master if none selected
  if (!masterSessionId && connectedCount > 0) {
    const firstConnected = sessions.find(s => s.status === 'connected');
    if (firstConnected) masterSessionId = firstConnected.id;
  }

  if (connectedCount > 0) {
    fleetStatusTextEl.innerHTML = `
      <div class="sync-status-badge">
        <span class="sync-dot"></span>
        <span>SYNC ACTIVE // MASTER: ${masterSessionId ? masterSessionId.toUpperCase() : 'NONE'}</span>
      </div>
    `;
  } else {
    fleetStatusTextEl.innerHTML = `<span class="status-indicator">STANDBY</span>`;
  }

  if (sessions.length === 0) {
    phoneFarmGridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px 16px; color: var(--text-muted);">
        <p style="font-weight: 500;">No devices initialized.</p>
        <p style="font-size: 11px; margin-top: 4px;">Click <strong>+ Add Device</strong> or <strong>+ Batch (5)</strong> to spawn instances.</p>
      </div>
    `;
    return;
  }

  phoneFarmGridEl.innerHTML = '';
  sessions.forEach((session, index) => {
    const numId = getNumericId(session.id, index);
    const isConnected = session.status === 'connected';
    const isQrReady = session.status === 'qr_ready';
    const isMaster = session.id === masterSessionId;

    if (!instanceChatState.has(session.id)) {
      instanceChatState.set(session.id, {
        activeContact: null,
        messages: [
          { text: 'Instance ready for commands.', type: 'incoming', time: '10:30' }
        ]
      });
    }

    const state = instanceChatState.get(session.id);
    const card = document.createElement('div');
    card.className = `device-card ${isMaster ? 'is-master' : ''}`;
    card.id = `device-card-${session.id}`;

    const statusTag = isConnected ? 'online' : isQrReady ? 'standby' : 'offline';
    const statusLabel = isConnected ? 'Online' : isQrReady ? 'Ready' : 'Offline';

    card.innerHTML = `
      <!-- Phone Top Bar -->
      <div class="device-card-header">
        <div class="instance-label">
          <span>Unit ${numId}</span>
          <span class="master-indicator">MASTER</span>
        </div>
        <span class="instance-tag tag-${statusTag}">${statusLabel}</span>
      </div>

      <!-- Phone Screen Viewport -->
      <div class="phone-screen-viewport" id="viewport-${session.id}">
        <!-- Virtual Ghost Cursor for slave screens -->
        <div class="ghost-cursor" id="cursor-${session.id}"></div>

        <!-- System Clock & Status Bar -->
        <div class="phone-system-bar">
          <span>10:42</span>
          <span>4G • 98%</span>
        </div>

        ${isConnected ? `
          <!-- WhatsApp App Header -->
          <div class="wa-app-header">
            <span class="wa-app-title">WhatsApp</span>
            <div class="wa-header-actions">
              <span>🔍</span>
              <span>⋮</span>
            </div>
          </div>

          <!-- View A: Chats List View -->
          <div class="wa-chats-view ${state.activeContact ? 'hidden' : ''}" id="chats-view-${session.id}" style="${state.activeContact ? 'display: none;' : ''}">
            ${(() => {
              const chats = getSessionChats(session.id);
              if (chats.length === 0) {
                return `
                  <div style="padding: 30px 12px; text-align: center; color: var(--text-muted); font-size: 10px;">
                    <p style="font-weight: 500; color: var(--text-secondary);">Syncing Real WhatsApp Chats...</p>
                    <p style="margin-top: 4px; font-size: 8px;">Recent chats appear automatically.</p>
                  </div>
                `;
              }
              return chats.map((c, cIdx) => `
                <div class="wa-chat-item ${state.activeContact?.id === c.id ? 'active' : ''}" data-session="${session.id}" data-contact-idx="${cIdx}">
                  <div class="chat-avatar">${c.avatar}</div>
                  <div class="chat-info">
                    <div class="chat-name-row">
                      <span class="chat-name">${c.name}</span>
                      <span class="chat-time">${c.time}</span>
                    </div>
                    <div class="chat-last-msg">${c.lastMsg || 'Tap to open chat'}</div>
                  </div>
                </div>
              `).join('');
            })()}
          </div>

          <!-- View B: Conversation Screen -->
          <div class="wa-conversation-view ${state.activeContact ? 'active' : ''}" id="conv-view-${session.id}">
            <div class="conv-header">
              <button class="conv-back-btn" data-session="${session.id}">&lsaquo;</button>
              <div class="chat-avatar" style="width: 20px; height: 20px; font-size: 9px;" id="conv-avatar-${session.id}">
                ${state.activeContact ? state.activeContact.avatar : 'WA'}
              </div>
              <span class="conv-contact-name" id="conv-title-${session.id}">
                ${state.activeContact ? state.activeContact.name : 'Select Chat'}
              </span>
            </div>

            <div class="conv-messages-scroll" id="conv-msgs-${session.id}">
              ${state.messages.map(m => `
                <div class="msg-bubble ${m.type}">
                  ${m.text}
                  <div class="msg-meta">${m.time} &#10003;&#10003;</div>
                </div>
              `).join('')}
            </div>

            <div class="conv-input-bar">
              <input type="text" class="conv-input" id="input-${session.id}" placeholder="Type a message..." data-session="${session.id}">
              <button class="conv-send-btn" id="send-${session.id}" data-session="${session.id}">&#10148;</button>
            </div>
          </div>
        ` : `
          <!-- Unpaired Screen -->
          <div class="phone-unpaired-screen">
            <div class="unpaired-icon">💬</div>
            <div class="unpaired-title">WhatsApp Unpaired</div>
            <div class="unpaired-subtitle">Scan QR code to activate this phone instance</div>
            ${isQrReady ? `
              <button class="btn btn-primary qr-action-btn" data-id="${session.id}" style="font-size: 11px;">
                Pair QR Code
              </button>
            ` : `
              <button class="btn btn-secondary reconnect-action-btn" data-id="${session.id}" style="font-size: 11px;">
                Connect Instance
              </button>
            `}
          </div>
        `}
      </div>

      <!-- Phone Bottom Controls -->
      <div class="device-card-footer">
        ${isConnected ? `
          <button class="btn-card btn-master ${isMaster ? 'is-active' : ''} master-toggle-btn" data-id="${session.id}">
            ${isMaster ? '★ Master' : 'Set Master'}
          </button>
        ` : isQrReady ? `
          <button class="btn-card highlight qr-action-btn" data-id="${session.id}">Pair QR</button>
        ` : `
          <button class="btn-card reconnect-action-btn" data-id="${session.id}">Connect</button>
        `}
        <button class="btn-card danger delete-action-btn" data-id="${session.id}" title="Remove Instance">&times;</button>
      </div>
    `;

    phoneFarmGridEl.appendChild(card);
  });

  attachInteractiveEvents();
}

// 6. Master-Slave Interactive Event Mirroring
function attachInteractiveEvents() {
  // Master selection toggle
  document.querySelectorAll('.master-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      masterSessionId = id;
      logFeed(`⭐ DESIGNATED MASTER CONTROLLER: ${id.toUpperCase()}`);
      renderDeviceGrid();
    });
  });

  // Attach Master Cursor & Interaction Listener
  if (masterSessionId) {
    const masterViewport = document.getElementById(`viewport-${masterSessionId}`);
    if (masterViewport) {
      // Mouse move cursor mirror
      masterViewport.addEventListener('mousemove', (e) => {
        const rect = masterViewport.getBoundingClientRect();
        const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

        // Replicate ghost cursor to all slave devices
        document.querySelectorAll('.ghost-cursor').forEach(cursor => {
          const card = cursor.closest('.device-card');
          if (card && card.id !== `device-card-${masterSessionId}`) {
            cursor.style.left = `${xPct}%`;
            cursor.style.top = `${yPct}%`;
            cursor.classList.add('visible');
          }
        });
      });

      masterViewport.addEventListener('mouseleave', () => {
        document.querySelectorAll('.ghost-cursor').forEach(cursor => {
          cursor.classList.remove('visible');
        });
      });
    }
  }

  // Chat Item Click (Selecting contact in WhatsApp)
  document.querySelectorAll('.wa-chat-item').forEach(item => {
    item.addEventListener('click', () => {
      const sessionId = item.getAttribute('data-session');
      const contactIdx = parseInt(item.getAttribute('data-contact-idx'), 10);
      const chats = getSessionChats(sessionId);
      const contact = chats[contactIdx];
      if (!contact) return;

      // If clicked on Master phone, mirror open to ALL devices!
      if (sessionId === masterSessionId) {
        logFeed(`Master opened [${contact.name}] -> Synchronizing all devices.`);
        sessionsState.forEach((s) => {
          if (s.status === 'connected') {
            const sChats = getSessionChats(s.id);
            const targetContact = sChats[contactIdx] || contact;
            openConversationView(s.id, targetContact);
          }
        });
      } else {
        openConversationView(sessionId, contact);
      }
    });
  });

  // Back Button Click in Conversation View
  document.querySelectorAll('.conv-back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sessionId = btn.getAttribute('data-session');
      if (sessionId === masterSessionId) {
        logFeed(`Master backed out -> Returning all devices to chat list.`);
        sessionsState.forEach((s) => {
          if (s.status === 'connected') {
            closeConversationView(s.id);
          }
        });
      } else {
        closeConversationView(sessionId);
      }
    });
  });

  // Real-Time Keystroke Mirroring on Message Input
  document.querySelectorAll('.conv-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const sessionId = input.getAttribute('data-session');
      if (sessionId === masterSessionId) {
        const text = e.target.value;
        // Mirror keystrokes to all slave inputs!
        document.querySelectorAll('.conv-input').forEach(otherInput => {
          if (otherInput !== input) {
            otherInput.value = text;
          }
        });
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const sessionId = input.getAttribute('data-session');
        handleSendMessage(sessionId);
      }
    });
  });

  // Send Button Click
  document.querySelectorAll('.conv-send-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sessionId = btn.getAttribute('data-session');
      handleSendMessage(sessionId);
    });
  });

  // Standard Action Buttons
  document.querySelectorAll('.qr-action-btn').forEach(btn => {
    btn.addEventListener('click', () => openQRModal(btn.getAttribute('data-id')));
  });

  document.querySelectorAll('.reconnect-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      socket.emit('create_session', { id, label: id });
      logFeed(`Reconnecting instance ${id}...`);
    });
  });

  document.querySelectorAll('.delete-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (confirm(`Remove instance ${id}?`)) {
        socket.emit('remove_session', { id });
        logFeed(`Removed instance ${id}`);
      }
    });
  });
}

// 7. Conversation View Helper Functions
function openConversationView(sessionId, contact) {
  const state = instanceChatState.get(sessionId) || { activeContact: null, messages: [] };
  state.activeContact = contact;

  // Retrieve real historical messages for this contact if available
  const realMsgs = realMessagesState.get(sessionId)?.[contact.id];
  if (realMsgs && Array.isArray(realMsgs) && realMsgs.length > 0) {
    state.messages = realMsgs;
  } else {
    state.messages = [
      { text: `Chat with ${contact.name}`, type: 'incoming', time: 'now' }
    ];
  }
  instanceChatState.set(sessionId, state);

  const chatsView = document.getElementById(`chats-view-${sessionId}`);
  const convView = document.getElementById(`conv-view-${sessionId}`);
  const titleEl = document.getElementById(`conv-title-${sessionId}`);
  const avatarEl = document.getElementById(`conv-avatar-${sessionId}`);
  const msgsContainer = document.getElementById(`conv-msgs-${sessionId}`);

  if (chatsView) chatsView.style.display = 'none';
  if (convView) convView.classList.add('active');
  if (titleEl) titleEl.textContent = contact.name;
  if (avatarEl) avatarEl.textContent = contact.avatar;

  if (msgsContainer) {
    msgsContainer.innerHTML = state.messages.map(m => `
      <div class="msg-bubble ${m.type}">
        ${m.text}
        <div class="msg-meta">${m.time} &#10003;&#10003;</div>
      </div>
    `).join('');
    msgsContainer.scrollTop = msgsContainer.scrollHeight;
  }
}

function closeConversationView(sessionId) {
  const state = instanceChatState.get(sessionId);
  if (state) state.activeContact = null;

  const chatsView = document.getElementById(`chats-view-${sessionId}`);
  const convView = document.getElementById(`conv-view-${sessionId}`);

  if (chatsView) chatsView.style.display = 'flex';
  if (convView) convView.classList.remove('active');
}

// 8. Synchronized Message Dispatch Handler
function handleSendMessage(sourceSessionId) {
  const inputEl = document.getElementById(`input-${sourceSessionId}`);
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;

  const isMaster = sourceSessionId === masterSessionId;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isMaster) {
    logFeed(`🚀 MASTER FIRED MESSAGE: "${text}" -> Synchronizing across all devices!`);

    // Add message bubble to ALL connected device screens!
    sessionsState.forEach((s) => {
      if (s.status === 'connected') {
        appendMessageToScreen(s.id, text, 'outgoing', time);
        const slaveInput = document.getElementById(`input-${s.id}`);
        if (slaveInput) slaveInput.value = '';
      }
    });

    // Also dispatch to actual WhatsApp recipient via backend!
    const activeContact = instanceChatState.get(sourceSessionId)?.activeContact;
    const targetPhone = activeContact ? (activeContact.id || activeContact.phone) : targetRecipientInput.value.trim();

    if (targetPhone) {
      socket.emit('mirror_send', {
        target: targetPhone,
        message: text,
        minDelay: 800,
        maxDelay: 2000,
        simulateTyping: true
      });
    }
  } else {
    // Send single from slave
    appendMessageToScreen(sourceSessionId, text, 'outgoing', time);
    inputEl.value = '';
    const activeContact = instanceChatState.get(sourceSessionId)?.activeContact;
    const targetPhone = activeContact ? (activeContact.id || activeContact.phone) : targetRecipientInput.value.trim();
    if (targetPhone) {
      socket.emit('mirror_send', {
        target: targetPhone,
        message: text,
        sessionIds: [sourceSessionId],
        minDelay: 500,
        maxDelay: 1000,
        simulateTyping: true
      });
    }
  }
}

function appendMessageToScreen(sessionId, text, type, time) {
  const msgsContainer = document.getElementById(`conv-msgs-${sessionId}`);
  const state = instanceChatState.get(sessionId);

  if (state) {
    state.messages.push({ text, type, time });
  }

  if (msgsContainer) {
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${type}`;
    bubble.innerHTML = `${text}<div class="msg-meta">${time} &#10003;&#10003;</div>`;
    msgsContainer.appendChild(bubble);
    msgsContainer.scrollTop = msgsContainer.scrollHeight;
  }
}

// 9. QR Modal Handlers
function openQRModal(sessionId) {
  currentQRModalId = sessionId;
  modalDeviceLabelEl.textContent = `Pairing: ${sessionId}`;
  const session = sessionsState.get(sessionId);

  if (session && session.qr) {
    modalQRImgEl.src = session.qr;
    phoneDetailModalEl.classList.add('show');
  }
}

closePhoneModalBtn.addEventListener('click', () => {
  phoneDetailModalEl.classList.remove('show');
  currentQRModalId = null;
});

// 10. Socket.io Handlers
socket.on('initial_state', ({ sessions, chats, messages }) => {
  sessionsState.clear();
  sessions.forEach(s => sessionsState.set(s.id, s));
  if (chats) {
    for (const [id, chatList] of Object.entries(chats)) {
      realChatsState.set(id, chatList);
    }
  }
  if (messages) {
    for (const [id, msgMap] of Object.entries(messages)) {
      realMessagesState.set(id, msgMap);
    }
  }
  renderDeviceGrid();
  logFeed(`Loaded ${sessions.length} device instances with real chat sync.`);
});

socket.on('chats_updated', ({ id, chats }) => {
  realChatsState.set(id, chats);
  renderDeviceGrid();
});

socket.on('messages_updated', ({ id, messages }) => {
  realMessagesState.set(id, messages);
  renderDeviceGrid();
});

socket.on('session_update', (session) => {
  sessionsState.set(session.id, session);
  renderDeviceGrid();

  if (currentQRModalId === session.id) {
    if (session.status === 'connected') {
      logFeed(`🎉 Instance ${session.id} successfully paired.`);
      phoneDetailModalEl.classList.remove('show');
      currentQRModalId = null;
    } else if (session.qr) {
      modalQRImgEl.src = session.qr;
    }
  }
});

socket.on('session_removed', (sessionId) => {
  sessionsState.delete(sessionId);
  renderDeviceGrid();
  logFeed(`Instance ${sessionId} decommissioned.`);
});

socket.on('session_qr', ({ id, qr }) => {
  const s = sessionsState.get(id);
  if (s) {
    s.qr = qr;
    s.status = 'qr_ready';
    renderDeviceGrid();
  }
  if (currentQRModalId === id) {
    modalQRImgEl.src = qr;
  }
});

// Telemetry & Action Animations
socket.on('action_started', (data) => {
  logFeed(`Dispatching [${data.type.toUpperCase()}] across ${data.total} units.`);
});

socket.on('action_progress', (data) => {
  logFeed(`[${data.current}/${data.total}] Instance ${data.sessionId}: ${data.status}`);
});

socket.on('action_completed', (data) => {
  logFeed(`Broadcast complete. ${data.results.length} instances processed.`);
  fireBroadcastBtn.disabled = false;
  fireGroupJoinBtn.disabled = false;
  fireReactBtn.disabled = false;
});

socket.on('operation_error', (data) => {
  logFeed(`[Error] ${data.message}`);
  alert(data.message);
  fireBroadcastBtn.disabled = false;
  fireGroupJoinBtn.disabled = false;
  fireReactBtn.disabled = false;
});

// 11. Add Buttons
addSingleUnitBtn.addEventListener('click', () => {
  const num = sessionsState.size + 1;
  const id = `account_${String(num).padStart(2, '0')}`;
  socket.emit('create_session', { id, label: `Device ${num}` });
  logFeed(`Spawning device instance ${id}...`);
});

addBatchUnitsBtn.addEventListener('click', () => {
  const currentCount = sessionsState.size;
  logFeed(`Batch deploying 5 device instances...`);
  for (let i = 1; i <= 5; i++) {
    const num = currentCount + i;
    const id = `account_${String(num).padStart(2, '0')}`;
    socket.emit('create_session', { id, label: `Device ${num}` });
  }
});

if (clearUnpairedBtn) {
  clearUnpairedBtn.addEventListener('click', () => {
    if (confirm('Clean all unpaired/offline instances from the dashboard?')) {
      socket.emit('clear_unpaired');
      logFeed('Cleaning unpaired instances...');
    }
  });
}

// Action Dispatches from Top Console
fireBroadcastBtn.addEventListener('click', () => {
  const target = targetRecipientInput.value.trim();
  const message = broadcastMessageInput.value.trim();
  const minDelay = parseFloat(minJitterInput.value) * 1000 || 1000;
  const maxDelay = parseFloat(maxJitterInput.value) * 1000 || 2500;
  const simulateTyping = humanTypingCheck.checked;

  if (!target) {
    alert('Please enter a target recipient phone number or group JID');
    return;
  }
  if (!message) {
    alert('Please enter a message template');
    return;
  }

  fireBroadcastBtn.disabled = true;
  logFeed(`Firing synchronized broadcast...`);

  // Mirror onto screen
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  sessionsState.forEach(s => {
    if (s.status === 'connected') {
      appendMessageToScreen(s.id, message, 'outgoing', time);
    }
  });

  socket.emit('mirror_send', {
    target,
    message,
    minDelay,
    maxDelay,
    simulateTyping
  });
});
