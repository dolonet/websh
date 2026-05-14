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

test('saved-card connect: 404 saved-entry-not-found surfaces vault_not_found popup', async () => {
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

test('saved-card connect: 400 vault_decrypt_failed surfaces vault_decrypt popup', async () => {
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

test('saved-card connect: 501 credential-vault-unavailable surfaces vault_off popup', async () => {
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
  ok(p.pendingSave._pendingSecrets && p.pendingSave._pendingSecrets.password === 'hunter2',
     '_pendingSecrets carry the password');
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
  ok(!list[0].pass && !list[0].key && !list[0]._pendingSecrets,
     'no secrets / _pendingSecrets in localStorage entry');
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
  // key blob (no auth tag). Until the legacy banner drops it, the row
  // must still render with the (key) badge so users can identify their
  // entries before re-saving.
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
