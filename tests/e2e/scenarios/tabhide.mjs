// A control whose action is impossible in the current layout is not
// shown (owner, 2026-10-06: "the Move to tab button should be removed
// when there are no other tabs"): "Move to tab" in the top bar of a lone
// pane and in every pane bar, and "Move into tab" in a tab's menu, are
// absent with one tab and come back the moment a second tab exists -
// opened, closed by its x or Alt+W, after a reload. The top bar's width
// changes with it: at 560 px the tab in front must stay fully in the
// strip when the button comes and goes (tabnarrow checks only five tabs,
// where the button is always there). Real mouse, real keys.
import { sleep, until } from '../lib.mjs';
export const meta = {
  about: '"Move to tab" / "Move into tab" hidden with one tab, back with two (open, x, Alt+W, merge, reload), tab in front stays in the strip at 560 px',
  ssh: true, local: true,
};

export async function run({ b, t }) {
  const J = JSON.stringify;
  const rect = sel => b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e || !e.offsetWidth) return null;
    const q = e.getBoundingClientRect(); return {x: q.x, y: q.y, w: q.width, h: q.height}; })()`);
  const mid = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const mouse = (type, p, buttons, extra) => b.send('Input.dispatchMouseEvent', Object.assign(
    { type, x: p.x, y: p.y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }, extra || {}));
  const calm = () => until(() => b.ev('typeof _clickBlockUntil === "undefined" || !_clickBlockUntil || Date.now() > _clickBlockUntil'), 2000, 20);
  const click = async sel => {
    await calm();
    const r = await rect(sel);
    if (!r) throw new Error('no visible element ' + sel);
    await mouse('mouseMoved', mid(r), 0); await sleep(30);
    await mouse('mousePressed', mid(r), 1); await mouse('mouseReleased', mid(r), 0);
  };
  const frame = () => b.ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const key = async (code, k, vk, mods) => {
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 });
  };
  const ALT = 1;
  const tabIds = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getAttribute('data-tab'))`);
  const activeTab = () => b.ev(`(() => { const e = document.querySelector('#tabs .tab.active'); return e ? e.getAttribute('data-tab') : null; })()`);
  const tabOf = id => b.ev(`(() => { const r = panes[${J(id)}].el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; })()`);
  const tabSel = tid => `#tabs .tab[data-tab="${tid}"]`;
  // Every "Move to tab" button a person can see and hit: laid out, and
  // the topmost element at its centre.
  const moveButtons = () => b.ev(`Array.from(document.querySelectorAll('[data-act="move-to"]')).filter(e => {
      if (!e.offsetWidth || !e.offsetHeight) return false;
      const q = e.getBoundingClientRect(); const h = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2);
      return !!h && (h === e || e.contains(h)); })
    .map(e => e.closest('#paneTools') ? 'top bar' : 'bar of ' + e.closest('.pane').getAttribute('data-pane'))`);
  const toolsShown = () => b.ev(`(() => { const g = document.getElementById('paneTools'); return !!g && g.offsetWidth > 0; })()`);
  const menuItems = () => b.ev(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
    .filter(e => e.offsetWidth > 0).map(e => e.textContent.replace(/\\s+/g, ' ').trim())`);
  const rightClick = async sel => {
    await calm();
    const r = mid(await rect(sel));
    await mouse('mouseMoved', r, 0);
    await mouse('mousePressed', r, 2, { button: 'right' });
    await mouse('mouseReleased', r, 0, { button: 'right' });
    await until(async () => (await menuItems()).length > 0, 2000);
    const items = await menuItems();
    await key('Escape', 'Escape', 27, 0);
    await until(async () => (await menuItems()).length === 0, 2000);
    return items;
  };
  const into = items => items.some(x => /^Move into tab/i.test(x));
  const newTab = async () => {
    const before = await b.ev('Object.keys(panes).length');
    await click('#tabNew');
    await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
    await b.ev(`(() => { ${b._fill(false)} doConnect(); return 1; })()`);
    const i = await b._ready(before);
    return b.ev(`Object.keys(panes)[${i}]`);
  };
  const splitOf = async (id, dir) => {
    const before = await b.ev('Object.keys(panes).length');
    await b.ev(`(() => { splitPane(${J(id)}, ${J(dir)}); ${b._fill(false)} doConnect(); return 1; })()`);
    const i = await b._ready(before);
    return b.ev(`Object.keys(panes)[${i}]`);
  };
  const focusPane = id => b.ev(`(() => { panes[${J(id)}].term.focus(); return 1; })()`);
  const fits = () => b.ev(`(() => { const s = document.getElementById('tabs'); const r = s.getBoundingClientRect();
    const a = s.querySelector('.tab.active'); if (!a) return {fits: false};
    const q = a.getBoundingClientRect();
    return { fits: q.left >= r.left - 1 && q.right <= r.right + 1, strip: Math.round(r.width), tab: [Math.round(q.left), Math.round(q.right)],
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);

  // 1. One tab, one (persistent) pane.
  const A = await b.ev(`Object.keys(panes)[${await b.connect({ persistent: true })}]`);
  const tA = await tabOf(A);
  await frame();
  t.ok(await toolsShown(), '1: a lone pane: the pane actions are in the top bar');
  let mv = await moveButtons();
  t.ok(mv.length === 0, `1: one tab: no "Move to tab" anywhere (${J(mv)})`);
  t.ok(!!(await rect('#paneTools [data-act="split-h"]')) && !!(await rect('#paneTools [data-act="close"]')), '1: split and close still in the top bar');
  let items = await rightClick(tabSel(tA) + ' .tab-label');
  t.ok(!into(items) && items.some(x => /^Rename/i.test(x)), `1: the tab menu has no "Move into tab" (${J(items)})`);

  // 2. A split: still one tab.
  const A2 = await splitOf(A, 'h');
  await frame();
  mv = await moveButtons();
  t.ok(mv.length === 0, `2: one tab, two panes: no "Move to tab" in either bar (${J(mv)})`);
  t.ok(!!(await rect(`#panes .pane[data-pane="${A2}"] .pane-bar [data-act="to-tab"]`)), '2: "Move to new tab" is in the bar');

  // 3. A second tab: the button is there at once, and works.
  const B = await newTab();
  const tB = await tabOf(B);
  await frame();
  mv = await moveButtons();
  t.ok(mv.includes('top bar'), `3: B (lone) opened: "Move to tab" in the top bar (${J(mv)})`);
  items = await rightClick(tabSel(tB) + ' .tab-label');
  t.ok(into(items), `3: B's menu has "Move into tab" (${J(items)})`);
  await click(tabSel(tA) + ' .tab-label');
  await until(async () => await activeTab() === tA, 2000);
  await frame();
  mv = await moveButtons();
  t.ok(mv.length === 2 && !mv.includes('top bar'), `3: A in front: both of its bars show "Move to tab" (${J(mv)})`);

  // 4. B closed by its x while A is in front.
  await mouse('mouseMoved', mid(await rect(tabSel(tB) + ' .tab-label')), 0);
  await sleep(100);
  await click(tabSel(tB) + ' .tab-close');
  await until(async () => (await tabIds()).length === 1, 3000);
  await frame();
  t.ok((await tabIds()).length === 1 && await activeTab() === tA, '4: B closed by its x, A in front');
  mv = await moveButtons();
  t.ok(mv.length === 0, `4: one tab again: no "Move to tab" anywhere, at once (${J(mv)})`);
  items = await rightClick(tabSel(tA) + ' .tab-label');
  t.ok(!into(items), `4: A's menu lost "Move into tab" (${J(items)})`);

  // 5. Narrow window, a lone pane: the button comes and goes, the tab in
  //    front stays inside the strip.
  await b.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 650, deviceScaleFactor: 1, mobile: false });
  await frame();
  await b.ev(`(() => { closePane(${J(A2)}); return 1; })()`);
  await until(() => b.ev(`!panes[${J(A2)}]`), 3000);
  await frame();
  let f = await fits();
  t.ok(await toolsShown() && f.fits && f.page <= 0, `5: 560 px, one tab, lone pane: the tab fits (${J(f)})`);
  const C = await newTab();
  const tC = await tabOf(C);
  await frame(); await frame();
  mv = await moveButtons();
  f = await fits();
  t.ok(mv.includes('top bar'), `5: 560 px, C opened: "Move to tab" back in the top bar (${J(mv)})`);
  t.ok(f.fits && f.page <= 0, `5: 560 px: C, in front, fully inside the strip once the button is back (${J(f)})`);
  await click(tabSel(tA) + ' .tab-label');
  await until(async () => await activeTab() === tA, 2000);
  await frame(); await frame();
  f = await fits();
  t.ok(f.fits && f.page <= 0, `5: 560 px: A shown, fully inside the strip (${J(f)})`);
  await click(tabSel(tC) + ' .tab-label');
  await until(async () => await activeTab() === tC, 2000);
  await focusPane(C);
  await key('KeyW', 'w', 87, ALT);
  await until(async () => (await tabIds()).length === 1, 3000);
  await frame(); await frame();
  mv = await moveButtons();
  f = await fits();
  t.ok((await tabIds()).length === 1 && await activeTab() === tA, '5: Alt+W closed C, A in front');
  t.ok(mv.length === 0, `5: no "Move to tab" after Alt+W (${J(mv)})`);
  t.ok(f.fits && f.page <= 0, `5: 560 px: A fully inside the strip after the button went (${J(f)})`);
  await b.send('Emulation.clearDeviceMetricsOverride', {});
  await frame();

  // 6. A merge leaves one tab: a pane moved by the top-bar button.
  const D = await newTab();
  await frame();
  await click('#paneTools [data-act="move-to"]');
  await until(async () => (await menuItems()).length > 0, 2000);
  const at = await b.ev(`(() => { const e = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find(e => e.offsetWidth > 0);
    if (!e) return null; const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
  if (at) { await mouse('mouseMoved', at, 0); await sleep(50); await mouse('mousePressed', at, 1); await mouse('mouseReleased', at, 0); }
  await until(async () => (await tabIds()).length === 1, 3000);
  await frame();
  t.ok((await tabIds()).length === 1 && await tabOf(D) === tA, '6: D moved into A by "Move to tab"; one tab left');
  mv = await moveButtons();
  t.ok(mv.length === 0, `6: after the move no "Move to tab" in the bars (${J(mv)})`);
  await b.ev(`(() => { closePane(${J(D)}); return 1; })()`);
  await until(() => b.ev(`!panes[${J(D)}]`), 3000);

  // 7. Reload with one tab (the persistent pane re-attaches).
  await b.open(b.url);
  const back = await until(() => b.ev(`Object.values(panes).length === 1 && Object.values(panes).every(p => p.sid)`), 30000);
  t.ok(back >= 0, '7: after reload: one tab, its pane connected');
  await frame();
  mv = await moveButtons();
  t.ok(await toolsShown() && mv.length === 0, `7: reload with one tab: no "Move to tab" (${J(mv)})`);

  // 8. The only tab, pressed and dragged with a real mouse: no drag look,
  //    nothing moves, and the next click is not swallowed.
  const tOnly = (await tabIds())[0];
  const p0 = mid(await rect(tabSel(tOnly) + ' .tab-label'));
  await mouse('mousePressed', p0, 1);
  let look = false;
  for (let i = 1; i <= 12; i++) {
    await mouse('mouseMoved', { x: p0.x + i * 8, y: p0.y + (i > 6 ? (i - 6) * 40 : 0) }, 1);
    await sleep(20);
    if (await b.ev(`!!document.querySelector('.tab.dragging') || getComputedStyle(document.body).cursor === 'grabbing'`)) look = true;
  }
  await sleep(600);
  const zone8 = await b.ev(`!!document.querySelector('.drop-zone-left,.drop-zone-right,.drop-zone-top,.drop-zone-bottom')`);
  await mouse('mouseReleased', { x: p0.x + 96, y: p0.y + 240 }, 0);
  await frame();
  t.ok(!look && !zone8, `8: the only tab dragged: no drag look, no drop zone (look ${look}, zone ${zone8})`);
  t.ok((await tabIds()).length === 1 && await activeTab() === tOnly, '8: still the one tab, in front');
  const opened = await b.ev(`(() => { window.__clicked = 0; document.getElementById('tabNew').addEventListener('click', () => window.__clicked++, {once: true}); return 1; })()`);
  const nb = mid(await rect('#tabNew'));
  await mouse('mousePressed', nb, 1); await mouse('mouseReleased', nb, 0);
  t.ok(opened && await b.ev('window.__clicked') === 1, '8: a click right after it is not swallowed ("+" got it)');
  await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
  await key('Escape', 'Escape', 27, 0);
  await until(() => b.ev(`document.getElementById('ov').classList.contains('h')`), 3000);
  t.ok((await tabIds()).length === 1 && (await moveButtons()).length === 0, '8: "+" then Escape: still one tab, no "Move to tab"');

  const E = await newTab();
  await frame();
  mv = await moveButtons();
  t.ok(!!E && mv.includes('top bar'), `7: after the reload a new tab still brings it back (${J(mv)})`);
  // 9. With two tabs the same gesture drags: E before the first tab.
  const tE = await tabOf(E);
  const pe = mid(await rect(tabSel(tE) + ' .tab-label'));
  const first = await rect(tabSel(tOnly));
  await calm();
  await mouse('mousePressed', pe, 1);
  let dragLook = false;
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', { x: pe.x + (first.x + 5 - pe.x) * i / 10, y: pe.y }, 1);
    await sleep(20);
    if (await b.ev(`!!document.querySelector('.tab.dragging')`)) dragLook = true;
  }
  await mouse('mouseReleased', { x: first.x + 5, y: pe.y }, 0);
  await frame();
  t.ok(dragLook && (await tabIds())[0] === tE, `9: two tabs: a tab drag shows and reorders (${J(await tabIds())})`);
}
