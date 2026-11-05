// Six HTTP/1.1 streams must leave room for input, including streams in
// another browser tab. A private nginx speaks HTTP/1.1 to Chromium, so
// this exercises the browser's real per-origin connection limit.
import { until } from '../lib.mjs';
export const meta = {
  about: 'eight panes on HTTP/1.1 echo promptly, including hidden panes and after output recovery',
  ssh: true, local: true, front: 'h1',
};

export async function run({ b, t }) {
  try {
    if (process.env.E2E_CONNECTIONS_NO_SSE === '1')
      await b.ev('window.EventSource = undefined; 1');
    const plan = [[0, 'v'], [0, 'h'], [1, 'h'], [2, 'h'], [3, 'h']];
    await b.connect();
    for (let k = 1; k < 6; k++) {
      const [from, dir] = plan[k - 1];
      const before = await b.ev('Object.keys(panes).length');
      await b.ev(`(() => { splitPane(Object.keys(panes)[${from}], ${JSON.stringify(dir)}); ${b._fill(false)} doConnect(); return 1; })()`);
      await b._ready(before);
    }
    t.ok((await b.state()).length === 6, 'six panes connected');
    const protocol = await b.ev(`performance.getEntriesByType('navigation')[0].nextHopProtocol`);
    t.ok(protocol === 'http/1.1', 'the browser uses HTTP/1.1: ' + protocol);
    const start = Date.now();
    for (let i = 0; i < 6; i++) await b.type(i, `echo Z$((${i}+71))\r`);
    const echoed = async () => {
      const values = await Promise.all(Array.from({ length: 6 }, (_, i) => b.lines(i)));
      return values.map((lines, i) => lines.some(l => l === 'Z' + (i + 71)));
    };
    const result = await until(async () => (await echoed()).every(Boolean), 4000, 50);
    t.ok(result >= 0, `every pane echoes within 4 s (${Date.now() - start} ms); echoed: ${JSON.stringify(await echoed())}`);
    // A new tab gives the seventh terminal enough width to read its
    // prompt. The existing six panes keep their output transports alive.
    const before = await b.ev('Object.keys(panes).length');
    await b.ev(`(() => { newTab(); ${b._fill(false)} doConnect(); return 1; })()`);
    const seventh = await until(async () => (await b.state()).length === 7 && /[$#]\s*$/.test((await b.screen(6)).trimEnd() + ' '), 8000, 100);
    t.ok(seventh >= 0, 'a seventh pane connects while the first six stay alive');
    if (seventh >= 0) {
      await b.type(6, 'echo Z$((99))\r');
      t.ok(await until(async () => (await b.lines(6)).includes('Z99'), 4000, 50) >= 0, 'the seventh pane echoes');
    }
    if (seventh >= 0) {
      await b.ev(`(() => { splitPane(Object.keys(panes)[6], 'h'); ${b._fill(false)} doConnect(); return 1; })()`);
      await b._ready(7);
      const hidden = await b.ev('Object.values(panes).map(p => paneHidden(p))');
      t.ok(hidden.slice(0, 6).every(Boolean) && hidden.slice(6).every(x => !x), 'six original panes hidden, last two on screen');
      t.ok((await b.state()).length === 8, 'an eighth pane connects');
      // The original six panes are now in a hidden websh tab. Their
      // output must keep flowing while the last two are on screen.
      const sendRound = async offset => {
        for (let i = 0; i < 8; i++) await b.type(i, `echo Y$((${i}+${offset}))\r`);
        const got = await until(async () => {
          const lines = await Promise.all(Array.from({ length: 8 }, (_, i) => b.lines(i)));
          return lines.every((a, i) => a.includes('Y' + (i + offset)));
        }, 4000, 50);
        t.ok(got >= 0, `all eight panes echo, including hidden panes (round ${offset}, ${got} ms)`);
      };
      await sendRound(101);
      await b.ev('kickAllOutputs(true); 1');
      await sendRound(201);
    }
    t.ok(before === 6, 'the first six panes survived');
  } finally {
    // Release browser sockets before the runner sends disconnects. This
    // also makes cleanup work on the version with the connection bug.
    await b.ev(`Object.values(panes).forEach(p => { p.polling = false; closeStream(p); abortPoll(p); }); 1`);
  }
}
