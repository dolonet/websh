// Sealed mode in the browser: a second encryption layer under TLS.
//
// Written from the behaviour spec (the owner: "nobody between my browser
// and my server may read, or even partly understand, what I type or
// upload"), not from the code. websh.js runs under jsdom; the server is
// a fake written here that speaks the spec's wire contract with Node's
// WebCrypto: seal_open (ECDH P-256 + ECDSA identity signature), sealed
// frames (AES-256-GCM, HKDF keys, AAD channel:c2s / channel:s2c:2:request_seq:frame_index),
// replies as uint32-length-prefixed frames ending in an empty frame.
// Every request the page makes - fetch, XHR, beacon - is recorded raw,
// so "an observer sees nothing" is checked on the bytes, and every
// sealed request is also decrypted, so "it really went sealed" is too.
//
// What these guard (spec, "What the user sees" and "Client"):
//   - the Options checkbox: default off, persisted, reset turns it off,
//     disabled when the server cannot do it;
//   - with the mode on, nothing but config/ping goes out in clear, and
//     never a silent downgrade to plain requests;
//   - TOFU pin, and a changed server key stops everything behind a modal;
//   - a lost channel can reopen for reads; an uncertain mutation is never
//     resent, and later fresh keys still work;
//   - toggling with open panes loses no key and no output;
//   - the client_diag beacon is not sent while on;
//   - uploads: byte-identical, every piece request the same size, the
//     total rounded up to a size bucket.
//
// Same output format as test_connect.js; scripts/check.sh runs it.

const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');
const nodeCrypto = require('node:crypto');
const {IDBFactory, IDBKeyRange} = require('fake-indexeddb');

const REPO = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(REPO, 'websh.js'), 'utf8');
const subtle = nodeCrypto.webcrypto.subtle;

let passed = 0, failed = 0, current = '(between scenarios)';
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(current + ': ' + msg); console.log('  FAIL: ' + msg); }
}
const {sleep, until, enc, dec, b64, unb64, cat, hex, b64runs, has, SSE_HEADERS, ctypeOf, FakeWebsh, bodyBytes, installTransport, liveEventSource, fakes, EXPOSE, envs, mkEnv, cleanup, $, visible, storageDump, setCheckbox, plainApi, innerActions, PASSWORD, HOST, USER, connect, termText, typeKeys} = require('./sealed_harness');
const scenarios = [];
function test(name, fn) { scenarios.push({name, fn}); }

// ═════════════════════════════════════════════════════════════════════
// The option

test('sealed option: the checkbox exists and is off by default', async () => {
  const env = await mkEnv(); const win = env.win;
  ok(win.settings.sealed === false, 'settings.sealed defaults to false; got ' + JSON.stringify(win.settings.sealed));
  win.openOptions();
  const cb = $(win, 'optSealed');
  ok(!!cb && cb.type === 'checkbox', '#optSealed is a checkbox in Options');
  ok(cb && cb.checked === false, 'unchecked by default');
  ok(cb && !cb.disabled, 'enabled when the server reports the mode available');
  ok(env.srv.wire.every(w => w.action !== 'seal_open' && w.action !== 'sealed'), 'off: no seal_open, nothing sealed');
  cleanup(env);
});

test('sealed option: turned on, it is saved and a reload keeps it', async () => {
  const env = await mkEnv(); const win = env.win;
  win.openOptions();
  setCheckbox(win, $(win, 'optSealed'), true);
  await sleep(30);
  ok(win.settings.sealed === true, 'settings.sealed true after the click');
  let saved = {};
  try { saved = JSON.parse(win.localStorage.getItem('websh_settings') || '{}'); } catch (e) {}
  ok(saved.sealed === true, 'stored with the other display settings (websh_settings.sealed); got ' + JSON.stringify(saved));
  const store = storageDump(win);
  cleanup(env);
  const env2 = await mkEnv({storage: store}); const w2 = env2.win;
  ok(w2.settings.sealed === true, 'after a reload settings.sealed is still true');
  w2.openOptions();
  ok($(w2, 'optSealed').checked === true, 'and the checkbox shows it');
  cleanup(env2);
});

test('sealed option: "Reset to defaults" turns it off', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win;
  win.openOptions();
  ok($(win, 'optSealed').checked === true, 'on before the reset');
  win.resetOptions();
  await sleep(20);
  ok(win.settings.sealed === false, 'settings.sealed false after reset');
  ok($(win, 'optSealed').checked === false, 'checkbox unchecked after reset');
  cleanup(env);
});

test('sealed option: disabled, with the reason, when the server cannot do it', async () => {
  const env = await mkEnv({available: false}); const win = env.win;
  win.openOptions();
  const cb = $(win, 'optSealed');
  ok(cb && cb.disabled === true, 'disabled when config says available:false');
  const dlg = $(win, 'ovOpt');
  ok(/cryptography/.test(dlg ? dlg.textContent : ''), 'the hint names the missing `cryptography` module');
  cleanup(env);
  const env2 = await mkEnv({reportSealed: false}); const w2 = env2.win;
  w2.openOptions();
  ok($(w2, 'optSealed') && $(w2, 'optSealed').disabled === true, 'disabled with a server that does not report the mode at all (older server)');
  cleanup(env2);
});

// ═════════════════════════════════════════════════════════════════════
// Mode on: nothing in clear

test('sealed replies: an earlier connect reply cannot identify a later connection', async () => {
  const env = await mkEnv({sealed: true});
  const {win, srv} = env;
  const exchange = srv.exchange.bind(srv);
  let recorded = null, replaced = false;
  srv.exchange = async (...args) => {
    const out = await exchange(...args);
    const action = new URL(String(args[1]), 'https://websh.test/').searchParams.get('action');
    if (action === 'sealed' && srv.inner.length && srv.inner[srv.inner.length - 1].action === 'connect') {
      if (!recorded) recorded = out.bytes.slice();
      else { replaced = true; return Object.assign({}, out, {bytes: recorded.slice()}); }
    }
    return out;
  };
  try {
    const a = await win.api('connect', {body: {host: 'first.example', username: 'test', password: 'local-only'}});
    let b = null, rejected = false;
    try { b = await win.api('connect', {body: {host: 'second.example', username: 'test', password: 'local-only'}}); }
    catch (e) { rejected = true; }
    ok(replaced && srv.inner.filter(r => r.action === 'connect').length === 2,
       'two distinct requests were executed and only encrypted response bytes were substituted');
    ok(rejected || !b || b.session_id !== a.session_id,
       'the later connection must reject an earlier encrypted reply, not reuse session ' + a.session_id);
  } finally { cleanup(env); }
});

const encryptedEvents = bytes => dec.decode(bytes).match(/data: [^\n]+\n\n/g).map(s => enc.encode(s));
for (const attack of ['duplicate body', 'reorder body', 'missing body', 'old end', 'foreign body']) {
  test('sealed replies: reject ' + attack + ' in a streamed download', async () => {
    const env = await mkEnv({sealed: true});
    const {win, srv} = env;
    srv.files['/before'] = enc.encode('old-body');
    srv.files['/after'] = enc.encode('AAAABBBB');
    srv.replyChunkSize = 4;
    const exchange = srv.exchange.bind(srv);
    let previous = null, mutated = false;
    srv.exchange = async (...args) => {
      const out = await exchange(...args);
      const inner = srv.inner[srv.inner.length - 1];
      if (out.bytes && inner && inner.action === 'download') {
        const frames = encryptedEvents(out.bytes);
        if (!previous) previous = frames;
        else {
          mutated = true;
          if (attack === 'duplicate body') frames.splice(2, 0, frames[1]);
          if (attack === 'reorder body') [frames[1], frames[2]] = [frames[2], frames[1]];
          if (attack === 'missing body') frames.splice(2, 1);
          if (attack === 'old end') frames[frames.length - 1] = previous[previous.length - 1];
          if (attack === 'foreign body') frames[1] = previous[1];
          return Object.assign({}, out, {bytes: cat(...frames)});
        }
      }
      return out;
    };
    try {
      await (await win.sealedFetch('GET', 'download', {path: '/before'})).text();
      let rejected = false;
      try { await (await win.sealedFetch('GET', 'download', {path: '/after'})).text(); }
      catch (e) { rejected = true; }
      ok(mutated, 'only recorded opaque ciphertext frames were changed');
      ok(rejected, 'the authenticated stream must reject ' + attack);
    } finally { cleanup(env); }
  });
}

