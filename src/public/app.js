// Initialize Socket.io
const socket = io();

// State
let sessionsState = new Map();
let currentQRModalSessionId = null;
let selectedEmoji = '👍';

// DOM Elements
const activeSessionsCountEl = document.getElementById('activeSessionsCount');
const totalSessionsCountEl = document.getElementById('totalSessionsCount');
const sessionsGridEl = document.getElementById('sessionsGrid');
const terminalLogsEl = document.getElementById('terminalLogs');
const qrModalEl = document.getElementById('qrModal');
const qrImageEl = document.getElementById('qrImage');
const modalSessionTitleEl = document.getElementById('modalSessionTitle');
const qrStatusTextEl = document.getElementById('qrStatusText');
const closeModalBtn = document.getElementById('closeModalBtn');

// Buttons
const addSessionQuickBtn = document.getElementById('addSessionQuickBtn');
const batchAddBtn = document.getElementById('batchAddBtn');
const dispatchMessageBtn = document.getElementById('dispatchMessageBtn');
const dispatchJoinBtn = document.getElementById('dispatchJoinBtn');
const dispatchReactBtn = document.getElementById('dispatchReactBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');

// Inputs
const msgTargetInput = document.getElementById('msgTarget');
const msgTextInput = document.getElementById('msgText');
const minDelayInput = document.getElementById('minDelay');
const maxDelayInput = document.getElementById('maxDelay');
const simulateTypingInput = document.getElementById('simulateTyping');
const groupInviteInput = document.getElementById('groupInvite');
const reactTargetInput = document.getElementById('reactTarget');
const reactMsgIdInput = document.getElementById('reactMsgId');

// Logging Helper
function appendLog(text, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] ${text}`;
  terminalLogsEl.appendChild(entry);
  terminalLogsEl.scrollTop = terminalLogsEl.scrollHeight;
}

clearLogsBtn.addEventListener('click', () => {
  terminalLogsEl.innerHTML = '';
});

// Update Metrics & Fleet Grid
function updateFleetUI() {
  const sessions = Array.from(sessionsState.values());
  const connectedCount = sessions.filter(s => s.status === 'connected').length;

  activeSessionsCountEl.textContent = `${connectedCount} Connected`;
  totalSessionsCountEl.textContent = `${sessions.length} Total Accounts`;

  if (sessions.length === 0) {
    sessionsGridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
        <p>No accounts configured yet.</p>
        <p style="margin-top: 8px;">Click <strong>+ Add Account</strong> or <strong>+ Add 5 Accounts</strong> to get started!</p>
      </div>
    `;
    return;
  }

  sessionsGridEl.innerHTML = '';
  sessions.forEach(session => {
    const card = document.createElement('div');
    card.className = 'session-card';

    const statusClass = `status-${session.status}`;
    const statusLabel = session.status === 'qr_ready' ? 'Scan QR' : session.status.replace('_', ' ');

    let userLabel = 'Not authenticated';
    if (session.user && session.user.id) {
      userLabel = session.user.id.split('@')[0] || session.user.id;
    }

    card.innerHTML = `
      <div class="session-card-header">
        <span class="session-title">${session.label || session.id}</span>
        <span class="status-tag ${statusClass}">${statusLabel}</span>
      </div>
      <div class="session-user-info">
        📞 ${userLabel}
      </div>
      <div class="session-card-actions">
        ${session.status === 'qr_ready' ? `
          <button class="btn btn-primary btn-sm btn-block view-qr-btn" data-id="${session.id}">
            📷 View QR
          </button>
        ` : session.status === 'connected' ? `
          <button class="btn btn-outline btn-sm btn-block" style="color: var(--wa-green);" disabled>
            ✓ Online
          </button>
        ` : `
          <button class="btn btn-outline btn-sm btn-block reconnect-btn" data-id="${session.id}">
            🔄 Connect
          </button>
        `}
        <button class="btn btn-outline btn-sm delete-btn" data-id="${session.id}" title="Remove account" style="color: var(--danger-red);">
          🗑️
        </button>
      </div>
    `;

    sessionsGridEl.appendChild(card);
  });

  // Attach card event listeners
  document.querySelectorAll('.view-qr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      openQRModal(id);
    });
  });

  document.querySelectorAll('.reconnect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      socket.emit('create_session', { id, label: id });
      appendLog(`Reconnecting account ${id}...`, 'info');
    });
  });

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (confirm(`Remove account ${id}?`)) {
        socket.emit('remove_session', { id });
        appendLog(`Removing account ${id}...`, 'warn');
      }
    });
  });
}

// Modal Handlers
function openQRModal(sessionId) {
  currentQRModalSessionId = sessionId;
  modalSessionTitleEl.textContent = `Pair Account: ${sessionId}`;
  const session = sessionsState.get(sessionId);

  if (session && session.qr) {
    qrImageEl.src = session.qr;
    qrStatusTextEl.textContent = 'Scan code with WhatsApp on your phone';
    qrStatusTextEl.className = 'status-pill status-qr_ready';
  } else {
    qrImageEl.src = '';
    qrStatusTextEl.textContent = 'Waiting for QR generation...';
    qrStatusTextEl.className = 'status-pill status-connecting';
  }

  qrModalEl.classList.add('show');
}

closeModalBtn.addEventListener('click', () => {
  qrModalEl.classList.remove('show');
  currentQRModalSessionId = null;
});

