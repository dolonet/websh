// The stream's connection dies WITHOUT a FIN or RST - a Wi-Fi switch, a
// laptop that slept. The browser gets no error: before the fix the pane
// sent keys and showed nothing until the page was reloaded.
import { sleep, tagOf, numbered, consecutive, until, blackhole, blackholeOff } from '../lib.mjs';
export const meta = { about: 'connection dies silently (Wi-Fi switch): output returns by itself', ssh: true, local: true, sudo: true };

async function last(b, i, tag) { const n = numbered(await b.lines(i), tag); return n.length ? n[n.length - 1] : 0; }

export async function run({ b, t, port }) {
  const i = await b.connect();
  try {
    // A) the user presses a key
    let tag = tagOf('W');
    await b.type(i, `for i in $(seq 1 400); do echo ${tag}_$i; sleep 0.25; done\r`);
    await sleep(2500);
    t.note(`A) black-holed ${blackhole(port)} connection(s)`);
    await sleep(3000);
    let frozenAt = await last(b, i, tag);
    await b.type(i, 'x');
    let took = await until(async () => await last(b, i, tag) > frozenAt, 30000);
    t.ok(took >= 0 && took < 6000, `output resumes within 6 s of a keypress (${took < 0 ? 'never' : took + ' ms'})`);
    blackholeOff();
    await b.type(i, '\x03'); await sleep(1500);
    let nums = numbered(await b.lines(i), tag);
    t.ok(consecutive(nums), `${nums.length} lines, none lost or doubled`);

    // B) nobody types: the heartbeat watchdog has to notice
    tag = tagOf('Q');
    await b.type(i, `for i in $(seq 1 400); do echo ${tag}_$i; sleep 0.25; done\r`);
    await sleep(2500);
    t.note(`B) black-holed ${blackhole(port)} connection(s)`);
    await sleep(1500);
    frozenAt = await last(b, i, tag);
    took = await until(async () => await last(b, i, tag) > frozenAt, 70000);
    t.ok(took >= 0, `without typing, output resumes by itself (${took < 0 ? 'never' : took + ' ms'})`);
    blackholeOff();
    await b.type(i, '\x03'); await sleep(1500);
    nums = numbered(await b.lines(i), tag);
    t.ok(consecutive(nums), `${nums.length} lines, none lost or doubled`);
    const st = (await b.state())[i];
    t.ok(st.sse && !st.reconnecting, 'on SSE, not reconnecting');
  } finally { blackholeOff(); }
  await b.type(i, 'exit\r');
}
