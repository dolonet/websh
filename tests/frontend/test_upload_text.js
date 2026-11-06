// Plain uploads (sealed mode off) fall back to a text body when binary
// is blocked (upload-text spec, 2026-10-21). Written from the spec.
//
// The owner's Mac: endpoint-security software intercepts HTTPS and
// answers every application/octet-stream POST itself with 503 text/html
// (nginx logs 400/499, 0 bytes); the same bytes as base64 in JSON pass.
// Plain uploads from there: 3 succeeded, 26 cut (12-21 Oct). What must
// hold:
//   - no mark in this browser: an upload is binary exactly as today;
//   - a piece answered by something that is not websh (503 text/html)
//     switches the upload to text at once - no halving first - and it
//     continues from the size the server has: the file lands whole and
//     byte-identical, nothing sent twice, no restart from zero;
//   - cuts (O7b) still happening at the minimum piece size switch too;
//   - the switch is remembered (localStorage websh_upload_text = the time
//     it was set) for 30 days: uploads then start as text; a storage
//     failure only means the next upload probes again;
//   - never text unless /api/config says upload_text: true;
//   - one toast, once;
//   - the file browser, drag-and-drop and several files at once take
//     the same path.
//
// The fake server and the interceptor are in sealed_harness.js
// (blockBinary / cutBinary).

const {sleep, until, enc, dec, b64, unb64, cat, FakeWebsh, mkEnv, cleanup, $} = require('./sealed_harness');
const nodeCrypto = require('node:crypto');

let passed = 0, failed = 0, current = '(between scenarios)';
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(current + ': ' + msg); console.log('  FAIL: ' + msg); }
}
const scenarios = [];
function test(name, fn) { scenarios.push({name, fn}); }

const MiB = 1024 * 1024, KiB = 1024;
const DAY = 24 * 3600 * 1000;
const MARK = 'websh_upload_text';
const TOAST = /Binary uploads are blocked on this computer/;
const randomBytes = n => new Uint8Array(nodeCrypto.randomBytes(n));
const same = (a, b) => !!a && !!b && a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

async function env(o) {
  o = o || {};
  const srv = await new FakeWebsh(o).init();
  if (o.uploadText === false) srv.uploadText = false;
  const e = await mkEnv({server: srv, storage: o.storage});
  const win = e.win;
  win.UPLOAD_RETRY_BASE_MS = 2;
  win.UPLOAD_CHUNK_TIMEOUT_MS = 5000;
  // Count toasts by text (showToast dedups on screen, the user still saw it).
  e.toasts = [];
  const orig = win.showToast;
  win.showToast = function (m, k) { e.toasts.push(String(m)); return orig.apply(this, arguments); };
  return e;
}
function pane(e) {
  const win = e.win, srv = e.srv;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = srv.newSession(); p.host = 'h'; p.persistent = true; p.cwd = '/home/u';
  win.activatePane && win.activatePane(p.id);
  return p;
}
const bannerOf = p => ((p.el.querySelector('[data-upload-progress] .upload-progress-text') || {}).textContent || '');
const finished = p => /Saved to|Upload complete|Uploaded|Upload failed|cancel/i.test(bannerOf(p));
async function settle(p, ms) { await until(() => finished(p) && !p.upload, ms || 30000); await sleep(20); }
// Every /api/upload request on the wire, with what it carried.
function uploadReqs(srv, from) {
  return srv.wire.slice(from || 0).filter(w => w.action === 'upload').map(w => {
    const u = new URL(w.url, 'http://x/');
    const text = /^application\/json/i.test(w.ctype);
    let decoded = null;
    if (text) { try { decoded = unb64(JSON.parse(dec.decode(w.body)).b64); } catch (e) {} }
    return {offset: u.searchParams.get('offset') === null ? null : +u.searchParams.get('offset'), name: u.searchParams.get('path'),
            text, ctype: w.ctype, size: text ? (decoded ? decoded.length : -1) : w.body.length, status: w.status, intercepted: w.intercepted};
  });
}
const landed = (srv, name) => srv.files['/final/' + name] || null;
const markOf = win => { try { return win.localStorage.getItem(MARK); } catch (e) { return 'unreadable'; } };

