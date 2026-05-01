// websh.js — frontend logic for websh terminal

// ── Storage isolation ──────────────────────────────────────────────
// When isolate_storage is enabled, saved connections are scoped to the URL path
// so multiple websh instances on the same origin don't share connections.
let storagePrefix = '';
function storageKey(name) { return storagePrefix + name; }

// ── Helpers ─────────────────────────────────────────────────────────
function $(id){ return document.getElementById(id) }
function esc(s){ let d=document.createElement('div'); d.textContent=s; return d.innerHTML }

const API = location.pathname.replace(/\/[^/]*$/, '') + '/api.php';
function api(action, opts) {
  opts = opts || {};
  let url = `${API}?action=${action}${opts.query || ''}`;
  let init = {};
  if (opts.body) { init.method='POST'; init.body=JSON.stringify(opts.body); init.headers={'Content-Type':'application/json'} }
  return fetch(url, init).then(r => { return r.json() });
}

// ── Pane management ─────────────────────────────────────────────────
const panes = {};
let activeId = null;
let paneCounter = 0;
let connectingFor = null; // pane ID the overlay is connecting for
// overlayMode tracks why the login form is open:
//   'initial' — no panes yet (fresh app, last pane closed). Modal.
//   'split'   — user clicked split. Dismissable; dismiss is a no-op
//               before materialize, undoes the split after.
//   null      — form not driving a new-pane flow (e.g. not shown).
// A pane is only added to the DOM on successful connect (materialize step),
// so dismissing before connect cleanly leaves the layout untouched.
let overlayMode = null;
let pendingSplit = null; // {fromId, dir} while overlayMode==='split' pre-materialize
let serverConfig = null;
// ── Terminal display settings (size / line-height / weight / font) ─
const SETTINGS_KEY = 'websh_settings';
const DEFAULT_SETTINGS = {
  fontSize: 14, lineHeight: 1.0, fontWeight: 400, font: 'jetbrains-mono',
  // tmux options sent on /api/connect when persistent. Defaults give a
  // sensible "wheel scrolls" UX out of the box; users on hosts with their
  // own .tmux.conf can uncheck them to fall back to that file.
  tmuxMouse: true, tmuxClipboard: true, tmuxHistory: 100000
};
// id → [label, webfont-name-or-null, fallback-stack]
// webfont-name is the family loaded via Google Fonts; null = system only.
const FONTS = {
  'jetbrains-mono': ['JetBrains Mono', 'JetBrains Mono', "'Menlo','Monaco','Consolas',monospace"],
  'fira-code':      ['Fira Code',      'Fira Code',      "'Menlo','Monaco','Consolas',monospace"],
  'ibm-plex-mono':  ['IBM Plex Mono',  'IBM Plex Mono',  "'Menlo','Monaco','Consolas',monospace"],
  'roboto-mono':    ['Roboto Mono',    'Roboto Mono',    "'Menlo','Monaco','Consolas',monospace"],
  'source-code-pro':['Source Code Pro','Source Code Pro',"'Menlo','Monaco','Consolas',monospace"],
  'inconsolata':    ['Inconsolata',    'Inconsolata',    "'Menlo','Monaco','Consolas',monospace"],
  'system':         ['System default', null,             "ui-monospace,'Menlo','Monaco','SF Mono','Cascadia Code','Consolas',monospace"]
};
function fontStack(id) {
  let f = FONTS[id] || FONTS[DEFAULT_SETTINGS.font];
  return (f[1] ? `'${f[1]}',` : '') + f[2];
}
let settings = loadSettings();
// Legacy alias: the rest of the code reads `fontSize` directly.
let fontSize = settings.fontSize;
function loadSettings() {
  try {
    let s = JSON.parse(localStorage.getItem(storageKey(SETTINGS_KEY)) || '{}');
    return { ...DEFAULT_SETTINGS, ...s };
  } catch(e) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { localStorage.setItem(storageKey(SETTINGS_KEY), JSON.stringify(settings)); } catch(e) {}
}
const MAX_POLL_RETRIES = 5;
// Hard cap on a single download (bytes). Server enforces this too via
// MAX_DOWNLOAD_SIZE, but the client also bails early so a misconfigured
// or trusted-but-misbehaving server can't OOM the tab. 2 GB matches the
// upload limit and modern browsers' Blob ceilings.
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
let authMode = 'pw';

const darkTheme = {
  background:'#0d1117',foreground:'#e6edf3',cursor:'#58a6ff',cursorAccent:'#0d1117',
  selectionBackground:'rgba(88,166,255,0.3)',
  black:'#484f58',red:'#ff7b72',green:'#3fb950',yellow:'#d29922',
  blue:'#58a6ff',magenta:'#bc8cff',cyan:'#39d353',white:'#b1bac4',
  brightBlack:'#6e7681',brightRed:'#ffa198',brightGreen:'#56d364',
  brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',
  brightCyan:'#56d364',brightWhite:'#f0f6fc'
};
const lightTheme = {
  background:'#ffffff',foreground:'#1f2328',cursor:'#0969da',cursorAccent:'#ffffff',
  selectionBackground:'rgba(9,105,218,0.2)',
  black:'#24292f',red:'#cf222e',green:'#1a7f37',yellow:'#9a6700',
  blue:'#0969da',magenta:'#8250df',cyan:'#1b7c83',white:'#6e7781',
  brightBlack:'#57606a',brightRed:'#a40e26',brightGreen:'#2da44e',
  brightYellow:'#bf8700',brightBlue:'#218bff',brightMagenta:'#a475f9',
  brightCyan:'#3192aa',brightWhite:'#8c959f'
};
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? lightTheme : darkTheme;
}

function createPane(container) {
  let id = 'p' + (++paneCounter);
  let el = document.createElement('div');
  el.className = 'pane';
  el.setAttribute('data-pane', id);
  el.innerHTML =
    `<div class="pane-bar">` +
      `<span class="pane-badge s-off" data-pane-badge="${id}"></span>` +
      `<span class="pane-label" data-pane-label="${id}"></span>` +
      `<div class="upload-progress h" data-upload-progress="${id}">` +
        `<div class="upload-progress-track"><div class="upload-progress-bar"></div>` +
        `<div class="upload-progress-text"></div></div>` +
        `<button class="upload-progress-cancel" onclick="cancelTransfer('${id}')" title="Cancel" aria-label="Cancel transfer">&#x2715;</button>` +
      `</div>` +
      `<button class="pane-btn" onclick="triggerUpload('${id}')" title="Upload file" aria-label="Upload file" data-upload-btn="${id}" disabled>&#x2B06;</button>` +
      `<input type="file" class="h" data-upload-input="${id}" multiple onchange="handleUpload('${id}',this)">` +
      `<button class="pane-btn" onclick="triggerDownload('${id}')" title="Download file" aria-label="Download file" data-download-btn="${id}" disabled>&#x2B07;</button>` +
      `<button class="pane-btn" onclick="splitPane('${id}','h')" title="Split horizontal" aria-label="Split horizontal">&#x2194;</button>` +
      `<button class="pane-btn" onclick="splitPane('${id}','v')" title="Split vertical" aria-label="Split vertical">&#x2195;</button>` +
      `<button class="pane-btn close" onclick="closePane('${id}')" title="Close pane" aria-label="Close pane">&#x2715;</button>` +
    `</div>` +
    `<div class="reconnect-bar h" data-reconnect="${id}">` +
      `<span style="font-size:12px;color:var(--dim)">Disconnected</span>` +
      `<button class="btn btn-p" onclick="reconnectPane('${id}')">Reconnect</button>` +
    `</div>` +
    `<div class="pane-term"></div>` +
    `<div class="search-bar h" data-search="${id}">` +
      `<input type="text" placeholder="Search...">` +
      `<button onclick="searchPrev()">&#x25B2;</button>` +
      `<button onclick="searchNext()">&#x25BC;</button>` +
      `<button onclick="closeSearch()">&#x2715;</button>` +
    `</div>`;
  container.appendChild(el);

  let termEl = el.querySelector('.pane-term');
  let fit = new FitAddon.FitAddon();
  let search = new SearchAddon.SearchAddon();
  let term = new Terminal({
    cursorBlink:true, cursorStyle:'bar',
    fontSize: settings.fontSize,
    fontFamily: fontStack(settings.font),
    fontWeight: settings.fontWeight,
    fontWeightBold: Math.min(900, settings.fontWeight + 300),
    lineHeight: settings.lineHeight,
    theme: currentTheme(),
    allowProposedApi:true, scrollback:50000
  });
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  let u = new Unicode11Addon.Unicode11Addon(); term.loadAddon(u);
  term.unicode.activeVersion = '11';
  term.loadAddon(search);
  term.open(termEl);
  waitForFontThenRefresh(term, fit);

  let p = {
    id:id, el:el, term:term, fitAddon:fit, searchAddon:search,
    sid:null, connecting:false, polling:false, pollRetries:0,
    inputQueue:[], flushTimer:null, keepaliveTimer:null,
    label:'', resizeTimer:null, upload:null, download:null,
    // Connection identity — set once per connect, used for save/restore/reconnect.
    host:'', port:22, user:'', connection:null,
    auth:'pw', password:'', key:'', keyPass:'',
    persistent:false, slotId:null, tmuxCmd:'tmux',
    connectedAt:0 // ms timestamp of last successful /api/connect resolve
  };
  panes[id] = p;

  // Focus tracking
  el.addEventListener('mousedown', () => { activatePane(id) });

  // Terminal events
  term.onData(d => { if(p.sid) queueInput(p,d) });
  term.onBinary(d => { if(p.sid) queueInput(p,d) });
  term.onResize(size => {
    if(!p.sid) return;
    if(p.resizeTimer) clearTimeout(p.resizeTimer);
    p.resizeTimer = setTimeout(() => {
      p.resizeTimer=null;
      if(p.sid) api('resize',{body:{session_id:p.sid,cols:size.cols,rows:size.rows}}).catch(() => {});
    }, 150);
  });
  term.onSelectionChange(() => {
    let sel=term.getSelection();
    if(sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {});
  });
  term.onBell(() => {
    el.classList.remove('bell'); void el.offsetWidth; el.classList.add('bell');
  });

  // Right-click paste
  termEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    if(navigator.clipboard && navigator.clipboard.readText){
      navigator.clipboard.readText().then(t => { if(t && p.sid) queueInput(p,t) }).catch(() => {});
    }
  });

  // Resize observer
  new ResizeObserver(() => { fit.fit() }).observe(termEl);
  setTimeout(() => { fit.fit() }, 50);

  return p;
}

function activatePane(id) {
  if (activeId === id) return;
  let prev = activeId ? panes[activeId] : null;
  if (prev) prev.el.classList.remove('active');
  activeId = id;
  let p = panes[id];
  if (!p) return;
  p.el.classList.add('active');
  updatePaneBadge(p);
  p.term.focus();
}

function updatePaneBadge(p) {
  let badge = p.el.querySelector('[data-pane-badge]');
  if (!badge) return;
  let s = p.sid ? 'connected' : (p.connecting ? 'connecting' : 'disconnected');
  badge.className = 'pane-badge ' + (s==='connected'?'s-on':s==='connecting'?'s-wait':'s-off');
  badge.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  if (activeId === p.id) setTitle(p.label || '');
  let busy = !!p.upload || !!p.download;
  let ub = p.el.querySelector('[data-upload-btn]');
  if (ub) ub.disabled = !p.sid || busy;
  let db = p.el.querySelector('[data-download-btn]');
  if (db) db.disabled = !p.sid || busy;
  updatePaneTag(p);
}

// ── Split / Close ───────────────────────────────────────────────────
// Split does NOT mutate the DOM. It records the intent and opens the
// login form. The new pane is materialized only on successful connect
// (materializeTarget). Refreshing before connecting leaves layout intact.
function splitPane(id, dir) {
  if (!panes[id]) return;
  pendingSplit = {fromId: id, dir: dir};
  overlayMode = 'split';
  connectingFor = null;

  // Auto-connect shortcut for a single ready host — materialize happens
  // inside connectByName via materializeTarget.
  if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1
      && serverConfig.connections[0].kind !== 'prompt') {
    connectByName(serverConfig.connections[0].name);
    return;
  }

  if (selectedPrompt) clearPromptSelection();
  showOverlay();
  if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1
      && serverConfig.connections[0].kind === 'prompt'
      && loadSaved().length === 0) {
    selectPromptConnection(serverConfig.connections[0].name);
  }
  renderSaved();
}

