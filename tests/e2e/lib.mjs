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
// Full Chromium (not the headless shell), run with --headless=new: its
// tabs have a real visibility state. A tab put behind another one is
// document.hidden, its timers are throttled and its rendering stops -
// what a user's browser does when they switch to another tab. The
// headless shell reports "visible" for ever.
function findFullChrome() {
  if (process.env.E2E_CHROME_FULL) return process.env.E2E_CHROME_FULL;
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse(); } catch (e) {}
  for (const d of dirs) {
    const p = path.join(root, d, 'chrome-linux64/chrome');
    if (fs.existsSync(p)) return p;
  }
  return '';
}
export const fullChrome = () => findFullChrome();

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
             WEBSH_CONFIG: '/nonexistent',
             // The sealed-mode identity of the private instance: kept out
             // of the repository, one per port (E2E_SEALED=1 needs it).
             WEBSH_SEALED_KEY_FILE: path.join(os.tmpdir(), `websh-e2e-${this.port}.sealed.key`),
             ...this.env },
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

// ── a private nginx in front (HTTP/2 + TLS, like the deployment) ────
// The deployment is reached over HTTP/2 through nginx with
// proxy_buffering off; the private instance alone is plain HTTP/1.1,
// where Chromium allows six connections per host and every stream holds
// one. A scenario that needs the deployment's transport sets
// meta.front = 'h2'. Self-signed certificate (the browser is started
// with --ignore-certificate-errors); prefix, logs and pid in a temp dir.
export class H2Front {
  constructor(port, upstream) { this.port = port; this.upstream = upstream; }
  get url() { return `https://127.0.0.1:${this.port}/`; }
  async start() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websh-e2e-nginx-'));
    const d = this.dir;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=127.0.0.1', '-keyout', d + '/k.pem', '-out', d + '/c.pem'], { stdio: 'ignore' });
    fs.writeFileSync(d + '/nginx.conf', this.conf(d));
    this.proc = spawn('nginx', ['-p', d, '-c', d + '/nginx.conf'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { execFileSync('curl', ['-skf', '-o', '/dev/null', this.url + 'api/ping']); return; } catch (e) {}
      await sleep(100);
    }
    throw new Error('private nginx did not start on port ' + this.port + ' (see ' + d + '/error.log)');
  }
  conf(d) {
    return `
daemon off; pid ${d}/nginx.pid; error_log ${d}/error.log info;
events { worker_connections 1024; }
http {
  access_log ${d}/access.log;
  client_body_temp_path ${d}/body; proxy_temp_path ${d}/proxy;
  fastcgi_temp_path ${d}/fcgi; uwsgi_temp_path ${d}/uwsgi; scgi_temp_path ${d}/scgi;
  server {
    listen 127.0.0.1:${this.port} ssl http2;
    ssl_certificate ${d}/c.pem; ssl_certificate_key ${d}/k.pem;
    client_max_body_size 2g;
    proxy_request_buffering off;
    location / {
      proxy_pass http://127.0.0.1:${this.upstream};
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 1800s; proxy_send_timeout 1800s;
      proxy_buffering off;
    }
  }
}`;
  }
  accessLog() { try { return fs.readFileSync(this.dir + '/access.log', 'utf8'); } catch (e) { return ''; } }
  async stop() {
    const p = this.proc; this.proc = null;
    if (p && p.exitCode === null) {
      const gone = new Promise(r => p.once('exit', r));
      p.kill('SIGQUIT');
      await Promise.race([gone, sleep(3000)]);
      if (p.exitCode === null) p.kill('SIGKILL');
    }
    if (process.env.E2E_KEEP_NGINX) return;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ── the production front (websh.gorev.space, see AGENTS.local.md) ───
// The public :443 is an nginx stream{} block (SNI demux, shared with
// mtg) that forwards with PROXY protocol to an http vhost
// `listen 127.0.0.1:8443 ssl proxy_protocol`. That listen line has no
// `http2`, but other vhosts on the same socket do, and nginx applies it
// to the socket: browsers get HTTP/2 (`curl --http2` says 2, ALPN h2;
// checked 2026-10-21). E2E_PROD_H1=1 builds the HTTP/1.1 variant (six
// connections per host in Chromium). Same proxy directives
// as /etc/nginx/sites-enabled/websh, gzip on at http level, real_ip
// from the PROXY header. meta.front = 'prod'. The scenario talks to the
// stream port; the vhost is on port + 1.
export class ProdFront extends H2Front {
  conf(d) {
    const vhost = this.port + 1;
    return `
load_module /usr/lib/nginx/modules/ngx_stream_module.so;
daemon off; pid ${d}/nginx.pid; error_log ${d}/error.log info;
events { worker_connections 1024; }
stream {
  server {
    listen 127.0.0.1:${this.port};
    proxy_protocol on;
    proxy_timeout 1d;
    proxy_pass 127.0.0.1:${vhost};
  }
}
http {
  default_type application/octet-stream;
  access_log ${d}/access.log;
  gzip on;
  set_real_ip_from 127.0.0.1;
  real_ip_header proxy_protocol;
  client_body_temp_path ${d}/body; proxy_temp_path ${d}/proxy;
  fastcgi_temp_path ${d}/fcgi; uwsgi_temp_path ${d}/uwsgi; scgi_temp_path ${d}/scgi;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:e2e_SSL:1m; ssl_session_timeout 1440m; ssl_session_tickets off;
  server {
    listen 127.0.0.1:${vhost} ssl${process.env.E2E_PROD_H1 === '1' ? '' : ' http2'} proxy_protocol;
    ssl_certificate ${d}/c.pem; ssl_certificate_key ${d}/k.pem;
    client_max_body_size 2g;
    proxy_request_buffering off;
    location / {
      proxy_pass         http://127.0.0.1:${this.upstream};
      proxy_http_version 1.1;
      # prod has $host; here the port is not 443, and $host would drop
      # it (the Origin carries it): the one deliberate difference.
      proxy_set_header   Host              $http_host;
      proxy_set_header   X-Real-IP         $remote_addr;
      proxy_set_header   X-Forwarded-For   $remote_addr;
      proxy_set_header   X-Forwarded-Proto $scheme;
      proxy_read_timeout 1800s;
      proxy_send_timeout 1800s;
      proxy_buffering    off;
    }
  }
}`;
  }
}

// ── browser ─────────────────────────────────────────────────────────
export class Browser {
  static async launch(o) {
    const full = !!(o && o.full);
    const bin = full ? findFullChrome() : cfg.chrome;
    if (!bin) throw new Error(full ? 'no full Chromium found: set E2E_CHROME_FULL'
                                   : 'no headless Chromium found: set E2E_CHROME');
    const b = new Browser();
    b.full = full;
    // Port 0: Chromium picks a free port and writes it to
    // DevToolsActivePort in its own profile directory. A random port from
    // a fixed range once landed on ANOTHER headless Chromium already
    // listening there, and the scenario drove (and navigated) that
    // browser's page - never touch what you did not start.
    b.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websh-e2e-chrome-'));
    b.proc = spawn(bin, [...(full ? ['--headless=new'] : []), '--ignore-certificate-errors', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
      `--user-data-dir=${b.dir}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
    let port = 0;
    for (let i = 0; i < 100 && !b.ws; i++) {
      try {
        if (!port) port = +fs.readFileSync(path.join(b.dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        if (port) {
          const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
          const page = list.find(t => t.type === 'page');
          if (page) { b.ws = new WebSocket(page.webSocketDebuggerUrl); b.targetId = page.id; }
        }
      } catch (e) {}
      if (!b.ws) await sleep(100);
    }
    if (!b.ws) throw new Error('Chromium did not come up');
    if (b.ws.readyState !== 1) await new Promise(r => { b.ws.onopen = r; });
    b.id = 0; b.pending = new Map();
    b.errors = []; b.console = []; b.requests = {}; b.trace = null; b._req = {}; b.inputListeners = [];
    b.ws.onmessage = m => b._on(JSON.parse(m.data));
    await b.send('Page.enable'); await b.send('Runtime.enable');
    // maxPostDataSize: without it DevTools puts every request body into
    // its event; a sealed upload's ~1 MB binary piece bodies stalled the
    // DevTools connection for good (every later evaluate hung, the page
    // itself was fine - found 2026-10-21). Bodies above it are left out
    // of the event; their size is still in the Content-Length header.
    await b.send('Network.enable', { maxPostDataSize: 256 * 1024 });
    if (process.env.E2E_SEALED === '1') await b._countSealed();
    return b;
  }
  // Under E2E_SEALED=1 every API request is `sealed`, so counting
  // actions by URL (b.requests.input, .upload, .resize, .connect - "no
  // /api/resize", "sent in pieces") would count nothing and pass
  // vacuously. The page encrypts each request with Web Crypto AES-GCM,
  // and the plaintext starts with the spec's header line
  // {"seq", "method", "action", ...}: a wrapper around
  // crypto.subtle.encrypt, installed before the page's own scripts,
  // reports that action, and it is counted like a plain URL's. It
  // counts what the page sealed (a retried piece is sealed again, so
  // it counts again - as a resent plain request does).
  async _countSealed() {
    await this.send('Runtime.addBinding', { name: '__wsSealedReq' });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const s = crypto.subtle; if (!s) return;
      const enc = s.encrypt.bind(s);
      s.encrypt = function (alg, key, data) {
        try {
          if (alg && alg.name === 'AES-GCM' && data) {
            const u = data instanceof ArrayBuffer ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const nl = u.indexOf(10);
            if (u[0] === 123 && nl > 0 && nl < 8192) {
              const h = JSON.parse(new TextDecoder().decode(u.subarray(0, nl)));
              if (h && typeof h.action === 'string') {
                let data;
                if (h.action === 'input')
                  try { data = JSON.parse(new TextDecoder().decode(u.subarray(nl + 1))).data; } catch (e) {}
                window.__wsSealedReq(JSON.stringify({ a: h.action, pad: !!h.pad, data }));
              }
            }
          }
        } catch (e) {}
        return enc(alg, key, data);
      };
    })();` });
  }
  _on(d) {
    const p = d.params;
    if (d.method === 'Runtime.bindingCalled' && p.name === '__wsSealedReq') {
      try {
        const x = JSON.parse(p.payload);
        this.requests[x.a] = (this.requests[x.a] || 0) + 1;
        if (x.pad) this.requests.upload_pad = (this.requests.upload_pad || 0) + 1;
        if (x.a === 'input' && typeof x.data === 'string') this.inputListeners.forEach(f => f(x.data));
        if (this.trace) this.trace.push(`${stamp()} >> ${x.a} (sealed)`);
      } catch (e) {}
    }
    if (d.method === 'Runtime.exceptionThrown')
      this.errors.push((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled') {
      const text = p.args.map(a => a.value !== undefined ? a.value : a.description).join(' ');
      if (p.type === 'error') this.errors.push('console.error: ' + text);
      if (this.trace) this.trace.push(`${stamp()} ${text.slice(0, 160)}`);
    }
    if (d.method === 'Network.requestWillBeSent' && /[?&]action=input\b/.test(p.request.url)) {
      let data;
      try { data = JSON.parse(p.request.postData || '{}').data; } catch (e) {}
      if (typeof data === 'string') this.inputListeners.forEach(f => f(data));
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
      try { if (await this.ev('typeof bootReady') === 'object') { await this.ev('bootReady.then(() => 1)'); await this._sealedOn(); return; } } catch (e) {}
    }
    throw new Error('websh did not boot at ' + url);
  }
  // What websh sends to the shells: the `data` of every input request,
  // from the network in plain mode, from the page's encryption in sealed
  // mode (where the network shows only ciphertext).
  onInput(fn) { this.inputListeners.push(fn); }
  // E2E_SEALED=1: every scenario runs with sealed mode switched on, the
  // way a user does it (Options checkbox), before it connects anything.
  // Requests are still counted by their (inner) action: _countSealed.
  async _sealedOn() {
    if (process.env.E2E_SEALED !== '1') return;
    const on = await this.ev(`(() => { if (!settings.sealed) { openOptions(); document.getElementById('optSealed').click(); closeOptions(); } return settings.sealed === true; })()`);
    if (!on) throw new Error('E2E_SEALED=1 but sealed mode could not be switched on');
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
  // Another browser tab in front of ours (full Chromium only): the page
  // becomes document.hidden as for a user who switched tabs; show()
  // brings ours back.
  async hide() {
    if (!this.full) throw new Error('hide() needs Browser.launch({full: true})');
    if (!this.otherTarget)
      this.otherTarget = (await this.send('Target.createTarget', { url: 'about:blank' })).result.targetId;
    else await this.send('Target.activateTarget', { targetId: this.otherTarget });
  }
  show() { return this.send('Target.activateTarget', { targetId: this.targetId }); }
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
