// Typing-latency reports from the page (latency spec, 2026-10-25).
// Written from the spec, not from the code.
//
// The owner types into a coding agent in a persistent tmux pane and
// sees "regular delays"; nothing records where a keystroke's time goes.
// The page measures each input batch (one /api/input request) per pane:
//   queue - first key (xterm onData) -> its input request sent
//   rtt   - request sent -> its reply
//   echo  - request sent -> the first output for that pane arriving
//           (only within 2 s; otherwise the batch is "no echo")
//   paint - that output's arrival -> xterm's next render of the pane
//   total - first key -> that render
// and every 5 minutes (if it sent input in that window), and on pagehide
// (if anything is unsent), POSTs one report ?action=client_lat:
//   {window_ms, vis, panes: [{sid (8 chars), mode, sealed, n, n_echo, slow,
//    queue|rtt|echo|paint|total: {p50, p90, max}, worst: {...5 stages},
//    inflight_max}]}
// through the normal API wrapper (sealed when sealed mode is on), plain
// pagehide by fetch keepalive / sendBeacon. 404 -> no more reports from
// this page; a failed report is dropped silently, never retried in a loop.
// Input order and every existing input behaviour unchanged.
//
// The clock: timers of 5 s and longer are virtual (fired by clock.advance),
// Date.now() and performance.now() move with it; shorter timers are real.
// So "5 minutes pass" takes milliseconds, and the page's 5-minute schedule
// must be built from setTimeout/setInterval and Date.now/performance.now.
// xterm's render is faked: onRender fires PAINT ms after each write.

const {sleep, until, enc, dec, mkEnv, cleanup, connect, termText} = require('./sealed_harness');

let passed = 0, failed = 0, current = '(between scenarios)';
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(current + ': ' + msg); console.log('  FAIL: ' + msg); }
}
const scenarios = [];
function test(name, fn) { scenarios.push({name, fn}); }

const MIN = 60 * 1000;
const STAGES = ['queue', 'rtt', 'echo', 'paint', 'total'];

// ── virtual clock + rendering terminal, installed before websh.js runs ──
function beforeBoot(holder) {
  return (win) => {
    const clk = {skew: 0, q: [], id: 900000000, paintMs: 40};
    holder.clock = clk;
    const rST = win.setTimeout.bind(win), rCT = win.clearTimeout.bind(win);
    const rSI = win.setInterval.bind(win), rCI = win.clearInterval.bind(win);
    const rNow = win.Date.now.bind(win.Date);
    const perf = win.performance, rPerf = perf.now.bind(perf);
    const vnow = () => rNow() + clk.skew;
    win.Date.now = vnow;
    Object.defineProperty(perf, 'now', {value: () => rPerf() + clk.skew, configurable: true, writable: true});
    const LONG = 5000;
    const add = (fn, ms, a, every) => { const id = ++clk.id; clk.q.push({id, at: vnow() + ms, fn, a, every}); return id; };
    const drop = id => { const i = clk.q.findIndex(t => t.id === id); if (i >= 0) { clk.q.splice(i, 1); return true; } return false; };
    win.setTimeout = function (fn, ms, ...a) { ms = +ms || 0; return ms < LONG ? rST(fn, ms, ...a) : add(fn, ms, a, 0); };
    win.setInterval = function (fn, ms, ...a) { ms = +ms || 0; return ms < LONG ? rSI(fn, ms, ...a) : add(fn, ms, a, ms); };
    win.clearTimeout = id => { if (!drop(id)) rCT(id); };
    win.clearInterval = id => { if (!drop(id)) rCI(id); };
    clk.advance = async ms => {
      const end = vnow() + ms;
      for (;;) {
        clk.q.sort((x, y) => x.at - y.at);
        const t = clk.q[0];
        if (!t || t.at > end) break;
        clk.skew += Math.max(0, t.at - vnow());
        if (t.every) t.at += t.every; else clk.q.shift();
        try { if (typeof t.fn === 'function') t.fn(...t.a); } catch (e) { console.log('timer threw', e && e.message); }
        await new Promise(r => rST(r, 0));
      }
      clk.skew += Math.max(0, end - vnow());
      await new Promise(r => rST(r, 30));
    };
    // xterm renders a moment after a write: onRender listeners fire then.
    const P = win.Terminal.prototype;
    P.onRender = function (cb) { (this._rcb = this._rcb || []).push(cb); return {dispose() {}}; };
    const w = P.write;
    P.write = function (d, cb) {
      w.call(this, d, cb);
      const self = this;
      rST(() => { for (const f of (self._rcb || [])) try { f({start: 0, end: 23}); } catch (e) {} }, clk.paintMs);
    };
  };
}

