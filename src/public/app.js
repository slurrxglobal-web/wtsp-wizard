// Studio Socket.io Client & Hybrid Dual-Engine Mirror Controller
const socket = io();

// State
let sessionsState = new Map();
let adbDevicesState = []; // Array of { serial, model, resolution, status, type: 'android' }
let currentQRModalId = null;
let masterSessionId = null;
let currentFleetFilter = 'all'; // 'all', 'android', 'web'
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

// Filters & ADB Buttons
const countAllEl = document.getElementById('countAll');
const countAndroidEl = document.getElementById('countAndroid');
const countWebEl = document.getElementById('countWeb');
const scanAdbBtn = document.getElementById('scanAdbBtn');
const adbBackBtn = document.getElementById('adbBackBtn');
const adbHomeBtn = document.getElementById('adbHomeBtn');
const adbEnterBtn = document.getElementById('adbEnterBtn');

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

// 5. Render Hybrid Fleet Grid (Android BlueStacks + Web WhatsApp)
function renderDeviceGrid() {
  const webSessions = Array.from(sessionsState.values());
  const androidDevices = adbDevicesState;

  const totalCount = webSessions.length + androidDevices.length;
  const connectedWeb = webSessions.filter(s => s.status === 'connected').length;
  const connectedAndroid = androidDevices.length;
  const totalOnline = connectedWeb + connectedAndroid;

  totalUnitsCountEl.textContent = totalCount;
  activeUnitsCountEl.textContent = totalOnline;

  if (countAllEl) countAllEl.textContent = totalCount;
  if (countAndroidEl) countAndroidEl.textContent = androidDevices.length;
  if (countWebEl) countWebEl.textContent = webSessions.length;

  activeFilterCountEl.textContent = `${totalOnline} / ${totalCount} online (${currentFleetFilter.toUpperCase()})`;

  // Auto-elect Master
  if (!masterSessionId && totalOnline > 0) {
    if (androidDevices.length > 0) {
      masterSessionId = androidDevices[0].serial;
    } else {
      const firstConnectedWeb = webSessions.find(s => s.status === 'connected');
      if (firstConnectedWeb) masterSessionId = firstConnectedWeb.id;
    }
  }

  if (totalOnline > 0) {
    fleetStatusTextEl.innerHTML = `
      <div class="sync-status-badge">
        <span class="sync-dot"></span>
        <span>SYNC ACTIVE // MASTER: ${masterSessionId ? masterSessionId.toUpperCase() : 'NONE'}</span>
      </div>
    `;
  } else {
    fleetStatusTextEl.innerHTML = `<span class="status-indicator">STANDBY</span>`;
  }

  // Filter units
  let displayUnits = [];
  if (currentFleetFilter === 'all') {
    displayUnits = [
      ...androidDevices.map(d => ({ ...d, isAndroid: true })),
      ...webSessions.map(s => ({ ...s, isAndroid: false }))
    ];
  } else if (currentFleetFilter === 'android') {
    displayUnits = androidDevices.map(d => ({ ...d, isAndroid: true }));
  } else {
    displayUnits = webSessions.map(s => ({ ...s, isAndroid: false }));
  }

  if (displayUnits.length === 0) {
    phoneFarmGridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px 16px; color: var(--text-muted);">
        <p style="font-weight: 500;">No devices found in current filter [${currentFleetFilter.toUpperCase()}].</p>
        <p style="font-size: 11px; margin-top: 4px;">Start BlueStacks or click <strong>+ Add Device</strong> to spawn instances.</p>
      </div>
    `;
    return;
  }

  phoneFarmGridEl.innerHTML = '';
  displayUnits.forEach((unit, index) => {
    const isMaster = unit.isAndroid ? (unit.serial === masterSessionId) : (unit.id === masterSessionId);

    if (unit.isAndroid) {
      // Render Android BlueStacks / Cloud Phone Frame
      const card = document.createElement('div');
      card.className = `device-card ${isMaster ? 'is-master' : ''}`;
      card.id = `device-card-${unit.serial}`;

      card.innerHTML = `
        <div class="device-card-header">
          <div class="instance-label">
            <span>${unit.model}</span>
            <span class="master-indicator">MASTER</span>
          </div>
          <span class="instance-tag tag-android">ANDROID ADB</span>
        </div>

        <div class="phone-screen-viewport" id="viewport-${unit.serial}">
          <div class="ghost-cursor" id="cursor-${unit.serial}"></div>
          
          <div class="android-canvas-sim" id="canvas-sim-${unit.serial}" data-serial="${unit.serial}">
            <div class="android-screen-badge">
              <span>${unit.serial}</span>
              <span>${unit.resolution.width}x${unit.resolution.height}</span>
            </div>

            <div class="android-center-content">
              <div class="android-app-icon">🤖</div>
              <div class="android-app-title">BlueStacks Android</div>
              <div class="android-app-sub">Click anywhere to Tap Mirror</div>
            </div>

            <div class="android-nav-bar">
              <span class="adb-click-key" data-key="4" data-serial="${unit.serial}">◀ Back</span>
              <span class="adb-click-key" data-key="3" data-serial="${unit.serial}">● Home</span>
              <span class="adb-click-key" data-key="66" data-serial="${unit.serial}">⏎ Enter</span>
            </div>
          </div>
        </div>

        <div class="device-card-footer">
          <button class="btn-card btn-master ${isMaster ? 'is-active' : ''} master-toggle-btn" data-id="${unit.serial}">
            ${isMaster ? '★ Master' : 'Set Master'}
          </button>
          <button class="btn-card adb-click-key" data-key="4" data-serial="${unit.serial}">Back</button>
          <button class="btn-card adb-click-key" data-key="3" data-serial="${unit.serial}">Home</button>
        </div>
      `;
      phoneFarmGridEl.appendChild(card);
    } else {
      // Render Web WhatsApp Session Frame
      const numId = getNumericId(unit.id, index);
      const isConnected = unit.status === 'connected';
      const isQrReady = unit.status === 'qr_ready';

      if (!instanceChatState.has(unit.id)) {
        instanceChatState.set(unit.id, {
          activeContact: null,
          messages: [
            { text: 'Session ready.', type: 'incoming', time: '10:30' }
          ]
        });
      }

      const state = instanceChatState.get(unit.id);
      const card = document.createElement('div');
      card.className = `device-card ${isMaster ? 'is-master' : ''}`;
      card.id = `device-card-${unit.id}`;

      const statusTag = isConnected ? 'online' : isQrReady ? 'standby' : 'offline';
      const statusLabel = isConnected ? 'Online' : isQrReady ? 'Ready' : 'Offline';

      card.innerHTML = `
        <div class="device-card-header">
          <div class="instance-label">
            <span>Unit ${numId}</span>
            <span class="master-indicator">MASTER</span>
          </div>
          <span class="instance-tag tag-${statusTag}">${statusLabel}</span>
        </div>

        <div class="phone-screen-viewport" id="viewport-${unit.id}">
          <div class="ghost-cursor" id="cursor-${unit.id}"></div>

          <div class="phone-system-bar">
            <span>10:42</span>
            <span>4G • 98%</span>
          </div>

          ${isConnected ? `
            <div class="wa-app-header">
              <span class="wa-app-title">WhatsApp</span>
              <div class="wa-header-actions">
                <span>🔍</span>
                <span>⋮</span>
              </div>
            </div>

            <!-- View A: Chats List View -->
            <div class="wa-chats-view ${state.activeContact ? 'hidden' : ''}" id="chats-view-${unit.id}" style="${state.activeContact ? 'display: none;' : ''}">
              ${(() => {
                const chats = getSessionChats(unit.id);
                if (chats.length === 0) {
                  return `
                    <div style="padding: 30px 12px; text-align: center; color: var(--text-muted); font-size: 10px;">
                      <p style="font-weight: 500; color: var(--text-secondary);">Syncing Real WhatsApp Chats...</p>
                      <p style="margin-top: 4px; font-size: 8px;">Recent chats appear automatically.</p>
                    </div>
                  `;
                }
                return chats.map((c, cIdx) => `
                  <div class="wa-chat-item ${state.activeContact?.id === c.id ? 'active' : ''}" data-session="${unit.id}" data-contact-idx="${cIdx}">
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
            <div class="wa-conversation-view ${state.activeContact ? 'active' : ''}" id="conv-view-${unit.id}">
              <div class="conv-header">
                <button class="conv-back-btn" data-session="${unit.id}">&lsaquo;</button>
                <div class="chat-avatar" style="width: 20px; height: 20px; font-size: 9px;" id="conv-avatar-${unit.id}">
                  ${state.activeContact ? state.activeContact.avatar : 'WA'}
                </div>
                <span class="conv-contact-name" id="conv-title-${unit.id}">
                  ${state.activeContact ? state.activeContact.name : 'Select Chat'}
                </span>
              </div>

              <div class="conv-messages-scroll" id="conv-msgs-${unit.id}">
                ${state.messages.map(m => `
                  <div class="msg-bubble ${m.type}">
                    ${m.text}
                    <div class="msg-meta">${m.time} &#10003;&#10003;</div>
                  </div>
                `).join('')}
              </div>

              <div class="conv-input-bar">
                <input type="text" class="conv-input" id="input-${unit.id}" placeholder="Type a message..." data-session="${unit.id}">
                <button class="conv-send-btn" id="send-${unit.id}" data-session="${unit.id}">&#10148;</button>
              </div>
            </div>
          ` : `
            <div class="phone-unpaired-screen">
              <div class="unpaired-icon">💬</div>
              <div class="unpaired-title">WhatsApp Unpaired</div>
              <div class="unpaired-subtitle">Scan QR code to activate this phone instance</div>
              ${isQrReady ? `
                <button class="btn btn-primary qr-action-btn" data-id="${unit.id}" style="font-size: 11px;">
                  Pair QR Code
                </button>
              ` : `
                <button class="btn btn-secondary reconnect-action-btn" data-id="${unit.id}" style="font-size: 11px;">
                  Connect Instance
                </button>
              `}
            </div>
          `}
        </div>

        <div class="device-card-footer">
          ${isConnected ? `
            <button class="btn-card btn-master ${isMaster ? 'is-active' : ''} master-toggle-btn" data-id="${unit.id}">
              ${isMaster ? '★ Master' : 'Set Master'}
            </button>
          ` : isQrReady ? `
            <button class="btn-card highlight qr-action-btn" data-id="${unit.id}">Pair QR</button>
          ` : `
            <button class="btn-card reconnect-action-btn" data-id="${unit.id}">Connect</button>
          `}
          <button class="btn-card danger delete-action-btn" data-id="${unit.id}" title="Remove Instance">&times;</button>
        </div>
      `;
      phoneFarmGridEl.appendChild(card);
    }
  });

  attachInteractiveEvents();
}

