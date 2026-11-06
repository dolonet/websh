// OSC 8 hyperlinks in the terminal: what a click and a hover do.
//
// Programs (Claude Code, `ls --hyperlink`, gcc) print
// ESC ] 8 ; ; URL ESC \ text ESC ] 8 ; ; ESC \. xterm.js turns such
// cells into links and hands hover/click to the terminal's `linkHandler`
// option; without one it falls back to a confirm("Do you want to
// navigate to ...? WARNING ...") dialog. The owner's expectation: a link
// opens in a new tab on click (plain, Ctrl or Cmd), like plain URLs do,
// with no dialog; hovering shows the real target (the visible text can
// differ); only http(s) (mailto optional) ever open.
//
// websh.js runs under jsdom with xterm stubbed; the stub records the
// options websh passes to `new Terminal(...)`, and the test drives the
// link handler the way xterm.js 5.5 calls it: activate(event, uri,
// range), hover(event, uri, range), leave(event, uri, range).
//
// Separate from test_connect.js on purpose (a parallel author owns that
// file's tab tests); same output format, so scripts/check.sh reads both.

const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');

const REPO = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(REPO, 'websh.js'), 'utf8');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(current + ': ' + msg); console.log('  FAIL: ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakes(win, rec) {
  win.Terminal = class {
    constructor(opts) {
      rec.termOpts.push(opts || {});
      (rec.terms = rec.terms || []).push(this);
      this.options = Object.assign({}, opts || {});
      this.cols = 80; this.rows = 24; this.modes = {mouseTrackingMode: 'none'};
    }
    loadAddon(a) { rec.addons.push(a); }
    open(el) { this.element = el; }
    reset() {} focus() {} blur() {} write() {} dispose() { this.disposed = true; } clear() {} scrollToBottom() {} refresh() {}
    onData() { return {dispose() {}}; } onBinary() { return {dispose() {}}; }
    onResize() { return {dispose() {}}; } onBell() { return {dispose() {}}; }
    onTitleChange() { return {dispose() {}}; } onScroll() { return {dispose() {}}; }
    onRender() { return {dispose() {}}; } onWriteParsed() { return {dispose() {}}; }
    onSelectionChange() { return {dispose() {}}; } onCursorMove() { return {dispose() {}}; }
    onKey() { return {dispose() {}}; } onLineFeed() { return {dispose() {}}; }
    attachCustomKeyEventHandler() {} registerLinkProvider(p) { rec.providers.push(p); return {dispose() {}}; }
    registerDecoration() { return null; } registerMarker() { return null; }
    getSelection() { return ''; } hasSelection() { return false; }
    get parser() { return {registerOscHandler() { return {dispose() {}}; }, registerCsiHandler() { return {dispose() {}}; }}; }
    get buffer() { return {active: {length: 0, viewportY: 0, baseY: 0, getLine: () => null}}; }
    get unicode() { return {activeVersion: '11'}; }
  };
  win.FitAddon = {FitAddon: class { activate() {} fit() {} proposeDimensions() { return {cols: 80, rows: 24}; } }};
  win.SearchAddon = {SearchAddon: class { activate() {} findNext() {} findPrevious() {} clearDecorations() {}
    onDidChangeResults() { return {dispose() {}}; } dispose() {} }};
  win.WebLinksAddon = {WebLinksAddon: class { constructor(h, o) { rec.webLinks.push({handler: h, opts: o}); } activate() {} dispose() {} }};
  win.Unicode11Addon = {Unicode11Addon: class { activate() {} }};
  win.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
}

async function env() {
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/websh/'});
  const win = dom.window;
  const rec = {termOpts: [], addons: [], webLinks: [], providers: [], opened: [], confirms: 0, alerts: 0};
  fakes(win, rec);
  // No server: every API call gets an empty answer.
  win.fetch = () => sleep(1).then(() => ({ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('{}')}));
  win.localStorage.clear();
  // A new tab: either window.open(url, ...) or window.open() + location.
  // Like a browser: with 'noopener'/'noreferrer' in the features the
  // call returns null and the new tab has no opener.
  win.open = function (url, name, features) {
    const w = {opener: win, closed: false, focus() {}, close() {}, document: {write() {}, close() {}}};
    const noopener = /noopener|noreferrer/i.test(String(features || ''));
    const entry = {arg: url === undefined ? null : String(url), win: w, noopener};
    let href = '';
    w.location = {set href(v) { href = String(v); entry.href = href; }, get href() { return href; },
                  assign(v) { this.href = v; }, replace(v) { this.href = v; }};
    rec.opened.push(entry);
    return noopener ? null : w;
  };
  win.confirm = () => { rec.confirms++; return false; };
  win.alert = () => { rec.alerts++; };
  win.eval(js);
  try { await Promise.race([win.eval('bootReady'), sleep(2000)]); } catch (e) {}
  await sleep(20);
  return {dom, win, rec};
}

