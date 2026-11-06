// File browser: a symlink to a folder is a folder (owner, 2026-10-23:
// "in the file browser I don't see mounted folders"). ~/job/БЮ_ОптРеш is
// a symlink into an rclone FUSE mount; it was listed as type "l", sorted
// among the 128 files of ~/job with a link icon, and a click downloaded
// instead of opening it. Written from the decision:
//   - an entry {type: "l", dir: true} is shown and sorted with the
//     folders, with the folder icon, marked as a link;
//   - a click opens it: the browser shows the LINK's path and its
//     contents; ".." goes back to the parent;
//   - a symlink to a file, and a dangling one, stay as today (with the
//     files; a click on the file link downloads);
//   - Delete on a link-to-folder row asks about a link and sends rm for
//     the link's path; Rename sends mv for the link's path.
// Harness: sealed_harness.js (the fake server answers /api/ls from a
// small tree below).

const {sleep, until, dec, FakeWebsh, mkEnv, cleanup, $} = require('./sealed_harness');

let passed = 0, failed = 0, current = '(between scenarios)';
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(current + ': ' + msg); console.log('  FAIL: ' + msg); }
}
const scenarios = [];
function test(name, fn) { scenarios.push({name, fn}); }

const JOB = '/home/u/job';
const LINK = JOB + '/БЮ_ОптРеш';
function tree(path) {
  const t = 1790000000;
  const files = [];
  for (let k = 0; k < 20; k++) files.push({name: 'file' + String(k).padStart(2, '0') + '.txt', type: 'f', size: 100 + k, mtime: t + 1000 + k});
  if (path === JOB) return [
    ...files,
    {name: 'archive', type: 'd', size: 4096, mtime: t + 10},
    {name: 'zz-real-dir', type: 'd', size: 4096, mtime: t + 20},
    {name: 'БЮ_ОптРеш', type: 'l', dir: true, size: 39, mtime: t + 5},
    {name: 'notes-link', type: 'l', size: 9, mtime: t + 3000},
    {name: 'dangling', type: 'l', size: 14, mtime: t + 3001},
  ];
  if (path === LINK) return [{name: 'отчёт.xlsx', type: 'f', size: 12345, mtime: t}, {name: 'sub', type: 'd', size: 0, mtime: t}];
  return [];
}

async function fbEnv() {
  const srv = await new FakeWebsh().init();
  srv.hooks.ls = req => ({status: 200, headers: {'Content-Type': 'application/json'},
    body: new TextEncoder().encode(JSON.stringify({path: req.query.path, entries: tree(req.query.path)}))});
  srv.hooks.rm = req => ({status: 200, headers: {'Content-Type': 'application/json'}, body: new TextEncoder().encode('{"ok": true}')});
  srv.hooks.mv = req => ({status: 200, headers: {'Content-Type': 'application/json'}, body: new TextEncoder().encode('{"ok": true}')});
  const e = await mkEnv({server: srv});
  const win = e.win;
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = srv.newSession(); p.host = 'h'; p.persistent = true; p.cwd = '/home/u';
  win.showFileBrowser(p.id);
  await until(() => srv.wire.some(w => w.action === 'ls'), 1000);
  await sleep(30);
  win.loadFbDir(JOB);
  await until(() => rows(win).some(r => r.name === 'БЮ_ОптРеш'), 2000);
  return {e, win, srv, p};
}
function rows(win) {
  return Array.from(win.document.querySelectorAll('#fbList .fb-row')).map(r => ({
    el: r, name: r.dataset.name, type: r.dataset.type,
    icon: (r.querySelector('.fb-ic use') || {getAttribute: () => ''}).getAttribute('href') || '',
    text: r.textContent, html: r.outerHTML,
  }));
}
const rowOf = (win, n) => rows(win).find(r => r.name === n);
const lsPaths = srv => srv.wire.filter(w => w.action === 'ls').map(w => new URL(w.url, 'http://x/').searchParams.get('path'));
// The breadcrumb <nav> carries the full path in data-path (setFbPath).
const curPath = win => { const n = win.document.getElementById('fbPath'); return n ? (n.getAttribute('data-path') || '') : ''; };
const crumbText = win => { const n = win.document.getElementById('fbPath'); return n ? n.textContent : ''; };