// ═════════════════════════════════════════════════════════════════════

test('upload text: no mark, nothing blocked - binary pieces exactly as today', async () => {
  const e = await env(); const {win, srv} = e;
  const p = pane(e);
  const data = randomBytes(9 * MiB + 5);
  win.handleUpload(p.id, {files: [new win.File([data], 'today.bin')], value: ''});
  await settle(p);
  const r = uploadReqs(srv);
  ok(/Saved to|complete/i.test(bannerOf(p)), 'finished; banner ' + JSON.stringify(bannerOf(p)));
  ok(r.length === 3 && r.every(x => !x.text && /octet-stream/i.test(x.ctype)), 'three binary octet-stream pieces; got ' + JSON.stringify(r.map(x => [x.offset, x.ctype, x.size])));
  ok(r.map(x => x.offset).join(',') === '0,4194304,8388608' && r.map(x => x.size).join(',') === [4 * MiB, 4 * MiB, MiB + 5].join(','),
     'offsets and sizes as today; got ' + JSON.stringify(r.map(x => [x.offset, x.size])));
  ok(same(landed(srv, 'today.bin'), data), 'file byte-identical');
  ok(markOf(win) === null, 'no mark set');
  ok(!e.toasts.some(t => TOAST.test(t)), 'no toast');
  cleanup(e);
});

test('upload text: a piece answered 503 text/html by an interceptor switches to text at once; the file lands whole', async () => {
  const e = await env(); const {win, srv} = e;
  srv.blockBinary = true;
  const p = pane(e);
  const data = randomBytes(9 * MiB + 77);
  const t0 = Date.now();
  win.handleUpload(p.id, {files: [new win.File([data], 'blocked.bin')], value: ''});
  await settle(p);
  const r = uploadReqs(srv);
  const bin = r.filter(x => !x.text), txt = r.filter(x => x.text);
  ok(/Saved to|complete/i.test(bannerOf(p)), 'the upload finished, not failed; banner ' + JSON.stringify(bannerOf(p)));
  ok(bin.length === 1 && bin[0].size === 4 * MiB, 'one binary attempt, at full size: no halving before the switch; got ' + JSON.stringify(bin.map(x => x.size)));
  ok(txt.length >= 3 && txt[0].offset === 0, 'then text pieces from where the server stands (0); got ' + JSON.stringify(txt.map(x => [x.offset, x.size])));
  ok(txt.every(x => x.status === 200), 'every text piece accepted');
  ok(txt.every(x => x.size > 0 && x.size <= 4 * MiB), 'text pieces carry at most 4 MiB decoded');
  ok(same(landed(srv, 'blocked.bin'), data), 'file byte-identical');
  const m = +markOf(win);
  ok(m >= t0 - 1000 && m <= Date.now() + 1000, 'the mark is stored as the time it was set; got ' + markOf(win));
  ok(e.toasts.filter(t => TOAST.test(t)).length === 1, 'the user is told once; toasts: ' + JSON.stringify(e.toasts));
  cleanup(e);
});

test('upload text: blocked mid-file - continues from the size the server has, no restart from zero, nothing twice', async () => {
  const e = await env(); const {win, srv} = e;
  let binaryOk = 0;
  srv.blockBinary = () => (binaryOk++ >= 1);         // the first binary piece passes, the rest are blocked
  const p = pane(e);
  const data = randomBytes(10 * MiB + 3);
  win.handleUpload(p.id, {files: [new win.File([data], 'mid.bin')], value: ''});
  await settle(p);
  const r = uploadReqs(srv);
  const txt = r.filter(x => x.text);
  ok(r[0] && !r[0].text && r[0].status === 200 && r[0].offset === 0, 'the first piece went binary and landed');
  ok(txt.length > 0 && txt[0].offset === 4 * MiB, 'the first text piece starts at 4 MiB, not 0; got ' + JSON.stringify(txt.map(x => x.offset)));
  ok(!txt.some(x => x.offset === 0), 'no restart from zero');
  const accepted = r.filter(x => x.status === 200).reduce((a, x) => a + x.size, 0);
  ok(accepted === data.length, 'bytes accepted add up to the file exactly (nothing twice): ' + accepted + ' vs ' + data.length);
  ok(same(landed(srv, 'mid.bin'), data), 'file byte-identical');
  cleanup(e);
});