// A shell with controllable delays: the input reply after rttMs, the echo
// echoMs(data) after the request arrived (null: no output at all).
function slowShell(env, o) {
  const srv = env.srv;
  env.rttMs = o.rttMs; env.echoMs = o.echoMs;
  srv.hooks.input = async req => {
    let b; try { b = JSON.parse(dec.decode(req.body)); } catch (e) { return undefined; }
    const s = srv.sessions[b.session_id];
    if (!s) return undefined;
    s.inputCalls++;
    s.input += b.data;
    if (b.data) {
      (s.batches = s.batches || []).push(b.data);
      const ms = env.echoMs(b.data);
      if (ms !== null) setTimeout(() => srv.emit(b.session_id, b.data), ms);
    }
    await sleep(env.rttMs);
    return {status: 200, headers: {'Content-Type': 'application/json'},
            body: enc.encode(JSON.stringify({ok: true, alive: true, cursor: s.out.length}))};
  };
}

async function env(o) {
  o = o || {};
  const holder = {};
  const e = await mkEnv(Object.assign({}, o, {beforeBoot: beforeBoot(holder)}));
  e.clock = holder.clock;
  e.toasts = []; e.errs = [];
  const win = e.win;
  for (const k of ['showToast', 'showErr']) {
    const orig = win[k];
    if (typeof orig === 'function') win[k] = function (m) { (k === 'showErr' ? e.errs : e.toasts).push(String(m)); return orig.apply(this, arguments); };
  }
  e.latInits = [];
  const f = win.fetch;
  win.fetch = function (u, init) { if (/client_lat/.test(String(u))) e.latInits.push(init || {}); return f.apply(this, arguments); };
  if (o.latReply !== undefined) e.srv.hooks.client_lat = async () => o.latReply;
  e.pageErrors = [];
  win.addEventListener('error', ev => e.pageErrors.push(String(ev.message || ev.error)));
  win.addEventListener('unhandledrejection', ev => e.pageErrors.push('unhandled: ' + (ev.reason && ev.reason.message)));
  return e;
}
const OK200 = {status: 200, headers: {'Content-Type': 'application/json'}, body: enc.encode('{"ok": true}')};

// Reports seen by the server: plain ones on the wire, sealed ones inside.
function plainReports(e) { return e.srv.wire.filter(w => w.action === 'client_lat'); }
function sealedReports(e) { return e.srv.inner.filter(r => r.action === 'client_lat'); }
function allReports(e) { return plainReports(e).concat(sealedReports(e)); }
function bodyOf(r) {
  const t = typeof r.body === 'string' ? r.body : dec.decode(r.body);
  try { return JSON.parse(t); } catch (x) { return {_raw: t}; }
}
function rawOf(r) { return typeof r.body === 'string' ? r.body : dec.decode(r.body); }

// One key, the way xterm delivers it (onData), then wait for its echo
// and the render after it.
async function key(e, p, c, waitEcho) {
  const before = termText(p).length;
  p.term._onData(c);
  if (waitEcho !== false) {
    ok(await until(() => termText(p).length > before, 3000), 'echo of ' + JSON.stringify(c) + ' arrived');
    await sleep(e.clock.paintMs + 40);
  }
}
async function setup(o) {
  const e = await env(o);
  const p = await connect(e);
  if (!p) { ok(false, 'setup: pane connected'); cleanup(e); return null; }
  await until(() => /Welcome/.test(termText(p)), 2000);
  await sleep(100);
  if (!p.term._onData) { ok(false, 'setup: the pane listens to xterm onData'); cleanup(e); return null; }
  return {e, p};
}
const isStats = s => !!s && STAGES && ['p50', 'p90', 'max'].every(k => Number.isInteger(s[k]));
const inRange = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;

