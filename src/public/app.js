// Wtsp Wizard — Multi-Device Fleet Controller (Real Android BlueStacks + Puppeteer Web)
const socket = io();

// ── State ────────────────────────────────────────────────────────────────────
let currentFleetMode     = 'android'; // 'android' | 'puppeteer'
let puppetSessions       = new Map(); // id -> session data
let puppetDisplayOrder   = [];        // Array of puppet IDs for drag-and-drop
let masterSessionId      = null;

let adbDevices           = new Map(); // serial -> { serial, model, resolution, status, isMaster }
let adbDisplayOrder      = [];        // Array of serials for drag-and-drop
let masterAdbSerial      = null;

let isMasterModalOpen    = false;
let isFollowMouseEnabled = true;      // Master cursor mirroring toggle
let draggedId            = null;      // Drag and drop tracking (works for both modes)

// Smooth mouse update animation frame tracking
let mouseRafPending = false;
let targetCursorX   = 0;
let targetCursorY   = 0;

// ── DOM Elements ────────────────────────────────────────────────────────────
const totalUnitsCountEl    = document.getElementById('totalUnitsCount');
const activeUnitsCountEl   = document.getElementById('activeUnitsCount');
const activeFilterCountEl  = document.getElementById('activeFilterCount');
const fleetStatusTextEl    = document.getElementById('fleetStatusText');
const phoneFarmGridEl      = document.getElementById('phoneFarmGrid');
const feedStreamEl         = document.getElementById('feedStream');
const themeSelectorEl      = document.getElementById('themeSelector');
const mainFleetTitleEl     = document.getElementById('mainFleetTitle');
const fleetHintTextEl      = document.getElementById('fleetHintText');

// Mode Switcher Elements
const modeAndroidBtn       = document.getElementById('modeAndroidBtn');
const modePuppetBtn        = document.getElementById('modePuppetBtn');
const androidCountBadge    = document.getElementById('androidCountBadge');
const puppetCountBadge     = document.getElementById('puppetCountBadge');
const androidHeaderActions = document.getElementById('androidHeaderActions');
const puppetHeaderActions  = document.getElementById('puppetHeaderActions');

// Action Buttons
const scanAdbBtn           = document.getElementById('scanAdbBtn');
const launchWaBtn          = document.getElementById('launchWaBtn');
const addSingleUnitBtn     = document.getElementById('addSingleUnitBtn');
const addBatchUnitsBtn     = document.getElementById('addBatchUnitsBtn');
const cleanAllBtn          = document.getElementById('cleanAllBtn');
const openMasterStudioBtn  = document.getElementById('openMasterStudioBtn');
const toggleFollowMouseBtn = document.getElementById('toggleFollowMouseBtn');
const modalFollowMouseBtn  = document.getElementById('modalFollowMouseBtn');

// Console Drawer Elements
const commandConsoleEl     = document.getElementById('commandConsole');
const toggleConsoleBtn     = document.getElementById('toggleConsoleBtn');
const collapseConsoleBtn   = document.getElementById('collapseConsoleBtn');

// Broadcast Inputs
const targetRecipientInput  = document.getElementById('targetRecipient');
const broadcastMessageInput = document.getElementById('broadcastMessage');
const fireBroadcastBtn      = document.getElementById('fireBroadcastBtn');
const minJitterInput        = document.getElementById('minJitter');
const maxJitterInput        = document.getElementById('maxJitter');
const humanTypingCheck      = document.getElementById('humanTypingCheck');

// Master Focus Studio Modal Elements
const masterStudioModalEl       = document.getElementById('masterStudioModal');
const closeMasterStudioBtn      = document.getElementById('closeMasterStudioBtn');
const masterFocusTitleEl        = document.getElementById('masterFocusTitle');
const masterStudioViewportEl    = document.getElementById('masterStudioViewport');
const masterStudioScreenEl      = document.getElementById('masterStudioScreen');
const masterStudioPlaceholderEl = document.getElementById('masterStudioPlaceholder');
const masterModalGhostCursorEl  = document.getElementById('masterModalGhostCursor');
const modalAndroidNavEl         = document.getElementById('modalAndroidNav');

// ── 1. Accurate Coordinates Helper ──────────────────────────────────────────
function calculateAccurateCoordinates(event, containerEl, imgEl, nativeWidth = 1080, nativeHeight = 1920) {
  const targetRect = (imgEl && imgEl.style.display !== 'none' && imgEl.offsetWidth > 0)
    ? imgEl.getBoundingClientRect()
    : containerEl.getBoundingClientRect();

  const cWidth = targetRect.width;
  const cHeight = targetRect.height;

  if (cWidth <= 0 || cHeight <= 0) return { xPct: 50, yPct: 50 };

  const nativeAspect = nativeWidth / nativeHeight;
  const containerAspect = cWidth / cHeight;

  let renderedW, renderedH, padX = 0, padY = 0;

  if (containerAspect > nativeAspect) {
    renderedH = cHeight;
    renderedW = cHeight * nativeAspect;
    padX = (cWidth - renderedW) / 2;
  } else {
    renderedW = cWidth;
    renderedH = cWidth / nativeAspect;
    padY = (cHeight - renderedH) / 2;
  }

  const rawX = event.clientX - targetRect.left - padX;
  const rawY = event.clientY - targetRect.top - padY;

  const xPct = Math.max(0, Math.min(100, (rawX / renderedW) * 100));
  const yPct = Math.max(0, Math.min(100, (rawY / renderedH) * 100));

  return { xPct, yPct };
}

