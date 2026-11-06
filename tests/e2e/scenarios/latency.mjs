// Typing latency reaches the server log (latency spec, 2026-10-25): keys
// typed into a real pane over a 100 ms link, the page goes away (pagehide:
// the report goes out with fetch keepalive / sendBeacon), and the private
// instance logs ONE `client_lat` line for that pane with numbers that fit
// what happened: n = the batches typed, rtt at least the link's 100 ms,
// p50 <= p90 <= max, total at least echo, nothing absurd.
//
// Plain mode only: with sealed mode on the pagehide report may be skipped
// (the spec allows it), so under E2E_SEALED=1 the scenario only notes what
// it saw.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { until } from '../lib.mjs';

export const meta = { about: 'typing in a pane leaves a client_lat line with plausible numbers in the log', ssh: true, local: true };

const STAGES = ['queue', 'rtt', 'echo', 'paint', 'total'];

function readFrom(file, offset) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const n = fs.fstatSync(fd).size - offset;
      if (n <= 0) return '';
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, offset);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) { return ''; }
}

// The log layout (see tests/backend/test_latency.py): panes split at sid=,
// `name p50/p90/max=a/b/c` (or `name=a/b/c`), worst as five numbers.
function parse(line) {
  const parts = line.split(/(?=\bsid=)/);
  const word = (s, k) => (s.match(new RegExp('(?<![\\w/])' + k + '=([^\\s\\]]*)')) || [])[1];
  const int = (s, k) => { const v = word(s, k); return v !== undefined && /^-?\d+$/.test(v) ? +v : null; };
  const stat = (s, k) => { const m = s.match(new RegExp('(?<![\\w/])' + k + '(?: p50/p90/max)?=(-?\\d+)/(-?\\d+)/(-?\\d+)\\b')); return m ? m.slice(1).map(Number) : null; };
  const worst = s => { const m = s.match(/(?<![\w/])worst(?: queue\/rtt\/echo\/paint\/total)?=(-?\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)\b/); return m ? m.slice(1).map(Number) : null; };
  return {
    window_ms: int(parts[0], 'window_ms'), vis: word(parts[0], 'vis'),
    panes: parts.slice(1).map(s => {
      const o = { sid: word(s, 'sid'), mode: word(s, 'mode'), sealed: word(s, 'sealed'),
                  n: int(s, 'n'), n_echo: int(s, 'n_echo'), slow: int(s, 'slow'),
                  inflight_max: int(s, 'inflight_max'), worst: worst(s) };
      for (const k of STAGES) o[k] = stat(s, k);
      return o;
    }),
  };
}

export async function run({ b, t, port }) {
  const logFile = path.join(os.tmpdir(), `websh-e2e-${port}.log`);
  const from = (() => { try { return fs.statSync(logFile).size; } catch (e) { return 0; } })();
  const i = await b.connect();
  const sid = (await b.state())[i].sid;
  t.ok((await b.state())[i].sse, 'output over SSE');
  const sealed = process.env.E2E_SEALED === '1';

  await b.network({ latency: 100 });
  // What actually went out: input requests that carry keys (a keepalive
  // is an input with empty data and is not a batch).
  let batches = 0;
  b.onInput(d => { if (d) batches++; });
  const word = 'echo lat' + (Date.now() % 1000);
  const keys = word + '\r';
  // One key at a time, each after the previous one's echo: one batch per key.
  let echoed = 0;
  const cursorX = () => b.ev(`(() => { const p = Object.values(panes)[${i}]; return p.term.buffer.active.cursorX; })()`);
  for (const c of word) {
    const x0 = await cursorX();
    await b.type(i, c);
    const ms = await until(async () => (await cursorX()) === x0 + 1, 3000, 5);
    if (ms >= 0) echoed++;
  }
  await b.type(i, '\r');
  const outLine = word.slice(5);
  await until(async () => (await b.lines(i)).includes(outLine), 3000, 20);
  await until(async () => /[$#]\s*$/.test((await b.screen(i)).trimEnd() + ' '), 3000, 20);
  await b.network({});
  t.ok(echoed === word.length, `every key echoed (${echoed}/${word.length})`);

  // The page goes away: pagehide.
  await b.send('Page.navigate', { url: 'about:blank' });
  let lines = [];
  const waited = await until(() => {
    lines = readFrom(logFile, from).split('\n').filter(l => /\[(INFO|WARN)\] client_lat\b/.test(l));
    return lines.length > 0;
  }, 10000, 100);
  // Back to websh, so the runner can end what is left.
  await b.open(b.url);

  if (sealed) {
    t.note(`sealed mode: ${lines.length} client_lat line(s) on pagehide (may be skipped)`);
    return;
  }
  t.ok(waited >= 0, `a client_lat line in the log after pagehide (${waited} ms)`);
  t.ok(lines.length === 1, `exactly one line; got ${lines.length}`);
  if (!lines.length) return;
  const line = lines[0];
  t.note(line.replace(/^.*?client_lat/, 'client_lat').slice(0, 600));
  const r = parse(line);
  const p = r.panes.find(x => x.sid === sid);
  t.ok(!!p, `the line has our pane (sid=${sid}); panes: ${r.panes.map(x => x.sid).join(',')}`);
  if (!p) return;
  t.ok(r.window_ms > 0 && r.window_ms < 5 * 60000, `window_ms is the part of the window that passed: ${r.window_ms}`);
  t.ok(r.vis === 'visible' || r.vis === 'hidden', `vis is a visibility state: ${r.vis}`);
  t.ok(p.mode === 'sse', `mode sse - the transport the window's keys and echo used, not the page's teardown: ${p.mode}`);
  t.ok(p.sealed === '0' || p.sealed === 'false', `sealed off: ${p.sealed}`);
  t.ok(p.n === batches, `n = the input requests that carried keys (${batches}, for ${keys.length} keys): ${p.n}`);
  t.ok(p.n_echo >= p.n - 1 && p.n_echo <= p.n, `n_echo: every batch but at most the last was echoed: ${p.n_echo} of ${p.n}`);
  for (const k of STAGES) {
    const s = p[k];
    t.ok(!!s && s[0] >= 0 && s[0] <= s[1] && s[1] <= s[2] && s[2] < 5000, `${k} p50<=p90<=max, under 5 s: ${s}`);
  }
  if (STAGES.every(k => p[k])) {
    t.ok(p.rtt[0] >= 90, `rtt p50 includes the 100 ms link: ${p.rtt[0]}`);
    // Chromium's emulated latency delays each request's reply, not the
    // chunks of the SSE stream already open: echo can be shorter than rtt.
    t.ok(p.total[0] >= p.echo[0], `total p50 >= echo p50: ${p.total[0]} vs ${p.echo[0]}`);
    t.ok(p.total[2] >= p.rtt[0], `total max >= rtt p50`);
    t.ok(p.queue[0] <= p.rtt[2] + 50, `a key waits at most behind one request in flight: queue p50 ${p.queue[0]}, rtt max ${p.rtt[2]}`);
  }
  t.ok(!!p.worst && p.worst[4] === p.total[2], `worst.total = total.max: ${p.worst} / ${p.total}`);
  t.ok(p.slow >= 0 && p.slow <= p.n, `slow within 0..n: ${p.slow}`);
  t.ok(p.inflight_max >= 1, `inflight_max >= 1: ${p.inflight_max}`);
  t.ok(!line.includes(word.slice(5)), 'no typed text in the log line');
}