// ═════════════════════════════════════════════════════════════════════

test('report shape: one pane, every field, integers, no content', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 20, echoMs: () => 30});
  for (const c of 'abc') await key(e, p, c);
  p.term._onData('SECRETPASTE123');            // a paste: one batch
  await until(() => /SECRETPASTE123/.test(termText(p)), 2000); await sleep(100);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 1, 2000), 'one report after 5 minutes; got ' + allReports(e).length);
  const r = allReports(e)[0];
  if (!r) { cleanup(e); return; }
  ok(r.method === 'POST', 'POST; got ' + r.method);
  const b = bodyOf(r), raw = rawOf(r);
  ok(inRange(b.window_ms, 290000, 320000), 'window_ms ~ 5 minutes; got ' + b.window_ms);
  ok(b.vis === 'visible', 'vis = visibilityState; got ' + b.vis);
  ok(Array.isArray(b.panes) && b.panes.length === 1, 'one pane; got ' + JSON.stringify(b.panes));
  const d = (b.panes || [])[0] || {};
  ok(d.sid === p.sid.slice(0, 8), 'sid = the 8-character prefix; got ' + d.sid);
  ok(!raw.includes(p.sid), 'the full session id is not in the report');
  ok(d.mode === 'sse', 'mode sse (the pane streams); got ' + d.mode);
  ok(d.sealed === false, 'sealed false; got ' + d.sealed);
  ok(d.n === 4, 'n = 4 batches (3 keys + 1 paste); got ' + d.n);
  ok(d.n_echo === 4, 'n_echo = 4; got ' + d.n_echo);
  ok(Number.isInteger(d.slow), 'slow is an integer; got ' + d.slow);
  for (const k of STAGES) ok(isStats(d[k]), k + ' is {p50, p90, max} integers; got ' + JSON.stringify(d[k]));
  ok(!!d.worst && STAGES.every(k => Number.isInteger(d.worst[k])), 'worst has the five stages as integers; got ' + JSON.stringify(d.worst));
  ok(Number.isInteger(d.inflight_max) && d.inflight_max >= 1, 'inflight_max >= 1; got ' + d.inflight_max);
  ok(!/SECRETPASTE/.test(raw), 'no typed text in the report');
  ok(!/Welcome/.test(raw), 'no output in the report');
  ok(raw.length < 4000, 'small: ' + raw.length + ' bytes');
  ok(e.toasts.length === 0 && e.errs.length === 0, 'nothing shown to the user: ' + e.toasts.concat(e.errs).join(' | '));
  cleanup(e);
});