function getNextPuppetId() {
  let i = 1;
  while (puppetSessions.has(`puppet_${String(i).padStart(2, '0')}`)) {
    i++;
  }
  return {
    id: `puppet_${String(i).padStart(2, '0')}`,
    label: `WhatsApp ${i}`
  };
}

// ── 2. Theme Engine ─────────────────────────────────────────────────────────
function initTheme() {
  const savedTheme = localStorage.getItem('wtsp_wizard_theme') || 'midnight';
  document.documentElement.setAttribute('data-theme', savedTheme);
  if (themeSelectorEl) themeSelectorEl.value = savedTheme;
}

if (themeSelectorEl) {
  themeSelectorEl.addEventListener('change', (e) => {
    const newTheme = e.target.value;
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('wtsp_wizard_theme', newTheme);
    logFeed(`Applied visual theme: ${newTheme.toUpperCase()}`);
  });
}
initTheme();

// ── 3. Activity Feed Logger ─────────────────────────────────────────────────
function logFeed(msg) {
  if (!feedStreamEl) return;
  const time = new Date().toLocaleTimeString();
  feedStreamEl.textContent = `[${time}] ${msg}`;
}

// ── 4. Follow Mouse Toggle ──────────────────────────────────────────────────
function updateFollowMouseUI() {
  const text = isFollowMouseEnabled ? '🎯 Follow Mouse: ON' : '🚫 Follow Mouse: OFF';
  [toggleFollowMouseBtn, modalFollowMouseBtn].forEach(btn => {
    if (btn) {
      btn.textContent = text;
      if (isFollowMouseEnabled) {
        btn.classList.add('active-toggle');
        btn.classList.remove('inactive-toggle');
      } else {
        btn.classList.remove('active-toggle');
        btn.classList.add('inactive-toggle');
      }
    }
  });

  if (!isFollowMouseEnabled) {
    document.querySelectorAll('.ghost-cursor').forEach(c => c.classList.remove('visible'));
    if (masterModalGhostCursorEl) masterModalGhostCursorEl.style.display = 'none';
  }
}

function toggleFollowMouse() {
  isFollowMouseEnabled = !isFollowMouseEnabled;
  updateFollowMouseUI();
  logFeed(`Cursor mirroring ${isFollowMouseEnabled ? 'ENABLED' : 'DISABLED'}`);
}

if (toggleFollowMouseBtn) toggleFollowMouseBtn.addEventListener('click', toggleFollowMouse);
if (modalFollowMouseBtn) modalFollowMouseBtn.addEventListener('click', toggleFollowMouse);

function scheduleCursorUpdate(xPct, yPct) {
  if (!isFollowMouseEnabled) return;
  targetCursorX = xPct;
  targetCursorY = yPct;

  if (!mouseRafPending) {
    mouseRafPending = true;
    requestAnimationFrame(() => {
      document.querySelectorAll('.ghost-cursor').forEach(cursor => {
        const card = cursor.closest('.device-card');
        const currentMasterId = (currentFleetMode === 'android') ? `device-card-${masterAdbSerial}` : `device-card-${masterSessionId}`;
        if (card && card.id !== currentMasterId) {
          cursor.style.left = `${targetCursorX}%`;
          cursor.style.top  = `${targetCursorY}%`;
          cursor.classList.add('visible');
        }
      });
      mouseRafPending = false;
    });
  }
}

// ── 5. Mode Switcher (Android BlueStacks vs Puppeteer Web) ────────────────────
function switchFleetMode(mode) {
  currentFleetMode = mode;

  if (mode === 'android') {
    if (modeAndroidBtn) modeAndroidBtn.classList.add('active');
    if (modePuppetBtn) modePuppetBtn.classList.remove('active');
    if (androidHeaderActions) androidHeaderActions.style.display = 'flex';
    if (puppetHeaderActions) puppetHeaderActions.style.display = 'none';
    if (modalAndroidNavEl) modalAndroidNavEl.style.display = 'flex';
    if (mainFleetTitleEl) mainFleetTitleEl.textContent = 'Real Android Fleet (BlueStacks)';
    if (fleetHintTextEl) fleetHintTextEl.textContent = 'Real Android OS • Direct SMS Login • Mirror Tap & Keys';
    logFeed('Switched to Real Android / BlueStacks Phone Farm mode.');
  } else {
    if (modePuppetBtn) modePuppetBtn.classList.add('active');
    if (modeAndroidBtn) modeAndroidBtn.classList.remove('active');
    if (puppetHeaderActions) puppetHeaderActions.style.display = 'flex';
    if (androidHeaderActions) androidHeaderActions.style.display = 'none';
    if (modalAndroidNavEl) modalAndroidNavEl.style.display = 'none';
    if (mainFleetTitleEl) mainFleetTitleEl.textContent = 'Real WhatsApp Web Fleet';
    if (fleetHintTextEl) fleetHintTextEl.textContent = 'Web Companion Instances • Drag & drop cards to reorder';
    logFeed('Switched to WhatsApp Web (Puppeteer) mode.');
  }

  renderDeviceGrid();
}

