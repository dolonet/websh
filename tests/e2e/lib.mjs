// Shared harness for the browser scenarios: a headless Chromium driven
// over the DevTools protocol, a private websh instance started from the
// working tree, and the network faults the scenarios inject.
// No dependencies beyond Node 22 (global fetch/WebSocket).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const cfg = {
  chrome: process.env.E2E_CHROME || findChrome(),
  host: process.env.E2E_SSH_HOST || '127.0.0.1',
  user: process.env.E2E_SSH_USER || os.userInfo().username,
  password: process.env.E2E_SSH_PASSWORD || '',
  sudoPassword: process.env.E2E_SUDO_PASSWORD || '',
  port: +(process.env.E2E_PORT || 18765),
};

function findChrome() {
  const roots = [path.join(os.homedir(), '.cache/ms-playwright')];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(d => d.startsWith('chromium_headless_shell')).sort().reverse(); }
    catch (e) { continue; }
    for (const d of dirs) {
      const p = path.join(root, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

// ── sudo (network faults only) ──────────────────────────────────────
export function sudo(args) {
  const opts = cfg.sudoPassword ? { input: cfg.sudoPassword + '\n' } : {};
  const pre = cfg.sudoPassword ? ['-S', '-p', ''] : ['-n'];
  return execFileSync('sudo', [...pre, ...args], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] })
    .toString().trim();
}
export function haveSudo() {
  try { sudo(['true']); return true; } catch (e) { return false; }
}
// Silently drop the packets of the connections CURRENTLY established to
// the port (no FIN, no RST): what a Wi-Fi switch or a sleeping laptop
// looks like. New connections are unaffected.
export const blackhole = port => sudo(['bash', path.join(HERE, 'blackhole.sh'), 'on', String(port)]);
export const blackholeOff = () => { try { sudo(['bash', path.join(HERE, 'blackhole.sh'), 'off']); } catch (e) {} };
// Reset them instead (the browser sees an error).
export const resetConnections = port =>
  sudo(['ss', '-K', 'state', 'established', `( sport = :${port} )`])
    .split('\n').filter(l => l.includes(':' + port)).length;

// ── private websh instance ──────────────────────────────────────────
export class LocalServer {
  constructor(port, env) { this.port = port; this.env = env || {}; this.proc = null; }
  get url() { return `http://127.0.0.1:${this.port}/`; }
  async start() {
    this.log = this.log || fs.openSync(path.join(os.tmpdir(), `websh-e2e-${this.port}.log`), 'a');
    this.proc = spawn('python3', ['server.py'], {
      cwd: REPO, stdio: ['ignore', this.log, this.log],
      env: { ...process.env, PORT: String(this.port), HOST: '127.0.0.1',
             WEBSH_CONFIG: '/nonexistent', ...this.env },
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(this.url + 'api/ping')).ok) return; } catch (e) {}
      await sleep(100);
    }
    throw new Error('local websh did not start on port ' + this.port);
  }
  async stop() {
    const p = this.proc; this.proc = null;
    if (!p || p.exitCode !== null) return;
    const gone = new Promise(r => p.once('exit', r));
    p.kill('SIGTERM');
    await Promise.race([gone, sleep(5000)]);
    if (p.exitCode === null) p.kill('SIGKILL');
  }
  async restart() { await this.stop(); await this.start(); }
}