// Materialize a new pane for the pending 'initial' or 'split' overlay
// mode. Creates the DOM + term, places it in the layout, returns it.
// For 'reauth'/null mode, returns the existing target pane.
function materializeTarget() {
  if (overlayMode === 'initial') {
    let root = $('panes');
    let np = createPane(root);
    activatePane(np.id);
    connectingFor = np.id;
    return np;
  }
  if (overlayMode === 'split' && pendingSplit) {
    let from = panes[pendingSplit.fromId];
    if (!from) { pendingSplit = null; return targetPane(); }
    let dir = pendingSplit.dir;
    let parent = from.el.parentNode;
    let wrap = document.createElement('div');
    wrap.className = 'split-' + dir;
    let handle = document.createElement('div');
    handle.className = 'split-handle';
    parent.replaceChild(wrap, from.el);
    wrap.appendChild(from.el);
    wrap.appendChild(handle);
    let np = createPane(wrap);
    activatePane(np.id);
    connectingFor = np.id;
    pendingSplit = null;
    return np;
  }
  return targetPane();
}

function cancelConnect() {
  if (!overlayDismissable()) return;
  // Abort any in-flight runConnect and dismiss the status popup so
  // closing the form takes the ongoing attempt with it.
  if (currentConnectRun) {
    currentConnectRun.cancelled = true;
    cleanupRun(currentConnectRun);
    currentConnectRun = null;
  }
  $('tmuxOv').classList.add('h');
  let np = connectingFor ? panes[connectingFor] : null;
  // If we got as far as materializing a pane for this overlay session
  // (user clicked Connect, auth failed, form stayed open, user now
  // dismisses), remove it. For pure intent (no materialize yet) there's
  // nothing to clean up.
  if (np && !np.sid && (overlayMode === 'initial' || overlayMode === 'split')) {
    let wrap = np.el.parentNode;
    if (wrap && wrap.id === 'panes') {
      // Initial case: pane sits directly in #panes root.
      np.term.dispose();
      delete panes[np.id];
      np.el.remove();
    } else if (wrap) {
      // Split case: unwrap and restore the sibling.
      let parent = wrap.parentNode;
      let sibling = null;
      for (let i=0; i<wrap.children.length; i++) {
        let ch = wrap.children[i];
        if (ch !== np.el && ch.classList.contains('pane')) { sibling = ch; break; }
        if (ch !== np.el && (ch.classList.contains('split-h') || ch.classList.contains('split-v'))) { sibling = ch; break; }
      }
      np.term.dispose();
      delete panes[np.id];
      if (sibling && parent) {
        sibling.style.flex = '';
        parent.replaceChild(sibling, wrap);
      }
    }
    saveSessions();
  }
  pendingSplit = null;
  overlayMode = null;
  connectingFor = null;
  hideOverlay();
  let ids = Object.keys(panes);
  if (ids.length && !panes[activeId]) activatePane(ids[ids.length - 1]);
}

// User-facing close. Persistent panes with a live tmux session need a
// confirmation step (and a kill-on-server) so we don't quietly leak a
// remote tmux that the UI can no longer reach.
const TERMINATE_NO_ASK_KEY = 'websh_terminate_no_ask';

function closePane(id) {
  let p = panes[id];
  if (!p) return;
  let liveTmux = !!(p.persistent && p.sid && p.slotId);
  if (!liveTmux) { _destroyPane(id, false); return; }
  if (localStorage.getItem(TERMINATE_NO_ASK_KEY)) {
    _destroyPane(id, true);
    return;
  }
  showTerminateModal(p, neverAgain => {
    if (neverAgain) localStorage.setItem(TERMINATE_NO_ASK_KEY, '1');
    _destroyPane(id, true);
  });
}

function _destroyPane(id, terminate) {
  let p = panes[id];
  if (!p) return;
  // Cancel active transfers
  if (p.upload) { p.upload.cancelled = true; closeUploadSession(p.upload); }
  if (p.download) { p.download.cancelled = true; if (p.download.abort) p.download.abort(); }
  // Disconnect main session
  if (p.sid) {
    p.polling = false;
    stopKeepalive(p);
    let body = {session_id: p.sid};
    if (terminate) body.terminate = true;
    api('disconnect', {body: body}).catch(() => {});
  }
  p.term.dispose();

  let wrap = p.el.parentNode;
  delete panes[id];

  // No panes left → back to the initial-login flow. No pane is
  // materialized yet; the form drives creation on submit.
  if (!Object.keys(panes).length) {
    $('panes').innerHTML = '';
    overlayMode = 'initial';
    pendingSplit = null;
    connectingFor = null;
    showOverlay();
    renderSaved();
    saveSessions();
    return;
  }

  // Unwrap: replace split container with the remaining child
  let sibling = null;
  for (let i=0; i<wrap.children.length; i++) {
    let ch = wrap.children[i];
    if (ch !== p.el && !ch.classList.contains('split-handle')) { sibling = ch; break; }
  }
  if (sibling && wrap.parentNode) {
    sibling.style.flex = '';
    wrap.parentNode.replaceChild(sibling, wrap);
  } else {
    p.el.remove();
  }

  // Activate another pane
  if (activeId === id) {
    let ids = Object.keys(panes);
    if (ids.length) activatePane(ids[0]);
  }

  // Refit all terminals after layout change
  Object.keys(panes).forEach(k => { panes[k].fitAddon.fit() });
  saveSessions();
}

// ── Per-pane session helpers ────────────────────────────────────────
function startKeepalive(p) {
  stopKeepalive(p);
  // Empty input bumps the server's last_activity, so sessions stay alive
  // as long as any tab is open. When the tab closes the interval stops
  // and the server's idle timeout reaps the PTY normally.
  p.keepaliveTimer = setInterval(() => {
    if (p.sid) api('input', {body: {session_id: p.sid, data: ''}}).catch(() => {});
  }, 30000);
}
function stopKeepalive(p) {
  if(p.keepaliveTimer){ clearInterval(p.keepaliveTimer); p.keepaliveTimer=null }
}

// ── Reconnect ────────────────────────────────────────────────────────
function showReconnectBar(p, reason) {
  let bar = p.el.querySelector('[data-reconnect]');
  if (!bar) return;
  let msg = bar.querySelector('span');
  if (msg) {
    if (reason === 'auth_failed') {
      msg.textContent = 'Authentication failed';
      msg.style.color = 'var(--dg)';
    } else {
      msg.textContent = 'Disconnected';
      msg.style.color = 'var(--dim)';
    }
  }
  bar.classList.remove('h');
}
function hideReconnectBar(p) {
  let bar = p.el.querySelector('[data-reconnect]');
  if (bar) bar.classList.add('h');
}
function reconnectPane(id) {
  let p = panes[id]; if (!p || (!p.host && !p.connection)) return;
  hideReconnectBar(p);
  connectPane(p, {label: p.label, resume: p.persistent});
}
// ── Session persistence (localStorage) ──────────────────────────────
// Persistent panes wrap their remote shell in tmux; on refresh we resume
// by slot_id so the layout + running processes come back intact. Layout
// tree is serialized from the DOM so we can rebuild splits verbatim.
const PANES_KEY = 'websh_panes';
const PANES_VERSION = 2;

