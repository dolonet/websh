// A terminal whose element is moved in the DOM keeps its scroll position.
// Splitting a pane wraps it in a new split container, closing one hands
// its place to the sibling, moving a pane between tabs re-parents it: each
// time the browser resets the scroll offset of xterm's viewport element
// to 0 while xterm itself still shows the bottom. Nothing looks wrong
// until the user scrolls: the scrollbar sits at the top, and the first
// turn of the wheel jumps to the very start of the scrollback instead of
// a few lines up. Checked here the way the user meets it: a real wheel
// event over the pane, then where the terminal ended up.
//
// Relies on xterm 5's .xterm-viewport and term.buffer.active
// (viewportY/baseY), and on the tabs hooks movePaneToNewTab/mergeTabInto
// when they exist.
import { sleep, until } from '../lib.mjs';
export const meta = {
  about: 'a pane re-parented by split, close or move keeps its scroll position (wheel scrolls a few lines, not to the top)',
  ssh: true, local: true,
};

export async function run({ b, t }) {
  const J = JSON.stringify;
  const pane = id => `panes[${J(id)}]`;
  const type = (id, text) => b.ev(`(() => { const p = ${pane(id)};
    for (const c of ${J(text)}) p.term._core.coreService.triggerDataEvent(c, true); return 1; })()`);
  const screen = id => b.ev(`(() => { const p = ${pane(id)}; const bf = p.term.buffer.active; let s = '';
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) s += l.translateToString(true) + '\\n'; } return s; })()`);
  const fill = async (id, tag) => {
    await type(id, `seq 1 400 | sed 's/^/${tag}_/'\r`);
    await until(async () => (await screen(id)).includes(`${tag}_400`), 8000);
    await sleep(300);
  };
  // Where xterm is and where its scrollbar is.
  const pos = id => b.ev(`(() => { const p = ${pane(id)}; const bf = p.term.buffer.active;
    const vp = p.term.element.querySelector('.xterm-viewport');
    return {y: bf.viewportY, base: bf.baseY, top: Math.round(vp.scrollTop), max: Math.round(vp.scrollHeight - vp.clientHeight)}; })()`);
  // One notch of the wheel, up, over the pane; where did it land?
  const wheelUp = async id => {
    const r = await b.ev(`(() => { const q = ${pane(id)}.el.querySelector('.pane-term').getBoundingClientRect();
      return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
    const before = await pos(id);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: -120 });
    await until(async () => (await pos(id)).y !== before.y, 1500);
    await sleep(150);
    const after = await pos(id);
    // back to the bottom for the next case
    await b.ev(`${pane(id)}.term.scrollToBottom()`);
    await sleep(100);
    return { before, after };
  };
  const check = async (id, what) => {
    // xterm brings its scroll area up to date on a later frame after a
    // resize; give it that, and fail only if it never gets there.
    const atBottom = async () => { const q = await pos(id); return q.y === q.base && Math.abs(q.top - q.max) <= 2; };
    // First the pane must have its final size (a window resize lands a
    // moment later), then its scroll area.
    await until(() => b.ev(`(() => { const p = ${pane(id)}; const d = p.fitAddon.proposeDimensions();
      return !!d && d.cols === p.term.cols && d.rows === p.term.rows && p.lastSentCols === p.term.cols && p.lastSentRows === p.term.rows; })()`), 5000, 100);
    await until(atBottom, 3000, 100);
    const p = await pos(id);
    t.ok(p.y === p.base && Math.abs(p.top - p.max) <= 2,
         `${what}: the scrollbar is at the bottom, where the terminal is (scrollTop ${p.top} of ${p.max}, line ${p.y}/${p.base})`);
    const w = await wheelUp(id);
    const back = w.before.base - w.after.y;
    t.ok(back > 0 && back <= 20,
         `${what}: one wheel notch up scrolls a few lines (${back} lines; at line ${w.after.y} of ${w.before.base})`);
  };

  const iA = await b.connect({ persistent: false });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  await fill(A, 'A');
  await check(A, 'a lone pane (control)');

  const iB = await b.split({ persistent: false });           // A is wrapped in the split
  const B = await b.ev(`Object.keys(panes)[${iB}]`);
  await check(A, 'the pane that was split');
  await fill(B, 'B');
  await check(B, 'the new pane of a split');

  await b.ev(`closePane(${J(B)})`);                          // A takes the wrapper's place
  await until(() => b.ev(`!${pane(B)}`), 3000);
  await check(A, 'the pane left after its sibling closed');

  // Its tab hidden (display:none) and shown again: another tab via "+".
  const nBefore = await b.ev('Object.keys(panes).length');
  await b.ev(`(() => { newTab(); ${b._fill(false)} doConnect(); return 1; })()`);
  const iD = await b._ready(nBefore);
  const D = await b.ev(`Object.keys(panes)[${iD}]`);
  const tA0 = await b.ev(`${pane(A)}.el.closest('.tab-root').getAttribute('data-tab')`);
  await b.ev(`showTab(${J(tA0)})`);
  await check(A, 'a pane whose tab was hidden and shown again');
  // The window gets smaller while A's tab is hidden; shown, A is refitted.
  const tD0 = await b.ev(`${pane(D)}.el.closest('.tab-root').getAttribute('data-tab')`);
  await b.ev(`showTab(${J(tD0)})`);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 520, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await b.ev(`showTab(${J(tA0)})`);
  await check(A, 'a pane shown again after the window was resized while its tab was hidden');
  await b.send('Emulation.clearDeviceMetricsOverride');
  await check(A, 'the same pane after the window got its size back');
  // A sibling closed while the tab is hidden, then shown.
  const iE = await b.split({ persistent: false });
  const E = await b.ev(`Object.keys(panes)[${iE}]`);
  const tD = await b.ev(`${pane(D)}.el.closest('.tab-root').getAttribute('data-tab')`);
  await b.ev(`showTab(${J(tD)})`);
  await b.ev(`closePane(${J(E)})`);
  await until(() => b.ev(`!${pane(E)}`), 3000);
  await b.ev(`showTab(${J(tA0)})`);
  await check(A, 'a pane whose sibling closed while its tab was hidden');
  await b.ev(`closePane(${J(D)})`);
  await until(() => b.ev(`!${pane(D)}`), 3000);

  if (!(await b.ev(`typeof movePaneToNewTab === 'function' && typeof mergeTabInto === 'function'`))) {
    t.note('no tab move hooks here: moves not checked');
    return;
  }
  const iC = await b.split({ persistent: false });
  const C = await b.ev(`Object.keys(panes)[${iC}]`);
  await fill(C, 'C');
  await b.ev(`movePaneToNewTab(${J(C)})`);
  await check(C, 'a pane moved to a new tab');
  const tA = await b.ev(`${pane(A)}.el.closest('.tab-root').getAttribute('data-tab')`);
  const tC = await b.ev(`${pane(C)}.el.closest('.tab-root').getAttribute('data-tab')`);
  await b.ev(`showTab(${J(tA)})`);
  await check(A, 'the pane left behind by the move, its tab shown');
  await b.ev(`mergeTabInto(${J(tC)}, ${J(A)}, 'bottom')`);
  await check(C, 'a pane merged in from another tab');
  await check(A, 'the pane a tab was merged beside');
}
