// A middlebox between the browser and websh that behaves like the owner's
// corporate proxy: small POST bodies pass, a POST body over a threshold is
// truncated. Measured on that network: GET (download) of a 1.2 MB file
// works; a normal-file upload POST is cut while a couple-of-KB file passes
// - so the proxy limits uploads by SIZE/DURATION, not outright. nginx
// logged the first 4 MB piece as 400 ("client sent fewer bytes than
// Content-Length"), retried every ~2 min, ~6 times, then gave up; the
// progress bar sat at 0% with no message for many minutes.
//
// INTEGRATION LAYER (real browser -> real proxy -> real server -> real
// ssh), the honest companion to the deterministic unit checks in
// tests/frontend/test_connect.js. Two phases, each a current-code FAIL:
//
//   B (cut400): over-size pieces get a clean 400 "fewer bytes" (the
//     owner's logged signature). The upload must still COMPLETE by
//     shrinking - the small pieces pass through to the server - and the
//     file on disk must be byte-identical (sha256). Current code treats
//     the 400 as final and gives up on the first piece: never completes.
//
//   A (stall): over-size pieces are accepted but no response is ever
//     sent (mimics the 120 s stall). The user must get a VISIBLE failure
//     banner FAST (seconds, within the bound below), not after the full
//     try budget of 120 s timeouts (~16 min of a 0% bar). Current code
//     has no wall-clock cap: nothing shows within the bound.
//
// The threshold is > the 256 KB shrink floor so that, in cut400, shrinking
// can reach a size that passes.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sleep, until, cfg } from '../lib.mjs';

export const meta = { about: 'a size-limiting proxy: upload completes by shrinking, and a stall fails fast', ssh: true, local: true };

const THRESHOLD = 1024 * 1024;              // bodies over 1 MB are cut
const STALL_FAIL_BOUND_MS = 45000;          // a stall must surface a failure within this

// A streaming HTTP proxy to 127.0.0.1:<upstream>. Everything is piped
// through untouched (so SSE output, input POSTs, config all work) EXCEPT a
// POST /api/upload piece whose Content-Length is over THRESHOLD, which is
// handled per `mode`.
function startMiddlebox(upstream) {
  const held = [];                          // stalled sockets, destroyed on stop
  const sockets = new Set();                // every live socket, so close() can't hang
  let mode = 'pass';
  // A sealed upload piece (E2E_SEALED=1) is a large POST to action=sealed:
  // the proxy cannot see more than that, and does not need to - it cuts
  // by size.
  const isUploadPiece = url => /[?&]action=upload&/.test(url) || /[?&]action=sealed&/.test(url);
  const srv = http.createServer((req, res) => {
    const clen = +(req.headers['content-length'] || 0);
    if (req.method === 'POST' && isUploadPiece(req.url) && clen > THRESHOLD) {
      if (mode === 'cut400') {
        // Drain the body, then answer a clean 400 like the owner's proxy.
        req.resume();
        req.on('end', () => {
          const body = Buffer.from(JSON.stringify(
            { error: 'client sent fewer bytes than Content-Length' }));
          res.writeHead(400, { 'Content-Type': 'application/json',
                               'Content-Length': body.length });
          res.end(body);
        });
        req.on('error', () => {});
        return;
      }
      if (mode === 'stall') {
        // Accept the whole body, then never reply.
        req.resume();
        held.push(res);
        req.on('error', () => {});
        return;
      }
    }
    // Transparent pass-through.
    const up = http.request(
      { host: '127.0.0.1', port: upstream, method: req.method,
        path: req.url, headers: req.headers },
      ur => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => { try { res.destroy(); } catch (e) {} });
    req.pipe(up);
  });
  srv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      setMode: m => { mode = m; },
      // Destroy EVERY socket (the long-lived SSE stream would otherwise
      // keep srv.close() from ever calling back and hang the scenario).
      stop: () => { held.forEach(r => { try { r.destroy(); } catch (e) {} });
                    sockets.forEach(s => { try { s.destroy(); } catch (e) {} });
                    return new Promise(r => srv.close(r)); },
    }));
  });
}

async function makeFileInPage(b, i, name, size) {
  return b.ev(`(async () => {
    const buf = new Uint8Array(${size}); for (let k = 0; k < buf.length; k += 65536)
      crypto.getRandomValues(buf.subarray(k, Math.min(k + 65536, buf.length)));
    window._f = new File([buf], ${JSON.stringify(name)});
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('');
  })()`);
}
const bannerOf = (b, i) => b.ev(`(() => { const p = Object.values(panes)[${i}];
  const e = p.el.querySelector('[data-upload-progress] .upload-progress-text'); return e ? e.textContent : ''; })()`);