test('upload text: binary cut at every size (O7b) - shrinks to the minimum piece, then switches; the file lands whole', async () => {
  const e = await env(); const {win, srv} = e;
  srv.cutBinary = true;
  const p = pane(e);
  const data = randomBytes(3 * MiB + 9);
  win.handleUpload(p.id, {files: [new win.File([data], 'cut.bin')], value: ''});
  await settle(p, 60000);
  const r = uploadReqs(srv);
  const bin = r.filter(x => !x.text).map(x => x.size), txt = r.filter(x => x.text);
  ok(/Saved to|complete/i.test(bannerOf(p)), 'finished, not "blocked or cut short"; banner ' + JSON.stringify(bannerOf(p)));
  ok(bin.length >= 2 && bin.every((s, k) => k === 0 || s <= bin[k - 1]), 'binary pieces shrink first (O7b); sizes ' + bin.join(','));
  ok(bin[bin.length - 1] === 256 * KiB, 'the switch comes once cuts happen at the minimum piece (256 KiB); last binary ' + bin[bin.length - 1]);
  ok(txt.length > 0, 'then text');
  ok(same(landed(srv, 'cut.bin'), data), 'file byte-identical');
  ok(markOf(win) !== null, 'and remembered');
  cleanup(e);
});

test('upload text: with the mark, uploads start as text; the mark expires after 30 days', async () => {
  for (const [age, wantText] of [[0, true], [29 * DAY, true], [31 * DAY, false]]) {
    const e = await env({storage: {[MARK]: String(Date.now() - age)}}); const {win, srv} = e;
    const p = pane(e);
    const data = randomBytes(5 * MiB + 1);
    win.handleUpload(p.id, {files: [new win.File([data], 'm.bin')], value: ''});
    await settle(p);
    const r = uploadReqs(srv);
    const days = Math.round(age / DAY);
    ok(r.length > 0 && r[0].text === wantText, `mark ${days} days old: the first piece is ${wantText ? 'text' : 'binary'}; got ` + JSON.stringify(r.map(x => [x.offset, x.text])));
    if (wantText) ok(r.every(x => x.text), `mark ${days} days old: no binary piece at all`);
    ok(same(landed(srv, 'm.bin'), data), `mark ${days} days old: file byte-identical`);
    ok(!e.toasts.some(t => TOAST.test(t)), `mark ${days} days old: no toast (nothing was blocked)`);
    cleanup(e);
  }
});

test('upload text: storage that fails (private mode) is tolerated - the upload still lands, the next one probes again', async () => {
  for (const how of ['setItem throws', 'getItem throws']) {
    const e = await env(); const {win, srv} = e;
    const S = win.Storage.prototype, set = S.setItem, get = S.getItem;
    if (how === 'setItem throws') S.setItem = function (k, v) { if (k === MARK) throw new win.DOMException('quota', 'QuotaExceededError'); return set.call(this, k, v); };
    else S.getItem = function (k) { if (k === MARK) throw new win.DOMException('denied', 'SecurityError'); return get.call(this, k); };
    srv.blockBinary = true;
    const p = pane(e);
    const a = randomBytes(5 * MiB + 2);
    win.handleUpload(p.id, {files: [new win.File([a], 'a.bin')], value: ''});
    await settle(p);
    ok(same(landed(srv, 'a.bin'), a), how + ': the first upload still lands whole; banner ' + JSON.stringify(bannerOf(p)));
    const n = srv.wire.length;
    win.handleUpload(p.id, {files: [new win.File([randomBytes(1000)], 'b.bin')], value: ''});
    await settle(p);
    ok(landed(srv, 'b.bin') !== null, how + ': the second upload lands too');
    const r = uploadReqs(srv, n);
    ok(r.length > 0, how + ': the second upload sent pieces (' + JSON.stringify(r.map(x => x.text)) + ')');
    S.setItem = set; S.getItem = get;
    cleanup(e);
  }
});

