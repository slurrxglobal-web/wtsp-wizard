// Studio Socket.io Client
const socket = io();

// State
let sessionsState = new Map();
let currentQRModalId = null;
let selectedEmoji = '❤️';

// Supported Android Models for realism
const DEVICE_MODELS = [
  'SM-G986N', 'SM-A325N', 'SM-N981N', 'SM-A528N', 'SM-G781N',
  'SM-A336N', 'SM-A346N', 'SM-G988N', 'SM-S908N', 'SM-S918N'
];

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
const groupInviteLinkInput = document.getElementById('groupInviteLink');
const reactChatJidInput = document.getElementById('reactChatJid');
const reactMessageIdInput = document.getElementById('reactMessageId');

const fireBroadcastBtn = document.getElementById('fireBroadcastBtn');
const fireGroupJoinBtn = document.getElementById('fireGroupJoinBtn');
const fireReactBtn = document.getElementById('fireReactBtn');
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

// 2. Activity Feed Helper
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

// 4. Device Model Helper
function getDeviceModel(index) {
  return DEVICE_MODELS[index % DEVICE_MODELS.length];
}

function getNumericId(id, fallbackIndex) {
  const digits = id.replace(/\D/g, '');
  return digits ? digits.padStart(2, '0') : String(fallbackIndex + 1).padStart(2, '0');
}

// 5. Render High-Density Device Grid
function renderDeviceGrid() {
  const sessions = Array.from(sessionsState.values());
  const connectedCount = sessions.filter(s => s.status === 'connected').length;

  totalUnitsCountEl.textContent = sessions.length;
  activeUnitsCountEl.textContent = connectedCount;
  activeFilterCountEl.textContent = `${connectedCount} / ${sessions.length} online`;

  if (connectedCount > 0) {
    fleetStatusTextEl.textContent = 'ONLINE // SYNCED';
    fleetStatusTextEl.style.color = 'var(--status-online)';
    fleetStatusTextEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
  } else {
    fleetStatusTextEl.textContent = 'STANDBY';
    fleetStatusTextEl.style.color = 'var(--status-standby)';
    fleetStatusTextEl.style.borderColor = 'rgba(245, 158, 11, 0.3)';
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
    const model = getDeviceModel(index);
    const isConnected = session.status === 'connected';
    const isQrReady = session.status === 'qr_ready';

    const statusTag = isConnected ? 'online' : isQrReady ? 'standby' : 'offline';
    const statusLabel = isConnected ? 'Online' : isQrReady ? 'Ready' : 'Offline';

    const userNumber = session.user?.id ? session.user.id.split('@')[0] : 'Unpaired';

    const card = document.createElement('div');
    card.className = 'device-card';
    card.id = `device-card-${session.id}`;

    card.innerHTML = `
      <div class="device-card-header">
        <span class="instance-label">Unit ${numId}</span>
        <span class="instance-tag tag-${statusTag}">${statusLabel}</span>
      </div>

      <div class="device-screen-sim">
        <div class="sim-number">${numId}</div>
        <div class="sim-telemetry">
          <span class="sim-model">${model}</span>
          <span class="sim-user-id">${userNumber}</span>
        </div>
        <div class="sim-bubble-layer">
          <div class="sim-chat-bubble" id="sim-bubble-${session.id}">
            <span id="sim-text-${session.id}">...</span>
            <div class="bubble-time-ticks">&#10003;&#10003;</div>
          </div>
        </div>
      </div>

      <div class="device-card-footer">
        ${isQrReady ? `
          <button class="btn-card highlight qr-action-btn" data-id="${session.id}">Pair QR</button>
        ` : isConnected ? `
          <button class="btn-card" style="color: var(--status-online);" disabled>Connected</button>
        ` : `
          <button class="btn-card reconnect-action-btn" data-id="${session.id}">Connect</button>
        `}
        <button class="btn-card danger delete-action-btn" data-id="${session.id}" title="Remove Instance">&times;</button>
      </div>
    `;

    phoneFarmGridEl.appendChild(card);
  });

  // Attach button events
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

// 6. QR Modal
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

// 7. Socket.io Handlers
socket.on('initial_state', ({ sessions }) => {
  sessionsState.clear();
  sessions.forEach(s => sessionsState.set(s.id, s));
  renderDeviceGrid();
  logFeed(`Loaded ${sessions.length} device instances.`);
});

socket.on('session_update', (session) => {
  sessionsState.set(session.id, session);
  renderDeviceGrid();

  if (currentQRModalId === session.id) {
    if (session.status === 'connected') {
      logFeed(`Instance ${session.id} successfully paired.`);
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
  const bubble = document.getElementById(`sim-bubble-${data.sessionId}`);
  const bubbleText = document.getElementById(`sim-text-${data.sessionId}`);

  if (bubble && bubbleText) {
    bubbleText.textContent = data.status === 'success' ? 'Dispatched' : 'Failed';
    bubble.classList.add('active');
    setTimeout(() => bubble.classList.remove('active'), 3500);
  }

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

// 8. Add Buttons
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

// 9. Console Tabs
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.console-tab-pane').forEach(p => p.classList.remove('active'));

    tab.classList.add('active');
    const targetId = tab.getAttribute('data-tab');
    document.getElementById(targetId).classList.add('active');
  });
});

// Reaction Select
document.querySelectorAll('.react-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.react-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedEmoji = btn.getAttribute('data-emoji');
  });
});

// Action Dispatches
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

  socket.emit('mirror_send', {
    target,
    message,
    minDelay,
    maxDelay,
    simulateTyping
  });
});

fireGroupJoinBtn.addEventListener('click', () => {
  const inviteLink = groupInviteLinkInput.value.trim();
  if (!inviteLink) {
    alert('Please enter group invite link');
    return;
  }

  fireGroupJoinBtn.disabled = true;
  logFeed(`Executing group join across active instances...`);
  socket.emit('mirror_join', { inviteLink });
});

fireReactBtn.addEventListener('click', () => {
  const target = reactChatJidInput.value.trim();
  const messageId = reactMessageIdInput.value.trim();

  if (!target || !messageId) {
    alert('Please enter target chat and message ID');
    return;
  }

  fireReactBtn.disabled = true;
  logFeed(`Executing reaction [${selectedEmoji}] across active instances...`);
  socket.emit('mirror_react', {
    target,
    messageId,
    emoji: selectedEmoji
  });
});
