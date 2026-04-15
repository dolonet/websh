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
let serverConfig = null;
let sessionTimeout = 300; // updated from server config
let fontSize = 14;
const MAX_POLL_RETRIES = 5;
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
      `<button class="btn" onclick="newConnectionPane('${id}')">New connection</button>` +
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
    cursorBlink:true, cursorStyle:'bar', fontSize:fontSize,
    fontFamily:"'Menlo','Monaco','SF Mono','Cascadia Code','Fira Code','JetBrains Mono','Consolas',monospace",
    theme: currentTheme(),
    allowProposedApi:true, scrollback:50000
  });
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  let u = new Unicode11Addon.Unicode11Addon(); term.loadAddon(u);
  term.unicode.activeVersion = '11';
  term.loadAddon(search);
  term.open(termEl);

  let p = {
    id:id, el:el, term:term, fitAddon:fit, searchAddon:search,
    sid:null, connecting:false, polling:false, pollRetries:0,
    inputQueue:[], flushTimer:null, keepaliveTimer:null,
    label:'', resizeTimer:null, upload:null, download:null,
    idleTimer:null, idleWarnEl:null,
    // Connection identity — set once per connect, used for save/restore/reconnect.
    host:'', port:22, user:'', connection:null,
    auth:'pw', password:'', key:'', keyPass:'',
    persistent:false, slotId:null
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
function splitPane(id, dir) {
  let p = panes[id];
  if (!p) return;
  let parent = p.el.parentNode;
  let wrap = document.createElement('div');
  wrap.className = 'split-' + dir;
  let handle = document.createElement('div');
  handle.className = 'split-handle';
  parent.replaceChild(wrap, p.el);
  wrap.appendChild(p.el);
  wrap.appendChild(handle);

  // Create new pane placeholder
  let np = createPane(wrap);
  activatePane(np.id);
  saveSessions();

  // Auto-connect if single restricted host, otherwise show overlay.
  // For Prompt-kind entries we need user input, so we surface the overlay.
  if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1
      && serverConfig.connections[0].kind !== 'prompt') {
    connectByName(serverConfig.connections[0].name);
  } else {
    connectingFor = np.id;
    if (selectedPrompt) clearPromptSelection();
    showOverlay();
    $('btnCancel').classList.remove('h');
    if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1
        && serverConfig.connections[0].kind === 'prompt'
        && loadSaved().length === 0) {
      selectPromptConnection(serverConfig.connections[0].name);
    }
    renderSaved();
  }
}

