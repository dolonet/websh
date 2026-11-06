// Tabs step 3: moving panes between tabs, with a real mouse.
// A pane leaves its split for a tab of its own ("Move to new tab" in its
// bar, or its bar dragged onto the strip), a pane joins another tab (its
// bar dropped on that tab), and a whole tab is dropped on the edge of a
// pane of the tab on screen. None of it may reconnect or restart a pane:
// the tmux shell is the same one (an exported variable is still there),
// output that runs during the move arrives whole and in order, the
// scrollback of a plain pane is still in the terminal (a tmux pane is on
// xterm's alternate screen with no scrollback of its own, so its output
// is kept shorter than its screen), and the PTY ends up with the size
// the terminal has (`stty size` in the real shell). A reload brings the
// moved layout back.
//
// Relies on: .pane-bar [data-act="to-tab"], .pane-label (where a bar is
// grabbed), #tabs .tab[data-tab], #tabNew, #panes .tab-root[data-tab],
// .split-h/.split-v, and .drop-zone-left|right|top|bottom shown on the
// hovered pane while a tab is dragged over it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, tagOf, numbered, consecutive, until } from '../lib.mjs';
export const meta = {
  about: 'move panes between tabs by button and by real mouse drags: same sessions, nothing lost, reload restores it',
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
  const sid = id => b.ev(`${pane(id)} ? ${pane(id)}.sid : null`);
  const tabOf = id => b.ev(`(() => { const r = ${pane(id)}.el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; })()`);
  const tabIds = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getAttribute('data-tab'))`);
  const activeTab = () => b.ev(`(() => { const e = document.querySelector('#tabs .tab.active'); return e ? e.getAttribute('data-tab') : null; })()`);
  // A tab's layout as text, panes by id: (h p1 p2).
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
    e.scrollIntoView && e.scrollIntoView({block: 'nearest', inline: 'nearest'});
    const q = e.getBoundingClientRect(); return {x: q.x, y: q.y, w: q.width, h: q.height}; })()`);
  const mid = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent',
    { type, x: p.x, y: p.y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const click = async sel => {
    const r = await rect(sel);
    if (!r) throw new Error('no visible element ' + sel);
    await mouse('mousePressed', mid(r), 1); await mouse('mouseReleased', mid(r), 0);
  };
  // Press at `from`, move in steps to `to` with the button down, release.
  const drag = async (from, to, beforeUp) => {
    await mouse('mouseMoved', from, 0);
    await mouse('mousePressed', from, 1);
    const n = 12;
    for (let i = 1; i <= n; i++) {
      await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / n, y: from.y + (to.y - from.y) * i / n }, 1);
      await sleep(15);
    }
    const seen = beforeUp ? await beforeUp() : null;
    await mouse('mouseReleased', to, 0);
    return seen;
  };
  const paneSel = id => `#panes .pane[data-pane="${id}"]`;
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
    const [c, r] = await size(id);
    const s = await sttySize(id, mark);
    return { ok: s === `${r}x${c}`, text: `PTY ${s}, terminal ${c}x${r}` };
  };

  // A is the tmux pane, B a plain one (it carries the scrollback check).
  const iA = await b.connect({ persistent: true });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const iB = await b.split({ persistent: false });
  const B = await b.ev(`Object.keys(panes)[${iB}]`);
  const tag = tagOf('M');
  await type(A, `export WT=A_${tag}; clear\r`);
  await type(B, `seq 1 300 | sed 's/^/SB_/'\r`);
  await until(async () => (await lines(B)).includes('SB_300'), 8000);
  const sidA = await sid(A), sidB = await sid(B);
  const tA = await tabOf(A);
  t.ok(J(await shapes()) === J([`(h ${A} ${B})`]), `start: one tab, A and B side by side (${J(await shapes())})`);

  // 1. "Move to new tab" from B's bar, while B is printing.
  const btn = `${paneSel(B)} .pane-bar [data-act="to-tab"]`;
  if (!t.ok(!!(await rect(btn)), 'B\'s bar has a visible "Move to new tab" button')) return;
  const connects0 = b.requests.connect || 0;
  await type(B, `for i in $(seq 1 40); do echo MV_$i; sleep 0.1; done; echo MV_END\r`);
  await sleep(700);
  await click(btn);
  const moved = await until(async () => (await tabIds()).length === 2, 3000);
  t.ok(moved >= 0, 'B is in a tab of its own');
  const tB = await tabOf(B);
  t.ok(tB && tB !== tA && await activeTab() === tB, 'the new tab is in front');
  t.ok(await b.ev(`${pane(B)}.el.contains(document.activeElement)`), 'keyboard focus is in B');
  t.ok(await until(async () => (await lines(B)).includes('MV_END'), 15000) >= 0, 'the output running during the move finished');
  const nums = numbered(await lines(B), 'MV');
  t.ok(nums.length === 40 && consecutive(nums) && nums[0] === 1, `all 40 lines, in order, none twice (${nums.length})`);
  t.ok((await lines(B)).includes('SB_1'), 'the scrollback from before the move is still there');
  t.ok(await sid(B) === sidB && await sid(A) === sidA, 'both sessions unchanged');
  t.ok((b.requests.connect || 0) === connects0, `no /api/connect (${(b.requests.connect || 0) - connects0})`);
  let s = await settledSize(B, 'NEWTAB');
  t.ok(s.ok, `B's PTY has its terminal's size in the new tab: ${s.text}`);

  // 2. Drag tab B onto the right edge of A, with A's tab in front.
  await click(`#tabs .tab[data-tab="${tA}"] .tab-label`);
  await until(async () => await activeTab() === tA, 3000);
  const ra = await rect(paneSel(A));
  const from = mid(await rect(`#tabs .tab[data-tab="${tB}"]`));
  const to = { x: ra.x + ra.w * 0.93, y: ra.y + ra.h / 2 };
  const zone = await drag(from, to, () => b.ev(`(() => { const p = ${pane(A)};
    const z = document.querySelector('.drop-zone-left,.drop-zone-right,.drop-zone-top,.drop-zone-bottom');
    return z ? {side: (z.className.match(/drop-zone-(\\w+)/) || [])[1], onA: p.el.contains(z) || z === p.el} : null; })()`));
  t.ok(!!zone && zone.side === 'right' && zone.onA, `before release the right edge of A is highlighted (${J(zone)})`);
  const merged = await until(async () => (await tabIds()).length === 1, 3000);
  t.ok(merged >= 0, 'the dragged tab is gone');
  t.ok(await shape(tA) === `(h ${A} ${B})`, `B is right of A again (${await shape(tA)})`);
  t.ok(await b.ev(`!document.querySelector('.drop-zone-left,.drop-zone-right,.drop-zone-top,.drop-zone-bottom')`), 'no drop zone left');
  t.ok(await sid(B) === sidB && await sid(A) === sidA && (b.requests.connect || 0) === connects0, 'same sessions, no connect');
  s = await settledSize(A, 'MERGEA'); t.ok(s.ok, `A after the merge: ${s.text}`);
  s = await settledSize(B, 'MERGEB'); t.ok(s.ok, `B after the merge: ${s.text}`);

  // 3. Drag B's bar onto the strip (its empty end, else "+").
  const strip = await rect('#tabs');
  const last = await b.ev(`(() => { const e = Array.from(document.querySelectorAll('#tabs .tab')).pop(); const q = e.getBoundingClientRect(); return q.right; })()`);
  const target = strip.x + strip.w - last > 30 ? { x: (last + strip.x + strip.w) / 2, y: strip.y + strip.h / 2 } : mid(await rect('#tabNew'));
  await drag(mid(await rect(`${paneSel(B)} .pane-label`)), target);
  t.ok(await until(async () => (await tabIds()).length === 2, 3000) >= 0, 'B\'s bar dropped on the strip: a new tab');
  const tB2 = await tabOf(B);
  t.ok(tB2 !== tA && await activeTab() === tB2 && await shape(tA) === A, `B in its own tab, in front; A alone (${J(await shapes())})`);
  t.ok(await b.ev(`document.getElementById('ov').classList.contains('h')`), 'no login form');

  // 4. A third pane in A's tab; then A's bar (the tmux pane, printing
  // fewer lines than its screen holds) dropped on B's tab.
  await click(`#tabs .tab[data-tab="${tA}"] .tab-label`);
  await until(async () => await activeTab() === tA, 3000);
  const iC = await b.split({ persistent: false });
  const C = await b.ev(`Object.keys(panes)[${iC}]`);
  t.ok(await shape(tA) === `(h ${A} ${C})`, `A and C share A's tab (${await shape(tA)})`);
  const connects1 = b.requests.connect || 0;
  const [, rowsA] = await size(A);
  const nA = Math.max(5, Math.min(15, rowsA - 6));
  await type(A, `clear; for i in $(seq 1 ${nA}); do echo TM_$i; sleep 0.1; done; echo TM_END\r`);
  await sleep(400);
  await drag(mid(await rect(`${paneSel(A)} .pane-label`)), mid(await rect(`#tabs .tab[data-tab="${tB2}"]`)));
  t.ok(await until(async () => await shape(tB2) === `(h ${B} ${A})`, 3000) >= 0, `A joined B's tab, right of B (${J(await shapes())})`);
  t.ok(await shape(tA) === C && (await tabIds()).length === 2, 'C alone in the old tab, two tabs');
  t.ok(await activeTab() === tB2, 'B\'s tab is in front');
  t.ok(await sid(A) === sidA && (b.requests.connect || 0) === connects1, 'the tmux pane kept its session (no connect)');
  t.ok(await until(async () => (await lines(A)).includes('TM_END'), 10000) >= 0, 'its output during the drag finished');
  const tm = numbered(await lines(A), 'TM');
  t.ok(tm.length === nA && consecutive(tm) && tm[0] === 1, `all ${nA} lines, in order, none twice (${tm.length})`);
  await type(A, 'echo WT_$WT\r');
  t.ok(await until(async () => (await lines(A)).includes('WT_A_' + tag), 5000) >= 0, 'still the same tmux shell');
  s = await settledSize(A, 'JOINA'); t.ok(s.ok, `A in B's tab: ${s.text}`);
  t.ok(b.errors.length === 0, `no script errors (${J(b.errors.slice(0, 3))})`);

  // 4b. A file dropped from the OS on the moved pane still uploads into it.
  const fname = 'websh-e2e-move-' + tag + '.txt';
  const local = path.join(os.tmpdir(), fname);
  fs.writeFileSync(local, 'moved ' + tag + '\n');
  try {
    const at = mid(await rect(`${paneSel(A)} .pane-term`));
    const data = { items: [], files: [local], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await b.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
    const banner = () => b.ev(`(() => { const e = document.querySelector('[data-upload-progress="${A}"] .upload-progress-text'); return e ? e.textContent : ''; })()`);
    const up = await until(async () => /Saved to|Upload complete|Upload failed/.test(await banner()), 20000);
    const txt = await banner();
    t.ok(up >= 0 && /Saved to|Upload complete/.test(txt), `a file dropped on the moved tmux pane uploads into it (${J(txt)})`);
    t.ok(J(await shapes()) === J([C, `(h ${B} ${A})`]), 'and the drop moved nothing');
    await type(A, `rm -f ${fname} ~/${fname}\r`);
  } finally { try { fs.unlinkSync(local); } catch (e) {} }

  // 5. Reload: the moved layout comes back; B is still the same tmux shell.
  const before = (await shapes()).map(x => x.replace(/p\d+/g, 'P'));
  const activeIdx = (await tabIds()).indexOf(await activeTab());
  await b.open(b.url);
  const back = await until(() => b.ev(`Object.values(panes).length === 3 && Object.values(panes).every(p => p.sid)`), 30000);
  t.ok(back >= 0, 'after reload all three panes are back');
  if (back < 0) return;
  const after = (await shapes()).map(x => x.replace(/p\d+/g, 'P'));
  t.ok(J(after) === J(before), `same layout after reload: ${J(after)} (was ${J(before)})`);
  t.ok((await tabIds()).indexOf(await activeTab()) === activeIdx, 'the same tab is in front');
  await sleep(1500);
  const ids = await b.ev('Object.keys(panes)');
  let where = null;
  for (const id of ids) {
    if (!(await b.ev(`${pane(id)}.persistent`))) continue;
    await type(id, 'echo WT_$WT\r');
    if (await until(async () => (await lines(id)).includes('WT_A_' + tag), 5000) >= 0) where = id;
  }
  t.ok(!!where && /^\(h P P\)$/.test((await shape(await tabOf(where))).replace(/p\d+/g, 'P')) &&
       (await shape(await tabOf(where))).split(' ')[2] === where + ')',
       'A is the same tmux shell, on the right of the two-pane tab');
}