test('stages measured: queue, rtt, echo, paint, total match the delays', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  e.clock.paintMs = 40;
  slowShell(e, {rttMs: 30, echoMs: () => 120});
  for (const c of 'abcdef') await key(e, p, c);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length >= 1, 2000), 'a report');
  const d = ((bodyOf(allReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  console.log('  report pane: ' + JSON.stringify(d));
  ok(d.n === 6 && d.n_echo === 6, 'six batches, all echoed; got n=' + d.n + ' n_echo=' + d.n_echo);
  const m = k => (d[k] || {}).p50;
  ok(inRange(m('queue'), 0, 60), 'queue p50 small (nothing in flight ahead): ' + m('queue'));
  ok(inRange(m('rtt'), 25, 150), 'rtt p50 ~ 30 ms reply delay: ' + m('rtt'));
  ok(inRange(m('echo'), 110, 300), 'echo p50 ~ 120 ms output delay: ' + m('echo'));
  ok(m('echo') > m('rtt') + 50, 'echo is not the reply: echo ' + m('echo') + ' vs rtt ' + m('rtt'));
  ok(inRange(m('paint'), 35, 200), 'paint p50 ~ 40 ms to the render after the output: ' + m('paint'));
  ok(inRange(m('total'), m('echo') + m('paint') - 15, 600), 'total p50 >= echo + paint: ' + m('total'));
  ok(d.slow === 0, 'no batch over 300 ms: slow ' + d.slow);
  const t = d.total || {};
  ok(t.p50 <= t.p90 && t.p90 <= t.max, 'p50 <= p90 <= max: ' + JSON.stringify(t));
  const w = d.worst || {};
  ok(w.total === t.max, 'worst is the slowest batch: worst.total ' + w.total + ' = total.max ' + t.max);
  cleanup(e);
});

test('a slow batch: counted in slow, and worst is its breakdown', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 20, echoMs: d => d === 'S' ? 450 : 30});
  for (const c of 'abSde') await key(e, p, c);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length >= 1, 2000), 'a report');
  const d = ((bodyOf(allReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  console.log('  report pane: ' + JSON.stringify(d));
  ok(d.slow === 1, 'exactly one batch with total > 300 ms; got ' + d.slow);
  const w = d.worst || {};
  ok(inRange(w.echo, 430, 700), 'worst.echo ~ 450; got ' + w.echo);
  ok(inRange(w.total, 470, 900), 'worst.total ~ 450 + paint; got ' + w.total);
  ok(inRange(w.rtt, 10, 150), 'worst.rtt is that batch\'s rtt (~20); got ' + w.rtt);
  ok((d.echo || {}).max === w.echo, 'echo.max is the slow batch; got ' + JSON.stringify(d.echo));
  cleanup(e);
});

test('no echo within 2 s: excluded from echo and total, counted in n', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 20, echoMs: d => d === 'P' ? null : 30});
  await key(e, p, 'P', false);                 // a password key: nothing comes back
  await until(() => (e.srv.sessions[p.sid].batches || []).length === 1, 2000);
  await sleep(2300);                           // the 2 s window itself is under test
  e.srv.emit(p.sid, 'late output\r\n');         // output, but 2.3 s later
  await until(() => /late output/.test(termText(p)), 2000);
  await sleep(100);
  for (const c of 'xyz') await key(e, p, c);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length >= 1, 2000), 'a report');
  const d = ((bodyOf(allReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  console.log('  report pane: ' + JSON.stringify(d));
  ok(d.n === 4, 'n = 4 batches; got ' + d.n);
  ok(d.n_echo === 3, 'n_echo = 3 (the silent one is not echoed); got ' + d.n_echo);
  ok(inRange((d.echo || {}).max, 0, 1000), 'the late output is not that batch\'s echo: echo.max ' + JSON.stringify(d.echo));
  ok(inRange((d.total || {}).max, 0, 1000), 'nor in total: ' + JSON.stringify(d.total));
  cleanup(e);
});

test('keys typed while a request is in flight: queue counts the wait', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 200, echoMs: () => 20});
  p.term._onData('a');                         // goes out at once
  await sleep(30);
  p.term._onData('b');                         // waits ~170 ms behind it
  await until(() => (e.srv.sessions[p.sid].batches || []).length === 2, 3000);
  await until(() => /ab/.test(termText(p)), 3000);
  await sleep(500);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length >= 1, 2000), 'a report');
  const d = ((bodyOf(allReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  console.log('  report pane: ' + JSON.stringify(d));
  ok(d.n === 2, 'two batches; got ' + d.n);
  ok(inRange((d.queue || {}).max, 130, 400), 'queue.max ~ 170 ms waiting behind the request in flight; got ' + JSON.stringify(d.queue));
  ok(inRange((d.total || {}).max, (d.queue || {}).max + 15, 1500), 'the wait is in total: ' + JSON.stringify(d.total));
  cleanup(e);
});

test('long-poll pane: mode says so', async () => {
  const s = await setup({latReply: OK200}); if (!s) return;   // no EventSource: long-poll
  const {e, p} = s;
  for (const c of 'ab') await key(e, p, c);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length >= 1, 2000), 'a report');
  const d = ((bodyOf(allReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  ok(d.mode === 'poll' || d.mode === 'long-poll', 'mode poll; got ' + d.mode);
  ok(d.n === 2, 'n = 2; got ' + d.n);
  cleanup(e);
});

test('cadence: every 5 minutes, only for a window with input', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 10, echoMs: () => 10});
  for (const c of 'ab') await key(e, p, c);
  await e.clock.advance(4 * MIN);
  await sleep(100);
  ok(allReports(e).length === 0, 'nothing before 5 minutes; got ' + allReports(e).length);
  await e.clock.advance(1 * MIN + 2000);
  ok(await until(() => allReports(e).length === 1, 2000), 'one report at 5 minutes; got ' + allReports(e).length);
  await e.clock.advance(5 * MIN + 1000);
  await sleep(100);
  ok(allReports(e).length === 1, 'no input in the next window (keepalives do not count): no report; got ' + allReports(e).length);
  await key(e, p, 'c');
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 2, 2000), 'input again: the next report; got ' + allReports(e).length);
  const b2 = bodyOf(allReports(e)[1] || {body: '{}'});
  const d2 = (b2.panes || [])[0] || {};
  ok(d2.n === 1, 'the second report has only its own window: n = 1; got ' + d2.n);
  await sleep(500);
  ok(allReports(e).length === 2, 'one report per window, not a stream: ' + allReports(e).length);
  cleanup(e);
});

