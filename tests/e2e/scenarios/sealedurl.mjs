// Sealed mode against a deployment (scripts/e2e.sh --url https://host/
// sealedurl): one private, non-persistent test session, switched to
// sealed, typed into. Safe against production: it touches only its own
// session, which it ends. Written for the 2026-10-21 production failure
// (every action=sealed request 400/499 at nginx, panes "HTTP 503").
import { sleep, until, tagOf } from '../lib.mjs';
export const meta = { about: 'sealed mode on a deployment: a private test pane switched to sealed keeps working', ssh: true };

export async function run({ b, t }) {
  const reqs = new Map();
  const orig = b._on.bind(b);
  b._on = d => {
    const p = d.params || {};
    if (d.method === 'Network.requestWillBeSent' && /action=seal/.test(p.request.url))
      reqs.set(p.requestId, { url: p.request.url.replace(/.*action=/, ''), at: Date.now(), len: (p.request.postDataEntries || []).reduce((a, e) => a + (e.bytes ? Buffer.from(e.bytes, 'base64').length : 0), 0) });
    if (d.method === 'Network.requestWillBeSentExtraInfo' && reqs.has(p.requestId)) reqs.get(p.requestId).hdr = p.headers;
    if (d.method === 'Network.responseReceived' && reqs.has(p.requestId)) Object.assign(reqs.get(p.requestId), { status: p.response.status, proto: p.response.protocol });
    if (d.method === 'Network.loadingFailed' && reqs.has(p.requestId)) Object.assign(reqs.get(p.requestId), { fail: p.errorText + (p.canceled ? ' canceled' : ''), failAt: Date.now() });
    if (d.method === 'Network.loadingFinished' && reqs.has(p.requestId)) reqs.get(p.requestId).done = Date.now();
    orig(d);
  };
  b.startTrace();
  try {
    const i = await b.connect();
    t.ok(true, 'plain test pane connected');
    if (!(await b.ev('settings.sealed')))
      await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
    const tag = tagOf('U');
    await sleep(1500);
    await b.type(i, `echo ${tag}_$((40+2))\r`);
    const ok = await until(async () => (await b.lines(i)).includes(`${tag}_42`), 15000);
    t.ok(ok >= 0, 'typed text came back sealed' + (ok < 0 ? '; screen: ' + JSON.stringify((await b.lines(i)).filter(Boolean).slice(-3)) : ''));
    const list = [...reqs.values()];
    t0: {
      const base = list.length ? list[0].at : 0;
      for (const r of list.slice(0, 25))
        t.note(`+${r.at - base}ms ${r.url.slice(0, 22)} body=${r.len} -> ${r.status || '-'} ${r.proto || ''} ${r.fail ? 'FAILED ' + r.fail + ' after ' + (r.failAt - r.at) + 'ms' : r.done ? 'done' : 'open'}`);
    }
    t.note('console tail: ' + b.console.slice(-8).join(' | ').slice(0, 1500));
    t.note('trace tail: ' + (b.trace || []).slice(-15).join(' || ').slice(0, 2500));
    t.ok(list.some(r => /^sealed/.test(r.url) && r.status === 200), 'some sealed request got 200');
  } finally { b._on = orig; }
}
