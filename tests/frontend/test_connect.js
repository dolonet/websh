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
    constructor() { this.cols = 80; this.rows = 24; }
    loadAddon() {} open() {} focus() {} reset() {}
    write() {} dispose() {}
    onData() {} onBinary() {} onResize() {} onSelectionChange() {} onBell() {}
    get buffer() { return {active: {length: 0, getLine: () => null}}; }
    get unicode() { return {activeVersion: '11'}; }
  };
  win.FitAddon = {FitAddon: class {
    activate() {} fit() {}
    proposeDimensions() { return {cols: 80, rows: 24}; }
  }};
  win.SearchAddon = {SearchAddon: class {}};
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

async function mkEnv(plan) {
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                               url: 'http://localhost/websh/'});
  const win = dom.window;
  const log = [];
  makeFakes(win);
  win.fetch = makeFetch(plan, log);
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

test('persistent + no-tmux: popup, form open, no real-connect attempted', async () => {
  const probeOut = 'prompt$ \r\n__WEBSH_TMUX__:installed=no:cmd=\r\n';
  let outCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.background === true,
     response: {session_id: 'bg', alive: true}},
    {action: 'input', response: {ok: true}},
    {action: 'output', response: () => {
      outCalls++;
      if (outCalls === 1) return {data: '', alive: true};
      return {data: Buffer.from(probeOut).toString('base64'), alive: true};
    }},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'remote'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = true;
  win.doConnect();
  await sleep(3500);
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok($(win, 'tmTitle').textContent.indexOf('tmux not found') !== -1,
     'title mentions tmux not found, got: ' + $(win, 'tmTitle').textContent);
  ok($(win, 'tmCancel').textContent === 'OK', 'button OK');
  ok(!hidden($(win, 'ov')), 'form visible behind popup');
  ok(paneList(win).length === 0, 'no pane');
  const realConnects = log.filter(e => e.action === 'connect' && !(e.body && e.body.background));
  ok(realConnects.length === 0, 'no real /api/connect called, saw ' + realConnects.length);
  cleanup(env);
});

test('persistent + probe auth-fail: auth_failed popup, no pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.background === true,
     response: {auth_failed: true, alive: false}},
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