test('no input at all: no report, not at 5 minutes, not on pagehide', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e} = s;
  await e.clock.advance(11 * MIN);              // keepalives (empty inputs) go meanwhile
  await sleep(100);
  ok(e.srv.wire.some(w => w.action === 'input'), 'control: keepalive inputs were sent');
  e.win.dispatchEvent(new e.win.Event('pagehide'));
  await sleep(100);
  ok(allReports(e).length === 0, 'no report without typing; got ' + allReports(e).length);
  cleanup(e);
});

test('pagehide: unsent data goes out once, keepalive or beacon', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 10, echoMs: () => 10});
  for (const c of 'abc') await key(e, p, c);
  e.win.dispatchEvent(new e.win.Event('pagehide'));
  ok(await until(() => allReports(e).length === 1, 1000), 'one report on pagehide; got ' + allReports(e).length);
  const r = allReports(e)[0];
  if (r) {
    ok(r.kind === 'beacon' || (r.kind === 'fetch' && e.latInits.some(i => i.keepalive === true)),
       'sent so it survives the page: sendBeacon or fetch keepalive; got ' + r.kind + ' ' + JSON.stringify(e.latInits.map(i => i.keepalive)));
    const d = (bodyOf(r).panes || [])[0] || {};
    ok(d.n === 3, 'n = 3; got ' + d.n);
    ok(inRange(bodyOf(r).window_ms, 0, 4 * MIN), 'window_ms is the part of the window that passed; got ' + bodyOf(r).window_ms);
  }
  e.win.dispatchEvent(new e.win.Event('pagehide'));
  await sleep(100);
  ok(allReports(e).length === 1, 'nothing new since: no second report; got ' + allReports(e).length);
  cleanup(e);
});

test('pagehide after a periodic report with nothing new: nothing sent', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 10, echoMs: () => 10});
  await key(e, p, 'a');
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 1, 2000), 'the periodic report');
  e.win.dispatchEvent(new e.win.Event('pagehide'));
  await sleep(100);
  ok(allReports(e).length === 1, 'already sent: pagehide sends nothing; got ' + allReports(e).length);
  cleanup(e);
});

test('an old server (404): the page stops reporting', async () => {
  const s = await setup({eventSource: 'live'}); if (!s) return;   // the fake answers 404 to unknown actions
  const {e, p} = s;
  slowShell(e, {rttMs: 10, echoMs: () => 10});
  await key(e, p, 'a');
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 1, 2000), 'the first report is tried; got ' + allReports(e).length);
  ok(plainReports(e)[0] && plainReports(e)[0].status === 404, 'answered 404');
  for (let i = 0; i < 2; i++) {
    await key(e, p, 'b');
    await e.clock.advance(5 * MIN + 1000);
    await sleep(100);
  }
  await key(e, p, 'c');
  e.win.dispatchEvent(new e.win.Event('pagehide'));
  await sleep(200);
  ok(allReports(e).length === 1, 'after a 404, no more reports from this page (windows, pagehide); got ' + allReports(e).length);
  ok(e.toasts.length === 0 && e.errs.length === 0, 'nothing shown: ' + e.toasts.concat(e.errs).join(' | '));
  cleanup(e);
});