if (modeAndroidBtn) modeAndroidBtn.addEventListener('click', () => switchFleetMode('android'));
if (modePuppetBtn) modePuppetBtn.addEventListener('click', () => switchFleetMode('puppeteer'));

// ── 6. Grid Rendering Engine ────────────────────────────────────────────────
function renderDeviceGrid() {
  if (androidCountBadge) androidCountBadge.textContent = adbDevices.size;
  if (puppetCountBadge) puppetCountBadge.textContent = puppetSessions.size;

  if (currentFleetMode === 'android') {
    renderAndroidGrid();
  } else {
    renderPuppetGrid();
  }
}

// ── 6A. Real Android / BlueStacks Grid Renderer ─────────────────────────────
function renderAndroidGrid() {
  const currentSerials = Array.from(adbDevices.keys());
  adbDisplayOrder = adbDisplayOrder.filter(s => adbDevices.has(s));
  for (const s of currentSerials) {
    if (!adbDisplayOrder.includes(s)) adbDisplayOrder.push(s);
  }

  const totalCount = adbDevices.size;
  const connectedCount = Array.from(adbDevices.values()).filter(d => d.status === 'online').length;

  if (totalUnitsCountEl) totalUnitsCountEl.textContent = totalCount;
  if (activeUnitsCountEl) activeUnitsCountEl.textContent = connectedCount;
  if (activeFilterCountEl) activeFilterCountEl.textContent = `${totalCount} Android Emulators / Phones (${connectedCount} Online)`;

  if (!masterAdbSerial || !adbDevices.has(masterAdbSerial)) {
    masterAdbSerial = adbDisplayOrder.length > 0 ? adbDisplayOrder[0] : null;
    if (masterAdbSerial) socket.emit('adb_set_master', { serial: masterAdbSerial });
  }

  if (totalCount > 0 && masterAdbSerial) {
    fleetStatusTextEl.innerHTML = `
      <div class="sync-status-badge">
        <span class="sync-dot"></span>
        <span>ANDROID SYNC // MASTER: ${masterAdbSerial.toUpperCase()}</span>
      </div>
    `;
    if (openMasterStudioBtn) openMasterStudioBtn.style.display = 'inline-flex';
  } else {
    fleetStatusTextEl.innerHTML = `<span class="status-indicator">STANDBY</span>`;
    if (openMasterStudioBtn) openMasterStudioBtn.style.display = 'none';
  }

  if (totalCount === 0) {
    phoneFarmGridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 16px; color: var(--text-muted);">
        <div style="font-size: 38px; margin-bottom: 12px;">📱</div>
        <p style="font-weight: 600; font-size: 15px; color: var(--text-primary);">No Android / BlueStacks Devices Detected</p>
        <p style="font-size: 12px; margin-top: 6px; color: var(--text-muted); max-width: 500px; margin-left: auto; margin-right: auto; line-height: 1.6;">
          Start BlueStacks 5 or connect your Android phones via USB, then click <strong>🔍 Scan ADB</strong> above.<br>
          <span style="color: var(--accent);">Tip: BlueStacks ADB access is enabled automatically on port 5555.</span>
        </p>
      </div>
    `;
    return;
  }

  phoneFarmGridEl.innerHTML = '';

  adbDisplayOrder.forEach((serial) => {
    const dev = adbDevices.get(serial);
    if (!dev) return;

    const isMaster = (dev.serial === masterAdbSerial);
    const card = document.createElement('div');
    card.className = `device-card ${isMaster ? 'is-master' : ''}`;
    card.id = `device-card-${dev.serial}`;
    card.setAttribute('draggable', 'true');
    card.setAttribute('data-id', dev.serial);

    card.innerHTML = `
      <div class="device-card-header" title="Drag to reorder like a puzzle">
        <div class="instance-label">
          <span style="font-size: 11px; font-weight: 600;">${dev.model}</span>
          <span style="font-size: 9px; color: var(--text-muted); font-family: monospace;">(${dev.serial})</span>
          ${isMaster ? '<span class="master-indicator">MASTER</span>' : ''}
        </div>
        <span class="instance-tag tag-online">ONLINE</span>
      </div>

      <div class="phone-screen-viewport adb-viewport" id="viewport-${dev.serial}" data-serial="${dev.serial}" style="aspect-ratio: 9/16;">
        <div class="ghost-cursor" id="cursor-${dev.serial}"></div>
        <img
          id="adb-screen-${dev.serial}"
          class="android-screen-img"
          src=""
          alt="Android Screen"
          style="display: none;"
        >
        <div class="puppet-placeholder" id="adb-placeholder-${dev.serial}">
          <div class="unpaired-icon" style="font-size: 32px;">📱</div>
          <div class="unpaired-title">${dev.model}</div>
          <div class="unpaired-subtitle" style="margin-top: 4px;">Streaming Android screen buffer...</div>
        </div>
      </div>

      <!-- Android Soft Navigation Bar -->
      <div class="android-soft-nav">
        <button class="android-nav-btn adb-key-btn" data-serial="${dev.serial}" data-key="4" title="Android Back">◀ Back</button>
        <button class="android-nav-btn adb-key-btn" data-serial="${dev.serial}" data-key="3" title="Android Home">● Home</button>
        <button class="android-nav-btn adb-key-btn" data-serial="${dev.serial}" data-key="187" title="Android Recent Apps">■ Apps</button>
        <button class="android-nav-btn adb-key-btn" data-serial="${dev.serial}" data-key="66" title="Android Enter">⏎ Enter</button>
      </div>

      <div class="device-card-footer">
        <button class="btn-card btn-master ${isMaster ? 'is-active' : ''} adb-master-btn" data-serial="${dev.serial}">
          ${isMaster ? '★ Master' : 'Set Master'}
        </button>
        ${isMaster ? `
          <button class="btn-card highlight adb-expand-btn" data-serial="${dev.serial}" title="Open large master screen">
            ⛶ Expand
          </button>
        ` : ''}
        <button class="btn-card adb-open-wa-btn" data-serial="${dev.serial}" title="Launch WhatsApp on this device">
          🚀 Open WA
        </button>
      </div>
    `;

    phoneFarmGridEl.appendChild(card);
  });

  attachAndroidInteractiveEvents();
  attachDragAndDropEvents('android');
}

// ── 6B. Real WhatsApp Web (Puppeteer) Grid Renderer ─────────────────────────
function renderPuppetGrid() {
  const currentIds = Array.from(puppetSessions.keys());
  puppetDisplayOrder = puppetDisplayOrder.filter(id => puppetSessions.has(id));
  for (const id of currentIds) {
    if (!puppetDisplayOrder.includes(id)) puppetDisplayOrder.push(id);
  }

  const totalCount = puppetSessions.size;
  const connectedCount = Array.from(puppetSessions.values()).filter(s => s.status === 'connected').length;

  if (totalUnitsCountEl) totalUnitsCountEl.textContent = totalCount;
  if (activeUnitsCountEl) activeUnitsCountEl.textContent = connectedCount;
  if (activeFilterCountEl) activeFilterCountEl.textContent = `${totalCount} Real WhatsApp Instances (${connectedCount} Online)`;

  if (!masterSessionId || !puppetSessions.has(masterSessionId)) {
    masterSessionId = puppetDisplayOrder.length > 0 ? puppetDisplayOrder[0] : null;
    if (masterSessionId) socket.emit('puppet_set_master', { id: masterSessionId });
  }

  if (totalCount > 0 && masterSessionId) {
    fleetStatusTextEl.innerHTML = `
      <div class="sync-status-badge">
        <span class="sync-dot"></span>
        <span>SYNC ACTIVE // MASTER: ${masterSessionId.toUpperCase()}</span>
      </div>
    `;
    if (openMasterStudioBtn) openMasterStudioBtn.style.display = 'inline-flex';
  } else {
    fleetStatusTextEl.innerHTML = `<span class="status-indicator">STANDBY</span>`;
    if (openMasterStudioBtn) openMasterStudioBtn.style.display = 'none';
  }

  if (totalCount === 0) {
    phoneFarmGridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 16px; color: var(--text-muted);">
        <div style="font-size: 32px; margin-bottom: 12px;">🌐</div>
        <p style="font-weight: 600; font-size: 14px; color: var(--text-primary);">No WhatsApp Web Instances Active</p>
        <p style="font-size: 12px; margin-top: 6px; color: var(--text-muted);">
          Click <strong>+ Add Device</strong> for 1 instance, or <strong>+ Batch (5)</strong> to launch 5 real WhatsApp Web browsers.
        </p>
      </div>
    `;
    return;
  }

  phoneFarmGridEl.innerHTML = '';

  puppetDisplayOrder.forEach((id) => {
    const unit = puppetSessions.get(id);
    if (!unit) return;

    const isMaster = unit.id === masterSessionId;
    const card = document.createElement('div');
    card.className = `device-card ${isMaster ? 'is-master' : ''}`;
    card.id = `device-card-${unit.id}`;
    card.setAttribute('draggable', 'true');
    card.setAttribute('data-id', unit.id);

    const isQr = (unit.status === 'qr_ready');
    const isConn = (unit.status === 'connected');

    const statusLabel = isConn ? 'Online'
      : isQr ? 'Scan QR'
      : unit.status === 'loading' ? 'Loading...'
      : 'Offline';

    const statusTag = isConn ? 'online' : isQr ? 'standby' : 'offline';
    const displayName = unit.accountName
      ? `${unit.label || unit.id} (${unit.accountName})`
      : (unit.label || unit.id);

    card.innerHTML = `
      <div class="device-card-header" title="Drag to reorder like a puzzle">
        <div class="instance-label">
          <span style="font-size: 11px; font-weight: 600;">${displayName}</span>
          ${isMaster ? '<span class="master-indicator">MASTER</span>' : ''}
        </div>
        <span class="instance-tag tag-${statusTag}">${statusLabel}</span>
      </div>

      <div class="phone-screen-viewport puppet-viewport" id="viewport-${unit.id}" data-puppet-id="${unit.id}">
        <div class="ghost-cursor" id="cursor-${unit.id}"></div>
        <img
          id="puppet-screen-${unit.id}"
          class="puppet-live-screen ${isQr ? 'qr-zoom' : ''}"
          src=""
          alt="WhatsApp Web Live"
          style="display: none;"
        >
        <div class="puppet-placeholder" id="puppet-placeholder-${unit.id}">
          <div class="unpaired-icon" style="font-size: 26px;">🌐</div>
          <div class="unpaired-title">${unit.label || unit.id}</div>
          <div class="unpaired-subtitle" style="margin-top: 4px;">${
            unit.status === 'loading' ? 'Launching Chrome & WhatsApp Web...' :
            isQr ? 'Point phone camera at QR code' :
            isConn ? 'Connected — streaming live screen...' :
            'Initializing session'
          }</div>
        </div>
      </div>

      <div class="device-card-footer">
        <button class="btn-card btn-master ${isMaster ? 'is-active' : ''} puppet-master-btn" data-id="${unit.id}">
          ${isMaster ? '★ Master' : 'Set Master'}
        </button>
        ${isMaster ? `
          <button class="btn-card highlight master-expand-btn" data-id="${unit.id}" title="Open large master screen">
            ⛶ Expand
          </button>
        ` : ''}
        <button class="btn-card danger puppet-close-btn" data-id="${unit.id}" title="Close Instance">&times;</button>
      </div>
    `;

    phoneFarmGridEl.appendChild(card);
  });

  attachPuppetInteractiveEvents();
  attachDragAndDropEvents('puppeteer');
}

