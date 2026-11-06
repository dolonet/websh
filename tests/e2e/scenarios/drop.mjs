// The stream's TCP connection is reset (the browser sees an error).
import { sleep, tagOf, numbered, fromOne, until, resetConnections } from '../lib.mjs';
export const meta = { about: 'stream connection reset 3 times during output', ssh: true, local: true, sudo: true };

export async function run({ b, t, port }) {
  const i = await b.connect();
  const sid = (await b.state())[i].sid;
  for (const round of [1, 2, 3]) {
    const tag = tagOf('R' + round + 'x');
    await b.type(i, `for i in $(seq 1 25); do echo ${tag}_$i; sleep 0.2; done\r`);
    await sleep(1200);
    const killed = resetConnections(port);
    const took = await until(async () => {
      const s = (await b.state())[i];
      return (await b.lines(i)).includes(tag + '_25') && s.sse && !s.reconnecting;
    }, 20000);
    await sleep(800);
    const nums = numbered(await b.lines(i), tag);
    t.ok(took >= 0 && nums.length === 25 && fromOne(nums),
      `round ${round}: ${killed} connection(s) reset, 25 lines each once in order (got ${nums.length})`);
  }
  resetConnections(port);
  const word = tagOf('T') + '_after_reset_0123456789';
  await b.type(i, `echo ${word}\r`);
  await sleep(3000);
  t.ok((await b.lines(i)).includes(word), 'typing right after a reset arrives intact');
  const st = (await b.state())[i];
  t.ok(st.sid === sid && st.sse, 'same session, on SSE');
  await b.type(i, 'exit\r');
}