function cancelConnect() {
  if (!connectingFor) return;
  let np = panes[connectingFor];
  if (np && !np.sid) {
    // Undo split: remove the wrapper, put the sibling back
    let wrap = np.el.parentNode;
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
  connectingFor = null;
  hideOverlay();
  $('btnCancel').classList.add('h');
  // Activate remaining pane
  let ids = Object.keys(panes);
  if (ids.length) activatePane(ids[ids.length - 1]);
}

function closePane(id) {
  let p = panes[id];
  if (!p) return;
  // Cancel active transfers
  if (p.upload) { p.upload.cancelled = true; closeUploadSession(p.upload); }
  if (p.download) { p.download.cancelled = true; if(p.download.bgSid) api('disconnect',{body:{session_id:p.download.bgSid}}).catch(() => {}); }
  // Disconnect main session
  if (p.sid) {
    p.polling = false;
    stopKeepalive(p);
    clearIdleTimer(p);
    api('disconnect', {body:{session_id:p.sid}}).catch(() => {});
  }
  p.term.dispose();
  saveSessions();

  let wrap = p.el.parentNode;
  delete panes[id];

  // If no panes left, create a fresh one and show auth overlay
  if (!Object.keys(panes).length) {
    let root = $('panes');
    root.innerHTML = '';
    let np = createPane(root);
    activatePane(np.id);
    connectingFor = np.id;
    showOverlay();
    $('btnCancel').classList.add('h');
    renderSaved();
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
}

// ── Per-pane session helpers ────────────────────────────────────────
function startKeepalive(p) {
  stopKeepalive(p);
  p.keepaliveTimer = setInterval(() => { if(p.sid) api('ping').catch(() => {}) }, 30000);
}
function stopKeepalive(p) {
  if(p.keepaliveTimer){ clearInterval(p.keepaliveTimer); p.keepaliveTimer=null }
}

// ── Reconnect ────────────────────────────────────────────────────────
function showReconnectBar(p) {
  let bar = p.el.querySelector('[data-reconnect]');
  if (bar) bar.classList.remove('h');
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
function newConnectionPane(id) {
  let p = panes[id]; if (!p) return;
  hideReconnectBar(p);
  p.term.reset();
  connectingFor = p.id;
  showOverlay();
  let hasOthers = Object.keys(panes).length > 1;
  $('btnCancel').classList.toggle('h', !hasOthers);
  prefillForm(p);
  renderSaved();
}

// ── Idle timeout warning ────────────────────────────────────────────
function resetIdleTimer(p) {
  clearIdleTimer(p);
  if (!p.sid || sessionTimeout <= 0) return;
  let warnAt = Math.max(0, sessionTimeout - 30) * 1000;
  p.idleTimer = setTimeout(() => { showIdleWarning(p); }, warnAt);
}
function clearIdleTimer(p) {
  if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }
  dismissIdleWarning(p);
}
function showIdleWarning(p) {
  if (!p.sid) return;
  let el = document.createElement('div');
  el.className = 'idle-warn';
  el.innerHTML = `Session idle — will disconnect in 30s <button class="btn" onclick="keepAlive('${p.id}')">Keep alive</button>`;
  p.el.appendChild(el);
  p.idleWarnEl = el;
}
function dismissIdleWarning(p) {
  if (p.idleWarnEl) { p.idleWarnEl.remove(); p.idleWarnEl = null; }
}
function keepAlive(id) {
  let p = panes[id]; if (!p || !p.sid) return;
  // Send empty input to reset server-side activity timer
  api('input', {body: {session_id: p.sid, data: ''}}).catch(() => {});
  resetIdleTimer(p);
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
  }
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

// ── Pre-fill form from last connection ──────────────────────────────
function prefillForm(p) {
  if (!p) return;
  if (p.host) $('iH').value = p.host;
  if (p.port) $('iP').value = p.port;
  if (p.user) $('iU').value = p.user;
}

// ── Export terminal ─────────────────────────────────────────────────
function exportTerminal() {
  let p = panes[activeId]; if (!p) return;
  let buf = p.term.buffer.active;
  let lines = [];
  for (let i = 0; i <= buf.length - 1; i++) {
    let line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  // Trim trailing empty lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let text = lines.join('\n') + '\n';
  let blob = new Blob([text], {type: 'text/plain'});
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (p.label || 'terminal') + '.txt';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function pollOutput(p) {
  if(!p.sid || !p.polling) return;
  api('output',{query:'&session_id='+p.sid}).then(r => {
    p.pollRetries=0;
    if(r.error){
      // Session not found — stale restore or server restarted. Persistent
      // panes try to re-attach via tmux; short-lived panes just reconnect.
      console.log('poll: session error:', r.error);
      stopKeepalive(p); clearIdleTimer(p); p.polling=false; p.sid=null; p.connecting=false;
      updatePaneBadge(p);
      if(p.host || p.connection) {
        connectPane(p, {label:p.label, resume:p.persistent});
      } else { doAutoConnect(); }
      return;
    }
    p.connecting=false;
    console.log('poll:', p.id, 'data_len:', (r.data||'').length, 'alive:', r.alive);
    if(r.data){
      updatePaneBadge(p);
      p.term.write(Uint8Array.from(atob(r.data), c => c.charCodeAt(0)));
      resetIdleTimer(p);
    }
    if(r.alive===false){
      p.term.write('\r\n\x1b[90m--- connection closed ---\x1b[0m\r\n');
      stopKeepalive(p); clearIdleTimer(p); p.polling=false; p.sid=null;
      saveSessions();
      if(p.host || p.connection) showReconnectBar(p);
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
      stopKeepalive(p); clearIdleTimer(p); p.polling=false; p.sid=null;
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
  resetIdleTimer(p);
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

  hideReconnectBar(p);
  p.connecting = true;
  let labelEl = p.el.querySelector('[data-pane-label]');
  if (labelEl) labelEl.textContent = p.label;
  p.term.reset();
  setTitle(p.label);
  updatePaneBadge(p);

  let body = buildConnectBody(paneRecord(p), p.term.cols, p.term.rows);
  if (opts.resume && p.slotId) body.resume_slot_id = p.slotId;

  api('connect', {body: body})
    .then(r => {
      console.log('connect result:', r);
      p.connecting = false;
      if (r.error) { showErr(r.error); updatePaneBadge(p); return }
      if (r.alive === false) { showErr('SSH process exited immediately'); updatePaneBadge(p); return }
      p.sid = r.session_id;
      if (r.slot_id) p.slotId = r.slot_id;
      hideOverlay();
      $('btnCancel').classList.add('h');
      connectingFor = null;
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
      resetIdleTimer(p);
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

// ── UI ──────────────────────────────────────────────────────────────
function setTitle(label) {
  document.title = label ? label + ' \u2014 websh' : 'websh \u2014 Lightweight but powerful web terminal';
}


function showOverlay(){ $('ov').classList.remove('h'); focusFirst() }
function hideOverlay(){ $('ov').classList.add('h') }
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
  let p = targetPane(); if(!p) return;
  let label = c.name||(c.user+'@'+c.host);
  // Auto-match legacy entries (saved before we tagged with connection name)
  // to a config entry by host:port so they still work under restrict_hosts.
  let connName = c.connection;
  if(!connName && serverConfig && serverConfig.connections) {
    let m = serverConfig.connections.find(e => e.host===c.host && e.port===c.port);
    if(m) connName = m.name;
  }
  connectPane(p, {
    label: label,
    host: c.host, port: c.port || 22, user: c.user,
    connection: connName,
    auth: c.key ? 'key' : 'pw',
    password: c.pass || '',
    key: c.key || '',
    persistent: c.persistent !== false,
    slotId: null
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
  let p = targetPane(); if(!p) return;
  connectPane(p, {
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
  let p = targetPane(); if(!p) return;
  let host=$('iH').value.trim(), port=parseInt($('iP').value)||22, username=$('iU').value.trim();
  let password=authMode==='pw'?$('iPw').value:$('iKeyPw').value;
  let key=authMode==='key'?$('iKey').value.trim():'';
  if(!host||!username){showErr('Host and username are required');return}
  if(authMode==='pw'&&!password){showErr('Password is required');return}
  if(authMode==='key'&&!key){showErr('Private key is required');return}
  let label = $('iName').value.trim() || (username+'@'+host);
  let wantPersistent = $('iPersistent') ? $('iPersistent').checked : true;
  if($('iSave').checked){
    let list=loadSaved();
    let entry={name:label,host:host,port:port,user:username,auth:authMode,persistent:wantPersistent};
    if(authMode==='pw') entry.pass=password; else entry.key=key;
    if(selectedPrompt) entry.connection=selectedPrompt.name;
    list=list.filter(c => {return c.name!==label}); list.unshift(entry);
    saveSaved(list); $('iSave').checked=false; toggleSaveName();
  }
  let opts = {
    label: label,
    host: host, port: port, user: username,
    connection: selectedPrompt ? selectedPrompt.name : null,
    auth: authMode,
    persistent: wantPersistent,
    slotId: null
  };
  if (authMode === 'pw') opts.password = password;
  else { opts.key = key; opts.keyPass = $('iKeyPw').value; }
  if (selectedPrompt && !$('iName').value.trim()) {
    opts.label = username + '@' + host + ' (' + selectedPrompt.name + ')';
  }
  connectPane(p, opts);
}

function doDisconnect() {
  let p=panes[activeId]; if(!p) return;
  p.polling=false; stopKeepalive(p); clearIdleTimer(p);
  if(p.sid){api('disconnect',{body:{session_id:p.sid}}).catch(() => {});p.sid=null}
  saveSessions();
  p.label='';
  let labelEl=p.el.querySelector('[data-pane-label]'); if(labelEl) labelEl.textContent='';
  updatePaneBadge(p);
  p.term.reset();
  if (selectedPrompt) clearPromptSelection();
  connectingFor=p.id;
  showOverlay();
  // Show cancel only if there are other panes with active sessions
  let hasOthers=false;
  Object.keys(panes).forEach(k => {if(k!==p.id && panes[k].sid) hasOthers=true});
  $('btnCancel').classList.toggle('h', !(hasOthers || Object.keys(panes).length>1));
  renderSaved();
}

// ── Server config ───────────────────────────────────────────────────
function loadServerConfig() {
  api('config').then(cfg => {
    serverConfig=cfg;
    if(cfg.session_timeout) sessionTimeout=cfg.session_timeout;
    if(cfg.isolate_storage) storagePrefix = location.pathname.replace(/[^/]*$/, '');
    renderServerConnections();
    renderSaved();
    // Try to restore sessions from page reload
    if(!tryRestoreSessions()) {
      doAutoConnect();
    }
  }).catch(() => {
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

// ── File upload (background SSH session) ────────────────────────────
const SLICE_SIZE = 32768; // 32KB file slices

function delay(ms) { return new Promise(r => { setTimeout(r, ms); }); }

function bgSend(u, data) {
  if (!u || !u.bgSid) return Promise.reject(new Error('no background session'));
  return api('input', { body: { session_id: u.bgSid, data: data } });
}
function bgDlSend(p, data) {
  if (!p.download || !p.download.bgSid) return Promise.reject(new Error('no background session'));
  return api('input', { body: { session_id: p.download.bgSid, data: data } });
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
    bgSid:null, currentFile:null
  };
  showUploadProgress(p);
  updatePaneBadge(p);

  // Create background SSH session with same credentials (no tmux wrap).
  let body = buildConnectBody(paneRecord(p), 80, 24);
  delete body.persistent; delete body.slot_id;
  body.background = true;
  api('connect', {body: body}).then(r => {
    if (!p.upload || p.upload.cancelled) return;
    if (r.error || r.alive === false) { finishUpload(p, false); return; }
    p.upload.bgSid = r.session_id;
    // Wait for SSH to fully connect
    return delay(2000);
  }).then(() => {
    if (!p.upload || p.upload.cancelled) return;
    // Drain initial output (MOTD etc) so it doesn't interfere
    return api('output', {query: '&session_id=' + p.upload.bgSid});
  }).then(() => {
    if (!p.upload || p.upload.cancelled) return;
    uploadNextFile(p);
  }).catch(() => { finishUpload(p, false); });
}

// Encode filename as base64 to avoid ANY shell injection
function safeShellName(name) { return btoa(unescape(encodeURIComponent(name))); }

function makeRenamCmd(name) {
  // Shell command: mv tmp → final, with auto-increment if final exists.
  // All filenames base64-encoded to prevent injection.
  let b64 = safeShellName(name);
  let b64tmp = safeShellName('.' + name + '.websh.tmp');
  // Decode names into shell vars, then increment if needed, then mv
  return `t="$(echo ${b64tmp} | base64 -d)"; ` +
    `f="$(echo ${b64} | base64 -d)"; ` +
    'b="${f%.*}"; e="${f##*.}"; ' +
    'if [ "$b.$e" = "$f" ]; then ' +
      'n=1; while [ -e "$f" ]; do f="$b($n).$e"; n=$((n+1)); done; ' +
    'else ' +
      'n=1; while [ -e "$f" ]; do f="${f%(*)}($n)"; n=$((n+1)); done; ' +
    'fi; ' +
    'mv "$t" "$f"\n';
}

function uploadNextFile(p) {
  let u = p.upload;
  if (!u || u.cancelled) return;
  if (u.fileIndex >= u.files.length) { finishUpload(p, true); return; }
  let file = u.files[u.fileIndex];
  u.fileOffset = 0;
  u.fileSize = file.size;
  u.currentFile = file.name;
  u.currentTmp = '.' + file.name + '.websh.tmp';

  let b64tmp = safeShellName(u.currentTmp);
  // Start base64 decode into temp file (filename base64-encoded — injection-safe)
  bgSend(u, `base64 -d > "$(echo ${b64tmp} | base64 -d)"\n`).then(() => {
    if (!u || u.cancelled) return;
    return delay(50);
  }).then(() => {
    sendNextSlice(p, file);
  }).catch(() => { finishUpload(p, false); });
}

function sendNextSlice(p, file) {
  let u = p.upload;
  if (!u || u.cancelled || !u.bgSid) return;

  if (u.fileOffset >= file.size) {
    // Send Ctrl+D to end base64, rename tmp → final, move to next file
    bgSend(u, '\x04').then(() => {
      return delay(50);
    }).then(() => {
      // Rename tmp → final (auto-increments if file already exists)
      return bgSend(u, makeRenamCmd(u.currentFile));
    }).then(() => {
      u.sentBytes += file.size;
      u.fileIndex++;
      u.currentFile = null;
      u.currentTmp = null;
      updateUploadProgress(p);
      return delay(100);
    }).then(() => {
      uploadNextFile(p);
    }).catch(() => { finishUpload(p, false); });
    return;
  }

  let end = Math.min(u.fileOffset + SLICE_SIZE, file.size);
  let slice = file.slice(u.fileOffset, end);
  let reader = new FileReader();
  reader.onload = e => {
    if (!u || u.cancelled) return;
    let bytes = new Uint8Array(e.target.result);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    let b64 = btoa(binary);
    let lines = '';
    for (let j = 0; j < b64.length; j += 76) lines += b64.substring(j, j + 76) + '\n';
    bgSend(u, lines).then(() => {
      if (!u || u.cancelled) return;
      u.fileOffset = end;
      updateUploadProgress(p);
      sendNextSlice(p, file);
    }).catch(() => { finishUpload(p, false); });
  };
  reader.onerror = () => { finishUpload(p, false); };
  reader.readAsArrayBuffer(slice);
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
  if (u && u.bgSid) {
    api('disconnect', {body: {session_id: u.bgSid}}).catch(() => {});
    u.bgSid = null;
  }
}

function finishUpload(p, success) {
  if (!p.upload) return;
  let u = p.upload;
  u.cancelled = true;
  closeUploadSession(u);
  let el = p.el.querySelector('[data-upload-progress]');
  if (el) {
    let bar = el.querySelector('.upload-progress-bar');
    let text = el.querySelector('.upload-progress-text');
    if (success) {
      bar.style.width = '100%'; bar.style.background = 'var(--ok)';
      text.textContent = 'Upload complete';
    } else {
      bar.style.background = 'var(--dg)';
      text.textContent = 'Upload failed';
    }
  }
  setTimeout(() => {
    p.upload = null;
    hideUploadProgress(p);
    updatePaneBadge(p);
    if (el) el.querySelector('.upload-progress-bar').style.background = '';
  }, 2000);
}

function cancelUpload(id) {
  let p = panes[id];
  if (!p || !p.upload) return;
  let u = p.upload;
  let fileName = u.currentFile;
  u.cancelled = true;

  // Abort base64, delete temp file, close background session
  let tmpName = u.currentTmp;
  if (u.bgSid) {
    bgSend(u, '\x03\n').then(() => {
      if (tmpName) { let b=safeShellName(tmpName); return bgSend(u, `rm -f "$(echo ${b} | base64 -d)"\n`); }
    }).then(() => {
      return delay(100);
    }).then(() => {
      closeUploadSession(u);
    }).catch(() => {
      closeUploadSession(u);
    });
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

// ── File download (background SSH session) ─────────────────────────
function triggerDownload(id) {
  let p = panes[id];
  if (!p || !p.sid || p.upload || p.download || (!p.host && !p.connection)) return;
  // Use terminal selection as filename, or prompt
  let sel = (p.term.getSelection() || '').trim().replace(/^['"]|['"]$/g, '');
  if (sel && sel.indexOf('\n') === -1 && sel.length < 256) {
    startDownload(p, sel);
  } else {
    let name = prompt('Filename to download:');
    if (name && name.trim()) startDownload(p, name.trim());
  }
}

function startDownload(p, filename) {
  let b64name = safeShellName(filename);
  let sf = `"$(echo ${b64name} | base64 -d)"`; // injection-safe shell ref
  p.download = { cancelled: false, bgSid: null, filename: filename, b64: '', expectedSize: 0 };
  showUploadProgress(p);
  updatePaneBadge(p);

  // Create background session (no tmux wrap).
  let body = buildConnectBody(paneRecord(p), 80, 24);
  delete body.persistent; delete body.slot_id;
  body.background = true;
  api('connect', {body: body}).then(r => {
    if (!p.download || p.download.cancelled) return;
    if (r.error || r.alive === false) { finishDownload(p, false); return; }
    p.download.bgSid = r.session_id;
    // Wait for SSH + MOTD, then send base64 command with error marker
    // No separate stat step — just try base64 and detect failure via marker
    return delay(3000);
  }).then(() => {
    if (!p.download || p.download.cancelled) return;
    // Drain all MOTD output before sending command
    function drain() {
      return api('output', {query: '&session_id=' + p.download.bgSid}).then(r => {
        if (r && r.data && atob(r.data).length > 0) return delay(200).then(drain);
      });
    }
    return drain();
  }).then(() => {
    if (!p.download || p.download.cancelled) return;
    // Disable echo so our command doesn't appear in output
    return bgDlSend(p, 'stty -echo\n');
  }).then(() => {
    return delay(200);
  }).then(() => {
    if (!p.download || p.download.cancelled) return;
    return bgDlSend(p, `base64 ${sf} 2>/dev/null && echo WEBSH_DL_DONE || echo WEBSH_DL_ERR\n`);
  }).then(() => {
    if (!p.download || p.download.cancelled) return;
    pollDownload(p);
  }).catch(() => { finishDownload(p, false); });
}

const MAX_DOWNLOAD_B64 = 50 * 1024 * 1024; // ~37MB file limit

function pollDownload(p) {
  let dl = p.download;
  if (!dl || dl.cancelled || !dl.bgSid) return;
  api('output', {query: '&session_id=' + dl.bgSid}).then(r => {
    if (!dl || dl.cancelled) return;
    if (r.data) {
      let chunk = atob(r.data);
      dl.b64 += chunk;
      if (dl.b64.length > MAX_DOWNLOAD_B64) { finishDownload(p, false, 'File too large'); return; }

      // Check for error (file not found)
      if (dl.b64.indexOf('WEBSH_DL_ERR') !== -1) { finishDownload(p, false, 'File not found'); return; }

      // Check if done — extract only the base64 content (skip MOTD/prompts)
      let doneIdx = dl.b64.indexOf('WEBSH_DL_DONE');
      if (doneIdx !== -1) {
        // base64 output is pure [A-Za-z0-9+/=\n] — extract it
        let raw = dl.b64.substring(0, doneIdx);
        // Find start of actual base64 (after MOTD/prompt) — look for first long base64 line
        let lines = raw.split('\n');
        let b64lines = [];
        for (let i = 0; i < lines.length; i++) {
          let line = lines[i].trim();
          if (line && /^[A-Za-z0-9+/=]+$/.test(line)) b64lines.push(line);
        }
        dl.b64 = b64lines.join('');
        saveDownload(p);
        return;
      }
      updateDownloadProgress(p);
    }
    if (r.alive === false) { finishDownload(p, false); return; }
    pollDownload(p);
  }).catch(() => {
    finishDownload(p, false);
  });
}

function updateDownloadProgress(p) {
  let dl = p.download;
  if (!dl) return;
  let el = p.el.querySelector('[data-upload-progress]');
  if (!el) return;
  let bar = el.querySelector('.upload-progress-bar');
  // Indeterminate: pulse between 20-80% based on data received
  let kb = Math.round(dl.b64.length / 1024);
  let pulse = 20 + (Math.sin(Date.now() / 500) + 1) * 30;
  bar.style.width = pulse + '%';
  bar.style.opacity = '0.7';
  el.querySelector('.upload-progress-text').textContent = dl.filename + ' (' + kb + ' KB)';
}

function saveDownload(p) {
  let dl = p.download;
  if (!dl) return;
  try {
    // Decode base64 — remove any whitespace/newlines
    let clean = dl.b64.replace(/\s/g, '');
    let binary = atob(clean);
    let bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    let blob = new Blob([bytes], {type: 'application/octet-stream'});
    let a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = dl.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    finishDownload(p, true);
  } catch(e) {
    finishDownload(p, false, 'Decode error');
  }
}

function finishDownload(p, success, msg) {
  let dl = p.download;
  if (!dl) return;
  dl.cancelled = true;
  if (dl.bgSid) {
    api('disconnect', {body: {session_id: dl.bgSid}}).catch(() => {});
    dl.bgSid = null;
  }
  let el = p.el.querySelector('[data-upload-progress]');
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
  if (p.download.bgSid) {
    api('disconnect', {body: {session_id: p.download.bgSid}}).catch(() => {});
    p.download.bgSid = null;
  }
  let el = p.el.querySelector('[data-upload-progress]');
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
function zoomIn(){fontSize=Math.min(fontSize+2,32);applyZoom()}
function zoomOut(){fontSize=Math.max(fontSize-2,8);applyZoom()}
function applyZoom(){
  Object.keys(panes).forEach(k => {panes[k].term.options.fontSize=fontSize;panes[k].fitAddon.fit()});
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

let rootPane = createPane($('panes'));
activatePane(rootPane.id);
connectingFor = rootPane.id;
$('btnCancel').classList.add('h'); // no cancel on first connect

loadServerConfig();
renderSaved();
focusFirst();