// ── 7. Android Interactive Events (Taps, Keys & Gestures) ────────────────────
function attachAndroidInteractiveEvents() {
  // Set Master Android
  document.querySelectorAll('.adb-master-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const serial = btn.getAttribute('data-serial');
      masterAdbSerial = serial;
      socket.emit('adb_set_master', { serial });
      logFeed(`⭐ DESIGNATED MASTER ANDROID: ${serial}`);
      renderDeviceGrid();
    });
  });

  // Expand Master Android Modal
  document.querySelectorAll('.adb-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMasterStudio();
    });
  });

  // Launch WhatsApp on specific device
  document.querySelectorAll('.adb-open-wa-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const serial = btn.getAttribute('data-serial');
      socket.emit('adb_launch_wa');
      logFeed(`🚀 Launching WhatsApp on ${serial}...`);
    });
  });

  // Android Soft Key Navigation Buttons
  document.querySelectorAll('.adb-key-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const keyCode = parseInt(btn.getAttribute('data-key'), 10);
      socket.emit('adb_key', { keyCode });
      const keyName = keyCode === 4 ? 'Back' : keyCode === 3 ? 'Home' : keyCode === 187 ? 'Recent Apps' : 'Enter';
      logFeed(`Pressed Android [${keyName}] -> Mirrored to all devices`);
    });
  });

  // Tap & Mouse tracking on Android Viewport
  document.querySelectorAll('.adb-viewport').forEach(vp => {
    const serial = vp.getAttribute('data-serial');
    const dev = adbDevices.get(serial);
    const nativeW = dev?.resolution?.width || 1080;
    const nativeH = dev?.resolution?.height || 1920;

    vp.addEventListener('click', (e) => {
      const img = document.getElementById(`adb-screen-${serial}`);
      const { xPct, yPct } = calculateAccurateCoordinates(e, vp, img, nativeW, nativeH);

      if (serial === masterAdbSerial) {
        socket.emit('adb_tap', { xPct, yPct });
        logFeed(`Master tap at (${Math.round(xPct)}%, ${Math.round(yPct)}%) -> Mirrored to all Android devices`);
      } else {
        socket.emit('adb_single_tap', { serial, xPct, yPct });
        logFeed(`Single tap on [${serial}] at (${Math.round(xPct)}%, ${Math.round(yPct)}%) (No mirroring)`);
      }
    });
  });

  // Ghost Cursor Mirroring on Android Grid
  if (masterAdbSerial && adbDevices.has(masterAdbSerial)) {
    const masterVp = document.getElementById(`viewport-${masterAdbSerial}`);
    if (masterVp) {
      masterVp.addEventListener('mousemove', (e) => {
        if (!isFollowMouseEnabled) return;
        const rect = masterVp.getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
        scheduleCursorUpdate(xPct, yPct);
      });

      masterVp.addEventListener('mouseleave', () => {
        document.querySelectorAll('.ghost-cursor').forEach(c => c.classList.remove('visible'));
      });
    }
  }
}