// 6. Interactive Event Mirroring
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
      masterViewport.addEventListener('mousemove', (e) => {
        const rect = masterViewport.getBoundingClientRect();
        const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

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

  // Android Tap Mirroring: Click on any Android canvas
  document.querySelectorAll('.android-canvas-sim').forEach(canvas => {
    canvas.addEventListener('click', (e) => {
      const serial = canvas.getAttribute('data-serial');
      const rect = canvas.getBoundingClientRect();
      const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

      logFeed(`Tap at (${Math.round(xPct)}%, ${Math.round(yPct)}%) -> Mirroring to Android devices`);
      socket.emit('adb_tap', { xPct, yPct });
    });
  });

  // Android Key Click
  document.querySelectorAll('.adb-click-key').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const keyCode = parseInt(btn.getAttribute('data-key'), 10);
      const serial = btn.getAttribute('data-serial');
      socket.emit('adb_key', { keyCode, targetSerials: serial ? [serial] : null });
      logFeed(`Dispatched Android KeyEvent [${keyCode}]`);
    });
  });

  // Web Chat Item Click (Selecting contact in WhatsApp)
  document.querySelectorAll('.wa-chat-item').forEach(item => {
    item.addEventListener('click', () => {
      const sessionId = item.getAttribute('data-session');
      const contactIdx = parseInt(item.getAttribute('data-contact-idx'), 10);
      const chats = getSessionChats(sessionId);
      const contact = chats[contactIdx];
      if (!contact) return;

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

// 8. Synchronized Message Dispatch Handler (Hybrid: Web + Android)
function handleSendMessage(sourceSessionId) {
  const inputEl = document.getElementById(`input-${sourceSessionId}`);
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;

  const isMaster = sourceSessionId === masterSessionId;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isMaster) {
    logFeed(`🚀 MASTER FIRED: "${text}" -> Synchronizing across Web & Android fleets!`);

    // Web screens animation
    sessionsState.forEach((s) => {
      if (s.status === 'connected') {
        appendMessageToScreen(s.id, text, 'outgoing', time);
        const slaveInput = document.getElementById(`input-${s.id}`);
        if (slaveInput) slaveInput.value = '';
      }
    });

    // Also type text and send on BlueStacks Android instances!
    if (adbDevicesState.length > 0) {
      socket.emit('adb_text', { text });
      setTimeout(() => socket.emit('adb_key', { keyCode: 66 }), 300); // Press Enter to send
    }

    // Web delivery via Baileys
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

// 10. Filter Chips & ADB Key Click Handlers
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFleetFilter = chip.getAttribute('data-filter');
    renderDeviceGrid();
    logFeed(`Switched view to [${currentFleetFilter.toUpperCase()}]`);
  });
});

if (scanAdbBtn) {
  scanAdbBtn.addEventListener('click', () => {
    socket.emit('adb_refresh');
    logFeed('Scanning for running BlueStacks / Cloud Phone ADB devices...');
  });
}

if (adbBackBtn) {
  adbBackBtn.addEventListener('click', () => {
    socket.emit('adb_key', { keyCode: 4 });
    logFeed('Dispatched Back Key (KeyEvent 4) to Android fleet.');
  });
}

if (adbHomeBtn) {
  adbHomeBtn.addEventListener('click', () => {
    socket.emit('adb_key', { keyCode: 3 });
    logFeed('Dispatched Home Key (KeyEvent 3) to Android fleet.');
  });
}

if (adbEnterBtn) {
  adbEnterBtn.addEventListener('click', () => {
    socket.emit('adb_key', { keyCode: 66 });
    logFeed('Dispatched Enter Key (KeyEvent 66) to Android fleet.');
  });
}

// 11. Socket.io Handlers
socket.on('initial_state', ({ sessions, chats, messages, adbDevices }) => {
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
  if (adbDevices) {
    adbDevicesState = adbDevices;
  }
  renderDeviceGrid();
  logFeed(`Loaded ${sessions.length} Web instances and ${adbDevicesState.length} Android devices.`);
});

socket.on('adb_devices_update', (devices) => {
  adbDevicesState = devices || [];
  renderDeviceGrid();
  logFeed(`ADB Fleet updated: ${adbDevicesState.length} Android emulators detected.`);
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

socket.on('action_started', (data) => {
  logFeed(`Dispatching [${data.type.toUpperCase()}] across ${data.total} units.`);
});

socket.on('action_progress', (data) => {
  logFeed(`[${data.current}/${data.total}] Instance ${data.sessionId}: ${data.status}`);
});

socket.on('action_completed', (data) => {
  logFeed(`Broadcast complete. ${data.results.length} instances processed.`);
  fireBroadcastBtn.disabled = false;
});

socket.on('operation_error', (data) => {
  logFeed(`[Error] ${data.message}`);
  alert(data.message);
  fireBroadcastBtn.disabled = false;
});

// 12. Add Buttons
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

// Action Dispatches from Top Console (Unified)
fireBroadcastBtn.addEventListener('click', () => {
  const target = targetRecipientInput.value.trim();
  const message = broadcastMessageInput.value.trim();
  const minDelay = parseFloat(minJitterInput.value) * 1000 || 1000;
  const maxDelay = parseFloat(maxJitterInput.value) * 1000 || 2500;
  const simulateTyping = humanTypingCheck.checked;

  if (!target && adbDevicesState.length === 0) {
    alert('Please enter a target recipient phone number or group JID');
    return;
  }
  if (!message) {
    alert('Please enter a message template');
    return;
  }

  fireBroadcastBtn.disabled = true;
  logFeed(`Firing synchronized broadcast to Web & Android fleets...`);

  // Web screens animation
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  sessionsState.forEach(s => {
    if (s.status === 'connected') {
      appendMessageToScreen(s.id, message, 'outgoing', time);
    }
  });

  // Android text input & enter
  if (adbDevicesState.length > 0) {
    socket.emit('adb_text', { text: message });
    setTimeout(() => socket.emit('adb_key', { keyCode: 66 }), 400);
  }

  if (target) {
    socket.emit('mirror_send', {
      target,
      message,
      minDelay,
      maxDelay,
      simulateTyping
    });
  } else {
    fireBroadcastBtn.disabled = false;
  }
});
