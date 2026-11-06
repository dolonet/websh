// The Reconnect control lives in the pane's bar row, not over the
// terminal (owner, 2026-10-05: "it must be in the row where 'persistent'
// is written, in the middle of course").
//
// Split pane: inside that pane's .pane-bar, horizontally centred in it at
// several pane widths, nothing in the bar overlapping it (badge, label
// text, tag, buttons), the button clickable (hit-test) - also in a narrow
// pane, also with the message and the password input.
// Lone pane: a strip the height of a pane bar at the top of the pane,
// full width, the control centred in it; the terminal keeps its size (no
// refit, no /api/resize, `stty size` unchanged, the screen not pushed
// down); gone on reconnect.
// A pane going split -> lone while disconnected keeps the typed password
// and focus; Enter with the real password reconnects. A lone pane's
// transfer progress card and the strip do not collide.
// The shell is left with `exit`: the server ends the session, the client
// shows Reconnect the way a user sees it.
//
// Relies on: [data-reconnect=ID] (span message, [data-reconnect-pw=ID],
// button "Reconnect"), .pane-bar, .reconnect-strip (or the .pane-bar shown
// as an overlay for a lone pane), .upload-progress(-cancel), #paneTools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, until, tagOf, cfg } from '../lib.mjs';
export const meta = {
  about: 'Reconnect sits centred in the pane bar (split) or in an overlaid bar-high strip (lone); terminal size untouched',
  ssh: true, local: true,
};