// ── 8. Puppeteer Interactive Events ─────────────────────────────────────────
function attachPuppetInteractiveEvents() {
  document.querySelectorAll('.puppet-master-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      masterSessionId = id;
      socket.emit('puppet_set_master', { id: masterSessionId });
      logFeed(`⭐ DESIGNATED MASTER CONTROLLER: ${id.toUpperCase()}`);
      renderDeviceGrid();
    });
  });

  document.querySelectorAll('.master-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMasterStudio();
    });
  });

  document.querySelectorAll('.puppet-close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      if (confirm(`Close WhatsApp instance "${id}"?`)) {
        socket.emit('puppet_close', { id });
        logFeed(`Closing session: ${id}`);
      }
    });
  });

  document.querySelectorAll('.puppet-viewport').forEach(vp => {
    const sessionId = vp.getAttribute('data-puppet-id');

    vp.addEventListener('click', (e) => {
      const cardImg = document.getElementById(`puppet-screen-${sessionId}`);
      const { xPct, yPct } = calculateAccurateCoordinates(e, vp, cardImg, 1280, 820);

      if (sessionId === masterSessionId) {
        socket.emit('puppet_click', { masterId: sessionId, xPct, yPct });
        logFeed(`Master tap at (${Math.round(xPct)}%, ${Math.round(yPct)}%) -> Mirrored across all WhatsApp instances`);
      } else {
        socket.emit('puppet_single_click', { id: sessionId, xPct, yPct });
        logFeed(`Single tap on [${sessionId}] at (${Math.round(xPct)}%, ${Math.round(yPct)}%) (No mirroring)`);
      }
    });

    vp.addEventListener('wheel', (e) => {
      if (sessionId === masterSessionId) {
        e.preventDefault();
        const rect = vp.getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
        socket.emit('puppet_scroll', { masterId: sessionId, xPct, yPct, deltaY: e.deltaY });
      }
    }, { passive: false });
  });

  if (masterSessionId && puppetSessions.has(masterSessionId)) {
    const masterVp = document.getElementById(`viewport-${masterSessionId}`);
    if (masterVp) {
      masterVp.addEventListener('mousemove', (e) => {
        if (!isFollowMouseEnabled) return;
        const rect = masterVp.getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
        scheduleCursorUpdate(xPct, yPct);
      });

      masterVp.addEventListener('mouseleave', () => {
        document.querySelectorAll('.ghost-cursor').forEach(c => c.classList.remove('visible'));
      });
    }
  }
}