function slotIdFor(user, host, port) {
  // Human-readable + unique. Sanitize to backend's [A-Za-z0-9_-]{1,64}.
  let base = (user || 'u') + '_' + (host || 'h') + '_' + (port || 22);
  let rand = Math.random().toString(36).slice(2, 8);
  let raw = base + '_' + rand;
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function paneRecord(p) {
  // Flat, self-contained record persisted per open pane. Has everything
  // needed to rebuild the wire request — no lookups at restore time.
  if (!p.host && !p.connection) return null;
  return {
    label:      p.label || '',
    host:       p.host || '',
    port:       p.port || 22,
    user:       p.user || '',
    connection: p.connection || null,
    auth:       p.auth || (p.key ? 'key' : 'pw'),
    password:   p.password || '',
    key:        p.key || '',
    key_pass:   p.keyPass || '',
    persistent: !!p.persistent,
    slot_id:    p.slotId || null,
    tmux_cmd:   p.tmuxCmd || 'tmux',
    cols:       p.term.cols,
    rows:       p.term.rows
  };
}

function buildConnectBody(rec, termCols, termRows) {
  // Translate a pane record into the shape server.py /api/connect wants.
  let b = {
    username: rec.user,
    cols: termCols || rec.cols || 80,
    rows: termRows || rec.rows || 24
  };
  if (rec.connection) b.connection = rec.connection;
  else { b.host = rec.host; b.port = rec.port || 22; }
  if (rec.auth === 'key') {
    if (rec.key) b.key = rec.key;
    if (rec.key_pass) b.password = rec.key_pass;
  } else if (rec.password) {
    b.password = rec.password;
  }
  if (rec.persistent) {
    b.persistent = true;
    b.slot_id = rec.slot_id || slotIdFor(rec.user, rec.host, rec.port);
    // tmux options from local settings, applied on every connect/resume.
    // Server validates against an allow-list, so unexpected values are
    // dropped silently rather than fail the connect.
    b.tmux_mouse = !!settings.tmuxMouse;
    b.tmux_set_clipboard = !!settings.tmuxClipboard;
    let hl = parseInt(settings.tmuxHistory, 10);
    if (Number.isFinite(hl) && hl >= 100) b.tmux_history_limit = hl;
  }
  if (rec.tmux_cmd && rec.tmux_cmd !== 'tmux') b.tmux_cmd = rec.tmux_cmd;
  return b;
}

function serializeLayout(rootEl) {
  // rootEl is #panes; walk its single child (pane or split wrapper).
  let first = null;
  for (let i = 0; i < rootEl.children.length; i++) {
    let ch = rootEl.children[i];
    if (ch.classList.contains('pane') || ch.classList.contains('split-h') || ch.classList.contains('split-v')) {
      first = ch; break;
    }
  }
  return first ? serializeNode(first) : null;
}
function serializeNode(el) {
  let flex = el.style.flex || '';
  if (el.classList.contains('pane')) {
    return {type: 'leaf', pane: el.getAttribute('data-pane'), flex: flex};
  }
  let dir = el.classList.contains('split-h') ? 'h' : 'v';
  let kids = [];
  for (let i = 0; i < el.children.length; i++) {
    let c = el.children[i];
    if (c.classList.contains('split-handle')) continue;
    kids.push(serializeNode(c));
  }
  return {type: 'split', dir: dir, flex: flex, a: kids[0], b: kids[1]};
}

function saveSessions() {
  let out = {};
  Object.keys(panes).forEach(k => {
    let rec = paneRecord(panes[k]);
    if (rec) out[k] = rec;
  });
  let manifest = {
    version: PANES_VERSION,
    layout: serializeLayout($('panes')),
    panes: out
  };
  try { localStorage.setItem(storageKey(PANES_KEY), JSON.stringify(manifest)); } catch(e) {}
}
function loadManifest() {
  // Load v2 directly, or migrate from the legacy v1 "websh_manifest" key.
  try {
    let raw = localStorage.getItem(storageKey(PANES_KEY));
    if (raw) {
      let m = JSON.parse(raw);
      if (m && m.version === PANES_VERSION) return m;
    }
  } catch(e) {}
  // Migrate v1 → v2, then drop the old key.
  try {
    let raw = localStorage.getItem(storageKey('websh_manifest'));
    if (!raw) return null;
    let old = JSON.parse(raw);
    if (!old || old.version !== 1 || !old.slots) return null;
    let panes = {};
    Object.keys(old.slots).forEach(k => {
      let s = old.slots[k];
      let b = s.connect_body || {};
      panes[k] = {
        label: s.label || '',
        host: b.host || '',
        port: b.port || 22,
        user: b.username || '',
        connection: b.connection || null,
        auth: b.key ? 'key' : 'pw',
        password: b.password || '',
        key: b.key || '',
        key_pass: '',
        persistent: !!s.persistent_requested,
        slot_id: s.slot_id || null,
        tmux_cmd: 'tmux',
        cols: b.cols || 80,
        rows: b.rows || 24
      };
    });
    let migrated = { version: PANES_VERSION, layout: old.layout, panes };
    localStorage.setItem(storageKey(PANES_KEY), JSON.stringify(migrated));
    localStorage.removeItem(storageKey('websh_manifest'));
    return migrated;
  } catch(e) { return null; }
}
function clearSavedSessions() {
  try { localStorage.removeItem(storageKey(PANES_KEY)); } catch(e) {}
  try { localStorage.removeItem(storageKey('websh_manifest')); } catch(e) {}
  try { sessionStorage.removeItem('websh_sessions'); } catch(e) {}
}

// ── Export terminal ─────────────────────────────────────────────────
function exportTerminal() {
  let p = panes[activeId]; if (!p) return;
  let filename = (p.label || 'terminal') + '.txt';
  // Persistent panes run inside tmux, which keeps its own scrollback —
  // xterm.js only sees the alt-screen, so its buffers are useless for
  // export. Pull the real buffer over the ControlMaster side-channel.
  if (p.persistent && p.sid) {
    let url = `${API}?action=tmux_capture&session_id=${encodeURIComponent(p.sid)}`;
    fetch(url).then(r => {
      if (!r.ok) {
        return r.json().catch(() => ({error: 'capture failed'}))
          .then(j => Promise.reject(j.error || 'capture failed'));
      }
      return r.text();
    }).then(text => {
      // tmux capture-pane keeps trailing blank lines; trim them off so
      // the file ends at the last real output.
      text = text.replace(/\n+$/, '') + '\n';
      saveTextAs(filename, text);
    }).catch(err => {
      console.warn('tmux capture failed, falling back to xterm buffer:', err);
      saveTextAs(filename, dumpXtermBuffers(p));
    });
    return;
  }
  saveTextAs(filename, dumpXtermBuffers(p));
}

function dumpXtermBuffers(p) {
  let lines = [];
  let dump = (buf) => {
    if (!buf) return;
    for (let i = 0; i < buf.length; i++) {
      let line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
  };
  dump(p.term.buffer.normal);
  if (p.term.buffer.active.type === 'alternate') {
    lines.push('');
    lines.push('─── alternate screen ───');
    dump(p.term.buffer.alternate);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n') + '\n';
}

function saveTextAs(filename, text) {
  let blob = new Blob([text], {type: 'text/plain'});
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function commitPendingSave(p) {
  if (!p.pendingSave) return;
  let entry = Object.assign({}, p.pendingSave);
  // Overwrite persistent with the actual live mode (handles tmux-skip
  // and any other downgrade paths). Also capture a discovered tmux_cmd.
  entry.persistent = !!p.persistent;
  if (p.tmuxCmd && p.tmuxCmd !== 'tmux') entry.tmux_cmd = p.tmuxCmd;
  let list = loadSaved();
  list = list.filter(c => c.name !== entry.name);
  list.unshift(entry);
  saveSaved(list);
  p.pendingSave = null;
  if ($('iSave').checked) { $('iSave').checked = false; toggleSaveName(); }
  renderSaved();
}

function pollOutput(p) {
  if(!p.sid || !p.polling) return;
  api('output',{query:'&session_id='+p.sid}).then(r => {
    p.pollRetries=0;
    if(r.error){
      // Session not found — stale restore or server restarted. Persistent
      // panes try to re-attach via tmux; short-lived panes just reconnect.
      console.log('poll: session error:', r.error);
      stopKeepalive(p); p.polling=false; p.sid=null; p.connecting=false;
      updatePaneBadge(p);
      if(p.host || p.connection) {
        connectPane(p, {label:p.label, resume:p.persistent});
      } else { doAutoConnect(); }
      return;
    }
    p.connecting=false;
    if(r.data){
      updatePaneBadge(p);
      let chunk = atob(r.data);
      p.term.write(Uint8Array.from(chunk, c => c.charCodeAt(0)));
      // Keep a short tail of decoded output only while we're still
      // within the tmux-death detection window on a persistent pane.
      if (p.persistent && p.connectedAt && (Date.now() - p.connectedAt) < 8000) {
        p.recentOutput = ((p.recentOutput || '') + chunk).slice(-4096);
      }
    }
    // SSH auth rejected our password/key: stop the loop cleanly and
    // do NOT save the entry. Surface the failure on the pane itself
    // (reconnect placeholder). The login form never reopens on its own.
    if (r.auth_failed) {
      p.pendingSave = null;
      p.term.write('\r\n\x1b[91m--- authentication failed ---\x1b[0m\r\n');
      stopKeepalive(p); p.polling = false;
      if (p.sid) {
        api('disconnect', {body: {session_id: p.sid}}).catch(() => {});
        p.sid = null;
      }
      p.recentOutput = '';
      updatePaneBadge(p);
      if (p.host || p.connection) showReconnectBar(p, 'auth_failed');
      saveSessions();
      return;
    }
    // Commit the deferred save once the session has proven healthy
    // (alive and no auth failure for ≥2.5 s).
    if (p.pendingSave && r.alive !== false &&
        p.connectedAt && (Date.now() - p.connectedAt) >= 2500) {
      commitPendingSave(p);
    }
    if(r.alive===false){
      p.term.write('\r\n\x1b[90m--- connection closed ---\x1b[0m\r\n');
      stopKeepalive(p); p.polling=false; p.sid=null;
      saveSessions();
      // Smart tmux fallback: a persistent pane whose session dies quickly
      // with a "not found" shape in the output is almost certainly a
      // missing tmux binary on the target. Offer re-probe / short-lived.
      let quick = p.connectedAt && (Date.now() - p.connectedAt) < 5000;
      let tail = p.recentOutput || '';
      let hit = /tmux: not found|tmux: command not found|No such file|command not found/i.test(tail);
      if (p.persistent && quick && hit) {
        showTmuxBar(p, 'tmux seems missing on ' + (p.host || 'target') + '.');
      } else if (p.host || p.connection) {
        showReconnectBar(p);
      }
      p.recentOutput = '';
      if(activeId===p.id) updatePaneBadge(p);
      return;
    }
    if(p.polling) pollOutput(p);
  }).catch(e => {
    console.error('poll error:', p.id, e);
    p.pollRetries++;
    if(p.pollRetries>=MAX_POLL_RETRIES){
      let msg = (e && e.message && e.message.indexOf('502') !== -1)
        ? '\r\n\x1b[91m--- backend restarted, session lost ---\x1b[0m\r\n'
        : '\r\n\x1b[91m--- connection lost ---\x1b[0m\r\n';
      p.term.write(msg);
      stopKeepalive(p); p.polling=false; p.sid=null;
      saveSessions();
      if(p.host || p.connection) showReconnectBar(p);
      if(activeId===p.id) updatePaneBadge(p);
      return;
    }
    let d=Math.min(1000*Math.pow(2,p.pollRetries-1),10000);
    setTimeout(() => { if(p.polling) pollOutput(p) },d);
  });
}

function queueInput(p, data) {
  p.inputQueue.push(data);
  if(!p.flushTimer) p.flushTimer = setTimeout(() => {
    p.flushTimer=null;
    if(!p.sid||!p.inputQueue.length) return;
    let d=p.inputQueue.join(''); p.inputQueue=[];
    api('input',{body:{session_id:p.sid,data:d}}).catch(() => {});
  }, 10);
}

// ── Unified connect ─────────────────────────────────────────────────
// opts = { label, host, port, user, connection, auth, password, key, keyPass,
//          persistent, slotId?, resume? }
// `resume` flag triggers attach-by-slot_id on the backend.
function connectPane(p, opts) {
  p.label = opts.label || '';
  if (opts.host !== undefined) p.host = opts.host || '';
  if (opts.port !== undefined) p.port = opts.port || 22;
  if (opts.user !== undefined) p.user = opts.user || '';
  if (opts.connection !== undefined) p.connection = opts.connection || null;
  if (opts.auth !== undefined) p.auth = opts.auth || 'pw';
  if (opts.password !== undefined) p.password = opts.password || '';
  if (opts.key !== undefined) p.key = opts.key || '';
  if (opts.keyPass !== undefined) p.keyPass = opts.keyPass || '';
  if (opts.persistent !== undefined) p.persistent = !!opts.persistent;
  if (opts.slotId) p.slotId = opts.slotId;
  else if (p.persistent && !p.slotId) p.slotId = slotIdFor(p.user, p.host, p.port);
  if (opts.tmuxCmd !== undefined) p.tmuxCmd = opts.tmuxCmd || 'tmux';
  if (opts.saveEntry !== undefined) p.pendingSave = opts.saveEntry;

  hideReconnectBar(p);
  p.connecting = true;
  let labelEl = p.el.querySelector('[data-pane-label]');
  if (labelEl) labelEl.textContent = p.label;
  p.term.reset();
  setTitle(p.label);
  updatePaneBadge(p);

  let body = buildConnectBody(paneRecord(p), p.term.cols, p.term.rows);
  if (opts.resume && p.slotId) body.resume_slot_id = p.slotId;

  console.log('connectPane: host=' + body.host + ' user=' + body.username +
              ' persistent=' + !!body.persistent +
              ' pw len=' + ((body.password || '').length) +
              ' key len=' + ((body.key || '').length));

  api('connect', {body: body})
    .then(r => {
      console.log('connect result:', r);
      p.connecting = false;
      if (r.error) { p.pendingSave = null; showErr(r.error); updatePaneBadge(p); return }
      if (r.auth_failed) {
        p.pendingSave = null;
        updatePaneBadge(p);
        // If the form is still open (user just clicked Connect), keep it
        // visible with an error so they can retry or dismiss. Otherwise
        // (refresh re-auth, reconnect retry) surface on the pane.
        let formOpen = !$('ov').classList.contains('h');
        if (formOpen) {
          showErr('Authentication failed — check password or key.');
        } else {
          p.term.write('\r\n\x1b[91m--- authentication failed ---\x1b[0m\r\n');
          if (p.host || p.connection) showReconnectBar(p, 'auth_failed');
          connectingFor = null;
          overlayMode = null;
          pendingSplit = null;
        }
        return;
      }
      if (r.alive === false) {
        p.pendingSave = null;
        showErr('SSH process exited immediately');
        updatePaneBadge(p);
        if (p.persistent) showTmuxBar(p, 'Connection died immediately — tmux may be missing on ' + (p.host || 'target') + '.');
        return;
      }
      p.sid = r.session_id;
      if (r.slot_id) p.slotId = r.slot_id;
      if (r.tmux_cmd) p.tmuxCmd = r.tmux_cmd;
      p.connectedAt = Date.now();
      p.recentOutput = '';
      // Persist a non-default tmux path on the matching saved entry so
      // future connects skip the probe and use the right binary path.
      if (p.persistent && p.tmuxCmd && p.tmuxCmd !== 'tmux') {
        let list = loadSaved();
        let dirty = false;
        for (let i = 0; i < list.length; i++) {
          let c = list[i];
          if (c.host === p.host && c.port === (p.port || 22) && c.user === p.user && c.tmux_cmd !== p.tmuxCmd) {
            c.tmux_cmd = p.tmuxCmd; dirty = true;
          }
        }
        if (dirty) saveSaved(list);
      }
      hideTmuxBar(p);
      hideOverlay();
      connectingFor = null;
      overlayMode = null;
      pendingSplit = null;
      p.term.focus();
      p.polling = true;
      p.pollRetries = 0;
      // Force a resize so resumed tmux sessions redraw at the real size.
      p.fitAddon.fit();
      let dims = p.fitAddon.proposeDimensions();
      let cols = (dims && dims.cols) || p.term.cols;
      let rows = (dims && dims.rows) || p.term.rows;
      api('resize', {body:{session_id:p.sid, cols:cols, rows:rows}}).catch(() => {});
      startKeepalive(p);
      saveSessions();
      pollOutput(p);
    })
    .catch(e => {
      p.connecting = false;
      showErr('Connection failed: ' + e.message);
      updatePaneBadge(p);
    });
}

function updatePaneTag(p) {
  let labelEl = p.el.querySelector('[data-pane-label]');
  if (!labelEl) return;
  let old = p.el.querySelector('.pane-tag'); if (old) old.remove();
  if (!p.host && !p.connection) return;
  let tag = document.createElement('span');
  tag.className = 'pane-tag ' + (p.persistent ? 'persistent' : 'ephemeral');
  tag.textContent = p.persistent ? 'persistent' : 'short-lived';
  tag.title = p.persistent
    ? 'This pane is wrapped in remote tmux and will survive browser refresh.'
    : 'This pane is NOT persistent — it will be lost on refresh.';
  labelEl.after(tag);
}

function targetPane() {
  // Which pane are we connecting for?
  if (connectingFor && panes[connectingFor]) return panes[connectingFor];
  if (activeId && panes[activeId]) return panes[activeId];
  return null;
}

// ── tmux fallback bar ──────────────────────────────────────────────
// Shown over a persistent pane whose connect died fast with a tmux-
// shaped error ("not found"). Prompts the user to retry or switch the
// pane to a plain (short-lived) session so they can install tmux.
function showTmuxBar(p, note) {
  hideReconnectBar(p);
  let bar = p.el.querySelector('[data-tmux-bar]');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'tmux-bar';
    bar.setAttribute('data-tmux-bar', p.id);
    let msg = document.createElement('span');
    msg.setAttribute('data-tmux-msg', '1');
    bar.appendChild(msg);
    let reBtn = document.createElement('button');
    reBtn.className = 'btn btn-p';
    reBtn.textContent = 'Retry';
    reBtn.onclick = () => { tmuxRetry(p.id); };
    bar.appendChild(reBtn);
    let shortBtn = document.createElement('button');
    shortBtn.className = 'btn';
    shortBtn.textContent = 'Connect short-lived';
    shortBtn.onclick = () => { tmuxSwitchToShortLived(p.id); };
    bar.appendChild(shortBtn);
    let panebar = p.el.querySelector('.pane-bar');
    panebar.after(bar);
  }
  bar.querySelector('[data-tmux-msg]').textContent = note || 'tmux failed on this target';
  bar.classList.remove('h');
}
function hideTmuxBar(p) {
  let bar = p.el.querySelector('[data-tmux-bar]');
  if (bar) bar.classList.add('h');
}
function tmuxRetry(id) {
  let p = panes[id]; if (!p) return;
  hideTmuxBar(p);
  connectPane(p, {label: p.label, persistent: true});
}
function tmuxSwitchToShortLived(id) {
  let p = panes[id]; if (!p) return;
  hideTmuxBar(p);
  p.persistent = false;
  p.slotId = null;
  connectPane(p, {label: p.label, persistent: false});
}

// ── tmux probe ─────────────────────────────────────────────────────
// On a manual connect with Persistent checked, we open a background
// SSH session (same mechanism as file upload/download), ask the remote
// shell whether tmux is installed, and report back its path. If the
// user has already said "connect short-lived" for this target, we
// skip the probe next time — they've opted out.

const TMUX_MARKER = '__WEBSH_TMUX__';

function probeScript() {
  // One-liner that prints a marker line our parser can find. Checks
  // both $PATH and ~/.local/bin — a common user-space install location.
  // The marker is assembled from two halves so the typed command itself
  // (which the remote shell echoes back to our buffer) does not contain
  // the full marker string — only the expanded output does.
  return (
    'PATH="$HOME/.local/bin:$PATH"; ' +
    'CMD=""; ' +
    'if command -v tmux >/dev/null 2>&1; then CMD="$(command -v tmux)"; ' +
    'elif [ -x "$HOME/.local/bin/tmux" ]; then CMD="$HOME/.local/bin/tmux"; fi; ' +
    'WTA=__WEBSH; WTB=_TMUX__; ' +
    'printf "%s%s:installed=%s:cmd=%s\\n" "$WTA" "$WTB" "${CMD:+yes}${CMD:-no}" "$CMD"'
  );
}

function parseProbeOutput(text) {
  let m = text.match(new RegExp(TMUX_MARKER + ':installed=(\\S+?):cmd=(\\S*)'));
  if (!m) return null;
  return {
    installed: m[1].indexOf('yes') === 0,
    tmux_cmd: m[2] || ''
  };
}

function openBgSession(rec) {
  // Spins up a non-persistent, background-tagged SSH session that
  // borrows the caller's creds. Used only for the probe.
  let body = buildConnectBody(rec, 80, 24);
  delete body.persistent; delete body.slot_id; delete body.tmux_cmd;
  body.background = true;
  return api('connect', {body: body}).then(r => {
    if (r.auth_failed) {
      let err = new Error('authentication failed');
      err.authFailed = true;
      throw err;
    }
    if (r.error || r.alive === false) throw new Error(r.error || 'bg connect failed');
    return r.session_id;
  });
}

function drainOutput(sid, shouldStop) {
  // Long-poll /api/output until shouldStop(buf) returns truthy or
  // the session dies. Returns the accumulated decoded output.
  let buf = '';
  function step() {
    return api('output', {query: '&session_id=' + sid}).then(r => {
      if (r.error) return {buf: buf, reason: 'error', error: r.error};
      if (r.data) buf += atob(r.data);
      if (r.auth_failed) return {buf: buf, reason: 'auth_failed'};
      let stop = shouldStop ? shouldStop(buf) : null;
      if (stop) return {buf: buf, reason: stop};
      if (r.alive === false) return {buf: buf, reason: 'closed'};
      return step();
    });
  }
  return step();
}

// Classify a chunk of PTY output as an auth failure. Mirrors the server's
// AUTH_FAIL_PATTERNS so we don't depend solely on session.auth_failed
// flag propagation (a poll can race ahead of the read loop's flag set).
function looksLikeAuthFail(text) {
  if (!text) return false;
  return /permission denied|authentication failed|access denied|too many authentication failures/i.test(text);
}

function probeTmux(rec) {
  // Returns a Promise<{installed, tmux_cmd} | null>. Opens a bg
  // session, runs the probe one-liner, reads until the marker,
  // disconnects. Caps at 20 s total.
  let bgSid = null;
  let timeoutId = null;
  let timed = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('probe timeout')), 20000);
  });
  let work = openBgSession(rec).then(sid => {
    bgSid = sid;
    return delay(2500); // let MOTD / login banner drain
  }).then(() => {
    return api('input', {body: {session_id: bgSid, data: probeScript() + '\n'}});
  }).then(() => {
    return drainOutput(bgSid, buf => buf.indexOf(TMUX_MARKER + ':') !== -1 ? 'marker' : null);
  }).then(res => {
    if (res.reason === 'auth_failed' || looksLikeAuthFail(res.buf)) {
      let err = new Error('authentication failed');
      err.authFailed = true;
      throw err;
    }
    return parseProbeOutput(res.buf);
  });
  return Promise.race([work, timed]).finally(() => {
    clearTimeout(timeoutId);
    if (bgSid) api('disconnect', {body: {session_id: bgSid}}).catch(() => {});
  });
}

