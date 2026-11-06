// Sealed mode in a real browser: turned on in Options while a pane is
// live, typing still echoes, an upload lands byte-identical, and what
// Chromium itself puts on the network (DevTools' view: what a TLS-
// inspecting proxy would read) carries no session id, no typed text, no
// output, no file name and no file content - only seal_open and
// sealed&c=<channel> after the switch. Every upload piece request has one
// size. The owner's request (2026-10): "nobody between my browser and my
// server may read, or even partly understand, what I type or upload".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sleep, until, tagOf, cfg } from '../lib.mjs';

const KEY = path.join(os.tmpdir(), `websh-e2e-sealed-${process.pid}.key`);
export const meta = {
  about: 'sealed mode switched on with a live pane: echo, byte-identical upload, nothing readable on the wire',
  ssh: true, local: true,
  env: { WEBSH_SEALED_KEY_FILE: KEY },
};

// A page that stops answering must fail the scenario, not hang the run.
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('no answer from the page within ' + ms + ' ms: ' + what)), ms))]);

export async function run({ b, t, port }) {
  // Record every request Chromium sends, with its body.
  const reqs = new Map(), lengths = new Map();
  const orig = b._on.bind(b);
  b._on = d => {
    const p = d.params;
    if (d.method === 'Network.requestWillBeSent') {
      const r = p.request;
      let body = Buffer.alloc(0);
      if (r.postDataEntries) body = Buffer.concat(r.postDataEntries.map(e => e.bytes ? Buffer.from(e.bytes, 'base64') : Buffer.alloc(0)));
      else if (r.postData) body = Buffer.from(r.postData, 'latin1');
      const hh = r.headers || {};
      reqs.set(p.requestId, { id: p.requestId, url: r.url, method: r.method, body, hasPost: !!r.hasPostData, at: Date.now(), done: false,
                              ctype: hh['Content-Type'] || hh['content-type'] || '' });
    }
    if (d.method === 'Network.requestWillBeSentExtraInfo') {
      const h = p.headers || {};
      const cl = h['content-length'] || h['Content-Length'];
      if (cl !== undefined) lengths.set(p.requestId, +cl);
    }
    if (d.method === 'Network.loadingFinished' && reqs.has(p.requestId)) reqs.get(p.requestId).done = true;
    orig(d);
  };
  try {
    const i = await b.connect();
    const sid = await b.ev(`Object.values(panes)[${i}].sid`);
    t.ok(!!sid, 'plain pane connected');
    const tag = tagOf('S');

    // (Under E2E_SEALED=1 the harness has switched it on already: a
    // click would switch it off. Off first, so the switch is still seen.)
    if (await b.ev('settings.sealed === true')) {
      await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
      await sleep(1500);   // let what the switch-off restarted go out before the window below opens
    }
    // The switch, the way the user does it.
    const tSwitch = Date.now();
    await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
    t.ok(await b.ev('settings.sealed === true'), 'setting on after the click');
    const badge = await until(() => b.ev(`(() => { const e = document.getElementById('sealedBadge'); return !!e && !e.classList.contains('h') && !e.hidden && getComputedStyle(e).display !== 'none'; })()`), 10000);
    t.ok(badge >= 0, 'lock badge shown once the channel is up');

    // The fingerprint the browser trusts is the one the server logged.
    const log = fs.readFileSync(path.join(os.tmpdir(), `websh-e2e-${port}.log`), 'utf8');
    const fps = [...log.matchAll(/sealed channel: identity ([0-9A-F]{4}(?: [0-9A-F]{4}){15})/g)].map(m => m[1]);
    const fp = fps[fps.length - 1];
    t.ok(!!fp, 'the server logged its identity fingerprint at start');
    const shown = await b.ev(`(() => { openOptions(); const e = document.getElementById('optSealedPin'); const s = e ? e.textContent : ''; closeOptions(); return s; })()`);
    t.ok(fp && shown.includes(fp), `Options shows the same fingerprint (${JSON.stringify(shown).slice(0, 90)})`);

    // Typing: the echo comes back.
    await b.type(i, `echo SEAL_$((6*7))_${tag}\r`);
    const echoed = await until(async () => (await b.lines(i)).includes(`SEAL_42_${tag}`), 10000);
    t.ok(echoed >= 0, 'typed text is executed and its output is on screen');

    // An upload: 1.3 MB of random bytes with a marker inside.
    const name = `sealed-e2e-${tag}.bin`;
    const size = 1300 * 1024 + 17;
    // Pieces of 128 KiB: small enough that DevTools hands over every
    // body (lib.mjs caps it at 256 KiB), many enough to compare sizes.
    await b.ev(`(() => { try { UPLOAD_CHUNK_BYTES = 128 * 1024; } catch (e) {} return 1; })()`);
    t.note('building the file in the page');
    const digest = await within(b.ev(`(async () => {
      const buf = new Uint8Array(${size});
      for (let k = 0; k < buf.length; k += 65536) crypto.getRandomValues(buf.subarray(k, Math.min(k + 65536, buf.length)));
      buf.set(new TextEncoder().encode('UPLOADMARK-${tag}'), 4096);
      window._sf = new File([buf], ${JSON.stringify(name)});
      const h = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('');
    })()`), 20000, 'building the file');
    t.note('uploading');
    await within(b.ev(`(() => { const p = Object.values(panes)[${i}]; handleUpload(p.id, { files: [window._sf], value: '' }); return 1; })()`), 20000, 'starting the upload');
    const banner = () => within(b.ev(`(() => { const p = Object.values(panes)[${i}];
      const e = p.el.querySelector('[data-upload-progress] .upload-progress-text'); return e ? e.textContent : ''; })()`), 20000, 'reading the upload banner');
    const done = await until(async () => /Saved to|Upload complete|Upload failed/.test(await banner()), 60000);
    const text = await banner();
    t.ok(done >= 0 && /Saved to|Upload complete/.test(text), 'upload finished: ' + JSON.stringify(text));
    const dest = (text.match(/Saved to (\S+)/) || [])[1] || path.join(os.homedir(), name);
    const local = dest.replace(/^~(?=\/)/, os.homedir());
    if (fs.existsSync(local)) {
      const got = createHash('sha256').update(fs.readFileSync(local)).digest('hex');
      t.ok(fs.statSync(local).size === size, `size on disk ${fs.statSync(local).size} = ${size}`);
      t.ok(got === digest, 'sha256 on disk equals the file in the browser');
      fs.unlinkSync(local);
    } else {
      t.note(`target ${cfg.host}: ${local} not on this machine; checked the banner only`);
      await b.type(i, `rm -f ${JSON.stringify(dest)}\r`);
    }

    // What crossed the network after the switch.
    await sleep(300);
    const after = [...reqs.values()].filter(r => r.at >= tSwitch);
    const unseen = after.filter(r => r.hasPost && !r.body.length).length;
    t.ok(unseen === 0, `every request body after the switch was inspected (${unseen} not available)`);
    for (const r of after) r.len = lengths.has(r.id) ? lengths.get(r.id) : r.body.length;
    const api = after.filter(r => /api\.php|\/api\//.test(r.url));
    t.ok(api.length > 0, `${api.length} API requests after the switch`);
    const badUrls = api.filter(r => !/[?&]action=(seal_open|config|ping)$/.test(r.url) && !/[?&]action=sealed&c=[0-9a-f]{32}$/.test(r.url));
    t.ok(badUrls.length === 0, 'only seal_open / sealed&c=<channel> (and config/ping) in URLs' + (badUrls.length ? ': ' + badUrls.slice(0, 3).map(r => r.url).join(' | ') : ''));
    // Revision 2: sealed requests are JSON text {"f": base64}, replies
    // text/event-stream of base64 frames. Search the raw text and every
    // base64 run decoded.
    const b64runs = buf => Buffer.concat((buf.toString('latin1').match(/[A-Za-z0-9+/]{16,}={0,2}/g) || []).map(m => Buffer.from(m, 'base64')));
    for (const r of api) r.decoded = b64runs(r.body);
    const octet = api.filter(r => /octet-stream/i.test(r.ctype));
    t.ok(api.filter(r => /action=sealed&/.test(r.url)).every(r => /^application\/json/i.test(r.ctype)), 'every sealed request is sent as application/json');
    t.ok(octet.length === 0, `no request after the switch is application/octet-stream (${octet.length})`);
    const secrets = { 'session id': sid, 'typed text': 'SEAL_$((6*7))', 'tag': tag, 'file name': name, 'file content': 'UPLOADMARK', 'JSON key session_id': 'session_id', 'JSON key data': '"data"' };
    for (const [what, s] of Object.entries(secrets)) {
      const inUrl = api.filter(r => r.url.includes(s));
      const inBody = api.filter(r => r.body.includes(Buffer.from(s)) || r.decoded.includes(Buffer.from(s)));
      t.ok(inUrl.length === 0 && inBody.length === 0, `${what} not in clear (urls: ${inUrl.length}, bodies: ${inBody.length})`);
    }
    // Replies: the finished ones can be read back from DevTools.
    let readable = 0, leaks = [];
    for (const r of api.filter(x => x.done)) {
      try {
        const x = (await b.send('Network.getResponseBody', { requestId: r.id })).result;
        if (!x) continue;
        readable++;
        const body = Buffer.from(x.body, x.base64Encoded ? 'base64' : 'utf8');
        const dec = b64runs(body);
        for (const s of [sid, `SEAL_42_${tag}`, name, 'session_id'])
          if (body.includes(Buffer.from(s)) || dec.includes(Buffer.from(s))) leaks.push(r.url.replace(/.*action=/, '') + ' has ' + s.slice(0, 12));
      } catch (e) {}
    }
    t.note(`${readable} reply bodies inspected`);
    t.ok(leaks.length === 0, 'no reply carries the session id, the output or the file name in clear' + (leaks.length ? ': ' + leaks.slice(0, 3).join(' | ') : ''));
    // Upload pieces: one size on the wire. The pieces are the big ones.
    const big = api.filter(r => /action=sealed/.test(r.url) && r.len > 32 * 1024).map(r => r.len);
    t.note('large sealed request sizes: ' + [...new Set(big)].join(', '));
    t.ok(big.length > 0, 'the upload went as sealed pieces');
    t.ok(new Set(big).size <= 1, 'every upload piece request has the same size on the wire');
    t.ok(big.reduce((a, x) => a + x, 0) >= size, 'at least the file size crossed the network');

    // Still typing after all that.
    await b.type(i, `echo AGAIN_$((1+2))_${tag}\r`);
    t.ok(await until(async () => (await b.lines(i)).includes(`AGAIN_3_${tag}`), 10000) >= 0, 'typing still works');
    await b.type(i, 'exit\r');
  } finally {
    b._on = orig;
    try { fs.unlinkSync(KEY); } catch (e) {}
  }
}