// ── 9. Drag and Drop Reordering ─────────────────────────────────────────────
function attachDragAndDropEvents(mode) {
  const cards = document.querySelectorAll('.device-card');

  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedId = card.getAttribute('data-id');
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedId);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      cards.forEach(c => c.classList.remove('drag-over'));
      draggedId = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetId = card.getAttribute('data-id');
      if (draggedId && draggedId !== targetId) {
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetId = card.getAttribute('data-id');

      if (!draggedId || draggedId === targetId) return;

      const orderArray = (mode === 'android') ? adbDisplayOrder : puppetDisplayOrder;
      const fromIndex = orderArray.indexOf(draggedId);
      const toIndex = orderArray.indexOf(targetId);

      if (fromIndex !== -1 && toIndex !== -1) {
        orderArray.splice(fromIndex, 1);
        orderArray.splice(toIndex, 0, draggedId);
        logFeed(`Reordered tile [${draggedId}] to position ${toIndex + 1}`);
        renderDeviceGrid();
      }
    });
  });
}

// ── 10. Big Pop-up Master Studio Modal Logic ────────────────────────────────
function openMasterStudio() {
  const activeMaster = (currentFleetMode === 'android') ? masterAdbSerial : masterSessionId;
  if (!activeMaster) return;

  isMasterModalOpen = true;

  if (masterFocusTitleEl) {
    masterFocusTitleEl.textContent = (currentFleetMode === 'android')
      ? `Master Android Studio [${activeMaster}]`
      : `Master WhatsApp Studio [${activeMaster.toUpperCase()}]`;
  }
  if (masterStudioModalEl) {
    masterStudioModalEl.classList.add('show');
  }
  logFeed(`⛶ Opened expanded Master Studio for [${activeMaster}]`);
}

function closeMasterStudio() {
  isMasterModalOpen = false;
  if (masterStudioModalEl) {
    masterStudioModalEl.classList.remove('show');
  }
}

if (openMasterStudioBtn) openMasterStudioBtn.addEventListener('click', openMasterStudio);
if (closeMasterStudioBtn) closeMasterStudioBtn.addEventListener('click', closeMasterStudio);