// ── Terminate-session confirm modal ────────────────────────────────
// Shown only when [x] is clicked on a successful tmux-backed pane.
// Three outcomes: cancel, terminate once, terminate + suppress prompt
// for future closes (preference lives in localStorage).
let pendingTerminate = null;

function showTerminateModal(p, onConfirm) {
  pendingTerminate = onConfirm;
  // Prefer the human label (saved name or connection name) over the raw
  // host IP — matches what the user sees in the pane's title bar.
  let name = p.label || p.connection || p.host || 'server';
  $('cfTitle').textContent = 'Terminate session on ' + name + '?';
  $('confirmOv').classList.remove('h');
}
function confirmCancel() {
  $('confirmOv').classList.add('h');
  pendingTerminate = null;
}
function confirmTerminate(neverAgain) {
  $('confirmOv').classList.add('h');
  let cb = pendingTerminate;
  pendingTerminate = null;
  if (cb) cb(!!neverAgain);
}

// ── Unified connect flow ───────────────────────────────────────────
// Single entry point for every connect attempt (manual form, saved
// card, server-configured card). Rules:
//
//   1. No pane is created until the connection is confirmed. The login
//      form stays visible behind a status popup during the attempt —
//      on success we materialise the pane and close the form in one
//      step; on failure the popup shows the reason and the form is
//      still there, unchanged, for the user to retry.
//   2. All failure states (auth, no-tmux, policy-deny, host-down,
//      timeout, generic error) surface in the same popup with one
//      [OK] button that just dismisses the popup.
//   3. Saved cards run the same flow — clicking one does not bypass
//      the form; the form remains the single "close me" control.
//
// The popup's DOM is #tmuxOv (kept for backwards-compat; the visible
// title is "Connecting" by default). The probeTmux / openBgSession /
// drainOutput helpers below stay as building blocks.

// Synthesize a paneRecord-shaped object from opts so probeTmux can run
// before any pane exists. Probe is always non-persistent and uses a
// fixed 80x24 PTY, so cols/rows/persistent fields don't matter.
function recForProbe(opts) {
  return {
    label: opts.label || '',
    host: opts.host || '',
    port: opts.port || 22,
    user: opts.user || '',
    connection: opts.connection || null,
    auth: opts.auth || (opts.key ? 'key' : 'pw'),
    password: opts.password || '',
    key: opts.key || '',
    key_pass: opts.keyPass || '',
    persistent: false,
    slot_id: null,
    tmux_cmd: opts.tmuxCmd || 'tmux',
    cols: 80, rows: 24
  };
}

// Tracks the active attempt so the popup's Cancel / form's × can abort
// it and so we don't leak bg or half-connected sessions.
let currentConnectRun = null;

function runConnect(opts) {
  // A second runConnect supersedes the first.
  if (currentConnectRun) {
    currentConnectRun.cancelled = true;
    cleanupRun(currentConnectRun);
  }
  let run = { cancelled: false, connectSid: null, opts: opts };
  currentConnectRun = run;

  hideErr();
  showConnectStatus('connecting', {host: opts.host, persistent: !!opts.persistent});

  let step = opts.persistent
    ? probeTmux(recForProbe(opts)).then(res => {
        if (run.cancelled) return null;
        if (!res) throw { kind: 'probe_unparseable' };
        if (!res.installed) throw { kind: 'no_tmux' };
        opts.tmuxCmd = res.tmux_cmd || 'tmux';
        return true;
      })
    : Promise.resolve(true);

  step.then(ok => {
    if (run.cancelled || ok === null) return null;
    return realConnect(opts, run);
  }).then(result => {
    if (run.cancelled || !result) return;
    finalizeSuccess(opts, result, run);
  }).catch(err => {
    if (run.cancelled) return;
    cleanupRun(run);
    currentConnectRun = null;
    let ctx = mapConnectError(err, opts);
    showConnectStatus(ctx.kind, ctx);
  });
}

function realConnect(opts, run) {
  // Build connect body from opts (no pane yet, so cols/rows default to
  // 80x24 and we /api/resize once the pane is materialised).
  let rec = {
    label: opts.label || '',
    host: opts.host || '',
    port: opts.port || 22,
    user: opts.user || '',
    connection: opts.connection || null,
    auth: opts.auth || (opts.key ? 'key' : 'pw'),
    password: opts.password || '',
    key: opts.key || '',
    key_pass: opts.keyPass || '',
    persistent: !!opts.persistent,
    slot_id: opts.slotId || (opts.persistent
      ? slotIdFor(opts.user, opts.host, opts.port) : null),
    tmux_cmd: opts.tmuxCmd || 'tmux',
    cols: 80, rows: 24
  };
  opts.slotId = rec.slot_id;
  let body = buildConnectBody(rec, 80, 24);
  return api('connect', {body: body}).then(r => {
    if (run.cancelled) {
      if (r && r.session_id) api('disconnect', {body: {session_id: r.session_id}}).catch(() => {});
      return null;
    }
    if (r && r.session_id) run.connectSid = r.session_id;
    if (r.auth_failed) throw { kind: 'auth_failed' };
    if (r.error) {
      if (/not allowed|not in the allowed list/i.test(r.error)) {
        throw { kind: 'policy_deny', msg: r.error };
      }
      throw { kind: 'error', msg: r.error };
    }
    if (r.alive === false) throw { kind: 'host_down' };
    return r;
  });
}

function finalizeSuccess(opts, result, run) {
  // Connection confirmed — now it's safe to create the pane.
  let p = materializeTarget();
  if (!p) {
    // No materialize target (shouldn't happen under normal flow) —
    // tear down the stray session so it doesn't leak.
    if (result.session_id) api('disconnect', {body: {session_id: result.session_id}}).catch(() => {});
    currentConnectRun = null;
    return;
  }
  p.label = opts.label || '';
  p.host = opts.host || '';
  p.port = opts.port || 22;
  p.user = opts.user || '';
  p.connection = opts.connection || null;
  p.auth = opts.auth || (opts.key ? 'key' : 'pw');
  p.password = opts.password || '';
  p.key = opts.key || '';
  p.keyPass = opts.keyPass || '';
  p.persistent = !!opts.persistent;
  p.slotId = result.slot_id || opts.slotId || null;
  p.tmuxCmd = result.tmux_cmd || opts.tmuxCmd || 'tmux';
  p.sid = result.session_id;
  p.connectedAt = Date.now();
  p.recentOutput = '';
  p.connecting = false;
  // Deferred save: commitPendingSave writes it to localStorage once the
  // session has proven healthy for ≥2.5s with no auth failure.
  if (opts.saveEntry) {
    let entry = Object.assign({}, opts.saveEntry);
    entry.persistent = !!p.persistent;
    if (p.tmuxCmd && p.tmuxCmd !== 'tmux') entry.tmux_cmd = p.tmuxCmd;
    p.pendingSave = entry;
  }

  hideReconnectBar(p);
  hideTmuxBar(p);
  let labelEl = p.el.querySelector('[data-pane-label]');
  if (labelEl) labelEl.textContent = p.label;
  p.term.reset();
  setTitle(p.label);
  updatePaneBadge(p);

  // Close the status popup and login form as a single success step.
  $('tmuxOv').classList.add('h');
  hideOverlay();
  connectingFor = null;
  overlayMode = null;
  pendingSplit = null;
  currentConnectRun = null;

  p.term.focus();
  p.polling = true;
  p.pollRetries = 0;
  p.fitAddon.fit();
  let dims = p.fitAddon.proposeDimensions();
  let cols = (dims && dims.cols) || p.term.cols;
  let rows = (dims && dims.rows) || p.term.rows;
  api('resize', {body: {session_id: p.sid, cols: cols, rows: rows}}).catch(() => {});
  startKeepalive(p);
  saveSessions();
  pollOutput(p);
}