// Socket Events
socket.on('initial_state', ({ sessions }) => {
  sessionsState.clear();
  sessions.forEach(s => sessionsState.set(s.id, s));
  updateFleetUI();
  appendLog(`Loaded ${sessions.length} existing account sessions.`);
});

socket.on('session_update', (session) => {
  sessionsState.set(session.id, session);
  updateFleetUI();

  if (currentQRModalSessionId === session.id) {
    if (session.status === 'connected') {
      appendLog(`🎉 Account ${session.id} successfully linked!`, 'success');
      qrModalEl.classList.remove('show');
      currentQRModalSessionId = null;
    } else if (session.qr) {
      qrImageEl.src = session.qr;
      qrStatusTextEl.textContent = 'Ready to scan';
      qrStatusTextEl.className = 'status-pill status-qr_ready';
    }
  }
});

socket.on('session_removed', (sessionId) => {
  sessionsState.delete(sessionId);
  updateFleetUI();
  appendLog(`Account ${sessionId} removed.`, 'warn');
});

socket.on('session_qr', ({ id, qr }) => {
  if (currentQRModalSessionId === id) {
    qrImageEl.src = qr;
    qrStatusTextEl.textContent = 'Scan code with WhatsApp';
    qrStatusTextEl.className = 'status-pill status-qr_ready';
  }
});

// Action Telemetry Events
socket.on('action_started', (data) => {
  appendLog(`▶ Started action [${data.type}] across ${data.total} accounts.`, 'info');
});

socket.on('action_progress', (data) => {
  const icon = data.status === 'success' ? '✓' : '✗';
  const logType = data.status === 'success' ? 'success' : 'error';
  appendLog(`${icon} [${data.current}/${data.total}] Account ${data.sessionId}: ${data.status} ${data.error ? '(' + data.error + ')' : ''}`, logType);
});

socket.on('action_completed', (data) => {
  appendLog(`✔ Action finished! Processed ${data.results.length} accounts.`, 'success');
  dispatchMessageBtn.disabled = false;
  dispatchJoinBtn.disabled = false;
  dispatchReactBtn.disabled = false;
});

socket.on('operation_error', (data) => {
  appendLog(`[Error] ${data.message}`, 'error');
  alert(`Error: ${data.message}`);
  dispatchMessageBtn.disabled = false;
  dispatchJoinBtn.disabled = false;
  dispatchReactBtn.disabled = false;
});

// Adding Sessions
addSessionQuickBtn.addEventListener('click', () => {
  const currentCount = sessionsState.size;
  const nextNum = currentCount + 1;
  const id = `account_${String(nextNum).padStart(2, '0')}`;
  const label = `Account #${nextNum}`;

  socket.emit('create_session', { id, label });
  appendLog(`Initializing ${id}... Generating pairing QR code.`);
  openQRModal(id);
});

batchAddBtn.addEventListener('click', () => {
  const currentCount = sessionsState.size;
  appendLog(`Adding batch of 5 accounts...`, 'info');
  for (let i = 1; i <= 5; i++) {
    const num = currentCount + i;
    const id = `account_${String(num).padStart(2, '0')}`;
    const label = `Account #${num}`;
    socket.emit('create_session', { id, label });
  }
});

// Tab Navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    const targetId = btn.getAttribute('data-tab');
    document.getElementById(targetId).classList.add('active');
  });
});

// Emoji Picker
document.querySelectorAll('.emoji-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedEmoji = btn.getAttribute('data-emoji');
  });
});

// Dispatch: Broadcast Message
dispatchMessageBtn.addEventListener('click', () => {
  const target = msgTargetInput.value.trim();
  const message = msgTextInput.value.trim();
  const minDelay = parseFloat(minDelayInput.value) * 1000 || 1000;
  const maxDelay = parseFloat(maxDelayInput.value) * 1000 || 2500;
  const simulateTyping = simulateTypingInput.checked;

  if (!target) {
    alert('Please enter a target recipient phone number or group JID');
    return;
  }
  if (!message) {
    alert('Please enter a message payload');
    return;
  }

  dispatchMessageBtn.disabled = true;
  appendLog(`🚀 Dispatching broadcast mirror to ${target}...`, 'info');

  socket.emit('mirror_send', {
    target,
    message,
    minDelay,
    maxDelay,
    simulateTyping
  });
});

// Dispatch: Join Group
dispatchJoinBtn.addEventListener('click', () => {
  const inviteLink = groupInviteInput.value.trim();
  if (!inviteLink) {
    alert('Please enter WhatsApp group invite link');
    return;
  }

  dispatchJoinBtn.disabled = true;
  appendLog(`👥 Dispatching group join mirror...`, 'info');

  socket.emit('mirror_join', { inviteLink });
});

// Dispatch: React Emoji
dispatchReactBtn.addEventListener('click', () => {
  const target = reactTargetInput.value.trim();
  const messageId = reactMsgIdInput.value.trim();

  if (!target || !messageId) {
    alert('Please provide target chat and message ID to react');
    return;
  }

  dispatchReactBtn.disabled = true;
  appendLog(`✨ Dispatching emoji reaction [${selectedEmoji}] mirror...`, 'info');

  socket.emit('mirror_react', {
    target,
    messageId,
    emoji: selectedEmoji
  });
});