// Click mirroring inside Master Studio Modal
if (masterStudioViewportEl) {
  masterStudioViewportEl.addEventListener('click', (e) => {
    if (currentFleetMode === 'android') {
      if (!masterAdbSerial) return;
      const dev = adbDevices.get(masterAdbSerial);
      const nativeW = dev?.resolution?.width || 1080;
      const nativeH = dev?.resolution?.height || 1920;
      const { xPct, yPct } = calculateAccurateCoordinates(e, masterStudioViewportEl, masterStudioScreenEl, nativeW, nativeH);

      socket.emit('adb_tap', { xPct, yPct });
      logFeed(`🎯 Master Studio Tap (${Math.round(xPct)}%, ${Math.round(yPct)}%) -> Replicating to all Android instances`);
    } else {
      if (!masterSessionId) return;
      const { xPct, yPct } = calculateAccurateCoordinates(e, masterStudioViewportEl, masterStudioScreenEl, 1280, 820);

      socket.emit('puppet_click', { masterId: masterSessionId, xPct, yPct });
      logFeed(`🎯 Master Studio Click (${Math.round(xPct)}%, ${Math.round(yPct)}%) -> Replicating to all background instances`);
    }
  });

  // Modal Mousemove for Ghost Cursor
  masterStudioViewportEl.addEventListener('mousemove', (e) => {
    const activeMaster = (currentFleetMode === 'android') ? masterAdbSerial : masterSessionId;
    if (!activeMaster || !isFollowMouseEnabled) return;
    const rect = masterStudioViewportEl.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
    scheduleCursorUpdate(xPct, yPct);
  });

  masterStudioViewportEl.addEventListener('mouseleave', () => {
    document.querySelectorAll('.ghost-cursor').forEach(c => c.classList.remove('visible'));
  });
}

// Modal Android Soft Keys
document.querySelectorAll('.modal-adb-key').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const keyCode = parseInt(btn.getAttribute('data-key'), 10);
    socket.emit('adb_key', { keyCode });
    const keyName = keyCode === 4 ? 'Back' : keyCode === 3 ? 'Home' : keyCode === 187 ? 'Recent Apps' : 'Enter';
    logFeed(`Master Studio pressed [${keyName}] -> Mirrored to all devices`);
  });
});

// Global Keypress Mirroring
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Escape') {
    if (isMasterModalOpen) closeMasterStudio();
    return;
  }

  if (currentFleetMode === 'android') {
    if (!masterAdbSerial) return;
    if (e.key.length === 1) {
      socket.emit('adb_text', { text: e.key });
    } else if (e.key === 'Backspace') {
      socket.emit('adb_key', { keyCode: 67 });
    } else if (e.key === 'Enter') {
      socket.emit('adb_key', { keyCode: 66 });
    }
  } else {
    if (!masterSessionId) return;
    if (e.key.length === 1) {
      socket.emit('puppet_type', { masterId: masterSessionId, text: e.key });
    } else if (['Enter', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
      socket.emit('puppet_key', { masterId: masterSessionId, key: e.key });
    }
  }
});

// ── 11. Header Action Buttons ───────────────────────────────────────────────
if (scanAdbBtn) {
  scanAdbBtn.addEventListener('click', () => {
    logFeed('🔍 Scanning ADB & BlueStacks ports (5555, 5565...)...');
    socket.emit('adb_scan');
  });
}

if (launchWaBtn) {
  launchWaBtn.addEventListener('click', () => {
    logFeed('🚀 Launching WhatsApp on all Android devices...');
    socket.emit('adb_launch_wa');
  });
}

if (addSingleUnitBtn) {
  addSingleUnitBtn.addEventListener('click', () => {
    const next = getNextPuppetId();
    socket.emit('puppet_create', { id: next.id, label: next.label });
    logFeed(`🚀 Launching real WhatsApp instance [${next.id}]...`);
  });
}

if (addBatchUnitsBtn) {
  addBatchUnitsBtn.addEventListener('click', () => {
    logFeed(`⚡ Spawning Batch of 5 Real WhatsApp Web instances...`);
    socket.emit('puppet_batch', { count: 5 });
  });
}

if (cleanAllBtn) {
  cleanAllBtn.addEventListener('click', () => {
    if (confirm('Close and clean ALL running WhatsApp Web instances?')) {
      socket.emit('puppet_clear_all');
      logFeed('🧹 Closing all WhatsApp instances...');
    }
  });
}

if (fireBroadcastBtn) {
  fireBroadcastBtn.addEventListener('click', () => {
    const message = broadcastMessageInput ? broadcastMessageInput.value.trim() : '';
    const target  = targetRecipientInput  ? targetRecipientInput.value.trim()  : '';

    if (!message) {
      alert('Please enter a message template to broadcast');
      return;
    }

    if (currentFleetMode === 'android') {
      if (adbDevices.size === 0) {
        alert('No Android devices active');
        return;
      }
      fireBroadcastBtn.disabled = true;
      logFeed(`Mirroring text broadcast to all ${adbDevices.size} Android devices...`);
      socket.emit('adb_text', { text: message });
      setTimeout(() => {
        socket.emit('adb_key', { keyCode: 66 }); // Enter
        fireBroadcastBtn.disabled = false;
        logFeed('Android broadcast text & enter dispatched.');
      }, 600);
    } else {
      if (puppetSessions.size === 0) {
        alert('No WhatsApp instances active');
        return;
      }
      const minDelay = minJitterInput ? parseFloat(minJitterInput.value) * 1000 : 1000;
      const maxDelay = maxJitterInput ? parseFloat(maxJitterInput.value) * 1000 : 2500;
      const simulateTyping = humanTypingCheck ? humanTypingCheck.checked : true;

      fireBroadcastBtn.disabled = true;
      fireBroadcastBtn.textContent = 'Dispatching...';
      logFeed(`🚀 Initiating fleet broadcast to ${puppetSessions.size} instances ${target ? `(Target: ${target})` : '(Open Chats)'}...`);

      socket.emit('puppet_broadcast', {
        target,
        message,
        minDelay,
        maxDelay,
        simulateTyping
      });
    }
  });
}