// ── browser ─────────────────────────────────────────────────────────
export class Browser {
  static async launch() {
    if (!cfg.chrome) throw new Error('no headless Chromium found: set E2E_CHROME');
    const b = new Browser();
    // Port 0: Chromium picks a free port and writes it to
    // DevToolsActivePort in its own profile directory. A random port from
    // a fixed range once landed on ANOTHER headless Chromium already
    // listening there, and the scenario drove (and navigated) that
    // browser's page - never touch what you did not start.
    b.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websh-e2e-chrome-'));
    b.proc = spawn(cfg.chrome, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
      `--user-data-dir=${b.dir}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
    let port = 0;
    for (let i = 0; i < 100 && !b.ws; i++) {
      try {
        if (!port) port = +fs.readFileSync(path.join(b.dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        if (port) {
          const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
          const page = list.find(t => t.type === 'page');
          if (page) b.ws = new WebSocket(page.webSocketDebuggerUrl);
        }
      } catch (e) {}
      if (!b.ws) await sleep(100);
    }
    if (!b.ws) throw new Error('Chromium did not come up');
    if (b.ws.readyState !== 1) await new Promise(r => { b.ws.onopen = r; });
    b.id = 0; b.pending = new Map();
    b.errors = []; b.console = []; b.requests = {}; b.trace = null; b._req = {};
    b.ws.onmessage = m => b._on(JSON.parse(m.data));
    await b.send('Page.enable'); await b.send('Runtime.enable'); await b.send('Network.enable');
    return b;
  }
  _on(d) {
    const p = d.params;
    if (d.method === 'Runtime.exceptionThrown')
      this.errors.push((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled') {
      const text = p.args.map(a => a.value !== undefined ? a.value : a.description).join(' ');
      if (p.type === 'error') this.errors.push('console.error: ' + text);
      if (this.trace) this.trace.push(`${stamp()} ${text.slice(0, 160)}`);
    }
    if (d.method === 'Network.requestWillBeSent') {
      const a = (p.request.url.match(/action=(\w+)/) || [])[1];
      if (a) {
        this.requests[a] = (this.requests[a] || 0) + 1;
        this._req[p.requestId] = a;
        if (this.trace) {
          const body = p.request.postData || '';
          const sid = (body.match(/"session_id":"(.{8})/) || p.request.url.match(/session_id=(.{8})/) || [])[1];
          const data = (body.match(/"data":"((?:[^"\\]|\\.)*)"/) || [])[1];
          this.trace.push(`${stamp()} >> ${a} sid=${sid}` + (data !== undefined ? ` data=${data.slice(0, 80)}` : ''));
        }
      }
    }
    if (d.method === 'Network.responseReceived' && this.trace && this._req[p.requestId])
      this.trace.push(`${stamp()} << ${this._req[p.requestId]} ${p.response.status}`);
    if (d.id && this.pending.has(d.id)) { this.pending.get(d.id)(d); this.pending.delete(d.id); }
  }
  send(method, params) {
    return new Promise(r => { const i = ++this.id; this.pending.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  }
  async ev(expr) {
    const r = (await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  // Start recording page console + API traffic (for a failure report).
  startTrace() { this.trace = []; }

  async open(url) {
    this.url = url;
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      try { if (await this.ev('typeof bootReady') === 'object') { await this.ev('bootReady.then(() => 1)'); return; } } catch (e) {}
    }
    throw new Error('websh did not boot at ' + url);
  }
  _fill(persistent) {
    return `iH.value=${JSON.stringify(cfg.host)}; iU.value=${JSON.stringify(cfg.user)}; ` +
           `iPw.value=${JSON.stringify(cfg.password)}; iPersistent.checked=${!!persistent};`;
  }
  async connect(o) {
    const before = await this.ev('Object.keys(panes).length');
    await this.ev(`(() => { ${this._fill(o && o.persistent)} doConnect(); return 1; })()`);
    return this._ready(before);
  }
  async split(o) {
    const before = await this.ev('Object.keys(panes).length');
    await this.ev(`(() => { splitPane(Object.keys(panes)[0], 'h'); ${this._fill(o && o.persistent)} doConnect(); return 1; })()`);
    return this._ready(before);
  }
  async _ready(i) {
    for (let k = 0; k < 80; k++) {
      await sleep(500);
      const n = await this.ev('Object.keys(panes).length');
      if (n > i && /[$#]\s*$/.test((await this.screen(i)).trimEnd() + ' ')) { await sleep(800); return i; }
    }
    throw new Error(`pane ${i}: no shell prompt (check E2E_SSH_HOST/USER/PASSWORD)`);
  }
  screen(i) {
    return this.ev(`(() => { const p = Object.values(panes)[${i || 0}]; if (!p || !p.term) return '';
      const b = p.term.buffer.active; let t = '';
      for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (l) t += l.translateToString(true) + '\\n'; }
      return t; })()`);
  }
  async lines(i) { return (await this.screen(i)).split('\n').map(l => l.trim()); }
  // Through the terminal's own input path, like a keypress.
  type(i, text) {
    return this.ev(`(() => { const p = Object.values(panes)[${i}];
      for (const c of ${JSON.stringify(text)}) p.term._core.coreService.triggerDataEvent(c, true); return 1; })()`);
  }
  state() {
    return this.ev(`Object.values(panes).map(p => ({ sid: (p.sid || '').slice(0, 8),
      sse: !!p.eventSource && !p.sseDisabled, polling: !!p.sseDisabled,
      reconnecting: !!p.reconnecting, pings: !!p.serverPings }))`);
  }
  network(o) {
    return this.send('Network.emulateNetworkConditions',
      { offline: !!o.offline, latency: o.latency || 0, downloadThroughput: -1,
        uploadThroughput: o.upload || -1 });   // bytes/s
  }
  freeze() { return this.send('Page.setWebLifecycleState', { state: 'frozen' }); }
  unfreeze() { return this.send('Page.setWebLifecycleState', { state: 'active' }); }
  // End every session; persistent ones take their tmux session with them.
  // A persistent pane that has no session at this moment (the scenario
  // aborted while it was expired) is re-attached first: its tmux session
  // on the target would otherwise outlive the test.
  async endAll() {
    try {
      return await this.ev(`(async () => { let n = 0; const left = [];
        for (const p of Object.values(panes)) {
          if (!p.sid && p.persistent && p.slotId && (p.host || p.connection)) {
            if (!p.connecting) connectPane(p, { label: p.label, resume: true });
            for (let i = 0; i < 60 && !p.sid; i++) await new Promise(r => setTimeout(r, 250));
            if (!p.sid) left.push('websh-' + p.slotId);
          }
          p.polling = false;
          if (p.sid) { await api('disconnect', { body: { session_id: p.sid, terminate: true } }); n++; }
        }
        return { ended: n, left }; })()`);
    } catch (e) { return { ended: 0, left: ['unknown (page not reachable: ' + e.message.slice(0, 60) + ')'] }; }
  }
  async close() {
    try { this.ws.close(); } catch (e) {}
    try { this.proc.kill('SIGKILL'); } catch (e) {}
    await sleep(200);
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) {}
  }
}

function stamp() { return String(Date.now() % 100000).padStart(5, '0'); }

// ── assertions ──────────────────────────────────────────────────────
export class Report {
  constructor() { this.failed = 0; this.notes = []; }
  ok(cond, what) {
    console.log(`    ${cond ? 'ok  ' : 'FAIL'} ${what}`);
    if (!cond) this.failed++;
    return !!cond;
  }
  note(text) { console.log('    ' + text); }
}

// `tag_1 … tag_n` printed by a shell loop: the numbers seen, in order.
// A key typed mid-line shows up as a prefix on one line; tolerate it.
export function numbered(lines, tag) {
  const re = new RegExp('^\\S{0,3}' + tag + '_(\\d+)$');
  return lines.map(l => l.match(re)).filter(Boolean).map(m => +m[1]);
}
export const consecutive = nums => nums.length > 0 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
export const fromOne = nums => consecutive(nums) && nums[0] === 1;
export const tagOf = prefix => prefix + (Date.now() % 100000);
export async function until(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(step || 250); }
  return -1;
}
