// Output scheduling is promise driven: browsers throttle timers while
// hidden, but receiving one batch must immediately start the next one.
const {FakeWebsh, mkEnv, cleanup, until, enc, termText} = require('./sealed_harness');
let passed = 0, failed = 0;
function ok(value, message) {
  if (value) passed++;
  else { failed++; console.log('  FAIL: ' + message); }
}
function reply(entries, text) {
  return {status: 200, headers: {'Content-Type': 'application/json'},
    body: enc.encode(JSON.stringify({outputs: entries.map(() => ({status: 200,
      payload: {data: Buffer.from(text).toString('base64'), alive: true,
        auth_failed: false, cursor: text.length}}))}))};
}
(async () => {
  const srv = await new FakeWebsh().init();
  const baseConfig = srv.config.bind(srv);
  srv.config = () => Object.assign(baseConfig(), {output_batch: true});
  const arrivals = [];
  srv.hooks.output_many = req => new Promise(resolve => {
    arrivals.push({entries: JSON.parse(new TextDecoder().decode(req.body)).sessions, resolve});
  });
  const env = await mkEnv({server: srv});
  const win = env.win;
  const timers = win.setTimeout;
  const panes = [];
  try {
    console.log('\n=== output batch: coalesces and continues without browser timers, cancellation is per pane ===');
    // No browser timer will run now, as when a hidden page is heavily
    // throttled. Node's test timeout helpers remain independent.
    win.setTimeout = () => 1;
    for (let i = 0; i < 2; i++) {
      const p = win.createPane(win.document.getElementById('panes'));
      p.sid = srv.newSession(); p.polling = true;
      panes.push(p); win.startOutput(p);
    }
    ok(await until(() => arrivals.length === 1, 1000), 'first request starts without a timer');
    if (!arrivals.length) return;
    ok(arrivals[0].entries.length === 2, 'both pane requests coalesce in the same batch');
    const [cancelled, active] = panes;
    cancelled.polling = false;
    win.abortPoll(cancelled);
    arrivals[0].resolve(reply(arrivals[0].entries, 'obsolete'));
    ok(await until(() => arrivals.length === 2, 1000), 'cancellation restarts the remaining waiter without a timer');
    if (arrivals[1]) {
      ok(arrivals[1].entries.length === 1 && arrivals[1].entries[0].session_id === active.sid,
        'only the still-active pane is polled again');
      arrivals[1].resolve(reply(arrivals[1].entries, 'first'));
      ok(await until(() => termText(active).includes('first'), 1000), 'cancelling one pane leaves delivery to the other intact');
      ok(!termText(cancelled).includes('obsolete'), 'cancelled pane does not receive its obsolete result');
      ok(await until(() => arrivals.length === 3, 1000), 'the following request starts immediately without a timer');
      if (arrivals[2]) {
        arrivals[2].resolve(reply(arrivals[2].entries, 'first-next'));
        ok(await until(() => termText(active).includes('-next'), 1000), 'output keeps flowing in the following batch');
      }
    }
  } catch (error) { ok(false, error.stack || error.message); }
  finally {
    win.setTimeout = timers;
    for (const p of panes) { p.polling = false; win.abortPoll(p); }
    for (const a of arrivals) a.resolve(reply(a.entries, ''));
    cleanup(env);
    console.log('\n===========================================');
    console.log('  passed: ' + passed + '   failed: ' + failed);
    setTimeout(() => process.exit(failed ? 1 : 0), 350);
  }
})();
