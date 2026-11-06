// A long absence: the tab is frozen, its connections are dead, and the
// server-side session of the idle pane expires meanwhile. On return both
// panes must be back by themselves, and the FIRST thing typed must
// arrive (it used to vanish, four different ways).
import { sleep, tagOf, numbered, consecutive, until, blackhole, blackholeOff } from '../lib.mjs';
export const meta = {
  about: 'two panes, 75 s away, server session expired: both back, first keys delivered',
  ssh: true, local: true, sudo: true, env: { SESSION_TIMEOUT: '20' },
};

export async function run({ b, t, port }) {
  const A = await b.connect({ persistent: true });
  const B = await b.split({ persistent: true });
  const tag = tagOf('C');
  await b.type(A, `export WT=A_${tag}; for i in $(seq 1 2000); do echo ${tag}_$i; sleep 0.5; done\r`);
  await b.type(B, `export WT=B_${tag}\r`);
  await sleep(3000);
  const last = async () => { const n = numbered(await b.lines(A), tag); return n.length ? n[n.length - 1] : 0; };
  try {
    t.note(`black-holed ${blackhole(port)} connection(s), page frozen, away 75 s`);
    await b.freeze();
    await sleep(75000);
    await b.unfreeze();
    b.startTrace();
    const before = await last();
    const t0 = Date.now();
    await sleep(750);
    await b.type(B, 'echo back_$WT\r');                 // typed once, never repeated
    let recA = -1, recB = -1;
    await until(async () => {
      if (recA < 0 && await last() > before) recA = Date.now() - t0;
      if (recB < 0 && (await b.lines(B)).includes('back_B_' + tag)) recB = Date.now() - t0;
      return recA >= 0 && recB >= 0;
    }, 60000);
    t.ok(recA >= 0, `pane with running output is live again (${recA < 0 ? 'never' : recA + ' ms'})`);
    t.ok(recB >= 0, `first command typed into the expired pane arrived, same shell (${recB < 0 ? 'never' : recB + ' ms'})`);
    if (recA < 0 || recB < 0) t.note('trace:\n      ' + b.trace.join('\n      '));
    await sleep(1500);
    const st = await b.state();
    t.ok(st.every(s => s.sse && !s.reconnecting), 'both panes on SSE, not reconnecting');
    await b.type(A, '\x03'); await sleep(1000);
    await b.type(A, 'echo still_$WT\r');
    t.ok(await until(async () => (await b.lines(A)).includes('still_A_' + tag), 8000) >= 0, 'pane A: same shell');
    t.ok(consecutive(numbered(await b.lines(A), tag)), 'pane A: visible lines consecutive, none doubled');
  } finally { blackholeOff(); }
}