// The URL each window.open call ended up at (argument, or location set).
const targets = rec => rec.opened.map(e => e.href || e.arg || '').filter(u => u && u !== 'about:blank');

async function paneEnv() {
  const e = await env();
  const box = e.win.document.createElement('div');
  e.win.document.body.appendChild(box);
  e.win.createPane(box);
  ok(e.rec.termOpts.length >= 1, 'harness: createPane built a terminal');
  e.opts = e.rec.termOpts[e.rec.termOpts.length - 1] || {};
  e.lh = e.opts.linkHandler || null;
  return e;
}

const ev = (win, o) => new win.MouseEvent('click', Object.assign({bubbles: true, cancelable: true, button: 0}, o || {}));
const range = {start: {x: 1, y: 1}, end: {x: 8, y: 1}};

// Is `url` visible to the user somewhere in the page: a title tooltip, or
// text in an element that is not hidden.
function urlShown(win, url) {
  const doc = win.document;
  for (const el of doc.querySelectorAll('*')) {
    if ((el.getAttribute('title') || '').includes(url)) return 'title';
  }
  const hidden = el => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.classList.contains('h') || n.hidden) return true;
      const st = win.getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return true;
    }
    return false;
  };
  for (const el of doc.querySelectorAll('body *')) {
    if (el.children.length) continue;
    if ((el.textContent || '').includes(url) && !hidden(el)) return 'text';
  }
  return null;
}

let current = '';
const tests = [];
function test(name, fn) { tests.push({name, fn}); }

test('OSC 8 links get a handler of websh\'s own (not xterm\'s confirm() default)', async () => {
  const e = await paneEnv();
  ok(!!e.lh && typeof e.lh.activate === 'function',
     'new Terminal({...}) has linkHandler.activate - without it xterm.js shows "Do you want to navigate to ...? WARNING" on every OSC 8 link click');
  e.dom.window.close();
});

test('clicking an http(s) OSC 8 link opens the target in a new tab, once, no dialog', async () => {
  const e = await paneEnv();
  if (!e.lh) { ok(false, 'no linkHandler: cannot click an OSC 8 link'); return; }
  const cases = [['plain click', {}], ['Ctrl+click', {ctrlKey: true}], ['Cmd+click', {metaKey: true}]];
  for (const url of ['https://example.com/a/b?q=1&r=%20x#frag', 'http://example.org/']) {
    for (const [what, mods] of cases) {
      e.rec.opened.length = 0; e.rec.confirms = 0;
      try { e.lh.activate(ev(e.win, mods), url, range); } catch (err) { ok(false, `${what} ${url}: activate threw ${err.message}`); }
      await sleep(5);
      const t = targets(e.rec);
      ok(t.length === 1 && t[0] === url, `${what} on ${url}: one new tab at exactly that URL (opened: ${JSON.stringify(t)})`);
      ok(e.rec.confirms === 0 && e.rec.alerts === 0, `${what} on ${url}: no confirm()/alert() dialog`);
      const w = e.rec.opened[0] && e.rec.opened[0].win;
      ok(!w || w.opener === null || e.rec.opened[0].noopener, `${what} on ${url}: the new tab cannot reach back into websh (opener cleared)`);
    }
  }
  e.dom.window.close();
});

test('unsafe link targets never open, whatever the modifier', async () => {
  const e = await paneEnv();
  if (!e.lh) { ok(false, 'no linkHandler: cannot check unsafe schemes'); return; }
  const bad = ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
               'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:msgbox(1)',
               'blob:http://localhost/x', 'ftp://example.com/', 'chrome://settings', 'about:blank#x'];
  for (const url of bad) {
    for (const mods of [{}, {ctrlKey: true}, {metaKey: true}]) {
      e.rec.opened.length = 0; e.rec.confirms = 0;
      try { e.lh.activate(ev(e.win, mods), url, range); } catch (err) {}
      await sleep(2);
      const any = e.rec.opened.map(x => x.href || x.arg || '(blank)');
      ok(any.length === 0, `${JSON.stringify(url)} ${JSON.stringify(mods)}: nothing opens (opened: ${JSON.stringify(any)})`);
    }
  }
  e.dom.window.close();
});

test('hovering an OSC 8 link shows its real target; leaving hides it', async () => {
  const e = await paneEnv();
  if (!e.lh || typeof e.lh.hover !== 'function') { ok(false, 'no linkHandler.hover: the user cannot see where a link goes before clicking'); return; }
  const url = 'https://example.com/hover-target-7f3a';
  e.lh.hover(ev(e.win, {}), url, range);
  await sleep(5);
  ok(!!urlShown(e.win, url), 'while hovered, the target URL is visible (tooltip or status text)');
  if (typeof e.lh.leave === 'function') e.lh.leave(ev(e.win, {}), url, range);
  await sleep(5);
  ok(!urlShown(e.win, url), 'after leaving, the target URL is no longer shown');
  e.dom.window.close();
});