function cleanupRun(run) {
  if (run && run.connectSid) {
    api('disconnect', {body: {session_id: run.connectSid}}).catch(() => {});
    run.connectSid = null;
  }
}

function mapConnectError(err, opts) {
  let host = (opts && opts.host) || '';
  let user = (opts && opts.user) || '';
  if (err && err.kind) {
    return Object.assign({host, user}, err);
  }
  if (err && err.authFailed) {
    return {kind: 'auth_failed', host, user};
  }
  let msg = (err && err.message) || String(err || '');
  if (/not allowed|not in the allowed list/i.test(msg)) {
    return {kind: 'policy_deny', host, user, msg};
  }
  if (/timeout/i.test(msg)) {
    return {kind: 'timeout', host, user, msg};
  }
  return {kind: 'error', host, user, msg};
}

// One popup, many states. Only [OK]/[Cancel] (dismissConnectStatus).
function showConnectStatus(kind, ctx) {
  let title = $('tmTitle'), sub = $('tmSub'), status = $('tmStatus'), btn = $('tmCancel');
  let host = ctx.host || 'target';
  status.textContent = ''; status.className = 'tm-status';
  btn.classList.remove('h');

  if (kind === 'connecting') {
    title.textContent = 'Connecting';
    sub.textContent = ctx.persistent
      ? 'Connecting to ' + host + ' and checking for tmux…'
      : 'Connecting to ' + host + '…';
    btn.textContent = 'Cancel';
  } else if (kind === 'auth_failed') {
    title.textContent = 'Authentication failed';
    sub.textContent = 'Could not log in to ' + host + '.';
    status.textContent = 'Check your password or key and try again.';
    status.className = 'tm-status err';
    btn.textContent = 'OK';
  } else if (kind === 'no_tmux') {
    title.textContent = 'tmux not found on ' + host;
    sub.textContent =
      'Uncheck "Persistent session" to connect short-lived, then ' +
      'install tmux on the remote and try again with Persistent on.';
    btn.textContent = 'OK';
  } else if (kind === 'probe_unparseable') {
    title.textContent = 'tmux check failed';
    sub.textContent =
      'The tmux probe on ' + host + ' returned no recognisable answer. ' +
      'Uncheck "Persistent session" to connect short-lived.';
    btn.textContent = 'OK';
  } else if (kind === 'policy_deny') {
    title.textContent = 'Connection not allowed';
    sub.textContent =
      "The username '" + (ctx.user || '?') +
      "' is not authorized to connect to " + host + '.';
    if (ctx.msg) { status.textContent = ctx.msg; status.className = 'tm-status err'; }
    btn.textContent = 'OK';
  } else if (kind === 'host_down') {
    title.textContent = 'Host unreachable';
    sub.textContent = 'Could not reach ' + host + '.';
    if (ctx.msg) { status.textContent = ctx.msg; status.className = 'tm-status err'; }
    btn.textContent = 'OK';
  } else if (kind === 'timeout') {
    title.textContent = 'Connection timed out';
    sub.textContent = 'The connection to ' + host + ' timed out.';
    btn.textContent = 'OK';
  } else {
    title.textContent = 'Connection error';
    sub.textContent = 'Could not connect to ' + host + '.';
    if (ctx.msg) { status.textContent = ctx.msg; status.className = 'tm-status err'; }
    btn.textContent = 'OK';
  }
  $('tmuxOv').classList.remove('h');
}

// Popup [OK]/[Cancel] handler: cancel the in-flight run (if any) and
// hide the popup. The login form is never touched by this — it stays
// open so the user can adjust credentials and retry. If dismissing
// leaves the user on an empty screen (no panes, form also hidden —
// happens when auto-connect fails), fall back to the login form so
// they aren't stranded.
function dismissConnectStatus() {
  if (currentConnectRun) {
    currentConnectRun.cancelled = true;
    cleanupRun(currentConnectRun);
    currentConnectRun = null;
  }
  $('tmuxOv').classList.add('h');
  if (!Object.keys(panes).length && $('ov').classList.contains('h')) {
    overlayMode = 'initial';
    pendingSplit = null;
    connectingFor = null;
    showOverlay();
  }
}

// ── UI ──────────────────────────────────────────────────────────────
function setTitle(label) {
  document.title = label ? label + ' \u2014 websh' : 'websh \u2014 Lightweight but powerful web terminal';
}


// Dismissable iff the user has somewhere to retreat to:
//   'split'   — the source pane exists (and always will), so yes.
//   'initial' — there's no other pane; they must complete auth.
function overlayDismissable() { return overlayMode === 'split'; }
function showOverlay(){
  $('ov').classList.remove('h');
  $('btnCancel').classList.toggle('h', !overlayDismissable());
  hideErr();
  focusFirst();
}
function hideOverlay(){
  $('ov').classList.add('h');
  // Scrub credentials from the DOM once the overlay is closed so the
  // browser has nothing to offer to save/sync.
  $('iPw').value = '';
  $('iKey').value = '';
  $('iKeyPw').value = '';
}
function showErr(m){ let e=$('err'); e.textContent=m; e.classList.add('on') }
function hideErr(){ $('err').classList.remove('on') }

function focusFirst() {
  if($('manualForm').classList.contains('h')) return;
  let el=$('iH'); if(!el.value){el.focus();return}
  el=$('iU'); if(!el.value){el.focus();return}
  $('iPw').focus();
}

function toggleSaveName() { $('saveNameWrap').className=$('iSave').checked?'save-name':'save-name h' }

function setAuthTab(mode) {
  authMode=mode;
  $('tabPw').className='auth-tab'+(mode==='pw'?' active':'');
  $('tabKey').className='auth-tab'+(mode==='key'?' active':'');
  $('authPw').className=mode==='pw'?'fg':'fg h';
  $('authKey').className=mode==='key'?'fg':'fg h';
}

// ── Saved connections (localStorage) ────────────────────────────────
function loadSaved() { try{return JSON.parse(localStorage.getItem(storageKey('websh_connections'))||'[]')}catch(e){return[]} }
function saveSaved(list) { localStorage.setItem(storageKey('websh_connections'),JSON.stringify(list)) }

function renderSaved() {
  let list=loadSaved(), el=$('savedList');
  el.innerHTML='';
  $('divider').querySelector('span').textContent=list.length?'Or connect manually':'Connect';
  list.forEach((c,i) => {
    let div=document.createElement('div'); div.className='sv'; div.setAttribute('data-idx',i);
    div.innerHTML=
      `<div class="sv-info"><div class="sv-name">${esc(c.name)}</div>`+
      `<div class="sv-host">${esc(c.user)}@${esc(c.host)}:${c.port}${c.key?' (key)':''}</div></div>`+
      `<div class="sv-actions"><button class="sv-btn del" data-idx="${i}">Delete</button></div>`;
    el.appendChild(div);
  });
  el.onclick=e => {
    if(e.target.classList.contains('del')){
      list.splice(parseInt(e.target.getAttribute('data-idx')),1);saveSaved(list);renderSaved();return;
    }
    let row=e.target.closest('.sv'); if(!row) return;
    let idx=parseInt(row.getAttribute('data-idx')); if(isNaN(idx)) return;
    connectSaved(list[idx]);
  };
}

function connectSaved(c) {
  hideErr();
  let label = c.name||(c.user+'@'+c.host);
  // Auto-match legacy entries (saved before we tagged with connection name)
  // to a config entry by host:port so they still work under restrict_hosts.
  let connName = c.connection;
  if(!connName && serverConfig && serverConfig.connections) {
    let m = serverConfig.connections.find(e => e.host===c.host && e.port===c.port);
    if(m) connName = m.name;
  }
  runConnect({
    label: label,
    host: c.host, port: c.port || 22, user: c.user,
    connection: connName,
    auth: c.key ? 'key' : 'pw',
    password: c.pass || '',
    key: c.key || '',
    persistent: c.persistent !== false,
    slotId: null,
    tmuxCmd: c.tmux_cmd || 'tmux'
  });
}

function connectByName(name) {
  hideErr();
  let c=null;
  if(serverConfig && serverConfig.connections){
    for(let i=0;i<serverConfig.connections.length;i++){
      if(serverConfig.connections[i].name===name){c=serverConfig.connections[i];break}
    }
  }
  if(!c) return;
  // Prompt connections need user input — switch the form into locked mode.
  if(c.kind === 'prompt') { selectPromptConnection(name); return; }
  runConnect({
    label: name,
    host: c.host || '', port: c.port || 22, user: c.username || '',
    connection: name,
    auth: 'pw',
    persistent: c.persistent !== false,
    slotId: null
  });
}

function doConnect() {
  hideErr();
  let host=$('iH').value.trim(), port=parseInt($('iP').value)||22, username=$('iU').value.trim();
  let password=authMode==='pw'?$('iPw').value:$('iKeyPw').value;
  let key=authMode==='key'?$('iKey').value.trim():'';
  if(!host||!username){showErr('Host and username are required');return}
  if(authMode==='pw'&&!password){showErr('Password is required');return}
  if(authMode==='key'&&!key){showErr('Private key is required');return}
  let label = $('iName').value.trim() || (username+'@'+host);
  let wantPersistent = $('iPersistent') ? $('iPersistent').checked : true;
  // Build the save-intent but defer writing: we only commit after the
  // connect is confirmed stable (no auth failure, still alive). If the
  // user downgrades persistent→short-lived via the tmux modal, the
  // saved entry records the actual outcome (persistent=false).
  let saveEntry = null;
  if ($('iSave').checked) {
    saveEntry = {name: label, host: host, port: port, user: username,
                 auth: authMode, persistent: wantPersistent};
    if (authMode === 'pw') saveEntry.pass = password; else saveEntry.key = key;
    if (selectedPrompt) saveEntry.connection = selectedPrompt.name;
  }
  let opts = {
    label: label,
    host: host, port: port, user: username,
    connection: selectedPrompt ? selectedPrompt.name : null,
    auth: authMode,
    persistent: wantPersistent,
    slotId: null,
    saveEntry: saveEntry
  };
  if (authMode === 'pw') opts.password = password;
  else { opts.key = key; opts.keyPass = $('iKeyPw').value; }
  if (selectedPrompt && !$('iName').value.trim()) {
    opts.label = username + '@' + host + ' (' + selectedPrompt.name + ')';
  }
  runConnect(opts);
}

// ── Server config ───────────────────────────────────────────────────
function loadServerConfig() {
  api('config').then(cfg => {
    serverConfig=cfg;
    if(cfg.isolate_storage) storagePrefix = location.pathname.replace(/[^/]*$/, '');
    renderServerConnections();
    renderSaved();
    // Try to restore sessions from page reload. If there's nothing to
    // restore, kick off the initial-login flow — materialize happens on
    // submit, so the user sees the overlay on an empty workspace.
    if(!tryRestoreSessions()) {
      overlayMode = 'initial';
      doAutoConnect();
    }
  }).catch(() => {
    overlayMode = 'initial';
    showOverlay();
  });
}

// ── Prompt-kind selection (free-form ↔ locked-form transitions) ────
// selectedPrompt is null for free-form mode, or the config entry when a
// prompt card is active. The form fields are kept in sync for doConnect.
let selectedPrompt = null;