test('sealed replies: concurrent requests keep their own sequence when answers finish in reverse order', async () => {
  const env = await mkEnv({sealed: true});
  const {win, srv} = env;
  const exchange = srv.exchange.bind(srv);
  const held = [];
  srv.exchange = async (...args) => {
    const out = await exchange(...args);
    if (new URL(String(args[1]), 'https://websh.test/').searchParams.get('action') !== 'sealed') return out;
    return new Promise(resolve => {
      held.push({resolve, out});
      if (held.length === 2) { held[1].resolve(held[1].out); held[0].resolve(held[0].out); }
    });
  };
  try {
    const [a, b] = await Promise.all([
      win.api('connect', {body: {host: 'first.example', username: 'test'}}),
      win.api('connect', {body: {host: 'second.example', username: 'test'}}),
    ]);
    ok(a.session_id && b.session_id && a.session_id !== b.session_id,
       'out-of-order completion still yields the two distinct legitimate sessions');
  } finally { cleanup(env); }
});

test('sealed replies: an upload XHR rejects another request success response', async () => {
  const env = await mkEnv({sealed: true});
  const {win, srv} = env;
  const exchange = srv.exchange.bind(srv);
  let saved = null, substituted = false;
  srv.exchange = async (...args) => {
    const out = await exchange(...args);
    if (args[0] === 'xhr' && out.bytes) {
      if (!saved) saved = out.bytes.slice();
      else { substituted = true; return Object.assign({}, out, {bytes: saved.slice()}); }
    }
    return out;
  };
  const upload = name => new Promise(resolve => {
    const xhr = win.newApiXhr();
    xhr.open('POST', '/api.php?action=upload&path=' + name + '&offset=0');
    xhr.onload = () => resolve({status: xhr.status});
    xhr.onerror = () => resolve({error: true});
    xhr.ontimeout = () => resolve({error: true});
    xhr.timeout = 2000;
    xhr.send(enc.encode('data'));
  });
  try {
    const a = await upload('first');
    const b = await upload('second');
    ok(a.status === 200 && substituted, 'first upload completed and its opaque reply was replayed');
    ok(b.error || b.status !== 200, 'second XHR cannot accept a replayed success');
  } finally { cleanup(env); }
});

for (const status of [410, 409]) {
  test('sealed replies: an upload XHR cannot trust an outer ' + status + ' or resend internally', async () => {
    const env = await mkEnv({sealed: true}); const {win, srv} = env;
    const exchange = srv.exchange.bind(srv);
    let replaced = false;
    srv.exchange = async (...args) => {
      const out = await exchange(...args);
      if (args[0] === 'xhr' && !replaced) {
        replaced = true;
        return {status, bytes: enc.encode('{"error":"offset mismatch","size":4}'), headers: {'Content-Type': 'application/json'}};
      }
      return out;
    };
    try {
      const result = await new Promise(resolve => {
        const xhr = win.newApiXhr();
        xhr.open('POST', '/api.php?action=upload&path=private&offset=0');
        xhr.onload = () => resolve({status: xhr.status, body: xhr.responseText});
        xhr.onerror = () => resolve({error: true});
        xhr.ontimeout = () => resolve({error: true});
        xhr.timeout = 2000;
        xhr.send(enc.encode('data'));
      });
      ok(replaced && srv.inner.filter(r => r.action === 'upload').length === 1, 'upload executes once, without an internal resend');
      ok(result.error || ![200, 409].includes(result.status), 'unverified reply cannot complete or resume from a claimed size');
    } finally { cleanup(env); }
  });
}

test('sealed replies: a forged outer 410 cannot replay already executed input', async () => {
  const env = await mkEnv({sealed: true});
  const {win, srv} = env;
  const connected = await win.api('connect', {body: {host: 'local.example', username: 'test'}});
  const exchange = srv.exchange.bind(srv);
  let replaced = false;
  srv.exchange = async (...args) => {
    const out = await exchange(...args);
    const inner = srv.inner[srv.inner.length - 1];
    if (!replaced && inner && inner.action === 'input') {
      replaced = true;
      return {status: 410, bytes: enc.encode('{"error":"channel unknown"}'), headers: {'Content-Type': 'application/json'}};
    }
    return out;
  };
  try {
    try { await win.api('input', {body: {session_id: connected.session_id, data: 'echo local-test\r'}}); }
    catch (e) { /* Refusing an unauthenticated answer is safe. */ }
    const session = srv.sessions[connected.session_id];
    ok(replaced, 'the real input executed before its encrypted response was replaced');
    ok(session.inputCalls === 1 && session.input === 'echo local-test\r',
       'one submitted command reaches the shell once; executions=' + session.inputCalls);
  } finally { cleanup(env); }
});

test('sealed replies: an older server is refused visibly without a cleartext fallback', async () => {
  const env = await mkEnv({sealed: true});
  const {win, srv} = env;
  srv.wireVersion = 1;
  let error = '';
  try {
    try {
      const response = await win.api('connect', {body: {host: 'private.example', username: 'test'}});
      error = response && response.error || '';
    } catch (e) { error = String(e.message || e); }
    ok(error.length > 0, 'the caller receives an explicit incompatible-channel failure');
    ok(!srv.inner.some(r => r.action === 'connect') && plainApi(srv).length === 0,
       'no connection request is sent through an old channel or in cleartext');
  } finally { cleanup(env); }
});

for (const attack of ['outer 410', 'outer busy 503', 'damaged frame', 'missing end', 'lost reply', 'stalled reply']) {
  test('sealed input queue: ' + attack + ' cannot replay a command or release its queued suffix', async () => {
    const env = await mkEnv({sealed: true});
    const {win, srv} = env;
    const p = await connect(env);
    if (!p) { ok(false, 'fixture connected'); cleanup(env); return; }
    const sid = p.sid;
    if (attack === 'stalled reply') win.INPUT_STALL_MS = 80;
    const exchange = srv.exchange.bind(srv);
    let release, seen;
    const executed = new Promise(resolve => { seen = resolve; });
    let intercepted = false;
    srv.exchange = async (...args) => {
      const start = srv.inner.length;
      const out = await exchange(...args);
      if (!intercepted && srv.inner.slice(start).some(r => r.action === 'input' && dec.decode(r.body).includes('PREFIX'))) {
        intercepted = true;
        seen();
        return new Promise((resolve, reject) => { release = () => {
          if (attack === 'lost reply') { reject(new TypeError('private reply disconnected')); return; }
          if (attack === 'missing end') {
            resolve(Object.assign({}, out, {bytes: enc.encode(encryptedEvents(out.bytes).slice(0, -1).join(''))})); return;
          }
          resolve(attack === 'damaged frame'
            ? Object.assign({}, out, {bytes: enc.encode('data: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n\n')})
            : {status: attack === 'outer 410' ? 410 : 503, bytes: enc.encode('{"error":"busy"}'), headers: {'Content-Type': 'application/json'}});
        }; });
      }
      return out;
    };
    try {
      typeKeys(win, p, 'PREFIX');
      await executed;
      typeKeys(win, p, 'SUFFIX');
      if (attack !== 'stalled reply') release();
      ok(await until(() => !p.inputInFlight && !p.flushTimer, 3000), 'uncertain input settled without hanging');
      ok(/may have completed/i.test(win.document.body.textContent), 'delivery uncertainty is visible');
      typeKeys(win, p, 'FRESH');
      ok(await until(() => srv.sessions[sid].input.includes('FRESH'), 3000), 'fresh typing still reaches the session');
      ok(srv.sessions[sid].input === 'PREFIXFRESH',
         'executed prefix is not replayed and its queued suffix is dropped; got ' + JSON.stringify(srv.sessions[sid].input));
    } finally { if (release) release(); cleanup(env); }
  });
}