test('a failed report (429, 500, network error) is dropped, never retried in a loop', async () => {
  for (const kind of [429, 500, 'neterr']) {
    const reply = kind === 'neterr' ? undefined : {status: kind, headers: {'Content-Type': 'application/json'}, body: enc.encode('{"error": "x"}')};
    const s = await setup({eventSource: 'live', latReply: reply}); if (!s) continue;
    const {e, p} = s;
    if (kind === 'neterr') e.srv.hooks.client_lat = async () => { throw new TypeError('Failed to fetch'); };
    slowShell(e, {rttMs: 10, echoMs: () => 10});
    await key(e, p, 'a');
    await e.clock.advance(5 * MIN + 1000);
    ok(await until(() => allReports(e).length >= 1, 2000), kind + ': the report was sent');
    await sleep(1500);
    await e.clock.advance(30 * 1000);            // any short retry timer would fire now
    await sleep(200);
    ok(allReports(e).length === 1, kind + ': sent once, not retried; got ' + allReports(e).length);
    await key(e, p, 'b');
    await e.clock.advance(5 * MIN + 1000);
    await sleep(200);
    ok(allReports(e).length === 2, kind + ': the next window still reports once (only 404 stops it); got ' + allReports(e).length);
    ok(e.toasts.length === 0 && e.errs.length === 0, kind + ': nothing shown: ' + e.toasts.concat(e.errs).join(' | '));
    ok(e.pageErrors.length === 0, kind + ': no page error: ' + e.pageErrors.join(' | '));
    cleanup(e);
  }
});

test('a report that never gets an answer does not hold typing back', async () => {
  const s = await setup({eventSource: 'live'}); if (!s) return;
  const {e, p} = s;
  e.srv.hooks.client_lat = () => new Promise(() => {});
  slowShell(e, {rttMs: 10, echoMs: () => 10});
  await key(e, p, 'a');
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 1, 2000), 'the report is out (and hangs)');
  for (const c of 'hello') p.term._onData(c);
  ok(await until(() => e.srv.sessions[p.sid].input.endsWith('hello'), 2000),
     'keys typed meanwhile reach the shell; got ' + JSON.stringify(e.srv.sessions[p.sid].input.slice(-10)));
  cleanup(e);
});

test('sealed mode: the report goes inside the channel, never in clear', async () => {
  const s = await setup({sealed: true, latReply: OK200}); if (!s) return;
  const {e, p} = s;
  for (const c of 'ab') await key(e, p, c);
  ok(e.srv.inner.some(r => r.action === 'input'), 'control: input is sealed');
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => sealedReports(e).length === 1, 3000), 'one sealed client_lat; got ' + sealedReports(e).length);
  ok(plainReports(e).length === 0, 'no client_lat in clear; got ' + plainReports(e).length);
  const d = ((bodyOf(sealedReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  ok(d.sealed === true, 'the pane says sealed: true; got ' + d.sealed);
  ok(d.n === 2, 'n = 2; got ' + d.n);
  await key(e, p, 'c');
  e.win.dispatchEvent(new e.win.Event('pagehide'));
  await sleep(300);
  ok(plainReports(e).length === 0 && !e.srv.beacons.some(x => /client_lat/.test(String(x.url))),
     'pagehide in sealed mode: sealed or not at all, never a plain beacon');
  cleanup(e);
});

test('input order unchanged, and n counts the input requests', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 25, echoMs: () => 5});
  const text = 'echo ' + Array.from({length: 240}, (_, i) => String.fromCharCode(97 + (i * 7) % 26)).join('') + '\r';
  for (let i = 0; i < text.length; i++) {
    p.term._onData(text[i]);
    if (i % 17 === 0) await sleep(1 + (i % 4) * 9);
  }
  ok(await until(() => e.srv.sessions[p.sid].input === text, 5000),
     'every key arrives once, in order; got ' + JSON.stringify(e.srv.sessions[p.sid].input.slice(-40)));
  await sleep(300);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 1, 2000), 'a report');
  const d = ((bodyOf(allReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  const batches = (e.srv.sessions[p.sid].batches || []).length;
  ok(d.n === batches, 'n = the number of input requests with keys (' + batches + '); got ' + d.n);
  ok(inRange(d.inflight_max, 1, batches), 'inflight_max within 1..batches; got ' + d.inflight_max);
  ok(e.srv.sessions[p.sid].input === text, 'still exactly the typed text after the report');
  cleanup(e);
});

test('long-poll pane with a hung report: keys still arrive whole and in order', async () => {
  const s = await setup({}); if (!s) return;          // no EventSource: long-poll
  const {e, p} = s;
  e.srv.hooks.client_lat = () => new Promise(() => {});
  slowShell(e, {rttMs: 40, echoMs: () => 5});
  await key(e, p, 'a');
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 1, 2000), 'the report is out (and hangs)');
  const text = 'b' + Array.from({length: 120}, (_, i) => String.fromCharCode(97 + (i * 11) % 26)).join('') + '\r';
  for (let i = 0; i < text.length; i++) { p.term._onData(text[i]); if (i % 9 === 0) await sleep(7); }
  ok(await until(() => e.srv.sessions[p.sid].input === 'a' + text, 5000),
     'every key once, in order; got ' + JSON.stringify(e.srv.sessions[p.sid].input.slice(-30)));
  ok(await until(() => termText(p).includes(text.slice(0, -1)), 3000), 'and the output still flows (long-poll not starved)');
  cleanup(e);
});