function selectPromptConnection(name) {
  if(!serverConfig || !serverConfig.connections) return;
  let entry = serverConfig.connections.find(c => c.name === name && c.kind === 'prompt');
  if(!entry) return;
  selectedPrompt = entry;
  hideErr();

  // Free manual form becomes card-locked: unhide it even when
  // restrict_hosts is on (it was hidden by renderServerConnections).
  $('manualForm').classList.remove('h');
  $('divider').classList.remove('h');

  // Banner with a × to go back.
  let fixedUser = entry.username && entry.username.length;
  let oneAllowed = entry.allowed_users && entry.allowed_users.length === 1;
  $('promptTargetLabel').textContent =
    (fixedUser ? entry.username + '@' : (oneAllowed ? entry.allowed_users[0] + '@' : '')) +
    entry.host + ':' + entry.port + '  (' + esc(entry.name) + ')';
  $('promptTarget').classList.remove('h');

  // Lock host/port; lock username if fixed or whitelist has one entry.
  $('iH').value = entry.host; $('iH').disabled = true;
  $('iP').value = entry.port; $('iP').disabled = true;
  if(fixedUser) { $('iU').value = entry.username; $('iU').disabled = true; }
  else if(oneAllowed) { $('iU').value = entry.allowed_users[0]; $('iU').disabled = true; }
  else { $('iU').value = ''; $('iU').disabled = false; }

  // Clear any stale creds; focus the password field.
  $('iPw').value = ''; $('iKey').value = ''; $('iKeyPw').value = '';
  setAuthTab('pw');
  setTimeout(() => $('iPw').focus(), 0);
}

function clearPromptSelection() {
  selectedPrompt = null;
  $('promptTarget').classList.add('h');
  $('iH').disabled = false; $('iP').disabled = false; $('iU').disabled = false;
  $('iH').value = ''; $('iP').value = '22'; $('iU').value = '';
  // Restore restrict_hosts kiosk mode if configured.
  if(serverConfig && serverConfig.restrict_hosts) {
    $('manualForm').classList.add('h');
    $('divider').classList.add('h');
  }
  hideErr();
}

function renderServerConnections() {
  if(!serverConfig||!serverConfig.connections||!serverConfig.connections.length){$('serverSection').className='saved-section h';return}
  $('serverSection').className='saved-section';
  let el=$('serverList'); el.innerHTML='';
  serverConfig.connections.forEach(c => {
    let div=document.createElement('div'); div.className='sv'; div.setAttribute('data-name',c.name);
    let userDisplay = c.username || (c.allowed_users && c.allowed_users.length===1 ? c.allowed_users[0] : '<em>user</em>');
    let kindBadge = c.kind === 'prompt' ? `<span class="sv-kind" title="Password required on click">prompt</span>` : '';
    div.innerHTML=`<div class="sv-info"><div class="sv-name">${esc(c.name)}${kindBadge}</div>`+
      `<div class="sv-host">${userDisplay}@${esc(c.host)}:${c.port}</div></div>`;
    el.appendChild(div);
  });
  el.onclick=e => {let row=e.target.closest('.sv');if(!row)return;connectByName(row.getAttribute('data-name'))};
  // restrict_hosts: no free-form — hide manual form until a Prompt card is clicked.
  // Saved connections stay visible (they reconnect through the named path).
  if(serverConfig.restrict_hosts){$('manualForm').classList.add('h');$('divider').classList.add('h')}
}

// ── File upload (binary stream via SSH ControlMaster) ───────────────
function delay(ms) { return new Promise(r => { setTimeout(r, ms); }); }

function bgSend(u, data) {
  if (!u || !u.bgSid) return Promise.reject(new Error('no background session'));
  return api('input', { body: { session_id: u.bgSid, data: data } });
}
function triggerUpload(id) {
  let p = panes[id];
  if (!p || !p.sid || p.upload || (!p.host && !p.connection)) return;
  p.el.querySelector(`[data-upload-input="${id}"]`).click();
}

function handleUpload(id, input) {
  let p = panes[id];
  if (!p || !p.sid || !input.files.length || (!p.host && !p.connection)) return;
  let files = Array.prototype.slice.call(input.files);
  input.value = '';
  let totalSize = 0;
  files.forEach(f => { totalSize += f.size });
  p.upload = {
    files:files, fileIndex:0, cancelled:false,
    totalSize:totalSize, sentBytes:0, fileOffset:0, fileSize:0,
    currentFile:null, currentTmp:null, xhr:null,
    // Persistent sessions: server-side finalize landed each file at
    // a known absolute path. Surfaced in the final banner so the
    // user knows exactly where each upload went.
    placed:[],
    // Non-persistent + alt-screen: mv was skipped, file is at
    // $HOME/.websh-tmp-* and the user must move it themselves.
    staged:[]
  };
  showUploadProgress(p);
  updatePaneBadge(p);
  uploadNextFile(p);
}

// Encode filename as base64 to avoid ANY shell injection
function safeShellName(name) { return btoa(unescape(encodeURIComponent(name))); }

// Move uploaded tmp file from $HOME → cwd of foreground shell, with
// auto-increment if a file with that name already exists.
function makeUploadMvCmd(finalName, tmpName) {
  let bf = safeShellName(finalName);
  let bt = safeShellName(tmpName);
  return `t="$HOME/$(echo ${bt} | base64 -d)"; ` +
    `f="$(echo ${bf} | base64 -d)"; ` +
    'b="${f%.*}"; e="${f##*.}"; ' +
    'if [ "$b.$e" = "$f" ]; then ' +
      'n=1; while [ -e "$f" ]; do f="$b($n).$e"; n=$((n+1)); done; ' +
    'else ' +
      'n=1; while [ -e "$f" ]; do f="${f%(*)}($n)"; n=$((n+1)); done; ' +
    'fi; ' +
    // `--` plus `./` keep mv from parsing the destination as a flag if
    // the user uploaded a file whose name starts with `-`. Mirrors the
    // server-side finalize_upload path.
    'mv -- "$t" "./$f"\n';
}

// After bytes have landed at $HOME/<tmp>, move them into the user's
// shell cwd. Persistent sessions take the server-side path: a single
// /api/upload_finalize call uses tmux's #{pane_current_path} +
// ControlMaster to do the mv with no foreground keystrokes, so vim,
// less, htop etc. are never disturbed. Non-persistent sessions fall
// back to typing the mv into the foreground PTY (the only thing
// that knows their cwd), with an alt-screen guard so the keystrokes
// are skipped while a TUI is in front — those files are surfaced as
// staged at $HOME/.websh-tmp-* in the upload banner so the user can
// move them by hand.
function finalizeUploadedFile(p, file) {
  let u = p.upload;
  let tmp = u.currentTmp, fname = u.currentFile;
  if (p.persistent) {
    return api('upload_finalize', { body: { session_id: p.sid,
                                             tmp: tmp, final: fname } })
      .then(r => {
        if (r && r.ok && r.path) {
          u.placed.push({ name: fname, path: r.path });
          return;
        }
        // Server says non-persistent (shouldn't happen for a persistent
        // pane, but is the documented graceful-fallback shape) — fall
        // through to the keystroke path. Any other error is a hard
        // failure.
        if (r && r.non_persistent) return foregroundMv(p, fname, tmp);
        return Promise.reject(r && r.error ? r.error : 'finalize failed');
      });
  }
  return foregroundMv(p, fname, tmp);
}

// Type the mv into the foreground PTY. Only path that knows the
// non-persistent shell's cwd. Skipped under alt-screen so we don't
// stuff text into a running editor.
function foregroundMv(p, fname, tmp) {
  let u = p.upload;
  let altScreen = p.term && p.term.buffer.active &&
    p.term.buffer.active.type === 'alternate';
  if (altScreen) {
    u.staged.push({ name: fname, tmp: tmp });
    return Promise.resolve();
  }
  return api('input', { body: { session_id: p.sid,
                                data: makeUploadMvCmd(fname, tmp) } });
}

function uploadNextFile(p) {
  let u = p.upload;
  if (!u || u.cancelled) return;
  if (u.fileIndex >= u.files.length) { finishUpload(p, true); return; }
  let file = u.files[u.fileIndex];
  u.fileSize = file.size;
  u.fileOffset = 0;
  u.currentFile = file.name;
  // Random tmp name in $HOME — avoids collisions and makes cleanup easy.
  u.currentTmp = '.websh-tmp-' +
    Math.random().toString(36).slice(2, 12) + '-' +
    Date.now().toString(36);

  let xhr = new XMLHttpRequest();
  u.xhr = xhr;
  let url = `${API}?action=upload` +
    `&session_id=${encodeURIComponent(p.sid)}` +
    `&path=${encodeURIComponent(u.currentTmp)}`;
  xhr.open('POST', url, true);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = e => {
    if (!u || u.cancelled) return;
    u.fileOffset = e.loaded;
    updateUploadProgress(p);
  };
  xhr.onload = () => {
    if (!u || u.cancelled) return;
    let resp = null;
    try { resp = JSON.parse(xhr.responseText); } catch(e) {}
    if (xhr.status !== 200 || !resp || !resp.ok) {
      finishUpload(p, false); return;
    }
    finalizeUploadedFile(p, file).then(() => {
      if (!u || u.cancelled) return;
      u.sentBytes += file.size;
      u.fileOffset = 0;
      u.fileIndex++;
      u.currentFile = null;
      u.currentTmp = null;
      u.xhr = null;
      updateUploadProgress(p);
      uploadNextFile(p);
    })
    .catch(() => { finishUpload(p, false); });
  };
  xhr.onerror = () => { if (u && !u.cancelled) finishUpload(p, false); };
  xhr.send(file);
}

function showUploadProgress(p) {
  let label = p.el.querySelector('[data-pane-label]');
  let prog = p.el.querySelector('[data-upload-progress]');
  if (label) label.classList.add('h');
  if (prog) {
    // Reset state from previous operation
    prog.querySelector('.upload-progress-bar').style.width = '0%';
    prog.querySelector('.upload-progress-bar').style.background = '';
    prog.querySelector('.upload-progress-text').textContent = '';
    prog.classList.remove('h');
  }
}

function hideUploadProgress(p) {
  let label = p.el.querySelector('[data-pane-label]');
  let prog = p.el.querySelector('[data-upload-progress]');
  if (label) label.classList.remove('h');
  if (prog) prog.classList.add('h');
}

function updateUploadProgress(p) {
  if (!p.upload) return;
  let el = p.el.querySelector('[data-upload-progress]');
  if (!el) return;
  let u = p.upload;
  let total = u.files.length, done = u.fileIndex;
  let file = done < total ? u.files[done] : null;
  let name = file ? file.name : 'Done';
  let bytesDone = u.sentBytes + (u.fileSize > 0 ? u.fileOffset : 0);
  let pct = u.totalSize > 0 ? Math.min(100, Math.round(bytesDone / u.totalSize * 100)) : 0;
  el.querySelector('.upload-progress-bar').style.width = pct + '%';
  let prefix = total > 1 ? `(${Math.min(done + 1, total)}/${total}) ` : '';
  el.querySelector('.upload-progress-text').textContent = prefix + name + ' ' + pct + '%';
}

function closeUploadSession(u) {
  if (!u) return;
  if (u.xhr) { try { u.xhr.abort(); } catch(e) {} u.xhr = null; }
}

function finishUpload(p, success) {
  if (!p.upload) return;
  let u = p.upload;
  u.cancelled = true;
  closeUploadSession(u);
  let staged = u.staged || [];
  let placed = u.placed || [];
  let el = p.el.querySelector('[data-upload-progress]');
  if (el) {
    let bar = el.querySelector('.upload-progress-bar');
    let text = el.querySelector('.upload-progress-text');
    if (success) {
      bar.style.width = '100%'; bar.style.background = 'var(--ok)';
      if (staged.length) {
        // Files landed in $HOME but auto-mv was skipped (alt-screen).
        // Tell the user where to look so the upload isn't a silent no-op.
        text.textContent = staged.length === 1
          ? 'Saved to $HOME/' + staged[0].tmp + ' (alt-screen — mv manually)'
          : 'Saved ' + staged.length + ' files to $HOME/.websh-tmp-* (alt-screen)';
      } else if (placed.length === 1) {
        // Persistent finalize gave us the absolute path — show it.
        text.textContent = 'Saved to ' + placed[0].path;
      } else {
        text.textContent = 'Upload complete';
      }
    } else {
      bar.style.background = 'var(--dg)';
      text.textContent = 'Upload failed';
    }
  }
  // Banner stays visible longer when there's a path the user needs to
  // act on, so they have time to read it before it disappears.
  let dismissAfter = (success && (staged.length || placed.length === 1))
    ? 6000 : 2000;
  setTimeout(() => {
    p.upload = null;
    hideUploadProgress(p);
    updatePaneBadge(p);
    if (el) el.querySelector('.upload-progress-bar').style.background = '';
  }, dismissAfter);
}