const startUpload = (b, i) => b.ev(`(() => { const p = Object.values(panes)[${i}];
  handleUpload(p.id, { files: [window._f], value: '' }); return 1; })()`);

export async function run({ b, t, port }) {
  const mb = await startMiddlebox(port);
  try {
    // Reload the page THROUGH the middlebox, then connect a persistent pane.
    await b.open(`http://127.0.0.1:${mb.port}/`);
    const i = await b.connect({ persistent: true });
    await b.type(i, 'cd ~\r');
    await sleep(500);

    // ── Phase B: cut400 — the upload must complete by shrinking ──────
    mb.setMode('cut400');
    const nameB = 'websh-e2e-trunc-' + Date.now() + '.bin';
    const sizeB = 6 * 1024 * 1024;
    const digestB = await makeFileInPage(b, i, nameB, sizeB);
    await startUpload(b, i);
    const doneB = await until(async () =>
      /Saved to|Upload complete|Upload failed|blocked|cut short/.test(await bannerOf(b, i)), 120000);
    const textB = await bannerOf(b, i);
    t.note(`cut400 banner: ${JSON.stringify(textB)}; upload requests: ${b.requests.upload}`);
    t.ok(doneB >= 0 && /Saved to|Upload complete/.test(textB),
         'upload completed despite the proxy cutting over-size pieces');

    const localB = path.join(os.homedir(), nameB);
    if (fs.existsSync(localB)) {
      const got = createHash('sha256').update(fs.readFileSync(localB)).digest('hex');
      t.ok(fs.statSync(localB).size === sizeB, `size on disk ${fs.statSync(localB).size} = ${sizeB}`);
      t.ok(got === digestB, 'sha256 on disk equals the file in the browser (byte-identical)');
      fs.unlinkSync(localB);
    } else {
      t.note(`target ${cfg.host} is not this machine: checked the banner only`);
      await b.type(i, `rm -f ~/${nameB}\r`);
    }

    // Let the success banner clear and the transfer slot free up.
    await until(async () => !(await b.ev(`!!Object.values(panes)[${i}].upload`)), 15000);

    // ── Phase A: stall — a failure must show FAST, not after 120 s ───
    mb.setMode('stall');
    const nameA = 'websh-e2e-hold-' + Date.now() + '.bin';   // no cause-word in the name
    const digestA = await makeFileInPage(b, i, nameA, 6 * 1024 * 1024);
    const t0 = Date.now();
    await startUpload(b, i);
    const failed = await until(async () =>
      /Upload failed|blocked|cut short/.test(await bannerOf(b, i)), STALL_FAIL_BOUND_MS);
    const elapsed = Date.now() - t0;
    const textA = await bannerOf(b, i);
    t.note(`stall banner after ${Math.round(elapsed / 1000)} s: ${JSON.stringify(textA)}`);
    t.ok(failed >= 0,
         `a stalled upload surfaced a VISIBLE failure within ${STALL_FAIL_BOUND_MS / 1000} s (got ${Math.round(elapsed / 1000)} s; banner=${JSON.stringify(textA)})`);
    // Only meaningful once a failure actually appeared: the reason must
    // name a probable cause, not leave a frozen progress bar.
    t.ok(failed >= 0 && /proxy|firewall|size|too large|network|blocking|blocked|no answer|stalled|timed out/i.test(textA),
         'the stall failure names a probable cause; got ' + JSON.stringify(textA));

    const localA = path.join(os.homedir(), nameA);
    try { if (fs.existsSync(localA)) fs.unlinkSync(localA); } catch (e) {}
  } finally {
    // Tear down THROUGH the still-live middlebox: cancel any stuck
    // upload and terminate the persistent tmux session ourselves, then
    // neutralise the panes so the runner's endAll (which would otherwise
    // run after the middlebox is gone and hang on the dead proxy, leaving
    // the session on the target) finds nothing to do.
    try {
      await b.ev(`(async () => {
        for (const p of Object.values(panes)) {
          p.polling = false;
          if (p.upload) { try { cancelUpload(p.id); } catch (e) {} }
          if (p.sid) { try { await api('disconnect', { body: { session_id: p.sid, terminate: true } }); } catch (e) {} }
          p.sid = null; p.persistent = false;
        }
        return 1;
      })()`);
    } catch (e) {}
    await mb.stop();
  }
}
