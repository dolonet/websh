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
// SELECTION_TRIM: cursor-hide + clipboard-trim machinery
// ----------------------------------------------------------------
// With tmux mouse-on, tmux's copy-mode leaves a terminal cursor at the
// cell one past the orange (mode-style yellow) selection. That cell is
// included in tmux's selection (and OSC 52 payload), so we both
//   (a) hide it visually during the drag by blurring xterm (combined
//       with `cursorInactiveStyle:'none'` on the Terminal, see
//       createPane) so the cursor bar / blink stops being painted, and
//   (b) trim one trailing character from any clipboard payload that
//       fires shortly after the drag.
// State lives per-pane on `p` (_dragBlurred, _selDisp, _selTimer,
// _dragStartX/Y, _dragMoved, _recentDragSelectAt). The three coupled
// sites are tagged `SELECTION_TRIM:` so the trio can't drift apart.
const DRAG_TRIM_WINDOW_MS = 1500;   // OSC 52 over SSE arrives ~50–200ms
                                    // after mouseup; window is generous.
const POST_DRAG_HIDE_FALLBACK_MS = 500; // for non-tmux sessions where the
                                        // cursor never moves on its own.
function trimDragTail(p, s) {
  if (!s || s.length <= 1) return s;
  // SELECTION_TRIM: drop the trailing cursor-cell character if the pane
  // is either still in drag-blur (xterm's mouseup-fired onSelectionChange
  // runs synchronously *before* the document mouseup, so timestamp is
  // stale on that path) or within the trim window of a recent drag (the
  // async OSC 52 path from tmux over SSE).
  if (p._dragBlurred ||
      (p._recentDragSelectAt &&
       Date.now() - p._recentDragSelectAt < DRAG_TRIM_WINDOW_MS)) {
    return s.slice(0, -1);
  }
  return s;
}
function _cancelDragBlurArm(p) {
  if (!p) return;
  if (p._selDisp) { try { p._selDisp.dispose(); } catch(e){} p._selDisp = null; }
  if (p._selTimer) { clearTimeout(p._selTimer); p._selTimer = null; }
}
function _restorePaneFromDrag(p) {
  if (!p) return;
  _cancelDragBlurArm(p);
  p._dragBlurred = false;
  try { p.term && p.term.focus(); } catch(e){}
}
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
  // tmux options sent on /api/connect when persistent. tmux mouse mode
  // is no longer user-configurable — the server hardcodes `set -g mouse
  // on` so wheel-scroll-history and click-in-vim work out of the box
  // without ever needing to toggle in /options.
  tmuxClipboard: true, tmuxHistory: 100000
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