function cancelUpload(id) {
  let p = panes[id];
  if (!p || !p.upload) return;
  let u = p.upload;
  let tmpName = u.currentTmp;
  u.cancelled = true;
  if (u.xhr) { try { u.xhr.abort(); } catch(e) {} u.xhr = null; }
  // Best-effort cleanup of the partial $HOME/<tmp> via the
  // ControlMaster side-channel — keystroke-free, so a TUI in front
  // of the foreground PTY (vim/less/htop) is left alone.
  if (tmpName) {
    api('upload_cancel', { body: { session_id: p.sid, tmp: tmpName } })
      .catch(() => {});
  }

  let el = p.el.querySelector('[data-upload-progress]');
  if (el) {
    el.querySelector('.upload-progress-bar').style.background = 'var(--wn)';
    el.querySelector('.upload-progress-text').textContent = 'Cancelled';
  }
  setTimeout(() => {
    p.upload = null;
    hideUploadProgress(p);
    updatePaneBadge(p);
    if (el) el.querySelector('.upload-progress-bar').style.background = '';
  }, 2000);
}

function cancelTransfer(id) {
  let p = panes[id];
  if (p && p.upload) cancelUpload(id);
  else if (p && p.download) cancelDownload(id);
}

// ── File download ────────────────────────────────────────────────────
function triggerDownload(id) {
  let p = panes[id];
  if (!p || !p.sid || p.upload || p.download || (!p.host && !p.connection)) return;
  showFileBrowser(id);
}

function startFastDownload(id, path) {
  let p = panes[id];
  if (!p || !p.sid || p.upload || p.download) return;
  let filename = path.split('/').pop() || 'download';
  let ctrl = new AbortController();
  p.download = {cancelled: false, filename: filename, abort: () => ctrl.abort()};
  showUploadProgress(p);
  updatePaneBadge(p);

  let url = API + '?action=download&session_id=' + encodeURIComponent(p.sid) +
            '&path=' + encodeURIComponent(path);
  fetch(url, {signal: ctrl.signal})
    .then(resp => {
      if (!resp.ok) {
        return resp.json().then(e => { throw new Error(e.error || 'failed'); });
      }
      let total = parseInt(resp.headers.get('Content-Length') || '0', 10);
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error('file too large (' + (total / 1048576).toFixed(0) + ' MB)');
      }
      let chunks = [], received = 0;
      let reader = resp.body.getReader();
      function pump() {
        return reader.read().then(({done, value}) => {
          if (done) return;
          if (!p.download || p.download.cancelled) { reader.cancel(); return; }
          chunks.push(value);
          received += value.length;
          if (received > MAX_DOWNLOAD_BYTES) {
            // Server didn't advertise Content-Length but the stream is
            // overrunning the cap. Abort before the tab OOMs.
            reader.cancel();
            throw new Error('download exceeded ' +
              (MAX_DOWNLOAD_BYTES / 1073741824).toFixed(0) + ' GB cap');
          }
          let el = p.el && p.el.querySelector('[data-upload-progress]');
          if (el) {
            let pct = total > 0 ? Math.round(received / total * 100) : 30;
            el.querySelector('.upload-progress-bar').style.width = pct + '%';
            let sz = received < 1048576
              ? Math.round(received / 1024) + ' KB'
              : (received / 1048576).toFixed(1) + ' MB';
            el.querySelector('.upload-progress-text').textContent = filename + ' (' + sz + ')';
          }
          return pump();
        });
      }
      return pump().then(() => {
        // Cancellation: pump returns undefined on cancel, which resolves
        // the promise. Without this guard we'd still build a partial
        // Blob and trigger a save dialog with success UI. The .catch
        // branch below has the same guard.
        if (!p.download || p.download.cancelled) return;
        let blob = new Blob(chunks, {type: 'application/octet-stream'});
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        finishDownload(p, true);
      });
    })
    .catch(e => {
      if (p.download && !p.download.cancelled)
        finishDownload(p, false, e.message || 'download failed');
    });
}

function finishDownload(p, success, msg) {
  let dl = p.download;
  if (!dl) return;
  dl.cancelled = true;
  let el = p.el && p.el.querySelector('[data-upload-progress]');
  if (el) {
    let bar = el.querySelector('.upload-progress-bar');
    let text = el.querySelector('.upload-progress-text');
    if (success) {
      bar.style.width = '100%'; bar.style.background = 'var(--ok)';
      text.textContent = 'Download complete';
    } else {
      bar.style.background = 'var(--dg)';
      text.textContent = msg || 'Download failed';
    }
  }
  setTimeout(() => {
    p.download = null;
    hideUploadProgress(p);
    updatePaneBadge(p);
    if (el) el.querySelector('.upload-progress-bar').style.background = '';
  }, 2000);
}

function cancelDownload(id) {
  let p = panes[id];
  if (!p || !p.download) return;
  p.download.cancelled = true;
  if (p.download.abort) p.download.abort();
  let el = p.el && p.el.querySelector('[data-upload-progress]');
  if (el) {
    el.querySelector('.upload-progress-bar').style.background = 'var(--wn)';
    el.querySelector('.upload-progress-text').textContent = 'Cancelled';
  }
  setTimeout(() => {
    p.download = null;
    hideUploadProgress(p);
    updatePaneBadge(p);
    if (el) el.querySelector('.upload-progress-bar').style.background = '';
  }, 2000);
}

// ── File browser ─────────────────────────────────────────────────────
let _fbId = null;

function showFileBrowser(id) {
  let p = panes[id];
  if (!p || !p.sid) return;
  _fbId = id;
  $('fbManual').value = '';
  $('fbOv').classList.remove('h');
  loadFbDir('~');
}

function closeFb() {
  $('fbOv').classList.add('h');
  _fbId = null;
}

function fbUp() {
  let cur = $('fbPath').textContent;
  if (!cur || cur === '/') return;
  let parent = cur.lastIndexOf('/') > 0 ? cur.substring(0, cur.lastIndexOf('/')) : '/';
  loadFbDir(parent);
}

function loadFbDir(path) {
  let p = _fbId && panes[_fbId];
  if (!p) return;
  let list = $('fbList');
  list.innerHTML = '<div class="fb-msg">Loading…</div>';
  $('fbPath').textContent = path;
  fetch(API + '?action=ls&session_id=' + encodeURIComponent(p.sid) +
        '&path=' + encodeURIComponent(path))
    .then(r => r.json())
    .then(r => {
      if (r.error) {
        list.innerHTML = '<div class="fb-msg err">' + esc(r.error) + '</div>';
        return;
      }
      $('fbPath').textContent = r.path;
      renderFbEntries(r.entries, r.path);
    })
    .catch(() => {
      list.innerHTML = '<div class="fb-msg err">Failed to load</div>';
    });
}

function renderFbEntries(entries, absPath) {
  let list = $('fbList');
  list.innerHTML = '';
  if (absPath !== '/') {
    let parent = absPath.lastIndexOf('/') > 0
      ? absPath.substring(0, absPath.lastIndexOf('/')) : '/';
    let row = makeFbRow('d', '..', null);
    row.addEventListener('click', () => loadFbDir(parent));
    list.appendChild(row);
  }
  for (let e of entries) {
    let fullPath = absPath.endsWith('/') ? absPath + e.name : absPath + '/' + e.name;
    let row = makeFbRow(e.type, e.name, e.type !== 'd' ? e.size : null);
    if (e.type === 'd') {
      row.addEventListener('click', () => loadFbDir(fullPath));
    } else {
      row.addEventListener('click', () => {
        let id = _fbId;
        closeFb();
        if (id) startFastDownload(id, fullPath);
      });
    }
    list.appendChild(row);
  }
  if (!entries.length) {
    let m = document.createElement('div');
    m.className = 'fb-msg'; m.textContent = 'Empty directory';
    list.appendChild(m);
  }
}

function makeFbRow(type, name, size) {
  let row = document.createElement('div');
  row.className = 'fb-row';
  let icon = type === 'd' ? '📁' : type === 'l' ? '🔗' : '📄';
  let sizeStr = '';
  if (size !== null && size !== undefined) {
    if (size < 1024) sizeStr = size + ' B';
    else if (size < 1048576) sizeStr = (size / 1024).toFixed(1) + ' KB';
    else if (size < 1073741824) sizeStr = (size / 1048576).toFixed(1) + ' MB';
    else sizeStr = (size / 1073741824).toFixed(1) + ' GB';
  }
  row.innerHTML = '<span class="fb-ic">' + icon + '</span>' +
    '<span class="fb-nm">' + esc(name) + '</span>' +
    '<span class="fb-sz">' + esc(sizeStr) + '</span>';
  return row;
}

function fbDownloadManual() {
  let id = _fbId;
  let path = $('fbManual').value.trim();
  if (!path || !id) return;
  closeFb();
  startFastDownload(id, path);
}

// ── Search ──────────────────────────────────────────────────────────
function activeSearch() { let p=panes[activeId]; return p?p.searchAddon:null }
function toggleSearch() {
  let p=panes[activeId]; if(!p) return;
  let bar=p.el.querySelector('[data-search]');
  if(bar.classList.contains('h')){bar.classList.remove('h');bar.querySelector('input').focus()}
  else closeSearch();
}
function closeSearch(){
  let p=panes[activeId]; if(!p) return;
  p.el.querySelector('[data-search]').classList.add('h');
  p.searchAddon.clearDecorations(); p.term.focus();
}
function searchNext(){ let s=activeSearch(); if(s){let p=panes[activeId];s.findNext(p.el.querySelector('[data-search] input').value)} }
function searchPrev(){ let s=activeSearch(); if(s){let p=panes[activeId];s.findPrevious(p.el.querySelector('[data-search] input').value)} }

// Search input events — delegated
document.addEventListener('keydown', e => {
  if(e.target.closest('[data-search]')){
    if(e.key==='Enter'){e.shiftKey?searchPrev():searchNext()}
    if(e.key==='Escape') closeSearch();
  }
});

// ── Zoom ────────────────────────────────────────────────────────────
function zoomIn(){ settings.fontSize=Math.min(settings.fontSize+2,32); fontSize=settings.fontSize; saveSettings(); applySettings(); }
function zoomOut(){ settings.fontSize=Math.max(settings.fontSize-2,8); fontSize=settings.fontSize; saveSettings(); applySettings(); }
function applySettings(){
  let stack = fontStack(settings.font);
  Object.keys(panes).forEach(k => {
    let t = panes[k].term;
    t.options.fontSize = settings.fontSize;
    t.options.fontWeight = settings.fontWeight;
    t.options.fontWeightBold = Math.min(900, settings.fontWeight + 300);
    t.options.lineHeight = settings.lineHeight;
    if (t.options.fontFamily !== stack) t.options.fontFamily = stack;
    waitForFontThenRefresh(t, panes[k].fitAddon);
    try { panes[k].fitAddon.fit(); } catch(e){}
  });
}
function waitForFontThenRefresh(term, fit){
  let f = FONTS[settings.font];
  let webfont = f && f[1];
  if (!webfont || !document.fonts || !document.fonts.load) return;
  document.fonts.load(`${settings.fontWeight} ${settings.fontSize}px '${webfont}'`)
    .then(() => {
      // xterm caches glyph metrics — bump fontFamily through a throwaway value
      // to force a re-measure once the webfont has arrived.
      let ff = term.options.fontFamily;
      term.options.fontFamily = 'monospace';
      term.options.fontFamily = ff;
      try { fit && fit.fit(); } catch(e){}
    }).catch(()=>{});
}

