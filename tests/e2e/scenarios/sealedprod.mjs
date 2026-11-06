// Sealed mode behind a front built like production (nginx stream{} with
// PROXY protocol -> an ssl vhost, HTTP/2, proxy_request_buffering off;
// lib.mjs ProdFront; E2E_PROD_H1=1 for the HTTP/1.1 variant). The owner (2026-10-21, Chrome on a Mac,
// several persistent panes) switched sealed mode on and every pane
// showed "[websh: HTTP 503 (unexpected reply from the server or a
// proxy)]"; nginx logged every action=sealed as 400 or 499 with no
// body, not one 200. What must hold: switched on with N panes open,
// every pane keeps working - typed text comes back - and sealed requests
// get answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, until, tagOf, cfg } from '../lib.mjs';
const N = +(process.env.E2E_SEALEDPROD_PANES || 6);
export const meta = { about: `sealed mode on behind a production-like front (nginx stream + PROXY protocol, HTTP/2), ${N} persistent panes switched on live: all keep working`, ssh: true, local: true, front: 'prod' };

export async function run({ b, t, front }) {
  const reqs = new Map(), all = new Map();
  let tOn = 0;
  const open = at => [...all.values()].filter(r => r.at <= at && (!r.end || r.end > at)).map(r => r.a + '/' + r.type);
  const orig = b._on.bind(b);
  b._on = d => {
    const p = d.params || {};
    if (d.method === 'Network.requestWillBeSent' && /action=/.test(p.request.url)) all.set(p.requestId, { a: (p.request.url.match(/action=(\w+)/) || [])[1], type: p.type, at: Date.now() });
    if ((d.method === 'Network.loadingFinished' || d.method === 'Network.loadingFailed') && all.has(p.requestId)) all.get(p.requestId).end = Date.now();
    if (d.method === 'Network.requestWillBeSent' && /action=sealed/.test(p.request.url)) reqs.set(p.requestId, { at: Date.now(), size: (p.request.postData || '').length, hasPost: p.request.hasPostData });
    if (d.method === 'Network.requestWillBeSentExtraInfo' && reqs.has(p.requestId)) reqs.get(p.requestId).hdr = p.headers;
    if (d.method === 'Network.responseReceived' && reqs.has(p.requestId)) { const r = reqs.get(p.requestId); r.status = p.response.status; r.proto = p.response.protocol; }
    if (d.method === 'Network.loadingFailed' && reqs.has(p.requestId)) { const r = reqs.get(p.requestId); r.fail = p.errorText + (p.canceled ? ' (canceled)' : ''); }
    if (d.method === 'Network.loadingFinished' && reqs.has(p.requestId)) reqs.get(p.requestId).done = true;
    orig(d);
  };
  try {
    const panes = [await b.connect({ persistent: true })];
    // A grid, not six slivers: split alternately down and across so no
    // pane is a few columns wide (a 6-column tmux pane garbles readline's
    // redraw and the check could not read its own output).
    const plan = [[0, 'v'], [0, 'h'], [1, 'h'], [2, 'h'], [3, 'h'], [4, 'v'], [5, 'v']];
    for (let k = 1; k < N; k++) {
      const [from, dir] = plan[k - 1];
      const before = await b.ev('Object.keys(panes).length');
      await b.ev(`(() => { splitPane(Object.keys(panes)[${from}], ${JSON.stringify(dir)}); ${b._fill(true)} doConnect(); return 1; })()`);
      panes.push(await b._ready(before));
    }
    t.note('pane sizes: ' + JSON.stringify(await b.ev(`Object.values(panes).map(p => [p.term.cols, p.term.rows])`)));
    t.ok(panes.length === N, `${N} persistent panes connected (plain)`);
    // The owner is far from the server: a real round trip.
    const lat = +(process.env.E2E_SEALEDPROD_LATENCY || 80);
    if (lat) await b.network({ latency: lat });
    // E2E_SEALEDPROD_PLAIN=1: the same without sealed mode (the control).
    const plainOnly = process.env.E2E_SEALEDPROD_PLAIN === '1';
    if (!plainOnly && !(await b.ev('settings.sealed')))
      await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
    t.ok(plainOnly || await b.ev('settings.sealed === true'), 'sealed mode on');
    tOn = Date.now();
    await sleep(1500);
    t.note('requests open just before the switch: ' + JSON.stringify(open(tOn - 50)));
    t.note('requests open 1.5 s after it: ' + JSON.stringify(open(Date.now())));
    const tag = tagOf('P');
    // Six persistent (tmux) panes split side by side are a few columns
    // wide, and tmux scrolls inside its own screen: a long echoed line can
    // leave the terminal before it is read. So each pane runs a command
    // whose effect is checked on disk (the target is this machine when
    // the file shows up there) and whose output is short (Z<i*7+40>).
    const marks = panes.map(i => path.join(os.homedir(), `.websh-e2e-sp-${tag}-${i}`));
    for (const i of panes) await b.type(i, `touch ~/.websh-e2e-sp-${tag}-${i}; echo Z$((${i}*7+40))\r`);
    const results = [];
    for (const i of panes) {
      const want = 'Z' + (i * 7 + 40);
      const seen = await until(async () => (await b.screen(i)).replace(/\n/g, '').includes(want), 15000);
      const local = fs.existsSync(marks[i]) || await until(async () => fs.existsSync(marks[i]), 3000) >= 0;
      results.push(seen >= 0);
      t.ok(seen >= 0, `pane ${i}: the command's output came back` + (seen < 0 ? '; screen: ' + JSON.stringify((await b.lines(i)).filter(Boolean).slice(-40)) + ' size ' + JSON.stringify(await b.ev(`(() => { const p = Object.values(panes)[${i}]; return [p.term.cols, p.term.rows]; })()`)) : ''));
      if (cfg.host === '127.0.0.1' || fs.existsSync(path.dirname(marks[i]))) t.ok(local, `pane ${i}: the typed command ran (its file exists)`);
      try { fs.unlinkSync(marks[i]); } catch (e) {}
    }
    t.note('pane transports: ' + JSON.stringify(await b.state()));
    t.note('requests by action (inner actions too under E2E_SEALED=1): ' + JSON.stringify(b.requests));
    const errs = await b.ev(`Object.values(panes).map(p => { const t = p.term.buffer.active; let s = ''; for (let y = 0; y < t.length; y++) { const l = t.getLine(y); if (l) s += l.translateToString(true) + '\\n'; } return (s.match(/\\[websh:[^\\]]*\\]/g) || []).slice(-2); })`);
    t.ok(errs.every(e => e.length === 0), 'no "[websh: ...]" error in any pane: ' + JSON.stringify(errs));
    const all = [...reqs.values()];
    const by = {};
    for (const r of all) { const k = r.status ? 'status ' + r.status : r.fail ? 'failed: ' + r.fail : r.done ? 'done?' : 'pending'; by[k] = (by[k] || 0) + 1; }
    t.note('sealed requests from the browser: ' + JSON.stringify(by));
    t.note('protocol: ' + [...new Set(all.map(r => r.proto).filter(Boolean))].join(','));
    const log = front.accessLog().split('\n').filter(l => /action=sealed/.test(l));
    const st = {};
    for (const l of log) { const m = l.match(/" (\d{3}) (\d+) /); if (m) { const k = m[1] + (m[2] === '0' ? ' (empty)' : ''); st[k] = (st[k] || 0) + 1; } }
    t.note('nginx access log, action=sealed: ' + JSON.stringify(st));
    if (!plainOnly) t.ok(log.some(l => /" 200 /.test(l)), 'nginx saw at least one sealed 200');
    const bad = log.filter(l => /" (400|499) /.test(l));
    t.ok(bad.length === 0, `no sealed 400/499 at nginx (${bad.length})` + (bad.length ? ': ' + bad.slice(0, 2).join(' | ') : ''));
  } finally { b._on = orig; }
}
