// Sealed mode switched on and off over and over, quickly, while two
// panes are being typed into: every key arrives once, in order, in its
// own pane, and the output of both keeps coming (spec: "Toggling takes
// effect immediately, without a reload: open panes keep working, no
// typed key and no output is lost or duplicated").
import { sleep, until, tagOf } from '../lib.mjs';
export const meta = { about: 'sealed mode toggled 24 times in 3 s while two panes are typed into: every key once, in order', ssh: true, local: true };

export async function run({ b, t }) {
  const a = await b.connect();
  const c = await b.split();
  const tag = tagOf('G');
  const toggle = () => b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return settings.sealed; })()`);
  const words = [[], []];
  // printf, so the output line (OUT:...) differs from the command line.
  await b.type(a, `printf 'OUT:%s\\n' "${tag}A`);
  await b.type(c, `printf 'OUT:%s\\n' "${tag}B`);
  let toggles = 0;
  for (let n = 0; n < 48; n++) {
    const p = n % 2, w = ` w${n}`;
    words[p].push(w);
    await b.type(p ? c : a, w);
    if (n % 2 === 1) { await toggle(); toggles++; }
    await sleep(50);                      // a fast typist between words
  }
  // Leave it on.
  if (!(await b.ev('settings.sealed'))) { await toggle(); toggles++; }
  t.note(`toggled ${toggles} times; ends ${await b.ev('settings.sealed') ? 'on' : 'off'}`);
  await b.type(a, '"\r'); await b.type(c, '"\r');
  // Logical lines: a long line wraps in the terminal; join the wrapped rows.
  const logical = i => b.ev(`(() => { const p = Object.values(panes)[${i}]; const bf = p.term.buffer.active; const out = [];
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (!l) continue; const n = bf.getLine(y + 1);
      const s = l.translateToString(!(n && n.isWrapped)); if (l.isWrapped && out.length) out[out.length - 1] += s; else out.push(s); }
    return out.map(x => x.trim()); })()`);
  for (const [i, k] of [[a, 0], [c, 1]]) {
    const want = `OUT:${tag}${k ? 'B' : 'A'}${words[k].join('')}`;
    const got = await until(async () => (await logical(i)).includes(want), 15000);
    const lines = await logical(i);
    t.ok(got >= 0, `pane ${k ? 'B' : 'A'}: every word arrived once, in order, in this pane` +
         (got < 0 ? '; last lines: ' + JSON.stringify(lines.filter(Boolean).slice(-3)) : ''));
    t.ok(lines.filter(l => l === want).length <= 1, `pane ${k ? 'B' : 'A'}: the output line is there once`);
  }
  // Output still flows in both, sealed.
  for (const i of [a, c]) {
    const w = tagOf('Z') + '_' + i;
    await b.type(i, `echo ${w}\r`);
    t.ok(await until(async () => (await b.lines(i)).includes(w), 8000) >= 0, `pane ${i}: output flows after the toggling`);
  }
  const st = await b.state();
  t.ok(st.every(s => s.sid && !s.reconnecting), 'both panes connected, same as before: ' + JSON.stringify(st));
}
