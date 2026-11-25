// Wtsp Wizard — Real WhatsApp Web Multi-Account Fleet Controller
const socket = io();

// ── State ────────────────────────────────────────────────────────────────────
let puppetSessions       = new Map(); // id -> { id, label, accountName, status, type: 'puppeteer', isMaster }
let displayOrder         = [];        // Array of session IDs for drag-and-drop ordering
let masterSessionId      = null;
let isMasterModalOpen    = false;
let isFollowMouseEnabled = true;      // Master cursor mirroring toggle

// Drag and drop tracking
let draggedSessionId = null;

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

// Buttons
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

// Master Focus Studio Modal Elements
const masterStudioModalEl       = document.getElementById('masterStudioModal');
const closeMasterStudioBtn      = document.getElementById('closeMasterStudioBtn');
const masterFocusTitleEl        = document.getElementById('masterFocusTitle');
const masterStudioViewportEl    = document.getElementById('masterStudioViewport');
const masterStudioScreenEl      = document.getElementById('masterStudioScreen');
const masterStudioPlaceholderEl = document.getElementById('masterStudioPlaceholder');
const masterModalGhostCursorEl  = document.getElementById('masterModalGhostCursor');

// ── 1. Theme Engine ─────────────────────────────────────────────────────────
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

// ── 2. Activity Feed Logger ─────────────────────────────────────────────────
function logFeed(msg) {
  if (!feedStreamEl) return;
  const time = new Date().toLocaleTimeString();
  feedStreamEl.textContent = `[${time}] ${msg}`;
}

// ── 3. Follow Mouse Toggle ──────────────────────────────────────────────────
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

// Smooth 60fps cursor dispatch using requestAnimationFrame
function scheduleCursorUpdate(xPct, yPct) {
  if (!isFollowMouseEnabled) return;
  targetCursorX = xPct;
  targetCursorY = yPct;

  if (!mouseRafPending) {
    mouseRafPending = true;
    requestAnimationFrame(() => {
      document.querySelectorAll('.ghost-cursor').forEach(cursor => {
        const card = cursor.closest('.device-card');
        if (card && card.id !== `device-card-${masterSessionId}`) {
          cursor.style.left = `${targetCursorX}%`;
          cursor.style.top  = `${targetCursorY}%`;
          cursor.classList.add('visible');
        }
      });
      mouseRafPending = false;
    });
  }
}

// ── 4. Console Toggle ───────────────────────────────────────────────────────
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

// ── 5. Grid Rendering & Drag-and-Drop System ────────────────────────────────
function syncDisplayOrder() {
  const currentIds = Array.from(puppetSessions.keys());
  displayOrder = displayOrder.filter(id => puppetSessions.has(id));
  for (const id of currentIds) {
    if (!displayOrder.includes(id)) {
      displayOrder.push(id);
    }
  }
}