test('persistent + tmux installed: full success, pane gets tmuxCmd, slotId', async () => {
  const probeOut = 'prompt$ \r\n__WEBSH_TMUX__:installed=yes:cmd=/usr/bin/tmux\r\n';
  let outCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.background === true,
     response: {session_id: 'bg', alive: true}, once: true},
    {action: 'input', response: {ok: true}},
    {action: 'output', response: () => {
      outCalls++;
      if (outCalls === 1) return {data: '', alive: true};
      if (outCalls === 2) return {data: Buffer.from(probeOut).toString('base64'), alive: true};
      return {data: '', alive: true};
    }},
    {action: 'disconnect', response: {ok: true}},
    {action: 'connect', match: b => !b.background,
     response: {session_id: 'real1', alive: true, slot_id: 'alex@rh#1', tmux_cmd: '/usr/bin/tmux'}},
    {action: 'resize', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'rh'; $(win, 'iU').value = 'alex'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = true;
  win.doConnect();
  await sleep(3500);
  ok(hidden($(win, 'ov')), 'form hidden on success');
  ok(hidden($(win, 'tmuxOv')), 'popup hidden on success');
  const ps = paneList(win);
  ok(ps.length === 1, 'one pane');
  if (ps.length) {
    ok(ps[0].sid === 'real1', 'sid; got=' + ps[0].sid);
    ok(ps[0].persistent === true, 'persistent=true');
    ok(ps[0].slotId === 'alex@rh#1', 'slotId; got=' + ps[0].slotId);
    ok(ps[0].tmuxCmd === '/usr/bin/tmux', 'tmuxCmd; got=' + ps[0].tmuxCmd);
  }
  const realConnects = log.filter(e => e.action === 'connect' && e.body && !e.body.background);
  ok(realConnects.length === 1, 'one real connect');
  if (realConnects.length) {
    const b = realConnects[0].body;
    ok(b.tmux_cmd === '/usr/bin/tmux', 'connect body has tmux_cmd; got=' + b.tmux_cmd);
    ok(b.persistent === true, 'connect body persistent=true');
  }
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
    echoQueue: '', echoTimer: null,
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
    echoQueue: '', echoTimer: null,
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

// =====================================================================
// echo_off hint: server tells the client when the recent visible output
// ends with a prompt that disables remote echo (sudo, mysql -p, passwd,
// ssh passphrase, read -s). The client toggles p.echoEnabled so
// predictionsEnabled() short-circuits on the next predictKey call —
// nothing is rendered as a dim glyph. Backward-compat: undefined in the
// payload must NOT clobber the previous value.
test('echo_off=true disables predictions; absent field leaves state alone', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  const writes = [];
  const p = {
    id: 'p1', sid: 'abc', polling: true,
    term: {
      write(b) {
        if (typeof b === 'string') { writes.push(b); return; }
        let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        writes.push(s);
      },
      buffer: {active: {type: 'normal'}},
    },
    el: win.document.createElement('div'),
    echoQueue: '', echoTimer: null,
    persistent: false, host: '', connection: null,
    connectedAt: 0, recentOutput: '',
  };
  win._tp = p;
  win.eval(`panes['p1'] = window._tp; activeId = 'p1';`);

  // Frame with the prompt and echo_off=true: predictions must be off.
  win.handleOutputPayload(p, {
    data: win.btoa('[sudo] password for alexey: '),
    alive: true, echo_off: true,
  });
  ok(p.echoEnabled === false,
     'echoEnabled flipped false on echo_off=true; got ' + p.echoEnabled);
  ok(win.predictionsEnabled(p) === false,
     'predictionsEnabled() short-circuits on echoEnabled===false');
  // predictKey must not write a dim glyph at the prompt.
  const before = writes.length;
  win.predictKey(p, 'a');
  ok(writes.length === before,
     'predictKey wrote nothing while echoEnabled=false; new writes=' +
     (writes.length - before));

  // Frame with no echo_off field: echoEnabled must be unchanged
  // (back-compat with older servers).
  win.handleOutputPayload(p, {data: win.btoa('x'), alive: true});
  ok(p.echoEnabled === false,
     'absent echo_off must not flip the gate; got ' + p.echoEnabled);

  // Frame with echo_off=false: predictions back on.
  win.handleOutputPayload(p, {data: win.btoa('alexey@host:~$ '),
                              alive: true, echo_off: false});
  ok(p.echoEnabled === true,
     'echoEnabled flipped true on echo_off=false; got ' + p.echoEnabled);
  ok(win.predictionsEnabled(p) === true,
     'predictionsEnabled() truthy again');
  cleanup(env);
});

// Wide chars and non-ASCII bypass the prediction queue. rewindEcho's
// '\b \b' assumes one column per queued char, but CJK / fullwidth /
// emoji glyphs occupy 2 columns. Non-ASCII (Cyrillic, etc.) is
// single-cell but doesn't round-trip safely against base64-decoded
// server bytes (consumeEcho compares JS char codes byte-for-byte).
// predictKey must drop those at entry.
test('predictKey skips wide chars and non-ASCII', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  const writes = [];
  const p = {
    id: 'p1', sid: 'abc', polling: true,
    term: {
      write(b) { writes.push(typeof b === 'string' ? b : '<bin>'); },
      buffer: {active: {type: 'normal'}},
    },
    el: win.document.createElement('div'),
    echoQueue: '', echoTimer: null, echoEnabled: true,
  };

  // ASCII printable: predicted (writes a dim glyph).
  win.predictKey(p, 'a');
  ok(p.echoQueue === 'a',
     'ASCII queued; got echoQueue=' + JSON.stringify(p.echoQueue));
  ok(writes.some(w => w.includes('\x1b[2m')),
     'ASCII printable wrote a dim glyph; writes=' + JSON.stringify(writes));
  // Reset: rewind, then drop predictions silently.
  p.echoQueue = '';
  if (p.echoTimer) { clearTimeout(p.echoTimer); p.echoTimer = null; }
  writes.length = 0;

  // CJK (wide): NOT predicted — column-only \b would corrupt.
  win.predictKey(p, '中');
  ok(p.echoQueue === '',
     'CJK char must not enter prediction queue; got ' + JSON.stringify(p.echoQueue));
  // Cyrillic single-cell but UTF-8 multibyte on the wire — still rejected.
  win.predictKey(p, 'я');
  ok(p.echoQueue === '',
     'Cyrillic must not enter prediction queue; got ' + JSON.stringify(p.echoQueue));
  // Emoji are length 2 in UTF-16 (surrogate pair) and already filtered
  // by `ch.length !== 1` — confirm explicit assertion still holds.
  win.predictKey(p, '😀');
  ok(p.echoQueue === '',
     'Emoji must not enter prediction queue; got ' + JSON.stringify(p.echoQueue));

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
