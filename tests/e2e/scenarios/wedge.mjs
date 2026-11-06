// "I type, the text does not appear; after a reload it is there."
// Caught in production (client_diag beacon, 2026-10-18): a visible pane,
// data handed to xterm 5 ms earlier, no render for 18 s. If anything
// throws inside xterm's write/parse loop, xterm 5.5 never schedules the
// next parse: every byte after it waits in the write queue until reload,
// while the keys still reach the shell.
//
// Here a parser hook throws exactly once (on an otherwise ignored
// CSI ... z the shell prints) while output is streaming. The pane must
// come back by itself: typed text on screen within a few seconds, and
// the output that follows keeps flowing. And a pane that only prints a
// spinner (a constant trickle) must never trigger a recovery.
import { sleep, tagOf, until, numbered } from '../lib.mjs';
export const meta = {
  about: 'a throw inside xterm\'s parse loop does not freeze the pane until reload; a spinner never triggers a recovery',
  ssh: true, local: true,
};

export async function run({ b, t }) {
  const J = JSON.stringify;
  b.startTrace();
  // A plain (non-tmux) pane: tmux would drop the unknown CSI that the
  // hook throws on. What throws does not matter; that the loop recovers does.
  const i = await b.connect();
  const P = `Object.values(panes)[${i}]`;
  const buf = () => b.ev(`(() => { const bf = ${P}.term.buffer.active; let s = '';
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) s += l.translateToString(true) + '\\n'; } return s; })()`);
  const has = async s => (await buf()).includes(s);
  const paintWarnings = () => (b.trace || []).filter(l => l.includes('paint:')).length;

  // ── 1. a spinner: constant trickle, no recovery may fire ───────────
  const w0 = paintWarnings();
  await b.type(i, `clear; for k in $(seq 1 150); do printf '\\r spin %d ' $k; sleep 0.1; done; echo; echo SPIN_$((1+1))DONE\r`);
  const spun = await until(() => has('SPIN_2DONE'), 40000);
  t.ok(spun >= 0, 'the spinner ran to its end');
  const spurious = paintWarnings() - w0;
  t.ok(spurious === 0, `a spinner (150 updates in 15 s) triggers no paint recovery (${spurious} "paint:" warnings)`);

  // ── 2. the parse loop throws once while output streams ────────────
  for (let round = 1; round <= 3; round++) {
    const tag = tagOf('W' + round);
    await b.ev(`(() => { const p = ${P}; window.__wedge = 0;
      if (!p.__wedgeHook) p.__wedgeHook = p.term.parser.registerCsiHandler({ final: 'z' }, () => {
        if (window.__wedge === 0) { window.__wedge = 1; throw new Error('e2e wedge: parser hook throws'); }
        return true; });
      return 1; })()`);
    // Lines before and after the throwing sequence, printed one per 100 ms.
    await b.type(i, `clear; for k in $(seq 1 60); do echo ${tag}_$k; [ $k = 10 ] && printf '\\033[1z'; sleep 0.1; done\r`);
    const thrown = await until(() => b.ev('window.__wedge === 1'), 10000, 50);
    t.ok(thrown >= 0, `round ${round}: the parser hook threw`);
    // The user types while the loop is still printing.
    await sleep(800);
    const mark = tagOf('K' + round);
    const t0 = Date.now();
    await b.type(i, `${mark}`);
    const shown = await until(() => has(mark), 15000, 100);
    t.ok(shown >= 0 && shown < 3000, `round ${round}: typed text shows up after the throw (${shown < 0 ? 'not in 15 s' : shown + ' ms'})`);
    const done = await until(async () => numbered((await buf()).split('\n').map(l => l.trim()), tag).includes(60), 20000);
    const nums = numbered((await buf()).split('\n').map(l => l.trim()), tag);
    t.ok(done >= 0, `round ${round}: output keeps flowing to the end (last line ${nums.length ? nums[nums.length - 1] : 'none'} of 60)`);
    await b.type(i, '\x15');   // drop the typed mark from the command line
    await until(() => b.ev(`!${P}.term._core._writeBuffer._writeBuffer.length`), 5000);
    void t0;
  }
  // The thrown error is the test's own; anything else is a real error.
  b.errors = b.errors.filter(e => !/e2e wedge/.test(e));
  await b.type(i, 'exit\r');
}