test('sealed input queue: a late old-session failure preserves fresh-session queued keys', async () => {
  const env = await mkEnv({sealed: true});
  const {win, srv} = env;
  const p = await connect(env);
  if (!p) { ok(false, 'fixture connected'); cleanup(env); return; }
  const oldSid = p.sid;
  const exchange = srv.exchange.bind(srv);
  let release, seen;
  const executed = new Promise(resolve => { seen = resolve; });
  let intercepted = false;
  srv.exchange = async (...args) => {
    const start = srv.inner.length;
    const out = await exchange(...args);
    if (!intercepted && srv.inner.slice(start).some(r => r.action === 'input' && dec.decode(r.body).includes('OLD'))) {
      intercepted = true;
      seen();
      return new Promise(resolve => { release = () => resolve({status: 503, bytes: enc.encode('{"error":"busy"}'), headers: {'Content-Type': 'application/json'}}); });
    }
    return out;
  };
  try {
    typeKeys(win, p, 'OLD');
    await executed;
    const newSid = srv.newSession();
    p.sid = newSid;
    typeKeys(win, p, 'NEW');
    release();
    ok(await until(() => srv.sessions[newSid].input === 'NEW', 3000), 'new session receives its own queued keys');
    ok(srv.sessions[oldSid].input === 'OLD', 'old session command was executed once');
  } finally { if (release) release(); cleanup(env); }
});

test('sealed on: every API call but config/ping goes sealed; no plain URL or body carries anything', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  ok(!!p, 'connected through the sealed channel');
  if (!p) { cleanup(env); return; }
  const sid = p.sid;
  await until(() => /\$ /.test(termText(p)), 2000);
  ok(/Welcome/.test(termText(p)), 'output arrived; terminal has ' + JSON.stringify(termText(p).slice(-60)));
  typeKeys(win, p, 'echo KEYMARK-1\r');
  ok(await until(() => srv.sessions[sid].input === 'echo KEYMARK-1\r', 2000), 'typed text reached the shell; got ' + JSON.stringify(srv.sessions[sid].input));
  ok(await until(() => /KEYMARK-1/.test(termText(p)), 2000), 'its echo is on screen');
  // file browser, a download, a resize, a disconnect
  srv.files['/home/u/secret-plan-Q7.txt'] = enc.encode('CONTENTMARK');
  try { win.showFileBrowser(p.id); } catch (e) {}
  await until(() => innerActions(srv).includes('ls'), 1000);
  try { await win.startFastDownload(p.id, '/home/u/secret-plan-Q7.txt'); } catch (e) {}
  try { win.flushPaneResize && win.flushPaneResize(p, 100, 30); } catch (e) {}
  await sleep(30);
  const acts = innerActions(srv);
  for (const a of ['connect', 'input', 'ls', 'download'])
    ok(acts.includes(a), a + ' went through the sealed channel; inner actions: ' + [...new Set(acts)].join(','));
  ok(acts.includes('stream') || acts.includes('output'), 'output is read through the sealed channel');
  const plain = plainApi(srv);
  ok(plain.length === 0, 'no plain API request; got ' + plain.map(w => w.action + ' ' + w.url).slice(0, 5).join(' | '));
  for (const w of srv.wire) {
    const u = w.url;
    ok(!u.includes(sid) && !u.includes('secret-plan') && !u.includes('session_id') && !u.includes('HOSTMARK'), 'no secret in a URL: ' + u);
    if (w.action !== 'sealed') {
      for (const n of [sid, PASSWORD, USER, HOST, 'KEYMARK', 'session_id', 'secret-plan'])
        ok(!has(w.body, n), 'clear body of ' + w.action + ' carries "' + n + '"');
    } else {
      // Revision 2: base64 text on the wire - the raw text and every
      // base64 run decoded.
      for (const n of [sid, PASSWORD, USER, 'KEYMARK', 'session_id', '"action"']) {
        ok(!has(w.body, n), 'sealed body carries "' + n + '" in clear');
        ok(!has(b64runs(w.body), n), 'sealed body carries "' + n + '" once its base64 is decoded');
      }
      ok(/^application\/json\b/i.test(w.ctype), 'a sealed request is sent as JSON text; got ' + JSON.stringify(w.ctype));
    }
    if (w.reply && w.action !== 'config' && w.action !== 'ping')
      for (const n of [sid, 'KEYMARK', 'secret-plan', 'CONTENTMARK', 'Welcome']) {
        ok(!has(w.reply, n), 'reply to ' + w.action + ' carries "' + n + '" in clear');
        ok(!has(b64runs(w.reply), n), 'reply to ' + w.action + ' carries "' + n + '" once its base64 is decoded');
      }
  }
  ok(!srv.wire.some(w => /octet-stream/i.test(w.ctype)), 'no application/octet-stream request at all (endpoint security answers those itself)');
  const badge = $(win, 'sealedBadge');
  ok(visible(badge), 'the lock badge is shown while the channel is up');
  ok(badge && (badge.title || '').includes(srv.fp), 'its title shows the fingerprint; got ' + JSON.stringify(badge && badge.title));
  win.openOptions();
  ok(($(win, 'optSealedPin') || {}).textContent && $(win, 'optSealedPin').textContent.includes(srv.fp),
     'Options shows the trusted fingerprint under the checkbox; got ' + JSON.stringify(($(win, 'optSealedPin') || {}).textContent));
  cleanup(env);
});

test('sealed off: the page talks exactly as before (no seal_open, no sealed)', async () => {
  const env = await mkEnv(); const win = env.win, srv = env.srv;
  const p = await connect(env);
  ok(!!p, 'connected plain');
  if (p) { typeKeys(win, p, 'ls\r'); await until(() => srv.sessions[p.sid].input === 'ls\r', 1000); }
  ok(srv.wire.every(w => w.action !== 'seal_open' && w.action !== 'sealed'), 'nothing sealed while off');
  ok(srv.wire.some(w => w.action === 'connect') && srv.wire.some(w => w.action === 'input'), 'plain connect and input as today');
  ok(!visible($(win, 'sealedBadge')), 'no lock badge while off');
  cleanup(env);
});

test('sealed on: when the channel cannot be opened nothing is sent in clear, and the user is told', async () => {
  for (const how of ['neterr', 500, 'unavailable']) {
    const srv = await new FakeWebsh(how === 'unavailable' ? {} : {}).init();
    if (how === 'unavailable') srv.available = false; else srv.sealOpenFail = how;
    if (how === 'unavailable') srv.reportSealed = true;
    const env = await mkEnv({sealed: true, server: srv}); const win = env.win;
    $(win, 'iH').value = HOST; $(win, 'iU').value = USER; $(win, 'iPw').value = PASSWORD;
    $(win, 'iPersistent').checked = false;
    win.doConnect();
    await sleep(400);
    const plain = plainApi(srv);
    ok(plain.length === 0, how + ': no fallback to a plain request; got ' + plain.map(w => w.action).join(','));
    ok(!srv.wire.some(w => has(w.body, PASSWORD) || has(w.body, USER)), how + ': the credentials never left in clear');
    ok(!Object.values(win.panes).some(p => p.sid), how + ': no session');
    ok(!visible($(win, 'sealedBadge')), how + ': no lock badge');
    const text = win.document.body.textContent;
    ok(/encrypt|seal/i.test(text.replace(/Encrypt traffic inside websh/g, '').replace(/a second layer under TLS[^.]*/g, '')),
       how + ': a visible error mentions the encrypted channel');
    cleanup(env);
  }
});

