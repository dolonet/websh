// Putting a pane or a tab back into another tab, with a real mouse and
// real geometry - what the unit tests (jsdom, every box at 0,0) cannot
// see:
//  - a tab renamed by a real double-click and typed text (Input.insertText)
//    shows the name; it survives a reload;
//  - the split marker is a miniature: one box per pane, at real size;
//    the split handle dragged with the real mouse: the boxes follow the
//    real proportion within ~300 ms of release, a window resize changes
//    nothing in the marker; splitting the dragged pane keeps the other
//    divider (+-1 px), closing the new pane puts both back;
//  - spring-loaded tabs: the tab on screen (B) is pressed and moved onto
//    tab A in the strip and held still - in a real strip the reorder
//    moves B under the pointer, which must not stop A from coming
//    forward; then over the right edge of A's pane (zone shown) and
//    released: B's pane is right of A's, same session, PTY = terminal;
//  - a quick pass across a tab does not switch;
//  - held, then released outside the window: the first tab is back;
//  - a pane dragged by its name, held over another tab, dropped on an
//    edge there;
//  - the tab menu (real right-click): the browser menu does not open
//    over it, "Move into tab" -> a tab by name merges, by mouse.
//
// Relies on the hooks listed in tests/frontend/test_connect.js above the
// "tab name:" tests: dblclick on .tab-label -> <input> in the .tab;
// .tab-split svg rect[data-pane]; [role=menu] [role=menuitem] by text.
import { sleep, tagOf, until } from '../lib.mjs';
export const meta = {
  about: 'rename a tab, the layout miniature, spring-loaded tabs (hold a dragged tab or pane over another tab), the tab menu: real mouse, same sessions',
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
  const sid = id => b.ev(`${pane(id)} ? ${pane(id)}.sid : null`);
  const tabOf = id => b.ev(`(() => { const r = ${pane(id)}.el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; })()`);
  const tabIds = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getAttribute('data-tab'))`);
  const activeTab = () => b.ev(`(() => { const e = document.querySelector('#tabs .tab.active'); return e ? e.getAttribute('data-tab') : null; })()`);
  const label = tid => b.ev(`(() => { const e = document.querySelector('#tabs .tab[data-tab="${tid}"] .tab-label'); return e ? e.textContent.trim() : null; })()`);
  const shape = tid => b.ev(`(() => {
    const root = document.querySelector('#panes .tab-root[data-tab="${tid}"]');
    if (!root) return null;
    const node = el => el.classList.contains('pane') ? el.getAttribute('data-pane')
      : el.classList.contains('split-h') || el.classList.contains('split-v')
        ? '(' + (el.classList.contains('split-h') ? 'h' : 'v') + ' ' + Array.from(el.children).map(node).filter(Boolean).join(' ') + ')'
        : null;
    return Array.from(root.children).map(node).filter(Boolean).join(' '); })()`);
  const shapes = async () => { const out = []; for (const id of await tabIds()) out.push(await shape(id)); return out; };
  const rect = sel => b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e || !e.offsetWidth) return null;
    const q = e.getBoundingClientRect(); return {x: q.x, y: q.y, w: q.width, h: q.height}; })()`);
  const mid = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const mouse = (type, p, buttons, extra) => b.send('Input.dispatchMouseEvent', Object.assign(
    { type, x: p.x, y: p.y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }, extra || {}));
  const click = async sel => {
    const r = await rect(sel);
    if (!r) throw new Error('no visible element ' + sel);
    await mouse('mousePressed', mid(r), 1); await mouse('mouseReleased', mid(r), 0);
  };
  const moveTo = async (from, to, n) => {
    for (let i = 1; i <= (n || 10); i++) {
      await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / (n || 10), y: from.y + (to.y - from.y) * i / (n || 10) }, 1);
      await sleep(15);
    }
  };
  const zoneOn = id => b.ev(`(() => { const e = document.querySelector('#panes .pane[data-pane="${id}"]');
    return e ? (['left','right','top','bottom'].find(s => e.classList.contains('drop-zone-' + s)) || null) : null; })()`);
  const noDrag = () => b.ev(`!document.querySelector('.dragging') && !document.body.classList.contains('pane-moving') &&
    !document.querySelector('.drop-zone-left,.drop-zone-right,.drop-zone-top,.drop-zone-bottom')`);
  const sttySize = async (id, mark) => {
    await type(id, `echo ${mark}_$(stty size | tr ' ' x)_END\r`);
    let got = null;
    await until(async () => {
      const l = (await lines(id)).find(x => x.startsWith(mark + '_') && x.endsWith('_END') && !x.includes('$('));
      if (l) got = l.slice(mark.length + 1, -4);
      return !!got;
    }, 8000);
    return got;
  };
  const settledSize = async (id, mark) => {
    await until(() => b.ev(`(() => { const p = ${pane(id)}; const d = p.fitAddon.proposeDimensions();
      return !!d && d.cols === p.term.cols && d.rows === p.term.rows && p.lastSentCols === p.term.cols && p.lastSentRows === p.term.rows; })()`), 5000);
    const [c, r] = await b.ev(`[${pane(id)}.term.cols, ${pane(id)}.term.rows]`);
    const s = await sttySize(id, mark);
    return { ok: s === `${r}x${c}`, text: `PTY ${s}, terminal ${c}x${r}` };
  };
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
  const tabSel = tid => `#tabs .tab[data-tab="${tid}"]`;
  const menuItems = () => b.ev(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
    .filter(e => e.offsetWidth > 0).map(e => e.textContent.replace(/\\s+/g, ' ').trim())`);
  const clickItem = async re => {
    const at = await b.ev(`(() => { const e = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
      .filter(e => e.offsetWidth > 0).find(e => new RegExp(${J(re)}).test(e.textContent.replace(/\\s+/g, ' ').trim()));
      if (!e) return null; const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
    if (!at) return false;
    await mouse('mouseMoved', at, 0); await sleep(50);
    await mouse('mousePressed', at, 1); await mouse('mouseReleased', at, 0);
    return true;
  };
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Setup: A = one plain pane; B = one plain pane, in front.
  const iA = await b.connect({ persistent: false });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const B = await newTab();
  const tA = await tabOf(A), tB = await tabOf(B);
  const tag = tagOf('K');
  await type(B, `seq 1 200 | sed 's/^/SB_/'\r`);
  await until(async () => (await lines(B)).includes('SB_200'), 8000);
  const sidA = await sid(A), sidB = await sid(B);
  t.ok(await activeTab() === tB && (await tabIds()).length === 2, 'start: two tabs, B in front');

  // 1. Rename B by a real double-click, typed text, Enter.
  const lab = mid(await rect(`${tabSel(tB)} .tab-label`));
  await mouse('mousePressed', lab, 1, { clickCount: 1 }); await mouse('mouseReleased', lab, 0, { clickCount: 1 });
  await mouse('mousePressed', lab, 1, { clickCount: 2 }); await mouse('mouseReleased', lab, 0, { clickCount: 2 });
  const field = await until(() => b.ev(`!!document.querySelector('${tabSel(tB)} input') && document.activeElement === document.querySelector('${tabSel(tB)} input')`), 2000);
  t.ok(field >= 0, 'a real double-click on B\'s title opens a focused field in the tab');
  const sentBefore = await b.ev(`(${pane(B)}.inputQueue || []).length`);
  await b.send('Input.insertText', { text: 'work ' + tag });
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  t.ok(await until(async () => await label(tB) === 'work ' + tag, 2000) >= 0, `B is called "work ${tag}" (${J(await label(tB))})`);
  t.ok(!(await lines(B)).some(l => l.includes('work ' + tag)), 'the typed name did not reach B\'s shell');
  t.ok(await b.ev(`(${pane(B)}.inputQueue || []).length`) === sentBefore, 'nothing queued for the shell');

  // 2. The miniature: split A, look at it.
  await click(`${tabSel(tA)} .tab-label`);
  await until(async () => await activeTab() === tA, 3000);
  const A2 = await splitOf(A, 'h');
  const mini = await b.ev(`(() => { const s = document.querySelector('${tabSel(tA)} .tab-split svg');
    if (!s) return null; const q = s.getBoundingClientRect();
    return {w: q.width, h: q.height, n: s.querySelectorAll('rect[data-pane]').length, on: s.querySelectorAll('rect[data-pane].on').length}; })()`);
  t.ok(!!mini && mini.n === 2 && mini.on === 1 && mini.w >= 12 && mini.w <= 24 && mini.h >= 8 && mini.h <= 18,
       `A's marker is a small miniature with two boxes, one lit (${J(mini)})`);
  // 2b. The split handle dragged with the real mouse to ~70%: the
  // miniature follows within ~300 ms of release, in the proportions the
  // panes really have on screen; few DOM changes during the drag; a
  // window resize (same proportions) changes nothing in it.
  const rootSel = `#panes .tab-root[data-tab="${tA}"]`;
  const miniVsReal = () => b.ev(`(() => {
    const s = document.querySelector('${tabSel(tA)} .tab-split svg');
    const pa = document.querySelector('${rootSel} .pane[data-pane="${A}"]'), pb = document.querySelector('${rootSel} .pane[data-pane="${A2}"]');
    if (!s || !pa || !pb) return null;
    const r = id => s.querySelector('rect[data-pane="' + id + '"]');
    const ra = r(${J(A)}), rb = r(${J(A2)});
    if (!ra || !rb) return null;
    const wa = pa.getBoundingClientRect().width, wb = pb.getBoundingClientRect().width;
    const xa = +ra.getAttribute('x'), la = +ra.getAttribute('width'), xb = +rb.getAttribute('x'), lb = +rb.getAttribute('width');
    const drawable = xb + lb - xa - 1, want = wa / (wa + wb) * drawable;
    return {ratio: Math.round(wa / (wa + wb) * 100), drawn: la, of: drawable, want: Math.round(want * 10) / 10,
            gap: xb - (xa + la), ok: Math.abs(la - want) <= 1 && xb - (xa + la) === 1}; })()`);
  const hr = await rect(`${rootSel} .split-h > .split-handle`);
  const wr = await rect(`${rootSel} .split-h`);
  t.ok(!!hr && !!wr, 'A\'s split has a visible handle');
  if (hr && wr) {
    await b.ev(`(() => { window.__miniMuts = 0; const s = document.querySelector('${tabSel(tA)} .tab-split');
      window.__miniMo = new MutationObserver(l => { window.__miniMuts += l.length; });
      window.__miniMo.observe(s, {attributes: true, childList: true, subtree: true, characterData: true}); return 1; })()`);
    // 66%: 0.66 * 15 px = 9.9, so +-1 screen px of jitter never crosses a rounding edge.
    const h0 = mid(hr), h1 = { x: wr.x + wr.w * 0.66, y: h0.y };
    await mouse('mouseMoved', h0, 0);
    await mouse('mousePressed', h0, 1);
    await moveTo(h0, h1, 40);
    for (let i = 0; i < 20; i++) { await mouse('mouseMoved', { x: h1.x + (i % 2 ? 1 : -1), y: h1.y }, 1); await sleep(10); }
    await mouse('mouseMoved', h1, 1);
    const during = await b.ev('window.__miniMuts');
    await mouse('mouseReleased', h1, 0);
    const t0 = Date.now();
    const got = await until(async () => { const g = await miniVsReal(); return !!g && g.ok; }, 2000, 20);
    const took = Date.now() - t0;
    const g = await miniVsReal();
    t.ok(got >= 0 && took <= 400, `dragged to ~66%: A's box drawn in the real proportion within ~300 ms of release (${took} ms incl. CDP; ${J(g)})`);
    t.ok(during <= 20, `60 mousemoves during the drag changed the marker's DOM ${during} times (only when a box's pixel size changes)`);
    await b.ev('window.__miniMuts = 0');
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await b.send('Emulation.clearDeviceMetricsOverride');
    await sleep(500);
    const afterResize = await b.ev('(() => { const n = window.__miniMuts; window.__miniMo.disconnect(); return n; })()');
    const g2 = await miniVsReal();
    t.ok(afterResize === 0 && !!g2 && g2.ok, `window resized and back: the marker untouched (${afterResize} DOM changes) and still right (${J(g2)})`);
  }
  // 2c. Splitting the dragged pane keeps the divider: A stays where it
  // was (+-1 px), A2 and the new pane halve A2's width; closing the new
  // pane gives A2 its width back, A still unmoved.
  const paneW = id => b.ev(`(() => { const e = document.querySelector('${rootSel} .pane[data-pane="${id}"]');
    if (!e) return null; const q = e.getBoundingClientRect(); return {x: Math.round(q.x), w: Math.round(q.width)}; })()`);
  const wA0 = await paneW(A), wA20 = await paneW(A2);
  const A3 = await splitOf(A2, 'h');
  await sleep(300);
  const wA1 = await paneW(A), wA21 = await paneW(A2), wA31 = await paneW(A3);
  t.ok(!!wA0 && !!wA1 && Math.abs(wA1.w - wA0.w) <= 1,
       `A2 split: A keeps its width (${J(wA0)} -> ${J(wA1)})`);
  t.ok(!!wA21 && !!wA31 && Math.abs(wA21.w - wA31.w) <= 4 && Math.abs(wA21.w + wA31.w - wA20.w) <= 6,
       `A2 and the new pane halve A2's old ${J(wA20)}: ${J(wA21)} + ${J(wA31)}`);
  await b.ev(`closePane(${J(A3)})`);
  await until(async () => await shape(tA) === `(h ${A} ${A2})`, 3000);
  await sleep(300);
  const wA2 = await paneW(A), wA22 = await paneW(A2);
  t.ok(!!wA2 && !!wA22 && Math.abs(wA2.w - wA0.w) <= 1 && Math.abs(wA22.w - wA20.w) <= 1,
       `the new pane closed: A and A2 back where they were (A ${J(wA0)} -> ${J(wA2)}, A2 ${J(wA20)} -> ${J(wA22)})`);
  // Back to one pane in A for the merge below.
  await b.ev(`closePane(${J(A2)})`);
  await until(async () => await shape(tA) === A, 3000);

  // 3. Spring: B (in front) pressed, moved onto A's tab, held still.
  await click(`${tabSel(tB)} .tab-label`);
  await until(async () => await activeTab() === tB, 3000);
  const from = mid(await rect(`${tabSel(tB)} .tab-label`));
  const over = mid(await rect(`${tabSel(tA)} .tab-label`));
  await mouse('mouseMoved', from, 0);
  await mouse('mousePressed', from, 1);
  await moveTo(from, over, 10);
  await sleep(250);
  t.ok(await activeTab() === tB, 'after 250 ms held over A, B is still in front');
  const came = await until(async () => await activeTab() === tA, 2000, 50);
  t.ok(came >= 0, `held over A (real strip, B reordered under the pointer), A comes forward (${came} ms after the check)`);
  const ra = await rect(`#panes .pane[data-pane="${A}"]`);
  const to = ra ? { x: ra.x + ra.w * 0.93, y: ra.y + ra.h / 2 } : over;
  await moveTo(over, to, 10);
  const z = await zoneOn(A);
  t.ok(z === 'right', `the drag went on: A's right half highlighted before release (${z})`);
  await mouse('mouseReleased', to, 0);
  t.ok(await until(async () => (await tabIds()).length === 1, 3000) >= 0, 'B\'s tab is gone');
  t.ok(await shape(tA) === `(h ${A} ${B})`, `B is right of A (${J(await shapes())})`);
  t.ok(await sid(A) === sidA && await sid(B) === sidB, 'same sessions');
  t.ok((await lines(B)).includes('SB_1'), 'B\'s scrollback kept');
  t.ok(await noDrag(), 'no drag state or zone left');
  let s = await settledSize(B, 'SPRB'); t.ok(s.ok, `B after the merge: ${s.text}`);

  // 4. Take B out again (new tab), then: a quick pass does not switch.
  await b.ev(`movePaneToNewTab(${J(B)})`);
  const tB2 = await tabOf(B);
  await until(async () => await activeTab() === tB2, 3000);
  const f2 = mid(await rect(`${tabSel(tB2)} .tab-label`));
  const o2 = mid(await rect(`${tabSel(tA)} .tab-label`));
  await mouse('mouseMoved', f2, 0);
  await mouse('mousePressed', f2, 1);
  await moveTo(f2, o2, 6);
  await moveTo(o2, { x: o2.x, y: o2.y + 300 }, 4);     // straight on, down into the panes
  let switched = false;
  for (let i = 0; i < 10; i++) { if (await activeTab() === tA) switched = true; await sleep(80); }
  t.ok(!switched, 'a quick pass over A (no rest) does not bring A forward');
  // Back up into the strip over A, held, then out of the window.
  await moveTo({ x: o2.x, y: o2.y + 300 }, o2, 6);
  t.ok(await until(async () => await activeTab() === tA, 2000, 50) >= 0, 'held over A: A forward');
  await moveTo(o2, { x: o2.x, y: -5 }, 3);
  await mouse('mouseReleased', { x: o2.x, y: -5 }, 0);
  t.ok(await until(async () => await activeTab() === tB2, 2000) >= 0, `released outside the window: B is back in front (${await activeTab()})`);
  t.ok(J(await shapes()) === J([A, B]) || J(await shapes()) === J([B, A]), `nothing merged (${J(await shapes())})`);
  t.ok(await noDrag(), 'no drag state left');

  // 5. A pane by its name: split B, drag the new pane held over A, onto A's bottom edge.
  const B3 = await splitOf(B, 'h');
  const pl = mid(await rect(`#panes .pane[data-pane="${B3}"] .pane-label`));
  const oa = mid(await rect(`${tabSel(tA)} .tab-label`));
  await mouse('mouseMoved', pl, 0);
  await mouse('mousePressed', pl, 1);
  await moveTo(pl, oa, 10);
  t.ok(await until(async () => await activeTab() === tA, 2000, 50) >= 0, 'a pane label held over A: A forward');
  const rA = await rect(`#panes .pane[data-pane="${A}"]`);
  const bot = rA ? { x: rA.x + rA.w / 2, y: rA.y + rA.h * 0.93 } : oa;
  await moveTo(oa, bot, 10);
  t.ok(await zoneOn(A) === 'bottom', `A's bottom half highlighted (${await zoneOn(A)})`);
  await mouse('mouseReleased', bot, 0);
  t.ok(await until(async () => await shape(tA) === `(v ${A} ${B3})`, 3000) >= 0, `the pane went under A (${J(await shapes())})`);
  s = await settledSize(B3, 'SPRP'); t.ok(s.ok, `the moved pane: ${s.text}`);

  // 6. Tab menu by a real right-click on B's tab: Move into tab -> A.
  const rb = mid(await rect(`${tabSel(tB2)} .tab-label`));
  await mouse('mousePressed', rb, 2, { button: 'right' });
  await mouse('mouseReleased', rb, 0, { button: 'right' });
  const items = await menuItems();
  t.ok(items.some(x => /^Rename/i.test(x)) && items.some(x => /^Move into tab/i.test(x)) && items.some(x => /^Close/i.test(x)),
       `the tab menu opens (${J(items)})`);
  await clickItem('^Move into tab');
  await sleep(200);
  const nameA = await label(tA);
  const chose = await clickItem('^' + esc(nameA));
  t.ok(chose, `"${nameA}" listed and chosen (${J(await menuItems())})`);
  t.ok(await until(async () => (await tabIds()).length === 1, 3000) >= 0, `B merged into A by the menu (${J(await shapes())})`);
  t.ok(await sid(B) === sidB, 'B kept its session');
  t.ok((await menuItems()).length === 0, 'the menu closed');

  // 7. Reload: the layout comes back; a name survives (rename A first).
  await b.ev(`movePaneToNewTab(${J(B)})`);
  const tB4 = await tabOf(B);
  await b.ev(`(() => { const l = document.querySelector('${tabSel(tB4)} .tab-label');
    l.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, detail: 2})); return 1; })()`);
  await until(() => b.ev(`!!document.querySelector('${tabSel(tB4)} input')`), 2000);
  await b.send('Input.insertText', { text: 'again ' + tag });
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(async () => await label(tB4) === 'again ' + tag, 2000);
  const n = await b.ev('Object.keys(panes).length');
  await b.open(b.url);
  const back = await until(() => b.ev(`Object.values(panes).length === ${n} && Object.values(panes).every(p => p.sid)`), 30000);
  t.ok(back >= 0, 'after a reload every pane is back');
  const names = await b.ev(`Array.from(document.querySelectorAll('#tabs .tab .tab-label')).map(e => e.textContent.trim())`);
  t.ok(names.includes('again ' + tag), `the name survived the reload (${J(names)})`);
  t.ok(b.errors.length === 0, `no page errors (${J(b.errors.slice(0, 3))})`);
}
