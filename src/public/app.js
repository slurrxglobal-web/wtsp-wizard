// Socket.io Real-Time Connection
const socket = io();

// State
let sessionsState = new Map();
let currentQRModalId = null;
let selectedEmoji = '❤️';

// Samsung model names to match the phone farm aesthetic in the reel
const DEVICE_MODELS = [
  'SM-G986N', 'SM-A325N', 'SM-N981N', 'SM-A528N', 'SM-G781N',
  'SM-A336N', 'SM-A346N', 'SM-G988N', 'SM-S908N', 'SM-S918N'
];

// DOM Elements
const totalUnitsCountEl = document.getElementById('totalUnitsCount');
const activeUnitsCountEl = document.getElementById('activeUnitsCount');
const phoneFarmGridEl = document.getElementById('phoneFarmGrid');
const tickerLogsEl = document.getElementById('tickerLogs');
const fleetStatusTextEl = document.getElementById('fleetStatusText');

// Commander Drawer Elements
const commanderDrawerEl = document.getElementById('commanderDrawer');
const toggleMasterConsoleBtn = document.getElementById('toggleMasterConsoleBtn');
const closeDrawerBtn = document.getElementById('closeDrawerBtn');

// Action Inputs
const targetRecipientInput = document.getElementById('targetRecipient');
const broadcastMessageInput = document.getElementById('broadcastMessage');
const minJitterInput = document.getElementById('minJitter');
const maxJitterInput = document.getElementById('maxJitter');
const humanTypingCheck = document.getElementById('humanTypingCheck');
const groupInviteLinkInput = document.getElementById('groupInviteLink');
const reactChatJidInput = document.getElementById('reactChatJid');
const reactMessageIdInput = document.getElementById('reactMessageId');

// Buttons
const fireBroadcastBtn = document.getElementById('fireBroadcastBtn');
const fireGroupJoinBtn = document.getElementById('fireGroupJoinBtn');
const fireReactBtn = document.getElementById('fireReactBtn');
const addSingleUnitBtn = document.getElementById('addSingleUnitBtn');
const addBatchUnitsBtn = document.getElementById('addBatchUnitsBtn');

// Modal Elements
const phoneDetailModalEl = document.getElementById('phoneDetailModal');
const modalDeviceLabelEl = document.getElementById('modalDeviceLabel');
const modalQRImgEl = document.getElementById('modalQRImg');
const closePhoneModalBtn = document.getElementById('closePhoneModalBtn');

// Drawer Toggle
toggleMasterConsoleBtn.addEventListener('click', () => {
  commanderDrawerEl.classList.toggle('collapsed');
});

closeDrawerBtn.addEventListener('click', () => {
  commanderDrawerEl.classList.add('collapsed');
});

// Ticker Log Stream
function logTicker(msg, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const item = document.createElement('span');
  item.className = 'ticker-item';
  item.style.color = type === 'error' ? 'var(--accent-red)' : type === 'success' ? 'var(--neon-green)' : 'var(--text-main)';
  item.textContent = `[${time}] ${msg} | `;
  tickerLogsEl.prepend(item);
}

// Generate Model for Device
function getDeviceModel(index) {
  return DEVICE_MODELS[index % DEVICE_MODELS.length];
}

// Extract numeric ID (e.g. "account_01" -> "01")
function getNumericId(id, fallbackIndex) {
  const digits = id.replace(/\D/g, '');
  if (digits) {
    return digits.padStart(2, '0');
  }
  return String(fallbackIndex + 1).padStart(2, '0');
}

