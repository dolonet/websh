// Plain uploads (sealed mode off) through what the owner's Mac does: an
// endpoint-security product intercepting HTTPS answers every
// application/octet-stream POST itself with 503 text/html (it never
// reaches websh); JSON passes. Plain uploads from there failed 26 times
// out of 29 (12-21 Oct). What must hold (upload-text spec): the first
// upload switches to text pieces when its binary piece is blocked and
// lands byte-identical, the user is told once; the browser remembers it,
// so after a reload the next upload is text from its first piece - no
// blocked request at all - and lands byte-identical too.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { until, tagOf } from '../lib.mjs';
export const meta = { about: 'plain uploads through an interceptor that answers octet-stream POSTs 503: text fallback, remembered across a reload, files identical', ssh: true, local: true };

function middlebox(upstream) {
  const sockets = new Set();
  const seen = { blocked: 0, json: 0 };
  const srv = http.createServer((req, res) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (req.method === 'POST' && ct === 'application/octet-stream') {
      seen.blocked++;
      req.resume();
      req.on('end', () => {
        const body = Buffer.from('<html><head><title>503 Service Unavailable</title></head><body>Blocked by policy</body></html>');
        res.writeHead(503, { 'Content-Type': 'text/html', 'Content-Length': body.length });
        res.end(body);
      });
      req.on('error', () => {});
      return;
    }
    if (req.method === 'POST' && /action=upload&/.test(req.url) && ct === 'application/json') seen.json++;
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

async function uploadOne(b, t, i, name, size, what) {
  const digest = await b.ev(`(async () => {
    const buf = new Uint8Array(${size}); for (let k = 0; k < buf.length; k += 65536)
      crypto.getRandomValues(buf.subarray(k, Math.min(k + 65536, buf.length)));
    window._f = new File([buf], ${JSON.stringify(name)});
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('');
  })()`);
  await b.ev(`(() => { const p = Object.values(panes)[${i}]; handleUpload(p.id, { files: [window._f], value: '' }); return 1; })()`);
  const banner = () => b.ev(`(() => { const p = Object.values(panes)[${i}];
    const e = p.el.querySelector('[data-upload-progress] .upload-progress-text'); return e ? e.textContent : ''; })()`);
  const done = await until(async () => /Saved to|Upload complete|Upload failed/.test(await banner()), 90000);
  const text = await banner();
  t.ok(done >= 0 && /Saved to|Upload complete/.test(text), `${what}: upload finished (${JSON.stringify(text)})`);
  const dest = ((text.match(/Saved to (\S+)/) || [])[1] || path.join(os.homedir(), name)).replace(/^~(?=\/)/, os.homedir());
  if (fs.existsSync(dest)) {
    const got = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    t.ok(fs.statSync(dest).size === size && got === digest, `${what}: sha256 on disk equals the file in the browser (${fs.statSync(dest).size} bytes)`);
    fs.unlinkSync(dest);
  } else t.ok(false, `${what}: file not found on disk at ${dest}`);
}

export async function run({ b, t, port }) {
  const mb = await middlebox(port);
  try {
    await b.open(`http://127.0.0.1:${mb.port}/`);
    // A plain-upload scenario: under E2E_SEALED=1 the mode is switched
    // off here (sealed uploads are text already).
    if (await b.ev('settings.sealed'))
      await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
    t.ok(!(await b.ev('settings.sealed')), 'sealed mode off');
    await b.ev(`(() => { try { localStorage.removeItem('websh_upload_text'); } catch (e) {} return 1; })()`);
    let i = await b.connect();
    await b.type(i, 'cd ~\r');
    const toasts = () => b.ev(`Array.from(document.querySelectorAll('#toastHost *')).map(e => e.textContent).join(' | ')`);
    // First upload: the binary piece is blocked, the upload switches.
    await uploadOne(b, t, i, `websh-e2e-upblk1-${tagOf('a')}.bin`, 6 * 1024 * 1024 + 123, 'first upload');
    const blocked1 = mb.seen.blocked;
    t.ok(blocked1 >= 1, `the interceptor blocked the binary attempt (${blocked1})`);
    t.ok(mb.seen.json >= 2, `then text pieces went through (${mb.seen.json})`);
    t.ok(/Binary uploads are blocked on this computer/.test(await toasts()), 'the user was told');
    const mark = await b.ev(`localStorage.getItem('websh_upload_text')`);
    t.ok(mark && Math.abs(+mark - Date.now()) < 120000, `remembered in this browser (${mark})`);
    // Second upload, after a reload: text from the first piece.
    // A fresh page in the same browser: close the pane (so the layout is
    // not restored), keep the browser's storage - the mark included.
    await b.ev(`(() => { for (const id of Object.keys(panes)) closePane(id); return 1; })()`);
    await until(async () => (await b.ev('Object.keys(panes).length')) === 0, 5000);
    await b.open(`http://127.0.0.1:${mb.port}/`);
    t.ok(await b.ev(`localStorage.getItem('websh_upload_text') !== null`), 'the mark survived the reload');
    if (await b.ev('settings.sealed'))      // E2E_SEALED=1 switches it on at every page load
      await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
    i = await b.connect();
    await b.type(i, 'cd ~\r');
    const before = mb.seen.blocked, jsonBefore = mb.seen.json;
    await uploadOne(b, t, i, `websh-e2e-upblk2-${tagOf('b')}.bin`, 2 * 1024 * 1024 + 7, 'second upload (after a reload)');
    t.ok(mb.seen.blocked === before, `no blocked request this time (${mb.seen.blocked - before})`);
    t.ok(mb.seen.json > jsonBefore, 'it went as text');
  } finally {
    try { await b.endAll(); } catch (e) {}
    await mb.stop();
    try { await b.open(`http://127.0.0.1:${port}/`); } catch (e) {}
  }
}