test('sealed on: an open pane whose channel later fails does not fall back to clear', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup: no pane'); cleanup(env); return; }
  await until(() => /\$ /.test(termText(p)), 1000);
  srv.restart(); srv.sealOpenFail = 500;          // server restarted and can no longer seal
  const before = srv.wire.length;
  typeKeys(win, p, 'echo LEAKMARK\r');
  await sleep(600);
  const after = srv.wire.slice(before);
  ok(!after.some(w => !['seal_open', 'sealed', 'config', 'ping'].includes(w.action)), 'no plain request after the failure: ' + after.map(w => w.action).join(','));
  ok(!after.some(w => has(w.body, 'LEAKMARK')), 'typed text never sent in clear');
  ok(!visible($(win, 'sealedBadge')), 'badge gone while the channel is down');
  cleanup(env);
});

// ═════════════════════════════════════════════════════════════════════
// Identity pin

test('sealed pin: first use pins the key; a different key later stops everything behind a modal', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  ok(!!p, 'first use (TOFU) connects');
  const pin1 = win.localStorage.getItem('websh_sealed_pin');
  ok(!!pin1, 'the pin is stored under websh_sealed_pin');
  const store = storageDump(win);
  cleanup(env);

  // Same browser, the server now presents another identity.
  const srv2 = await new FakeWebsh().init();
  const env2 = await mkEnv({storage: store, server: srv2}); const w2 = env2.win;
  $(w2, 'iH').value = HOST; $(w2, 'iU').value = USER; $(w2, 'iPw').value = PASSWORD;
  $(w2, 'iPersistent').checked = false;
  w2.doConnect();
  const modal = () => $(w2, 'ovSealedMismatch');
  ok(await until(() => visible(modal()), 2000), '#ovSealedMismatch is shown');
  const mt = modal() ? modal().textContent : '';
  ok(mt.includes(srv.fp) && mt.includes(srv2.fp), 'it shows the old and the new fingerprint');
  await sleep(100);
  ok(!srv2.wire.some(w => w.action === 'sealed'), 'nothing was sent through the unverified channel');
  ok(plainApi(srv2).length === 0, 'and nothing in clear');
  const btn = re => [...(modal() ? modal().querySelectorAll('button') : [])].find(b => re.test(b.textContent));
  const cancel = btn(/cancel/i), trust = btn(/trust the new key/i);
  ok(!!cancel && !!trust, 'the modal has "Trust the new key" and "Cancel"');
  if (cancel) {
    const code = cancel.getAttribute('onclick');
    if (code) w2.eval('(function(){' + code + '}).call(document.querySelector("#ovSealedMismatch"))'); else cancel.click();
  }
  await sleep(100);
  ok(!visible(modal()), 'Cancel closes the modal');
  ok(w2.settings.sealed === true, 'Cancel leaves the mode on');
  ok(!srv2.wire.some(w => w.action === 'sealed') && plainApi(srv2).length === 0, 'after Cancel: still nothing sent');
  ok(w2.localStorage.getItem('websh_sealed_pin') === pin1, 'the old pin is kept');
  cleanup(env2);

  // Trust the new key: the request goes ahead, the new pin is stored.
  const env3 = await mkEnv({storage: store, server: srv2}); const w3 = env3.win;
  srv2.wire.length = 0; srv2.inner.length = 0;
  $(w3, 'iH').value = HOST; $(w3, 'iU').value = USER; $(w3, 'iPw').value = PASSWORD;
  $(w3, 'iPersistent').checked = false;
  w3.doConnect();
  const m3 = () => $(w3, 'ovSealedMismatch');
  await until(() => visible(m3()), 2000);
  const t3 = [...(m3() ? m3().querySelectorAll('button') : [])].find(b => /trust the new key/i.test(b.textContent));
  if (t3) {
    const code = t3.getAttribute('onclick');
    if (code) w3.eval('(function(){' + code + '}).call(document.querySelector("#ovSealedMismatch"))'); else t3.click();
  }
  ok(await until(() => innerActions(srv2).includes('connect'), 2000), 'after "Trust the new key" the connect goes through, sealed');
  ok(w3.localStorage.getItem('websh_sealed_pin') !== pin1, 'the new key is pinned');
  ok(plainApi(srv2).length === 0, 'nothing in clear');
  cleanup(env3);
});

test('sealed pin: the server key changing under an open pane stops it; no key is sent', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  const sid = p.sid;
  await until(() => /\$ /.test(termText(p)), 1000);
  await srv.newIdentity(); srv.restart();
  typeKeys(win, p, 'echo AFTERMARK\r');
  ok(await until(() => visible($(win, 'ovSealedMismatch')), 2000), 'the mismatch modal comes up');
  await sleep(200);
  ok(!srv.sessions[sid].input.includes('AFTERMARK'), 'the keys did not reach the shell through the unverified key');
  ok(!srv.wire.some(w => has(w.body, 'AFTERMARK')), 'and never went out in clear');
  cleanup(env);
});

// ═════════════════════════════════════════════════════════════════════
// Server restart: 410

test('sealed 410: a read reopens a restarted channel before fresh typing, without doubling keys', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  const sid = p.sid;
  typeKeys(win, p, 'ab');
  await until(() => srv.sessions[sid].input === 'ab', 1000);
  const opens = srv.wire.filter(w => w.action === 'seal_open').length;
  srv.restart();
  await (await win.sealedFetch('GET', 'tmux_capture', {session_id: sid})).text();
  typeKeys(win, p, 'cd');
  ok(await until(() => srv.sessions[sid].input === 'abcd', 2000), 'keys typed after the restart arrive; got ' + JSON.stringify(srv.sessions[sid].input));
  await sleep(150);
  ok(srv.sessions[sid].input === 'abcd', 'exactly once; got ' + JSON.stringify(srv.sessions[sid].input));
  ok(srv.wire.filter(w => w.action === 'seal_open').length === opens + 1, 'one new channel opened');
  ok(plainApi(srv).length === 0, 'nothing in clear');
  ok(await until(() => visible($(win, 'sealedBadge')), 1000), 'badge back');
  cleanup(env);
});

test('sealed 410: a channel that is lost again at once is not retried forever', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  srv.forgetEvery = true;
  const before = srv.wire.length;
  typeKeys(win, p, 'z');
  await sleep(800);
  const inputs410 = srv.wire.slice(before).filter(w => w.action === 'sealed' && w.status === 410).length;
  const opens = srv.wire.slice(before).filter(w => w.action === 'seal_open').length;
  ok(opens <= 6, 'channel reopened a bounded number of times in 0.8 s; got ' + opens);
  ok(inputs410 <= 6, 'no tight resend loop; 410s: ' + inputs410);
  ok(plainApi(srv).filter(w => w.action === 'input').length === 0, 'and never a plain input');
  cleanup(env);
});

// ═════════════════════════════════════════════════════════════════════
// I3 under sealed mode: keys held while the channel is unusable are never
// delivered stale (INPUT_HOLD_MS, 20 s, as for any held keys); a short
// blockage delivers them once, in order.

const HOLD_PAST = 25000;      // past INPUT_HOLD_MS (20 s)

