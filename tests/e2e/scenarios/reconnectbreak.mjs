// The Reconnect control in the bar row, under attack: what changes the
// space around it while a pane stays disconnected. The bar's CSS gets
// content widths measured in JS (--rc-*), refreshed only when what the
// control shows changes - so anything that changes widths without that
// (window resize, terminal font zoom, a tab hidden and shown, the device
// pixel ratio, the message changing in place) could leave it stale.
//
//   - auth_failed straight from a plain drop, at 900 px (no earlier state)
//   - the window resized 1200 -> 640 -> 1000 -> 560 while disconnected
//   - terminal font zoom (zoomIn/zoomOut) while disconnected, split and lone
//   - device pixel ratio 1.5 (rounding)
//   - the tab hidden, the window resized, the tab shown again
//   - reconnect / disconnect three times, split and lone: one control,
//     no stale strip, the terminal untouched by the lone strip
//   - lone strip together with the search bar, the tmux banner and the
//     "reconnecting..." banner: no overlap, all clickable
//
// Placement rule (coordinator, 2026-10-05): exactly centred in the bar
// when the centred control clears badge/tag and the buttons; else right
// next to the buttons (or badge/tag), not overlapping, clickable. Lone:
// a bar-high full-width strip at the top, control centred in it.
import { sleep, until, cfg } from '../lib.mjs';
export const meta = {
  about: 'Reconnect in the bar row under resize, font zoom, DPR, tab switches, repeated drops, search/tmux/retry banners',
  ssh: true, local: true,
};