function renderDeviceGrid() {
  syncDisplayOrder();

  const totalCount = puppetSessions.size;
  const connectedCount = Array.from(puppetSessions.values()).filter(s => s.status === 'connected').length;

  if (totalUnitsCountEl) totalUnitsCountEl.textContent = totalCount;
  if (activeUnitsCountEl) activeUnitsCountEl.textContent = connectedCount;
  if (activeFilterCountEl) activeFilterCountEl.textContent = `${totalCount} Real WhatsApp Instances (${connectedCount} Online)`;

  // Auto-elect Master if none set
  if (!masterSessionId || !puppetSessions.has(masterSessionId)) {
    if (displayOrder.length > 0) {
      masterSessionId = displayOrder[0];
      socket.emit('puppet_set_master', { id: masterSessionId });
    } else {
      masterSessionId = null;
    }
  }

  // Update Status Banner & Open Master Studio Button
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

  // Empty state
  if (totalCount === 0) {
    phoneFarmGridEl.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 16px; color: var(--text-muted);">
        <div style="font-size: 32px; margin-bottom: 12px;">🌐</div>
        <p style="font-weight: 600; font-size: 14px; color: var(--text-primary);">No WhatsApp Instances Active</p>
        <p style="font-size: 12px; margin-top: 6px; color: var(--text-muted);">
          Click <strong>+ Add Device</strong> for 1 instance, or <strong>+ Batch (5)</strong> to launch 5 real WhatsApp Web browsers.
        </p>
      </div>
    `;
    return;
  }

  phoneFarmGridEl.innerHTML = '';

  // Render cards according to displayOrder
  displayOrder.forEach((id, index) => {
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

    const statusTag = isConn ? 'online'
      : isQr ? 'standby' : 'offline';

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
            unit.status === 'loading'   ? 'Launching Chrome & WhatsApp Web...' :
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

  attachInteractiveEvents();
  attachDragAndDropEvents();
}

// ── 6. Drag and Drop Reordering (Puzzle Style) ──────────────────────────────
function attachDragAndDropEvents() {
  const cards = document.querySelectorAll('.device-card');

  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedSessionId = card.getAttribute('data-id');
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedSessionId);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      cards.forEach(c => c.classList.remove('drag-over'));
      draggedSessionId = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetId = card.getAttribute('data-id');
      if (draggedSessionId && draggedSessionId !== targetId) {
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

      if (!draggedSessionId || draggedSessionId === targetId) return;

      const fromIndex = displayOrder.indexOf(draggedSessionId);
      const toIndex = displayOrder.indexOf(targetId);

      if (fromIndex !== -1 && toIndex !== -1) {
        displayOrder.splice(fromIndex, 1);
        displayOrder.splice(toIndex, 0, draggedSessionId);

        logFeed(`Reordered fleet tile [${draggedSessionId}] to position ${toIndex + 1}`);
        renderDeviceGrid();
      }
    });
  });
}

// ── 7. Interactive Events & Action Mirroring ────────────────────────────────
function attachInteractiveEvents() {
  // Set Master button
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

  // Expand Master modal button
  document.querySelectorAll('.master-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMasterStudio();
    });
  });

  // Close single session button
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

  // Click & Mouse tracking on any card's viewport
  document.querySelectorAll('.puppet-viewport').forEach(vp => {
    const sessionId = vp.getAttribute('data-puppet-id');

    vp.addEventListener('click', (e) => {
      const rect = vp.getBoundingClientRect();
      const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top)  / rect.height) * 100));

      if (sessionId === masterSessionId) {
        socket.emit('puppet_click', { masterId: sessionId, xPct, yPct });
        logFeed(`Master tap at (${Math.round(xPct)}%, ${Math.round(yPct)}%) -> Mirrored across all WhatsApp instances`);
      } else {
        socket.emit('puppet_click', { masterId: sessionId, xPct, yPct });
      }
    });

    // Scroll mirror
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

  // Ghost Cursor Mirroring on Grid with requestAnimationFrame
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

// ── 8. Big Pop-up Master Studio Modal Logic ─────────────────────────────────
function openMasterStudio() {
  if (!masterSessionId) return;
  isMasterModalOpen = true;

  if (masterFocusTitleEl) {
    masterFocusTitleEl.textContent = `Master WhatsApp Studio [${masterSessionId.toUpperCase()}]`;
  }
  if (masterStudioModalEl) {
    masterStudioModalEl.classList.add('show');
  }
  logFeed(`⛶ Opened expanded Master Studio for [${masterSessionId}]`);
}

function closeMasterStudio() {
  isMasterModalOpen = false;
  if (masterStudioModalEl) {
    masterStudioModalEl.classList.remove('show');
  }
}

if (openMasterStudioBtn) {
  openMasterStudioBtn.addEventListener('click', openMasterStudio);
}
if (closeMasterStudioBtn) {
  closeMasterStudioBtn.addEventListener('click', closeMasterStudio);
}

// Click mirroring on Big Master Studio screen
if (masterStudioViewportEl) {
  masterStudioViewportEl.addEventListener('click', (e) => {
    if (!masterSessionId) return;

    const img = masterStudioScreenEl;
    const rect = img && img.style.display !== 'none'
      ? img.getBoundingClientRect()
      : masterStudioViewportEl.getBoundingClientRect();

    const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top)  / rect.height) * 100));

    socket.emit('puppet_click', { masterId: masterSessionId, xPct, yPct });
    logFeed(`🎯 Master Studio Click (${Math.round(xPct)}%, ${Math.round(yPct)}%) -> Replicating to all background instances`);
  });

  // Scroll mirroring on Master Studio
  masterStudioViewportEl.addEventListener('wheel', (e) => {
    if (!masterSessionId) return;
    e.preventDefault();
    const rect = masterStudioViewportEl.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
    socket.emit('puppet_scroll', { masterId: masterSessionId, xPct, yPct, deltaY: e.deltaY });
  }, { passive: false });

  // Mouse move in Master Studio with 60fps scheduling
  masterStudioViewportEl.addEventListener('mousemove', (e) => {
    if (!masterSessionId || !isFollowMouseEnabled) return;
    const rect = masterStudioViewportEl.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
    scheduleCursorUpdate(xPct, yPct);
  });

  masterStudioViewportEl.addEventListener('mouseleave', () => {
    document.querySelectorAll('.ghost-cursor').forEach(c => c.classList.remove('visible'));
  });
}

// Global Keypress Mirroring (Types into Master & mirrors to all slaves)
window.addEventListener('keydown', (e) => {
  if (!masterSessionId) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Escape') {
    if (isMasterModalOpen) closeMasterStudio();
    return;
  }

  if (e.key.length === 1) {
    socket.emit('puppet_type', { masterId: masterSessionId, text: e.key });
  } else if (['Enter', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
    socket.emit('puppet_key', { masterId: masterSessionId, key: e.key });
  }
});

// ── 9. Header Buttons (Single Add, Batch 5, Clean All) ──────────────────────
if (addSingleUnitBtn) {
  addSingleUnitBtn.addEventListener('click', () => {
    const num = puppetSessions.size + 1;
    const id = `puppet_${String(num).padStart(2, '0')}`;
    socket.emit('puppet_create', { id, label: `WhatsApp ${num}` });
    logFeed(`🚀 Launching real WhatsApp instance [${id}]...`);
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

// Broadcast dispatch to all real WhatsApp Web sessions
if (fireBroadcastBtn) {
  fireBroadcastBtn.addEventListener('click', () => {
    const message = broadcastMessageInput ? broadcastMessageInput.value.trim() : '';
    if (!message) {
      alert('Please enter a message to broadcast');
      return;
    }
    if (puppetSessions.size === 0) {
      alert('No WhatsApp instances active');
      return;
    }

    fireBroadcastBtn.disabled = true;
    logFeed(`Dispatching broadcast message to all ${puppetSessions.size} WhatsApp instances...`);

    socket.emit('puppet_type', { masterId: masterSessionId, text: message });
    setTimeout(() => {
      socket.emit('puppet_key', { masterId: masterSessionId, key: 'Enter' });
      fireBroadcastBtn.disabled = false;
      logFeed('Broadcast message entered & sent across all instances.');
    }, 500);
  });
}

// ── 10. Socket.io Event Listeners ───────────────────────────────────────────
socket.on('initial_state', ({ puppetSessions: initialPuppet }) => {
  puppetSessions.clear();
  if (initialPuppet) {
    initialPuppet.forEach(p => puppetSessions.set(p.id, p));
  }
  renderDeviceGrid();
  logFeed(`Loaded ${puppetSessions.size} Real WhatsApp instances.`);
});

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

// Stream real-time screenshots to card viewport & big master studio
socket.on('puppet_screenshot', ({ id, screenshot }) => {
  const cardImg = document.getElementById(`puppet-screen-${id}`);
  const placeholder = document.getElementById(`puppet-placeholder-${id}`);
  const unit = puppetSessions.get(id);

  if (cardImg) {
    cardImg.src = screenshot;
    cardImg.style.display = 'block';

    // Apply or remove smart QR zoom
    if (unit && unit.status === 'qr_ready') {
      cardImg.classList.add('qr-zoom');
    } else {
      cardImg.classList.remove('qr-zoom');
    }

    if (placeholder) placeholder.style.display = 'none';
  }

  // If this session is Master, also update the big Master Studio screen
  if (id === masterSessionId) {
    if (masterStudioScreenEl) {
      masterStudioScreenEl.src = screenshot;
      masterStudioScreenEl.style.display = 'block';
    }
    if (masterStudioPlaceholderEl) {
      masterStudioPlaceholderEl.style.display = 'none';
    }
  }
});

socket.on('operation_error', (data) => {
  logFeed(`[Error] ${data.message}`);
  alert(data.message);
  if (fireBroadcastBtn) fireBroadcastBtn.disabled = false;
});