async function sealedPane(o) {
  const env = await mkEnv(Object.assign({sealed: true}, o || {}));
  const p = await connect(env);
  if (p) await until(() => /\$ /.test(termText(p)), 1500);
  return {env, win: env.win, srv: env.srv, p};
}
const shellInput = (srv, p) => (srv.sessions[p.sid] || {input: ''}).input;
function pressInModal(win, re) {
  const m = $(win, 'ovSealedMismatch');
  const b = [...(m ? m.querySelectorAll('button') : [])].find(x => re.test(x.textContent));
  if (!b) return false;
  const code = b.getAttribute('onclick');
  if (code) win.eval('(function(){' + code + '}).call(document.querySelector("#ovSealedMismatch"))'); else b.click();
  return true;
}
// "That much time went by": the page clock jumps, and the input stall
// timer (10 s in real life, so it would have fired) is made to fire now.
async function letTimePass(env, ms) {
  env.win.INPUT_STALL_MS = 50;
  env.skew += ms;
  await sleep(400);
}

test('sealed I3: keys typed behind the key-changed modal, trusted after more than 20 s, never reach the shell', async () => {
  const {env, win, srv, p} = await sealedPane();
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  typeKeys(win, p, 'ok1');
  await until(() => shellInput(srv, p) === 'ok1', 1500);
  await srv.newIdentity(); srv.restart();
  // Discover the changed identity with a read before any command is submitted.
  win.sealedFetch('GET', 'tmux_capture', {session_id: p.sid}).catch(() => {});
  ok(await until(() => visible($(win, 'ovSealedMismatch')), 2000), 'read discovers changed identity');
  typeKeys(win, p, 'rm -rf LATE1\r');
  ok(await until(() => visible($(win, 'ovSealedMismatch')), 2000), 'the modal is up');
  await letTimePass(env, HOLD_PAST);
  ok(pressInModal(win, /trust the new key/i), '"Trust the new key" pressed');
  await sleep(600);
  ok(!shellInput(srv, p).includes('LATE1'), 'the stale keys were not delivered; shell got ' + JSON.stringify(shellInput(srv, p)));
  ok(/not sent/i.test(win.document.body.textContent), 'the user is told the keys were not sent (toast)');
  typeKeys(win, p, 'fresh');
  ok(await until(() => shellInput(srv, p).endsWith('fresh'), 3000), 'typing works after trusting; shell got ' + JSON.stringify(shellInput(srv, p)));
  await sleep(200);
  ok(shellInput(srv, p) === 'ok1fresh', 'exactly the fresh keys, nothing stale before or after them; got ' + JSON.stringify(shellInput(srv, p)));
  cleanup(env);
});

test('sealed I3: keys typed behind the key-changed modal, trusted within a second, arrive once, in order', async () => {
  const {env, win, srv, p} = await sealedPane();
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  await srv.newIdentity(); srv.restart();
  win.sealedFetch('GET', 'tmux_capture', {session_id: p.sid}).catch(() => {});
  ok(await until(() => visible($(win, 'ovSealedMismatch')), 2000), 'read discovers changed identity');
  typeKeys(win, p, 'ab');
  ok(await until(() => visible($(win, 'ovSealedMismatch')), 2000), 'the modal is up');
  typeKeys(win, p, 'cd');
  await sleep(300);
  ok(shellInput(srv, p) === '', 'nothing delivered while the modal is open');
  pressInModal(win, /trust the new key/i);
  ok(await until(() => shellInput(srv, p) === 'abcd', 3000), 'held keys delivered after "Trust"; got ' + JSON.stringify(shellInput(srv, p)));
  typeKeys(win, p, 'ef');
  await until(() => shellInput(srv, p) === 'abcdef', 2000);
  await sleep(200);
  ok(shellInput(srv, p) === 'abcdef', 'once, in order, then later keys; got ' + JSON.stringify(shellInput(srv, p)));
  cleanup(env);
});

test('sealed I3: a channel that cannot be opened for more than 20 s does not deliver the keys typed meanwhile when it is back', async () => {
  const {env, win, srv, p} = await sealedPane();
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  srv.restart(); srv.sealOpenFail = 500;
  // A failed read discovers the lost channel; the following keys are held
  // locally before submission, so retrying them cannot duplicate execution.
  await win.sealedFetch('GET', 'tmux_capture', {session_id: p.sid}).catch(() => {});
  typeKeys(win, p, 'rm -rf LATE2\r');
  await sleep(300);
  await letTimePass(env, HOLD_PAST);
  await sleep(1500);                               // the client's own retries run out meanwhile
  srv.sealOpenFail = null;
  win.INPUT_STALL_MS = 10000;
  typeKeys(win, p, 'new2');
  ok(await until(() => shellInput(srv, p).includes('new2'), 8000), 'typing works once the channel is back; got ' + JSON.stringify(shellInput(srv, p)));
  await sleep(300);
  ok(!shellInput(srv, p).includes('LATE2'), 'the keys typed during the outage were not delivered late; got ' + JSON.stringify(shellInput(srv, p)));
  ok(/not sent/i.test(win.document.body.textContent), 'the user is told the keys were not sent (toast)');
  ok(!srv.wire.some(w => has(w.body, 'LATE2')), 'and never in clear');
  cleanup(env);
});

test('sealed I3: keys with an uncertain 410 reply are not delivered late after recovery', async () => {
  const {env, win, srv, p} = await sealedPane();
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  srv.forgetEvery = true;
  typeKeys(win, p, 'rm -rf LATE3\r');
  await sleep(500);
  await letTimePass(env, HOLD_PAST);
  srv.forgetEvery = false;
  win.INPUT_STALL_MS = 10000;
  typeKeys(win, p, 'new3');
  const t0 = Date.now();
  const gotNew = await until(() => shellInput(srv, p).includes('new3'), 4000);
  ok(gotNew, 'a key typed once the server answers again is delivered (held through the backoff, not dropped); got ' + JSON.stringify(shellInput(srv, p)));
  if (!gotNew) {
    // Does the pane recover at all? Keep typing until something lands.
    let n = 0;
    const back = await until(() => { if (++n % 200 === 0) typeKeys(win, p, 'x'); return shellInput(srv, p).includes('x'); }, 35000);
    ok(back, 'the pane takes keys again at some point');
    console.log('  info: first key accepted ' + Math.round((Date.now() - t0) / 1000) + ' s after the server was healthy again');
  }
  await sleep(300);
  ok(!shellInput(srv, p).includes('LATE3'), 'the keys from the backoff were not delivered late; got ' + JSON.stringify(shellInput(srv, p)));
  ok(shellInput(srv, p) === 'new3', 'only fresh input follows uncertain delivery');
  cleanup(env);
});

test('sealed I3: a short outage (channel down for 0.3 s) delivers the keys typed during it, once, in order', async () => {
  const {env, win, srv, p} = await sealedPane();
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  srv.restart(); srv.sealOpenFail = 500;
  // A failed read discovers the lost channel; the following keys are held
  // locally before submission, so retrying them cannot duplicate execution.
  await win.sealedFetch('GET', 'tmux_capture', {session_id: p.sid}).catch(() => {});
  typeKeys(win, p, 'ab');
  await sleep(100);
  typeKeys(win, p, 'cd');
  setTimeout(() => { srv.sealOpenFail = null; }, 300);
  typeKeys(win, p, 'ef');
  ok(await until(() => shellInput(srv, p) === 'abcdef', 5000), 'all keys arrive in order; got ' + JSON.stringify(shellInput(srv, p)));
  await sleep(300);
  ok(shellInput(srv, p) === 'abcdef', 'exactly once; got ' + JSON.stringify(shellInput(srv, p)));
  cleanup(env);
});

// ═════════════════════════════════════════════════════════════════════
// Toggling with open panes