export async function run({ b, t }) {
  const J = JSON.stringify;
  const pane = id => `panes[${J(id)}]`;
  const screen = id => b.ev(`(() => { const p = ${pane(id)}; if (!p || !p.term) return '';
    const bf = p.term.buffer.active; let s = '';
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) s += l.translateToString(true) + '\\n'; }
    return s; })()`);
  const type = (id, text) => b.ev(`(() => { const p = ${pane(id)};
    for (const c of ${J(text)}) p.term._core.coreService.triggerDataEvent(c, true); return 1; })()`);
  const size = id => b.ev(`[${pane(id)}.term.cols, ${pane(id)}.term.rows]`);
  const fitted = id => b.ev(`(() => { const p = ${pane(id)}; const d = p.fitAddon.proposeDimensions();
    return !!d && d.cols === p.term.cols && d.rows === p.term.rows; })()`);
  const resizes = () => b.requests.resize || 0;
  const win = async (w, dpr) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: dpr || 1, mobile: false });
    await sleep(400);
  };
  const mouse = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 });
  };
  const prompt = async (id, ms) => await until(async () => /[$#]\s*$/.test((await screen(id)).trimEnd() + ' ')
    && await b.ev(`!!${pane(id)}.sid`), ms || 20000) >= 0;
  const geo = id => b.ev(`(() => {
    const p = ${pane(id)}; const c = document.querySelector('[data-reconnect=' + ${J(J(id))} + ']');
    const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && e.offsetWidth > 0;
    const R = r => ({l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height)});
    const box = e => R(e.getBoundingClientRect());
    const hitOk = e => { const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!h && (h === e || e.contains(h)); };
    const out = {shown: vis(c), pane: box(p.el)};
    const bar = p.el.querySelector('.pane-bar');
    out.bar = vis(bar) ? box(bar) : null;
    out.visibleControls = Array.from(document.querySelectorAll('[data-reconnect]')).filter(vis).length;
    out.visibleStrips = Array.from(document.querySelectorAll('.reconnect-strip')).filter(vis).length;
    if (!out.shown) return out;
    const strip = c.closest('.reconnect-strip') || c.closest('.pane-bar');
    out.strip = strip && strip !== bar && vis(strip) ? box(strip) : null;
    out.inBar = !!bar && c.closest('.pane-bar') === bar;
    const parts = ['span', 'input[type=password]', 'button'].map(s => c.querySelector(s))
      .filter(e => e && vis(e) && (e.tagName !== 'SPAN' || e.textContent));
    const u = parts.map(e => e.getBoundingClientRect());
    // With a severity edge the control is one box: the coloured edge on
    // the left, the same room kept on the right to balance it.
    if (/sev-(err|warn)/.test(c.className)) u.push(c.getBoundingClientRect());
    out.ctl = R({left: Math.min(...u.map(r => r.left)), top: Math.min(...u.map(r => r.top)), right: Math.max(...u.map(r => r.right)),
                 bottom: Math.max(...u.map(r => r.bottom)), width: 0, height: 0});
    const btn = c.querySelector('button');
    out.btnHit = vis(btn) && hitOk(btn);
    const br = btn.getBoundingClientRect(); out.btnAt = {x: br.left + br.width / 2, y: br.top + br.height / 2};
    out.btnInView = br.left >= 0 && br.right <= innerWidth;
    out.msg = (c.querySelector('span') || {}).textContent;
    if (bar && vis(bar)) {
      const L = Array.from(bar.querySelectorAll('[data-pane-badge], .pane-tag')).filter(e => vis(e) && !c.contains(e));
      const Rt = Array.from(bar.querySelectorAll('.pane-btn, .upload-progress')).filter(e => vis(e) && !c.contains(e));
      out.leftR = L.length ? Math.max(...L.map(e => e.getBoundingClientRect().right)) : bar.getBoundingClientRect().left;
      out.btnsL = Rt.length ? Math.min(...Rt.map(e => e.getBoundingClientRect().left)) : bar.getBoundingClientRect().right;
      out.overlaps = [];
      for (const o of L.concat(Rt)) for (const pe of parts) {
        const a = o.getBoundingClientRect(), q = pe.getBoundingClientRect();
        if (Math.min(q.right, a.right) - Math.max(q.left, a.left) > 0.5 && Math.min(q.bottom, a.bottom) - Math.max(q.top, a.top) > 0.5)
          out.overlaps.push(pe.tagName + ' x ' + (o.getAttribute('title') || o.className));
      }
      out.buttonsAllShown = Rt.filter(e => e.classList.contains('pane-btn')).length;
      // "Move to tab" is not shown with one tab (nowhere to move to).
      out.buttonsWant = tabs.length > 1 ? 7 : 6;
      out.partsInBar = u.every(q => q.left >= out.bar.l - 1 && q.right <= out.bar.r + 1 && q.top >= out.bar.t - 1 && q.bottom <= out.bar.b + 1);
    }
    return out;
  })()`);
  const centreOff = (g, row) => Math.abs((g.ctl.l + g.ctl.r) / 2 - (row.l + row.r) / 2);
  const placedBar = (g, what) => {
    if (!t.ok(g.shown && g.inBar && g.partsInBar, `${what}: the control is within the pane bar (bar ${J(g.bar)}, ctl ${J(g.ctl)})`)) return;
    const cw = g.ctl.r - g.ctl.l, mid = (g.bar.l + g.bar.r) / 2, cl = mid - cw / 2, cr = mid + cw / 2, GAP = 2;
    t.ok(g.overlaps.length === 0, `${what}: nothing overlaps it ${J(g.overlaps)}`);
    t.ok(g.btnHit && g.btnInView, `${what}: Reconnect clickable (hit ${g.btnHit}, in view ${g.btnInView})`);
    t.ok(g.buttonsAllShown >= g.buttonsWant, `${what}: all ${g.buttonsWant} pane buttons still shown (${g.buttonsAllShown})`);
    if (cr <= g.btnsL - GAP && cl >= g.leftR + GAP)
      t.ok(centreOff(g, g.bar) <= 4, `${what}: room to centre - centred, off ${centreOff(g, g.bar).toFixed(1)} px (bar ${g.bar.l}..${g.bar.r}, ctl ${g.ctl.l}..${g.ctl.r}, badge/tag end ${Math.round(g.leftR)}, buttons from ${Math.round(g.btnsL)}, msg ${J(g.msg)})`);
    else if (cr > g.btnsL - GAP) {
      const gap = g.btnsL - g.ctl.r;
      t.ok(gap >= 0 && gap <= 12 && g.ctl.l >= g.leftR - 0.5,
           `${what}: no room - next to the buttons, gap ${gap.toFixed(1)} px (control ${Math.round(g.ctl.l)}..${Math.round(g.ctl.r)}, buttons from ${Math.round(g.btnsL)}, badge/tag end ${Math.round(g.leftR)})`);
    } else {
      const gap = g.ctl.l - g.leftR;
      t.ok(gap >= 0 && gap <= 12, `${what}: no room left - next to badge/tag, gap ${gap.toFixed(1)} px`);
    }
  };
  let barH = 24;
  const placedStrip = (g, what) => {
    if (!t.ok(g.shown && !!g.strip, `${what}: the control is in a strip (${g.inBar ? 'in the pane bar' : 'no strip'})`)) return;
    t.ok(Math.abs(g.strip.t - g.pane.t) <= 1 && Math.abs(g.strip.l - g.pane.l) <= 1 && Math.abs(g.strip.r - g.pane.r) <= 1,
         `${what}: strip at the top, full width (${J(g.strip)} vs pane ${J(g.pane)})`);
    t.ok(Math.abs(g.strip.h - barH) <= 3, `${what}: strip ${g.strip.h} px high (a bar is ${barH})`);
    t.ok(centreOff(g, g.strip) <= 4 && g.ctl.t >= g.strip.t - 1 && g.ctl.b <= g.strip.b + 1,
         `${what}: control centred in the strip (off ${centreOff(g, g.strip).toFixed(1)} px, ctl ${J(g.ctl)})`);
    t.ok(g.btnHit, `${what}: Reconnect clickable`);
  };
  const shown = async id => await until(async () => (await geo(id)).shown, 15000, 100) >= 0;
  const drop = async id => { await type(id, 'exit\r'); return shown(id); };
  const authFailed = id => b.ev(`(() => { const p = ${pane(id)}; p.password = ''; p.key = ''; showReconnectBar(p, 'auth_failed'); return 1; })()`);
  const restoreCreds = id => b.ev(`(() => { ${pane(id)}.password = ${J(cfg.password)}; return 1; })()`);
  const clickReconnect = async id => { const g = await geo(id); if (g.btnAt) await mouse(g.btnAt.x, g.btnAt.y); return prompt(id); };

  // Two panes in tab 1.
  const iA = await b.connect({ persistent: false });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const iB = await b.split({ persistent: false });
  const B = await b.ev(`Object.keys(panes)[${iB}]`);
  await until(() => fitted(A), 5000);
  barH = await b.ev(`${pane(B)}.el.querySelector('.pane-bar').offsetHeight`);

  // auth_failed straight away at 900 px: no earlier state to reuse.
  await win(900);
  await drop(A);
  await authFailed(A);
  await sleep(150);
  placedBar(await geo(A), '900px, auth_failed first');
  // The message changes in place (auth_failed -> plain password hint -> auth_failed).
  await b.ev(`showReconnectBar(${pane(A)}, 'closed')`); await sleep(100);
  placedBar(await geo(A), '900px, password hint after auth_failed');
  await authFailed(A); await sleep(100);
  placedBar(await geo(A), '900px, auth_failed again');

  // Window resized while disconnected.
  for (const w of [1200, 640, 1000, 560, 1200]) {
    await win(w);
    placedBar(await geo(A), `window -> ${w}px, auth_failed`);
  }
  await restoreCreds(A);
  await b.ev(`showReconnectBar(${pane(A)}, 'closed')`);
  for (const w of [640, 1200]) { await win(w); placedBar(await geo(A), `window -> ${w}px, bare`); }

  // Terminal font zoom while disconnected (the app's zoom: terminal font).
  for (const [f, what] of [['zoomIn', 'font +2'], ['zoomIn', 'font +4'], ['zoomOut', 'font +2'], ['zoomOut', 'font 0']]) {
    await b.ev(`${f}()`); await sleep(400);
    placedBar(await geo(A), `split, ${what}`);
  }
  // Device pixel ratio 1.5.
  await win(900, 1.5);
  await authFailed(A); await sleep(150);
  placedBar(await geo(A), 'DPR 1.5, 900px, auth_failed');
  await win(1200);

  // Tab hidden, window resized meanwhile, shown again.
  const tabsBefore = await b.ev(`tabs.length`);
  const t1 = await b.ev(`activeTabId`);
  const before = await b.ev('Object.keys(panes).length');
  await b.ev(`(() => { const n = document.getElementById('tabNew'); n.click(); return 1; })()`);
  await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
  await b.ev(`(() => { ${b._fill(false)} doConnect(); return 1; })()`);
  const iC = await b._ready(before);
  const C = await b.ev(`Object.keys(panes)[${iC}]`);
  const t2 = await b.ev(`activeTabId`);
  t.ok(t2 !== t1 && (await b.ev('tabs.length')) > tabsBefore - 1, 'a second tab is in front');
  let g = await geo(A);
  t.ok(!g.shown && g.visibleControls === 0, `hidden tab: A's Reconnect not shown (${g.visibleControls} on screen)`);
  await win(700);
  await b.ev(`showTab(${J(t1)})`); await sleep(400);
  placedBar(await geo(A), 'tab shown again after a resize at 700px');
  await win(1200);
  await b.ev(`showTab(${J(t1)})`); await sleep(300);
  placedBar(await geo(A), 'and back at 1200px');

  // Reconnect / drop three times in the split.
  await restoreCreds(A);
  await b.ev(`showReconnectBar(${pane(A)}, 'closed')`);
  for (let k = 1; k <= 3; k++) {
    t.ok(await clickReconnect(A), `split cycle ${k}: a real click reconnects`);
    await until(async () => !(await geo(A)).shown, 3000, 100);
    g = await geo(A);
    t.ok(!g.shown && g.visibleControls === 0, `split cycle ${k}: no control left once connected`);
    t.ok(await drop(A), `split cycle ${k}: dropped again`);
    placedBar(await geo(A), `split cycle ${k}`);
  }

  // Lone: close B. A is alone, disconnected.
  await b.ev(`closePane(${J(B)})`);
  await until(async () => (await b.ev(`panesInTab(tabById(${J(t1)})).length`)) === 1 && await fitted(A), 5000);
  await sleep(400);
  placedStrip(await geo(A), 'lone');
  // Font zoom on a lone, disconnected pane: the strip keeps its look.
  await b.ev('zoomIn()'); await sleep(400);
  placedStrip(await geo(A), 'lone, font +2');
  await b.ev('zoomOut()'); await sleep(400);
  for (const w of [640, 1200]) { await win(w); placedStrip(await geo(A), `lone, window ${w}px`); }

  // Lone: reconnect / drop three times; the strip never resizes the terminal.
  await until(() => fitted(A), 3000);
  const [lc, lr] = await size(A);
  // The first reconnect after the font / window changes above may send
  // one /api/resize (the server last heard an older size; the old code
  // does the same). From then on the strip coming and going sends none.
  let r0 = resizes();
  for (let k = 1; k <= 3; k++) {
    t.ok(await clickReconnect(A), `lone cycle ${k}: a real click reconnects`);
    if (k === 1) { await sleep(500); r0 = resizes(); }
    await until(async () => !(await geo(A)).shown, 3000, 100);
    g = await geo(A);
    t.ok(!g.shown && g.visibleStrips === 0, `lone cycle ${k}: strip gone once connected (${g.visibleStrips} strips)`);
    t.ok(await drop(A), `lone cycle ${k}: dropped again`);
    await sleep(300);
    placedStrip(await geo(A), `lone cycle ${k}`);
    const [c, r] = await size(A);
    t.ok(c === lc && r === lr, `lone cycle ${k}: terminal still ${lc}x${lr} (${c}x${r}); /api/resize so far ${resizes() - r0}`);
  }
  t.ok(resizes() === r0, `no /api/resize over lone cycles 1 (after its reconnect) to 3 (${resizes() - r0})`);

  // Lone strip with the search bar, the tmux banner, the retry banner.
  const others = sel => b.ev(`(() => { const p = ${pane(A)}; const e = p.el.querySelector(${J(sel)});
    if (!e || !e.offsetWidth) return null; const r = e.getBoundingClientRect();
    const hitIn = el => { const q = el.getBoundingClientRect(); const h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !!h && (h === el || el.contains(h)); };
    const firstCtl = e.querySelector('input, button') || e;
    const q = firstCtl.getBoundingClientRect(); const h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    return {l: r.left, r: r.right, t: r.top, b: r.bottom, hit: hitIn(firstCtl), at: h ? [h, h.parentElement, h.parentElement && h.parentElement.parentElement].map(x => x ? x.tagName + '.' + x.className + (x.getAttribute('data-pane') || '') : '').join(' < ') + ' ' + JSON.stringify(h.getBoundingClientRect()) : null}; })()`);
  const noClash = async (sel, what, textOnly) => {
    const o = await others(sel), g = await geo(A);
    if (!t.ok(!!o && !!g.strip, `${what}: shown together with the strip (${J(o)}, strip ${J(g.strip)})`)) return;
    const ov = Math.min(o.r, g.strip.r) - Math.max(o.l, g.strip.l) > 0.5 && Math.min(o.b, g.strip.b) - Math.max(o.t, g.strip.t) > 0.5;
    t.ok(!ov, `${what}: does not overlap the strip (${Math.round(o.t)}..${Math.round(o.b)} vs strip ${g.strip.t}..${g.strip.b})`);
    // A text-only banner (the retry notice) lets clicks through on
    // purpose (pointer-events:none); only the strip's button must be on top.
    t.ok((textOnly || o.hit) && g.btnHit, `${what}: both on top where they are (${o.hit}${o.hit ? '' : ', covered by ' + o.at}; Reconnect ${g.btnHit})`);
  };
  await b.ev(`(() => { activatePane(${J(A)}); toggleSearch(); return 1; })()`); await sleep(200);
  await noClash('[data-search]', 'search bar');
  await b.ev(`closeSearch()`);
  await b.ev(`(() => { const p = ${pane(A)}; p.firstFailureAt = Date.now(); setReconnecting(p, true); return 1; })()`); await sleep(200);
  await noClash('.pane-reconnect', '"reconnecting..." banner', true);
  await b.ev(`setReconnecting(${pane(A)}, false)`);
  await b.ev(`(() => { const p = ${pane(A)}; showTmuxBar(p, 'tmux missing'); showReconnectBar(p, 'closed'); return 1; })()`); await sleep(200);
  await noClash('[data-tmux-bar]', 'tmux banner');
  await b.ev(`(() => { const e = ${pane(A)}.el.querySelector('[data-tmux-bar]'); if (e) e.classList.add('h'); return 1; })()`);

  // Leave A connected so the harness ends its session cleanly.
  await restoreCreds(A);
  await b.ev(`showReconnectBar(${pane(A)}, 'closed')`);
  await clickReconnect(A);
  void C;
}