export async function run({ b, t }) {
  const J = JSON.stringify;
  const pane = id => `panes[${J(id)}]`;
  const screen = id => b.ev(`(() => { const p = ${pane(id)}; if (!p || !p.term) return '';
    const bf = p.term.buffer.active; let s = '';
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) s += l.translateToString(true) + '\\n'; }
    return s; })()`);
  const lines = async id => (await screen(id)).split('\n').map(l => l.trim());
  const type = (id, text) => b.ev(`(() => { const p = ${pane(id)};
    for (const c of ${J(text)}) p.term._core.coreService.triggerDataEvent(c, true); return 1; })()`);
  const size = id => b.ev(`[${pane(id)}.term.cols, ${pane(id)}.term.rows]`);
  const fitted = id => b.ev(`(() => { const p = ${pane(id)}; const d = p.fitAddon.proposeDimensions();
    return !!d && d.cols === p.term.cols && d.rows === p.term.rows; })()`);
  const resizes = () => b.requests.resize || 0;
  const width = async w => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(400);                 // layout + the 150 ms resize debounce
  };
  const mouse = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 });
  };
  const key = async (k, code, vk) => {
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    if (k === 'Enter') await b.send('Input.dispatchKeyEvent', { type: 'char', key: k, code, text: '\r', unmodifiedText: '\r' });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const prompt = async (id, ms) => await until(async () => /[$#]\s*$/.test((await screen(id)).trimEnd() + ' ')
    && await b.ev(`!!${pane(id)}.sid`), ms || 20000) >= 0;
  const sttySize = async (id, mark) => {
    await type(id, `echo ${mark}_$(stty size | tr ' ' x)_END\r`);
    let got = null;
    await until(async () => {
      const l = (await lines(id)).find(x => x.startsWith(mark + '_') && x.endsWith('_END') && !x.includes('$('));
      if (l) got = l.slice(mark.length + 1, -4);
      return !!got;
    }, 8000);
    return got;                       // "rows x cols"
  };
  // Everything about pane id's Reconnect control, measured in the page.
  const geo = id => b.ev(`(() => {
    const p = ${pane(id)}; const c = document.querySelector('[data-reconnect=${J(id)}]');
    const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && e.offsetWidth > 0;
    const R = r => ({l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom),
                     w: Math.round(r.width), h: Math.round(r.height)});
    const box = e => R(e.getBoundingClientRect());
    const out = {shown: vis(c)};
    const bar = p.el.querySelector('.pane-bar');
    out.bar = vis(bar) ? box(bar) : null;
    out.pane = box(p.el);
    out.term = box(p.el.querySelector('.pane-term'));
    const scr = p.el.querySelector('.xterm-screen'); out.screen = scr ? box(scr) : null;
    const btns = Array.from(document.querySelectorAll('button')).filter(x => x.textContent.trim() === 'Reconnect' && vis(x));
    out.buttons = btns.filter(x => p.el.contains(x) || (x.closest('[data-reconnect]') || {}).getAttribute?.('data-reconnect') === ${J(id)}).length;
    out.visibleControlsAnywhere = Array.from(document.querySelectorAll('[data-reconnect]')).filter(vis).length;
    if (!out.shown) return out;
    const strip = c.closest('.reconnect-strip') || c.closest('.pane-bar');
    out.inBar = !!bar && c.closest('.pane-bar') === bar;
    out.inStrip = !!strip && strip !== bar;
    out.inOverlays = !!c.closest('.pane-overlays');
    out.strip = strip && vis(strip) ? box(strip) : null;
    out.stripIsBar = strip === bar;
    // The visible parts of the control; their union is what the eye sees.
    const msg = c.querySelector('span'), pw = c.querySelector('input[type=password]');
    const btn = Array.from(c.querySelectorAll('button')).find(x => x.textContent.trim() === 'Reconnect');
    const parts = [];
    if (msg && msg.textContent && vis(msg)) parts.push(['msg', msg]);
    if (pw && vis(pw)) parts.push(['pw', pw]);
    if (btn && vis(btn)) parts.push(['btn', btn]);
    out.parts = parts.map(([n, e]) => [n, box(e)]);
    const u = parts.map(([, e]) => e.getBoundingClientRect());
    // With a severity edge the control is one box: the coloured edge on
    // the left, the same room kept on the right to balance it.
    if (/sev-(err|warn)/.test(c.className)) u.push(c.getBoundingClientRect());
    out.ctl = u.length ? R({left: Math.min(...u.map(r => r.left)), top: Math.min(...u.map(r => r.top)),
      right: Math.max(...u.map(r => r.right)), bottom: Math.max(...u.map(r => r.bottom)),
      width: Math.max(...u.map(r => r.right)) - Math.min(...u.map(r => r.left)),
      height: Math.max(...u.map(r => r.bottom)) - Math.min(...u.map(r => r.top))}) : null;
    out.msg = msg ? msg.textContent : null;
    out.pwShown = !!pw && vis(pw);
    out.pwValue = pw ? pw.value : null;
    out.pwFocused = !!pw && document.activeElement === pw;
    out.sevErr = c.classList.contains('sev-err'); out.sevWarn = c.classList.contains('sev-warn');
    if (btn && vis(btn)) {
      const r = btn.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      out.btnAt = {x, y}; out.btnHit = !!hit && (hit === btn || btn.contains(hit));
      out.btnInView = r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    }
    // What else is in the bar row, and whether it is hit by the control.
    const others = [];
    if (bar && vis(bar)) {
      for (const e of bar.querySelectorAll('[data-pane-badge], .pane-tag, .pane-btn, .upload-progress')) {
        if (!vis(e) || c.contains(e) || e.contains(c)) continue;
        others.push([e.getAttribute('title') || e.className, e.getBoundingClientRect()]);
      }
      const lab = bar.querySelector('[data-pane-label]');
      if (lab && vis(lab) && lab.firstChild && !c.contains(lab)) {
        const rg = document.createRange(); rg.selectNodeContents(lab);
        const tr = rg.getBoundingClientRect(), lr = lab.getBoundingClientRect();
        const l = Math.max(tr.left, lr.left), r = Math.min(tr.right, lr.right);
        if (r > l) others.push(['label text', {left: l, right: r, top: lr.top, bottom: lr.bottom}]);
      }
    }
    out.overlaps = [];
    for (const [n, o] of others) for (const [pn, pe] of parts) {
      const q = pe.getBoundingClientRect();
      if (Math.min(q.right, o.right) - Math.max(q.left, o.left) > 0.5 && Math.min(q.bottom, o.bottom) - Math.max(q.top, o.top) > 0.5)
        out.overlaps.push(pn + ' x ' + n);
    }
    // The fixed things either side: badge + tag on the left (the label
    // text may shrink), the pane buttons (and a transfer card) on the right.
    if (bar && vis(bar)) {
      const L = Array.from(bar.querySelectorAll('[data-pane-badge], .pane-tag')).filter(e => vis(e) && !c.contains(e));
      const Rt = Array.from(bar.querySelectorAll('.pane-btn, .upload-progress')).filter(e => vis(e) && !c.contains(e));
      out.leftR = L.length ? Math.max(...L.map(e => e.getBoundingClientRect().right)) : bar.getBoundingClientRect().left;
      out.btnsL = Rt.length ? Math.min(...Rt.map(e => e.getBoundingClientRect().left)) : bar.getBoundingClientRect().right;
    }
    out.barItems = bar && vis(bar) ? {
      badge: vis(bar.querySelector('[data-pane-badge]')), label: vis(bar.querySelector('[data-pane-label]')),
      tag: vis(bar.querySelector('.pane-tag')), close: vis(bar.querySelector('[title="Close pane"]')),
      split: vis(bar.querySelector('[title="Split horizontal"]')) } : null;
    // Within the bar row: every part inside the bar's box.
    if (out.bar) out.partsInBar = parts.every(([, e]) => { const q = e.getBoundingClientRect();
      return q.left >= out.bar.l - 1 && q.right <= out.bar.r + 1 && q.top >= out.bar.t - 1 && q.bottom <= out.bar.b + 1; });
    return out;
  })()`);
  const centreOff = (g, row) => Math.abs((g.ctl.l + g.ctl.r) / 2 - (row.l + row.r) / 2);
  // Coordinator's rule (2026-10-05): exactly centred in the bar when the
  // centred control clears the fixed items on both sides; otherwise as
  // close to the centre as it can be: right next to the pane buttons (or
  // the badge/tag), not overlapping them, fully visible and clickable.
  const placed = (g, what) => {
    if (!g.ctl || !g.bar) { t.ok(false, `${what}: no control / bar to measure`); return; }
    const cw = g.ctl.r - g.ctl.l, mid = (g.bar.l + g.bar.r) / 2;
    const cl = mid - cw / 2, cr = mid + cw / 2, GAP = 2;
    const off = centreOff(g, g.bar);
    if (cr <= g.btnsL - GAP && cl >= g.leftR + GAP) {
      t.ok(off <= 4, `${what}: room to centre (control ${cw} px, buttons from ${Math.round(g.btnsL)}): centred, off by ${off.toFixed(1)} px`);
    } else if (cr > g.btnsL - GAP) {
      const gap = g.btnsL - g.ctl.r;
      t.ok(gap >= 0 && gap <= 12 && g.ctl.l >= g.leftR - 0.5 && g.btnHit && g.btnInView,
           `${what}: no room to centre (centred it would reach ${Math.round(cr)}, buttons start ${Math.round(g.btnsL)}): right next to the buttons, gap ${gap.toFixed(1)} px, clear of badge/tag (${Math.round(g.ctl.l)} >= ${Math.round(g.leftR)}), clickable ${g.btnHit}`);
    } else {
      const gap = g.ctl.l - g.leftR;
      t.ok(gap >= 0 && gap <= 12 && g.ctl.r <= g.btnsL + 0.5 && g.btnHit && g.btnInView,
           `${what}: no room left of centre: right after badge/tag, gap ${gap.toFixed(1)} px, clickable ${g.btnHit}`);
    }
  };
  const shown = async id => await until(async () => (await geo(id)).shown, 15000, 100) >= 0;
  const noCreds = (id, reason) => b.ev(`(() => { const p = ${pane(id)}; p.password = ''; p.key = '';
    showReconnectBar(p, ${J(reason || 'closed')}); return 1; })()`);

  // ── Split: two panes in one tab; A drops ──────────────────────────
  const iA = await b.connect({ persistent: false });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const iB = await b.split({ persistent: false });
  const B = await b.ev(`Object.keys(panes)[${iB}]`);
  await until(() => fitted(A), 5000);
  const barH = await b.ev(`${pane(B)}.el.querySelector('.pane-bar').offsetHeight`);
  t.ok(barH > 0, `a pane bar is ${barH} px high`);
  await sleep(400);
  let r0 = resizes();
  const [sc, sr] = await size(A);
  await type(A, 'exit\r');
  if (!t.ok(await shown(A), 'split: after `exit` A shows Reconnect')) return;
  let g = await geo(A);
  t.ok(g.inBar && !g.inOverlays, `split: the control is inside A's pane bar, not over the terminal (inBar=${g.inBar}, overlays=${g.inOverlays})`);
  t.ok(g.buttons === 1, `one Reconnect button for A (${g.buttons})`);
  t.ok(!!g.barItems && Object.values(g.barItems).every(Boolean), `badge, label, tag, split, close stay visible: ${J(g.barItems)}`);
  t.ok(!!g.ctl && g.ctl.b <= g.term.t + 1, `the control is above the terminal, not on it: ctl ${J(g.ctl)}, terminal top ${g.term.t}`);
  for (const w of [1200, 900, 700]) {
    await width(w);
    for (const variant of ['bare', 'password', 'auth_failed']) {
      if (variant === 'bare') await b.ev(`(() => { const p = ${pane(A)}; p.password = ${J(cfg.password)}; showReconnectBar(p, 'closed'); return 1; })()`);
      if (variant === 'password') await noCreds(A, 'closed');
      if (variant === 'auth_failed') await noCreds(A, 'auth_failed');
      await sleep(100);
      g = await geo(A);
      const pw = g.bar ? g.bar.w : 0;
      t.ok(g.inBar && g.partsInBar, `${w}px window (bar ${pw}px), ${variant}: control within the bar (parts ${J(g.parts)}, bar ${J(g.bar)})`);
      placed(g, `${w}px, ${variant}`);
      t.ok(g.overlaps.length === 0, `${w}px, ${variant}: nothing in the bar overlaps it: ${J(g.overlaps)}`);
      t.ok(g.btnHit && g.btnInView, `${w}px, ${variant}: the Reconnect button is on top and in view (hit=${g.btnHit})`);
    }
    t.ok(/Authentication failed/.test(g.msg) && g.sevErr && g.pwShown, `${w}px: auth message red with the password input (${J(g.msg)})`);
  }
  // Narrow: the pane is ~250 px. It may shrink the message, never cover the buttons.
  await width(520);
  for (const variant of ['bare', 'auth_failed']) {
    if (variant === 'bare') await b.ev(`(() => { const p = ${pane(A)}; p.password = ${J(cfg.password)}; showReconnectBar(p, 'closed'); return 1; })()`);
    else await noCreds(A, 'auth_failed');
    await sleep(100);
    g = await geo(A);
    t.ok(g.inBar && g.partsInBar, `narrow (bar ${g.bar && g.bar.w}px), ${variant}: control within the bar: ${J(g.parts)}`);
    t.ok(g.overlaps.filter(o => !/label text/.test(o)).length === 0,
         `narrow, ${variant}: no overlap with badge, tag or buttons: ${J(g.overlaps)}`);
    t.ok(g.btnHit && g.btnInView, `narrow, ${variant}: Reconnect still clickable (hit=${g.btnHit}, in view=${g.btnInView})`);
  }
  await width(1200);
  const [sc2, sr2] = await size(A);
  t.ok(sc2 === sc && sr2 === sr, `split: A's terminal kept its size while Reconnect showed: ${sc}x${sr} -> ${sc2}x${sr2}`);

  // Type the password into the bar's input, click Reconnect with the mouse.
  await noCreds(A, 'closed');
  await sleep(100);
  await b.ev(`document.querySelector('[data-reconnect-pw=${J(A)}]').focus()`);
  await b.send('Input.insertText', { text: cfg.password });
  g = await geo(A);
  if (g.btnAt) await mouse(g.btnAt.x, g.btnAt.y);
  t.ok(await prompt(A), 'split: password typed in the bar + a real click on Reconnect: A is back at a prompt');
  await until(async () => !(await geo(A)).shown, 3000, 100);
  g = await geo(A);
  t.ok(!g.shown && g.buttons === 0, 'and the control is gone');

  // ── Split -> lone while disconnected: password and focus kept ─────
  await type(A, 'exit\r');
  await shown(A);
  await noCreds(A, 'closed');
  await sleep(100);
  await b.ev(`document.querySelector('[data-reconnect-pw=${J(A)}]').focus()`);
  await b.send('Input.insertText', { text: 'half' });
  await b.ev(`closePane(${J(B)})`);
  await until(async () => (await b.ev('Object.keys(panes).length')) === 1 && await fitted(A), 5000);
  await sleep(400);
  g = await geo(A);
  t.ok(g.shown, 'lone (neighbour closed): the control is still shown');
  t.ok(g.pwValue === 'half' && g.pwShown, `the typed password survived the move (${J(g.pwValue)})`);
  t.ok(g.pwFocused, 'and the input still has focus');
  // Finish typing, Enter: reconnects with what was typed.
  await b.ev(`(() => { const i = document.querySelector('[data-reconnect-pw=${J(A)}]'); i.value = ''; i.focus(); return 1; })()`);
  await b.send('Input.insertText', { text: cfg.password });

  // ── Lone: the strip ───────────────────────────────────────────────
  const stripCheck = (g, what) => {
    t.ok(!!g.strip, `${what}: a strip holds the control (${g.inOverlays ? 'it is a card in the overlay stack' : 'in: ' + (g.inBar ? 'pane bar' : 'other')})`);
    if (!g.strip) return;
    t.ok(Math.abs(g.strip.t - g.pane.t) <= 1, `${what}: the strip is at the top of the pane (strip top ${g.strip.t}, pane top ${g.pane.t})`);
    t.ok(Math.abs(g.strip.l - g.pane.l) <= 1 && Math.abs(g.strip.r - g.pane.r) <= 1,
         `${what}: it spans the pane (${g.strip.l}..${g.strip.r} vs ${g.pane.l}..${g.pane.r})`);
    t.ok(Math.abs(g.strip.h - barH) <= 3, `${what}: it is a pane bar high (${g.strip.h} px, bar ${barH} px)`);
    t.ok(!!g.ctl && centreOff(g, g.strip) <= 4, `${what}: the control is centred in it (off ${g.ctl ? centreOff(g, g.strip).toFixed(1) : '?'} px)`);
    t.ok(!!g.ctl && g.ctl.t >= g.strip.t - 1 && g.ctl.b <= g.strip.b + 1, `${what}: and within its height (ctl ${J(g.ctl)})`);
    t.ok(g.btnHit && g.btnInView, `${what}: Reconnect clickable (hit=${g.btnHit})`);
    t.ok(g.buttons === 1 && g.visibleControlsAnywhere === 1, `${what}: one Reconnect on the page (${g.buttons}/${g.visibleControlsAnywhere})`);
  };
  g = await geo(A);
  stripCheck(g, 'lone, password');
  const [lc, lr] = await size(A);
  r0 = resizes();
  await key('Enter', 'Enter', 13);
  t.ok(await prompt(A), 'Enter in the strip\'s input: reconnected with the typed password');
  await until(async () => !(await geo(A)).shown, 3000, 100);
  await sleep(500);
  g = await geo(A);
  t.ok(!g.shown && !g.strip && g.buttons === 0, 'the strip is gone once connected');
  let [c, r] = await size(A);
  t.ok(c === lc && r === lr, `the terminal did not change size around the strip: ${lc}x${lr} -> ${c}x${r}`);
  let sz = await sttySize(A, 'RC1');
  t.ok(sz === `${lr}x${lc}`, `the PTY has the terminal's size: ${sz} (want ${lr}x${lc})`);

  // Plain drop (creds in memory): bare button in the strip; nothing moves.
  r0 = resizes();
  const scr0 = (await geo(A)).screen;
  await type(A, 'exit\r');
  await shown(A);
  await sleep(500);
  g = await geo(A);
  stripCheck(g, 'lone, bare');
  [c, r] = await size(A);
  t.ok(c === lc && r === lr, `strip shown: terminal still ${lc}x${lr} (${c}x${r})`);
  t.ok(!!g.screen && !!scr0 && g.screen.t === scr0.t && g.screen.h === scr0.h,
       `the terminal screen is not pushed or shrunk (top ${scr0 && scr0.t} -> ${g.screen && g.screen.t}, h ${scr0 && scr0.h} -> ${g.screen && g.screen.h})`);
  t.ok(resizes() === r0, `no /api/resize while it shows (${resizes() - r0})`);
  t.ok(await b.ev(`(() => { const g = document.getElementById('paneTools'); return !!g && g.offsetWidth > 0 && !!g.querySelector('.pane-tag:not(.h)'); })()`),
       'the top bar still carries the pane actions and the short-lived tag');
  if (g.btnAt) await mouse(g.btnAt.x, g.btnAt.y);
  t.ok(await prompt(A), 'a real click on the strip\'s Reconnect reconnects');
  await until(async () => !(await geo(A)).shown, 3000, 100);
  await sleep(500);
  [c, r] = await size(A);
  t.ok(c === lc && r === lr && !(await geo(A)).strip, `strip gone, size still ${lc}x${lr} (${c}x${r})`);
  sz = await sttySize(A, 'RC2');
  t.ok(sz === `${lr}x${lc}`, `PTY ${sz}`);
  t.ok(resizes() === r0, `no /api/resize for the strip at all (${resizes() - r0})`);

  // ── Lone: a transfer's progress card and the strip ────────────────
  const name = 'websh-e2e-rc-' + tagOf('U') + '.bin';
  const local = path.join(os.tmpdir(), name);
  fs.writeFileSync(local, Buffer.alloc(900 * 1024, 7));
  try {
    await type(A, 'cd ~\r');
    await b.send('Page.setInterceptFileChooserDialog', { enabled: true });
    let chooser = null;
    const on = b._on.bind(b);
    b._on = d => { if (d.method === 'Page.fileChooserOpened') chooser = d.params; on(d); };
    await b.network({ upload: 60 * 1024 });
    await b.ev(`triggerUpload(${J(A)})`);
    if (t.ok(await until(() => !!chooser, 3000) >= 0, 'upload: the file picker opened')) {
      await b.send('DOM.setFileInputFiles', { files: [local], backendNodeId: chooser.backendNodeId });
      const prog = () => b.ev(`(() => { const v = Array.from(document.querySelectorAll('.upload-progress')).filter(e => e.offsetWidth > 0);
        if (!v.length) return null; const r = v[0].getBoundingClientRect(); const c = v[0].querySelector('.upload-progress-cancel');
        const q = c.getBoundingClientRect(); const h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
        return {l: r.left, r: r.right, t: r.top, b: r.bottom, cancelHit: !!h && (h === c || c.contains(h))}; })()`);
      await until(async () => !!(await prog()), 5000, 100);
      await b.ev(`showReconnectBar(${pane(A)}, 'closed')`);   // the strip while the card is up
      await sleep(200);
      g = await geo(A);
      const p = await prog();
      t.ok(!!p && !!g.strip, `progress card and strip both shown (card ${J(p)}, strip ${J(g.strip)})`);
      if (p && g.strip) {
        const ov = Math.min(p.r, g.strip.r) - Math.max(p.l, g.strip.l) > 0.5 && Math.min(p.b, g.strip.b) - Math.max(p.t, g.strip.t) > 0.5;
        t.ok(!ov, 'they do not overlap');
        t.ok(p.cancelHit && g.btnHit, `cancel and Reconnect both clickable (cancel=${p.cancelHit}, reconnect=${g.btnHit})`);
      }
      await b.ev(`hideReconnectBar(${pane(A)})`);
      await b.ev(`cancelTransfer(${J(A)})`);
    }
  } finally {
    delete b._on;
    await b.network({});
    await b.send('Page.setInterceptFileChooserDialog', { enabled: false });
    try { fs.unlinkSync(local); } catch (e) {}
    try { fs.unlinkSync(path.join(os.homedir(), name)); } catch (e) {}
    await type(A, `rm -f ~/${name} ~/${name}.*\r`).catch(() => {});
  }
}