test('sealed toggle: turning it on (and off) with a pane open loses and doubles no key and no output', async () => {
  const env = await mkEnv(); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  const sid = p.sid;
  await until(() => /\$ /.test(termText(p)), 1000);
  win.openOptions();
  const cb = $(win, 'optSealed');
  let typed = '';
  const typeSome = async (tag, n) => { for (let i = 0; i < n; i++) { const c = tag + i + ' '; typed += c; typeKeys(win, p, c); await sleep(3); } };
  await typeSome('a', 10);
  setCheckbox(win, cb, true);                 // on, mid-typing
  await typeSome('b', 10);
  srv.emit(sid, '\r\nOUTMARK-1\r\n');
  await typeSome('c', 10);
  ok(await until(() => srv.sessions[sid].input === typed, 3000), 'every key arrived, in order, once; got ' + JSON.stringify(srv.sessions[sid].input).slice(0, 200));
  ok(await until(() => /OUTMARK-1/.test(termText(p)), 2000), 'output after the switch is on screen');
  const n1 = (termText(p).match(/OUTMARK-1/g) || []).length;
  ok(n1 === 1, 'and shown once; got ' + n1);
  const nb = srv.wire.length;
  typeKeys(win, p, 'Z'); typed += 'Z';
  await until(() => srv.sessions[sid].input === typed, 2000);
  ok(srv.wire.slice(nb).every(w => ['sealed', 'seal_open'].includes(w.action)), 'after the switch, keys go sealed: ' + srv.wire.slice(nb).map(w => w.action).join(','));
  ok(innerActions(srv).includes('stream') || innerActions(srv).includes('output'), 'the output channel moved to the sealed path');
  // and back off
  setCheckbox(win, cb, false);
  await typeSome('d', 5);
  srv.emit(sid, '\r\nOUTMARK-2\r\n');
  ok(await until(() => srv.sessions[sid].input === typed, 3000), 'keys after switching off arrive once; got ' + JSON.stringify(srv.sessions[sid].input.slice(-40)));
  ok(await until(() => /OUTMARK-2/.test(termText(p)), 2000), 'output after switching off is on screen');
  ok((termText(p).match(/OUTMARK-2/g) || []).length === 1, 'once');
  ok((termText(p).match(/OUTMARK-1/g) || []).length === 1, 'and the earlier output was not replayed twice');
  ok(!visible($(win, 'sealedBadge')), 'badge hidden when off');
  cleanup(env);
});

test('sealed toggle: with SSE in use (a browser), switching on moves the stream to the sealed path, nothing lost or doubled', async () => {
  const env = await mkEnv({eventSource: 'live'}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  const sid = p.sid;
  ok(await until(() => srv.wire.some(w => w.kind === 'eventsource'), 1500), 'plain mode streams over EventSource (control)');
  srv.emit(sid, 'BEFORE-1\r\n');
  ok(await until(() => /BEFORE-1/.test(termText(p)), 1500), 'plain output on screen');
  win.openOptions();
  setCheckbox(win, $(win, 'optSealed'), true);
  srv.emit(sid, 'DURING-2\r\n');
  let typed = '';
  for (let i = 0; i < 20; i++) { typed += 'k' + i + ' '; typeKeys(win, p, 'k' + i + ' '); await sleep(4); }
  srv.emit(sid, 'AFTER-3\r\n');
  ok(await until(() => srv.sessions[sid].input === typed, 3000), 'keys arrive once in order; got ' + JSON.stringify(srv.sessions[sid].input).slice(0, 120));
  ok(await until(() => /AFTER-3/.test(termText(p)), 4000), 'output after the switch on screen');
  for (const m of ['BEFORE-1', 'DURING-2', 'AFTER-3'])
    ok((termText(p).match(new RegExp(m, 'g')) || []).length === 1, m + ' shown exactly once; got ' + (termText(p).match(new RegExp(m, 'g')) || []).length);
  if (process.env.DBG) console.log('DBG', JSON.stringify(srv.inner.filter(r => r.action === 'stream' || r.action === 'output').map(r => r.query)), 'outlen', srv.sessions[sid].out.length, 'cursor', p.outCursor, JSON.stringify(termText(p)));
  ok(await until(() => innerActions(srv).includes('stream'), 2000), 'the output channel is now the sealed stream; inner: ' + [...new Set(innerActions(srv))].join(','));
  const es = srv.wire.filter(w => w.kind === 'eventsource').length;
  srv.emit(sid, 'LATER-4\r\n');
  await until(() => /LATER-4/.test(termText(p)), 2000);
  ok(srv.wire.filter(w => w.kind === 'eventsource').length === es, 'no new plain EventSource while on');
  ok((srv.esInstances || []).every(x => x.readyState === 2), 'the plain EventSource was closed (not left streaming in clear)');
  cleanup(env);
});

// ═════════════════════════════════════════════════════════════════════
// Framing: a cut reply is a dropped connection, not an end

test('sealed framing: a stream cut without the end frame is restarted, not taken as the session ending', async () => {
  const env = await mkEnv({sealed: true, eventSource: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  const sid = p.sid;
  const streamsBefore = () => srv.inner.filter(r => r.action === 'stream' || r.action === 'output').length;
  await until(() => (srv.sseStreams || []).length > 0, 1500);
  ok((srv.sseStreams || []).length > 0, 'the sealed stream is used (fetch streaming); inner actions: ' + [...new Set(innerActions(srv))].join(','));
  const n0 = streamsBefore();
  for (const s of srv.sseStreams || []) s.cut();
  ok(await until(() => streamsBefore() > n0, 6000), 'a new output request follows the cut');
  ok(p.sid === sid, 'same session (not ended, not reconnected)');
  srv.emit(sid, 'AFTERCUT\r\n');
  ok(await until(() => /AFTERCUT/.test(termText(p)), 4000), 'output flows again');
  cleanup(env);
});

test('sealed stream: output already waiting when the stream (re)opens is shown, also when it shares a chunk with the opening frames', async () => {
  for (const mode of ['together', 'split', null]) {
    const env = await mkEnv({sealed: true, eventSource: true}); const win = env.win, srv = env.srv;
    srv.chunking = mode;
    const p = await connect(env);
    if (!p) { ok(false, 'setup'); cleanup(env); continue; }
    const sid = p.sid;
    ok(await until(() => /Welcome/.test(termText(p)), 3000), mode + ': first output shown; got ' + JSON.stringify(termText(p)));
    for (let round = 1; round <= 3; round++) {
      const n0 = srv.inner.filter(r => r.action === 'stream').length;
      for (const st of srv.sseStreams || []) st.cut();
      srv.emit(sid, 'PENDING-' + round + '\r\n');      // waiting when the client reopens
      await until(() => srv.inner.filter(r => r.action === 'stream').length > n0, 6000);
      ok(await until(() => termText(p).includes('PENDING-' + round), 3000), mode + ' round ' + round + ': the waiting output is on screen; screen tail ' + JSON.stringify(termText(p).slice(-60)));
      ok((termText(p).match(new RegExp('PENDING-' + round, 'g')) || []).length <= 1, mode + ': once');
    }
    typeKeys(win, p, 'echo SPLITMARK\r');
    ok(await until(() => /SPLITMARK/.test(termText(p)), 3000), mode + ': typing and echo still work');
    cleanup(env);
  }
});

test('sealed framing: replies split at any byte boundary are read whole (connect, input, ls, download)', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  srv.chunking = 'split';
  const p = await connect(env);
  ok(!!p, 'connect reply read across tiny chunks');
  if (!p) { cleanup(env); return; }
  ok(innerActions(srv).includes('connect'), 'and it was a sealed connect');
  typeKeys(win, p, 'abc');
  ok(await until(() => srv.sessions[p.sid].input === 'abc', 2000), 'input');
  const data = randomBytes(70000);
  srv.files['/home/u/f.bin'] = data;
  let saved = null;
  const origCreate = win.URL.createObjectURL;
  win.URL.createObjectURL = blob => { saved = blob; return 'blob:x'; };
  const res = await win.startFastDownload(p.id, '/home/u/f.bin');
  ok(res === true, 'download finished: ' + res);
  ok(innerActions(srv).includes('download') && innerActions(srv).includes('input'), 'input and download went sealed');
  if (saved) { const got = new Uint8Array(await saved.arrayBuffer()); ok(same(got, data), 'downloaded bytes identical (' + got.length + ' of ' + data.length + ')'); }
  else ok(false, 'download produced no blob');
  win.URL.createObjectURL = origCreate;
  cleanup(env);
});

test('sealed framing: a reply cut without the end frame is a failure, not a success', async () => {
  const env = await mkEnv({sealed: true}); const win = env.win, srv = env.srv;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  // A download whose body is cut before the end frame must not be saved as complete.
  srv.files['/home/u/cut.bin'] = randomBytes(5000);
  srv.hooks.download = req => ({status: 200, headers: {'Content-Type': 'application/octet-stream', 'Content-Length': '5000', 'Content-Disposition': 'attachment; filename="cut.bin"'},
                                body: srv.files['/home/u/cut.bin'].slice(0, 2000), truncate: true});
  let saved = null;
  win.URL.createObjectURL = blob => { saved = blob; return 'blob:x'; };
  const res = await win.startFastDownload(p.id, '/home/u/cut.bin');
  ok(res === false, 'a truncated download is reported as failed; got ' + res);
  ok(!saved, 'and no partial file is handed to the user');
  cleanup(env);
});

test('sealed stream: the session ending (and the stream being closed) throws nothing in the page', async () => {
  const env = await mkEnv({sealed: true, eventSource: true}); const win = env.win, srv = env.srv;
  const errs = [];
  win.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason && (e.reason.name + ' ' + e.reason.message))));
  win.addEventListener('error', e => errs.push('error: ' + (e.error && (e.error.name + ' ' + e.error.message) || e.message)));
  const before = failed;
  const p = await connect(env);
  if (!p) { ok(false, 'setup'); cleanup(env); return; }
  await until(() => (srv.sseStreams || []).length > 0 && /Welcome/.test(termText(p)), 3000);
  // An open stream closed by the page (switching the mode off closes it).
  win.openOptions(); setCheckbox(win, $(win, 'optSealed'), false); setCheckbox(win, $(win, 'optSealed'), true);
  await sleep(300);
  // The shell exits: the server's end event.
  for (const st of srv.sseStreams || []) st.endEvent();
  srv.sessions[p.sid].alive = false;
  await sleep(500);
  ok(errs.length === 0, 'no uncaught error or rejection in the page; got ' + errs.slice(0, 3).join(' | '));
  ok(failed === before, 'and none reached the test runner either');
  cleanup(env);
});