// Copy `text` to the system clipboard. Yandex Browser silently rejects
// navigator.clipboard.writeText() outside a tightly-scoped user gesture,
// which is also where xterm's built-in OSC 52 handler falls over. We
// run the synchronous document.execCommand('copy') path first so the
// copy lands inside the post-mouseup "transient user activation" window
// (~5 s in Chromium); writeText() runs after as a best-effort upgrade
// for browsers where it's permitted.
function copyText(text) {
  if (!text) return;
  let listener = e => {
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    }
  };
  document.addEventListener('copy', listener, true);
  try { document.execCommand('copy'); } catch (e) {}
  document.removeEventListener('copy', listener, true);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
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
// How long the transport (SSE or long-poll) is allowed to stay broken
// before we surface the red banner. Until this elapses the failure is
// retried silently with exponential backoff so brief Wi-Fi blips don't
// startle the user. Wall-clock budget, not retry count.
const RECONNECT_BUDGET_MS = 60000;
// Backoff steps used for both SSE retry-after and long-poll retry.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 15000];
// If SSE doesn't deliver any event (data or comment) within this window,
// assume an upstream proxy is buffering it and silently fall back to
// /api/output long-polling for the rest of the session.
const SSE_FIRST_MSG_TIMEOUT_MS = 5000;
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
    `<div class="pane-term"></div>`;
  container.appendChild(el);

  let termEl = el.querySelector('.pane-term');
  let fit = new FitAddon.FitAddon();
  let term = new Terminal({
    cursorBlink:true, cursorStyle:'bar',
    // SELECTION_TRIM: when xterm is blurred, render the cursor cell with
    // no decoration at all — so the cell glyph stays visible but no
    // bar/block/blink is drawn. We blur on drag-start and refocus on the
    // deferred restore. See the SELECTION_TRIM trio in this file.
    cursorInactiveStyle:'none',
    fontSize: settings.fontSize,
    fontFamily: fontStack(settings.font),
    fontWeight: settings.fontWeight,
    fontWeightBold: Math.min(900, settings.fontWeight + 300),
    lineHeight: settings.lineHeight,
    theme: darkTheme,
    allowProposedApi:true, scrollback:50000
  });
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  let u = new Unicode11Addon.Unicode11Addon(); term.loadAddon(u);
  term.unicode.activeVersion = '11';
  term.open(termEl);

  let p = {
    id:id, el:el, term:term, fitAddon:fit,
    sid:null, connecting:false, polling:false, pollRetries:0,
    inputQueue:[], flushTimer:null, keepaliveTimer:null,
    label:'', resizeTimer:null, upload:null, download:null,
    // Last (cols,rows) we POSTed to the server — used to skip duplicate
    // /api/resize calls when several refit triggers fire in the same
    // tick (settle-loop iterations + ResizeObserver echo; visibility
    // recovery; held-key zoom autorepeat landing on the cap value).
    lastSentCols:0, lastSentRows:0,
    // Connection identity — set once per connect, used for save/restore/reconnect.
    host:'', port:22, user:'', connection:null,
    auth:'pw', password:'', key:'', keyPass:'',
    persistent:false, slotId:null, tmuxCmd:'tmux',
    connectedAt:0, // ms timestamp of last successful /api/connect resolve
    // SELECTION_TRIM: per-pane drag-blur state (see trimDragTail header)
    _dragBlurred:false, _selDisp:null, _selTimer:null,
    _dragStartX:0, _dragStartY:0, _dragMoved:false,
    _recentDragSelectAt:0
  };
  panes[id] = p;
  // Schedule a font-load-aware settle-loop refit after registration so
  // the helper can guard its RAFs against pane teardown via panes[id].
  // (Do not re-add a charSizeChange listener here — recursion via the
  // settle-loop fontFamily round-trip; see commit 292eace.)
  fitPaneWhenStable(p);

  // SELECTION_TRIM: focus tracking + drag-blur for cursor hiding.
  // Blur the xterm terminal on left-mousedown so the cursor cell that
  // ends up at the trailing edge of tmux's orange selection renders
  // without the bar/blink (via cursorInactiveStyle:'none'). The
  // companion document-level mouseup defers `focus()` restoration until
  // tmux moves the cursor back to the prompt (onCursorMove) or 500ms
  // elapsed, so the bar doesn't flicker back in the gap. Click-vs-drag
  // is decided by mousemove > 3px — bare clicks skip both the arm and
  // the trim window so a programmatic OSC 52 right after a focus-click
  // isn't truncated.
  el.addEventListener('mousedown', (e) => {
    activatePane(id);
    if (e.button !== 0) return;
    // Cancel any leftover deferred restore from a prior drag so the
    // stale subscription doesn't fire mid-new-drag and re-focus xterm.
    _cancelDragBlurArm(p);
    p._dragStartX = e.clientX; p._dragStartY = e.clientY; p._dragMoved = false;
    p._dragBlurred = true;
    try { p.term.blur(); } catch(err){}
  });
  el.addEventListener('mousemove', (e) => {
    if (!p._dragBlurred || p._dragMoved) return;
    if ((e.buttons & 1) === 0) return;
    if (Math.abs(e.clientX - p._dragStartX) > 3 ||
        Math.abs(e.clientY - p._dragStartY) > 3) {
      p._dragMoved = true;
    }
  });

  // Terminal events
  term.onData(d => {
    if (!p.sid) return;
    queueInput(p, d);
  });
  term.onBinary(d => { if(p.sid) queueInput(p,d) });
  term.onResize(size => {
    if(!p.sid) return;
    if(p.resizeTimer) clearTimeout(p.resizeTimer);
    p.resizeTimer = setTimeout(() => {
      p.resizeTimer=null;
      if(!p.sid) return;
      // Skip if the dimensions match what the server has already
      // confirmed receiving — saves a round-trip when several refit
      // triggers converge on the same size (held-key zoom past the
      // cap, ResizeObserver echo, etc.). Commit-on-success: the
      // lastSent fields are only updated after the POST resolves,
      // so a failed POST naturally retries on the next refit. See
      // flushPaneResize for the rationale.
      if(p.lastSentCols === size.cols && p.lastSentRows === size.rows) return;
      api('resize',{body:{session_id:p.sid,cols:size.cols,rows:size.rows}})
        .then(r => {
          if (r && r.error) return;
          p.lastSentCols = size.cols;
          p.lastSentRows = size.rows;
        })
        .catch(() => { /* leave lastSent alone so the next refit retries */ });
    }, 150);
  });
  // SELECTION_TRIM: hand selection-change copies through trimDragTail so
  // tmux's trailing cursor-cell character is dropped. See module-level
  // trimDragTail header for the rationale.
  term.onSelectionChange(() => {
    let sel = term.getSelection();
    if (!sel) return;
    sel = trimDragTail(p, sel);
    if (sel) copyText(sel);
  });

  // OSC 52 from tmux (with `set-clipboard on`, which is the default
  // here). xterm v5's built-in OSC 52 handler calls writeText, which
  // Yandex denies because OSC bytes arrive on the network polling
  // path — outside a gesture frame. Our handler reuses copyText() so
  // the sync execCommand runs inside the activation window left by
  // the recent mouseup. Format: "<kind>;<base64>"; "?" means a read
  // request, which we don't service.
  if (term.parser && term.parser.registerOscHandler) {
    term.parser.registerOscHandler(52, data => {
      let semi = data.indexOf(';');
      if (semi < 0) return false;
      let payload = data.slice(semi + 1);
      if (!payload || payload === '?') return false;
      let text;
      try { text = atob(payload); } catch (e) { return false; }
      try { text = decodeURIComponent(escape(text)); } catch (e) {}
      // SELECTION_TRIM: see trimDragTail header at module top.
      text = trimDragTail(p, text);
      copyText(text);
      return true;
    });
  }
  term.onBell(() => {
    el.classList.remove('bell'); void el.offsetWidth; el.classList.add('bell');
  });

  // Right-click paste. Also swallow button-2 mousedown at capture phase
  // so xterm.js never forwards it to the remote — otherwise tmux (with
  // `mouse on`) catches MouseDown3Pane and pops its own menu, which
  // competes with our paste UX.
  //
  // activatePane(id) is called explicitly before stopPropagation: the
  // bubble-phase listener on the parent .pane element (`el.mousedown
  // → activatePane(id)`) won't fire once we stop propagation, so
  // right-clicking an inactive pane would leave the previously-active
  // pane focused and the subsequent contextmenu paste would land in
  // the wrong pane.
  termEl.addEventListener('mousedown', e => {
    if (e.button === 2) {
      activatePane(id);
      e.stopPropagation();
    }
  }, true);
  termEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    if(navigator.clipboard && navigator.clipboard.readText){
      navigator.clipboard.readText().then(t => { if(t && p.sid) queueInput(p,t) }).catch(() => {});
    }
  });

  // Resize observer fires immediately on observe() with the current
  // container size, so the initial fit happens automatically. The
  // older setTimeout(fit, 50) fallback is now redundant: ResizeObserver
  // covers the cold-layout case and fitPaneWhenStable covers the
  // webfont-load case.
  new ResizeObserver(() => { fit.fit() }).observe(termEl);

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
  // Drop any sessionStorage secrets first — the pane is going away,
  // and so should its plaintext SSH credentials. Vault panes have no
  // entry here; the call is a no-op for them.
  _deletePaneSecret(id);
  // Cancel active transfers
  if (p.upload) { p.upload.cancelled = true; closeUploadSession(p.upload); }
  if (p.download) { p.download.cancelled = true; if (p.download.abort) p.download.abort(); }
  // SELECTION_TRIM: drop any pending onCursorMove subscription / timer
  // pointing at the term we're about to dispose.
  _cancelDragBlurArm(p);
  // fitPaneWhenStable safety-valve timer. Without clearing it here, a
  // pane closed mid-settle keeps the 10 s closure (and its `p` ref)
  // alive until the timer fires — harmless because `panes[p.id] !== p`
  // bails on each step, but a leak under rapid open/close churn.
  if (p._stuckTimer) {
    clearTimeout(p._stuckTimer);
    p._stuckTimer = null;
  }
  p._fitInFlight = false;
  // Disconnect main session
  if (p.sid) {
    p.polling = false;
    stopKeepalive(p);
    closeStream(p);
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

// ── Pane secret storage (sessionStorage, manual/named panes) ────────
// localStorage[websh_panes] persists layout + non-secret pane metadata
// across browser restarts. SSH plaintext (passwords, key PEMs, key
// passphrases) for manual or prompt-kind connections lives in
// sessionStorage instead — it survives F5 within a tab but doesn't
// land in long-term profile storage (browser-history sync, FDE
// snapshots) and is gone after a tab close. See docs/encryption.md
// for the precise property ("never in long-term profile storage; brief
// crash-recovery shadow during a live session"). Vault-backed panes
// don't use this map; their credentials live on the server.
const SS_PANE_SECRETS_KEY = 'websh_panes_session';
function _loadPaneSecrets() {
  try { return JSON.parse(sessionStorage.getItem(storageKey(SS_PANE_SECRETS_KEY)) || '{}'); }
  catch (e) { return {}; }
}
function _savePaneSecrets(map) {
  try { sessionStorage.setItem(storageKey(SS_PANE_SECRETS_KEY), JSON.stringify(map)); }
  catch (e) {}
}
function _setPaneSecret(uuid, secrets) {
  // No-op if nothing to store — avoid creating empty rows that later
  // F5 would re-read as "secrets exist but are empty."
  if (!secrets || (!secrets.password && !secrets.key && !secrets.key_pass)) {
    return _deletePaneSecret(uuid);
  }
  let m = _loadPaneSecrets();
  m[uuid] = secrets;
  _savePaneSecrets(m);
}
function _getPaneSecret(uuid) { return _loadPaneSecrets()[uuid] || null; }
function _deletePaneSecret(uuid) {
  let m = _loadPaneSecrets();
  if (!(uuid in m)) return;
  delete m[uuid];
  _savePaneSecrets(m);
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
  // Disk-safe per-pane record persisted into localStorage. Vault panes
  // store conn_id + display-hint metadata, no key bytes — F5 restore
  // re-derives vault_key from IDB. Manual and named panes still inline
  // plaintext for backward compatibility (manual moves to
  // sessionStorage in the next task).
  if (!p.host && !p.connection && !p.conn_id) return null;
  let rec = {
    label:      p.label || '',
    persistent: !!p.persistent,
    slot_id:    p.slotId || null,
    tmux_cmd:   p.tmuxCmd || 'tmux',
    cols:       p.term.cols,
    rows:       p.term.rows,
  };
  if (p.conn_id) {
    rec.via = 'vault';
    rec.conn_id = p.conn_id;
    // host/port/user persisted as UX hints (badge text + slot id);
    // server fetches the real values from the stored vault record.
    rec.host = p.host || '';
    rec.port = p.port || 22;
    rec.user = p.user || '';
  } else if (p.connection) {
    rec.via = 'named';
    rec.connection = p.connection;
    rec.user = p.user || '';
    rec.auth = p.auth || (p.key ? 'key' : 'pw');
    // Plaintext lives in sessionStorage (_setPaneSecret on materialise,
    // _getPaneSecret on restore). Only prompt-kind named connections
    // need a password client-side anyway; ready-kind connections rely
    // on websh.json server-side.
  } else {
    rec.via = 'manual';
    rec.host = p.host;
    rec.port = p.port;
    rec.user = p.user;
    rec.auth = p.auth || (p.key ? 'key' : 'pw');
    // Plaintext moved to sessionStorage — see _setPaneSecret().
  }
  return rec;
}

function buildConnectBody(rec, termCols, termRows) {
  // Translate a pane record into the shape server.py /api/connect wants.
  // Saved-variant: ship the vault tuple; server pulls host/username
  // from the stored record, decrypts the blob with vault_key, and
  // proceeds with ssh. Cols/rows/persistent/slot_id/tmux options still
  // flow through (server-side they apply identically to manual mode).
  if (rec.vault_id && rec.conn_id && rec.vault_key) {
    let b = {
      vault_id: rec.vault_id,
      conn_id:  rec.conn_id,
      vault_key: rec.vault_key,
      cols: termCols || rec.cols || 80,
      rows: termRows || rec.rows || 24,
    };
    if (rec.persistent) {
      b.persistent = true;
      b.slot_id = rec.slot_id || slotIdFor(rec.user, rec.host, rec.port);
      b.tmux_set_clipboard = !!settings.tmuxClipboard;
      let hl = parseInt(settings.tmuxHistory, 10);
      if (Number.isFinite(hl) && hl >= 100) b.tmux_history_limit = hl;
    }
    if (rec.tmux_cmd && rec.tmux_cmd !== 'tmux') b.tmux_cmd = rec.tmux_cmd;
    return b;
  }
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
    // dropped silently rather than fail the connect. Mouse is hardcoded
    // on the server side (no user-facing toggle).
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
  p.pendingSave = null;
  if ($('iSave').checked) { $('iSave').checked = false; toggleSaveName(); }
  if (entry._pendingSecrets) {
    // Vault path: mint conn_id, encrypt secrets, POST to /api/save; on
    // success the entry (without _pendingSecrets) is added to the
    // saved-card list. Failure surfaces as a toast and does not touch
    // the list — the live session keeps running either way.
    commitVaultSave(entry).then(() => {
      // Best-effort UX hook for future Safari ITP / persist() prompt.
      if (typeof _onFirstVaultSave === 'function' && _vaultFirstSave) {
        _vaultFirstSave = false;
        try { _onFirstVaultSave(); } catch(e){}
      }
    }).catch(err => {
      console.warn('vault save failed:', err);
      showToast('Could not save credentials to the server. The session ' +
                'is still open; try Save again later.', 'warn');
    });
    return;
  }
  // No-vault fallback path. Currently unreachable because doConnect now
  // only assembles a saveEntry when serverConfig.vault_enabled is true;
  // kept defensive for any future caller that hand-builds pendingSave.
  let list = loadSaved();
  list = list.filter(c => c.name !== entry.name);
  list.unshift(entry);
  saveSaved(list);
  renderSaved();
}

async function commitVaultSave(entry) {
  let conn_id = generateConnId();
  let secrets = entry._pendingSecrets || {};
  delete entry._pendingSecrets;
  let {iv, ct, vault_id} = await encryptCredentials(secrets, conn_id);
  let body = {
    vault_id, conn_id,
    host: entry.host, port: entry.port, username: entry.user,
    iv, ct,
  };
  let resp = await api('save', {body: body});
  if (resp && resp.error) {
    throw new Error('save: ' + resp.error);
  }
  entry.conn_id = conn_id;
  // De-dup by conn_id (and by name, for the pre-vault upgrade path
  // where an old plaintext row with the same label is still around).
  let list = loadSaved().filter(c => c.conn_id !== conn_id && c.name !== entry.name);
  list.unshift(entry);
  saveSaved(list);
  renderSaved();
}

// ── Output transport ────────────────────────────────────────────────
// Two transports share one payload shape ({data, alive, auth_failed}).
// Primary: SSE via /api/stream, opened with EventSource. Falls back to
// long-poll automatically if (a) EventSource is missing, (b) the first
// SSE event doesn't arrive within SSE_FIRST_MSG_TIMEOUT_MS (a buffering
// proxy), or (c) the SSE connection errors before any event landed. A
// pane that has fallen back stays on long-poll for the rest of the
// session — no flapping.

function closeStream(p) {
  if (p.eventSource) {
    try { p.eventSource.close(); } catch (e) {}
    p.eventSource = null;
  }
  if (p.sseFirstMsgTimer) {
    clearTimeout(p.sseFirstMsgTimer);
    p.sseFirstMsgTimer = null;
  }
}

// ── Recovery after a long absence ────────────────────────────────────
// Background tabs get frozen by the browser (Chrome's memory saver /
// page lifecycle freeze) after ~5 min hidden: timers stop, EventSource
// pauses, our 30s empty-input keepalive stops going out. The server
// reaps the PTY after SESSION_TIMEOUT idle, the SSE socket rots, but
// EventSource doesn't always fire onerror on resume — the tab looks
// frozen until F5. Persistent panes survive because the real shell
// lives in tmux on the remote host; a fresh connect re-attaches by
// slot_id. bfcache restore (Firefox/Safari Back navigation, sometimes
// Chrome) is a sibling case: pageshow with persisted=true means the
// page was un-bfcached; timers and EventSource state are stale.
//
// Strategy: on either signal — visibility return after >10s hidden,
// or bfcache restore — refit every active pane and reopen its output
// stream. If the server-side session is still alive, the SSE primer
// arrives in one frame and nothing visible happens. If it was reaped,
// the reconnect path fires and tmux brings the shell back.
//
// Long-poll panes don't need the SSE kick (fetch isn't frozen the way
// EventSource is in a backgrounded tab, the existing pollOutput
// recursion keeps running across the freeze; double-firing would
// stack a second poll chain and garble output via destructive
// session.read() races). They DO benefit from the refit, though,
// since the window may have changed size while we were hidden.
function kickPanesAfterAbsence() {
  Object.values(panes).forEach(p => {
    if (!p || !p.sid || !p.polling) return;
    // Settle-loop refit covers the case where the webfont finished
    // loading while the tab was hidden (xterm's measurement was made
    // against the fallback). The onSettled callback chains the SSE
    // reconnect after /api/resize lands, preserving the original
    // server-side ordering guarantee: PTY is resized before the
    // shell next prints into the new stream.
    fitPaneWhenStable(p, { onSettled: (p) => {
      if (p.sseDisabled) return;
      closeStream(p);
      clearRetryClock(p);
      startOutput(p);
    }});
  });
}

let _lastHiddenAt = 0;
const VISIBILITY_PROBE_THRESHOLD_MS = 10000;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _lastHiddenAt = Date.now();
    return;
  }
  let hiddenFor = _lastHiddenAt ? (Date.now() - _lastHiddenAt) : 0;
  _lastHiddenAt = 0;
  if (hiddenFor < VISIBILITY_PROBE_THRESHOLD_MS) return;
  kickPanesAfterAbsence();
});

