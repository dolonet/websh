// Trying to break the tab features (rename, tab menu, spring-loaded
// tabs, "Move to tab") on paths the feature scenario (tabback) does not
// walk: a rename left open while its tab is dragged into another tab; a
// rename, a merge and a reload in a row; a tab menu (and its submenu)
// whose tab closes by another path while it is open; a drag held over
// "+" and over the empty strip; the only tab dragged and held over
// itself and its own pane; a pane moved by the menu while keys are
// still arriving for it (order and completeness). Real mouse and keys.
import { sleep, tagOf, until } from '../lib.mjs';
export const meta = {
  about: 'tab features under attack: rename during a drag, rename+merge+reload, menu of a closed tab, spring over "+", the only tab, pane moved by menu while typing',
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
  // websh swallows a click within 400 ms of a drag's release
  // (_blockClickAfterDrag: the release must not also click what it was
  // dropped on). A person does not click that fast; the script waits.
  const calm = () => until(() => b.ev('typeof _clickBlockUntil === "undefined" || !_clickBlockUntil || Date.now() > _clickBlockUntil'), 2000, 20);
  const click = async sel => {
    await calm();
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
    await calm();
    await mouse('mouseMoved', at, 0); await sleep(50);
    await mouse('mousePressed', at, 1); await mouse('mouseReleased', at, 0);
    return true;
  };
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ALT = 1;
  const key = async (code, k, vk, mods) => {
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 });
  };
  const enter = () => key('Enter', 'Enter', 13, 0);
  const rightClick = async sel => {
    await calm();
    const r = mid(await rect(sel));
    await mouse('mouseMoved', r, 0);
    await mouse('mousePressed', r, 2, { button: 'right' });
    await mouse('mouseReleased', r, 0, { button: 'right' });
    return until(async () => (await menuItems()).length > 0, 2000);
  };
  const menuOpen = () => b.ev(`Array.from(document.querySelectorAll('[role="menu"]')).some(e => e.offsetWidth > 0)`);
  const saved = () => b.ev(`(() => { try { return JSON.parse(localStorage.getItem('websh_panes')); } catch (e) { return null; } })()`);
  const allLabels = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab .tab-label')).map(e => e.textContent.trim())`);
  const frame = () => b.ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const tag = tagOf('R');

  // Setup: three tabs of one plain pane each, A B C.
  const A = await b.ev(`Object.keys(panes)[${await b.connect({ persistent: false })}]`);
  const B = await newTab();
  const C = await newTab();
  const tA = await tabOf(A), tB = await tabOf(B), tC = await tabOf(C);
  const sids0 = { A: await sid(A), B: await sid(B), C: await sid(C) };

  // 1. A rename left open (typed, no Enter) while its tab is dragged by
  //    its dot into B: the typed name must not land on B, and nothing
  //    is left behind (no field, no error).
  await click(tabSel(tA) + ' .tab-label');
  await until(async () => await activeTab() === tA, 2000);
  await b.ev(`(() => { const l = document.querySelector('${tabSel(tA)} .tab-label');
    l.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, detail: 2})); return 1; })()`);
  t.ok(await until(() => b.ev(`document.activeElement && document.activeElement.classList.contains('tab-edit')`), 2000) >= 0, '1: rename field open on A');
  await b.send('Input.insertText', { text: 'half ' + tag });
  const dot = mid(await rect(tabSel(tA) + ' .tab-dot'));
  const tbm = mid(await rect(tabSel(tB) + ' .tab-label'));
  await mouse('mousePressed', dot, 1);
  await moveTo(dot, { x: tbm.x, y: tbm.y + 1 }, 12);
  await mouse('mouseMoved', { x: tbm.x + 1, y: tbm.y + 1 }, 1);
  const sprung = await until(async () => await activeTab() === tB, 2000);
  t.ok(sprung >= 0, '1: held over B, B came forward during the drag');
  const pb = await rect(`#panes .pane[data-pane="${B}"]`);
  const edge = { x: pb.x + pb.w - 12, y: pb.y + pb.h / 2 };
  await moveTo({ x: tbm.x, y: tbm.y }, edge, 12);
  await until(async () => await zoneOn(B) === 'right', 2000);
  await mouse('mouseReleased', edge, 0);
  await until(async () => (await tabIds()).length === 2, 3000);
  await frame();
  t.ok((await tabIds()).length === 2 && await tabOf(A) === tB, `1: A merged into B (${J(await shapes())})`);
  t.ok(!(await allLabels()).some(l => l.includes('half ' + tag)), `1: the half-typed name went nowhere (${J(await allLabels())})`);
  t.ok(await b.ev(`!document.querySelector('.tab-edit')`), '1: no rename field left in the page');
  t.ok(!JSON.stringify(await saved()).includes('half ' + tag), '1: and none saved');
  t.ok(await noDrag(), '1: no drag state left');

  // 2. Rename B and C by the menu, merge C into B by the menu, reload.
  const renameByMenu = async (tid, name) => {
    await rightClick(tabSel(tid));
    await clickItem('^Rename');
    await until(() => b.ev(`document.activeElement && document.activeElement.classList.contains('tab-edit')`), 2000);
    await b.send('Input.insertText', { text: name });
    await enter();
    return until(async () => await label(tid) === name, 2000);
  };
  t.ok(await renameByMenu(tB, 'Bee ' + tag) >= 0, `2: B renamed by its menu (${J(await label(tB))})`);
  t.ok(await renameByMenu(tC, 'Cee ' + tag) >= 0, `2: C renamed by its menu (${J(await label(tC))})`);
  await rightClick(tabSel(tC));
  await clickItem('^Move into tab');
  await until(async () => (await menuItems()).some(x => x.includes('Bee ' + tag)), 2000);
  t.ok(await clickItem('^' + esc('Bee ' + tag)), '2: "Move into tab" lists B by its name');
  await until(async () => (await tabIds()).length === 1, 3000);
  t.ok((await tabIds()).length === 1 && (await allLabels())[0] === 'Bee ' + tag, `2: one tab left, still called "Bee ${tag}" (${J(await allLabels())})`);
  const shapeBefore = await shapes();
  const n0 = await b.ev('Object.keys(panes).length');
  await b.open(b.url);
  t.ok(await until(() => b.ev(`Object.values(panes).length === ${n0} && Object.values(panes).every(p => p.sid)`), 30000) >= 0, '2: after a reload every pane is back');
  const lab2 = await allLabels();
  t.ok(lab2.length === 1 && lab2[0] === 'Bee ' + tag, `2: after the reload one tab called "Bee ${tag}" (${J(lab2)})`);
  t.ok(!JSON.stringify(await saved()).includes('Cee ' + tag), '2: the merged-away name is gone from the saved layout');
  const shapeAfter = (await shapes()).map(s => s.replace(/p\d+/g, 'P'));
  t.ok(J(shapeAfter) === J(shapeBefore.map(s => s.replace(/p\d+/g, 'P'))), `2: same layout after the reload (${J(shapeAfter)})`);
  // Pane ids change on reload; find the panes again.
  const ids = await b.ev('Object.keys(panes)');
  const T1 = (await tabIds())[0];

  // 3. A tab's menu stays open while that tab is closed by Alt+W.
  const D = await newTab();
  const tD = await tabOf(D);
  await rightClick(tabSel(tD));
  t.ok(await menuOpen(), '3: D\'s menu is open');
  const before3a = (await tabIds()).filter(x => x !== tD);
  await key('KeyW', 'w', 87, ALT);
  await until(async () => !(await tabIds()).includes(tD), 3000);
  t.ok(!(await tabIds()).includes(tD), '3: Alt+W closed D while its menu was open');
  const stale = await menuOpen();
  t.ok(!stale, '3: the menu of a tab that closed (Alt+W) does not stay on screen');
  if (stale) {
    await clickItem('^Close tab');
    await frame();
    t.ok(J(await tabIds()) === J(before3a), `3: "Close tab" of the gone tab closed no other tab (${J(await tabIds())}, was ${J(before3a)})`);
  }
  if (await menuOpen()) { await rightClick(tabSel(T1)); await key('Escape', 'Escape', 27, 0); }
  // Submenu: "Move into tab" lists E; E closes by another path; E's item.
  const E = await newTab();
  const tE = await tabOf(E);
  await click(tabSel(T1) + ' .tab-label');
  await until(async () => await activeTab() === T1, 2000);
  await rightClick(tabSel(T1));
  await clickItem('^Move into tab');
  await until(async () => (await menuItems()).length >= 4, 2000);
  const eLabel = await label(tE);
  t.ok((await menuItems()).some(x => x === eLabel), `3: the submenu lists E (${J(await menuItems())})`);
  const before3 = await tabIds();
  await b.ev(`closeTab(${J(tE)})`);
  await until(async () => !(await tabIds()).includes(tE), 3000);
  const clicked = await clickItem('^' + esc(eLabel) + '$');
  await frame();
  t.note('3: E\'s item still clickable after E closed: ' + clicked);
  t.ok(J(await tabIds()) === J(before3.filter(x => x !== tE)), `3: choosing the closed tab moved nothing (${J(await tabIds())})`);
  t.ok((await b.ev('Object.keys(panes).length')) === n0, '3: every pane of the remaining tab is still there');
  if (await menuOpen()) await key('Escape', 'Escape', 27, 0);

  // 4. A tab drag held over "+" and over the empty strip: nothing comes
  //    forward, the release over "+" opens no form and makes no tab.
  const F = await newTab();
  const tF = await tabOf(F);
  t.ok(await activeTab() === tF, '4: F in front');
  const n4 = (await tabIds()).length;
  const t1m = mid(await rect(tabSel(T1) + ' .tab-label'));
  const plus = mid(await rect('#tabNew'));
  await mouse('mousePressed', t1m, 1);
  await moveTo(t1m, plus, 12);
  await sleep(900);             // longer than the spring delay: nothing must come
  t.ok(await activeTab() === tF, `4: held over "+" for 900 ms: still F in front (${await activeTab()})`);
  const st = await b.ev(`(() => { const s = document.getElementById('tabs').getBoundingClientRect(); const p = document.getElementById('tabNew').getBoundingClientRect();
    const tabsR = Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getBoundingClientRect().right);
    return {x: Math.max(...tabsR) + 6, y: s.top + s.height / 2, room: s.right - Math.max(...tabsR)}; })()`);
  if (st.room > 12) {
    await moveTo(plus, st, 6);
    await sleep(900);
    t.ok(await activeTab() === tF, `4: held over the empty strip: still F in front`);
    await moveTo(st, plus, 6);
  } else t.note('4: no empty strip at this width');
  await mouse('mouseReleased', plus, 0);
  await frame();
  t.ok(await b.ev(`document.getElementById('ov').classList.contains('h')`), '4: released on "+": no login form');
  t.ok((await tabIds()).length === n4, `4: no tab made or lost (${(await tabIds()).length}, was ${n4})`);
  t.ok(await noDrag(), '4: no drag state left');

  // 5. The only tab, dragged and held over itself and over its own
  //    pane's edge, released there: nothing changes.
  await b.ev(`closeTab(${J(tF)})`);
  await until(async () => (await tabIds()).length === 1, 3000);
  const only = await shapes();
  const own = ids[0];
  const om = mid(await rect(tabSel(T1) + ' .tab-label'));
  await mouse('mousePressed', om, 1);
  await moveTo(om, { x: om.x + 30, y: om.y }, 6);
  await sleep(700);
  const po = await rect(`#panes .pane[data-pane="${own}"]`);
  const oe = { x: po.x + 10, y: po.y + po.h / 2 };
  await moveTo({ x: om.x + 30, y: om.y }, oe, 10);
  await sleep(700);
  const zOwn = await zoneOn(own);
  await mouse('mouseReleased', oe, 0);
  await frame();
  t.note('5: zone shown on its own pane while the only tab was dragged: ' + zOwn);
  t.ok(J(await shapes()) === J(only) && (await tabIds()).length === 1, `5: the only tab dragged onto its own pane changed nothing (${J(await shapes())})`);
  t.ok(await noDrag(), '5: no drag state left');
  await type(own, `echo ONLY_${tag}_OK\r`);
  t.ok(await until(async () => (await lines(own)).includes(`ONLY_${tag}_OK`), 5000) >= 0, '5: the pane still takes keys');

  // 6. A pane moved by "Move to tab" while keys keep arriving for it:
  //    every key arrives, in order. The keys go through the terminal's
  //    own input path, one every 4 ms, while the real mouse opens the
  //    menu and picks the target.
  const G = await newTab();
  const tG = await tabOf(G);
  await click(tabSel(T1) + ' .tab-label');
  await until(async () => await activeTab() === T1, 2000);
  const X = ids[1];
  const N = 300;
  await b.ev(`(() => { const p = panes[${J(X)}]; let s = 'echo '; for (let i = 1; i <= ${N}; i++) s += 'k' + i + ' '; s += 'END_${tag}\\r';
    window.__typing = new Promise(res => { let i = 0; const tick = () => { if (i >= s.length) return res(1);
      p.term._core.coreService.triggerDataEvent(s[i++], true); setTimeout(tick, 4); }; tick(); }); return 1; })()`);
  await sleep(150);
  await click(`#panes .pane[data-pane="${X}"] .pane-bar [data-act="move-to"]`);
  await until(async () => (await menuItems()).length > 0, 2000);
  const items6 = await menuItems();
  t.ok(await clickItem('^' + esc(await label(tG)) + '$'), `6: the move menu lists G (${J(items6)})`);
  await until(async () => await tabOf(X) === tG, 3000);
  t.ok(await tabOf(X) === tG, '6: the pane is now in G');
  const typing = await b.ev('window.__typing.then(() => 1)');
  t.ok(typing === 1, '6: typing finished');
  // Logical lines (wrapped rows joined): the echo's output is one line
  // of ~1700 characters.
  const logical = id => b.ev(`(() => { const bf = ${pane(id)}.term.buffer.active; const out = []; let cur = '';
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (!l) continue;
      const nx = bf.getLine(y + 1); const wrapped = nx && nx.isWrapped;
      cur += l.translateToString(!wrapped); if (!wrapped) { out.push(cur); cur = ''; } }
    if (cur) out.push(cur); return out; })()`);
  let got = null;
  await until(async () => { got = (await logical(X)).find(l => l.startsWith('k1 ') && l.includes('END_' + tag)); return !!got; }, 10000);
  const nums = (got || '').split(/\s+/).filter(w => /^k\d+$/.test(w)).map(w => +w.slice(1));
  const inOrder = nums.length === N && nums.every((v, i) => v === i + 1);
  t.ok(inOrder, `6: all ${N} words arrived in order after the move (${nums.length}, first bad at ${nums.findIndex((v, i) => v !== i + 1)})`);
  t.ok(await sid(X), '6: same live session');
  t.ok(b.errors.length === 0, `no page errors (${J(b.errors.slice(0, 3))})`);
}