// Render Phone Farm Matrix Wall
function renderPhoneFarm() {
  const sessions = Array.from(sessionsState.values());
  const connectedCount = sessions.filter(s => s.status === 'connected').length;

  totalUnitsCountEl.textContent = sessions.length;
  activeUnitsCountEl.textContent = connectedCount;

  if (connectedCount > 0) {
    fleetStatusTextEl.textContent = `SYNCED // ${connectedCount} UNITS ONLINE`;
    fleetStatusTextEl.style.color = 'var(--neon-green)';
    fleetStatusTextEl.style.borderColor = 'rgba(0, 255, 102, 0.4)';
  } else {
    fleetStatusTextEl.textContent = 'STANDBY // ALL UNITS DISCONNECTED';
    fleetStatusTextEl.style.color = 'var(--accent-amber)';
    fleetStatusTextEl.style.borderColor = 'rgba(255, 170, 0, 0.3)';
  }

  if (sessions.length === 0) {
    phoneFarmGridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <p style="font-family: var(--font-hud); font-size: 16px; letter-spacing: 1px;">⚡ NO UNITS DEPLOYED IN MATRIX</p>
        <p style="font-size: 13px; margin-top: 8px;">Click <strong>+ DEPLOY 1 UNIT</strong> or <strong>+ DEPLOY 5 UNITS</strong> to spawn smartphone devices.</p>
      </div>
    `;
    return;
  }

  phoneFarmGridEl.innerHTML = '';
  sessions.forEach((session, index) => {
    const numId = getNumericId(session.id, index);
    const model = getDeviceModel(index);
    const temp = 20 + (index % 6); // Mock realistic temp 20°-25°C

    const card = document.createElement('div');
    card.className = `phone-unit-card`;
    card.id = `phone-card-${session.id}`;

    const isConnected = session.status === 'connected';
    const isQrReady = session.status === 'qr_ready';

    card.innerHTML = `
      <!-- Phone Top Bar (Matches Reel) -->
      <div class="phone-top-bar">
        <div class="phone-id-badge">
          <span class="phone-device-num">${numId}</span>
          <span class="phone-model-code">${model}</span>
        </div>
        <div class="phone-telemetry">
          <span class="usb-tag">USB</span>
          <span class="temp-tag">${temp}°C</span>
        </div>
      </div>

      <!-- Smartphone Inner Screen -->
      <div class="phone-inner-screen">
        <!-- Giant Neon Green Number From Reel -->
        <div class="screen-neon-number">${numId}</div>

        <!-- Screen Status Pill -->
        <div class="screen-status-pill">
          <span class="screen-status-text">${session.status.replace('_', ' ')}</span>
          <span class="status-dot-sm ${session.status}"></span>
        </div>

        <!-- In-Screen QR Code Preview (If QR Ready) -->
        <div class="screen-qr-preview ${isQrReady ? 'show' : ''}" id="screen-qr-${session.id}">
          <img src="${session.qr || ''}" alt="QR">
          <span class="screen-qr-tap">TAP TO ENLARGE</span>
        </div>

        <!-- Chat Mirror Layer (Live Action Bubble) -->
        <div class="screen-chat-layer">
          <div class="mirror-chat-bubble" id="bubble-${session.id}">
            <span class="bubble-text" id="bubble-text-${session.id}">...</span>
            <div class="bubble-meta">
              <span class="bubble-time">now</span>
              <span class="bubble-ticks">✓✓</span>
            </div>
          </div>
        </div>

        <!-- Bottom App Dock -->
        <div class="phone-bottom-dock">
          <div class="dock-icon system">📞</div>
          <div class="dock-icon whatsapp" title="WhatsApp Node">💬</div>
          <div class="dock-icon system">🌐</div>
          <div class="dock-icon system">📷</div>
        </div>
      </div>

      <!-- Phone Bottom Controls -->
      <div class="phone-bottom-controls">
        ${isQrReady ? `
          <button class="btn-phone-action active-qr qr-click-btn" data-id="${session.id}">📷 PAIR QR</button>
        ` : isConnected ? `
          <button class="btn-phone-action" style="color: var(--neon-green);" disabled>ONLINE</button>
        ` : `
          <button class="btn-phone-action connect-click-btn" data-id="${session.id}">CONNECT</button>
        `}
        <button class="btn-phone-action danger remove-click-btn" data-id="${session.id}" title="Remove unit">✕</button>
      </div>
    `;

    phoneFarmGridEl.appendChild(card);
  });

  // Attach button events
  document.querySelectorAll('.qr-click-btn').forEach(b => {
    b.addEventListener('click', () => openModalQR(b.getAttribute('data-id')));
  });

  document.querySelectorAll('.screen-qr-preview').forEach(el => {
    el.addEventListener('click', () => {
      const parentCard = el.closest('.phone-unit-card');
      const id = parentCard.id.replace('phone-card-', '');
      openModalQR(id);
    });
  });

  document.querySelectorAll('.connect-click-btn').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-id');
      socket.emit('create_session', { id, label: id });
      logTicker(`Reconnecting unit ${id}...`, 'info');
    });
  });

  document.querySelectorAll('.remove-click-btn').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-id');
      if (confirm(`Decommission unit ${id} from army?`)) {
        socket.emit('remove_session', { id });
        logTicker(`Decommissioned unit ${id}`, 'warn');
      }
    });
  });
}

// Modal QR viewer
function openModalQR(sessionId) {
  currentQRModalId = sessionId;
  modalDeviceLabelEl.textContent = `DEVICE UNIT: ${sessionId.toUpperCase()}`;
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

// Socket.io Handlers
socket.on('initial_state', ({ sessions }) => {
  sessionsState.clear();
  sessions.forEach(s => sessionsState.set(s.id, s));
  renderPhoneFarm();
  logTicker(`Loaded ${sessions.length} units into device farm matrix.`);
});

socket.on('session_update', (session) => {
  sessionsState.set(session.id, session);
  renderPhoneFarm();

  if (currentQRModalId === session.id) {
    if (session.status === 'connected') {
      logTicker(`🎉 UNIT ${session.id} ARMED & CONNECTED!`, 'success');
      phoneDetailModalEl.classList.remove('show');
      currentQRModalId = null;
    } else if (session.qr) {
      modalQRImgEl.src = session.qr;
    }
  }
});

socket.on('session_removed', (sessionId) => {
  sessionsState.delete(sessionId);
  renderPhoneFarm();
  logTicker(`Unit ${sessionId} removed from matrix.`);
});

socket.on('session_qr', ({ id, qr }) => {
  const s = sessionsState.get(id);
  if (s) {
    s.qr = qr;
    s.status = 'qr_ready';
    renderPhoneFarm();
  }
  if (currentQRModalId === id) {
    modalQRImgEl.src = qr;
  }
});

// Telemetry & Action Animations
socket.on('action_started', (data) => {
  logTicker(`🚀 ACTION DISPATCHED: [${data.type.toUpperCase()}] to ${data.total} units!`, 'info');
  // Trigger synchronized flashing across entire device army!
  document.querySelectorAll('.phone-unit-card').forEach(card => {
    card.classList.add('action-firing');
  });
});

socket.on('action_progress', (data) => {
  const card = document.getElementById(`phone-card-${data.sessionId}`);
  const bubble = document.getElementById(`bubble-${data.sessionId}`);
  const bubbleText = document.getElementById(`bubble-text-${data.sessionId}`);

  if (card) {
    card.classList.remove('action-firing');
  }

  if (bubble && bubbleText) {
    bubbleText.textContent = data.status === 'success' ? 'Synchronized ✓' : 'Failed ✗';
    bubble.classList.add('visible');
    setTimeout(() => {
      bubble.classList.remove('visible');
    }, 4000);
  }

  const icon = data.status === 'success' ? '✔' : '✖';
  const colorType = data.status === 'success' ? 'success' : 'error';
  logTicker(`${icon} [${data.current}/${data.total}] Unit ${data.sessionId}: ${data.status}`, colorType);
});

socket.on('action_completed', (data) => {
  logTicker(`🏁 ALL UNITS COMPLETED! Execution synced across army.`, 'success');
  document.querySelectorAll('.phone-unit-card').forEach(card => {
    card.classList.remove('action-firing');
  });
  fireBroadcastBtn.disabled = false;
  fireGroupJoinBtn.disabled = false;
  fireReactBtn.disabled = false;
});

socket.on('operation_error', (data) => {
  logTicker(`[ERROR] ${data.message}`, 'error');
  alert(data.message);
  fireBroadcastBtn.disabled = false;
  fireGroupJoinBtn.disabled = false;
  fireReactBtn.disabled = false;
});

// Deploy Unit Buttons
addSingleUnitBtn.addEventListener('click', () => {
  const count = sessionsState.size;
  const num = count + 1;
  const id = `account_${String(num).padStart(2, '0')}`;
  socket.emit('create_session', { id, label: `Unit ${num}` });
  logTicker(`Deploying Unit ${id}... Generating QR.`);
});

addBatchUnitsBtn.addEventListener('click', () => {
  const count = sessionsState.size;
  logTicker(`Batch deploying 5 phone units...`, 'info');
  for (let i = 1; i <= 5; i++) {
    const num = count + i;
    const id = `account_${String(num).padStart(2, '0')}`;
    socket.emit('create_session', { id, label: `Unit ${num}` });
  }
});

// Console Tab Switcher
document.querySelectorAll('.c-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.c-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.console-pane').forEach(p => p.classList.remove('active'));

    tab.classList.add('active');
    const targetId = tab.getAttribute('data-tab');
    document.getElementById(targetId).classList.add('active');
  });
});

// Emoji Picker
document.querySelectorAll('.emoji-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.emoji-opt').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    selectedEmoji = opt.getAttribute('data-emoji');
  });
});

// Fire Broadcast Action
fireBroadcastBtn.addEventListener('click', () => {
  const target = targetRecipientInput.value.trim();
  const message = broadcastMessageInput.value.trim();
  const minDelay = parseFloat(minJitterInput.value) * 1000 || 1000;
  const maxDelay = parseFloat(maxJitterInput.value) * 1000 || 2500;
  const simulateTyping = humanTypingCheck.checked;

  if (!target) {
    alert('Please enter target recipient phone number or group JID');
    return;
  }
  if (!message) {
    alert('Please enter message payload');
    return;
  }

  fireBroadcastBtn.disabled = true;
  logTicker(`⚡ FIRING BROADCAST MIRROR TO ALL UNITS...`, 'info');

  socket.emit('mirror_send', {
    target,
    message,
    minDelay,
    maxDelay,
    simulateTyping
  });
});

// Fire Group Join Action
fireGroupJoinBtn.addEventListener('click', () => {
  const inviteLink = groupInviteLinkInput.value.trim();
  if (!inviteLink) {
    alert('Please enter WhatsApp group invite link');
    return;
  }

  fireGroupJoinBtn.disabled = true;
  logTicker(`👥 INITIATING MASS GROUP JOIN ACROSS ARMY...`, 'info');

  socket.emit('mirror_join', { inviteLink });
});

// Fire Reaction Bomb
fireReactBtn.addEventListener('click', () => {
  const target = reactChatJidInput.value.trim();
  const messageId = reactMessageIdInput.value.trim();

  if (!target || !messageId) {
    alert('Please enter target chat and message ID');
    return;
  }

  fireReactBtn.disabled = true;
  logTicker(`🔥 TRIGGERING MASS REACTION [${selectedEmoji}]...`, 'info');

  socket.emit('mirror_react', {
    target,
    messageId,
    emoji: selectedEmoji
  });
});
