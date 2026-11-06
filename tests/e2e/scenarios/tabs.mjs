// Browser tabs that hold split layouts (step 1 of the tabs feature).
// A tab that is not shown stays alive: output keeps streaming into its
// terminal, and its PTY keeps the size it had - a pane fitted to its
// hidden (0-size) box would resize the remote terminal to 2x1 and wreck
// whatever runs in it. Shown again, the pane is fitted to the window as
// it is now. A reload brings back the same tabs, in order, with the
// same tab active.
//
// Relies on the tab DOM: #tabNew, #tabs .tab[data-tab] (.active,
// .activity, .tab-label), #panes .tab-root[data-tab].
import { sleep, tagOf, numbered, consecutive, until } from '../lib.mjs';
export const meta = {
  about: 'two tabs: output streams into the hidden one, its size survives, reload restores tabs',
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
  const tabOf = id => b.ev(`(() => { const r = ${pane(id)}.el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; })()`);
  const tabs = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => ({
    id: e.getAttribute('data-tab'), active: e.classList.contains('active'), activity: e.classList.contains('activity'),
    panes: Array.from((document.querySelector('#panes .tab-root[data-tab="' + e.getAttribute('data-tab') + '"]') || document.createElement('i'))
      .querySelectorAll('.pane')).map(p => p.getAttribute('data-pane')) }))`);
  const shown = id => b.ev(`${pane(id)}.el.offsetWidth > 0`);
  const click = async sel => {
    const r = await b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null;
      e.scrollIntoView({block: 'nearest', inline: 'nearest'});
      const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
    if (!r) throw new Error('no element ' + sel);
    for (const type of ['mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  };
  const clickTab = id => click(`#tabs .tab[data-tab="${id}"] .tab-label`);
  // The size the PTY reports, typed as a command and read back.
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

  if (!t.ok(await b.ev(`!!document.getElementById('tabNew')`), 'the "+" button (#tabNew) exists')) return;
  const iA = await b.connect({ persistent: true });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const tag = tagOf('T');
  await type(A, `export WT=A_${tag}; clear\r`);
  await sleep(500);
  const [colsA, rowsA] = await size(A);
  t.note(`pane A is ${colsA}x${rowsA}`);
  // Output that runs on while A's tab is hidden, and ends with the size
  // the PTY has at that moment.
  await type(A, `sleep 3; for i in $(seq 1 30); do echo ${tag}_$i; sleep 0.2; done; echo HID_$(stty size | tr ' ' x)_END\r`);

  // A second tab via "+".
  const before = await b.ev('Object.keys(panes).length');
  await click('#tabNew');
  t.ok(await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000) >= 0, '"+" opens the login form');
  await b.ev(`(() => { ${b._fill(true)} doConnect(); return 1; })()`);
  const iB = await b._ready(before);
  const B = await b.ev(`Object.keys(panes)[${iB}]`);
  await type(B, `export WT=B_${tag}; clear\r`);
  const tA = await tabOf(A), tB = await tabOf(B);
  let ts = await tabs();
  t.ok(ts.length === 2 && tA && tB && tA !== tB, `two tabs, one pane each (${J(ts)})`);
  t.ok(ts.find(x => x.id === tB)?.active, 'the new tab is active');
  t.ok(!(await shown(A)) && await shown(B), 'A\'s tab is hidden, B\'s is shown');

  // Output streams into the hidden tab.
  const done = await until(async () => (await lines(A)).some(l => /^HID_\d+x\d+_END$/.test(l)), 20000);
  t.ok(done >= 0, 'output kept streaming into the hidden tab');
  const nums = numbered(await lines(A), tag);
  t.ok(nums.length === 30 && consecutive(nums), `all 30 lines arrived in order (${nums.length})`);
  const hid = (await lines(A)).find(l => /^HID_\d+x\d+_END$/.test(l)) || '';
  t.ok(hid === `HID_${rowsA}x${colsA}_END`, `the hidden pane's PTY kept its size: ${hid} (want ${rowsA}x${colsA})`);
  const [c1, r1] = await size(A);
  t.ok(c1 === colsA && r1 === rowsA, `the hidden terminal kept its size (${c1}x${r1})`);
  t.ok((await tabs()).find(x => x.id === tA)?.activity, 'the hidden tab shows an activity mark');

  // The window gets smaller while A is hidden.
  const [colsB0] = await size(B);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  await until(async () => (await size(B))[0] !== colsB0, 5000);
  const [c2, r2] = await size(A);
  t.ok(c2 === colsA && r2 === rowsA, `a window resize leaves the hidden pane alone (${c2}x${r2})`);
  t.ok(await b.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
       'the page does not scroll horizontally');

  // Back to A: fitted to the window as it is now, PTY told once.
  await clickTab(tA);
  await until(() => shown(A), 3000);
  const fitted = await until(async () => b.ev(`(() => { const p = ${pane(A)}; const d = p.fitAddon.proposeDimensions();
    return !!d && d.cols === p.term.cols && d.rows === p.term.rows; })()`), 5000);
  t.ok(fitted >= 0, 'shown again, A is fitted to its box');
  const [c3, r3] = await size(A);
  t.ok(c3 < colsA, `A follows the smaller window (${colsA} -> ${c3} cols)`);
  t.ok(!(await tabs()).find(x => x.id === tA)?.activity, 'showing the tab cleared its activity mark');
  t.ok(await b.ev(`${pane(A)}.el.contains(document.activeElement)`), 'keyboard focus is in A');
  // The terminal is refitted at once; the server learns the size from
  // /api/resize a moment later (a command typed within that moment sees
  // the old size, as after any resize). Wait for the server to have
  // confirmed it - lastSent* is set only when /api/resize succeeded.
  const told = await until(() => b.ev(`(() => { const p = ${pane(A)};
    return p.lastSentCols === p.term.cols && p.lastSentRows === p.term.rows; })()`), 5000, 50);
  t.ok(told >= 0, `the server was told A's new size (${told < 0 ? 'never' : told + ' ms after the fit'})`);
  const sz = await sttySize(A, 'SHOWN');
  t.ok(sz === `${r3}x${c3}`, `the PTY has the new size: ${sz} (want ${r3}x${c3})`);

  // Reload: same tabs, same order, same active tab, same shells.
  await b.open(b.url);
  const back = await until(async () => {
    const x = await tabs();
    if (x.length !== 2) return false;
    return b.ev(`Object.values(panes).length === 2 && Object.values(panes).every(p => p.sid)`);
  }, 30000);
  t.ok(back >= 0, 'after reload: two tabs, both panes connected');
  ts = await tabs();
  if (ts.length === 2 && ts.every(x => x.panes.length === 1)) {
    await sleep(1500);
    const [p1, p2] = [ts[0].panes[0], ts[1].panes[0]];
    await type(p1, 'echo WT_$WT\r'); await type(p2, 'echo WT_$WT\r');
    await until(async () => (await lines(p1)).includes('WT_A_' + tag) && (await lines(p2)).includes('WT_B_' + tag), 8000);
    t.ok((await lines(p1)).includes('WT_A_' + tag), 'first tab is still A, same tmux shell');
    t.ok((await lines(p2)).includes('WT_B_' + tag), 'second tab is still B, same tmux shell');
    t.ok(ts[0].active && !ts[1].active, 'A (active before the reload) is active again');
    // B was restored into a hidden tab: its PTY must not be 2x1.
    await clickTab(ts[1].id);
    await until(() => shown(p2), 3000);
    await sleep(500);
    const [cb, rb] = await size(p2);
    const szB = await sttySize(p2, 'RESTB');
    t.ok(szB === `${rb}x${cb}` && cb >= 20, `B restored in a hidden tab has a sane PTY: ${szB} (terminal ${cb}x${rb})`);
  }
}