// bfcache restore: Firefox / Safari (and Chrome since 96) cache the
// whole page across navigations and restore it on Back. visibilitychange
// is unreliable on this path; pageshow with event.persisted=true is
// the canonical signal per the WICG Page Lifecycle spec.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) kickPanesAfterAbsence();
});

// Apply one decoded JSON payload from either transport. Returns true if
// the session ended (auth_failed / alive=false / fatal session error)
// so callers know to stop their read loop.
function handleOutputPayload(p, r) {
  if (r.error) {
    // Session not found — stale restore or server restarted. Persistent
    // panes try to re-attach via tmux; short-lived panes just reconnect.
    // Idempotency: only enter this branch on the first frame that
    // signals it; later frames (event:end after data on SSE) find
    // p.sid already nulled by us and bail. Without this guard we'd
    // re-enter connectPane and stomp our own reconnect attempt.
    if (!p.sid) return true;
    console.log('output: session error:', r.error);
    closeStream(p);
    stopKeepalive(p); p.polling=false; p.sid=null; p.connecting=false;
    updatePaneBadge(p);
    if(p.host || p.connection) {
      connectPane(p, {label:p.label, resume:p.persistent});
    } else { doAutoConnect(); }
    return true;
  }
  p.connecting=false;
  if(r.data){
    // Always render incoming bytes — even on a tail-drain frame that
    // arrives after the disconnect banner, the bytes may be the last
    // thing the shell wrote (final command output, exit message). We
    // lose nothing by writing them after the banner; xterm renders
    // them where the cursor is. Skipping them on p.sid=null would
    // silently drop end-of-session output.
    updatePaneBadge(p);
    let chunk = atob(r.data);
    p.term.write(Uint8Array.from(chunk, c => c.charCodeAt(0)));
    // Keep a short tail of decoded output only while we're still
    // within the tmux-death detection window on a persistent pane.
    if (p.persistent && p.connectedAt && (Date.now() - p.connectedAt) < 8000) {
      p.recentOutput = ((p.recentOutput || '') + chunk).slice(-4096);
    }
  }
  // Idempotency guard for the terminal-state branches below. SSE
  // delivers session-end as {alive:false} on data, then a tail-drain
  // {alive:false}, then event:end{alive:false}; each ends up here, and
  // each branch below nulls p.sid on the first call. Without this we'd
  // re-banner, re-stop-keepalive, re-saveSessions 2-3× per disconnect.
  if (!p.sid) return true;
  // SSH auth rejected our password/key: stop the loop cleanly and
  // do NOT save the entry. Surface the failure on the pane itself
  // (reconnect placeholder). The login form never reopens on its own.
  if (r.auth_failed) {
    p.pendingSave = null;
    p.term.write('\r\n\x1b[91m--- authentication failed ---\x1b[0m\r\n');
    closeStream(p);
    stopKeepalive(p); p.polling = false;
    if (p.sid) {
      api('disconnect', {body: {session_id: p.sid}}).catch(() => {});
      p.sid = null;
    }
    p.recentOutput = '';
    updatePaneBadge(p);
    if (p.host || p.connection) showReconnectBar(p, 'auth_failed');
    saveSessions();
    return true;
  }
  // Commit the deferred save once the session has proven healthy
  // (alive and no auth failure for ≥2.5 s).
  if (p.pendingSave && r.alive !== false &&
      p.connectedAt && (Date.now() - p.connectedAt) >= 2500) {
    commitPendingSave(p);
  }
  if(r.alive===false){
    p.term.write('\r\n\x1b[90m--- connection closed ---\x1b[0m\r\n');
    closeStream(p);
    stopKeepalive(p); p.polling=false; p.sid=null;
    saveSessions();
    // Smart tmux fallback: a persistent pane whose session dies quickly
    // with a "not found" shape in the output is almost certainly a
    // missing tmux binary on the target. Offer re-probe / short-lived.
    let quick = p.connectedAt && (Date.now() - p.connectedAt) < 5000;
    let tail = p.recentOutput || '';
    // Cover the common shells' wordings for "tmux not installed":
    //   bash/dash/sh:  "bash: tmux: command not found", "/bin/sh: tmux: not found"
    //   zsh:           "zsh: command not found: tmux"
    //   ksh:           "ksh: tmux: not found"
    //   fish:          "Unknown command: tmux"  (literal, case-sensitive in fish)
    //   csh/tcsh:      "tmux: Command not found." (capitalised, with period)
    // Plus the ENOENT path: "tmux: No such file or directory" (when invoked
    // with an explicit path that doesn't exist). Avoid matching a bare
    // "not found" without tmux context to stay clear of unrelated errors.
    let hit = /tmux: (?:command )?not found|command not found:?\s*tmux|tmux:\s*Command not found|Unknown command:?\s*tmux|tmux:\s*No such file/i.test(tail);
    if (p.persistent && quick && hit) {
      showTmuxBar(p, 'tmux seems missing on ' + (p.host || 'target') + '.');
    } else if (p.host || p.connection) {
      showReconnectBar(p);
    }
    p.recentOutput = '';
    if(activeId===p.id) updatePaneBadge(p);
    return true;
  }
  return false;
}