test('upload text: never text unless the server says upload_text (an older server would store the JSON)', async () => {
  const e = await env({uploadText: false}); const {win, srv} = e;
  ok(!('upload_text' in srv.config()), 'setup: config without upload_text');
  srv.blockBinary = true;
  const p = pane(e);
  win.handleUpload(p.id, {files: [new win.File([randomBytes(2 * MiB)], 'old.bin')], value: ''});
  await settle(p, 60000);
  const r = uploadReqs(srv);
  ok(r.length > 0 && r.every(x => !x.text), 'no text piece was sent; got ' + JSON.stringify(r.map(x => x.ctype)));
  ok(/fail/i.test(bannerOf(p)), 'the upload fails visibly as today; banner ' + JSON.stringify(bannerOf(p)));
  ok(markOf(win) === null, 'no mark set against a server that cannot take text');
  cleanup(e);
  // And a mark left from another server does not make it send text here.
  const e2 = await env({uploadText: false, storage: {[MARK]: String(Date.now())}});
  const p2 = pane(e2);
  e2.win.handleUpload(p2.id, {files: [new e2.win.File([randomBytes(1000)], 'old2.bin')], value: ''});
  await settle(p2);
  const r2 = uploadReqs(e2.srv);
  ok(r2.length > 0 && r2.every(x => !x.text), 'with a mark but no upload_text: binary; got ' + JSON.stringify(r2.map(x => x.ctype)));
  ok(landed(e2.srv, 'old2.bin') !== null, 'and it lands');
  cleanup(e2);
});

test('upload text: several files at once - the first switches, the rest start as text, one toast', async () => {
  const e = await env(); const {win, srv} = e;
  srv.blockBinary = true;
  const p = pane(e);
  const files = [randomBytes(5 * MiB), randomBytes(100 * KiB), randomBytes(4 * MiB + 1)];
  win.handleUpload(p.id, {files: files.map((d, k) => new win.File([d], 'bulk' + k + '.bin')), value: ''});
  await settle(p, 60000);
  files.forEach((d, k) => ok(same(landed(srv, 'bulk' + k + '.bin'), d), 'file ' + k + ' byte-identical'));
  const r = uploadReqs(srv);
  ok(r.filter(x => !x.text).length === 1, 'one binary attempt in all; got ' + r.filter(x => !x.text).length);
  ok(e.toasts.filter(t => TOAST.test(t)).length === 1, 'one toast for the batch; toasts ' + JSON.stringify(e.toasts));
  cleanup(e);
});

test('upload text: a second upload in the same page starts as text and says nothing', async () => {
  const e = await env(); const {win, srv} = e;
  srv.blockBinary = true;
  const p = pane(e);
  win.handleUpload(p.id, {files: [new win.File([randomBytes(300 * KiB)], 'first.bin')], value: ''});
  await settle(p);
  const n = srv.wire.length, nt = e.toasts.length;
  const d = randomBytes(2 * MiB + 3);
  win.handleUpload(p.id, {files: [new win.File([d], 'second.bin')], value: ''});
  await settle(p);
  const r = uploadReqs(srv, n);
  ok(r.length > 0 && r.every(x => x.text), 'the second upload is text from its first piece; got ' + JSON.stringify(r.map(x => x.text)));
  ok(same(landed(srv, 'second.bin'), d), 'byte-identical');
  ok(!e.toasts.slice(nt).some(t => TOAST.test(t)), 'no second toast');
  cleanup(e);
});