// ═════════════════════════════════════════════════════════════════════
// Beacon

test('sealed on: the client_diag beacon is not sent (it is sent while off)', async () => {
  for (const on of [false, true]) {
    const env = await mkEnv({sealed: on}); const win = env.win, srv = env.srv;
    const p = await connect(env);
    if (!p) { ok(false, 'setup'); cleanup(env); continue; }
    p.paintRecoveries = 1;           // a pane that needed a paint recovery: the beacon's trigger
    win.dispatchEvent(new win.Event('pagehide'));
    await sleep(20);
    if (!on) ok(srv.beacons.length === 1, 'control: off, the beacon goes (proves the trigger); got ' + srv.beacons.length);
    else ok(srv.beacons.length === 0, 'on: no client_diag beacon; got ' + srv.beacons.length);
    cleanup(env);
  }
});

// ═════════════════════════════════════════════════════════════════════
// Upload padding

const KiB = 1024;
function bucket(n) {
  n = Math.max(n, 64 * KiB);
  let best = Infinity;
  for (let k = 0; k < 40; k++) for (const m of [1, 1.25, 1.5, 1.75]) {
    const b = 64 * KiB * Math.pow(2, k) * m;
    if (b >= n && b < best) best = b;
  }
  return best;
}
function randomBytes(n) { return new Uint8Array(nodeCrypto.randomBytes(n)); }

async function sealedUpload(env, data, name) {
  const win = env.win, srv = env.srv;
  const sid = srv.newSession();
  const p = win.createPane(win.document.getElementById('panes'));
  p.sid = sid; p.host = 'h'; p.persistent = true; p.cwd = '/home/u';
  const file = new win.File([data], name);
  const u0 = srv.uploads.length, i0 = srv.inner.length;
  win.handleUpload(p.id, {files: [file], value: ''});
  const banner = () => ((p.el.querySelector('[data-upload-progress] .upload-progress-text') || {}).textContent || '');
  await until(() => /Saved to|Upload complete|Upload failed|Uploaded/i.test(banner()), 20000);
  const pieces = srv.uploads.slice(u0);
  const reqs = srv.inner.slice(i0).filter(r => r.action === 'upload');
  const tmp = pieces.length ? pieces[0].name : null;
  return {p, banner: banner(), pieces, reqs, landed: tmp ? srv.files[tmp] : null};
}
const same = (a, b) => a && b && a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

for (const mode of ['sealed', 'text']) {
  test('upload staging: ' + mode + ' refuses an oversized occupied path without retry or finalize', async () => {
    const env = await mkEnv({sealed: mode === 'sealed', storage: mode === 'text' ? {websh_upload_text: String(Date.now())} : {}});
    const {srv} = env;
    const occupied = enc.encode('a newer immutable upload');
    let calls = 0, finalizes = 0, target;
    srv.hooks.upload = req => {
      calls++; target = req.query.path; srv.files[target] = occupied;
      return {status: 409, headers: {'Content-Type': 'application/json'}, body: enc.encode(JSON.stringify({error: 'offset mismatch', size: occupied.length}))};
    };
    srv.hooks.upload_finalize = () => { finalizes++; };
    try {
      const r = await sealedUpload(env, enc.encode('small'), 'small.bin');
      ok(/failed/i.test(r.banner), 'occupied path fails visibly: ' + r.banner);
      ok(calls === 1 && finalizes === 0, 'no retry or finalize of the occupied path: ' + calls + '/' + finalizes);
      ok(same(srv.files[target], occupied), 'newer staging bytes remain exact');
    } finally { cleanup(env); }
  });
}

test('sealed upload: an authenticated completed-size mismatch still sends padding before finalize', async () => {
  const env = await mkEnv({sealed: true}); const {srv} = env;
  const data = enc.encode('already landed');
  let first = true, pads = 0;
  srv.hooks.upload = req => {
    if (req.header && req.header.pad) { pads++; return; }
    if (!first) return;
    first = false; srv.files[req.query.path] = data;
    return {status: 409, headers: {'Content-Type': 'application/json'}, body: enc.encode(JSON.stringify({error: 'offset mismatch', size: data.length}))};
  };
  try {
    const r = await sealedUpload(env, data, 'landed.bin');
    ok(/Saved to|complete|Uploaded/i.test(r.banner), 'completed bytes finalize successfully');
    ok(pads > 0, 'size mismatch completion still pads the tiny upload');
    ok(same(srv.files['/final/landed.bin'], data), 'final bytes remain exact');
  } finally { cleanup(env); }
});