// ── Options dialog ─────────────────────────────────────────────────
const OPT_PREVIEW = [
  ['c-dim','$ '],['','ls -la /usr/local/bin | head\n'],
  ['c-dim','total 248\n'],
  ['','-rwxr-xr-x 1 root root 12840 Apr 17 09:42 '],['c-green','claude\n'],
  ['','-rwxr-xr-x 1 root root  8192 Feb 11 12:30 '],['c-green','tmux\n'],
  ['c-dim','$ '],['','git log --oneline -2\n'],
  ['c-red','81e8260 '],['','tests: close HTTPServer sockets\n'],
  ['c-red','eaab909 '],['','README: polish — persistent-sessions docs\n'],
  ['c-dim','# '],['','illiI1lO0o  {} [] () <> =>  "hello" ~!@#$%^&*\n'],
  ['c-dim','# '],['','if (x === null) return obj?.value ?? 42;']
];
function renderOptPreview(){
  let el = $('optPreview'); if (!el) return;
  el.style.fontFamily = fontStack(settings.font);
  el.style.fontSize = settings.fontSize + 'px';
  el.style.fontWeight = settings.fontWeight;
  el.style.lineHeight = settings.lineHeight;
  el.textContent = '';
  for (let [cls, txt] of OPT_PREVIEW) {
    let s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = txt;
    el.appendChild(s);
  }
}
function openOptions(){
  let sel = $('optFont');
  if (sel && !sel.options.length) {
    Object.keys(FONTS).forEach(id => {
      let o = document.createElement('option');
      o.value = id; o.textContent = FONTS[id][0];
      sel.appendChild(o);
    });
  }
  sel.value = settings.font;
  $('optSize').value = settings.fontSize;
  $('optSizeVal').textContent = settings.fontSize + 'px';
  $('optLineHeight').value = settings.lineHeight;
  $('optLineHeightVal').textContent = Number(settings.lineHeight).toFixed(2);
  $('optWeight').value = settings.fontWeight;
  $('optWeightVal').textContent = settings.fontWeight;
  let cm = $('optTmuxMouse'); if (cm) cm.checked = !!settings.tmuxMouse;
  let cc = $('optTmuxClipboard'); if (cc) cc.checked = !!settings.tmuxClipboard;
  let ch = $('optTmuxHistory'); if (ch) ch.value = settings.tmuxHistory;
  renderOptPreview();
  $('ovOpt').classList.remove('h');
}
function closeOptions(){ $('ovOpt').classList.add('h'); }
function resetOptions(){
  settings = { ...DEFAULT_SETTINGS };
  fontSize = settings.fontSize;
  saveSettings();
  applySettings();
  openOptions();
}
function onOptInput(key, el, valEl, fmt){
  let v = key === 'lineHeight' ? parseFloat(el.value) : parseInt(el.value, 10);
  settings[key] = v;
  if (key === 'fontSize') fontSize = v;
  valEl.textContent = fmt(v);
  saveSettings();
  applySettings();
  renderOptPreview();
}
document.addEventListener('DOMContentLoaded', () => {
  let s = $('optSize'), sv = $('optSizeVal');
  let lh = $('optLineHeight'), lhv = $('optLineHeightVal');
  let w = $('optWeight'), wv = $('optWeightVal');
  let f = $('optFont');
  if (!s || !lh || !w || !f) return;
  s.addEventListener('input', () => onOptInput('fontSize', s, sv, v => v+'px'));
  lh.addEventListener('input', () => onOptInput('lineHeight', lh, lhv, v => v.toFixed(2)));
  w.addEventListener('input', () => onOptInput('fontWeight', w, wv, v => String(v)));
  f.addEventListener('change', () => { settings.font = f.value; saveSettings(); applySettings(); renderOptPreview(); });
  let cm = $('optTmuxMouse'), cc = $('optTmuxClipboard'), ch = $('optTmuxHistory');
  if (cm) cm.addEventListener('change', () => { settings.tmuxMouse = cm.checked; saveSettings(); pushTmuxOptionsToActiveSessions(); });
  if (cc) cc.addEventListener('change', () => { settings.tmuxClipboard = cc.checked; saveSettings(); pushTmuxOptionsToActiveSessions(); });
  if (ch) ch.addEventListener('change', () => {
    let v = parseInt(ch.value, 10);
    if (!Number.isFinite(v) || v < 100) v = DEFAULT_SETTINGS.tmuxHistory;
    settings.tmuxHistory = v; ch.value = v; saveSettings();
    pushTmuxOptionsToActiveSessions();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('ovOpt').classList.contains('h')) closeOptions();
  });
});

// Ship the current tmux toggles into every running persistent pane so
// the change takes effect immediately (no reconnect). Routed through
// /api/tmux_options, which runs `tmux set -g …` over the existing
// ControlMaster channel server-side — so the change can't bleed into
// a running editor / pager that happens to occupy the foreground PTY.
function pushTmuxOptionsToActiveSessions() {
  let payload = {
    tmux_mouse: !!settings.tmuxMouse,
    tmux_set_clipboard: !!settings.tmuxClipboard,
  };
  let hl = parseInt(settings.tmuxHistory, 10);
  if (Number.isFinite(hl) && hl >= 100) payload.tmux_history_limit = hl;
  Object.keys(panes).forEach(k => {
    let p = panes[k];
    if (!p || !p.sid || !p.persistent) return;
    api('tmux_options', { body: Object.assign({ session_id: p.sid }, payload) })
      .catch(() => {});
  });
}

// ── Fullscreen ──────────────────────────────────────────────────────
function toggleFullscreen(){
  if(!document.fullscreenElement)document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}

// ── Theme ───────────────────────────────────────────────────────────
function toggleTheme(){
  let isLight=document.documentElement.getAttribute('data-theme')==='light';
  document.documentElement.setAttribute('data-theme',isLight?'dark':'light');
  let t=isLight?darkTheme:lightTheme;
  Object.keys(panes).forEach(k => {panes[k].term.options.theme=t});
  localStorage.setItem('websh_theme',isLight?'dark':'light');
}

// ── Split handle drag resize (mouse + touch) ───────────────────────
(function(){
  let dragging=null;
  function startDrag(handle, clientX, clientY) {
    let wrap=handle.parentNode;
    let isH=wrap.classList.contains('split-h');
    let children=[];
    for(let i=0;i<wrap.children.length;i++){
      let ch=wrap.children[i];
      if(!ch.classList.contains('split-handle')) children.push(ch);
    }
    if(children.length<2) return;
    dragging={handle:handle,wrap:wrap,isH:isH,a:children[0],b:children[1]};
    handle.classList.add('dragging');
    document.body.classList.add(isH?'resizing':'resizing-v');
  }
  function moveDrag(clientX, clientY) {
    if(!dragging) return;
    let rect=dragging.wrap.getBoundingClientRect();
    let ratio = dragging.isH
      ? (clientX-rect.left)/rect.width
      : (clientY-rect.top)/rect.height;
    ratio=Math.max(0.1,Math.min(0.9,ratio));
    dragging.a.style.flex=ratio+'';
    dragging.b.style.flex=(1-ratio)+'';
    Object.keys(panes).forEach(k => {panes[k].fitAddon.fit()});
  }
  function endDrag() {
    if(!dragging) return;
    dragging.handle.classList.remove('dragging');
    document.body.classList.remove('resizing','resizing-v');
    dragging=null;
    Object.keys(panes).forEach(k => {panes[k].fitAddon.fit()});
    saveSessions();
  }
  // Mouse events
  document.addEventListener('mousedown', e => {
    if(!e.target.classList.contains('split-handle')) return;
    e.preventDefault(); startDrag(e.target, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', e => { moveDrag(e.clientX, e.clientY) });
  document.addEventListener('mouseup', endDrag);
  // Touch events
  document.addEventListener('touchstart', e => {
    if(!e.target.classList.contains('split-handle')) return;
    e.preventDefault(); let t=e.touches[0]; startDrag(e.target, t.clientX, t.clientY);
  }, {passive:false});
  document.addEventListener('touchmove', e => {
    if(!dragging) return; e.preventDefault(); let t=e.touches[0]; moveDrag(t.clientX, t.clientY);
  }, {passive:false});
  document.addEventListener('touchend', endDrag);
  document.addEventListener('touchcancel', endDrag);
})();

// ── Keyboard shortcuts ──────────────────────────────────────────────
function cyclePanes(reverse) {
  let ids = Object.keys(panes);
  if (ids.length < 2) return;
  let idx = ids.indexOf(activeId);
  if (reverse) idx = (idx - 1 + ids.length) % ids.length;
  else idx = (idx + 1) % ids.length;
  activatePane(ids[idx]);
}
document.addEventListener('keydown', e => {
  if(e.ctrlKey&&e.shiftKey&&e.key==='F'){e.preventDefault();toggleSearch()}
  if(e.ctrlKey&&!e.shiftKey&&(e.key==='='||e.key==='+')){e.preventDefault();zoomIn()}
  if(e.ctrlKey&&!e.shiftKey&&e.key==='-'){e.preventDefault();zoomOut()}
  if(e.key==='F11'){e.preventDefault();toggleFullscreen()}
  // Ctrl+Tab / Ctrl+Shift+Tab to switch panes
  if(e.ctrlKey&&e.key==='Tab'){e.preventDefault();cyclePanes(e.shiftKey)}
  // Escape: status popup first (topmost), then the login overlay.
  if(e.key==='Escape' && !$('tmuxOv').classList.contains('h')){
    e.preventDefault(); dismissConnectStatus(); return;
  }
  if(e.key==='Escape' && !$('ov').classList.contains('h')
     && $('tmuxOv').classList.contains('h') && overlayDismissable()){
    e.preventDefault(); cancelConnect();
  }
});
// Backdrop click on the overlay also dismisses (same dismissable rule).
$('ov').addEventListener('click', e => {
  if(e.target === e.currentTarget && overlayDismissable()) cancelConnect();
});

// ── Enter to connect ────────────────────────────────────────────────
document.querySelector('.panel').addEventListener('keydown', e => {
  if(e.key==='Enter'&&e.target.matches('input:not([type=checkbox])')) doConnect();
});

// ── Auto-connect logic ──────────────────────────────────────────────
function doAutoConnect() {
  // URL anchor: #connect=ConnectionName
  let hash = location.hash.replace(/^#/, '');
  let m = hash.match(/^connect=(.+)/);
  if (m && serverConfig && serverConfig.connections) {
    let name = decodeURIComponent(m[1]);
    let found = serverConfig.connections.some(c => c.name===name);
    if (found) { connectByName(name); return; }
  }
  // Single server connection with restrict_hosts:
  //   - Ready  → connect immediately (no overlay, no form).
  //   - Prompt → show the overlay with the form pre-locked, password focused.
  //     Skip the pre-lock if saved connections exist — user can click one.
  if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1) {
    let only = serverConfig.connections[0];
    if (only.kind === 'prompt') {
      showOverlay();
      if (loadSaved().length === 0) selectPromptConnection(only.name);
      return;
    }
    connectByName(only.name);
    return;
  }
  showOverlay();
}

// ── Session restore ─────────────────────────────────────────────────
// Rebuild layout + reconnect every pane from the localStorage manifest.
// Persistent panes attach via tmux (resume_slot_id); short-lived panes
// just re-run a plain connect with the saved credentials.
function tryRestoreSessions() {
  let m = loadManifest();
  if (!m || !m.layout || !m.panes || !Object.keys(m.panes).length) return false;

  let restored = {};
  let root = $('panes');
  Object.keys(panes).forEach(k => { try { panes[k].term.dispose(); } catch(e) {} delete panes[k]; });
  root.innerHTML = '';

  function build(parent, node) {
    if (!node) return null;
    if (node.type === 'leaf') {
      let p = createPane(parent);
      if (node.flex) p.el.style.flex = node.flex;
      restored[node.pane] = p;
      return p.el;
    }
    let wrap = document.createElement('div');
    wrap.className = 'split-' + (node.dir === 'v' ? 'v' : 'h');
    if (node.flex) wrap.style.flex = node.flex;
    parent.appendChild(wrap);
    build(wrap, node.a);
    let handle = document.createElement('div');
    handle.className = 'split-handle';
    wrap.appendChild(handle);
    build(wrap, node.b);
    return wrap;
  }
  build(root, m.layout);

  let ids = Object.keys(restored);
  if (!ids.length) return false;
  activatePane(restored[ids[0]].id);

  Object.keys(m.panes).forEach(oldId => {
    let rec = m.panes[oldId];
    let p = restored[oldId];
    if (!p || !rec) return;
    connectPane(p, {
      label: rec.label, host: rec.host, port: rec.port, user: rec.user,
      connection: rec.connection, auth: rec.auth,
      password: rec.password, key: rec.key, keyPass: rec.key_pass,
      persistent: rec.persistent, slotId: rec.slot_id,
      tmuxCmd: rec.tmux_cmd || 'tmux',
      resume: !!rec.persistent
    });
  });
  return true;
}

// ── Init ────────────────────────────────────────────────────────────
(function(){
  let saved=localStorage.getItem('websh_theme');
  if(saved==='light') document.documentElement.setAttribute('data-theme','light');
})();

// No pane is created eagerly. loadServerConfig drives next step:
// either tryRestoreSessions rebuilds the saved layout, or overlayMode is
// set to 'initial' and the user sees the login form on an empty canvas.
loadServerConfig();
renderSaved();
focusFirst();
