// Tabs under load: five tabs in a narrow window (the strip scrolls,
// the page does not), rapid switching while two tabs flood output, a
// zoom made while a tab is hidden, a tab dragged to the front with the
// mouse, and a reload that keeps that order.
//
// Relies on the tab DOM: #tabNew, #tabs .tab[data-tab] (.active,
// .tab-label), #panes .tab-root[data-tab].
import { sleep, tagOf, until } from '../lib.mjs';
export const meta = {
  about: '5 tabs: strip scrolls, flood + rapid switching, zoom while hidden, drag reorder survives reload',
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
  const tabOf = id => b.ev(`${pane(id)}.el.closest('.tab-root').getAttribute('data-tab')`);
  const order = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getAttribute('data-tab'))`);
  const activeTab = () => b.ev(`(document.querySelector('#tabs .tab.active') || {}).getAttribute?.call(document.querySelector('#tabs .tab.active'), 'data-tab')`);
  const centre = async sel => b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null;
    const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
  const mouse = (type, x, y, buttons) => b.send('Input.dispatchMouseEvent',
    { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons: buttons || 0, clickCount: 1 });
  const clickTab = async id => {
    await b.ev(`document.querySelector('#tabs .tab[data-tab="${id}"]').scrollIntoView({inline: 'nearest'})`);
    const r = await centre(`#tabs .tab[data-tab="${id}"] .tab-label`);
    if (!r) throw new Error('no tab ' + id);
    await mouse('mousePressed', r.x, r.y, 1); await mouse('mouseReleased', r.x, r.y, 0);
  };
  const synced = id => until(() => b.ev(`(() => { const p = ${pane(id)}; const d = p.fitAddon.proposeDimensions();
    return !!d && d.cols === p.term.cols && d.rows === p.term.rows &&
      p.lastSentCols === p.term.cols && p.lastSentRows === p.term.rows; })()`), 6000, 50);
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
  const sizeOk = async (id, what) => {
    t.ok(await synced(id) >= 0, `${what}: fitted and the server told`);
    const [c, r] = await b.ev(`[${pane(id)}.term.cols, ${pane(id)}.term.rows]`);
    const s = await sttySize(id, 'SZ' + tagOf(''));
    t.ok(s === `${r}x${c}` && c >= 20, `${what}: PTY ${s} matches the terminal ${r}x${c}`);
  };
  const newTab = async persistent => {
    const before = await b.ev('Object.keys(panes).length');
    const r = await centre('#tabNew');
    await mouse('mousePressed', r.x, r.y, 1); await mouse('mouseReleased', r.x, r.y, 0);
    await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
    await b.ev(`(() => { ${b._fill(persistent)} doConnect(); return 1; })()`);
    const i = await b._ready(before);
    return b.ev(`Object.keys(panes)[${i}]`);
  };

  if (!t.ok(await b.ev(`!!document.getElementById('tabNew')`), 'the "+" button (#tabNew) exists')) return;
  await b.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 650, deviceScaleFactor: 1, mobile: false });
  const tag = tagOf('S');
  const P = [];
  P.push(await b.ev(`Object.keys(panes)[${await b.connect({ persistent: true })}]`));
  P.push(await newTab(true));
  P.push(await newTab(true));
  for (let i = 0; i < 3; i++) await type(P[i], `export WT=${i + 1}_${tag}; clear\r`);
  // Five panes, not more: over HTTP/1.1 (this private instance) the
  // browser allows six connections per origin and every pane holds one
  // for its output stream - see the scenario `h1limit`.
  for (let i = 0; i < 2; i++) P.push(await newTab(false));
  const T = [];
  for (const p of P) T.push(await tabOf(p));
  t.ok((await order()).length === 5, `five tabs (${(await order()).length})`);

  // Narrow window, five tabs.
  const geo = await b.ev(`(() => { const s = document.getElementById('tabs');
    const tabs = Array.from(s.querySelectorAll('.tab')).map(e => e.getBoundingClientRect().width);
    const a = s.querySelector('.tab.active').getBoundingClientRect(), r = s.getBoundingClientRect();
    return {over: s.scrollWidth > s.clientWidth, minW: Math.min(...tabs), activeIn: a.left >= r.left - 1 && a.right <= r.right + 1,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      labelsCut: Array.from(s.querySelectorAll('.tab-label')).some(l => l.scrollWidth > l.clientWidth)}; })()`);
  t.note('strip: ' + J(geo));
  t.ok(geo.page <= 0, `the page does not scroll horizontally (${geo.page}px)`);
  t.ok(geo.activeIn, 'the active (last) tab is scrolled into view');
  t.ok(geo.over, 'the strip overflows at this width (so scrolling is tested)');
  t.ok(geo.minW >= 90, `tabs keep a minimum width (${Math.round(geo.minW)}px)`);
  await clickTab(T[0]);
  t.ok(await until(async () => (await activeTab()) === T[0], 3000) >= 0, 'the first tab can be reached and shown');
  t.ok(await b.ev(`(() => { const s = document.getElementById('tabs').getBoundingClientRect();
    const a = document.querySelector('#tabs .tab.active').getBoundingClientRect(); return a.left >= s.left - 1 && a.right <= s.right + 1; })()`),
    'and it is in view');

  // Flood two tabs, switch between them fast.
  await type(P[1], 'seq 1 200000\r');
  await type(P[2], 'seq 1 200000\r');
  for (let i = 0; i < 40; i++) { await clickTab(T[1 + (i % 2)]); await sleep(20); }
  const done = await until(async () => (await lines(P[1])).includes('200000') && (await lines(P[2])).includes('200000'), 60000);
  t.ok(done >= 0, 'both floods finished in their terminals');
  t.ok((await activeTab()) === T[2], 'the last clicked tab is in front');
  await sizeOk(P[2], 'tab 3 after the switching');
  await clickTab(T[1]);
  await sizeOk(P[1], 'tab 2 after the switching');

  // Zoom while tab 1 is hidden, then show it.
  const [c0] = await b.ev(`[${pane(P[0])}.term.cols]`);
  await b.ev('zoomIn(); zoomIn(); 1');
  await sleep(500);
  t.ok((await b.ev(`${pane(P[0])}.term.cols`)) === c0, 'a hidden pane is not refitted by a zoom');
  await clickTab(T[0]);
  await sizeOk(P[0], 'tab 1 shown after a zoom');
  t.ok((await b.ev(`${pane(P[0])}.term.cols`)) < c0, 'and has fewer columns at the bigger font');
  await b.ev('zoomOut(); zoomOut(); 1');
  await sizeOk(P[0], 'tab 1 after zooming back');

  // Drag tab 3 to the front with the mouse.
  await b.ev(`document.getElementById('tabs').scrollLeft = 0`);
  const from = await centre(`#tabs .tab[data-tab="${T[2]}"] .tab-label`);
  const to = await centre(`#tabs .tab[data-tab="${T[0]}"]`);
  await mouse('mousePressed', from.x, from.y, 1);
  for (let x = from.x; x > to.x - 60; x -= 15) await mouse('mouseMoved', x, from.y, 1);
  await mouse('mouseReleased', to.x - 60, from.y, 0);
  const o = await order();
  t.ok(o[0] === T[2] && o[1] === T[0] && o[2] === T[1], `tab 3 dragged to the front (${J(o.slice(0, 3))})`);
  const filesDrop = await b.ev(`Object.values(panes).some(p => p.upload)`);
  t.ok(!filesDrop, 'dragging a tab started no upload');

  // Reload: order and shells survive.
  await b.open(b.url);
  await until(async () => (await order()).length === 5 &&
    await b.ev(`Object.values(panes).length === 5 && Object.values(panes).every(p => p.sid)`), 40000);
  const o2 = await order();
  t.ok(o2.length === 5, `five tabs after reload (${o2.length})`);
  const firstPanes = await b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).slice(0, 3).map(e =>
    document.querySelector('#panes .tab-root[data-tab="' + e.getAttribute('data-tab') + '"] .pane').getAttribute('data-pane'))`);
  await sleep(1500);
  const want = ['3', '1', '2'];
  for (let i = 0; i < 3; i++) {
    await type(firstPanes[i], 'echo WT_$WT\r');
    const hit = await until(async () => (await lines(firstPanes[i])).includes(`WT_${want[i]}_${tag}`), 8000);
    t.ok(hit >= 0, `after reload, tab ${i + 1} is the shell that was tab ${want[i]}`);
  }
  await b.ev(`document.querySelector('#tabs .tab').scrollIntoView({inline: 'nearest'})`);
  await clickTab(o2[0]);
  await sizeOk(firstPanes[0], 'restored hidden tab, shown');
}
