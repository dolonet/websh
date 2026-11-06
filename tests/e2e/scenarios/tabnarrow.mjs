// The tab in front fits in the strip at every narrow width. The top bar
// shares its row with the strip; each button added to it (the pane's
// "Move to tab", 2026-10) takes width from the strip, and at 560 px the
// strip had shrunk to 83 px while a tab is at least 96: the tab in front
// was cut off (found by tabstress). Five tabs, a lone pane in front (so
// the pane actions sit in the top bar, the widest case), each tab shown
// in turn, at 560 / 600 / 640 / 660 / 900 px.
import { until } from '../lib.mjs';
export const meta = {
  about: 'narrow windows (560-900 px): the strip has room for a whole tab, and the tab in front is fully visible',
  ssh: true, local: true,
};

export async function run({ b, t }) {
  const J = JSON.stringify;
  const centre = async sel => b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null;
    const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
  const press = async pt => { for (const type of ['mousePressed', 'mouseReleased'])
    await b.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 }); };
  const newTab = async () => {
    const before = await b.ev('Object.keys(panes).length');
    await press(await centre('#tabNew'));
    await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
    await b.ev(`(() => { ${b._fill(false)} doConnect(); return 1; })()`);
    await b._ready(before);
  };
  await b.connect({ persistent: false });
  for (let i = 0; i < 4; i++) await newTab();
  const ids = await b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getAttribute('data-tab'))`);
  t.ok(ids.length === 5, `five tabs (${ids.length})`);
  const geo = () => b.ev(`(() => { const s = document.getElementById('tabs'); const r = s.getBoundingClientRect();
    const a = s.querySelector('.tab.active').getBoundingClientRect();
    const tabs = Array.from(s.querySelectorAll('.tab')).map(e => e.getBoundingClientRect().width);
    return { strip: Math.round(r.width * 10) / 10, minTab: Math.min(...tabs), fits: a.left >= r.left - 1 && a.right <= r.right + 1,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
  for (const w of [560, 600, 640, 660, 900]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 650, deviceScaleFactor: 1, mobile: false });
    await b.ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    let bad = [];
    let g0 = null;
    for (const id of ids) {
      // Shown by the API the tab click and the shortcuts use; the strip
      // scrolls it into view by itself.
      await b.ev(`showTab(${J(id)})`);
      await b.ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const g = await geo();
      g0 = g0 || g;
      if (!g.fits || g.page > 0) {
        // Diagnostics: does it settle by itself, and where is the tab?
        const d = await b.ev(`(() => { const s = document.getElementById('tabs'); const r = s.getBoundingClientRect();
          const a = s.querySelector('.tab.active').getBoundingClientRect();
          return {sl: s.scrollLeft, sw: s.scrollWidth, cw: s.clientWidth, strip: [Math.round(r.left), Math.round(r.right)], tab: [Math.round(a.left), Math.round(a.right)],
            tools: (document.getElementById('paneTools') || {}).offsetWidth}; })()`);
        const later = await until(async () => (await geo()).fits, 1000, 50);
        bad.push(id + ':' + J(d) + (later >= 0 ? ` (fits ${later} ms later)` : ' (still not after 1 s)'));
      }
    }
    t.ok(g0.strip >= g0.minTab, `${w} px: the strip (${g0.strip} px) has room for a whole tab (${Math.round(g0.minTab)} px)`);
    t.ok(bad.length === 0, `${w} px: every tab, shown, is fully visible and the page does not scroll sideways${bad.length ? ' - ' + bad.join(' ') : ''}`);
  }
}