// Compute the silent-retry delay. While the failure window is under
// RECONNECT_BUDGET_MS, returns ms to wait for the next attempt and
// bumps the failure clock if needed. Returns -1 once the budget is
// exhausted; the caller should then surface the red banner.
function nextRetryDelay(p) {
  if (!p.firstFailureAt) p.firstFailureAt = Date.now();
  let elapsed = Date.now() - p.firstFailureAt;
  if (elapsed >= RECONNECT_BUDGET_MS) return -1;
  let n = (p.retryCount = (p.retryCount || 0) + 1);
  let i = Math.min(n - 1, RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[i];
}

function clearRetryClock(p) {
  p.firstFailureAt = 0;
  p.retryCount = 0;
  p.pollRetries = 0;
}

function transportFatal(p, e) {
  // Final fallback: budget exhausted, give up and surface banner.
  console.error('transport gave up:', p.id, e);
  let msg = (e && e.message && e.message.indexOf('502') !== -1)
    ? '\r\n\x1b[91m--- backend restarted, session lost ---\x1b[0m\r\n'
    : '\r\n\x1b[91m--- connection lost ---\x1b[0m\r\n';
  p.term.write(msg);
  closeStream(p);
  stopKeepalive(p); p.polling=false; p.sid=null;
  saveSessions();
  if(p.host || p.connection) showReconnectBar(p);
  if(activeId===p.id) updatePaneBadge(p);
}

// Entry point used in place of the old pollOutput(). Tries SSE first,
// then transparently downgrades to long-poll on incompatible proxies.
function startOutput(p) {
  if (!p.sid || !p.polling) return;
  if (typeof EventSource !== 'undefined' && !p.sseDisabled) {
    streamOutput(p);
  } else {
    pollOutput(p);
  }
}

function streamOutput(p) {
  if (!p.sid || !p.polling) return;
  closeStream(p);
  let url = `${API}?action=stream&session_id=${encodeURIComponent(p.sid)}`;
  let es;
  try { es = new EventSource(url); }
  catch (e) {
    console.log('SSE: EventSource construction failed, using long-poll');
    p.sseDisabled = true;
    pollOutput(p);
    return;
  }
  p.eventSource = es;
  p.sseGotAnyMessage = false;
  // First-message timer: a buffering proxy will hold the response
  // until N bytes accumulate, so no event reaches us. The backend
  // sends ': ok\n\n' on connect specifically to defeat this — if we
  // don't see anything within the timeout, we're behind a buffer.
  if (p.sseFirstMsgTimer) clearTimeout(p.sseFirstMsgTimer);
  p.sseFirstMsgTimer = setTimeout(() => {
    if (!p.sseGotAnyMessage && p.eventSource === es) {
      console.log('SSE: no event in', SSE_FIRST_MSG_TIMEOUT_MS,
                  'ms, falling back to long-poll');
      p.sseDisabled = true;
      closeStream(p);
      if (p.polling) pollOutput(p);
    }
  }, SSE_FIRST_MSG_TIMEOUT_MS);

  // 'open' fires when HTTP response headers arrive — *before* any body
  // bytes traverse the upstream/proxy chain. A buffering proxy (nginx
  // without X-Accel-Buffering: no, Cloudflare free tier, Apache mod_deflate,
  // fastcgi_buffering on) flushes headers immediately and holds the body,
  // which is exactly the case the first-message timer is designed to detect.
  // So we DO NOT mark sseGotAnyMessage on 'open' — only body events
  // ('data' / 'end') prove the channel actually flushes. We also DO NOT
  // clear the retry clock on 'open': through a buffering proxy the
  // headers arrive but no body ever does, and resetting the budget on
  // every 'open' would let an unbroken series of half-working
  // connections starve the wall-clock retry budget. The first-message
  // timer is the safety net that fires the long-poll fallback; the
  // retry clock should only reset once a real frame proves the channel.
  let onBodyEvent = () => {
    p.sseGotAnyMessage = true;
    clearRetryClock(p);
  };
  // EventSource fires onmessage for unnamed events; the ': ok' comment
  // doesn't trigger it but still arrives on the wire. We rely on the
  // 'data' / 'end' named events here.
  es.addEventListener('data', e => {
    onBodyEvent();
    let r;
    try { r = JSON.parse(e.data); }
    catch (err) { console.error('SSE bad payload:', err); return; }
    handleOutputPayload(p, r);
  });
  es.addEventListener('end', e => {
    onBodyEvent();
    let r = {alive: false};
    try { r = JSON.parse(e.data); } catch (err) {}
    handleOutputPayload(p, r);
    closeStream(p);
  });
  es.onerror = () => {
    // EventSource auto-reconnects on transient errors; we let it for
    // a while, then escalate. If we never got a message at all, treat
    // it as "this transport doesn't work here" and switch to long-poll.
    if (!p.sseGotAnyMessage) {
      console.log('SSE: error before first event, falling back to long-poll');
      p.sseDisabled = true;
      closeStream(p);
      if (p.polling) pollOutput(p);
      return;
    }
    let d = nextRetryDelay(p);
    if (d < 0) { transportFatal(p, new Error('SSE reconnect budget exhausted')); return; }
    // EventSource will retry on its own ~3s; we just enforce the
    // total-elapsed budget. No need to schedule an explicit retry.
  };
}

function pollOutput(p) {
  if(!p.sid || !p.polling) return;
  api('output',{query:'&session_id='+p.sid}).then(r => {
    clearRetryClock(p);
    if (handleOutputPayload(p, r)) return;
    if(p.polling) pollOutput(p);
  }).catch(e => {
    let d = nextRetryDelay(p);
    if (d < 0) { transportFatal(p, e); return; }
    setTimeout(() => { if(p.polling) pollOutput(p) }, d);
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
//          conn_id?, persistent, slotId?, resume? }
// `resume` flag triggers attach-by-slot_id on the backend.
// Vault-backed panes (opts.conn_id or p.conn_id set) re-derive vault_key
// from IDB at every connect — caching it on the pane would let a
// sign-out in another tab leave a stale key in memory.
async function connectPane(p, opts) {
  p.label = opts.label || '';
  if (opts.host !== undefined) p.host = opts.host || '';
  if (opts.port !== undefined) p.port = opts.port || 22;
  if (opts.user !== undefined) p.user = opts.user || '';
  if (opts.connection !== undefined) p.connection = opts.connection || null;
  if (opts.auth !== undefined) p.auth = opts.auth || 'pw';
  if (opts.password !== undefined) p.password = opts.password || '';
  if (opts.key !== undefined) p.key = opts.key || '';
  if (opts.keyPass !== undefined) p.keyPass = opts.keyPass || '';
  if (opts.conn_id !== undefined) p.conn_id = opts.conn_id || null;
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

  let rec = paneRecord(p);
  if (rec && rec.via === 'vault') {
    try {
      rec.vault_id = await ensureVaultId();
      rec.vault_key = await exportRawVaultKey();
    } catch (e) {
      p.connecting = false;
      showErr('Vault key not available in this browser — re-enter to re-save.');
      updatePaneBadge(p);
      return;
    }
  } else if (rec) {
    // Manual / named: paneRecord intentionally strips plaintext from the
    // disk shape (kept in sessionStorage, see _setPaneSecret). Pass the
    // live in-memory credentials through to the body builder.
    rec.password = p.password || '';
    rec.key = p.key || '';
    rec.key_pass = p.keyPass || '';
  }
  let body = buildConnectBody(rec, p.term.cols, p.term.rows);
  if (opts.resume && p.slotId) body.resume_slot_id = p.slotId;

  if (body.vault_id) {
    console.log('connectPane: vault conn_id=' + body.conn_id +
                ' persistent=' + !!body.persistent);
  } else {
    console.log('connectPane: host=' + body.host + ' user=' + body.username +
                ' persistent=' + !!body.persistent +
                ' pw len=' + ((body.password || '').length) +
                ' key len=' + ((body.key || '').length));
  }

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
      // flushPaneResize uses p.term.cols/rows post-fit and updates
      // p.lastSent* so subsequent refit triggers can dedup.
      p.fitAddon.fit();
      flushPaneResize(p);
      startKeepalive(p);
      saveSessions();
      startOutput(p);
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
// title is "Connecting" by default).

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

  // Persistent panes used to run a tmux-presence probe here (separate
  // bg SSH session + MOTD-drain wait). It added ~2.5 s of latency and
  // duplicated work the reactive showTmuxBar fallback already does
  // post-connect when a "tmux not found" message arrives. Removed.
  // Users with non-default tmux locations need to either symlink to
  // PATH on the target or configure the connection via server-side
  // websh.json.
  realConnect(opts, run).then(result => {
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
  // 80x24 and we /api/resize once the pane is materialised). When the
  // saved-variant fields are present, the body builder ships them
  // instead of host/password/etc — the server resolves the real
  // credentials from the vault.
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
    vault_id: opts.vault_id || null,
    conn_id:  opts.conn_id  || null,
    vault_key: opts.vault_key || null,
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
      if (/too many (connection attempts|active sessions|background sessions)/i.test(r.error)) {
        throw { kind: 'rate_limited', msg: r.error };
      }
      // Saved-variant /api/connect surfaces vault-specific errors:
      //   404 + "saved entry not found"
      //   400 + {error: "vault_decrypt_failed"}
      //   501 + "credential vault unavailable…"
      // Status code is opaque to api() (always parses JSON), so we
      // pattern-match the strings.
      if (/saved entry not found/i.test(r.error)) {
        throw { kind: 'vault_not_found', msg: r.error };
      }
      if (r.error === 'vault_decrypt_failed') {
        throw { kind: 'vault_decrypt', msg: r.error };
      }
      if (/credential vault unavailable/i.test(r.error)) {
        throw { kind: 'vault_off', msg: r.error };
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
  // Plaintext SSH credentials live on the pane only for manual /
  // prompt-named modes. We mirror them into sessionStorage so F5 within
  // the tab can restore without re-prompting; vault-backed panes carry
  // conn_id instead (their secrets live server-side).
  p.password = opts.password || '';
  p.key = opts.key || '';
  p.keyPass = opts.keyPass || '';
  p.conn_id = opts.conn_id || null;
  if (!p.conn_id) {
    _setPaneSecret(p.id, {
      password: p.password,
      key: p.key,
      key_pass: p.keyPass,
    });
  } else {
    _deletePaneSecret(p.id);
  }
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
  flushPaneResize(p);
  startKeepalive(p);
  saveSessions();
  startOutput(p);
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
  if (/too many (connection attempts|active sessions|background sessions)/i.test(msg)) {
    return {kind: 'rate_limited', host, user, msg};
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
    sub.textContent = 'Connecting to ' + host + '…';
    btn.textContent = 'Cancel';
  } else if (kind === 'auth_failed') {
    title.textContent = 'Authentication failed';
    sub.textContent = 'Could not log in to ' + host + '.';
    status.textContent = 'Check your password or key and try again.';
    status.className = 'tm-status err';
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
  } else if (kind === 'rate_limited') {
    title.textContent = 'Too many connection attempts';
    sub.textContent = 'Please wait and try again shortly.';
    if (ctx.msg) { status.textContent = ctx.msg; status.className = 'tm-status err'; }
    btn.textContent = 'OK';
  } else if (kind === 'vault_not_found') {
    title.textContent = 'Saved entry missing on server';
    sub.textContent = 'This card was deleted or the server vault was cleared.';
    status.textContent = 'Delete this card from the saved list, then re-enter to re-save.';
    status.className = 'tm-status err';
    btn.textContent = 'OK';
  } else if (kind === 'vault_decrypt') {
    title.textContent = 'Cannot decrypt this card';
    sub.textContent = 'The vault key in this browser does not match the stored blob.';
    status.textContent = 'Re-enter the credentials to re-save this connection.';
    status.className = 'tm-status err';
    btn.textContent = 'OK';
  } else if (kind === 'vault_off') {
    title.textContent = 'Vault is disabled on the server';
    sub.textContent = 'The server is not accepting saved credentials right now.';
    if (ctx.msg) { status.textContent = ctx.msg; status.className = 'tm-status err'; }
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
  document.title = label ? label + ' \u2014 websh' : 'websh \u2014 Lite but powerful web terminal';
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

// Non-blocking notification. `kind` is one of '', 'warn', 'err'. Used by
// background flows (e.g. /api/save failures) so the live terminal isn't
// interrupted but the user still sees what happened.
function showToast(message, kind) {
  let host = $('toastHost'); if (!host) return;
  let el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  host.appendChild(el);
  // Force layout, then add .on for the transition.
  void el.offsetWidth;
  el.classList.add('on');
  setTimeout(() => {
    el.classList.remove('on');
    setTimeout(() => { try { el.remove(); } catch(e){} }, 250);
  }, 5000);
}

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

// ── Vault primitives (IndexedDB + Web Crypto AES-GCM) ───────────────
// K (AES-256-GCM CryptoKey, extractable=true) and vault_id (128-bit
// base32) live in IndexedDB. extractable is required because the
// /api/connect handshake ships the raw key bytes — the IDB layer is
// not the confidentiality boundary; the absence of ciphertext blobs
// from the client is what closes the threat. See docs/encryption.md.

const IDB_NAME = 'websh_vault';
const IDB_STORE = 'kv';
const IDB_K_KEY = 'K';
const IDB_VAULT_ID_KEY = 'vault_id';

function _idbOpen() {
  return new Promise((resolve, reject) => {
    let req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _idbGet(key) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    let tx = db.transaction(IDB_STORE, 'readonly');
    let req = tx.objectStore(IDB_STORE).get(_idbScopedKey(key));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function _idbPut(key, value) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    let tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, _idbScopedKey(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function _idbDelete(key) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    let tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(_idbScopedKey(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// isolate_storage support: scope IDB keys by URL path the same way
// storageKey() scopes localStorage. Two deployments on the same origin
// at different paths thus get independent vault keys + vault_ids.
function _idbScopedKey(name) {
  return storagePrefix ? storagePrefix + name : name;
}

// 26-char Crockford-style base32 of 128 random bits. Matches the
// server's _VAULT_ID_RE / _CONN_ID_RE: ^[A-Z2-7]{26}$.
const _B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function _generateBase32Id() {
  let bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  let acc = 0, accBits = 0;
  for (let b of bytes) {
    acc = (acc << 8) | b;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      s += _B32_ALPHA[(acc >> accBits) & 0x1f];
    }
  }
  if (accBits > 0) s += _B32_ALPHA[(acc << (5 - accBits)) & 0x1f];
  return s;  // 26 chars
}

let _vaultIdCache = null;
let _vaultKeyCache = null;  // CryptoKey
let _vaultFirstSave = false;  // set when ensureVaultId generates a new id

async function ensureVaultId() {
  if (_vaultIdCache) return _vaultIdCache;
  let id = await _idbGet(IDB_VAULT_ID_KEY);
  if (!id) {
    id = _generateBase32Id();
    await _idbPut(IDB_VAULT_ID_KEY, id);
    _vaultFirstSave = true;
  }
  _vaultIdCache = id;
  return id;
}

async function ensureVaultKey() {
  if (_vaultKeyCache) return _vaultKeyCache;
  let key = await _idbGet(IDB_K_KEY);
  if (!key) {
    key = await crypto.subtle.generateKey(
      {name: 'AES-GCM', length: 256},
      true,                              // extractable — connect ships raw bytes
      ['encrypt', 'decrypt']);
    await _idbPut(IDB_K_KEY, key);
  }
  _vaultKeyCache = key;
  _idbHasKeyCache = true;  // K is present, sync-readable for renderSaved
  return key;
}

async function exportRawVaultKey() {
  let key = await ensureVaultKey();
  let raw = await crypto.subtle.exportKey('raw', key);
  return _bufToB64(raw);
}

function _bufToB64(buf) {
  let bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function _b64ToBytes(b64) {
  let s = atob(b64);
  let bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function encryptCredentials(plaintext, conn_id) {
  let vault_id = await ensureVaultId();
  let key = await ensureVaultKey();
  // GCM IV reuse under the same key is catastrophic; draw a fresh
  // 12-byte IV on every encrypt. See docs/encryption.md.
  let iv = crypto.getRandomValues(new Uint8Array(12));
  let aad = new TextEncoder().encode(vault_id + ':' + conn_id);
  let pt = new TextEncoder().encode(JSON.stringify(plaintext));
  let ct = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: aad}, key, pt);
  return {iv: _bufToB64(iv), ct: _bufToB64(ct), vault_id};
}

async function decryptCredentials(iv_b64, ct_b64, conn_id) {
  let vault_id = await ensureVaultId();
  let key = await ensureVaultKey();
  let aad = new TextEncoder().encode(vault_id + ':' + conn_id);
  let pt = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: _b64ToBytes(iv_b64), additionalData: aad},
    key, _b64ToBytes(ct_b64));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Fresh conn_id for a new saved card. Same alphabet/length as
// vault_id; the server validates with the same regex.
function generateConnId() { return _generateBase32Id(); }

// Cross-tab signalling. localStorage 'storage' events cover the
// saved-card list (any tab editing websh_connections fires in every
// other tab). IDB / sign-out are out-of-band, so we also open a
// BroadcastChannel where signedOut signals invalidate the other tab's
// in-memory caches. Both layers degrade gracefully — when
// BroadcastChannel is absent the user just won't see immediate
// invalidation in the second tab, and the next render after a manual
// refresh picks up the wipe.
let _vaultBroadcast = null;
function _initVaultBroadcast() {
  if (typeof BroadcastChannel === 'undefined' || _vaultBroadcast) return;
  try {
    _vaultBroadcast = new BroadcastChannel('websh_vault');
    _vaultBroadcast.onmessage = (e) => {
      if (!e || !e.data) return;
      if (e.data.type === 'signed_out') {
        invalidateVaultCache();
        renderSaved();
      }
    };
  } catch (e) { _vaultBroadcast = null; }
}
function _broadcastSignedOut() {
  if (!_vaultBroadcast) return;
  try { _vaultBroadcast.postMessage({type: 'signed_out'}); } catch (e) {}
}

window.addEventListener('storage', (e) => {
  if (!e || !e.key) return;  // localStorage.clear() fires with key=null
  if (e.key === storageKey('websh_connections')) {
    // The other tab edited the saved-card list (delete, sign-out
    // wipe, fresh save). Refresh the visible list in this tab so we
    // don't show a stale row that's been removed elsewhere.
    renderSaved();
  }
});

// Sync-readable mirror of "is K present in IDB?". renderSaved checks
// this to gray out vault-backed rows that can no longer connect
// (Safari ITP cleared IDB after 7 days, user wiped site data, etc).
// Refreshed from loadServerConfig at boot, after save / sign-out
// (which know they just touched IDB), and on the storage / vault
// BroadcastChannel events (Task 11).
let _idbHasKeyCache = false;
async function _refreshIdbHasKey() {
  try { _idbHasKeyCache = !!(await _idbGet(IDB_K_KEY)); }
  catch (e) { _idbHasKeyCache = false; }
  return _idbHasKeyCache;
}

// Invalidate in-memory caches without touching IDB. Used when another
// tab signs out, when sign-out completes locally, and when /api/config
// reports the vault has been disabled out from under us.
function invalidateVaultCache() {
  _vaultIdCache = null;
  _vaultKeyCache = null;
  _idbHasKeyCache = false;
}

// Toggle vault-on / vault-off on <html> based on the server's
// /api/config response. Elements with class="vault-only" are hidden
// while the vault is off (server lacks cryptography, WEBSH_VAULT_ENABLE
// isn't set, schema version unsupported, or just before /api/config
// returns). Default in the HTML is vault-off — no flash of a "Save"
// affordance the server can't honor.
function _applyVaultEnabledClass() {
  let on = !!(serverConfig && serverConfig.vault_enabled);
  document.documentElement.classList.toggle('vault-on', on);
  document.documentElement.classList.toggle('vault-off', !on);
}

// ── Saved connections (localStorage) ────────────────────────────────
// Post-vault shape: {name, conn_id, host, port, user, auth, persistent,
// tmux_cmd?, connection?}. No `pass` / `key` fields — secrets live in
// the server-side vault under `conn_id`. Legacy entries with `pass` /
// `key` are tolerated (read-only) until the user acks the
// legacy-plaintext banner, which drops those fields.
function loadSaved() { try{return JSON.parse(localStorage.getItem(storageKey('websh_connections'))||'[]')}catch(e){return[]} }
function saveSaved(list) { localStorage.setItem(storageKey('websh_connections'),JSON.stringify(list)) }

// Heuristic for the "(key)" badge: trust `c.auth` first; fall back to
// the legacy `c.key` truthy-check for pre-vault rows that don't carry
// an explicit auth tag.
function _entryUsesKey(c) {
  if (c.auth) return c.auth === 'key';
  return !!c.key;
}

// Detect rows from before the vault shipped — they still carry the
// plaintext password or key inline. Used to surface a one-time banner
// (next paragraph) so the user can drop the plaintext consciously
// rather than have it silently linger.
function _hasLegacyPlaintext() {
  return loadSaved().some(c => c.pass || c.key);
}

// Show the legacy-plaintext banner if any saved-card row still carries
// `pass` or `key`. On Ack we strip those two fields from every row —
// the rest (name, host, port, user, auth, persistent) survives so the
// user can identify the entry and re-save it under the vault. We do
// NOT silently re-encrypt: the original plaintext may live in
// browser-history sync or profile backups.
function _maybeShowLegacyBanner() {
  let banner = $('legacyBanner'); if (!banner) return;
  if (!_hasLegacyPlaintext()) { banner.classList.add('h'); return; }
  banner.classList.remove('h');
  let ack = $('legacyBannerAck');
  if (ack && !ack._wired) {
    ack._wired = true;
    ack.onclick = () => {
      let cleaned = loadSaved().map(c => {
        let copy = Object.assign({}, c);
        delete copy.pass;
        delete copy.key;
        return copy;
      });
      saveSaved(cleaned);
      banner.classList.add('h');
      renderSaved();
    };
  }
}

function renderSaved() {
  let list=loadSaved(), el=$('savedList');
  el.innerHTML='';
  $('divider').querySelector('span').textContent=list.length?'Or connect manually':'Connect';
  list.forEach((c,i) => {
    // A vault-backed row is unusable when the browser's IDB key is gone
    // (Safari ITP eviction, user wiped site data, sign-out in another
    // tab). We mark it .nokey so CSS grays it out, and the click
    // handler routes to the bulk-delete path instead of connect.
    let nokey = !!(c.conn_id && !_idbHasKeyCache);
    let div=document.createElement('div');
    div.className = 'sv' + (nokey ? ' nokey' : '');
    div.setAttribute('data-idx', i);
    let suffix = _entryUsesKey(c) ? ' (key)' : '';
    let nokeyTag = nokey ? ' <span class="sv-kind sv-nokey" title="No vault key in this browser — cannot connect; delete to clean up">no key</span>' : '';
    div.innerHTML=
      `<div class="sv-info"><div class="sv-name">${esc(c.name)}</div>`+
      `<div class="sv-host">${esc(c.user)}@${esc(c.host)}:${c.port}${suffix}${nokeyTag}</div></div>`+
      `<div class="sv-actions"><button class="sv-btn del" data-idx="${i}">Delete</button></div>`;
    el.appendChild(div);
  });
  el.onclick=e => {
    if(e.target.classList.contains('del')){
      let idx = parseInt(e.target.getAttribute('data-idx'));
      let c = list[idx];
      if (c && c.conn_id) {
        // Vault-backed: best-effort tell the server to drop its blob.
        // We don't await — local removal proceeds even if the server
        // is unreachable.
        _bulkDeleteVaultEntry(c).catch(() => {});
      }
      list.splice(idx, 1); saveSaved(list); renderSaved();
      return;
    }
    let row=e.target.closest('.sv'); if(!row) return;
    let idx=parseInt(row.getAttribute('data-idx')); if(isNaN(idx)) return;
    let c = list[idx];
    if (c && c.conn_id && !_idbHasKeyCache) {
      // No-key state: the row's click target is delete, not connect.
      _bulkDeleteVaultEntry(c).catch(() => {});
      list.splice(idx, 1); saveSaved(list); renderSaved();
      return;
    }
    connectSaved(c);
  };
}

// Fire-and-forget DELETE /api/save for a vault-backed entry. The PHP
// proxy translates `?action=save_delete` POST into a backend DELETE.
async function _bulkDeleteVaultEntry(c) {
  if (!c || !c.conn_id) return;
  let vault_id;
  try { vault_id = await ensureVaultId(); }
  catch (e) {
    // If IDB itself is broken we can't recover vault_id; bail silently
    // — local list removal still proceeds in the caller.
    return;
  }
  let q = '&vault_id=' + encodeURIComponent(vault_id) +
          '&conn_id='  + encodeURIComponent(c.conn_id);
  // body:{} forces POST through api(); empty body is fine, PHP proxy
  // routes by ?action= regardless of body content.
  await api('save_delete', {query: q, body: {}});
}

async function connectSaved(c) {
  hideErr();
  let label = c.name || (c.user + '@' + c.host);
  // New-shape rows carry a conn_id and use the saved-variant
  // /api/connect — the server fetches host/port/username from the
  // vault record, browser supplies vault_key. Legacy rows (still
  // carrying c.pass / c.key in localStorage from before the vault
  // shipped) keep the old manual-mode flow so they continue to work
  // until the user acks the legacy banner or re-saves.
  if (c.conn_id) {
    let vault_key, vault_id;
    try {
      vault_id = await ensureVaultId();
      vault_key = await exportRawVaultKey();
    } catch (e) {
      showToast('No vault key in this browser — re-enter to re-save this connection.', 'err');
      return;
    }
    runConnect({
      label: label,
      vault_id: vault_id,
      conn_id: c.conn_id,
      vault_key: vault_key,
      // host/port/user are display hints for the connect popup; the
      // server derives the real values from the stored vault record.
      host: c.host, port: c.port || 22, user: c.user,
      persistent: c.persistent !== false,
      slotId: null,
      tmuxCmd: c.tmux_cmd || 'tmux',
    });
    return;
  }
  // Auto-match legacy entries (saved before we tagged with connection name)
  // to a config entry by host:port so they still work under restrict_hosts.
  let connName = c.connection;
  if (!connName && serverConfig && serverConfig.connections) {
    let m = serverConfig.connections.find(e => e.host === c.host && e.port === c.port);
    if (m) connName = m.name;
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
  // connect is confirmed stable (no auth failure, still alive). Note:
  // saved entries from earlier versions may carry tmux_cmd from the
  // probe era; that field still flows through buildConnectBody for
  // backward compatibility, but new entries don't capture it.
  let saveEntry = null;
  if ($('iSave').checked && serverConfig && serverConfig.vault_enabled) {
    // Vault flow: the entry that lands in localStorage carries NO
    // secrets — `_pendingSecrets` is consumed by commitVaultSave once
    // the connection is healthy, encrypted, and successfully POSTed to
    // /api/save. The conn_id is minted at commit-time. If vault_enabled
    // is false (UI hidden anyway by Task 2 CSS), no save path runs at
    // all — we deliberately don't fall back to plaintext localStorage.
    saveEntry = {name: label, host: host, port: port, user: username,
                 auth: authMode, persistent: wantPersistent,
                 _pendingSecrets: {
                   password: authMode === 'pw' ? password : null,
                   key:      authMode === 'key' ? key      : null,
                   key_pass: authMode === 'key' ? $('iKeyPw').value : null,
                 }};
    if (selectedPrompt) saveEntry.connection = selectedPrompt.name;
  }
  let opts = {
    label: label,
    host: host, port: port, user: username,
    connection: selectedPrompt ? selectedPrompt.name : null,
    auth: authMode,
    persistent: wantPersistent,
    slotId: null,
    tmuxCmd: 'tmux',
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
  api('config').then(async cfg => {
    serverConfig=cfg;
    if(cfg.isolate_storage) storagePrefix = location.pathname.replace(/[^/]*$/, '');
    _applyVaultEnabledClass();
    _maybeShowLegacyBanner();
    // Pre-cache the IDB key presence so the first renderSaved doesn't
    // flash all vault-backed rows as no-key while we wait on IDB.
    await _refreshIdbHasKey();
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

// ── Zoom ────────────────────────────────────────────────────────────
// Hotkey zoom uses forceFlush:false so a held-key autorepeat (~30Hz)
// doesn't fire one /api/resize POST per tick. The 150ms term.onResize
// debounce coalesces the burst — 30 keystrokes → 1 POST 150ms after
// release. Trade-off: the server learns the new size 150ms late, so
// any shell output during that window may be wrapped at the old cols.
// On a quiet terminal this is invisible; on a streaming command (top,
// tail -f) the user sees one stale row. Acceptable for a hotkey burst
// that, by definition, the user is mid-tweaking anyway.
function zoomIn(){ settings.fontSize=Math.min(settings.fontSize+2,32); fontSize=settings.fontSize; saveSettings(); applySettings({forceFlush:false}); }
function zoomOut(){ settings.fontSize=Math.max(settings.fontSize-2,8); fontSize=settings.fontSize; saveSettings(); applySettings({forceFlush:false}); }
// Cancel any pending /api/resize debounce and post the current xterm
// dimensions to the server immediately. Used after a programmatic
// refit when we want the server to learn the new geometry without the
// 150ms debounce window in term.onResize.
//
// Dedup guard: skip the POST when (cols,rows) matches the last value
// the server has confirmed receiving. Two real cases hit this:
//   - fitPaneWhenStable iterates the settle loop up to 8 times — once
//     cols stops changing the final flushPaneResize would re-POST the
//     same value the last successful iteration already sent.
//   - held Ctrl+= autorepeat past the fontSize cap (32) — fontSize
//     stops changing, dims stop changing, every additional keystroke
//     would otherwise re-POST the same value 30 times/sec.
//
// Commit-on-success: lastSentCols/Rows are updated only after the POST
// resolves cleanly. Network failure (rejection), business error (e.g.
// 404 session not found), or any non-JSON response leaves lastSent
// untouched, so the next refit will retry against the actual server
// state. Without this discipline, a swallowed POST failure silently
// desynced client and server until the user happened to resize to a
// DIFFERENT value — exactly the right-edge-overflow class of bug
// commit 7738ed1 was meant to eliminate.
function flushPaneResize(p) {
  if (!p || !p.sid) return;
  let cols = p.term.cols, rows = p.term.rows;
  if (p.lastSentCols === cols && p.lastSentRows === rows) return;
  if (p.resizeTimer) { clearTimeout(p.resizeTimer); p.resizeTimer = null; }
  api('resize', {body: {session_id: p.sid, cols: cols, rows: rows}})
    .then(r => {
      if (r && r.error) return;
      p.lastSentCols = cols;
      p.lastSentRows = rows;
    })
    .catch(() => { /* leave lastSent alone so the next refit retries */ });
}

// applySettings(opts):
//   forceFlush=true  (default — discrete user intent: zoom hotkey,
//                     reset, font select)  → bypass term.onResize
//                     150ms debounce, post /api/resize immediately.
//   forceFlush=false (continuous input: slider drag in Options)
//                     → let the existing term.onResize debounce
//                     coalesce a burst of mutations into one POST.
//
// Why the RAF: xterm v5's CharSizeService measures cell width
// synchronously when fontSize changes (offsetWidth forces a layout),
// so xterm itself is not the cause of stale cols. The bug we fix is
// (a) webfont rasterisation lag — for a webfont not yet rendered at
// the new size, the glyph metric the browser hands to xterm can lag
// the visible glyph by one frame; and (b) applySettings mutates five
// options back-to-back (fontSize, fontWeight, fontWeightBold,
// lineHeight, fontFamily) and each one re-fires the measure cascade.
// One animation frame after the last mutation, layout has settled and
// the webfont is laid out at its new size, so fit() reads stable
// metrics and proposeDimensions returns the correct cols.
function applySettings(opts){
  opts = opts || {};
  let forceFlush = opts.forceFlush !== false;
  let stack = fontStack(settings.font);
  Object.keys(panes).forEach(k => {
    let p = panes[k];
    let t = p.term;
    t.options.fontSize = settings.fontSize;
    t.options.fontWeight = settings.fontWeight;
    t.options.fontWeightBold = Math.min(900, settings.fontWeight + 300);
    t.options.lineHeight = settings.lineHeight;
    if (t.options.fontFamily !== stack) t.options.fontFamily = stack;
    // Single fit path: the settle loop inside fitPaneWhenStable does
    // both the font-load wait AND the multi-frame convergence check,
    // replacing the old "immediate-RAF fit AND a deferred refit after
    // document.fonts.load" pair that was racing.
    fitPaneWhenStable(p, { flush: forceFlush });
  });
}
// Refit a pane with a font-load gate and a settle loop.
//
// Why a settle loop (not just one RAF deferral): the previous version
// did `document.fonts.load → fontFamily round-trip → 1 × RAF → fit`.
// That works most of the time, but on slow renderers (low-end mobile,
// throttled background tabs, or parallel font-face loads) the cycle
// `JS → style recalc → layout → paint` does not always complete in
// one animation frame. `document.fonts.load(...)` resolves once the
// FontFace is registered, NOT once it has been applied to the
// measurement <span> xterm uses for CharSizeService — that
// application happens on the next style/layout pass. Result: fit
// reads a cell-width that was computed with the fallback font, cols
// is wrong, glyphs render with the (wider) webfont and overflow the
// pane on the right, selection drifts by one cell. The only reliable
// signal we have for "the cell-width xterm now caches is the one it
// will use to render" is: two consecutive fits return the same cols.
// So we iterate fit-once-per-RAF until cols stabilises (or hit a
// safety cap of 8 attempts — at most ~130 ms total, imperceptible).
function fitPaneWhenStable(p, opts){
  if (!p || !panes[p.id] || !p.fitAddon) return;
  // Re-entry guard: settle-loop forceMeasure() and the fontFamily
  // round-trip both cause xterm to fire its own change events. If a
  // second fitPaneWhenStable call races in before the first finishes
  // (watchdog tick, settings change, any future event-driven caller),
  // they pile up async Promises that each trigger the same xterm
  // chain, exponentially saturating the event loop. Skip cleanly —
  // the in-flight call will land on the latest values anyway.
  if (p._fitInFlight) return;
  p._fitInFlight = true;
  // Stuck-timer safety. If the font load hangs (CDN unreachable,
  // captive portal, document.fonts.ready waiting on an unrelated
  // never-completing face) the flag would stay true forever and every
  // subsequent fitPaneWhenStable call — including the 1 s watchdog —
  // would silently bail. After 10 s, force-release the flag; the
  // settle-loop checks p._fitInFlight at every iteration and exits
  // cleanly if the timer fired mid-flight (no double-fit, no leak).
  // Store the handle on `p` so _destroyPane can cancel it. Without that,
  // a pane closed mid-settle keeps the timer's closure-captured `p`
  // alive for up to 10 s.
  let stuckTimer = setTimeout(() => {
    p._fitInFlight = false;
    p._stuckTimer = null;
  }, 10000);
  p._stuckTimer = stuckTimer;
  let shouldFlush = !opts || opts.flush !== false;
  let onSettled = (opts && opts.onSettled) || null;
  let release = () => {
    clearTimeout(stuckTimer);
    if (p._stuckTimer === stuckTimer) p._stuckTimer = null;
    p._fitInFlight = false;
  };
  let f = FONTS[settings.font];
  let webfont = f && f[1];
  // `document.fonts.load(spec)` actively triggers the load AND resolves
  // when that face is registered. Chaining `document.fonts.ready` adds
  // a global "all currently-loading fonts done" gate — needed because
  // load(spec) resolves before the FontFace is applied to any laid-out
  // <span>, and we measure via offsetWidth which depends on layout.
  let waitFont = (webfont && document.fonts && document.fonts.load)
    ? document.fonts.load(
        `${settings.fontWeight} ${settings.fontSize}px '${webfont}'`)
        .then(() => document.fonts.ready)
    : Promise.resolve();
  waitFont.then(() => {
    if (!p._fitInFlight || panes[p.id] !== p) { release(); return; }
    // Invalidate xterm's CharSizeService cache via a no-op fontFamily
    // round-trip. xterm v5's options setter has a value-equality
    // short-circuit (`rawOptions[k] !== v && fire(k)`), so the
    // intermediate value MUST differ from the original — otherwise
    // both setters get filtered out and no re-measure happens. Pair
    // the canonical fallback families ('monospace' / 'serif') so the
    // sentinel is guaranteed to differ from the user's actual stack.
    let ff = p.term.options.fontFamily;
    let invalidator = (ff === 'monospace' ? 'serif' : 'monospace');
    p.term.options.fontFamily = invalidator;
    p.term.options.fontFamily = ff;
    // Belt-and-suspenders: directly invoke xterm's internal measurement
    // service. The options round-trip is supposed to trigger this via
    // its options-change listener, but the actual measure() reads
    // offsetWidth from a hidden <span> that must have been laid out
    // with the new font face. Calling it again from each settle
    // iteration guarantees the cached width can't pin the loop at a
    // wrong-cols fixed point.
    let forceMeasure = () => {
      try { p.term._core._charSizeService.measure(); } catch(e){}
    };
    // Settle loop: fit, observe cols, fit again next frame until two
    // consecutive iterations agree, or we hit the cap of 8 attempts
    // (~130 ms total, imperceptible).
    let attempts = 0, lastCols = -1;
    let step = () => {
      if (!p._fitInFlight || panes[p.id] !== p) { release(); return; }
      forceMeasure();
      try { p.fitAddon.fit(); } catch(e){}
      let cols = p.term.cols;
      if (cols === lastCols || attempts >= 8) {
        release();
        if (shouldFlush) flushPaneResize(p);
        if (onSettled) onSettled(p);
        return;
      }
      lastCols = cols;
      attempts++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }).catch(() => { release(); });
}

// Periodic drift watchdog. Even with the settle loop, edge cases can
// leave a pane with a cached cell-width that disagrees with what xterm
// actually renders: a webfont may finish loading well after every
// fit-triggering event fired, or a re-measure may have been called
// before layout applied the new font face. Once every PANE_DRIFT_*
// interval, compare what xterm thinks it can fit (cols × cellWidth)
// against the parent container's actual content area. If the visible
// glyphs overflow by more than a few sub-pixel-rounding pixels — or
// underflow by a full cell — trigger a settle-loop fit to correct it.
const PANE_DRIFT_CHECK_MS = 1000;
const PANE_DRIFT_TOLERANCE_PX = 3;
// Named so the tick can be invoked synchronously from tests against
// stubbed getComputedStyle / charSizeService. Returns true when the
// drift crossed a refit threshold (negative past tolerance, or
// positive over one cell + tolerance), false otherwise. Catches any
// xterm-internals reshuffle and bails quietly.
function _driftWatchdogTick(p) {
  if (!p || !p.term || !p.term.element || !p.term.element.parentElement) {
    return false;
  }
  try {
    let cs = p.term._core && p.term._core._charSizeService;
    if (!cs || !cs.width) return false;
    let parent = p.term.element.parentElement;
    let parentCss = window.getComputedStyle(parent);
    let parentWidth = parseInt(parentCss.getPropertyValue('width'), 10);
    let elCss = window.getComputedStyle(p.term.element);
    let pad = parseInt(elCss.getPropertyValue('padding-left'), 10)
            + parseInt(elCss.getPropertyValue('padding-right'), 10);
    let available = parentWidth - pad;
    let rendered = p.term.cols * cs.width;
    let drift = available - rendered;
    // Negative drift (rendered > available) is the user-visible bug:
    // right-edge glyphs spill past the pane. Tolerate a few pixels of
    // sub-pixel rounding. Positive drift over one cell means we're
    // wasting a column of space — also worth a refit.
    if (drift < -PANE_DRIFT_TOLERANCE_PX
        || drift > cs.width + PANE_DRIFT_TOLERANCE_PX) {
      fitPaneWhenStable(p);
      return true;
    }
  } catch (e) { /* xterm internals shifted — bail quietly */ }
  return false;
}

setInterval(() => {
  // Skip when no panes are open — no panes means no terminals to fit,
  // and getComputedStyle / Object.values churn every second is silly.
  if (!Object.keys(panes).length) return;
  Object.values(panes).forEach(_driftWatchdogTick);
}, PANE_DRIFT_CHECK_MS);

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
  let cc = $('optTmuxClipboard'); if (cc) cc.checked = !!settings.tmuxClipboard;
  let ch = $('optTmuxHistory'); if (ch) ch.value = settings.tmuxHistory;
  renderOptPreview();
  $('ovOpt').classList.remove('h');
}
function closeOptions(){ $('ovOpt').classList.add('h'); }

// ── Sign out of this browser ────────────────────────────────────────
// Permanently deletes every saved credential in this vault from the
// server and clears the key in this browser. Typed-DELETE confirm
// gate because the action is irreversible.
function openSignOutModal() {
  let input = $('signOutInput');
  let confirm = $('signOutConfirm');
  let status = $('signOutStatus');
  if (input) input.value = '';
  if (confirm) confirm.disabled = true;
  if (status) { status.textContent = ''; status.className = 'tm-status'; }
  if (input && !input._wired) {
    input._wired = true;
    input.addEventListener('input', () => {
      let ok = input.value === 'DELETE';
      if (confirm) confirm.disabled = !ok;
    });
  }
  $('signOutModal').classList.remove('h');
  setTimeout(() => { try { input && input.focus(); } catch(e){} }, 0);
}

function closeSignOutModal() {
  $('signOutModal').classList.add('h');
}

async function confirmSignOut() {
  let confirm = $('signOutConfirm');
  let status = $('signOutStatus');
  if (confirm) confirm.disabled = true;
  if (status) { status.textContent = 'Deleting saved credentials…'; status.className = 'tm-status'; }
  // Best-effort: tell the server to drop each blob in this vault. We
  // continue on per-row failure (404/network) — the local wipe still
  // happens, and the orphaned server-side blob (if any) is just a
  // namespace squat with no plaintext leak.
  let vault_id = null;
  try { vault_id = await ensureVaultId(); } catch (e) {}
  let list = loadSaved();
  for (let c of list) {
    if (!vault_id || !c.conn_id) continue;
    let q = '&vault_id=' + encodeURIComponent(vault_id) +
            '&conn_id='  + encodeURIComponent(c.conn_id);
    try { await api('save_delete', {query: q, body: {}}); } catch (e) {}
  }
  // Local wipe: IDB (K + vault_id), saved-card list, pane-secrets.
  try { await _idbDelete(IDB_K_KEY); } catch (e) {}
  try { await _idbDelete(IDB_VAULT_ID_KEY); } catch (e) {}
  saveSaved([]);
  try { sessionStorage.removeItem(storageKey(SS_PANE_SECRETS_KEY)); } catch (e) {}
  invalidateVaultCache();
  _broadcastSignedOut();
  closeSignOutModal();
  renderSaved();
  showToast('Signed out. All saved credentials in this browser have been removed.', '');
}
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
  // Slider 'input' fires per pixel of mouse movement — let the existing
  // 150ms term.onResize debounce coalesce the burst into a single
  // /api/resize POST instead of force-flushing on every step.
  applySettings({forceFlush: false});
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
  let cc = $('optTmuxClipboard'), ch = $('optTmuxHistory');
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

// SELECTION_TRIM: defer the focus restore on every drag-blurred pane.
// Between mouseup and tmux's drag-end processing (copy-pipe-and-cancel
// → cursor returns to the shell prompt) there's a ~50–200ms window
// where the cursor still sits at end-of-orange. Calling focus()
// immediately would paint the cursor bar back on that cell — the exact
// "dim symbol after the orange" we set out to fix. So we hook xterm's
// onCursorMove (tmux moving the cursor back is the signal that copy-
// mode is gone) and restore focus then. Fallback timer for sessions
// where the cursor doesn't move on its own (raw shell, no tmux).
// Click-without-drag panes restore immediately and skip the trim arm.
document.addEventListener('mouseup', () => {
  Object.keys(panes).forEach(id => {
    let p = panes[id];
    if (!p || !p._dragBlurred) return;
    if (!p._dragMoved) {
      // Bare click — no drag, no trim window, no defer.
      // Clear any stale trim timestamp from a recent drag, otherwise a
      // programmatic OSC 52 firing within DRAG_TRIM_WINDOW_MS of the
      // earlier drag would still be trimmed even though the user has
      // since just clicked.
      p._recentDragSelectAt = 0;
      _restorePaneFromDrag(p);
      return;
    }
    p._recentDragSelectAt = Date.now();
    // Defensive: cancel any stale subscription/timer from a prior drag.
    _cancelDragBlurArm(p);
    let restore = () => _restorePaneFromDrag(p);
    try { p._selDisp = p.term.onCursorMove(restore); } catch(e){}
    p._selTimer = setTimeout(restore, POST_DRAG_HIDE_FALLBACK_MS);
  });
});

// If the window loses focus mid-drag (Alt-Tab, click another window),
// the mouseup may never reach us. Treat blur as a drag-end signal so
// `.dragBlurred` panes don't stay stuck without their cursor.
window.addEventListener('blur', () => {
  Object.keys(panes).forEach(id => {
    let p = panes[id];
    if (p && p._dragBlurred) _restorePaneFromDrag(p);
  });
});

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

  let missingCreds = 0;
  Object.keys(m.panes).forEach(oldId => {
    let rec = m.panes[oldId];
    let p = restored[oldId];
    if (!p || !rec) return;
    // `via` is set by paneRecord post-vault; legacy v2 records without
    // via are treated as manual (their plaintext is in password/key
    // inline, which connectPane consumes once and saveSessions will
    // overwrite with the new shape on the next save).
    // Plaintext for manual / prompt-named panes lives in sessionStorage
    // (Task 7). Legacy v2 records carry password / key inline; we
    // prefer sessionStorage when present, fall back to legacy fields,
    // and finally surface a toast if both are empty for a non-vault
    // pane that needs creds at connect time.
    let secrets = _getPaneSecret(oldId);
    let password = (secrets && secrets.password) || rec.password || '';
    let key      = (secrets && secrets.key)      || rec.key      || '';
    let keyPass  = (secrets && secrets.key_pass) || rec.key_pass || '';
    let isVault  = !!rec.conn_id;
    let isReady  = rec.via === 'named' && !password && !key;
    // Manual mode (free-form host) needs credentials; prompt-named
    // panes do too. Ready-kind named panes connect with no body creds
    // (server has them in websh.json), so missing-cred toast doesn't
    // apply to those — but we have no kind on the client, so treat
    // empty named entries as "server provides" (`isReady` above).
    if (!isVault && !isReady && !password && !key) {
      missingCreds++;
    }
    connectPane(p, {
      label: rec.label, host: rec.host, port: rec.port, user: rec.user,
      connection: rec.connection, auth: rec.auth,
      password: password, key: key, keyPass: keyPass,
      conn_id: rec.conn_id,
      persistent: rec.persistent, slotId: rec.slot_id,
      tmuxCmd: rec.tmux_cmd || 'tmux',
      resume: !!rec.persistent
    });
  });
  if (missingCreds > 0) {
    showToast(missingCreds + ' pane' + (missingCreds === 1 ? ' was' : 's were') +
              ' restored without saved credentials. Open the login form to re-enter.',
              'warn');
  }
  return true;
}

// ── Init ────────────────────────────────────────────────────────────
// One-time cleanup: theme toggle was dropped (single dark theme now),
// so the legacy `websh_theme` key from users who flipped the toggle
// before the change is an orphan. Remove it once so a fresh devtools
// pass on a returning user's browser doesn't show stray entries.
try { localStorage.removeItem('websh_theme'); } catch(e){}

// Open the vault BroadcastChannel early so a sign-out fired in another
// tab during loadServerConfig still gets observed by this tab.
_initVaultBroadcast();

// No pane is created eagerly. loadServerConfig drives next step:
// either tryRestoreSessions rebuilds the saved layout, or overlayMode is
// set to 'initial' and the user sees the login form on an empty canvas.
loadServerConfig();
renderSaved();
focusFirst();