test('fb links: a link to a folder is listed with the folders, folder icon, marked as a link', async () => {
  const {e, win} = await fbEnv();
  const list = rows(win).filter(r => r.name !== '..');
  const idx = n => list.findIndex(r => r.name === n);
  const firstFile = list.findIndex(r => /^file\d/.test(r.name));
  const link = rowOf(win, 'БЮ_ОптРеш');
  ok(!!link, 'the link to a folder is listed');
  ok(idx('БЮ_ОптРеш') < firstFile, 'it comes before the files (with the folders); index ' + idx('БЮ_ОптРеш') + ', first file at ' + firstFile + '; order ' + list.map(r => r.name).slice(0, 6).join(','));
  ok(idx('archive') < firstFile && idx('zz-real-dir') < firstFile, 'the real folders are there too');
  ok(link && /folder/.test(link.icon), 'folder icon; got ' + (link && link.icon));
  ok(link && /link|symlink|→|->/i.test(link.html.replace(/data-name="[^"]*"/, '')), 'marked as a link (somewhere in the row)');
  // Files and the other links stay where they were.
  const nl = rowOf(win, 'notes-link'), dg = rowOf(win, 'dangling');
  const lastDir = Math.max(idx('archive'), idx('zz-real-dir'));
  ok(nl && idx('notes-link') > lastDir && /link/.test(nl.icon), 'a link to a file stays with the files, link icon');
  ok(dg && idx('dangling') > lastDir && /link/.test(dg.icon), 'a dangling link stays as today');
  cleanup(e);
});

test('fb links: clicking a link to a folder opens it at the link\'s path; ".." goes back', async () => {
  const {e, win, srv, p} = await fbEnv();
  const n0 = srv.wire.length;
  rowOf(win, 'БЮ_ОптРеш').el.click();
  ok(await until(() => rows(win).some(r => r.name === 'отчёт.xlsx'), 2000), 'its contents are shown');
  ok(lsPaths(srv).slice(-1)[0] === LINK, 'listed at the link path; asked for ' + JSON.stringify(lsPaths(srv).slice(-1)[0]));
  ok(curPath(win) === LINK, 'the browser shows the link path; got ' + JSON.stringify(curPath(win)));
  ok(/БЮ_ОптРеш/.test(crumbText(win)) && /job/.test(crumbText(win)), 'the breadcrumb reads …/job/БЮ_ОптРеш; got ' + JSON.stringify(crumbText(win)));
  ok(!srv.wire.slice(n0).some(w => w.action === 'download'), 'no download started');
  ok(!p.download, 'no download in the pane');
  rowOf(win, '..').el.click();
  ok(await until(() => rows(win).some(r => r.name === 'archive'), 2000) && curPath(win) === JOB, 'Up goes back to the folder holding the link; at ' + JSON.stringify(curPath(win)));
  cleanup(e);
});

test('fb links: a link to a file still downloads on click', async () => {
  const {e, win, srv} = await fbEnv();
  const n0 = srv.wire.length;
  rowOf(win, 'notes-link').el.click();
  ok(await until(() => srv.wire.slice(n0).some(w => w.action === 'download'), 2000), 'a download was asked for');
  const d = srv.wire.slice(n0).find(w => w.action === 'download');
  ok(d && new URL(d.url, 'http://x/').searchParams.get('path') === JOB + '/notes-link', 'of the link path');
  cleanup(e);
});

test('fb links: Delete on a link to a folder asks about a link and removes the link path', async () => {
  const {e, win, srv} = await fbEnv();
  const r = rowOf(win, 'БЮ_ОптРеш');
  r.el.querySelector('[data-fb-del]').click();
  await sleep(10);
  const q = (rowOf(win, 'БЮ_ОптРеш') || r).el.textContent;
  ok(/link/i.test(q), 'the question names a link; got ' + JSON.stringify(q));
  ok(!/only if empty/i.test(q), 'not the folder wording (that is about the target)');
  r.el.querySelector('.fb-cf-yes').click();
  ok(await until(() => srv.wire.some(w => w.action === 'rm'), 2000), 'rm sent');
  const rm = srv.wire.find(w => w.action === 'rm');
  const body = rm ? JSON.parse(dec.decode(rm.body)) : {};
  ok(body.path === LINK, 'for the link path, not the target; got ' + JSON.stringify(body.path));
  cleanup(e);
});

test('fb links: Rename on a link to a folder renames the link path', async () => {
  const {e, win, srv} = await fbEnv();
  const r = rowOf(win, 'БЮ_ОптРеш');
  r.el.querySelector('[data-fb-ren]').click();
  await sleep(10);
  const inp = r.el.querySelector('.fb-ed-inp');
  ok(!!inp, 'a rename field');
  if (inp) {
    inp.value = 'БЮ-ссылка';
    inp.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
  }
  ok(await until(() => srv.wire.some(w => w.action === 'mv'), 2000), 'mv sent');
  const mv = srv.wire.find(w => w.action === 'mv');
  const body = mv ? JSON.parse(dec.decode(mv.body)) : {};
  ok(body.path === LINK && body.name === 'БЮ-ссылка', 'for the link path; got ' + JSON.stringify(body));
  cleanup(e);
});

test('fb links: sorted by size or date, the link to a folder stays with the folders', async () => {
  const {e, win} = await fbEnv();
  for (const key of ['size', 'mtime', 'name']) {
    win.eval(`settings.fbSort = ${JSON.stringify(key)}; settings.fbSortDir = -1;`);
    win.loadFbDir(JOB);
    await until(() => rows(win).some(r => r.name === 'БЮ_ОптРеш'), 2000);
    await sleep(20);
    const list = rows(win).filter(r => r.name !== '..');
    const firstFile = list.findIndex(r => /^file\d/.test(r.name));
    ok(list.findIndex(r => r.name === 'БЮ_ОптРеш') < firstFile, `sort ${key}: with the folders; order ` + list.map(r => r.name).slice(0, 5).join(','));
  }
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
