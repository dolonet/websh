// Trying to break the tab keys (step 4) in a real browser.
//  - Alt+Shift+] held down (CDP autoRepeat key events) while two tabs
//    flood output: every line arrives, in order; one layout on screen;
//    each PTY ends with the size of its terminal; no ESC+} on the wire.
//  - A tab dragged with the real mouse over a pane (drop zone shown),
//    Alt+2 / Alt+W pressed mid-drag: they do nothing (and do not reach
//    the shell), the drag goes on and the release merges where the
//    zone was shown.
//  - Ctrl+Shift+F (search) still works from inside the terminal.
import { sleep, tagOf, numbered, consecutive, until } from '../lib.mjs';
export const meta = {
  about: 'tab keys under stress: held Alt+Shift+] while two tabs flood, Alt+2/Alt+W ignored during a real tab drag, Ctrl+Shift+F still works',
  ssh: true, local: true,
};
const ALT = 1, CTRL = 2, SHIFT = 8;

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
  const tabOf = id => b.ev(`(() => { const p = ${pane(id)}; const r = p && p.el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; })()`);
  const tabs = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getAttribute('data-tab'))`);
  const activeTab = () => b.ev(`(() => { const e = document.querySelector('#tabs .tab.active'); return e ? e.getAttribute('data-tab') : null; })()`);
  const shapes = () => b.ev(`Array.from(document.querySelectorAll('#panes .tab-root')).map(r => r.querySelectorAll('.pane').length)`);
  const centreOf = sel => b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null;
    const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2, w: q.width, h: q.height, l: q.x, t: q.y}; })()`);
  const mouse = (type, x, y, buttons) => b.send('Input.dispatchMouseEvent',
    { type, x, y, button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons: buttons || 0, clickCount: 1 });
  const click = async sel => { const r = await centreOf(sel); if (!r) throw new Error('no ' + sel);
    await mouse('mousePressed', r.x, r.y, 1); await mouse('mouseReleased', r.x, r.y, 0); };
  const key = async (code, k, vk, mods, o) => {
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 };
    await b.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown', autoRepeat: !!(o && o.repeat) }, base));
    if (!(o && o.noUp)) await b.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  };
  const sent = [];
  b.ws.addEventListener('message', m => {
    const d = JSON.parse(m.data);
    if (d.method === 'Network.requestWillBeSent' && /action=input/.test(d.params.request.url)) {
      try { sent.push(JSON.parse(d.params.request.postData || '{}').data || ''); } catch (e) {}
    }
  });
  const focusIn = async id => {
    await click(`#panes .pane[data-pane="${id}"] .xterm-screen`);
    await until(() => b.ev(`${pane(id)}.el.contains(document.activeElement)`), 3000);
  };
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

  if (!t.ok(await b.ev(`!!document.getElementById('tabNew')`), 'the "+" button exists')) return;
  const iA = await b.connect({ persistent: false });   // not tmux: the flood must stay in xterm's scrollback
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const newTab = async () => {
    const before = await b.ev('Object.keys(panes).length');
    await click('#tabNew');
    await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
    await b.ev(`(() => { ${b._fill(false)} doConnect(); return 1; })()`);
    const i = await b._ready(before);
    return b.ev(`Object.keys(panes)[${i}]`);
  };
  const B = await newTab();
  const C = await newTab();
  const [tA, tB, tC] = [await tabOf(A), await tabOf(B), await tabOf(C)];
  t.ok(J(await tabs()) === J([tA, tB, tC]), 'three tabs');

  // 1. Held Alt+Shift+] while A and B flood.
  const tag = tagOf('F');
  for (const [id, n] of [[A, 'a'], [B, 'b']])
    await type(id, `clear; for i in $(seq 1 4000); do echo ${tag}${n}_$i; done; echo ${tag}${n}_DONE\r`);
  await focusIn(C);
  sent.length = 0;
  for (let i = 0; i < 40; i++) await key('BracketRight', '}', 221, ALT | SHIFT, { repeat: i > 0, noUp: true });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '}', code: 'BracketRight', windowsVirtualKeyCode: 221, modifiers: ALT | SHIFT });
  // From C (index 2): 40 steps -> (2+40)%3 = 0 -> A
  t.ok(await until(async () => await activeTab() === tA, 3000) >= 0, `40 autorepeated Alt+Shift+] from C end on A (on ${[tA, tB, tC].indexOf(await activeTab())})`);
  t.ok(await b.ev(`document.querySelectorAll('#panes .tab-root:not(.h)').length`) === 1, 'one tab layout on screen');
  for (const [id, n] of [[A, 'a'], [B, 'b']]) {
    await until(async () => (await lines(id)).includes(`${tag}${n}_DONE`), 30000);
  }
  // Scrollback holds the tail; check the tail is consecutive and ends at 4000.
  for (const [id, n] of [[A, 'a'], [B, 'b']]) {
    const nums = numbered(await lines(id), tag + n);
    t.ok(nums.length === 4000 && consecutive(nums) && nums[nums.length - 1] === 4000,
         `${n.toUpperCase()}: flood arrived whole and in order (${nums.length} lines, last ${nums[nums.length - 1]})`);
  }
  t.ok(!/\x1b[}{\]]/.test(sent.join('')), `no ESC+} on the wire (${J((sent.join('').match(/\x1b./g) || []).slice(0, 5))})`);
  for (const id of [A, B, C]) {
    const tb = await tabOf(id);
    await click(`#tabs .tab[data-tab="${tb}"] .tab-label`);
    await until(async () => await activeTab() === tb, 3000);
    await until(() => b.ev(`(() => { const p = ${pane(id)}; return p.lastSentCols === p.term.cols && p.lastSentRows === p.term.rows; })()`), 5000);
    const [c, r] = await b.ev(`[${pane(id)}.term.cols, ${pane(id)}.term.rows]`);
    const sz = await sttySize(id, 'SZ' + tb);
    t.ok(sz === `${r}x${c}` && c >= 20, `${tb}: PTY ${sz} = terminal ${r}x${c}`);
  }

  // 2. Alt+2/Alt+W ignored during a real tab drag, release without moving.
  await click(`#tabs .tab[data-tab="${tA}"] .tab-label`);
  await until(async () => await activeTab() === tA, 3000);
  const shapes0 = J(await shapes());
  const src = await centreOf(`#tabs .tab[data-tab="${tC}"] .tab-label`);
  const tgt = await centreOf(`#panes .pane[data-pane="${A}"] .xterm-screen`);
  const x = tgt.l + tgt.w * 0.95, y = tgt.y;
  await mouse('mousePressed', src.x, src.y, 1);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', src.x + (x - src.x) * i / 6, src.y + (y - src.y) * i / 6, 1);
  await mouse('mouseMoved', x - 1, y, 1);
  const zone = await b.ev(`(() => { const e = document.querySelector('#panes .pane[data-pane="${A}"]');
    return ['left','right','top','bottom'].find(s => e.classList.contains('drop-zone-' + s)) || null; })()`);
  t.ok(zone === 'right', `setup: the drop zone is shown on A (${zone})`);
  // While a drag is in progress the tab keys do nothing (still not sent
  // to the shell); the drag goes on and drops where the zone was shown.
  sent.length = 0;
  await key('Digit2', '2', 50, ALT);
  await key('KeyW', 'w', 87, ALT);
  await sleep(300);
  const zoneStill = await b.ev(`(() => { const e = document.querySelector('#panes .pane[data-pane="${A}"]');
    return ['left','right','top','bottom'].find(s => e.classList.contains('drop-zone-' + s)) || null; })()`);
  t.ok(await activeTab() === tA && (await tabs()).length === 3, `Alt+2 / Alt+W mid-drag: A still in front, 3 tabs (front ${[tA, tB, tC].indexOf(await activeTab())}, ${(await tabs()).length} tabs)`);
  t.ok(zoneStill === 'right', `the drag goes on: zone still on A (${zoneStill})`);
  await mouse('mouseReleased', x - 1, y, 0);
  await sleep(500);
  const shapes1 = J(await shapes());
  t.ok(shapes1 === J([2, 1]), `the release merged C beside A as without the keys; layouts ${shapes0} -> ${shapes1}`);
  t.ok(await b.ev(`!document.querySelector('.dragging') && !document.querySelector('[class*="drop-zone-"]')`), 'no drag state or zone left');
  t.ok(!/\x1b[2w]/.test(sent.join('')), `the keys did not reach a shell (${J(sent.join(''))})`);

  // 3. Ctrl+Shift+F and Ctrl+Tab still work from inside a terminal.
  const visibleTab = await activeTab();
  const visPane = await b.ev(`document.querySelector('#panes .tab-root:not(.h) .pane').getAttribute('data-pane')`);
  await focusIn(visPane);
  await key('KeyF', 'F', 70, CTRL | SHIFT);
  t.ok(await until(() => b.ev(`(() => { const s = ${pane(visPane)}.el.querySelector('[data-search]'); return !!s && !s.classList.contains('h'); })()`), 2000) >= 0,
       'Ctrl+Shift+F opens the search box');
  await key('Escape', 'Escape', 27, 0);
  // A split for Ctrl+Tab: in the tab on screen.
  const before = await b.ev('Object.keys(panes).length');
  await b.ev(`(() => { splitPane(${J(visPane)}, 'h'); ${b._fill(false)} doConnect(); return 1; })()`);
  const iS = await b._ready(before);
  const S = await b.ev(`Object.keys(panes)[${iS}]`);
  await focusIn(S);
  const act0 = await b.ev('activeId');
  sent.length = 0;
  await key('Tab', 'Tab', 9, CTRL);
  await sleep(300);
  t.note(`after Ctrl+Tab the wire carried ${J(sent.join(''))}`);
  // Not a step-4 check: Ctrl+Tab typed INSIDE a terminal never cycled
  // panes (xterm sends Tab and stops the event before the document
  // listener; desktop Chrome reserves Ctrl+Tab anyway). Same on the
  // commit before the tab keys. Recorded, not asserted.
  const moved = await until(async () => await b.ev('activeId') !== act0, 1000) >= 0;
  t.note(`Ctrl+Tab inside a terminal ${moved ? 'moved to the other pane' : 'did not move (known, pre-existing)'}`);
  t.ok(b.errors.length === 0, `no page errors (${J(b.errors.slice(0, 3))})`);
}
