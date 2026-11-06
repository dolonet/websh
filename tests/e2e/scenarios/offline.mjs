// The browser loses the network for a while during output.
import { sleep, tagOf, numbered, fromOne, until } from '../lib.mjs';
export const meta = { about: '8 s without network during output: nothing lost or doubled', ssh: true };

export async function run({ b, t }) {
  const i = await b.connect();
  const sid = (await b.state())[i].sid;
  const tag = tagOf('L');
  await b.type(i, `for i in $(seq 1 30); do echo ${tag}_$i; sleep 0.3; done\r`);
  await sleep(1500);
  await b.network({ offline: true });
  await sleep(8000);
  await b.network({});
  const took = await until(async () => (await b.lines(i)).includes(tag + '_30'), 30000);
  t.ok(took >= 0, 'output caught up after the network returned');
  await sleep(1000);
  const nums = numbered(await b.lines(i), tag);
  t.ok(nums.length === 30 && fromOne(nums), `30 lines, each once, in order (got ${nums.length})`);
  const st = (await b.state())[i];
  t.ok(st.sid === sid, 'same session');
  t.ok(st.sse && !st.reconnecting, 'back on SSE, not reconnecting');
  await b.type(i, 'exit\r');
}
