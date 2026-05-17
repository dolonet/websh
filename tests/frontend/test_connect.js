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
    }
    loadAddon() {} open() {} reset() {}
    focus() { this._focusCalls++; }
    blur() { this._blurCalls++; }
    write() {} dispose() {}
    onData() {} onBinary() {} onResize() {} onSelectionChange() {} onBell() {}
    onCursorMove(cb) {
      this._cursorMoveCbs.push(cb);
      let self = this;
      return { dispose() { self._cursorMoveCbs = self._cursorMoveCbs.filter(c => c !== cb); } };
    }
    _fireCursorMove() { this._cursorMoveCbs.slice().forEach(cb => cb()); }
    get buffer() { return {active: {length: 0, getLine: () => null}}; }
    get unicode() { return {activeVersion: '11'}; }
  };
  win.FitAddon = {FitAddon: class {
    activate() {} fit() {}
    proposeDimensions() { return {cols: 80, rows: 24}; }
  }};
  win.WebLinksAddon = {WebLinksAddon: class {}};
  win.Unicode11Addon = {Unicode11Addon: class {}};
  win.ResizeObserver = class { observe() {} disconnect() {} };
}

// Each plan entry: {action, match?, response, delay?, once?, fallthrough?}.
// `match` filters on the request body. `response` may be a function(body).
// `once` consumes the entry. `fallthrough` lets an unmatched entry fall
// through silently (used so we can register a "catch-all" last).
function makeFetch(plan, log) {
  return function(url, init) {
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
      return sleep(d).then(() => ({json: () => Promise.resolve(resp)}));
    }
    // Keep the test moving on unexpected actions (output polls after a
    // test's assertions have already run, for example).
    return sleep(1).then(() => ({json: () => Promise.resolve({alive: false})}));
  };
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
  makeFakes(win);
  win.fetch = makeFetch(plan, log);
  _injectVaultGlobals(win);
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(30);
  return {dom, win, log};
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
    env.dom.window.close();
  } catch(e) {}
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

// SELECTION_TRIM regression tests — three coupled mechanisms must stay
// aligned: (1) drag-blur on mousedown via term.blur(), (2) deferred
// term.focus() restore via onCursorMove + 500ms timer, (3) trimDragTail
// dropping the trailing tmux cursor-cell char from clipboard payloads.
test('SELECTION_TRIM: trimDragTail drops trailing char while drag-blurred', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                                connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  // Synthesize a minimal pane with the SELECTION_TRIM state fields.
  const p = { _dragBlurred: true, _recentDragSelectAt: 0 };
  ok(win.trimDragTail(p, 'abcd') === 'abc',
     'drops trailing char when _dragBlurred');
  // Length-≤1 short-circuit: never trim to empty.
  ok(win.trimDragTail(p, 'a') === 'a',
     'preserves single-char payloads (no trim to empty)');
  // Outside window AND not blurred → identity.
  p._dragBlurred = false;
  p._recentDragSelectAt = 0;
  ok(win.trimDragTail(p, 'abcd') === 'abcd',
     'no trim when neither blurred nor recently dragged');
  // Inside trim window → trim.
  p._recentDragSelectAt = Date.now() - 100;
  ok(win.trimDragTail(p, 'abcd') === 'abc',
     'trims inside DRAG_TRIM_WINDOW_MS');
  // Outside trim window → no trim.
  p._recentDragSelectAt = Date.now() - 5000;
  ok(win.trimDragTail(p, 'abcd') === 'abcd',
     'no trim outside DRAG_TRIM_WINDOW_MS');
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

test('SELECTION_TRIM: mousedown blurs xterm, mousemove sets _dragMoved', async () => {
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

test('SELECTION_TRIM: drag mouseup arms onCursorMove + timer; cursor-move restores focus', async () => {
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
  // After mouseup: still blurred (deferred), trim-window timestamp set,
  // disposer + timer armed.
  ok(p._dragBlurred === true, 'mouseup defers — still blurred');
  ok(p._recentDragSelectAt > 0, 'mouseup recorded _recentDragSelectAt');
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

test('SELECTION_TRIM: bare click (no movement) restores immediately, no trim arm', async () => {
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
  ok(p._recentDragSelectAt === 0,
     'no trim window arm for bare click (timestamp untouched)');
  cleanup(env);
});

test('SELECTION_TRIM: _destroyPane cancels pending onCursorMove subscription', async () => {
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
    `encryptCredentials(${JSON.stringify(payload)}, ${JSON.stringify(conn_id)})`);
  ok(typeof blob.iv === 'string' && blob.iv.length > 0, 'iv is base64 string');
  ok(typeof blob.ct === 'string' && blob.ct.length > 0, 'ct is base64 string');
  ok(/^[A-Z2-7]{26}$/.test(blob.vault_id), 'vault_id surfaced from encryptCredentials');
  // IV must be 12 bytes (base64 length ~16 with padding).
  const ivBytes = Buffer.from(blob.iv, 'base64');
  ok(ivBytes.length === 12, 'iv is 12 bytes; got ' + ivBytes.length);
  const recovered = await win.eval(
    `decryptCredentials(${JSON.stringify(blob.iv)}, ` +
    `${JSON.stringify(blob.ct)}, ${JSON.stringify(conn_id)})`);
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
    `encryptCredentials({password:'x'}, ${JSON.stringify(conn_id)})`);
  let threw = false;
  try {
    await win.eval(
      `decryptCredentials(${JSON.stringify(blob.iv)}, ` +
      `${JSON.stringify(blob.ct)}, ${JSON.stringify('E'.repeat(26))})`);
  } catch (e) { threw = true; }
  ok(threw, 'wrong conn_id rejects (AAD binding holds)');
  cleanup(env);
});

test('vault primitives: each save uses a fresh IV', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: [],
                                                vault_enabled: true}}];
  const env = await mkEnv(plan); const win = env.win;
  const conn_id = 'F'.repeat(26);
  // GCM IV reuse under the same key is catastrophic — must regenerate.
  const blob1 = await win.eval(`encryptCredentials({p:'a'}, ${JSON.stringify(conn_id)})`);
  const blob2 = await win.eval(`encryptCredentials({p:'a'}, ${JSON.stringify(conn_id)})`);
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
  domA.window.close(); domB.window.close();
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
  dom.window.close();
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
  dom.window.close();
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
  dom.window.close();
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
  dom.window.close();
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
  dom.window.close();
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
  dom.window.close();
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
(async () => {
  for (const s of scenarios) {
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