// ── 12. Socket.io Event Listeners ───────────────────────────────────────────
socket.on('initial_state', ({ puppetSessions: initialPuppet, adbDevices: initialAdb }) => {
  puppetSessions.clear();
  adbDevices.clear();

  if (initialPuppet) initialPuppet.forEach(p => puppetSessions.set(p.id, p));
  if (initialAdb) initialAdb.forEach(d => adbDevices.set(d.serial, d));

  renderDeviceGrid();
  logFeed(`Connected to studio. [${adbDevices.size} Android Devices | ${puppetSessions.size} Web Sessions]`);
});

// Android Event Listeners
socket.on('adb_devices_update', (devices) => {
  adbDevices.clear();
  devices.forEach(d => adbDevices.set(d.serial, d));
  renderDeviceGrid();
  logFeed(`Android Fleet updated: ${adbDevices.size} emulator/phone instances.`);
});

socket.on('adb_screenshot', ({ serial, screenshot }) => {
  const img = document.getElementById(`adb-screen-${serial}`);
  const placeholder = document.getElementById(`adb-placeholder-${serial}`);

  if (img) {
    img.src = screenshot;
    img.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
  }

  if (serial === masterAdbSerial && currentFleetMode === 'android') {
    if (masterStudioScreenEl) {
      masterStudioScreenEl.src = screenshot;
      masterStudioScreenEl.style.display = 'block';
    }
    if (masterStudioPlaceholderEl) {
      masterStudioPlaceholderEl.style.display = 'none';
    }
  }
});

// Puppeteer Event Listeners
socket.on('puppet_session_update', (session) => {
  puppetSessions.set(session.id, session);
  renderDeviceGrid();
  logFeed(`Instance [${session.id}] status: ${session.status.toUpperCase()}`);
});

socket.on('puppet_session_removed', (id) => {
  puppetSessions.delete(id);
  renderDeviceGrid();
  logFeed(`Instance [${id}] decommissioned.`);
});

socket.on('puppet_screenshot', ({ id, screenshot }) => {
  const cardImg = document.getElementById(`puppet-screen-${id}`);
  const placeholder = document.getElementById(`puppet-placeholder-${id}`);
  const unit = puppetSessions.get(id);

  if (cardImg) {
    cardImg.src = screenshot;
    cardImg.style.display = 'block';
    if (unit && unit.status === 'qr_ready') {
      cardImg.classList.add('qr-zoom');
    } else {
      cardImg.classList.remove('qr-zoom');
    }
    if (placeholder) placeholder.style.display = 'none';
  }

  if (id === masterSessionId && currentFleetMode === 'puppeteer') {
    if (masterStudioScreenEl) {
      masterStudioScreenEl.src = screenshot;
      masterStudioScreenEl.style.display = 'block';
    }
    if (masterStudioPlaceholderEl) {
      masterStudioPlaceholderEl.style.display = 'none';
    }
  }
});

socket.on('action_started', (data) => {
  logFeed(`📡 Fleet action started (${data.total} devices) -> Target: ${data.target}`);
});

socket.on('action_progress', (data) => {
  logFeed(`Progress [${data.current}/${data.total}]: ${data.sessionId} -> ${data.status.toUpperCase()}`);
});

socket.on('action_completed', () => {
  if (fireBroadcastBtn) {
    fireBroadcastBtn.disabled = false;
    fireBroadcastBtn.textContent = 'Dispatch to Fleet';
  }
  logFeed(`✅ Broadcast transmission completed successfully across all devices.`);
});

socket.on('operation_error', (data) => {
  logFeed(`[Error] ${data.message}`);
  alert(data.message);
  if (fireBroadcastBtn) {
    fireBroadcastBtn.disabled = false;
    fireBroadcastBtn.textContent = 'Dispatch to Fleet';
  }
});

// Console drawer toggle shortcut
function toggleConsole() {
  if (commandConsoleEl) commandConsoleEl.classList.toggle('collapsed');
}
if (toggleConsoleBtn) toggleConsoleBtn.addEventListener('click', toggleConsole);
if (collapseConsoleBtn) collapseConsoleBtn.addEventListener('click', toggleConsole);

document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'c' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    toggleConsole();
  }
});
