// Keys reach the shell in the order typed, and echo costs one round trip.
// Guards: "ecoh" for "echo" (requests overtaking each other).
import { sleep, tagOf, until } from '../lib.mjs';
export const meta = { about: 'typed text arrives in order; echo latency on a 150 ms link', ssh: true };

export async function run({ b, t }) {
  const i = await b.connect();
  const st = (await b.state())[i];
  t.ok(st.sse, 'output over SSE');

  await b.network({ latency: 150 });
  await sleep(300);
  const lat = [];
  for (const c of 'abcxyz') {
    const t0 = Date.now();
    await b.type(i, c);
    for (let k = 0; k < 400; k++) {
      const cur = await b.ev(`(() => { const p = Object.values(panes)[${i}]; const bf = p.term.buffer.active;
        return bf.getLine(bf.baseY + bf.cursorY).translateToString(true); })()`);
      if (cur.trimEnd().endsWith(c)) { lat.push(Date.now() - t0); break; }
      await sleep(5);
    }
  }
  await b.type(i, '\x15');
  await sleep(500);
  t.note('echo latency, ms: ' + lat.join(' '));
  t.ok(lat.length === 6 && Math.max(...lat.slice(1)) < 600, 'echo within ~one round trip');

  const word = tagOf('T') + '_0123456789_abcdefghijklmnopqrstuvwxyz_ZYXWVUTSRQ';
  b.requests.input = 0;
  await b.type(i, `echo ${word}\r`);         // every key at once: a fast typist, key repeat
  await sleep(2500);
  await b.network({});
  t.ok((await b.lines(i)).includes(word), 'a burst of keys arrives exactly as typed');
  t.ok(b.requests.input <= 3, `batched: ${b.requests.input} input request(s) for ${word.length + 6} keys`);
  await orderedInputGate(b, t, i);
  await b.type(i, 'exit\r');
}

// A fast burst can fit into one request and pass even when requests
// race. Hold the first real POST while more chunks enter the terminal:
// the client must queue them until that request has been acknowledged.
async function orderedInputGate(b, t, pane) {
  const word = tagOf('ORDER') + '_abcdefghijklmnopqrstuvwxyz_0123456789';
  let held = null, overtook = 0, seen = 0;
  const originalOn = b._on.bind(b);
  b._on = function (message) {
    originalOn(message);
    if (message.method === 'Fetch.requestPaused') {
      seen++;
      if (held === null) held = message.params.requestId;
      else {
        overtook++;
        this.send('Fetch.continueRequest', { requestId: message.params.requestId }).catch(() => {});
      }
    }
  };
  try {
    await b.send('Fetch.enable', {
      patterns: [{ urlPattern: '*action=input*', requestStage: 'Request' }],
    });
    await b.type(pane, 'echo ');
    if (await until(() => held !== null, 5000) < 0)
      throw new Error('no input POST reached the network gate');
    for (let n = 0; n < word.length; n += 3) {
      await b.type(pane, word.slice(n, n + 3));
      await sleep(20); // separate typing bursts while the first POST stays held
    }
    await b.type(pane, '\r');
    t.ok(overtook === 0, 'later input requests cannot overtake a held first POST');
    const heldCount = seen;
    await b.send('Fetch.continueRequest', { requestId: held });
    await b.send('Fetch.disable');
    t.ok(await until(async () => (await b.lines(pane)).includes(word), 8000) >= 0,
      'queued typing chunks reach the shell in exact order');
    t.ok((await b.lines(pane)).filter(line => line === word).length === 1,
      'queued command executes exactly once');
    t.note('input requests while the first POST was held: ' + heldCount);
  } finally {
    try { await b.send('Fetch.disable'); } finally { b._on = originalOn; }
  }
}
