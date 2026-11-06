// The owner's network (2026-10-21, IP 86.110.203.190): sealed mode on,
// every pane "[websh: HTTP 503 (unexpected reply from the server or a
// proxy)]". What nginx saw from that address: every action=sealed POST
// (application/octet-stream, ~150-300 bytes of ciphertext) ended 400 or
// 499 with no byte sent back, not one 200; seal_open (JSON) 200; the
// plain JSON POSTs (input) all 200; and plain octet-stream uploads from
// the same address have ended "400 / 499, empty" since 12 Oct (the O7b
// proxy). nginx never answered 503: the 503 the page got came from
// something between the browser and nginx. This middlebox does what
// those measurements show - confirmed on the owner's machine with a probe:
// an application/octet-stream POST is answered 503 text/html by the box
// and never reaches websh; JSON (and base64 text) POSTs and
// text/event-stream replies pass.
//
// What must hold (the spec's purpose: networks that inspect HTTPS): with
// sealed mode on, typing still works through such a box, and nothing
// goes out in clear.
import http from 'node:http';
import { sleep, until, tagOf } from '../lib.mjs';
export const meta = { about: 'sealed mode through a middlebox that refuses application/octet-stream POST bodies (the owner\'s network): typing still works', ssh: true, local: true };

function middlebox(upstream) {
  const sockets = new Set();
  const seen = { block: true, blocked: 0, passed: 0, types: {} };
  const srv = http.createServer((req, res) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (req.method === 'POST') seen.types[ct || '(none)'] = (seen.types[ct || '(none)'] || 0) + 1;
    if (seen.block && req.method === 'POST' && ct === 'application/octet-stream') {
      // Measured on the owner's Mac (2026-10-21, endpoint-security
      // software intercepting HTTPS, script injected into the page): an
      // application/octet-stream POST - random or zero bytes - is
      // answered by the interceptor itself, 503 text/html, and never
      // reaches websh. The same bytes as base64 in text/plain or JSON
      // pass; JSON POSTs and text/event-stream replies pass.
      seen.blocked++;
      req.resume();
      req.on('end', () => {
        const body = Buffer.from('<html><head><title>503 Service Unavailable</title></head><body>Request blocked</body></html>');
        res.writeHead(503, { 'Content-Type': 'text/html', 'Content-Length': body.length });
        res.end(body);
      });
      req.on('error', () => {});
      return;
    }
    seen.passed++;
    const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers: req.headers },
      ur => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => { try { res.destroy(); } catch (e) {} });
    req.pipe(up);
  });
  srv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({
    port: srv.address().port, seen,
    stop: () => { sockets.forEach(s => { try { s.destroy(); } catch (e) {} }); return new Promise(q => srv.close(q)); },
  })));
}

export async function run({ b, t, port }) {
  const mb = await middlebox(port);
  const urls = [];
  const orig = b._on.bind(b);
  b._on = d => { if (d.method === 'Network.requestWillBeSent') urls.push({ url: d.params.request.url, body: d.params.request.postData || '' }); orig(d); };
  try {
    await b.open(`http://127.0.0.1:${mb.port}/`);
    const i = await b.connect();
    const tag = tagOf('B');
    await b.type(i, `echo ${tag}_plain_$((1+1))\r`);
    t.ok(await until(async () => (await b.lines(i)).includes(`${tag}_plain_2`), 8000) >= 0, 'control: plain mode works through this box');
    if (!(await b.ev('settings.sealed')))
      await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
    t.ok(await b.ev('settings.sealed === true'), 'sealed mode on');
    await sleep(1000);
    const n0 = urls.length;
    await b.type(i, `echo ${tag}_sealed_$((40+2))\r`);
    const ok = await until(async () => (await b.lines(i)).includes(`${tag}_sealed_42`), 15000);
    const screen = (await b.lines(i)).filter(Boolean);
    t.ok(ok >= 0, 'sealed: typed text comes back through the box' + (ok < 0 ? '; screen: ' + JSON.stringify(screen.slice(-3)) : ''));
    t.ok(!screen.some(l => /\[websh: HTTP 503/.test(l)), 'no "[websh: HTTP 503 ...]" in the pane');
    // Long enough for the output loop to report what it got.
    await sleep(4000);
    t.note('pane shows: ' + JSON.stringify((await b.lines(i)).filter(Boolean).slice(-2)));
    t.note(`middlebox: ${JSON.stringify(mb.seen)}`);
    const clear = urls.slice(n0).filter(u => /api\.php/.test(u.url) && !/action=(seal_open|sealed|config|ping)\b/.test(u.url));
    t.ok(clear.length === 0, 'nothing sent in clear after the switch' + (clear.length ? ': ' + clear.slice(0, 3).map(u => u.url).join(' | ') : ''));
    t.ok(!urls.slice(n0).some(u => u.body.includes(tag)), 'the typed text never in a request body in clear');
  } finally {
    b._on = orig;
    // Let the harness end the test session through the box.
    mb.seen.block = false;
    try {
      if (await b.ev('settings.sealed')) await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
      const end = await b.endAll();
      t.note(`ended ${end.ended} test session(s) before closing the box` + (end.left.length ? '; NOT ended: ' + end.left.join(', ') : ''));
    } catch (e) { t.note('could not end the test session: ' + e.message.slice(0, 120)); }
    await mb.stop();
    try { await b.open(`http://127.0.0.1:${port}/`); } catch (e) {}   // the runner's own cleanup needs a live page
  }
}
