// websh itself restarts (every deploy). Panes must find their sessions
// again; before the fix every pane sat at "Disconnected".
import { sleep, tagOf, until } from '../lib.mjs';
export const meta = { about: 'websh restarts: a persistent pane re-attaches to the same tmux shell', ssh: true, local: true };

export async function run({ b, t, server }) {
  const i = await b.connect({ persistent: true });
  const before = (await b.state())[i];
  const v = tagOf('v');
  await b.type(i, `export WT=${v}; echo pre_$WT\r`);
  await sleep(1500);
  const t0 = Date.now();
  await server.restart();
  const took = await until(async () => {
    const s = (await b.state())[i];
    return s.sid && s.sid !== before.sid && s.sse && !s.reconnecting;
  }, 40000);
  t.ok(took >= 0, `pane is back by itself (${took < 0 ? 'never' : (Date.now() - t0) + ' ms'})`);
  await sleep(1500);
  await b.type(i, 'echo post_$WT\r');
  const same = await until(async () => (await b.lines(i)).includes('post_' + v), 8000);
  t.ok(same >= 0, 'same tmux shell (its environment survived)');
  const word = tagOf('T') + '_abcdefghij_0123456789';
  await b.type(i, `echo ${word}\r`);
  t.ok(await until(async () => (await b.lines(i)).includes(word), 8000) >= 0, 'typing after the restart arrives intact');
}