test('a hovered target is shown as text, never as markup', async () => {
  const e = await paneEnv();
  if (!e.lh || typeof e.lh.hover !== 'function') { ok(false, 'no linkHandler.hover'); return; }
  const url = 'https://example.com/"><img src=x onerror="window.__xss=1">';
  e.lh.hover(ev(e.win, {}), url, range);
  await sleep(5);
  ok(!e.win.document.querySelector('img[src="x"]') && !e.win.__xss, 'a URL with markup in it creates no element');
  if (typeof e.lh.leave === 'function') e.lh.leave(ev(e.win, {}), url, range);
  e.dom.window.close();
});

// The tooltip is there so the user sees where a link REALLY goes. A
// target can put a trusted-looking name first and the real host after a
// long userinfo: https://github.com:xxxx...xxxx@evil.example/ opens
// evil.example. The tooltip is one line, cut with an ellipsis at 60% of
// the window: shown raw, the user reads "https://github.com:xxxxx…" and
// never sees evil.example (measured in Chromium: 720 px box, host past
// the cut). Whatever the presentation, the host that would open must be
// near the start of the shown text (64 characters fit even on a phone).
test('the tooltip shows the host a link would open, even behind a long userinfo', async () => {
  const e = await paneEnv();
  if (!e.lh || typeof e.lh.hover !== 'function') { ok(false, 'no linkHandler.hover'); return; }
  const cases = [
    ['https://github.com:' + 'x'.repeat(220) + '@evil.example/', 'evil.example'],
    ['https://github.com' + '%2F'.repeat(1) + '@evil.example/path', 'evil.example'],
    ['https://user:pw@evil.example/', 'evil.example'],
  ];
  for (const [url, host] of cases) {
    e.lh.hover(ev(e.win, {clientX: 100, clientY: 100}), url, range);
    await sleep(2);
    // The shown tooltip: whatever visible element now holds the text.
    let shown = null;
    for (const el of e.win.document.querySelectorAll('body *')) {
      const tx = el.textContent || '';
      if (!tx.includes('github.com') && !tx.includes(host)) continue;
      if (el.closest('.xterm, script, style')) continue;
      let hid = false;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const st = e.win.getComputedStyle(n);
        if (n.classList.contains('h') || st.display === 'none' || st.visibility === 'hidden') hid = true;
      }
      if (!hid && el.children.length === 0) { shown = tx; break; }
    }
    const at = shown == null ? -1 : shown.indexOf(host);
    ok(at >= 0 && at < 64, `${url.slice(0, 40)}...: the host that opens (${host}) is within the first 64 characters of the tooltip (at ${at}: ${JSON.stringify((shown || '').slice(0, 70))})`);
    e.lh.leave(ev(e.win, {}), url, range);
  }
  e.dom.window.close();
});

// The tooltip is one element on <body>, hidden by xterm's leave(). A
// pane closed under the pointer never gets a leave (measured in Chromium:
// the box stayed on screen over the next pane, showing the dead link).
test('closing the pane under a hovered link takes the tooltip away', async () => {
  const e = await paneEnv();
  if (!e.lh || typeof e.lh.hover !== 'function') { ok(false, 'no linkHandler.hover'); return; }
  const url = 'https://example.com/closing-pane-5e1c';
  // Not win.eval('panes'): jsdom's window.eval does not see websh.js's
  // top-level const/let, and `panes` then resolves to the #panes element
  // (named access on window). The pane's id is on its element.
  const pel = e.win.document.querySelector('.pane[data-pane]');
  const id = pel ? pel.getAttribute('data-pane') : null;
  ok(!!id, 'harness: the pane has an id');
  e.lh.hover(ev(e.win, {clientX: 50, clientY: 50}), url, range);
  await sleep(2);
  ok(!!urlShown(e.win, url), 'harness: the tooltip is shown while hovered');
  try { e.win.closePane(id); } catch (err) { ok(false, 'closePane threw ' + err.message); }
  await sleep(20);
  ok(e.rec.terms.every(x => x.disposed), 'harness: the pane is gone (its terminal disposed)');
  ok(!urlShown(e.win, url), 'after the pane closed, its link target is no longer shown');
  e.dom.window.close();
});

process.on('unhandledRejection', err => {
  failed++; failures.push(current + ': unhandled rejection: ' + (err && err.message || err));
  console.log('  UNHANDLED REJECTION: ' + (err && err.stack || err));
});
(async () => {
  for (const t of tests.filter(x => new RegExp(process.env.ONLY || '.').test(x.name))) {
    current = t.name;
    console.log('\n=== ' + t.name + ' ===');
    try { await t.fn(); } catch (err) {
      failed++; failures.push(t.name + ': ' + err.message);
      console.log('  THREW: ' + (err.stack || err.message));
    }
  }
  console.log('\n===========================================');
  console.log('  passed: ' + passed + '   failed: ' + failed);
  if (failed) { console.log('  failures:'); failures.forEach(f => console.log('    - ' + f)); }
  process.exit(failed ? 1 : 0);
})();