test('a report sent while keys are in flight (pagehide, then the page stays): order kept', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 120, echoMs: () => 5});
  const text = Array.from({length: 150}, (_, i) => String.fromCharCode(65 + (i * 5) % 26)).join('');
  for (let i = 0; i < text.length; i++) {
    p.term._onData(text[i]);
    if (i === 60) { await until(() => (e.srv.sessions[p.sid].batches || []).length >= 2, 3000); await sleep(150); e.win.dispatchEvent(new e.win.Event('pagehide')); e.win.dispatchEvent(Object.assign(new e.win.Event('pageshow'), {persisted: true})); }
    if (i % 10 === 0) await sleep(15);
  }
  ok(await until(() => e.srv.sessions[p.sid].input === text, 6000),
     'every key once, in order; got ' + JSON.stringify(e.srv.sessions[p.sid].input.slice(-30)));
  ok(allReports(e).length === 1, 'the pagehide report went once; got ' + allReports(e).length);
  await sleep(300);
  await e.clock.advance(5 * MIN + 1000);
  ok(await until(() => allReports(e).length === 2, 2000), 'reporting goes on after a bfcache return; got ' + allReports(e).length);
  const total = allReports(e).map(r => ((bodyOf(r).panes || [])[0] || {}).n || 0).reduce((a, b) => a + b, 0);
  const batches = (e.srv.sessions[p.sid].batches || []).length;
  ok(total === batches, 'every batch counted exactly once across the two reports: ' + total + ' vs ' + batches);
  cleanup(e);
});

test('pagehide right after a key: that batch is in the report too', async () => {
  const s = await setup({eventSource: 'live', latReply: OK200}); if (!s) return;
  const {e, p} = s;
  slowShell(e, {rttMs: 20, echoMs: () => 10});
  for (const c of 'ab') await key(e, p, c);
  e.clock.paintMs = 400;                       // the last key: echoed, not yet rendered
  const before = termText(p).length;
  p.term._onData('c');
  await until(() => termText(p).length > before, 2000);
  await sleep(60);                             // reply and echo in, render still to come
  e.win.dispatchEvent(new e.win.Event('pagehide'));
  ok(await until(() => allReports(e).length === 1, 1000), 'a report on pagehide');
  const d = ((bodyOf(allReports(e)[0] || {body: '{}'}).panes) || [])[0] || {};
  ok(d.n === 3, 'n = 3: the batch sent just before the page went away counts; got ' + d.n);
  ok(d.n_echo === 3, 'and its echo had arrived: n_echo = 3; got ' + d.n_echo);
  cleanup(e);
});

// =====================================================================
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
