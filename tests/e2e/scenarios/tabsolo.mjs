// Tabs step 2: a pane alone in its tab has no bar of its own. The tab
// carries its host and state; the pane actions sit in the top bar
// (#paneTools) and act on that pane. The terminal gets the bar's height,
// and the PTY is told the new size once - checked with `stty size` in
// the real shell, not with the terminal's own idea of its size.
// A split brings the bars back (each pane needs a header), closing back
// to one pane hides it again. Upload from the top-bar button goes through
// the real file picker, its progress and cancel stay visible.
//
// Relies on: #paneTools [data-act=upload|download|split-h|split-v|close],
// .pane > .pane-bar, .upload-progress(-text|-cancel), #tabs .tab-root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sleep, until, tagOf, cfg } from '../lib.mjs';
export const meta = {
  about: 'one pane in a tab: no pane bar, full height, PTY resized once; top-bar actions incl. upload via the file picker',
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
  const barH = id => b.ev(`(() => { const e = ${pane(id)}.el.querySelector('.pane-bar'); return e ? e.offsetHeight : 0; })()`);
  // The terminal's box against the pane's: equal when no bar takes space.
  const boxes = id => b.ev(`(() => { const p = ${pane(id)};
    return [p.el.getBoundingClientRect().height, p.el.querySelector('.pane-term').getBoundingClientRect().height]; })()`);
  const toolsShown = () => b.ev(`(() => { const g = document.getElementById('paneTools'); return !!g && g.offsetWidth > 0; })()`);
  const fitted = id => b.ev(`(() => { const p = ${pane(id)}; const d = p.fitAddon.proposeDimensions();
    return !!d && d.cols === p.term.cols && d.rows === p.term.rows && p.lastSentCols === p.term.cols && p.lastSentRows === p.term.rows; })()`);
  const click = async sel => {
    const r = await b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e || !e.offsetWidth) return null;
      const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
    if (!r) throw new Error('no visible element ' + sel);
    for (const type of ['mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  };
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
  const resizes = () => b.requests.resize || 0;

  const iA = await b.connect({ persistent: false });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  if (!t.ok(await b.ev(`!!document.getElementById('paneTools')`), 'the top-bar pane actions (#paneTools) exist')) return;
  await until(() => fitted(A), 5000);

  // One pane: no bar, the terminal has the pane's whole height.
  t.ok(await barH(A) === 0, `the lone pane's bar is not shown (height ${await barH(A)})`);
  const [hp, ht] = await boxes(A);
  t.ok(Math.abs(hp - ht) <= 1, `the terminal box is the whole pane: ${ht} of ${hp} px`);
  t.ok(await toolsShown(), 'the pane actions are in the top bar');
  const [c1, r1] = await size(A);
  let sz = await sttySize(A, 'SOLO');
  t.ok(sz === `${r1}x${c1}`, `the PTY has the terminal's size: ${sz} (want ${r1}x${c1})`);

  // Split from the top-bar button: both panes get their bar back.
  const before = await b.ev('Object.keys(panes).length');
  await click('#paneTools [data-act="split-h"]');
  t.ok(await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000) >= 0,
       'split-h in the top bar opens the login form');
  await b.ev(`(() => { ${b._fill(false)} doConnect(); return 1; })()`);
  const iB = await b._ready(before);
  const B = await b.ev(`Object.keys(panes)[${iB}]`);
  await until(() => fitted(A), 5000);
  t.ok(await barH(A) > 0 && await barH(B) > 0, 'two panes: both show their bar');
  t.ok(!(await toolsShown()), 'and the top-bar pane actions are hidden');
  const [c2, r2] = await size(A);
  t.ok(r2 < r1, `the first pane gave rows to its bar (${r1} -> ${r2})`);
  sz = await sttySize(A, 'SPLIT');
  t.ok(sz === `${r2}x${c2}`, `its PTY followed: ${sz} (want ${r2}x${c2})`);

  // Back to one pane: bar hidden, the rows come back, one resize.
  await sleep(300);                   // let any resize from the split land first
  const mark = resizes();
  // The bar goes while A is flooding output: the refit must still be
  // one resize, and the flood must arrive whole.
  await type(A, 'seq 1 100000 | tail -n 100000 > /dev/null; seq 1 30000; echo FLOOD_DONE\r');
  await sleep(300);
  await b.ev(`closePane(${J(B)})`);
  t.ok(await until(async () => (await lines(A)).includes('FLOOD_DONE'), 30000) >= 0, 'the flood during the bar change finished');
  t.ok((await lines(A)).includes('30000'), 'and its last line is there');
  await until(async () => (await size(A))[1] === r1 && await fitted(A), 5000);
  await sleep(1000);                  // a repeat would show up here
  t.ok(await barH(A) === 0 && await toolsShown(), 'one pane again: no bar, actions back in the top bar');
  const [c3, r3] = await size(A);
  t.ok(r3 === r1 && c3 === c1, `full size again: ${c3}x${r3} (was ${c1}x${r1})`);
  t.ok(resizes() - mark === 1, `exactly one /api/resize for the change (${resizes() - mark})`);
  sz = await sttySize(A, 'BACK');
  t.ok(sz === `${r1}x${c1}`, `the PTY has it: ${sz}`);

  // Upload from the top-bar button, through the real file picker.
  const name = 'websh-e2e-solo-' + tagOf('U') + '.bin';
  const local = path.join(os.tmpdir(), name);
  const data = Buffer.alloc(600 * 1024);
  for (let k = 0; k < data.length; k++) data[k] = (k * 7 + 13) & 255;
  fs.writeFileSync(local, data);
  const digest = createHash('sha256').update(data).digest('hex');
  try {
    await type(A, 'cd ~\r');
    await sleep(500);
    await b.send('Page.setInterceptFileChooserDialog', { enabled: true });
    let chooser = null;
    const on = b._on.bind(b);
    b._on = d => { if (d.method === 'Page.fileChooserOpened') chooser = d.params; on(d); };
    await b.network({ upload: 100 * 1024 });   // ~6 s: time to look at the progress
    await click('#paneTools [data-act="upload"]');
    const opened = await until(() => !!chooser, 3000);
    t.ok(opened >= 0, 'the top-bar upload button opens the file picker');
    if (opened >= 0) {
      await b.send('DOM.setFileInputFiles', { files: [local], backendNodeId: chooser.backendNodeId });
      const prog = () => b.ev(`(() => { const v = Array.from(document.querySelectorAll('.upload-progress')).filter(e => e.offsetWidth > 0);
        if (!v.length) return null; const c = v[0].querySelector('.upload-progress-cancel');
        return {n: v.length, text: v[0].textContent, cancel: !!c && c.offsetWidth > 0}; })()`);
      let seen = null;
      await until(async () => { const p = await prog(); if (p && /\d+%|KB|MB/.test(p.text)) seen = p; return !!seen; }, 5000, 100);
      t.ok(!!seen, `the upload progress is visible for the lone pane (${J(seen)})`);
      t.ok(!!seen && seen.cancel, 'with a visible cancel button');
      t.ok(await barH(A) === 0, 'the pane bar stays hidden during the upload');
      await b.network({});
      const done = await until(async () => { const p = await prog(); return !!p && /Saved|complete|failed/i.test(p.text); }, 30000, 100);
      const p = await prog();
      t.ok(done >= 0 && /Saved|complete/i.test(p ? p.text : ''), `upload finished: ${J(p && p.text)}`);
      const remote = path.join(os.homedir(), name);
      if (fs.existsSync(remote)) {
        const got = createHash('sha256').update(fs.readFileSync(remote)).digest('hex');
        t.ok(got === digest, 'the file on the target is identical');
        fs.unlinkSync(remote);
      } else {
        t.note(`target ${cfg.host} is not this machine (or the file went elsewhere): checked the banner only`);
        await type(A, `rm -f ~/${name}\r`);
      }
    }
  } finally {
    delete b._on;
    await b.network({});
    await b.send('Page.setInterceptFileChooserDialog', { enabled: false });
    try { fs.unlinkSync(local); } catch (e) {}
  }

  // Reload: the one-pane tab comes back without a bar, at full size.
  await b.open(b.url);
  const back = await until(() => b.ev(`Object.values(panes).length === 1 && Object.values(panes).every(p => p.sid)`), 30000);
  t.ok(back >= 0, 'after reload the pane is back');
  if (back >= 0) {
    const R = await b.ev('Object.keys(panes)[0]');
    await until(() => fitted(R), 5000);
    await sleep(1000);
    t.ok(await barH(R) === 0 && await toolsShown(), 'after reload: no pane bar, actions in the top bar');
    const [c4, r4] = await size(R);
    sz = await sttySize(R, 'RELOAD');
    t.ok(sz === `${r4}x${c4}` && r4 === r1, `after reload the PTY is ${sz}, the terminal ${c4}x${r4} (full height ${r1})`);
  }
}