test('upload text: drag-and-drop onto a pane takes the same path', async () => {
  const e = await env(); const {win, srv} = e;
  srv.blockBinary = true;
  const p = pane(e);
  const d = randomBytes(1 * MiB + 11);
  const file = new win.File([d], 'dropped.bin');
  const ev = new win.Event('drop', {bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'dataTransfer', {value: {types: ['Files'], files: [file], items: undefined}});
  p.el.dispatchEvent(ev);
  await until(() => !!p.upload, 1000);
  await settle(p);
  ok(same(landed(srv, 'dropped.bin'), d), 'a dropped file lands byte-identical through the text fallback; banner ' + JSON.stringify(bannerOf(p)));
  ok(uploadReqs(srv).some(x => x.text), 'it switched to text');
  cleanup(e);
});

test('upload text: the file browser\'s "upload here" takes the same path', async () => {
  const e = await env(); const {win, srv} = e;
  srv.blockBinary = true;
  const p = pane(e);
  win.showFileBrowser(p.id);
  await until(() => srv.wire.some(w => w.action === 'ls'), 1000);
  await sleep(50);
  const d = randomBytes(700 * KiB);
  win.fbStartUpload([new win.File([d], 'here.bin')]);
  await until(() => !!p.upload, 1000);
  await settle(p);
  ok(same(landed(srv, 'here.bin'), d), 'uploaded into the directory on screen, byte-identical; banner ' + JSON.stringify(bannerOf(p)));
  ok(uploadReqs(srv).some(x => x.text), 'it switched to text');
  const fin = srv.wire.filter(w => w.action === 'upload_finalize').map(w => JSON.parse(dec.decode(w.body)));
  ok(fin.length === 1 && fin[0].dir === '/home/u', 'finalized into the directory the browser showed; got ' + JSON.stringify(fin));
  cleanup(e);
});

test('upload text: text pieces cut by a size-limiting proxy shrink and still arrive (O7b holds for text)', async () => {
  const e = await env({storage: {[MARK]: String(Date.now())}}); const {win, srv} = e;
  srv.cutOver = 1500 * KiB;          // bodies over ~1.5 MB (a 4 MiB piece as base64 is ~5.6 MB) are cut
  const p = pane(e);
  const d = randomBytes(5 * MiB + 7);
  win.handleUpload(p.id, {files: [new win.File([d], 'tcut.bin')], value: ''});
  await settle(p, 60000);
  const r = uploadReqs(srv);
  ok(same(landed(srv, 'tcut.bin'), d), 'byte-identical after shrinking; banner ' + JSON.stringify(bannerOf(p)));
  ok(r.every(x => x.text), 'all pieces stayed text');
  const sizes = r.map(x => x.size);
  ok(sizes[0] === 4 * MiB && sizes.some(s => s <= MiB), 'the text piece size halved after the cut; sizes ' + sizes.join(','));
  cleanup(e);
});

// O7b: a stall (pieces taken, no answer) fails fast within ONE
// wall-clock budget for the whole upload. Found 2026-10-21: the first
// fallback took a stall for "blocked", switched to text and started the
// budget over - e2e proxytrunc's stalled upload still showed 33% after
// 45 s instead of failing at ~35 s.
const BUDGET = 1500;
async function budgetEnv(o) {
  const e = await env(o);
  e.win.UPLOAD_WALLCLOCK_MS = BUDGET;
  e.win.UPLOAD_CHUNK_TIMEOUT_MS = 60000;     // the watchdog, not the XHR timeout, is what fires
  return e;
}

test('upload text: a stalled binary piece never switches to text, and fails within the budget', async () => {
  const e = await budgetEnv(); const {win, srv} = e;
  srv.stallBinary = true;
  const p = pane(e);
  const t0 = Date.now();
  win.handleUpload(p.id, {files: [new win.File([randomBytes(2 * MiB)], 'stall.bin')], value: ''});
  await until(() => /fail/i.test(bannerOf(p)), 4 * BUDGET);
  const took = Date.now() - t0;
  ok(/Upload failed/.test(bannerOf(p)), 'a visible failure; banner ' + JSON.stringify(bannerOf(p)));
  ok(/proxy|firewall|blocked|cut short/i.test(bannerOf(p)), 'naming the probable cause');
  ok(took < BUDGET + 800, 'within the wall-clock budget (' + took + ' ms, budget ' + BUDGET + ')');
  ok(!uploadReqs(srv).some(x => x.text), 'no text piece: a stall is not "blocked"');
  ok(markOf(win) === null, 'no mark');
  ok(!e.toasts.some(t => TOAST.test(t)), 'no "binary is blocked" toast');
  cleanup(e);
});

test('upload text: blocked binary, then text stalls too - fails at the first text stall, nothing retried after it', async () => {
  const e = await budgetEnv(); const {win, srv} = e;
  srv.blockBinary = true;
  srv.stallText = true;
  const p = pane(e);
  const t0 = Date.now();
  let tSwitch = 0;
  win.handleUpload(p.id, {files: [new win.File([randomBytes(2 * MiB)], 'both.bin')], value: ''});
  await until(() => { if (!tSwitch && srv.wire.some(w => w.action === 'upload' && /json/i.test(w.ctype))) tSwitch = Date.now(); return /fail/i.test(bannerOf(p)); }, 6 * BUDGET);
  const took = Date.now() - t0;
  ok(tSwitch > 0, 'it switched to text');
  ok(/Upload failed/.test(bannerOf(p)), 'a visible failure; banner ' + JSON.stringify(bannerOf(p)));
  ok(took < BUDGET + 900, 'failed within one budget of the start (' + took + ' ms, budget ' + BUDGET + ')');
  ok(uploadReqs(srv).filter(x => x.text).length === 1, 'one text attempt, no retry after a stall that used the budget; got ' + uploadReqs(srv).filter(x => x.text).length);
  cleanup(e);
});

test('upload text: the switch does not restart the budget - binary cuts used it up, text retries then end at once', async () => {
  const e = await budgetEnv(); const {win, srv} = e;
  // Every binary piece is cut after the proxy has read it for 250 ms: the
  // binary phase (4 MiB down to the 256 KiB floor) takes longer than the
  // whole budget. Every text piece is then answered "busy" (503 JSON,
  // retried) after 250 ms. With one budget per upload the first text
  // failure ends it; a budget started over at the switch would let the
  // text retries run for another ~1.5 s.
  srv.cutBinary = true; srv.busyText = true; srv.cutDelay = 250;
  const p = pane(e);
  const t0 = Date.now();
  let tSwitch = 0;
  win.handleUpload(p.id, {files: [new win.File([randomBytes(2 * MiB)], 'cuts.bin')], value: ''});
  await until(() => { if (!tSwitch && srv.wire.some(w => w.action === 'upload' && /json/i.test(w.ctype))) tSwitch = Date.now(); return /fail/i.test(bannerOf(p)); }, 10 * BUDGET);
  const done = Date.now();
  const text = uploadReqs(srv).filter(x => x.text);
  ok(/Upload failed/.test(bannerOf(p)), 'a visible failure; banner ' + JSON.stringify(bannerOf(p)));
  ok(tSwitch > 0 && tSwitch - t0 >= BUDGET, 'setup: the switch came after the budget was used (' + (tSwitch - t0) + ' ms)');
  ok(done - tSwitch < 700, 'failed right after the switch (' + (done - tSwitch) + ' ms after it; ' + text.length + ' text attempts)');
  ok(text.length <= 2, 'at most two text attempts; got ' + text.length + ' (' + text.map(x => x.size).join(',') + ')');
  cleanup(e);
});

test('upload text: a big text piece is encoded in pieces (no stack overflow on 4 MiB)', async () => {
  const e = await env({storage: {[MARK]: String(Date.now())}}); const {win, srv} = e;
  const p = pane(e);
  const d = randomBytes(8 * MiB);
  const errs = [];
  win.addEventListener('error', ev => errs.push(ev.message));
  win.handleUpload(p.id, {files: [new win.File([d], 'big.bin')], value: ''});
  await settle(p, 60000);
  ok(same(landed(srv, 'big.bin'), d), '8 MiB as text lands byte-identical; banner ' + JSON.stringify(bannerOf(p)));
  ok(uploadReqs(srv).some(x => x.text && x.size === 4 * MiB), 'full 4 MiB text pieces');
  ok(errs.length === 0, 'no error in the page: ' + errs.join(' | '));
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