test('sealed upload: byte-identical, every piece request the same size, total rounded up to a bucket', async () => {
  const env = await mkEnv({sealed: true}); const srv = env.srv;
  for (const size of [1000, 100000, 300 * KiB + 7, 5000000]) {
    const data = randomBytes(size);
    const r = await sealedUpload(env, data, 'secret-plan-' + size + '.bin');
    ok(/Saved to|complete|Uploaded/i.test(r.banner), size + ': upload finished; banner ' + JSON.stringify(r.banner));
    ok(r.reqs.length > 0, size + ': pieces went sealed');
    ok(same(r.landed, data), size + ': the file on the target is byte-identical');
    const wire = [...new Set(r.reqs.map(x => x.wireLen))];
    ok(wire.length === 1, size + ': every piece request has the same size on the wire; sizes ' + wire.join(','));
    const P = r.reqs.length ? r.reqs[0].body.length : 0;
    ok(r.reqs.every(x => x.body.length === P), size + ': every piece carries P bytes of body; ' + [...new Set(r.reqs.map(x => x.body.length))].join(','));
    ok(r.reqs.every(x => typeof x.header.len === 'number'), size + ': each piece header has "len"');
    ok(!srv.wire.some(w => /octet-stream/i.test(w.ctype)), size + ': no piece went as application/octet-stream');
    const real = r.reqs.filter(x => !x.header.pad), pad = r.reqs.filter(x => x.header.pad);
    ok(real.reduce((s, x) => s + x.header.len, 0) === size, size + ': the lens add up to the file size');
    ok(pad.every(x => x.header.len === 0 && x.header.pad === true), size + ': padding pieces are len 0, pad true');
    const firstPad = r.reqs.findIndex(x => x.header.pad);
    ok(firstPad < 0 || r.reqs.slice(firstPad).every(x => x.header.pad), size + ': padding pieces come after the data');
    const T = r.reqs.length * P, B = bucket(size);
    ok(T >= B, size + ': total sent ' + T + ' >= bucket ' + B);
    ok(T <= Math.ceil(B / P) * P + P, size + ': total sent ' + T + ' is the bucket in whole pieces plus at most one extra (B=' + B + ', P=' + P + ')');
    ok(T >= 64 * KiB, size + ': at least 64 KiB in total');
    for (const x of r.reqs) ok(!has(srv.wire.find(w => w.action === 'sealed' && w.body.length === x.wireLen).body, 'secret-plan'), 'name not in clear');
  }
  cleanup(env);
});

test('sealed upload: two files in the same bucket look the same on the wire', async () => {
  const env = await mkEnv({sealed: true});
  const a = await sealedUpload(env, randomBytes(100000), 'a.bin');
  const b = await sealedUpload(env, randomBytes(110000), 'bb.bin');       // both in the 112 KiB bucket
  const sa = [...new Set(a.reqs.map(x => x.wireLen))], sb = [...new Set(b.reqs.map(x => x.wireLen))];
  ok(sa.length === 1 && sb.length === 1 && sa[0] === sb[0], 'same piece request size; ' + sa + ' vs ' + sb);
  ok(Math.abs(a.reqs.length - b.reqs.length) <= 1, 'same count up to the random extra piece; ' + a.reqs.length + ' vs ' + b.reqs.length);
  cleanup(env);
});

test('sealed upload: a piece cut by the network shrinks P, and the new P applies to every later piece', async () => {
  const env = await mkEnv({sealed: true}); const srv = env.srv;
  let cut = 0;
  const realExchange = srv.exchange.bind(srv);
  // The first piece request is cut on the network (no reply).
  srv.exchange = async (kind, url, method, body, ctype) => {
    if (/action=sealed/.test(url) && body.length > 200000 && cut === 0) { cut++; srv.wire.push({kind, url, action: 'sealed', method, body, status: 0}); throw new TypeError('Failed to fetch'); }
    return realExchange(kind, url, method, body, ctype);
  };
  srv.xhrCut = (xhr, b) => { if (/action=sealed/.test(xhr.url) && b.length > 200000 && cut === 0) { cut++; return true; } return false; };
  const data = randomBytes(9 * 1024 * 1024 + 3);
  const r = await sealedUpload(env, data, 'big.bin');
  ok(cut === 1, 'the first piece was cut');
  ok(same(r.landed, data), 'the file is byte-identical despite the cut');
  const sizes = r.reqs.map(x => x.wireLen);
  ok(new Set(sizes).size === 1, 'every piece that reached the server after the shrink has one size; got ' + [...new Set(sizes)].join(','));
  cleanup(env);
});

async function proxyCutUpload(replies) {
  for (const [what, reply] of Object.entries(replies)) {
    const env = await mkEnv({sealed: true}); const srv = env.srv;
    let cuts = 0;
    const realExchange = srv.exchange.bind(srv);
    // A proxy that cuts every request body over 1 MiB.
    const tooBig = n => n > 1024 * 1024;
    srv.exchange = async (kind, url, method, body, ctype) => {
      if (/action=sealed/.test(url) && tooBig(body.length)) { cuts++; srv.wire.push({kind, url, action: 'sealed', method, body, status: reply.status}); return reply; }
      return realExchange(kind, url, method, body, ctype);
    };
    const data = randomBytes(6 * 1024 * 1024 + 11);
    const r = await sealedUpload(env, data, 'proxy.bin');
    ok(cuts >= 1, what + ': the proxy cut at least one piece (' + cuts + ')');
    ok(same(r.landed, data), what + ': the file still lands whole and identical; banner ' + JSON.stringify(r.banner));
    ok(/Saved to|complete|Uploaded/i.test(r.banner), what + ': finished, not failed');
    ok(r.reqs.every(x => x.body.length <= 1024 * 1024), what + ': every piece that got through is under the cut size');
    cleanup(env);
  }
}

test('sealed upload: a body cut by a proxy ("client sent fewer bytes", from nginx or websh) shrinks the piece, the file lands whole (O7b)', async () => {
  await proxyCutUpload({
    'nginx 400 "client sent fewer bytes" (HTML)': {status: 400, bytes: enc.encode('<html><body>400 Bad Request: client sent fewer bytes than Content-Length</body></html>'), headers: {'Content-Type': 'text/html'}},
    'websh 400 "client sent fewer bytes" (JSON)': {status: 400, bytes: enc.encode(JSON.stringify({error: 'client sent fewer bytes than Content-Length'})), headers: {'Content-Type': 'application/json'}},
  });
});

// A cut body that reaches websh looking complete (a middlebox that
// re-chunks and ends the body cleanly) fails decryption: "bad frame".
// For an upload piece that is a truncation like any other. NOT in the
// spec - a decision for the coordinator; see the report.
test('sealed upload: a piece answered "bad frame" (a cut that looked complete) is treated as a cut too (O7b)', async () => {
  await proxyCutUpload({
    'bad frame': {status: 400, bytes: enc.encode(JSON.stringify({error: 'bad frame'})), headers: {'Content-Type': 'application/json'}},
  });
});

// =====================================================================
process.on('unhandledRejection', e => {
  failed++;
  failures.push(current + ': unhandled rejection: ' + (e && e.message || e));
  console.log('  UNHANDLED REJECTION: ' + (e && e.stack || e));
});
(async () => {
  for (const s of scenarios.filter(x => new RegExp(process.env.ONLY || '.').test(x.name))) {
    current = s.name;
    console.log('\n=== ' + s.name + ' ===');
    try { await s.fn(); } catch (e) {
      failed++;
      failures.push(s.name + ': ' + e.message);
      console.log('  THREW: ' + (e.stack || e.message));
    }
  }
  for (const e of envs) try { e.dom.window.close(); } catch (x) {}
  console.log('\n===========================================');
  console.log('  passed: ' + passed + '   failed: ' + failed);
  if (failed) {
    console.log('  failures:');
    failures.forEach(f => console.log('    - ' + f));
  }
  process.exit(failed ? 1 : 0);
})();
