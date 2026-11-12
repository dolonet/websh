// websh.js — frontend logic for websh terminal

// ── Storage isolation ──────────────────────────────────────────────
// When isolate_storage is enabled, saved connections are scoped to the URL path
// so multiple websh instances on the same origin don't share connections.
let storagePrefix = '';
function storageKey(name) { return storagePrefix + name; }

// ── Helpers ─────────────────────────────────────────────────────────
function $(id){ return document.getElementById(id) }
// Markup for one icon from the sprite in index.html. Kept in one place
// so dynamically built buttons (pane bar, search bar, file rows) use the
// same set as the static markup instead of ad-hoc emoji/glyphs.
function ic(name){ return '<svg class="ic"><use href="#i-' + name + '"></use></svg>' }
function icEl(name){
  const SVG = 'http://www.w3.org/2000/svg';
  let svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ic');
  let use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}
// HTML-escape for BOTH text and attribute context. The old
// textContent->innerHTML trick only covered & < > - a remote filename
// containing a double quote could then close an attribute and add its
// own (onmouseover=...) when esc() output was interpolated into one.
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}

const API = location.pathname.replace(/\/[^/]*$/, '') + '/api.php';
function api(action, opts) {
  opts = opts || {};
  if (action === 'output' && outputBatchAvailable()) return batchOutput(opts);
  let url = `${API}?action=${action}${opts.query || ''}`;
  let init = {};
  if (opts.body) { init.method='POST'; init.body=JSON.stringify(opts.body); init.headers={'Content-Type':'application/json'} }
  if (opts.signal) init.signal = opts.signal;
  // A non-JSON reply (a reverse proxy's own HTML error page for a 5xx,
  // a captive portal) used to surface as "Unexpected token <" in the
  // toast. Turn it into an {error} the callers already handle.
  // The status rides along as a non-enumerable `_status`, so callers
  // that must tell "the session is gone" (404) from "the server or a
  // proxy hiccuped" (503 busy, 502/504, 429) can - an {error} alone
  // can't say which.
  return apiFetch(url, init).then(r => r.json().catch(e => {
    if (e && e.sealedDeliveryUnknown) throw e;
    return {error: 'HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '') +
                   ' (unexpected reply from the server or a proxy)'};
  })
    .then(j => {
      if (j && typeof j === 'object') {
        try { Object.defineProperty(j, '_status', {value: r.status}); } catch (e) {}
      }
      return j;
    }));
}

// An /api/output reply that says nothing about the session itself: the
// worker pool was full (503 busy), a proxy failed (502/504, often an
// HTML page), a rate limit, a conflict with a stream still being torn
// down (409). Retry those on the SAME session. Only a real answer about
// the session (404 "session not found", or a normal frame) may end it -
// treating a transient 503 as "gone" opened a fresh shell and orphaned
// the old one with whatever was running in it.
function isTransientOutputReply(r) {
  let st = r && r._status;
  if (!r || !r.error || !st) return false;
  return st === 408 || st === 409 || st === 425 || st === 429 || st >= 500;
}

// Capacity/rate errors are identified by a machine-readable `code`
// (servers before it only sent prose, so the text match stays as the
// fallback).
const CAP_CODES = ['rate_limited', 'session_cap_per_ip',
                   'session_cap_background', 'session_cap_global'];
function isCapacityError(r, msg) {
  if (r && CAP_CODES.indexOf(r.code) >= 0) return true;
  return /too many (connection attempts|active sessions|background sessions)/i.test(msg || '');
}

// ── Sealed channel ─────────────────────────────────────────────────
// "Encrypt traffic inside websh" (settings.sealed, off by default): a
// second layer under TLS for networks that read HTTPS (a corporate root
// CA, DPI). Off, nothing here runs and every request is exactly what it
// was. On, every API call except config and ping goes as ONE AES-GCM
// frame to ?action=sealed&c=<channel> (as JSON {"f": base64}), carrying
// the real method, action, query and body; the reply comes back as
// text/event-stream, one `data: <base64 frame>` event per frame, read as
// it arrives, so the output stream and downloads still stream. Text on
// both legs: an HTTPS-intercepting security product refused binary
// (application/octet-stream) POSTs outright. Wire contract: docs/protocol.md "Sealed channel".
//
// The decision is made per call, at the boundary: apiFetch() for fetch,
// openEventSource() for the output stream, newApiXhr() for uploads. The
// call sites keep their own logic - retries, stall detection, cursors -
// and see a normal Response / EventSource / XHR.
//
// Never a silent downgrade: while the setting is on, a call that cannot
// be sealed (no channel, the server cannot seal, the key changed and was
// not trusted) is answered by a local 503 {error, code:"sealed_unavailable"}
// that was never sent anywhere - so the input queue resends it (I2: the
// reply proves the keys did not reach the PTY), the output loops retry
// inside their budget and then show the failure, connect shows the text.
// It is never sent in plain form instead.
const SEALED_PLAIN_ACTIONS = {config: 1, ping: 1};
const SEALED_WIRE_VERSION = 2;
const SEALED_PIN_KEY = 'websh_sealed_pin';
const SEALED_RETRY_MS = 2000;     // a failed open is not retried sooner
let _seal = null;                 // the open channel: {id, kc, ks, aadC, aadS, seq, fp}
let _sealOpening = null;          // Promise while a channel is being opened
let _sealFailAt = 0, _sealFailMsg = '';
let _sealRefused = null;          // {old, fresh}: a changed key the user did not trust
let _sealToastAt = 0;
let _sealLost = 0;                // 410s in a row that a fresh channel did not cure
// Input's stall timer needs to distinguish an unsent handshake wait
// from a request already handed to fetch. Weak keys need no teardown.
const _sealSentRequests = new WeakMap();
// Made on first use: a page that never seals needs none of this.
let _sealEncoder = null;
const _sealEnc = {encode: s => (_sealEncoder || (_sealEncoder = new TextEncoder())).encode(s)};

function sealedOn() { return !!(settings && settings.sealed); }

// stream.cancel() / reader.cancel() return a promise that rejects when
// the stream already failed (an aborted fetch): closing must never
// surface as an unhandled rejection in the page.
function _quietCancel(x) {
  try {
    let pr = x && x.cancel && x.cancel();
    if (pr && pr.catch) pr.catch(() => {});
  } catch (e) {}
}

function _sealErr(msg) { let e = new Error(msg); e.sealed = true; return e; }

function _u8cat() {
  let n = 0;
  for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
  let out = new Uint8Array(n), o = 0;
  for (let i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
  return out;
}
// Base64 in pieces of 24 KiB (a multiple of 3, so the pieces join into
// one valid string): no argument list or binary string the size of a
// multi-MB upload piece.
function _b64enc(u8) {
  let out = [];
  for (let i = 0; i < u8.length; i += 0x6000) {
    out.push(btoa(String.fromCharCode.apply(null, u8.subarray(i, i + 0x6000))));
  }
  return out.join('');
}
function _b64dec(str) {
  let s = atob(String(str || '')), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

function sealedPin() {
  try { return localStorage.getItem(storageKey(SEALED_PIN_KEY)) || ''; } catch (e) { return ''; }
}
function _sealedPinSet(fp) {
  try { localStorage.setItem(storageKey(SEALED_PIN_KEY), fp); } catch (e) {}
}

// SHA-256 of the identity key's SPKI DER, uppercase hex in groups of 4:
// the same text the server prints at start ("sealed channel: identity").
async function sealedFingerprint(der) {
  let h = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  let hex = Array.from(h, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{4}/g).join(' ');
}

function sealedServerAvailable() {
  // Unknown until /api/config answered: then try, the server says 501.
  if (!serverConfig) return true;
  return !!(serverConfig.sealed && serverConfig.sealed.available);
}

// Pending answer of the "server key has changed" dialog.
let _sealedMismatchResolve = null;
let _sealedMismatchTrap = null;
function askSealedMismatch(oldFp, newFp) {
  if (!_sealedMismatchTrap) {
    _sealedMismatchTrap = makeModalTrap('ovSealedMismatch', () => sealedMismatchAnswer(false));
  }
  return new Promise(resolve => {
    _sealedMismatchResolve = resolve;
    $('sealedOldFp').textContent = oldFp;
    $('sealedNewFp').textContent = newFp;
    _sealedMismatchTrap.open(() => $('sealedCancelBtn'));
  });
}
function sealedMismatchAnswer(trust) {
  if (_sealedMismatchTrap) _sealedMismatchTrap.close();
  let r = _sealedMismatchResolve;
  _sealedMismatchResolve = null;
  if (r) r(!!trust);
}

// Handshake: ephemeral ECDH, the reply's signature checked with the
// identity key it carries, that key checked against the pin - all
// before the channel is used for anything.
async function _sealOpenChannel() {
  let subtle = (typeof crypto !== 'undefined') && crypto.subtle;
  if (!subtle) throw _sealErr('this browser offers no Web Crypto here (the page needs HTTPS)');
  if (!sealedServerAvailable()) throw _sealErr('the server cannot encrypt (no cryptography module)');
  if (_sealRefused) throw _sealErr('the server key changed and was not trusted');
  let kp = await subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveBits']);
  let cpub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  let r;
  try {
    r = await fetch(`${API}?action=seal_open`, {method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({wire: SEALED_WIRE_VERSION, pub: _b64enc(cpub)})});
  } catch (e) { throw _sealErr('the server cannot be reached'); }
  let j = await r.json().catch(() => null);
  if (!r.ok || !j || typeof j.channel !== 'string' || !/^[0-9a-f]{32}$/.test(j.channel)) {
    throw _sealErr((j && typeof j.error === 'string' ? j.error : 'HTTP ' + r.status) +
                   ' (opening the encrypted channel)');
  }
  if (j.wire !== SEALED_WIRE_VERSION) {
    throw _sealErr('encrypted traffic requires matching server and client versions; update websh and reload this page');
  }
  let spub = _b64dec(j.pub), idDer = _b64dec(j.identity), sig = _b64dec(j.sig);
  let ok = false;
  try {
    let idKey = await subtle.importKey('spki', idDer, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
    ok = await subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, idKey, sig,
                             _u8cat(cpub, spub, _sealEnc.encode(j.channel + ':sealed:' + SEALED_WIRE_VERSION)));
  } catch (e) { ok = false; }
  if (!ok) throw _sealErr('the server’s signature does not verify');
  let fp = await sealedFingerprint(idDer);
  let pin = sealedPin();
  if (pin && pin !== fp) {
    if (!await askSealedMismatch(pin, fp)) {
      _sealRefused = {old: pin, fresh: fp};
      throw _sealErr('the server key changed and was not trusted');
    }
  }
  if (pin !== fp) _sealedPinSet(fp);
  let srv = await subtle.importKey('raw', spub, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  let bits = await subtle.deriveBits({name: 'ECDH', public: srv}, kp.privateKey, 256);
  let hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  let salt = _u8cat(cpub, spub);
  let dk = info => subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: salt, info: _sealEnc.encode(info)},
                                    hk, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  return {id: j.channel, kc: await dk('websh sealed c2s'), ks: await dk('websh sealed s2c'),
          aadC: _sealEnc.encode(j.channel + ':c2s'), aadS: _sealEnc.encode(j.channel + ':s2c'),
          seq: 0, fp: fp};
}

// The channel, opened lazily by the first sealed call and shared by
// every pane of the page.
function sealChannel() {
  if (_seal) return Promise.resolve(_seal);
  if (_sealOpening) return _sealOpening;
  if (Date.now() - _sealFailAt < _sealBackoffMs()) return Promise.reject(_sealErr(_sealFailMsg));
  _sealOpening = _sealOpenChannel().then(ch => {
    _sealOpening = null;
    _seal = ch;
    _sealFailAt = 0;
    renderSealedState();
    return ch;
  }, e => {
    _sealOpening = null;
    _sealFailAt = Date.now();
    _sealFailMsg = (e && e.message) || String(e);
    renderSealedState();
    let now = Date.now();
    if (now - _sealToastAt > 15000) {
      _sealToastAt = now;
      showToast('Encrypted traffic: ' + _sealFailMsg + '. Nothing was sent unencrypted.', 'err');
    }
    throw (e && e.sealed) ? e : _sealErr(_sealFailMsg);
  });
  return _sealOpening;
}

// How long a failed open (or a channel the server forgot again at once)
// keeps further calls local: 2 s, doubling per repeat up to 8 s - well
// under INPUT_HOLD_MS, so keys held through an outage still go out once
// the server answers again.
function _sealBackoffMs() {
  return Math.min(8000, SEALED_RETRY_MS * Math.pow(2, Math.max(0, _sealLost - 1)));
}

// Milliseconds until a sealed call may try the network again (0: now).
function _sealWaitMs() {
  if (_seal || _sealOpening || !sealedOn()) return 0;
  let w = _sealFailAt + _sealBackoffMs() - Date.now();
  return w > 0 ? w : 0;
}

// The server forgot a channel that was opened a moment ago: a restart
// loop, or channels dropped faster than they are used. Resending again
// would only repeat it - fail the call (locally, as an open failure)
// and back off.
function _sealLostAgain() {
  _sealLost++;
  _sealFailAt = Date.now();
  _sealFailMsg = 'the server keeps losing the encrypted channel';
  _seal = null;
  renderSealedState();
  return _sealErr(_sealFailMsg);
}

function _sealUnavailableResponse(e) {
  return new Response(JSON.stringify({
    error: 'encrypted traffic: ' + ((e && e.message) || 'channel unavailable'),
    code: 'sealed_unavailable'}),
    {status: 503, headers: {'Content-Type': 'application/json'}});
}

function _sealReplyError(ch, mutation, context) {
  if (context && context.error) return context.error;
  if (_seal === ch) { _seal = null; renderSealedState(); }
  let message = 'Encrypted reply could not be verified.';
  if (mutation) message += ' The request may have completed. Check the result before trying again.';
  let e = new TypeError(message);
  if (mutation) {
    e.sealedDeliveryUnknown = true;
    showToast(message, 'warn');
  }
  if (context) context.error = e;
  return e;
}

// Room for the header line of a padded (upload) request: the header is
// space-filled to this length, so a piece's size on the wire does not
// change with the digits of its offset or with "pad": true.
const SEALED_HEADER_ROOM = 1024;

async function _sealFrame(ch, hdr, body, padHeader) {
  let head = _sealEnc.encode(JSON.stringify(hdr));
  if (padHeader && head.length < SEALED_HEADER_ROOM - 1) {
    let room = new Uint8Array(SEALED_HEADER_ROOM - 1).fill(0x20);
    room.set(head, 0);
    head = room;
  }
  let pt = _u8cat(head, new Uint8Array([0x0a]), body);
  let iv = crypto.getRandomValues(new Uint8Array(12));
  let ct = new Uint8Array(await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: iv, additionalData: ch.aadC}, ch.kc, pt));
  return _u8cat(iv, ct);
}

// Reads the reply's frames - one SSE event `data: <base64(frame)>` each
// (text, not binary: an HTTPS-intercepting security product on the
// owner's machine refused application/octet-stream outright) - from a
// byte source, as they arrive, and decrypts them. `pull()` gives the
// next chunk of bytes or null at the end.
function _sealFrameReader(ch, pull, cancel, requestSeq) {
  let dec = new TextDecoder();
  let text = '', scanned = 0, eof = false;
  let frameIndex = 0;
  // The next complete event's data, or null at the end of the bytes.
  async function nextEvent() {
    for (;;) {
      let m = /\r?\n\r?\n/g;
      m.lastIndex = Math.max(0, scanned - 3);
      let hit = m.exec(text);
      if (hit) {
        let ev = text.slice(0, hit.index);
        text = text.slice(hit.index + hit[0].length);
        scanned = 0;
        let data = [];
        ev.split(/\r?\n/).forEach(line => {
          if (line.indexOf('data:') === 0) data.push(line.slice(line[5] === ' ' ? 6 : 5));
        });
        if (data.length) return data.join('');
        continue;          // a comment or an empty event
      }
      scanned = text.length;
      if (eof) {
        if (text.trim()) throw new TypeError('encrypted reply cut short');
        return null;
      }
      let v = await pull();
      if (v === null) { eof = true; text += dec.decode(); }
      else if (v.length) text += dec.decode(v, {stream: true});
    }
  }
  return {
    // The next plaintext, or null when the bytes ended between frames.
    next: async () => {
      let b = await nextEvent();
      if (b === null) return null;
      let f;
      try { f = _b64dec(b); } catch (e) { throw new TypeError('bad encrypted frame'); }
      if (f.length < 28) throw new TypeError('bad encrypted frame');
      // A page shares its channel among requests. Capture the request's
      // seq, never ch.seq (which other requests advance), and bind each
      // header/body/end frame to its exact position in this response.
      let aad = _u8cat(ch.aadS, _sealEnc.encode(':' + SEALED_WIRE_VERSION + ':' + requestSeq + ':' + frameIndex));
      let plain = await crypto.subtle.decrypt(
        {name: 'AES-GCM', iv: f.subarray(0, 12), additionalData: aad}, ch.ks, f.subarray(12));
      frameIndex++;
      return new Uint8Array(plain);
    },
    cancel: () => { try { cancel && cancel(); } catch (e) {} }
  };
}

function _sealReaderOf(ch, raw, requestSeq) {
  let reader = raw.body && raw.body.getReader ? raw.body.getReader() : null;
  if (reader) {
    return _sealFrameReader(ch, async () => {
      let x = await reader.read();
      return x.done ? null : x.value;
    }, () => _quietCancel(reader), requestSeq);
  }
  // No streaming body in this browser: the whole reply at once.
  let whole = raw.arrayBuffer().then(b => new Uint8Array(b));
  whole.catch(() => {});
  let given = false;
  return _sealFrameReader(ch, async () => {
    if (given) return null;
    given = true;
    return await whole;
  }, null, requestSeq);
}

// A sealed reply as a normal Response: the inner status and headers,
// and a body that yields each frame as it is decrypted. Without the
// empty end frame the body errors, as a cut connection would.
async function _sealResponse(ch, raw, requestSeq, failure) {
  let rd = _sealReaderOf(ch, raw, requestSeq);
  let fail = e => { rd.cancel(); return failure ? failure() : e; };
  let read = async () => { try { return await rd.next(); } catch (e) { throw fail(e); } };
  let head = await read();
  if (head === null || !head.length) throw fail(new TypeError('encrypted reply cut short'));
  let h;
  try { h = JSON.parse(new TextDecoder().decode(head)); }
  catch (e) { throw fail(e); }
  let status = h && h.status | 0;
  if (!(status >= 200 && status <= 599)) throw fail(new TypeError('bad encrypted reply'));
  let headers = new Headers();
  let hh = (h && h.headers) || {};
  Object.keys(hh).forEach(k => { try { headers.set(k, String(hh[k])); } catch (e) {} });
  if (status === 204 || status === 205 || status === 304) {
    let end = await read();
    if (end === null || end.length) throw fail(new TypeError('encrypted reply cut short'));
    rd.cancel();
    return new Response(null, {status: status, headers: headers});
  }
  let body = new ReadableStream({
    pull: async ctl => {
      let p;
      try { p = await read(); } catch (e) { ctl.error(e); return; }
      if (p === null) { ctl.error(fail(new TypeError('encrypted reply cut short'))); return; }
      if (!p.length) { ctl.close(); return; }
      ctl.enqueue(p);
    },
    cancel: () => rd.cancel()
  });
  return new Response(body, {status: status, headers: headers});
}

// Only authenticated inner replies describe an API outcome. An outer
// 410/503 can be forged after execution: renew for future requests, but
// never resend a mutation or expose an unverified busy/restarting code.
// GET and the explicitly read-only POST output_many may reopen and retry.
async function sealedFetch(method, action, query, body, opts) {
  opts = opts || {};
  // output_many uses POST only to carry the cursor list. No other POST
  // is granted read-only recovery or cancellation semantics.
  let readOnlyBatch = method === 'POST' && action === 'output_many';
  let asked = Date.now();
  for (let attempt = 0; ; attempt++) {
    let ch;
    try { ch = await sealChannel(); }
    catch (e) { return _sealUnavailableResponse(e); }
    // The channel can take long to come (the "key changed" dialog left
    // open, a slow open): a call its caller gave up on meanwhile is not
    // sent, and keys are never delivered late (I3: held keys are never
    // older than INPUT_HOLD_MS) - they are dropped, and the user told.
    if (opts.signal && opts.signal.aborted) {
      if (action === 'input') showToast('Keys typed while the encrypted channel was unavailable were not sent.', 'warn');
      throw new DOMException('aborted', 'AbortError');
    }
    if (action === 'input' && Date.now() - asked > INPUT_HOLD_MS) {
      showToast('Keys typed while the encrypted channel was unavailable were not sent.', 'warn');
      return new Response(JSON.stringify({error: 'encrypted traffic: keys too old to send',
                                          code: 'sealed_stale'}),
                          {status: 408, headers: {'Content-Type': 'application/json'}});
    }
    let hdr = Object.assign({seq: ++ch.seq, method: method, action: action, query: query || {}},
                            opts.extra || {});
    let frame = await _sealFrame(ch, hdr, body || new Uint8Array(0));
    let mutation = method !== 'GET' && !readOnlyBatch;
    let context = {ch: ch, error: null};
    let replyError = () => {
      // Joining/leaving panes rebuilds the batch routinely. Cancelling
      // that read must not invalidate a healthy shared encrypted channel.
      if (readOnlyBatch && opts.signal && opts.signal.aborted)
        return new DOMException('aborted', 'AbortError');
      return _sealReplyError(ch, mutation, context);
    };
    if (mutation && opts.signal) _sealSentRequests.set(opts.signal, context);
    let r;
    try {
      r = await fetch(`${API}?action=sealed&c=${ch.id}`, {method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: '{"f":"' + _b64enc(frame) + '"}', signal: opts.signal});
    } catch (e) { throw replyError(); }
    if (readOnlyBatch && opts.signal && opts.signal.aborted) {
      _quietCancel(r.body);
      throw replyError();
    }
    if (r.status === 410 && !mutation) {
      if (attempt > 0) return _sealUnavailableResponse(_sealLostAgain());
      if (_seal === ch) { _seal = null; renderSealedState(); }
      continue;
    }
    if (r.status !== 200) {
      _quietCancel(r.body);
      throw replyError();
    }
    _sealLost = 0;
    return await _sealResponse(ch, r, hdr.seq, replyError);
  }
}

async function _sealBodyBytes(b) {
  if (b === undefined || b === null) return new Uint8Array(0);
  if (typeof b === 'string') return _sealEnc.encode(b);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (typeof Blob !== 'undefined' && b instanceof Blob) return new Uint8Array(await b.arrayBuffer());
  return _sealEnc.encode(String(b));
}

// fetch() for every API URL (`${API}?action=...`): plain while the
// setting is off, sealed while it is on.
function apiFetch(url, init) {
  if (!sealedOn()) return fetch(url, init);
  let u = new URL(url, location.href);
  let action = u.searchParams.get('action') || '';
  if (SEALED_PLAIN_ACTIONS[action]) return fetch(url, init);
  let query = {};
  u.searchParams.forEach((v, k) => { if (k !== 'action') query[k] = v; });
  init = init || {};
  let method = String(init.method || 'GET').toUpperCase();
  return _sealBodyBytes(init.body).then(b =>
    sealedFetch(method, action, query, b, {signal: init.signal}));
}

// The output stream read over a sealed request: the EventSource surface
// websh uses (addEventListener, onerror/onopen/onmessage, readyState,
// close) with its behaviour - a dropped or ended connection is retried
// after ~3 s from the id of the last event (Last-Event-ID semantics,
// sent as since=), a non-200 reply closes it for good (readyState 2).
function SealedEventSource(url) {
  this.url = url;
  this.readyState = 0;
  this.onopen = this.onerror = this.onmessage = null;
  this._l = {};
  this._ctl = null;
  this._lastId = null;
  this._retryMs = 3000;
  this._timer = null;
  this._connect();
}
SealedEventSource.prototype.addEventListener = function (t, fn) {
  (this._l[t] = this._l[t] || []).push(fn);
};
SealedEventSource.prototype.removeEventListener = function (t, fn) {
  let a = this._l[t]; if (!a) return;
  let i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
};
SealedEventSource.prototype._fire = function (type, ev) {
  ev.type = type;
  ev.target = this;
  let run = fn => { try { fn.call(this, ev); } catch (e) { setTimeout(() => { throw e; }); } };
  (this._l[type] || []).slice().forEach(run);
  let h = (type === 'open' || type === 'error' || type === 'message') ? this['on' + type] : null;
  if (typeof h === 'function') run(h);
};
SealedEventSource.prototype.close = function () {
  this.readyState = 2;
  clearTimeout(this._timer);
  if (this._ctl) { try { this._ctl.abort(); } catch (e) {} this._ctl = null; }
};
SealedEventSource.prototype._connect = function () {
  if (this.readyState === 2) return;
  let u = new URL(this.url, location.href);
  if (this._lastId !== null && this._lastId !== '') u.searchParams.set('since', this._lastId);
  let ctl = this._ctl = new AbortController();
  let mine = () => this._ctl === ctl && this.readyState !== 2;
  apiFetch(u.toString(), {signal: ctl.signal}).then(r => {
    if (!mine()) { _quietCancel(r.body); return; }
    let ct = (r.headers.get('Content-Type') || '').toLowerCase();
    if (r.status !== 200 || ct.indexOf('text/event-stream') !== 0 || !r.body) {
      _quietCancel(r.body);
      this.readyState = 2;
      this._ctl = null;
      this._fire('error', {});
      return;
    }
    this.readyState = 1;
    this._fire('open', {});
    return this._read(r.body.getReader(), mine);
  }).then(() => {
    if (mine()) this._dropped();        // the stream ended: reconnect
  }, () => {
    if (mine()) this._dropped();        // network error: reconnect
  });
};
SealedEventSource.prototype._dropped = function () {
  this.readyState = 0;
  this._ctl = null;
  this._fire('error', {});
  if (this.readyState === 2) return;    // a listener closed it
  clearTimeout(this._timer);
  this._timer = setTimeout(() => this._connect(), this._retryMs);
};
SealedEventSource.prototype._read = async function (reader, mine) {
  let dec = new TextDecoder();
  let text = '', ev = '', data = [], hasData = false;
  for (;;) {
    let x = await reader.read();
    if (!mine()) { _quietCancel(reader); return; }
    if (x.done) return;
    text += dec.decode(x.value, {stream: true});
    let m;
    while ((m = /\r\n|\r|\n/.exec(text)) !== null) {
      // A lone \r at the very end may be the first half of \r\n.
      if (m[0] === '\r' && m.index === text.length - 1) break;
      let line = text.slice(0, m.index);
      text = text.slice(m.index + m[0].length);
      if (line === '') {
        if (hasData) {
          this._fire(ev || 'message', {data: data.join('\n'), lastEventId: this._lastId || ''});
          if (!mine()) { _quietCancel(reader); return; }
        }
        ev = ''; data = []; hasData = false;
        continue;
      }
      if (line[0] === ':') continue;
      let c = line.indexOf(':');
      let field = c < 0 ? line : line.slice(0, c);
      let val = c < 0 ? '' : line.slice(c + 1);
      if (val[0] === ' ') val = val.slice(1);
      if (field === 'event') ev = val;
      else if (field === 'data') { data.push(val); hasData = true; }
      else if (field === 'id') { if (val.indexOf('\0') < 0) this._lastId = val; }
      else if (field === 'retry') { if (/^\d+$/.test(val)) this._retryMs = parseInt(val, 10); }
    }
  }
};

// EventSource for the output stream (`${API}?action=stream&...`).
function openEventSource(url) {
  return sealedOn() ? new SealedEventSource(url) : new EventSource(url);
}

// ── Sealed uploads: same-size pieces ────────────────────────────────
// What crosses the network must not tell a file's size. Within one
// file every piece is padded to the same size P = min(piece size, T),
// where T is the file's size rounded up to a bucket (64 KiB x 2^k x
// {1, 1.25, 1.5, 1.75}, at least 64 KiB); after the real data, pad-only
// pieces ("pad": true, nothing written) are sent until T is covered,
// plus one more half of the time. Two files in the same bucket look
// the same on the wire (up to that extra piece). "len" in the header
// tells the server how many bytes of the piece are real.
function sealedUploadBucket(size) {
  let base = 64 * 1024;
  if (size <= base) return base;
  let p = base;
  while (p * 2 < size) p *= 2;     // p < size <= 2p
  for (let f of [1.25, 1.5, 1.75, 2]) {
    if (p * f >= size) return Math.ceil(p * f);
  }
  return p * 2;
}

// An XMLHttpRequest look-alike for one sealed upload request: open() /
// setRequestHeader() / send(blob) / abort(), timeout, upload.onprogress,
// onload / onerror / ontimeout, status and responseText. The real XHR
// underneath carries the frame (so upload progress events stay real);
// progress is reported in real bytes of this piece. `pad` = {to, pad}:
// pad the body to `to` bytes, or send a pad-only piece.
function SealedXhr(pad) {
  this._pad = pad || null;
  this.status = 0;
  this.responseText = '';
  this.readyState = 0;
  this.timeout = 0;
  this.upload = {onprogress: null};
  this.onload = this.onerror = this.ontimeout = this.onabort = null;
  this._x = null;
  this._aborted = false;
}
SealedXhr.prototype.open = function (method, url) { this._method = method; this._url = url; this.readyState = 1; };
SealedXhr.prototype.setRequestHeader = function () {};
SealedXhr.prototype.abort = function () {
  this._aborted = true;
  if (this._x) { try { this._x.abort(); } catch (e) {} }
};
SealedXhr.prototype._finish = function (status, text) {
  if (this._aborted) return;
  this.status = status;
  this.responseText = text;
  this.readyState = 4;
  if (this.onload) this.onload();
};
SealedXhr.prototype._fail = function (kind) {
  if (this._aborted) return;
  this.status = 0;
  this.readyState = 4;
  let h = kind === 'timeout' ? this.ontimeout : this.onerror;
  if (h) h();
};
SealedXhr.prototype.send = function (blob) {
  let u = new URL(this._url, location.href);
  let action = u.searchParams.get('action') || '';
  let query = {};
  u.searchParams.forEach((v, k) => { if (k !== 'action') query[k] = v; });
  let pad = this._pad;
  let deadline = this.timeout > 0 ? Date.now() + this.timeout : 0;
  let go = async () => {
    let real = await _sealBodyBytes(blob);
    if (pad && pad.pad) real = new Uint8Array(0);
    let body = real, extra = {};
    if (pad) {
      let to = Math.max(pad.to || 0, real.length);
      body = new Uint8Array(to);
      body.set(real, 0);
      // getRandomValues fills at most 64 KiB per call.
      for (let o = real.length; o < to; o += 65536) {
        crypto.getRandomValues(body.subarray(o, Math.min(to, o + 65536)));
      }
      extra.len = real.length;
      if (pad.pad) extra.pad = true;
    }
    for (;;) {
      if (this._aborted) return;
      let ch;
      try { ch = await sealChannel(); }
      catch (e) {
        this._finish(503, JSON.stringify({error: 'encrypted traffic: ' + e.message, code: 'sealed_unavailable'}));
        return;
      }
      let hdr = Object.assign({seq: ++ch.seq, method: String(this._method || 'POST').toUpperCase(),
                               action: action, query: query}, extra);
      let wire = '{"f":"' + _b64enc(await _sealFrame(ch, hdr, body, !!pad)) + '"}';
      if (this._aborted) return;
      let res = await new Promise(resolve => {
        let x = this._x = new XMLHttpRequest();
        x.open('POST', `${API}?action=sealed&c=${ch.id}`, true);
        x.setRequestHeader('Content-Type', 'application/json');
        if (deadline) x.timeout = Math.max(1, deadline - Date.now());
        x.upload.onprogress = e => {
          if (!this.upload.onprogress || !e.total) return;
          let loaded = Math.floor(real.length * Math.min(1, e.loaded / e.total));
          this.upload.onprogress({loaded: loaded, total: real.length, lengthComputable: true});
        };
        x.onload = () => resolve({x: x});
        x.onerror = () => resolve({fail: 'error'});
        x.ontimeout = () => resolve({fail: 'timeout'});
        x.onabort = () => resolve({fail: 'abort'});
        x.send(wire);
      });
      if (this._aborted || res.fail === 'abort') return;
      if (res.fail) { this._fail(res.fail); return; }
      let x = res.x;
      if (x.status === 200) _sealLost = 0;
      if (x.status !== 200) {
        if (_seal === ch) { _seal = null; renderSealedState(); }
        // This is unverified transport metadata, never an API result:
        // a forged 409 size could otherwise finalize an incomplete file.
        // Keep only cut/size signals needed by the safe positional upload
        // retry layer. It, not this wrapper, decides whether to retry.
        let t = x.responseText || '';
        if (x.status === 413) {
          this._finish(413, JSON.stringify({error: 'Encrypted upload request is too large.'}));
        } else if (x.status === 400 && /client sent fewer bytes than Content-Length/.test(t)) {
          this._finish(400, JSON.stringify({error: 'client sent fewer bytes than Content-Length'}));
        } else if (x.status === 499) {
          this._finish(499, JSON.stringify({error: 'encrypted upload connection closed'}));
        } else this._fail('error');
        return;
      }
      try {
        let resp = await _sealResponse(ch, new Response(x.responseText || ''), hdr.seq,
                                       () => _sealReplyError(ch, false));
        let t = await resp.text();
        this._finish(resp.status, t);
      } catch (e) { this._fail('error'); }
      return;
    }
  };
  go().catch(() => this._fail('error'));
};

// XMLHttpRequest for an upload request: plain while the setting is off.
function newApiXhr(pad) {
  return sealedOn() ? new SealedXhr(pad) : new XMLHttpRequest();
}

// ── Sealed mode: badge and option ───────────────────────────────
// Badge, pinned fingerprint and checkbox state.
function renderSealedState() {
  let on = sealedOn();
  let b = $('sealedBadge');
  if (b) {
    let up = on && !!_seal;
    b.classList.toggle('h', !up);
    b.title = up ? 'Traffic is encrypted inside websh. Server key: ' + _seal.fp : '';
  }
  let cb = $('optSealed');
  if (cb) {
    cb.checked = on;
    // Unavailable on this server: cannot be turned on, but a setting
    // that is already on can always be turned off.
    cb.disabled = !sealedServerAvailable() && !on;
  }
  let hint = $('optSealedHint');
  if (hint) {
    hint.textContent = sealedServerAvailable()
      ? 'A second layer under TLS, for networks that inspect HTTPS.'
      : 'Unavailable: the server has no cryptography module.';
  }
  let pinRow = $('optSealedPinRow'), pinEl = $('optSealedPin');
  if (pinRow && pinEl) {
    let pin = sealedPin();
    pinRow.classList.toggle('h', !on);
    pinEl.textContent = pin || 'none yet (trusted on first use)';
  }
}

// The checkbox: takes effect at once. Every output channel restarts
// through the new path from its cursor (nothing lost or shown twice);
// a request already in flight finishes the way it was sent.
function setSealed(on) {
  settings.sealed = !!on;
  saveSettings();
  _sealRefused = null;
  _sealFailAt = 0;
  renderSealedState();
  kickAllOutputs(true);
}

// ── Pane management ─────────────────────────────────────────────────
const panes = {};
let activeId = null;
let paneCounter = 0;
let connectingFor = null; // pane ID the overlay is connecting for
// CURSOR_HIDE — drag-selection cursor-hide machinery
// ----------------------------------------------------------------
// During a drag-selection in tmux (mouse-on), xterm's cursor bar/blink
// would paint over the cell at the trailing edge of tmux's yellow
// selection — a stray "dim symbol after the orange". We blur xterm on
// left-mousedown (combined with `cursorInactiveStyle:'none'`, see
// createPane) so the cursor cell renders glyph-only for the duration
// of the drag, then defer term.focus() until tmux moves the cursor
// back to the prompt (`onCursorMove`) or 500 ms have elapsed.
// State lives per-pane on `p` (_dragBlurred, _selDisp, _selTimer,
// _dragStartX/Y, _dragMoved). The two coupled sites (mousedown blur,
// document mouseup deferred restore) are tagged `CURSOR_HIDE:` so they
// can't drift apart.
const POST_DRAG_HIDE_FALLBACK_MS = 500; // for non-tmux sessions where the
                                        // cursor never moves on its own.
function _cancelDragBlurArm(p) {
  if (!p) return;
  if (p._selDisp) { try { p._selDisp.dispose(); } catch(e){} p._selDisp = null; }
  if (p._selTimer) { clearTimeout(p._selTimer); p._selTimer = null; }
}
function _restorePaneFromDrag(p) {
  if (!p) return;
  _cancelDragBlurArm(p);
  p._dragBlurred = false;
  try { p.term && p.term.focus(); } catch(e){}
}
// overlayMode tracks why the login form is open:
//   'initial' — no panes yet (fresh app, last pane closed). Modal.
//   'split'   — user clicked split. Dismissable; dismiss is a no-op
//               before materialize, undoes the split after.
//   'tab'     — user clicked "+" (newTab). Dismissable the same way;
//               the new tab is created only on a successful connect.
//   null      — form not driving a new-pane flow (e.g. not shown).
// A pane is only added to the DOM on successful connect (materialize step),
// so dismissing before connect cleanly leaves the layout untouched.
let overlayMode = null;
let pendingSplit = null; // {fromId, dir} while overlayMode==='split' pre-materialize
let serverConfig = null;
// ── Terminal display settings (size / line-height / weight / font) ─
const SETTINGS_KEY = 'websh_settings';
const DEFAULT_SETTINGS = {
  fontSize: 14, lineHeight: 1.0, fontWeight: 400, font: 'jetbrains-mono',
  // tmux options sent on /api/connect when persistent. tmux mouse mode
  // is no longer user-configurable — the server hardcodes `set -g mouse
  // on` so wheel-scroll-history and click-in-vim work out of the box
  // without ever needing to toggle in /options.
  tmuxClipboard: true, tmuxHistory: 100000,
  // File-browser sort. Newest-first by default: the reason to open the
  // browser is usually a file that was just written, and alphabetical
  // order buries it. 'name' | 'size' | 'mtime'; dir -1 = descending.
  fbSort: 'mtime', fbSortDir: -1,
  // Dotfiles hidden by default, as in every file manager and `ls`.
  fbShowHidden: false,
  // Ctrl+V pastes instead of sending ^V. See _ctrlVShouldPaste().
  ctrlVPaste: true,
  // "Encrypt traffic inside websh" (see "Sealed channel"). Off: every
  // request is exactly what it was before the option existed.
  sealed: false
};
// id → [label, webfont-name-or-null, fallback-stack, google-weights]
// webfont-name is the family loaded via Google Fonts; null = system
// only. google-weights mirrors what the old static <link> requested
// per family (they differ — Fira Code has no 100/200, Inconsolata no
// 100/500) so every weight the options panel offers stays a real face.
const FONTS = {
  'jetbrains-mono': ['JetBrains Mono', 'JetBrains Mono', "'Menlo','Monaco','Consolas',monospace", '100;200;300;400;500;700'],
  'fira-code':      ['Fira Code',      'Fira Code',      "'Menlo','Monaco','Consolas',monospace", '300;400;500;700'],
  'ibm-plex-mono':  ['IBM Plex Mono',  'IBM Plex Mono',  "'Menlo','Monaco','Consolas',monospace", '100;200;300;400;500;700'],
  'roboto-mono':    ['Roboto Mono',    'Roboto Mono',    "'Menlo','Monaco','Consolas',monospace", '100;200;300;400;500;700'],
  'source-code-pro':['Source Code Pro','Source Code Pro',"'Menlo','Monaco','Consolas',monospace", '200;300;400;500;700'],
  'inconsolata':    ['Inconsolata',    'Inconsolata',    "'Menlo','Monaco','Consolas',monospace", '200;300;400;700'],
  'system':         ['System default', null,             "ui-monospace,'Menlo','Monaco','SF Mono','Cascadia Code','Consolas',monospace", null]
};
function fontStack(id) {
  let f = FONTS[id] || FONTS[DEFAULT_SETTINGS.font];
  return (f[1] ? `'${f[1]}',` : '') + f[2];
}

// Load the ACTIVE font family only. The old static <link> pulled the
// css2 descriptors for all six families on every page load; now one
// <link id="dynFontCss"> tracks settings.font (boot + options change).
// While the css loads, the fallback stack renders and the fit-settle
// loop (fitPaneWhenStable) absorbs the swap — same flow as before.
function ensureFontLink(id) {
  let f = FONTS[id] || FONTS[DEFAULT_SETTINGS.font];
  let link = $('dynFontCss');
  if (!f[1]) {                 // system font: nothing to fetch
    if (link) link.remove();
    return;
  }
  let href = 'https://fonts.googleapis.com/css2?family=' +
             f[1].replace(/ /g, '+') + ':wght@' + f[3] + '&display=swap';
  if (link && link.getAttribute('href') === href) return;
  if (!link) {
    link = document.createElement('link');
    link.id = 'dynFontCss';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

// True when this key event is a Ctrl+V that should paste rather than
// send ^V. Deliberately narrow: only a plain Ctrl+V keydown, and only
// where ^V is not already the better binding.
function _ctrlVShouldPaste(e) {
  if (!settings.ctrlVPaste) return false;
  if (e.type !== 'keydown') return false;
  // Ctrl alone. Ctrl+Shift+V already pastes natively (xterm ignores it),
  // and Ctrl+Alt+V / AltGr must keep their own meaning.
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  // macOS pastes with Cmd+V, which needs nothing from us; there Ctrl+V
  // stays what it is on every Mac terminal - quoted-insert.
  if (_isMacLike()) return false;
  // e.code is layout-independent (a Cyrillic or Dvorak layout still
  // reports KeyV for the physical V); e.key covers browsers without it.
  return e.code === 'KeyV' || e.key === 'v' || e.key === 'V';
}

function _isMacLike() {
  let n = typeof navigator === 'object' && navigator ? navigator : {};
  let s = (n.userAgentData && n.userAgentData.platform) || n.platform ||
          n.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(s);
}

// Copy `text` to the system clipboard. Yandex Browser silently rejects
// navigator.clipboard.writeText() outside a tightly-scoped user gesture,
// which is also where xterm's built-in OSC 52 handler falls over. We
// run the synchronous document.execCommand('copy') path first so the
// copy lands inside the post-mouseup "transient user activation" window
// (~5 s in Chromium); writeText() runs after as a best-effort upgrade
// for browsers where it's permitted.
function copyText(text) {
  if (!text) return Promise.resolve(false);
  let handled = false;
  let listener = e => {
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      handled = true;
    }
  };
  let copied = false;
  document.addEventListener('copy', listener, true);
  try { copied = document.execCommand('copy') === true && handled; } catch (e) {}
  document.removeEventListener('copy', listener, true);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { return navigator.clipboard.writeText(text).then(() => true, () => copied); }
    catch (e) {}
  }
  return Promise.resolve(copied);
}

let settings = loadSettings();
// Legacy alias: the rest of the code reads `fontSize` directly.
let fontSize = settings.fontSize;
function loadSettings() {
  try {
    let s = JSON.parse(localStorage.getItem(storageKey(SETTINGS_KEY)) || '{}');
    return { ...DEFAULT_SETTINGS, ...s };
  } catch(e) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { localStorage.setItem(storageKey(SETTINGS_KEY), JSON.stringify(settings)); } catch(e) {}
}
// How long the transport (SSE or long-poll) is allowed to stay broken
// before we surface the red banner. Until this elapses the failure is
// retried silently with exponential backoff so brief Wi-Fi blips don't
// startle the user. Wall-clock budget, not retry count.
const RECONNECT_BUDGET_MS = 60000;
// Backoff steps used for both SSE retry-after and long-poll retry.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 15000];
// If SSE doesn't deliver any event within this window, assume an
// upstream proxy is buffering it and fall back to /api/output
// long-polling (unless the timer fired late or offline: then it proved
// nothing and the stream is simply restarted).
const SSE_FIRST_MSG_TIMEOUT_MS = 5000;
// A stream refused or dropped before its first event (409 while the old
// stream still holds the slot, 503 busy, a backend restart, a network
// blip) says nothing about whether SSE works here. Only this many in a
// row turn it off for the pane. Long-poll is never for good: the pane
// keeps probing the stream NEXT TO its poll loop (maybeProbeSse) - after
// SSE_RETRY_MS, doubling to SSE_RETRY_MAX_MS on each failed probe - and
// switches back once an event has actually arrived. A probe costs no
// output, so a path that buffers SSE is probed too.
const SSE_EARLY_FAIL_LIMIT = 3;
let SSE_RETRY_MS = 120000;
const SSE_RETRY_MAX_MS = 1800000;
// A connection that died without a FIN (Wi-Fi switched, laptop slept, a
// NAT forgot it) raises no error in the browser: the stream stays "open"
// and silent, a long-poll never answers - keys went out, nothing came
// back, until the page was reloaded. Three independent detectors restart
// the output channel (from the pane's cursor, so nothing is lost or
// doubled):
//  - the server sends a `ping` event every 15 s; a stream silent for
//    SSE_STALL_MS is dead;
//  - every /api/input reply says where the session's output stands; a
//    pane still behind it OUTPUT_LAG_MS later is not receiving;
//  - the browser says the network came back (`online`), or the page's
//    own clock jumped (it was asleep or frozen).
let SSE_STALL_MS = 40000;
let POLL_STALL_MS = 25000;      // server answers a long-poll within 10 s
let OUTPUT_LAG_MS = 2000;
let KICK_MIN_GAP_MS = 3000;

function disableSse(p, reason) {
  p.sseDisabled = true;
  p.sseDisabledReason = reason;
  p.sseDisabledAt = Date.now();
}
// Hard cap on a single download (bytes). Server enforces this too via
// MAX_DOWNLOAD_SIZE, but the client also bails early so a misconfigured
// or trusted-but-misbehaving server can't OOM the tab. 2 GB matches the
// upload limit and modern browsers' Blob ceilings.
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
// The server caps the JSON request body at MAX_BODY_SIZE (8 MB). A huge
// terminal paste is sent via /api/input; refuse one that would exceed the
// cap and tell the user, rather than letting the POST 400 and vanish.
const MAX_INPUT_BODY = 8 * 1024 * 1024;
let authMode = 'pw';

// ── Themes ──────────────────────────────────────────────────────────
// One table drives every color surface: the CSS custom properties on
// :root (the same literals ship in index.html so there is no unstyled
// flash before this script runs), xterm's per-pane theme object, and
// the scrollback-search decoration colors. A new theme is one more
// entry here; applyTheme() repaints live panes in place.
const THEMES = {
  dark: {
    css: {
      bg:'#0d1117', sf:'#161b22', bd:'#30363d', tx:'#e6edf3',
      dim:'#8b949e', ac:'#58a6ff', ach:'#79c0ff', dg:'#f85149',
      ok:'#3fb950', wn:'#d29922',
      // Options-panel preview swatches, derived from the terminal
      // palette (red / brightYellow / a dimmed foreground).
      'preview-red':'#ff7b72', 'preview-yel':'#e3b341',
      'preview-dim':'#7d8590',
    },
    xterm: {
      background:'#0d1117',foreground:'#e6edf3',cursor:'#58a6ff',cursorAccent:'#0d1117',
      selectionBackground:'rgba(88,166,255,0.3)',
      black:'#484f58',red:'#ff7b72',green:'#3fb950',yellow:'#d29922',
      blue:'#58a6ff',magenta:'#bc8cff',cyan:'#39d353',white:'#b1bac4',
      brightBlack:'#6e7681',brightRed:'#ffa198',brightGreen:'#56d364',
      brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',
      brightCyan:'#56d364',brightWhite:'#f0f6fc'
    },
    search: {
      matchBackground: '#264f78',
      matchBorder: '#3a6fa5',
      matchOverviewRuler: '#58a6ff',
      activeMatchBackground: '#a07b00',
      activeMatchBorder: '#d29922',
      activeMatchColorOverviewRuler: '#d29922',
    },
  },
};
let currentTheme = 'dark';

function themeXterm() {
  return (THEMES[currentTheme] || THEMES.dark).xterm;
}

function applyTheme(name) {
  let t = THEMES[name] || THEMES.dark;
  currentTheme = THEMES[name] ? name : 'dark';
  let root = document.documentElement.style;
  Object.keys(t.css).forEach(k => root.setProperty('--' + k, t.css[k]));
  // Live panes: xterm repaints when options.theme is reassigned.
  Object.keys(panes).forEach(id => {
    let term = panes[id].term;
    if (term && term.options) term.options.theme = t.xterm;
  });
  SEARCH_OPTS.decorations = Object.assign({}, t.search);
}

// Links in the terminal. Two kinds reach a click: plain-text URLs found
// by WebLinksAddon, and OSC 8 hyperlinks a program prints (Claude Code,
// `ls --hyperlink`, gcc: `ESC]8;;URL ESC\ text ESC]8;; ESC\`), which
// xterm.js hands to the Terminal's `linkHandler`. Without one, xterm
// answers every OSC 8 click with a confirm() "WARNING" dialog and never
// shows where the link goes - and the text of such a link can differ
// from its target. So: hovering shows the real target (as text, never
// HTML), and a click opens it the way plain URLs open (new tab, opener
// cut) - but only http(s). A program on the remote host chooses the
// target, so javascript:, data:, file: and the rest open nothing.
// Invariant O7 in docs/invariants.md. How a link looks at rest (no
// underline xterm adds): dropImplicitLinkUnderline, invariant O8.
function openLinkSafely(uri) {
  let u;
  try { u = new URL(String(uri)); } catch (e) { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  // Same as WebLinksAddon's own handler: open blank, cut the opener,
  // then navigate - noopener in window.open's features would make it
  // return null and lose the tab on some browsers.
  let w = window.open();
  if (!w) return;
  try { w.opener = null; } catch (e) {}
  w.location.href = u.href;
}

// What the tooltip shows is chosen by the remote program, so it is
// made safe to read: control and bidi-override characters (which can
// reorder or hide text) become U+FFFD, and the host that will really
// open - parsed, as the browser sees it, punycode included - comes
// first, on its own line, and wraps rather than being cut; the full
// URL under it may be truncated. Otherwise `https://github.com:xxx…@evil/`
// shows as "https://github.com:xxx…" and the real host is cut off.
function _linkTipText(s) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, '\ufffd');
}
let _linkTip = null, _linkTipOwner = null, _linkTipWatch = null;
function showLinkTip(ev, uri, term) {
  if (!_linkTip) {
    _linkTip = document.createElement('div');
    _linkTip.className = 'link-tip';
    _linkTip.style.cssText = 'position:fixed;z-index:1000;max-width:60vw;' +
      'display:none;' +
      'padding:3px 8px;border-radius:4px;border:1px solid var(--bd);' +
      'background:var(--sf);color:var(--tx);font-size:12px;' +
      'font-family:ui-monospace,Menlo,monospace;' +
      'pointer-events:none';
    let host = document.createElement('b');
    host.className = 'link-tip-host';
    host.style.cssText = 'display:block;white-space:normal;word-break:break-all';
    let full = document.createElement('span');
    full.className = 'link-tip-url';
    full.style.cssText = 'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dim)';
    _linkTip.appendChild(host); _linkTip.appendChild(full);
    document.body.appendChild(_linkTip);
  }
  let host = '';
  try { host = new URL(String(uri)).host; } catch (e) {}
  _linkTip.firstChild.textContent = _linkTipText(host);
  _linkTip.firstChild.style.display = host ? 'block' : 'none';
  _linkTip.lastChild.textContent = _linkTipText(uri);
  let x = (ev && ev.clientX) || 0, y = (ev && ev.clientY) || 0;
  _linkTip.style.left = Math.max(4, Math.min(x + 12, window.innerWidth - 300)) + 'px';
  _linkTip.style.top = (y + 18 > window.innerHeight - 24 ? y - 26 : y + 18) + 'px';
  _linkTip.style.display = 'block';
  // xterm sends no `leave` when its pane is closed, hidden with its tab
  // or disposed while hovered, so the box would stay with a dead link.
  // Pane close / dispose hides it at once (see createPane); this watch
  // covers every other way the hovered terminal disappears.
  _linkTipOwner = term || null;
  if (!_linkTipWatch) _linkTipWatch = setInterval(() => {
    let o = _linkTipOwner && _linkTipOwner.element;
    if (!o || !o.isConnected || !o.getClientRects().length) hideLinkTip();
  }, 200);
}
function hideLinkTip() {
  // Emptied as well as hidden: a dead link's target is not left in the
  // page for anything that reads its text.
  if (_linkTip) {
    _linkTip.style.display = 'none';
    _linkTip.firstChild.textContent = '';
    _linkTip.lastChild.textContent = '';
  }
  _linkTipOwner = null;
  if (_linkTipWatch) { clearInterval(_linkTipWatch); _linkTipWatch = null; }
}

function termLinkHandler(getTerm) {
  return {
    activate: (ev, uri) => openLinkSafely(uri),
    hover: (ev, uri) => showLinkTip(ev, uri, getTerm()),
    leave: () => hideLinkTip(),
    allowNonHttpProtocols: false,
  };
}

// A link at rest looks the way the program printed it (invariant O8:
// the owner wants no underline under links, their colour is enough).
// xterm.js 5.5 draws one anyway: its ExtendedAttrs `underlineStyle`
// getter answers 5 (dashed) whenever the cell carries an OSC 8 link id,
// so `isUnderline()` is true for every link cell and the DOM renderer
// gives it `xterm-underline-5` - and a program's own SGR 4 / 4:3 on
// link text comes out dashed too. There is no option for it. Hiding the
// `xterm-underline-5` class would also hide a program's own SGR 4:5 on
// plain text, so instead the getter itself is replaced, once, on the
// shared prototype: it answers the style the program set (the same bits
// the original reads), ignoring the link id. The prototype is reached
// through the public API (`buffer.getNullCell().extended`), not by a
// name or offset inside the bundle; and the swap happens only if the
// getter still behaves as described (link id -> 5) - a later xterm that
// fixed this, or changed the class, is left alone. The hover underline,
// pointer and tooltip come from the linkifier, not from this getter.
let _linkUnderlineFixed = false;
function dropImplicitLinkUnderline(term) {
  if (_linkUnderlineFixed) return;
  _linkUnderlineFixed = true;
  try {
    let ext = term.buffer.active.getNullCell().extended;
    let proto = ext && Object.getPrototypeOf(ext);
    let d = proto && Object.getOwnPropertyDescriptor(proto, 'underlineStyle');
    if (!d || !d.get || !d.set || typeof proto.constructor !== 'function') return;
    let probe = new proto.constructor(0, 1);       // (_ext, _urlId): a link, no style
    if (!('_urlId' in probe) || !('_ext' in probe) || d.get.call(probe) !== 5) return;
    let orig = d.get;
    Object.defineProperty(proto, 'underlineStyle', {
      configurable: true, enumerable: d.enumerable, set: d.set,
      get: function () {
        if (!this._urlId) return orig.call(this);
        let id = this._urlId;
        this._urlId = 0;
        try { return orig.call(this); } finally { this._urlId = id; }
      },
    });
  } catch (e) {}
}

function createPane(container) {
  let id = 'p' + (++paneCounter);
  let el = document.createElement('div');
  el.className = 'pane';
  el.setAttribute('data-pane', id);
  el.innerHTML =
    `<div class="pane-bar">` +
      `<div class="pane-bar-l">` +
      `<span class="pane-badge s-off" data-pane-badge="${id}"></span>` +
      `<span class="pane-label" data-pane-label="${id}"></span>` +
      `<div class="upload-progress h" data-upload-progress="${id}">` +
        `<div class="upload-progress-track"><div class="upload-progress-bar"></div>` +
        `<div class="upload-progress-text"></div></div>` +
        `<button class="upload-progress-cancel" onclick="cancelTransfer('${id}')" title="Cancel" aria-label="Cancel transfer">${ic('close')}</button>` +
      `</div>` +
      `</div>` +
      `<div class="reconnect-bar h" data-reconnect="${id}">` +
        `<span style="font-size:12px;color:var(--dim)"></span>` +
        `<input type="password" class="reconnect-pw h" data-reconnect-pw="${id}" placeholder="password" autocomplete="off" data-lpignore="true" data-1p-ignore="true" onkeydown="if(event.key==='Enter'){event.preventDefault();reconnectPane('${id}')}">` +
        `<button class="btn btn-p" onclick="reconnectPane('${id}')">Reconnect</button>` +
      `</div>` +
      `<div class="pane-bar-r">` +
      `<button class="pane-btn" onclick="triggerUpload('${id}')" title="Upload file" aria-label="Upload file" data-upload-btn="${id}" disabled>${ic('upload')}</button>` +
      `<input type="file" class="h" data-upload-input="${id}" multiple onchange="handleUpload('${id}',this)">` +
      `<button class="pane-btn" onclick="triggerDownload('${id}')" title="Download file" aria-label="Download file" data-download-btn="${id}" disabled>${ic('download')}</button>` +
      `<button class="pane-btn" data-act="to-tab" onclick="movePaneToNewTab('${id}')" title="Move to new tab" aria-label="Move pane to a new tab">${ic('to-tab')}</button>` +
      `<button class="pane-btn" data-act="move-to" onclick="openPaneMoveMenu('${id}',this)" title="Move to tab" aria-label="Move pane to another tab" aria-haspopup="menu">${ic('move-to')}</button>` +
      `<button class="pane-btn" onclick="splitPane('${id}','h')" title="Split horizontal" aria-label="Split horizontal">${ic('split-h')}</button>` +
      `<button class="pane-btn" onclick="splitPane('${id}','v')" title="Split vertical" aria-label="Split vertical">${ic('split-v')}</button>` +
      `<button class="pane-btn close" onclick="closePane('${id}')" title="Close pane" aria-label="Close pane">${ic('close')}</button>` +
      `</div>` +
    `</div>` +
    `<div class="reconnect-strip h" data-reconnect-strip="${id}"></div>` +
    `<div class="pane-term">` +
      `<div class="pane-overlays" data-overlays="${id}"></div>` +
    `</div>` +
    `<div class="search-bar h" data-search="${id}">` +
      `<input type="text" placeholder="Search...">` +
      `<button onclick="searchPrev()" title="Previous match" aria-label="Previous match">${ic('chevron-up')}</button>` +
      `<button onclick="searchNext()" title="Next match" aria-label="Next match">${ic('chevron-down')}</button>` +
      `<button onclick="closeSearch()" title="Close search" aria-label="Close search">${ic('close')}</button>` +
    `</div>`;
  container.appendChild(el);

  let termEl = el.querySelector('.pane-term');
  let fit = new FitAddon.FitAddon();
  let search = new SearchAddon.SearchAddon();
  let term = new Terminal({
    cursorBlink:true, cursorStyle:'bar',
    // CURSOR_HIDE: when xterm is blurred, render the cursor cell with
    // no decoration at all — so the cell glyph stays visible but no
    // bar/block/blink is drawn. We blur on drag-start and refocus on the
    // deferred restore. See the CURSOR_HIDE pair in this file.
    cursorInactiveStyle:'none',
    fontSize: settings.fontSize,
    fontFamily: fontStack(settings.font),
    fontWeight: settings.fontWeight,
    fontWeightBold: Math.min(900, settings.fontWeight + 300),
    lineHeight: settings.lineHeight,
    theme: themeXterm(),
    allowProposedApi:true, scrollback:50000,
    linkHandler: termLinkHandler(() => term)
  });
  dropImplicitLinkUnderline(term);   // invariant O8, see the function
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((ev, uri) => openLinkSafely(uri)));
  // A hovered link's tooltip goes with its terminal (see showLinkTip).
  let _termDispose = term.dispose.bind(term);
  term.dispose = () => {
    if (_linkTipOwner === term) hideLinkTip();
    _termDispose();
  };
  let u = new Unicode11Addon.Unicode11Addon(); term.loadAddon(u);
  term.unicode.activeVersion = '11';
  term.loadAddon(search);
  term.open(termEl);

  let p = {
    id:id, el:el, term:term, fitAddon:fit, searchAddon:search,
    sid:null, connecting:false, polling:false, pollRetries:0,
    inputQueue:[], flushTimer:null, inputInFlight:null, keepaliveTimer:null,
    // Remote working directory, learned from OSC 7 when the shell emits
    // it. '' means unknown — the file browser then asks the server,
    // which can answer for tmux panes. See the OSC 7 handler below.
    cwd:'',
    label:'', resizeTimer:null, upload:null, download:null,
    // Last (cols,rows) we POSTed to the server — used to skip duplicate
    // /api/resize calls when several refit triggers fire in the same
    // tick (settle-loop iterations + ResizeObserver echo; visibility
    // recovery; held-key zoom autorepeat landing on the cap value).
    lastSentCols:0, lastSentRows:0,
    // Connection identity — set once per connect, used for save/restore/reconnect.
    host:'', port:22, user:'', connection:null,
    auth:'pw', password:'', key:'', keyPass:'',
    persistent:false, slotId:null, tmuxCmd:'tmux',
    connectedAt:0, // ms timestamp of last successful /api/connect resolve
    // CURSOR_HIDE: per-pane drag-blur state (see module header)
    _dragBlurred:false, _selDisp:null, _selTimer:null,
    _dragStartX:0, _dragStartY:0, _dragMoved:false
  };
  panes[id] = p;
  // ── Paint guard: what xterm rendered, and when.
  if (typeof term.onRender === 'function') {
    term.onRender(() => notePaneRendered(p));
    p.paintWatchable = true;
  }
  if (typeof term.onWriteParsed === 'function') {
    term.onWriteParsed(() => notePaneParsed(p));
  }
  // Schedule a font-load-aware settle-loop refit after registration so
  // the helper can guard its RAFs against pane teardown via panes[id].
  // (Do not re-add a charSizeChange listener here — recursion via the
  // settle-loop fontFamily round-trip; see commit 292eace.)
  fitPaneWhenStable(p);

  // CURSOR_HIDE: focus tracking + drag-blur for cursor hiding.
  // Blur the xterm terminal on left-mousedown so the cursor cell that
  // ends up at the trailing edge of tmux's orange selection renders
  // without the bar/blink (via cursorInactiveStyle:'none'). The
  // companion document-level mouseup defers `focus()` restoration until
  // tmux moves the cursor back to the prompt (onCursorMove) or 500ms
  // elapsed, so the bar doesn't flicker back in the gap. Click-vs-drag
  // is decided by mousemove > 3px — bare clicks skip the
  // deferred-restore arm and re-focus xterm immediately.
  el.addEventListener('mousedown', (e) => {
    activatePane(id);
    if (e.button !== 0) return;
    // Cancel any leftover deferred restore from a prior drag so the
    // stale subscription doesn't fire mid-new-drag and re-focus xterm.
    _cancelDragBlurArm(p);
    p._dragStartX = e.clientX; p._dragStartY = e.clientY; p._dragMoved = false;
    p._dragBlurred = true;
    try { p.term.blur(); } catch(err){}
  });
  el.addEventListener('mousemove', (e) => {
    if (!p._dragBlurred || p._dragMoved) return;
    if ((e.buttons & 1) === 0) return;
    if (Math.abs(e.clientX - p._dragStartX) > 3 ||
        Math.abs(e.clientY - p._dragStartY) > 3) {
      p._dragMoved = true;
    }
  });

  // Terminal events
  // queueInput decides what a pane without a session does with keys:
  // dropped, unless it is a persistent pane re-attaching right now.
  term.onData(d => queueInput(p, d));
  term.onBinary(d => queueInput(p, d));
  term.onResize(size => {
    if(!p.sid) return;
    if(p.resizeTimer) clearTimeout(p.resizeTimer);
    p.resizeTimer = setTimeout(() => {
      p.resizeTimer=null;
      if(!p.sid) return;
      // Skip if the dimensions match what the server has already
      // confirmed receiving — saves a round-trip when several refit
      // triggers converge on the same size (held-key zoom past the
      // cap, ResizeObserver echo, etc.). Commit-on-success: the
      // lastSent fields are only updated after the POST resolves,
      // so a failed POST naturally retries on the next refit. See
      // flushPaneResize for the rationale.
      if(p.lastSentCols === size.cols && p.lastSentRows === size.rows) return;
      api('resize',{body:{session_id:p.sid,cols:size.cols,rows:size.rows}})
        .then(r => {
          if (r && r.error) return;
          p.lastSentCols = size.cols;
          p.lastSentRows = size.rows;
        })
        .catch(() => { /* leave lastSent alone so the next refit retries */ });
    }, 150);
  });
  term.onSelectionChange(() => {
    let sel = term.getSelection();
    if (sel) copyText(sel);
  });

  // OSC 52 from tmux (with `set-clipboard on`, which is the default
  // here). xterm v5's built-in OSC 52 handler calls writeText, which
  // Yandex denies because OSC bytes arrive on the network polling
  // path — outside a gesture frame. Our handler reuses copyText() so
  // the sync execCommand runs inside the activation window left by
  // the recent mouseup. Format: "<kind>;<base64>"; "?" means a read
  // request, which we don't service.
  // A clipboard write from the remote is honoured only when the user
  // asked for copying (Auto-copy) AND just did something in this pane -
  // a copy is always the tail of a mouse selection or a copy-mode key.
  // Otherwise ANY output could replace the clipboard: `tail -f` of a log
  // with an injected ESC]52 sequence silently put an attacker's command
  // line there, to be pasted into a local terminal later.
  const OSC52_GESTURE_MS = 3000;
  let lastGesture = 0;
  let markGesture = () => { lastGesture = Date.now(); };
  termEl.addEventListener('mouseup', markGesture, true);
  termEl.addEventListener('keydown', markGesture, true);
  if (term.parser && term.parser.registerOscHandler) {
    term.parser.registerOscHandler(52, data => {
      let semi = data.indexOf(';');
      if (semi < 0) return false;
      let payload = data.slice(semi + 1);
      if (!payload || payload === '?') return false;
      // A connected host (possibly compromised — it is the thing being
      // administered) can emit an arbitrarily large OSC 52 sequence. Cap it
      // so a hostile remote can't dump megabytes into the system clipboard.
      // ~1 MB of base64 is ~768 KB of text, far more than any real copy.
      if (payload.length > 1024 * 1024) return false;
      let text;
      try { text = atob(payload); } catch (e) { return false; }
      // tmux sends UTF-8. Reinterpret the latin1 byte string as UTF-8 via
      // TextDecoder — replacing the deprecated escape()/unescape() pair.
      // {fatal:true, ignoreBOM:true} reproduces the old escape() behavior
      // exactly: invalid UTF-8 throws (as escape() did) so the catch keeps
      // the raw latin1 text instead of substituting U+FFFD, and ignoreBOM
      // keeps a leading BOM that TextDecoder would otherwise strip.
      try {
        text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
          Uint8Array.from(text, c => c.charCodeAt(0)));
      } catch (e) {}
      // Returning true consumes the sequence, so xterm's own handler
      // doesn't write it either.
      if (!settings.tmuxClipboard) return true;
      if (Date.now() - lastGesture > OSC52_GESTURE_MS) return true;
      copyText(text);
      return true;
    });
    // OSC 7 — "here is my working directory", emitted on every prompt
    // by fish, by zsh/bash with the usual vte/starship hooks, and by
    // most modern shells' default configs. It is the only way a
    // non-persistent pane can know where the remote shell is: that
    // shell is a child of sshd on the far side, so nothing local can
    // introspect it. Persistent panes have tmux as a second source
    // (the server reads #{pane_current_path}), which is why the file
    // browser treats this as an optimisation, not a requirement.
    //
    // Format: file://<host>/<percent-encoded-path>. The host is
    // whatever the remote claims and is not something we can verify,
    // so we ignore it and keep only the path.
    term.parser.registerOscHandler(7, data => {
      // A hostile or broken remote can emit anything here. The value
      // only ever seeds a directory listing the user then sees, so the
      // exposure is low, but cap the length and demand a plausible
      // absolute path rather than storing arbitrary junk.
      if (!data || data.length > 4096 || data.slice(0, 7) !== 'file://') return false;
      let slash = data.indexOf('/', 7);
      if (slash < 0) return false;
      let host = data.slice(7, slash).toLowerCase();
      // Query/fragment are not part of a path: `file://h/srv?x#y` used
      // to become the directory "/srv?x#y".
      let raw = data.slice(slash).split(/[?#]/)[0];
      let path;
      try { path = decodeURIComponent(raw); }
      catch (e) { return false; }
      // No control characters at all (NUL, newline, ESC...): a path the
      // file browser then lists and offers delete buttons in must be a
      // plain one.
      if (path.charAt(0) !== '/' || /[\x00-\x1f\x7f]/.test(path)) return false;
      // The host part used to be discarded, so a nested `ssh other-box`,
      // a `docker exec`, or merely `cat`-ing a file containing an OSC 7
      // sequence moved the file browser's start directory - which then
      // opened that path on THIS pane's host, with delete buttons. Pin
      // the host of the first OSC 7 this session sees (the shell ssh
      // landed in) and ignore reports from any other host; when the
      // nested session exits, the outer shell's own reports apply again.
      if (p.osc7Host === undefined || p.osc7Host === null) p.osc7Host = host;
      else if (host !== p.osc7Host) return true;     // consumed, not applied
      p.cwd = path;
      return true;
    });
  }
  term.onBell(() => {
    el.classList.remove('bell'); void el.offsetWidth; el.classList.add('bell');
  });

  // Ctrl+V. In a terminal Ctrl+letter is a control code: xterm sends
  // ^V (0x16) and cancels the browser's own paste, so Ctrl+V looked
  // broken - the shell sat waiting for readline's quoted-insert to
  // swallow the next key. With the setting on we decline the event
  // instead of handling it: xterm leaves it alone, the browser performs
  // its native paste into xterm's hidden textarea, and xterm's own
  // paste handler wraps the text in bracketed-paste markers (so a
  // multi-line paste is not executed line by line).
  //
  // Returning false here is the ONLY way to get that: any handling at
  // all ends in preventDefault, which kills the native paste.
  //
  // The tab keys (Alt+1..9, Alt+T, Alt+W, Alt+Shift+[ / ]) are taken
  // here too, before xterm turns Alt+x into ESC x: see tabKeyHandled().
  term.attachCustomKeyEventHandler(e => !tabKeyHandled(e) && !_ctrlVShouldPaste(e));

  // Right-click paste. Also swallow button-2 mousedown at capture phase
  // so xterm.js never forwards it to the remote — otherwise tmux (with
  // `mouse on`) catches MouseDown3Pane and pops its own menu, which
  // competes with our paste UX.
  //
  // activatePane(id) is called explicitly before stopPropagation: the
  // bubble-phase listener on the parent .pane element (`el.mousedown
  // → activatePane(id)`) won't fire once we stop propagation, so
  // right-clicking an inactive pane would leave the previously-active
  // pane focused and the subsequent contextmenu paste would land in
  // the wrong pane.
  termEl.addEventListener('mousedown', e => {
    if (e.button === 2) {
      activatePane(id);
      e.stopPropagation();
    }
  }, true);
  termEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    if(navigator.clipboard && navigator.clipboard.readText){
      // Route through term.paste(), not queueInput(), so multi-line
      // clipboard content is wrapped in bracketed-paste markers when the
      // remote app has enabled the mode (vim, psql, shells with
      // bracketed paste on). Sending it raw executes each line
      // immediately — the classic paste-jacking hazard, made worse here
      // because the OSC 52 handler lets the remote host seed the
      // clipboard. paste()'s output flows through term.onData into the
      // same input queue (and inherits its p.sid guard).
      navigator.clipboard.readText().then(t => { if(t && p.sid) p.term.paste(t) }).catch(() => {});
    }
  });

  // Resize observer fires immediately on observe() with the current
  // container size, so the initial fit happens automatically. The
  // older setTimeout(fit, 50) fallback is now redundant: ResizeObserver
  // covers the cold-layout case and fitPaneWhenStable covers the
  // webfont-load case.
  // A pane in a hidden tab is not fitted here: its box is 0x0 and the
  // fit would shrink the terminal (and, through onResize, the PTY) to
  // 2x1. showTab() fits it once the tab is on screen.
  new ResizeObserver(() => {
    if (paneHidden(p)) { p._fitDeferred = true; return; }
    fit.fit();
  }).observe(termEl);
  wirePaneDrop(p);

  return p;
}

function activatePane(id) {
  // A pane in a tab that is not on screen: bring its tab forward, which
  // activates the pane remembered for it (this one).
  let t = panes[id] ? tabOfPane(panes[id]) : null;
  if (t && t.id !== activeTabId) { t.lastActive = id; showTab(t.id); return; }
  if (t && t.lastActive !== id) { t.lastActive = id; renderTab(t); }
  if (activeId === id) return;
  let prev = activeId ? panes[activeId] : null;
  if (prev) {
    prev.el.classList.remove('active');
    // Hide search bar on outgoing pane so it doesn't leak across switches.
    // toggleSearch/closeSearch act on panes[activeId] only, so without this
    // the bar stays visible on prev and the next Escape targets the new pane.
    let prevBar = prev.el.querySelector('[data-search]');
    if (prevBar && !prevBar.classList.contains('h')) {
      prevBar.classList.add('h');
      if (prev.searchAddon) prev.searchAddon.clearDecorations();
    }
  }
  activeId = id;
  let p = panes[id];
  if (!p) return;
  p.el.classList.add('active');
  updatePaneBadge(p);
  renderPaneTools();
  p.term.focus();
}

function updatePaneBadge(p) {
  let badge = p.el.querySelector('[data-pane-badge]');
  if (!badge) return;
  let s = p.sid ? (p.reconnecting ? 'reconnecting' : 'connected')
                : (p.connecting ? 'connecting' : 'disconnected');
  let busy = !!p.upload || !!p.download;
  // Title upkeep stays OUTSIDE the memo below: it depends on activeId,
  // which changes without this pane's own state changing (pane switch),
  // so a memoized skip here could leave a stale document title. setTitle
  // is itself memoized, so per-frame upkeep is one string compare.
  if (activeId === p.id) setTitle(p.label || '');
  // Early-return when nothing rendered below can have changed. This runs
  // on EVERY output frame (handleOutputPayload): during noisy output
  // (cat, build logs) the remove/recreate dance in updatePaneTag
  // allocated a fresh element and invalidated layout hundreds of times a
  // second, racing xterm's own renderer. The key covers every input the
  // remaining DOM writes depend on, so a skipped call is a true no-op.
  let state = [s, busy ? 1 : 0,
               p.label || '', p.host || '', p.connection || '',
               p.persistent ? 1 : 0].join('');
  if (p._badgeState === state) return;
  p._badgeState = state;
  badge.className = 'pane-badge ' + (s==='connected'?'s-on':
                                     (s==='connecting'||s==='reconnecting')?'s-wait':'s-off');
  badge.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  let ub = p.el.querySelector('[data-upload-btn]');
  if (ub) ub.disabled = !p.sid || busy;
  let db = p.el.querySelector('[data-download-btn]');
  if (db) db.disabled = !p.sid || busy;
  updatePaneTag(p);
  if (activeId === p.id) renderPaneTools();
  // The tab's dot is the worst state of its panes, so ANY pane's change
  // must reach it - not only the active pane's (a background pane that
  // drops while the user works elsewhere has to turn its tab red).
  renderTab(tabOfPane(p));
}

// ── Tabs ────────────────────────────────────────────────────────────
// A tab is a root container (#panes > .tab-root[data-tab]) holding its
// own split tree, plus a handle in the strip (#tabs > .tab[data-tab]).
// Only the active tab's root is shown; the others carry `.h`
// (display:none) and stay fully alive: streams, keepalive, input
// queues, reconnects and the absence kick run for their panes exactly
// as for visible ones.
//
// Which tab a pane belongs to is read from the DOM (the root it sits
// in), never stored on the pane: moving a pane element into another
// root is all it takes to move it between tabs, without touching its
// session.
//
// Sizing: a pane in a hidden tab has a 0x0 box. Fitting it there gives
// a 2x1 terminal and a 2x1 PTY - a shell that wraps every character,
// and a tmux session squashed for every other client. So every fit
// path (ResizeObserver, fitPaneWhenStable, beginSessionIO, split drag,
// close) skips a hidden pane and marks it; showTab() fits every pane of
// the tab once it has its real box, and the resize goes to the server
// only if cols/rows actually changed (flushPaneResize dedups).
// docs/invariants.md U1.
const tabs = [];          // strip order
let activeTabId = null;
let tabCounter = 0;

function tabById(id) {
  for (let i = 0; i < tabs.length; i++) if (tabs[i].id === id) return tabs[i];
  return null;
}
function tabOfPane(p) {
  if (!p || !p.el || !p.el.closest) return null;
  let root = p.el.closest('.tab-root');
  return root ? tabById(root.getAttribute('data-tab')) : null;
}
function activeTab() { return tabById(activeTabId); }
// Panes of a tab, in layout (DOM) order.
function panesInTab(t) {
  if (!t) return [];
  let out = [];
  t.root.querySelectorAll('.pane').forEach(el => {
    let p = panes[el.getAttribute('data-pane')];
    if (p) out.push(p);
  });
  return out;
}
// True when the pane has no real box to be fitted to: its tab is hidden.
function paneHidden(p) {
  let root = p && p.el && p.el.closest ? p.el.closest('.tab-root') : null;
  if (!root) return false;
  return root.classList.contains('h') || root.hidden;
}
// Fit every pane that is on screen. Hidden ones are only marked; their
// tab fits them when shown.
function fitVisiblePanes() {
  Object.keys(panes).forEach(k => {
    let p = panes[k];
    if (paneHidden(p)) { p._fitDeferred = true; return; }
    try { p.fitAddon.fit(); } catch (e) {}
  });
}

function createTab() {
  let id = 't' + (++tabCounter);
  let root = document.createElement('div');
  root.className = 'tab-root h';
  root.setAttribute('data-tab', id);
  $('panes').appendChild(root);

  let el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('data-tab', id);
  el.setAttribute('role', 'tab');
  el.innerHTML =
    `<span class="tab-dot s-off"></span>` +
    `<span class="tab-label"></span>` +
    `<span class="tab-split h"></span>` +
    `<button class="tab-close" title="Close tab" aria-label="Close tab">${ic('close')}</button>`;
  $('tabs').appendChild(el);

  // `name`: what the user called the tab (null: the label of its active
  // pane, the automatic title). It belongs to the tab, not to a pane:
  // panes coming, going or switching never change it.
  let t = {id: id, root: root, el: el, lastActive: null, activity: false, _key: null,
           name: null};
  tabs.push(t);
  wireTab(t);
  document.body.classList.add('has-tabs');
  renderPaneTools();   // a second tab: "Move to tab" appears
  return t;
}

// Mouse handling of one tab handle. A press on the tab in front only
// keeps the focus in its terminal; a press on another tab shows it on
// RELEASE, if the pointer did not travel (a click): the same press may
// become a drag of that tab onto a pane of the tab on screen, which has
// to stay in front while it happens (see ── Moving panes between tabs).
// preventDefault keeps keyboard focus in the terminal. The close button
// and the middle button never activate: closing a background tab must
// not bring it to the front first. A double-click renames the tab (the
// first click already brought it forward); a right-click opens its menu
// without bringing it forward.
function wireTab(t) {
  let el = t.el;
  let closeBtn = el.querySelector('.tab-close');
  closeBtn.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
  closeBtn.addEventListener('click', e => { e.stopPropagation(); closeTab(t.id); });
  el.addEventListener('dblclick', e => {
    if (!e.target || !e.target.closest || e.target.closest('.tab-close, .tab-edit')) return;
    e.preventDefault();
    startTabRename(t.id);
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    if (tabs.indexOf(t) < 0) return;
    openTabMenu(t, e.clientX, e.clientY);
  });
  el.addEventListener('mousedown', e => {
    if (e.button === 1) { e.preventDefault(); return; }   // no autoscroll
    if (e.button !== 0) return;
    e.preventDefault();
    if (activeTabId === t.id) { let p = panes[activeId]; if (p) { try { p.term.focus(); } catch (err) {} } }
    startTabDrag(t, e.clientX, e.clientY);
  });
  el.addEventListener('auxclick', e => {
    if (e.button !== 1) return;
    e.preventDefault();
    closeTab(t.id);
  });
}

// Drag a tab: along the strip to reorder, or onto an edge of a pane in
// the tab on screen to merge its whole layout there. Plain mouse events,
// not HTML5 drag-and-drop: a native drag would be seen by the panes'
// file-drop handlers, and a tab is not a file - and the file drags the
// browser does send never touch this state.
//
// The strip is reordered only while the pointer is not over the panes
// or outside the window; a drag that ends there without a merge (its
// own pane, no pane, released outside) puts the strip back as it was.
const DRAG_START_PX = 5;
let _tabDrag = null;
function startTabDrag(t, x, y) {
  let order = Array.prototype.slice.call($('tabs').children);
  _tabDrag = {t: t, x0: x, y0: y, moved: false, order: order,
              over: 'strip', zone: null, front: activeTabId, spring: null, sprung: false,
              slots: _tabSlots(t)};
}
// Where the tabs stood at the press, in strip coordinates (so a
// sideways scroll of the strip does not shift them): see _springTrack.
// The dragged tab's own place has id null.
function _tabSlots(t) {
  let strip = $('tabs');
  let sl = strip.scrollLeft || 0, out = [];
  Array.prototype.forEach.call(strip.children, c => {
    if (!c.classList.contains('tab')) return;
    let r = c.getBoundingClientRect();
    if (r && r.width > 0) out.push({id: c === t.el ? null : c.getAttribute('data-tab'),
                                    l: r.left + sl, r: r.right + sl});
  });
  return out;
}
// Where the pointer is during a drag: the element under it (null
// outside the window), and whether that is in the panes area.
function _dragPoint(e) {
  let x = e.clientX, y = e.clientY;
  let w = window.innerWidth || document.documentElement.clientWidth || 0;
  let h = window.innerHeight || document.documentElement.clientHeight || 0;
  let outside = x < 0 || y < 0 || (w && x >= w) || (h && y >= h);
  let el = null;
  if (!outside) {
    try { el = document.elementFromPoint(x, y); } catch (err) { el = null; }
    if (!el && e.target && e.target.nodeType === 1) el = e.target;
  }
  let panesBox = $('panes');
  let inPanes = !!(el && panesBox && panesBox.contains(el));
  return {el: el, outside: outside, inPanes: inPanes};
}
// The side of pane element `el` nearest to (x, y).
function _dropSide(el, x, y) {
  let r = el.getBoundingClientRect();
  if (!r || !(r.width > 0) || !(r.height > 0)) return null;
  let dx = (x - r.left) / r.width, dy = (y - r.top) / r.height;
  let best = 'left', d = dx;
  if (1 - dx < d) { best = 'right'; d = 1 - dx; }
  if (dy < d) { best = 'top'; d = dy; }
  if (1 - dy < d) { best = 'bottom'; d = 1 - dy; }
  return best;
}
const DROP_ZONES = ['drop-zone-left', 'drop-zone-right', 'drop-zone-top', 'drop-zone-bottom'];
function clearDropZones() {
  document.querySelectorAll('.drop-zone-left,.drop-zone-right,.drop-zone-top,.drop-zone-bottom')
    .forEach(el => el.classList.remove.apply(el.classList, DROP_ZONES));
}
// The merge target under the pointer: a pane of the tab on screen that
// is not one of the dragged tab's own panes, and the side.
function _tabDropTarget(d, pt, e) {
  if (!pt.inPanes || !pt.el || !pt.el.closest) return null;
  let pel = pt.el.closest('.pane');
  let p = pel ? panes[pel.getAttribute('data-pane')] : null;
  if (!p) return null;
  let t = tabOfPane(p);
  if (!t || t.id !== activeTabId || t === d.t) return null;
  let side = _dropSide(pel, e.clientX, e.clientY);
  return side ? {p: p, side: side} : null;
}
function _restoreStripOrder(d) {
  let strip = $('tabs');
  d.order.forEach(el => { if (el.parentNode === strip) strip.appendChild(el); });
}
document.addEventListener('mousemove', e => {
  let d = _tabDrag;
  if (!d) return;
  if ((e.buttons & 1) === 0) { endTabDrag(null); return; }
  // The only tab can go nowhere (no place in the strip, no other tab to
  // merge into): no drag look; the release is a click, as before.
  if (tabs.length < 2) return;
  if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_START_PX
      && Math.abs(e.clientY - d.y0) < DRAG_START_PX) return;
  if (!d.moved) { d.moved = true; d.t.el.classList.add('dragging'); }
  let pt = _dragPoint(e);
  d.over = pt.outside ? 'out' : (pt.inPanes ? 'panes' : 'strip');
  let target = d.over === 'panes' ? _tabDropTarget(d, pt, e) : null;
  let zone = target ? 'drop-zone-' + target.side : null;
  if (!target || !d.zone || d.zone.p !== target.p || d.zone.cls !== zone) {
    clearDropZones();
    if (target) target.p.el.classList.add(zone);
  }
  d.zone = target ? {p: target.p, side: target.side, cls: zone} : null;
  _springTrack(d, pt, e);
  if (d.over !== 'strip') return;
  let strip = $('tabs');
  let others = Array.prototype.filter.call(strip.children,
    c => c !== d.t.el && c.classList.contains('tab'));
  // Past the strip's edge means "to that end": in a narrow strip (the
  // pane actions of a lone pane take width from it) the tabs scrolled
  // out of view have midpoints the pointer can never reach - left of
  // the logo or outside the window.
  let sr = strip.getBoundingClientRect();
  let before = null;
  if (e.clientX <= sr.left) before = others[0] || null;
  else if (e.clientX < sr.right) {
    for (let i = 0; i < others.length; i++) {
      let r = others[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { before = others[i]; break; }
    }
  }
  if (before) { if (d.t.el.nextSibling !== before) strip.insertBefore(d.t.el, before); }
  else if (strip.lastElementChild !== d.t.el) strip.appendChild(d.t.el);
  if (e.clientX <= sr.left || e.clientX >= sr.right) scrollTabIntoView(d.t);
});
document.addEventListener('mouseup', e => endTabDrag(e));
// `e` is the mouseup, or null when the button was found released
// without one (let go outside the window): then the last position
// decides.
function endTabDrag(e) {
  let d = _tabDrag;
  _tabDrag = null;
  if (!d) return;
  _springCancel(d);
  if (!d.moved) {
    // A click: now it is safe to bring the tab forward.
    if (activeTabId !== d.t.id && tabs.indexOf(d.t) >= 0) showTab(d.t.id);
    return;
  }
  d.t.el.classList.remove('dragging');
  _blockClickAfterDrag();
  // Without a mouseup (the button went up outside the window) nothing
  // is dropped: a merge needs a release over the pane.
  let over = d.over, zone = null;
  if (e) {
    let pt = _dragPoint(e);
    over = pt.outside ? 'out' : (pt.inPanes ? 'panes' : 'strip');
    zone = over === 'panes' ? _tabDropTarget(d, pt, e) : null;
  }
  clearDropZones();
  if (over !== 'strip') {
    _restoreStripOrder(d);
    if (zone && panes[zone.p.id] && tabs.indexOf(d.t) >= 0) mergeTabInto(d.t.id, zone.p.id, zone.side);
    else _springBack(d);
    return;
  }
  // The strip's DOM order is the truth; bring the array in line.
  let order = [];
  $('tabs').querySelectorAll('.tab').forEach(el => {
    let t = tabById(el.getAttribute('data-tab'));
    if (t) order.push(t);
  });
  if (order.length === tabs.length) { tabs.length = 0; order.forEach(t => tabs.push(t)); }
  tabs.forEach(renderTab);   // the numbers in the tooltips follow the order
  // As in a browser, the tab that was dragged along the strip is the
  // one in front afterwards (it used to be activated on the press).
  if (activeTabId !== d.t.id) showTab(d.t.id, {noSave: true});
  saveSessions();
}
// Spring-loaded tabs: during a tab or pane drag, resting the pointer on
// another tab for SPRING_MS brings that tab forward (without saving),
// and the drag goes on: its panes are now drop targets. A drag that ends
// without dropping anything (released outside the window, on no pane,
// on its own panes) puts the tab that was in front at the press back;
// nothing was saved, so the saved layout is as it was.
//
// A timer, not mousemove: a resting pointer sends no events. The count
// starts when the pointer reaches a tab and restarts only when it
// reaches ANOTHER tab, so a trembling hand still counts as resting and
// a pass across a tab (it leaves before the timer) never switches. The
// dragged tab itself is no target: the strip reorders under the pointer
// while a tab is dragged along it (the dragged tab takes the place of
// the one it passes), so the pointer resting where A was is over the
// dragged tab a moment later. Over the dragged tab, the tab that stood
// there at the press is meant (checked in Chromium: a pass over A that
// went on and came back to A's place found only the dragged tab there
// and never switched); elsewhere on it the count goes on.
// Released, or the dragged tab gone, the timer does nothing.
const SPRING_MS = 500;
function _springCancel(d) {
  if (d && d.spring) { clearTimeout(d.spring.timer); d.spring = null; }
}
function _springTrack(d, pt, e) {
  let tabEl = pt.el && pt.el.closest ? pt.el.closest('#tabs .tab') : null;
  let id = tabEl ? tabEl.getAttribute('data-tab') : null;
  if (tabEl && d.t && tabEl === d.t.el) {
    // Only where the dragged tab now really sits (after a reorder): the
    // pointer must be inside its box as laid out now.
    let br = d.t.el.getBoundingClientRect();
    if (!br || !(e.clientX >= br.left && e.clientX < br.right)) return;
    let x = e.clientX + ($('tabs').scrollLeft || 0);
    let at = (d.slots || []).filter(sl => x >= sl.l && x < sl.r);
    // Its own place at the press is no other tab's, whatever overlaps it.
    if (at.length !== 1 || !at[0].id) return;
    id = at[0].id;
  }
  if (id === activeTabId) id = null;
  if (d.spring && d.spring.id === id) return;
  _springCancel(d);
  if (!id) return;
  d.spring = {id: id, timer: setTimeout(() => {
    if (d.spring && d.spring.id === id) d.spring = null;
    if (_tabDrag !== d && _paneDrag !== d) return;        // released meanwhile
    if (d.t && tabs.indexOf(d.t) < 0) return;             // the dragged tab closed
    if (d.p && !panes[d.p.id]) return;                    // the dragged pane closed
    if (!tabById(id) || activeTabId === id) return;
    d.sprung = true;
    showTab(id, {noSave: true});
  }, SPRING_MS)};
}
function _springBack(d) {
  if (!d.sprung || !d.front || activeTabId === d.front || !tabById(d.front)) return;
  showTab(d.front, {noSave: true});
}

// A drag that ends over a button (the "+", a tab's close) must not
// also click it: a pane dropped on "+" makes a tab, it does not open
// the login form.
let _clickBlockUntil = 0;
function _blockClickAfterDrag() { _clickBlockUntil = Date.now() + 400; }
document.addEventListener('click', e => {
  if (!_clickBlockUntil) return;
  if (Date.now() > _clickBlockUntil) { _clickBlockUntil = 0; return; }
  _clickBlockUntil = 0;
  e.stopPropagation();
  e.preventDefault();
}, true);

// Show tab `id`: hide every other root, show this one, fit its panes to
// their real box, and focus the pane that was last active in it.
function showTab(id, o) {
  let t = tabById(id);
  if (!t) return;
  let changed = activeTabId !== id;
  activeTabId = id;
  tabs.forEach(o => {
    let on = o === t;
    o.root.classList.toggle('h', !on);
    o.el.classList.toggle('active', on);
    o.el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  t.activity = false;
  let ps = panesInTab(t);
  let p = panes[t.lastActive];
  if (!p || ps.indexOf(p) < 0) p = ps[0] || null;
  if (p) {
    activatePane(p.id);
    try { p.term.focus(); } catch (e) {}
    setTitle(p.label || '');
  }
  // Now that the root is laid out again: fit each pane once to its real
  // size. The settle loop ends in flushPaneResize, which posts only a
  // size the server does not already have.
  // Once fitted, its scrollbar is put back where xterm shows the
  // buffer (_resyncScroll, ── Moving panes): xterm measured the viewport
  // while it was display:none, or the pane was re-parented.
  ps.forEach(q => {
    q._fitDeferred = false;
    applyTermSettings(q);        // a zoom or font change made while hidden
    // ...and repainted in full, expecting a render (── Paint guard).
    fitPaneWhenStable(q, {onSettled: q2 => { _resyncScrollSoon(q2); repaintPane(q2); }});
  });
  tabs.forEach(renderTab);
  renderPaneTools();
  scrollTabIntoView(t);
  if (changed && !(o && o.noSave)) saveSessions();
}

// The strip's width follows the window and the pane actions beside it
// (#paneTools changes with the active pane): whenever it changes, the tab
// in front is brought back into view - not during a drag, where the
// pointer decides what is shown.
(function () {
  let strip = $('tabs');
  if (!strip || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => {
    if (_tabDrag || _paneDrag) return;
    let t = activeTab();
    if (t) scrollTabIntoView(t);
  }).observe(strip);
})();
function scrollTabIntoView(t) {
  let strip = $('tabs');
  if (!strip || !t) return;
  // Measured in fractional pixels: the strip's width is whatever the
  // top bar leaves it, usually not a whole number, and offsetWidth /
  // clientWidth round it - which left the last tab half a pixel outside
  // the strip. Overshoot by rounding up; the browser clamps scrollLeft.
  let sr = strip.getBoundingClientRect(), r = t.el.getBoundingClientRect();
  if (r.left < sr.left) strip.scrollLeft -= Math.ceil(sr.left - r.left);
  else if (r.right > sr.right) strip.scrollLeft += Math.ceil(r.right - sr.right);
}

// Remove an (emptied) tab. If it was the active one, the tab to its
// right is shown, else the one to its left.
function removeTab(t) {
  let idx = tabs.indexOf(t);
  if (idx < 0) return;
  closeMenus(false);    // its menu, or a list of tabs that now names a gone one
  tabs.splice(idx, 1);
  t.root.remove();
  t.el.remove();
  if (!tabs.length) {
    activeTabId = null;
    document.body.classList.remove('has-tabs');
    renderPaneTools();
    return;
  }
  if (activeTabId === t.id) {
    let next = tabs[idx] || tabs[idx - 1];
    activeTabId = null;
    showTab(next.id);
  }
  tabs.forEach(renderTab);   // the numbers in the tooltips shift
  renderPaneTools();         // back to one tab: "Move to tab" goes
}

function removeAllTabs() {
  closeMenus(false);
  tabs.slice().forEach(t => { t.root.remove(); t.el.remove(); });
  tabs.length = 0;
  activeTabId = null;
  $('panes').innerHTML = '';
  $('tabs').innerHTML = '';
  document.body.classList.remove('has-tabs');
  renderPaneTools();
}

// Dot (worst pane state), label (the tab's name, else its active pane's
// label), split marker and activity mark. Memoized: it runs from
// updatePaneBadge, which runs on every output frame - the key holds only
// strings that are cheap to build (the split marker's key is a walk of
// the split wrappers and their inline flex values, not of the terminals,
// and holds whole-pixel boxes, so a drag that does not move a box by a
// pixel and a window resize leave it equal), so an output frame changes
// no DOM here.
function _paneDotState(p) {
  if (p.sid) return p.reconnecting ? 'wait' : 'on';
  return p.connecting ? 'wait' : 'off';
}
function renderTab(t) {
  if (!t) return;
  let ps = panesInTab(t);
  syncTabSolo(t, ps);
  let rank = {on: 0, wait: 1, off: 2};
  let worst = 'on';
  ps.forEach(p => { let s = _paneDotState(p); if (rank[s] > rank[worst]) worst = s; });
  if (!ps.length) worst = 'off';
  let ap = panes[t.lastActive];
  if (!ap || ps.indexOf(ap) < 0) ap = ps[0];
  let label = t.name || (ap ? (ap.label || '') : '');
  let shape = ps.length > 1 ? _miniKey(_layoutNode(t.root)) : '';
  let active = t.id === activeTabId;
  let act = !!t.activity && !active;
  // Tabs 1..8 carry their shortcut; the number follows the strip order,
  // so every path that reorders or removes a tab re-renders them all.
  let num = tabs.indexOf(t) + 1;
  let hint = num >= 1 && num <= 8 ? 'Alt+' + num : '';
  let key = [worst, label, ps.length, act ? 1 : 0, active ? 1 : 0, hint,
             shape, shape && ap ? ap.id : ''].join('\u0001');
  if (t._key === key) return;
  let shapeKey = shape + '\u0001' + (shape && ap ? ap.id : '');
  t._key = key;
  t.el.querySelector('.tab-dot').className = 'tab-dot s-' + worst;
  t.el.querySelector('.tab-label').textContent = label;
  let sp = t.el.querySelector('.tab-split');
  if (sp._shape !== shapeKey) {
    sp._shape = shapeKey;
    _drawSplitMarker(sp, shape ? _layoutNode(t.root) : null, ap);
  }
  sp.classList.toggle('h', ps.length < 2);
  sp.title = ps.length > 1 ? ps.length + ' panes' : '';
  t.el.classList.toggle('activity', act);
  t.el.title = label + (ps.length > 1 ? ' (' + ps.length + ' panes)' : '')
    + (hint ? (label ? ' - ' : '') + hint : '');
  if (active) renderPaneTools();
}

// The split marker: a 16x12 miniature of the tab's layout, one box per
// pane, side by side or stacked as the real splits are, in the splits'
// proportions, the tab's active pane lit. The proportion is read from the
// flex-grow of the split's two children - what the handle drag and the
// restore write, empty meaning 1 (index.html: `.pane`, `.split-*` are
// flex:1) - never measured: a hidden tab has no boxes, and measuring
// would redraw on every window resize. Whole-pixel boxes with a 1px gap, so it is
// sharp at 1x and 2x; colours come from the theme through CSS
// (index.html `.tab-split`), none are written here.
const MINI_W = 16, MINI_H = 12;
// The top node of a tab's layout: its pane, or its outer split wrapper.
function _layoutNode(rootEl) {
  if (!rootEl) return null;
  for (let i = 0; i < rootEl.children.length; i++) {
    let ch = rootEl.children[i];
    if (ch.classList.contains('pane') || ch.classList.contains('split-h')
        || ch.classList.contains('split-v')) return ch;
  }
  return null;
}
function _splitKids(el) {
  let out = [];
  for (let i = 0; i < el.children.length; i++) {
    let c = el.children[i];
    if (c.classList.contains('pane') || c.classList.contains('split-h')
        || c.classList.contains('split-v')) out.push(c);
  }
  return out;
}
// The arrangement as a short string: "p3", "h(p1,v(p2,p4))".
function _splitShape(el) {
  if (!el) return '';
  if (el.classList.contains('pane')) return el.getAttribute('data-pane') || '';
  return (el.classList.contains('split-h') ? 'h(' : 'v(')
    + _splitKids(el).map(_splitShape).join(',') + ')';
}
// An element's share in its split: its inline flex-grow (style.flex may
// read back as "0.7 1 0%"), 1 when none is set.
function _flexGrow(el) {
  let st = el && el.style;
  if (!st) return 1;
  let g = st.flexGrow;
  if (g === undefined || g === null || g === '') g = st.flex;
  let v = parseFloat(g);
  return v > 0 ? v : 1;
}
// The first part takes ratio x (size - 1) whole pixels, the second the
// rest after a 1px gap; each keeps at least 1px while there is room.
function _miniSplit(size, ratio) {
  let n = size - 1;
  if (n < 2) return Math.max(1, Math.floor(n / 2));
  return Math.max(1, Math.min(n - 1, Math.round(ratio * n)));
}
function _miniRects(el, x, y, w, h, out) {
  if (!el) return;
  if (el.classList.contains('pane')) {
    out.push({id: el.getAttribute('data-pane'), x: x, y: y, w: Math.max(1, w), h: Math.max(1, h)});
    return;
  }
  let kids = _splitKids(el);
  if (kids.length < 2) { _miniRects(kids[0], x, y, w, h, out); return; }
  let ga = _flexGrow(kids[0]), gb = _flexGrow(kids[1]);
  let ratio = ga / (ga + gb);
  if (el.classList.contains('split-h')) {
    let w1 = _miniSplit(w, ratio);
    _miniRects(kids[0], x, y, w1, h, out);
    _miniRects(kids[1], x + w1 + 1, y, Math.max(1, w - w1 - 1), h, out);
  } else {
    let h1 = _miniSplit(h, ratio);
    _miniRects(kids[0], x, y, w, h1, out);
    _miniRects(kids[1], x, y + h1 + 1, w, Math.max(1, h - h1 - 1), out);
  }
}
// renderTab's memo for the marker: the arrangement and every box in
// whole pixels - it changes exactly when the drawing would.
function _miniKey(node) {
  if (!node) return '';
  let rects = [];
  _miniRects(node, 0, 0, MINI_W, MINI_H, rects);
  return _splitShape(node) + '|' + rects.map(r => r.x + ',' + r.y + ',' + r.w + ',' + r.h).join(';');
}
const SVG_NS = 'http://www.w3.org/2000/svg';
function _drawSplitMarker(sp, node, ap) {
  while (sp.firstChild) sp.removeChild(sp.firstChild);
  if (!node) return;
  let rects = [];
  _miniRects(node, 0, 0, MINI_W, MINI_H, rects);
  let svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + MINI_W + ' ' + MINI_H);
  svg.setAttribute('width', String(MINI_W));
  svg.setAttribute('height', String(MINI_H));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  rects.forEach(r => {
    let el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('data-pane', r.id);
    el.setAttribute('x', String(r.x));
    el.setAttribute('y', String(r.y));
    el.setAttribute('width', String(r.w));
    el.setAttribute('height', String(r.h));
    if (ap && r.id === ap.id) el.setAttribute('class', 'on');
    svg.appendChild(el);
  });
  sp.appendChild(svg);
}

// ── Tab names ──
// A double-click on a tab (or "Rename" in its menu) edits its name in
// place: an <input> over the label, all selected. Enter or leaving the
// field saves, Escape cancels; an empty name gives the automatic title
// (the active pane's label) back. The name is text (textContent, never
// HTML), cut to TAB_NAME_MAX characters here, not only by maxlength,
// and saved with the layout at once (saveSessions, `name` per tab).
// While the field is open its keys are its own: they stop at the field,
// so none reaches the shell, the login form's Enter or the tab keys
// (U7); a press in it starts no tab drag and leaves the focus there.
// renderTab never touches the field (it writes the hidden label), so
// output or a state change does not lose what is being typed.
const TAB_NAME_MAX = 60;
function _cleanTabName(v) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  let cs = Array.from(s);
  if (cs.length > TAB_NAME_MAX) s = cs.slice(0, TAB_NAME_MAX).join('').trim();
  return s || null;
}
// What a tab is called on screen.
function tabTitle(t) {
  if (!t) return '';
  if (t.name) return t.name;
  let ps = panesInTab(t);
  let ap = panes[t.lastActive];
  if (!ap || ps.indexOf(ap) < 0) ap = ps[0];
  return ap ? (ap.label || '') : '';
}
function setTabName(id, v) {
  let t = tabById(id);
  if (!t) return;
  let n = _cleanTabName(v);
  if (n === (t.name || null)) return;
  t.name = n;
  renderTab(t);
  saveSessions();
}
function startTabRename(id) {
  let t = tabById(id);
  if (!t) return;
  closeMenus(false);
  if (_tabDrag && _tabDrag.t === t && !_tabDrag.moved) _tabDrag = null;
  if (activeTabId !== t.id) showTab(t.id);
  if (t._edit) { try { t._edit.focus(); t._edit.select(); } catch (e) {} return; }
  let lab = t.el.querySelector('.tab-label');
  let inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'tab-edit';
  inp.maxLength = TAB_NAME_MAX;
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  inp.setAttribute('aria-label', 'Tab name');
  inp.setAttribute('data-lpignore', 'true');
  inp.setAttribute('data-1p-ignore', 'true');
  inp.value = tabTitle(t);
  lab.classList.add('h');
  lab.parentNode.insertBefore(inp, lab.nextSibling);
  t._edit = inp;
  let done = false;
  let finish = (save, refocus) => {
    if (done) return;
    done = true;
    if (t._edit === inp) t._edit = null;
    let v = inp.value;
    if (inp.parentNode) inp.parentNode.removeChild(inp);
    lab.classList.remove('h');
    if (save) setTabName(t.id, v);
    if (refocus && activeTabId === t.id) {
      let p = panes[activeId];
      if (p) { try { p.term.focus(); } catch (e) {} }
    }
  };
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
  });
  ['keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']
    .forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
  inp.addEventListener('blur', () => finish(true, false));
  try { inp.focus(); inp.select(); } catch (e) {}
}

// ── A lone pane has no bar of its own ──
// A tab with exactly one pane is "solo" (.tab-root.solo): the pane's bar
// is hidden by CSS and the terminal gets its height; the tab already
// shows the label and state, and the pane actions are in the top bar
// (#paneTools, acting on the active pane). With 2+ panes every pane
// shows its bar again, so the user can tell them apart.
//
// Runs from renderTab, which every path that changes a tab's pane count
// calls (materialize, close, a dismissed split, restore) - a path that
// moves a pane between tabs must call renderTab on BOTH tabs. It is
// recomputed on every call, not only when the count changes: a pane can
// arrive while another leaves.
//
// The refit after the bar appears or goes is left to the pane's
// ResizeObserver (the terminal box changes height): one fit, and the
// resize reaches the server once, debounced in onResize and deduped
// against lastSent. A pane in a hidden tab is skipped there as
// everywhere (U1); showTab fits it.
//
// A transfer's progress lives in the bar; for a lone pane it is moved
// into the pane's overlay stack (a card over the terminal) so it and its
// cancel button stay visible, and only while that tab is on screen.
//
// The Reconnect control lives in the bar too, centred between the
// label side and the buttons; for a lone pane it moves into the pane's
// reconnect strip (placeReconnect).
function syncTabSolo(t, ps) {
  let solo = ps.length === 1;
  if (t.root.classList.contains('solo') !== solo) t.root.classList.toggle('solo', solo);
  ps.forEach(p => {
    if (p._progSolo !== solo) placeTransferProgress(p, solo);
    placeReconnect(p);
  });
}
function placeTransferProgress(p, solo) {
  let prog = p.el.querySelector('[data-upload-progress]');
  let side = p.el.querySelector('.pane-bar-l');
  let ovl = p.el.querySelector('.pane-overlays');
  if (!prog || !side || !ovl) return;
  p._progSolo = solo;
  if (solo) { if (prog.parentNode !== ovl) ovl.appendChild(prog); }
  else if (prog.parentNode !== side) side.appendChild(prog);
}
// Where a pane's Reconnect control is, and whether it shows. The owner
// wants it in the row that carries the pane's name and its persistent /
// short-lived tag, in the middle - not as a card over the terminal.
//   - Pane with its own bar (2+ panes in the tab): in the bar, between
//     .pane-bar-l (badge, label, tag, progress) and .pane-bar-r (the
//     buttons). .has-rc gives both sides the same flex share, which
//     centres the control; on a narrow pane the sides keep their
//     content and the control's message ellipsizes first, so it never
//     covers a button and the Reconnect button stays in view.
//   - Lone pane (bar hidden, see syncTabSolo): in .reconnect-strip, a
//     bar-high strip at the top of the pane, shown only while the
//     control is. It is position:absolute over the terminal, NOT in the
//     pane's flex column: in the column it would shrink the terminal,
//     refit it and resize the PTY on every disconnect and again on
//     reconnect (the reason the status bars live in .pane-overlays).
//     The overlay stack moves down below it in CSS.
// Called from syncTabSolo (every renderTab) and from show/hide. The
// control is one element moved between the two places, so a typed
// password stays; moving a focused input blurs it, so focus is put
// back when it was there.
function placeReconnect(p) {
  let ctrl = p.el.querySelector('[data-reconnect]');
  let strip = p.el.querySelector('.reconnect-strip');
  let bar = p.el.querySelector('.pane-bar');
  if (!ctrl || !strip || !bar) return;
  let root = p.el.closest('.tab-root');
  let solo = !!root && root.classList.contains('solo');
  let shown = !ctrl.classList.contains('h');
  if (solo) {
    if (ctrl.parentNode !== strip) _keepRcFocus(() => strip.appendChild(ctrl));
  } else if (ctrl.parentNode !== bar) {
    _keepRcFocus(() => bar.insertBefore(ctrl, bar.querySelector('.pane-bar-r')));
  }
  if (strip.classList.contains('h') !== !(solo && shown)) strip.classList.toggle('h', !(solo && shown));
  if (bar.classList.contains('has-rc') !== (!solo && shown)) bar.classList.toggle('has-rc', !solo && shown);
  if (shown && !solo) _measureReconnect(p, ctrl, bar);
}
// The widths the bar's CSS (.has-rc) needs to centre the control and
// still fit a narrow pane, as custom properties: --rc-lc the name side's
// badge + tag (--rc-lf: the least they take shrunk), --rc-rc the buttons, --rc-cc the least the control can
// be (its button, plus a short password input when one shows). The
// message has no floor: it is what gives way. Content widths only - they
// do not depend on the pane's width, so a resize needs no JS; they are
// measured again when what is shown changes (key), not on every call
// (syncTabSolo runs on every output frame of the tab). Only while the
// control is in the bar: a lone pane's bar is hidden and measures 0, as
// does a pane in a hidden tab - nothing is stored then, and it is
// measured when the bar is on screen.
function _measureReconnect(p, ctrl, bar) {
  let L = bar.querySelector('.pane-bar-l'), R = bar.querySelector('.pane-bar-r');
  let btn = ctrl.querySelector('.btn'), pw = ctrl.querySelector('input');
  let msg = ctrl.querySelector('span');
  let tag = L && L.querySelector('.pane-tag');
  let badge = L && L.querySelector('.pane-badge');
  // one-tab: the bar's "Move to tab" button comes and goes with it.
  let key = [ctrl.className, pw && pw.className, msg && msg.textContent,
             badge && badge.textContent, tag && tag.className,
             document.body.classList.contains('one-tab') ? 1 : 0].join('\u0001');
  if (p._rcMeasured === key) return;
  if (!btn || !btn.offsetWidth) return;
  // Natural widths: .has-rc lets badge and tag shrink, so measure
  // without it (one extra layout, only when the key changed).
  let had = bar.classList.contains('has-rc');
  if (had) bar.classList.remove('has-rc');
  let px = el => { let cs = getComputedStyle(el); return el.offsetWidth + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0); };
  // The least a shrunk badge or tag still takes: the badge its dot, the
  // tag its padding.
  let floor = el => {
    if (el.classList.contains('pane-badge')) return 6;
    let cs = getComputedStyle(el);
    return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) +
           (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  };
  let side = (box, skip, least) => {
    let w = 0, n = 0;
    if (!box) return 0;
    for (let i = 0; i < box.children.length; i++) {
      let ch = box.children[i];
      if (!ch.getClientRects().length) continue;
      n++;
      if (skip(ch)) continue;
      w += least ? floor(ch) + px(ch) - ch.offsetWidth : px(ch);
    }
    return w + Math.max(0, n - 1) * 6;
  };
  // Label and a transfer's progress stretch; they have no floor either.
  let stretch = ch => ch.classList.contains('pane-label') || ch.classList.contains('upload-progress');
  let lc = side(L, stretch, false);
  let lf = side(L, stretch, true);
  let rc = side(R, () => false, false);
  let cs = getComputedStyle(ctrl);
  let cc = btn.offsetWidth + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0) +
           (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  if (pw && !pw.classList.contains('h')) cc += 48 + 6;
  if (msg && msg.textContent) cc += 6;
  if (had) bar.classList.add('has-rc');
  bar.style.setProperty('--rc-lc', lc + 'px');
  bar.style.setProperty('--rc-lf', lf + 'px');
  bar.style.setProperty('--rc-rc', rc + 'px');
  bar.style.setProperty('--rc-cc', cc + 'px');
  ctrl.style.setProperty('--rc-cc', cc + 'px');
  p._rcMeasured = key;
}
// The reconnect password input that has the focus, if one has.
function _focusedRcInput() {
  let a = document.activeElement;
  return (a && a.hasAttribute && a.hasAttribute('data-reconnect-pw')) ? a : null;
}
// Run fn (which moves panes or the control around) and give the focus
// back to the reconnect password input that had it before, if that
// input is still in the page and shown. Re-parenting an element drops
// its focus to <body>, and the pane moves end in term.focus(). `had`
// names that input when it was taken before the DOM changed
// (_destroyPane).
function _keepRcFocus(fn, had) {
  let inp = had || _focusedRcInput();
  try { return fn(); }
  finally {
    let ctrl = inp && inp.closest('[data-reconnect]');
    if (inp && document.body.contains(inp) && document.activeElement !== inp &&
        !inp.classList.contains('h') && ctrl && !ctrl.classList.contains('h')) {
      try { inp.focus(); } catch (e) {}
    }
  }
}

// The top-bar copy of the pane actions, for the active pane of the
// active tab when that tab is solo. Hidden with 2+ panes (each pane has
// its bar) and with no tab at all. Upload/download are disabled by the
// same rule as the pane's own buttons (updatePaneBadge).
//
// It also keeps body.one-tab, which hides every "Move to tab" button
// (here and in all pane bars, by CSS): with one tab there is nowhere to
// move to, and an impossible action is hidden, not disabled. So it must
// run whenever the number of tabs changes: createTab, removeTab,
// removeAllTabs (and showTab, which every move ends in).
function renderPaneTools() {
  let box = $('paneTools');
  if (!box) return;
  let t = activeTab();
  let p = activeId ? panes[activeId] : null;
  let show = !!(t && p && tabOfPane(p) === t && panesInTab(t).length === 1);
  let busy = !!(p && (p.upload || p.download));
  let tag = p && (p.host || p.connection) ? (p.persistent ? 'persistent' : 'ephemeral') : '';
  let one = tabs.length < 2;
  let key = (one ? '1' : '2') + '\u0002'
    + (show ? [p.id, p.sid ? 1 : 0, busy ? 1 : 0, tag].join('\u0001') : '');
  if (box._key === key) return;
  box._key = key;
  // The group takes width from the tab strip, and its width changes
  // after showTab scrolled the active tab into view (a new tab is shown
  // before its pane exists; the marker appears at connect). Scroll again
  // when it did. Runs only when the key changes, so the reflow is rare.
  let w0 = box.offsetWidth;
  let flip = document.body.classList.contains('one-tab') !== one;
  document.body.classList.toggle('one-tab', one);
  box.classList.toggle('h', !show);
  if (show) fillPaneTools(box, p, busy, tag);
  if (t && box.offsetWidth !== w0) scrollTabIntoView(t);
  // The pane bars lost or gained a button: a Reconnect control centred
  // in a bar on screen is measured again (_measureReconnect keys on
  // one-tab); the hidden tabs' bars are measured when shown.
  if (flip && t) panesInTab(t).forEach(placeReconnect);
}
function fillPaneTools(box, p, busy, tag) {
  let off = !p.sid || busy;
  box.querySelector('[data-act="upload"]').disabled = off;
  box.querySelector('[data-act="download"]').disabled = off;
  let tg = box.querySelector('.pane-tag');
  tg.className = 'pane-tag ' + tag + (tag ? '' : ' h');
  // The same words as a pane's own bar (updatePaneTag); the tooltip
  // says what they mean.
  tg.textContent = tag === 'persistent' ? 'persistent' : 'short-lived';
  tg.title = tag === 'persistent'
    ? 'This pane is wrapped in remote tmux and will survive browser refresh.'
    : 'This pane is NOT persistent — it will be lost on refresh.';
}
(function () {
  let box = $('paneTools');
  if (!box) return;
  box.addEventListener('click', e => {
    let b = e.target.closest && e.target.closest('[data-act]');
    if (!b || b.disabled || !activeId || !panes[activeId]) return;
    let id = activeId, act = b.getAttribute('data-act');
    if (act === 'upload') triggerUpload(id);
    else if (act === 'download') triggerDownload(id);
    else if (act === 'split-h') splitPane(id, 'h');
    else if (act === 'split-v') splitPane(id, 'v');
    else if (act === 'close') closePane(id);
    else if (act === 'move-to') openPaneMoveMenu(id, b);
  });
})();

// Output reached a pane whose tab is not on screen: mark the tab.
function noteTabActivity(p) {
  let root = p.el.closest && p.el.closest('.tab-root');
  if (!root || root.getAttribute('data-tab') === activeTabId) return;
  let t = tabById(root.getAttribute('data-tab'));
  if (!t || t.activity) return;
  t.activity = true;
  renderTab(t);
}

// "+": open the login form for a new tab. Nothing is created until the
// connect succeeds (materializeTarget); dismissing the form leaves the
// current tab as it was.
function newTab() {
  if (!Object.keys(panes).length) return;   // the initial form is up
  pendingSplit = null;
  overlayMode = 'tab';
  connectingFor = null;
  openConnectForm();
}

// Close a whole tab. Live persistent (tmux) panes are confirmed once for
// the tab, under the same "don't ask again" setting as closing a pane.
function _liveTmux(p) { return !!(p && p.persistent && p.sid && p.slotId); }
function closeTab(id) {
  let t = tabById(id);
  if (!t) return;
  let doClose = () => {
    if (tabs.indexOf(t) < 0) return;
    panesInTab(t).forEach(p => _destroyPane(p.id, _liveTmux(p)));
    if (tabs.indexOf(t) >= 0 && !panesInTab(t).length) { removeTab(t); saveSessions(); }
  };
  let live = panesInTab(t).filter(_liveTmux);
  if (!live.length || localStorage.getItem(TERMINATE_NO_ASK_KEY)) { doClose(); return; }
  let title = live.length === 1 ? null
    : 'Terminate ' + live.length + ' sessions in this tab?';
  showTerminateModal(live[0], neverAgain => {
    if (neverAgain) localStorage.setItem(TERMINATE_NO_ASK_KEY, '1');
    doClose();
  }, title);
}

// ── Moving panes between tabs ──────────────────────────────────────
// A pane moves by moving its element: out of its split (the sibling
// takes the space, as on close) and into another tab's root or split.
// Nothing else about the pane is touched - no connect or disconnect,
// no stream restart, no term.reset/dispose/open, the input queue and an
// upload in progress stay on `p` - because which tab a pane is in is
// read from the DOM (see ── Tabs). xterm keeps working in a re-parented
// element as long as it is not disposed. docs/invariants.md U5.
//
// Every move is synchronous from the first DOM change to saveSessions():
// the layout in localStorage never shows a half-done move, and the
// ResizeObserver only sees the final boxes (one fit, one resize per
// pane whose size changed; a pane left in a hidden tab is skipped, U1).
// renderTab runs for BOTH tabs (via showTab), so the solo state and the
// bars are right on each side (U4).

// Moving an element out of the document and back resets the scroll
// position of everything inside it - xterm's viewport jumps to 0 (the
// top of the scrollback) while xterm still shows, and believes it
// shows, the bottom; it does not put it back by itself (it caches the
// last value it set), so the scrollbar lied and the first wheel or
// drag on it threw the view to the top. Put it where xterm's buffer
// says it is. A pane in a hidden tab cannot be scrolled (display:none
// keeps a scroll position but cannot take one): showTab does it.
// Checked in Chromium 2026-10-01: display:none and back keeps the
// position; removeChild + appendChild loses it.
//
// The same lie comes from a display:none tab without any move: xterm
// 5.5's Viewport._innerRefresh (run on any output or resize) records
// the viewport's offsetHeight - 0 while hidden - and sizes the scroll
// area to rows*rowHeight + (offsetHeight - canvas height), i.e. one
// screen too short. Shown again (after a window resize or a merge)
// nothing may call it again before the first wheel: scrollTop is
// clamped a screen above the bottom, the first notch is eaten by the
// gap or jumps a screen. So the viewport's own refresh is re-run here,
// with the pane on screen and fitted (it re-reads offsetHeight, resizes
// the scroll area and sets scrollTop from the buffer); the arithmetic
// below is the fallback if that private method is gone. No PTY resize.
function _resyncScroll(p) {
  if (!p || !p.term || !p.term.element) return;
  if (paneHidden(p)) return;    // showTab resyncs every pane it shows
  try {
    let core = p.term._core && p.term._core.viewport;
    if (core && typeof core._innerRefresh === 'function') core._innerRefresh();
  } catch (e) {}
  try {
    let vp = p.term.element.querySelector('.xterm-viewport');
    let area = vp && vp.querySelector('.xterm-scroll-area');
    let buf = p.term.buffer && p.term.buffer.active;
    if (!vp || !area || !buf || !buf.length) return;
    let core = p.term._core && p.term._core.viewport;
    let rowH = (core && core._currentRowHeight) || (area.offsetHeight / buf.length);
    if (!(rowH > 0)) return;
    let top = Math.round(buf.viewportY * rowH);
    if (Math.abs(vp.scrollTop - top) > 1) vp.scrollTop = top;
  } catch (e) {}
}
// After a fit: now, and once more on the next frame - the renderer
// takes the new canvas size on its own frame, and the scroll area's
// height depends on it.
function _resyncScrollSoon(p) {
  _resyncScroll(p);
  requestAnimationFrame(() => { if (panes[p.id] === p) _resyncScroll(p); });
}

// Take a pane out of its layout: its split wrapper is replaced by the
// sibling, as _destroyPane does. Returns the tab it was in.
function _detachPane(p) {
  let t = tabOfPane(p);
  let wrap = p.el.parentNode;
  if (wrap && !wrap.classList.contains('tab-root')) {
    let sibling = null;
    for (let i = 0; i < wrap.children.length; i++) {
      let ch = wrap.children[i];
      if (ch !== p.el && !ch.classList.contains('split-handle')) { sibling = ch; break; }
    }
    if (sibling && wrap.parentNode) {
      _unwrapSplit(wrap, sibling);
      _panesUnder(sibling).forEach(_resyncScroll);
    }
  }
  if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
  p.el.style.flex = '';
  if (t && t.lastActive === p.id) {
    let ps = panesInTab(t);
    t.lastActive = ps.length ? ps[0].id : null;
  }
  return t;
}
// The panes in (or being) element `el`.
function _panesUnder(el) {
  let out = [];
  if (!el) return out;
  let list = el.classList.contains('pane') ? [el] : Array.prototype.slice.call(el.querySelectorAll('.pane'));
  list.forEach(e => { let p = panes[e.getAttribute('data-pane')]; if (p) out.push(p); });
  return out;
}
// The two halves of "a split or a close moves no other divider"
// (docs/invariants.md U9), shared by split, close, cancel and moves.
// A split wrapper replacing `anchor` takes the anchor's place and its
// share of the parent (inline flex); the anchor starts at an even half
// inside it. Returns the wrapper holding the anchor and the handle; the
// caller adds the other child.
function _wrapInSplit(anchor, dir) {
  let wrap = document.createElement('div');
  wrap.className = 'split-' + dir;
  wrap.style.flex = anchor.style.flex || '';
  anchor.style.flex = '';
  let handle = document.createElement('div');
  handle.className = 'split-handle';
  anchor.parentNode.replaceChild(wrap, anchor);
  wrap.appendChild(anchor);
  wrap.appendChild(handle);
  return wrap;
}
// A split collapsing to one child: the child takes the wrapper's place
// and inherits the wrapper's share of ITS parent.
function _unwrapSplit(wrap, sibling) {
  sibling.style.flex = wrap.style.flex || '';
  wrap.parentNode.replaceChild(sibling, wrap);
}
// Put `el` beside `anchor` in a new split ('h' or 'v'); `first` puts it
// before the anchor (left / top). The wrapper takes the anchor's place
// and its share of the parent.
function _placeBeside(anchor, el, dir, first) {
  let wrap = _wrapInSplit(anchor, dir);
  el.style.flex = '';
  if (first) wrap.insertBefore(el, wrap.firstChild);
  else wrap.appendChild(el);
}
// Show `t` with pane `id` active; the moved pane takes the focus. The
// element was out of the document for a moment, which blurs a focused
// terminal, so focus it even when it already was the active pane.
function _showAfterMove(t, id, moved) {
  if (panes[id]) t.lastActive = id;
  showTab(t.id, {noSave: true});
  let p = panes[id];
  if (p) {
    if (activeId !== id) activatePane(id);
    try { p.term.focus(); } catch (e) {}
  }
  (moved || []).forEach(_resyncScroll);
}
function _dropEmptyTab(t) {
  if (!t || tabs.indexOf(t) < 0 || panesInTab(t).length) return;
  if (activeTabId === t.id) activeTabId = null;   // the caller shows another
  removeTab(t);
}

// "Move to new tab": the pane leaves its split and becomes a tab of its
// own, shown. A pane alone in its tab already is one: nothing to do.
function movePaneToNewTab(id) {
  let p = panes[id];
  if (!p) return;
  let from = tabOfPane(p);
  if (!from || panesInTab(from).length < 2) return;
  _keepRcFocus(() => {
    _detachPane(p);
    let t = createTab();
    t.root.appendChild(p.el);
    _showAfterMove(t, id, [p]);
  });
  saveSessions();
}

// Where something joining tab `t` goes by default: beside its active
// pane (the last one if that is unknown).
function _tabAnchor(t) {
  let ps = panesInTab(t);
  let a = panes[t.lastActive];
  if (!a || ps.indexOf(a) < 0) a = ps[ps.length - 1] || null;
  return a;
}
// The pane joins tab `tabId`, split to the right of that tab's active
// pane - or, given `anchorId` (a pane of that tab) and `side`, on that
// side of that pane (a pane dragged onto a pane edge); that tab is shown
// with the moved pane active. A tab emptied by the move goes. The tab's
// name stays; the emptied tab's goes with it.
function movePaneToTab(id, tabId, anchorId, side) {
  let p = panes[id];
  let to = tabById(tabId);
  if (!p || !to) return;
  let from = tabOfPane(p);
  if (!from || from === to) return;
  let anchor = anchorId ? panes[anchorId] : null;
  if (!anchor || tabOfPane(anchor) !== to) anchor = _tabAnchor(to);
  if (['left', 'right', 'top', 'bottom'].indexOf(side) < 0) side = 'right';
  _keepRcFocus(() => {
    _detachPane(p);
    if (anchor) _placeBeside(anchor.el, p.el, (side === 'left' || side === 'right') ? 'h' : 'v',
                             side === 'left' || side === 'top');
    else to.root.appendChild(p.el);
    _dropEmptyTab(from);
    _showAfterMove(to, id, [p].concat(_panesUnder(anchor ? anchor.el : null)));
  });
  saveSessions();
}

// Tab `tabId`'s whole layout goes beside pane `paneId` (of another tab):
// side 'left'/'right' split horizontally, 'top'/'bottom' vertically;
// left/top put the merged layout first. The merged tab's handle and
// root go; its inner layout is kept as it was. The pane's tab is shown,
// with the merged tab's active pane active.
function mergeTabInto(tabId, paneId, side) {
  let src = tabById(tabId);
  let q = panes[paneId];
  if (!src || !q) return;
  let dst = tabOfPane(q);
  if (!dst || dst === src) return;
  if (['left', 'right', 'top', 'bottom'].indexOf(side) < 0) return;
  let node = _layoutNode(src.root);
  if (!node) return;
  let srcPanes = panesInTab(src);
  let focusId = (src.lastActive && srcPanes.indexOf(panes[src.lastActive]) >= 0)
    ? src.lastActive : (srcPanes[0] ? srcPanes[0].id : q.id);
  _keepRcFocus(() => {
    src.root.removeChild(node);
    _placeBeside(q.el, node, (side === 'left' || side === 'right') ? 'h' : 'v',
                 side === 'left' || side === 'top');
    _dropEmptyTab(src);
    _showAfterMove(dst, focusId, _panesUnder(node).concat([q]));
  });
  saveSessions();
}
// Tab `srcId`'s whole layout joins tab `dstId`, to the right of its
// active pane (where movePaneToTab puts a pane): "Move into tab" in a
// tab's menu. Nothing if either tab has gone meanwhile.
function mergeTabIntoTab(srcId, dstId) {
  let src = tabById(srcId), dst = tabById(dstId);
  if (!src || !dst || src === dst) return;
  let anchor = _tabAnchor(dst);
  if (anchor) mergeTabInto(src.id, anchor.id, 'right');
}

// Dragging a pane by its bar's label onto the strip: onto a tab - the
// pane joins it; onto the strip around the tabs or "+" - a new tab.
// Resting on a tab brings it forward (spring-loaded, see endTabDrag);
// then an edge of one of its panes takes the pane on that side, with
// the same half highlighted as for a tab drag. Its own tab's panes are
// no target. Anywhere else (outside the window) nothing happens, and the
// tab that was in front at the press comes back. Mouse events only, as for tabs: an HTML5 drag would look
// like a file to wirePaneDrop, and an OS file drag never starts this.
let _paneDrag = null;
function _paneDropTarget(pt) {
  if (pt.outside || pt.inPanes || !pt.el || !pt.el.closest) return null;
  let tabEl = pt.el.closest('#tabs .tab');
  if (tabEl) return {kind: 'tab', el: tabEl, tabId: tabEl.getAttribute('data-tab')};
  let nb = pt.el.closest('#tabNew');
  if (nb) return {kind: 'new', el: nb};
  let strip = pt.el.closest('#tabs');
  if (strip) return {kind: 'new', el: strip};
  // The free room of the top bar after "+" belongs to the strip too.
  if (pt.el.classList && pt.el.classList.contains('top')) return {kind: 'new', el: $('tabs')};
  return null;
}
function _clearPaneDropMarks() {
  document.querySelectorAll('.tab.drop-into,.drop-new')
    .forEach(el => el.classList.remove('drop-into', 'drop-new'));
}
document.addEventListener('mousedown', e => {
  if (e.button !== 0 || !e.target || !e.target.closest) return;
  let label = e.target.closest('.pane-label');
  if (!label) return;
  let pel = label.closest('.pane');
  let p = pel ? panes[pel.getAttribute('data-pane')] : null;
  if (!p) return;
  e.preventDefault();          // no text selection of the label
  _paneDrag = {p: p, x0: e.clientX, y0: e.clientY, moved: false,
               front: activeTabId, spring: null, sprung: false, zone: null};
}, true);
// A pane of the tab on screen, not of the dragged pane's own tab, and
// the side of it under the pointer.
function _panePaneTarget(d, pt, e) {
  if (!pt.inPanes || !pt.el || !pt.el.closest) return null;
  let pel = pt.el.closest('.pane');
  let q = pel ? panes[pel.getAttribute('data-pane')] : null;
  if (!q || q === d.p) return null;
  let tq = tabOfPane(q);
  if (!tq || tq.id !== activeTabId || tq === tabOfPane(d.p)) return null;
  let side = _dropSide(pel, e.clientX, e.clientY);
  return side ? {p: q, side: side} : null;
}
document.addEventListener('mousemove', e => {
  let d = _paneDrag;
  if (!d) return;
  if ((e.buttons & 1) === 0) { _endPaneDrag(null); return; }
  if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_START_PX
      && Math.abs(e.clientY - d.y0) < DRAG_START_PX) return;
  if (!d.moved) { d.moved = true; document.body.classList.add('pane-moving'); }
  let pt = _dragPoint(e);
  let tg = _paneDropTarget(pt);
  _clearPaneDropMarks();
  if (tg && tg.kind === 'tab') {
    let own = tabOfPane(d.p);
    if (!own || own.id !== tg.tabId) tg.el.classList.add('drop-into');
  } else if (tg) tg.el.classList.add('drop-new');
  let zt = _panePaneTarget(d, pt, e);
  let cls = zt ? 'drop-zone-' + zt.side : null;
  if (!zt || !d.zone || d.zone.p !== zt.p || d.zone.cls !== cls) {
    clearDropZones();
    if (zt) zt.p.el.classList.add(cls);
  }
  d.zone = zt ? {p: zt.p, cls: cls} : null;
  _springTrack(d, pt, e);
});
document.addEventListener('mouseup', e => _endPaneDrag(e));
function _endPaneDrag(e) {
  let d = _paneDrag;
  _paneDrag = null;
  if (!d) return;
  _springCancel(d);
  _clearPaneDropMarks();
  clearDropZones();
  if (!d.moved) return;
  document.body.classList.remove('pane-moving');
  _blockClickAfterDrag();
  if (!e || !panes[d.p.id]) { _springBack(d); return; }
  let pt = _dragPoint(e);
  let tg = _paneDropTarget(pt);
  let zt = tg ? null : _panePaneTarget(d, pt, e);
  let own = tabOfPane(d.p);
  if (tg && tg.kind === 'tab') {
    if (own && own.id === tg.tabId) _springBack(d);
    else movePaneToTab(d.p.id, tg.tabId);
  } else if (tg) {
    if (own && panesInTab(own).length < 2) _springBack(d);   // already a tab of its own
    else movePaneToNewTab(d.p.id);
  } else if (zt) movePaneToTab(d.p.id, tabOfPane(zt.p).id, zt.p.id, zt.side);
  else _springBack(d);
}

// Strip: a vertical wheel scrolls it sideways when it overflows.
(function () {
  let strip = $('tabs');
  if (!strip) return;
  strip.addEventListener('wheel', e => {
    if (strip.scrollWidth <= strip.clientWidth || !e.deltaY || e.deltaX) return;
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  }, {passive: false});
})();

// ── Menus: a tab's context menu, a pane's "Move to tab" ──
// One menu at a time ([role=menu] of [role=menuitem] buttons), plus at
// most one submenu beside it. Opened by a right-click on a tab or the
// pane's move button; the first item takes the focus, so the keys go to
// the menu, not the shell: arrows move, Enter/Space choose, ArrowRight
// opens a submenu and ArrowLeft leaves it, Escape or Tab closes, as
// does a press anywhere outside. Items are text (textContent): a tab
// title is shown as typed. Every action re-checks that its tab and pane
// still exist - the menu may have been open while they closed.
let _menus = [];
function closeMenus(refocus) {
  if (!_menus.length) return;
  _menus.forEach(m => { if (m.parentNode) m.parentNode.removeChild(m); });
  _menus = [];
  if (refocus) { let p = panes[activeId]; if (p) { try { p.term.focus(); } catch (e) {} } }
}
function _menuItemsOf(m) {
  return Array.prototype.slice.call(m.querySelectorAll('[role="menuitem"]'));
}
function _buildMenu(items, label, level) {
  let m = document.createElement('div');
  m.className = 'ws-menu';
  m.setAttribute('role', 'menu');
  if (label) m.setAttribute('aria-label', label);
  m._level = level;
  items.forEach(it => {
    let b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    if (it.icon) b.insertAdjacentHTML('beforeend', ic(it.icon));
    let s = document.createElement('span');
    s.className = 'mi-label';
    s.textContent = it.label;
    b.appendChild(s);
    if (it.sub) {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.insertAdjacentHTML('beforeend', '<span class="mi-sub" aria-hidden="true">\u203a</span>');
    }
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    if (it.danger) b.classList.add('danger');
    b._mi = it;
    m.appendChild(b);
  });
  m.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  m.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
  m.addEventListener('click', e => {
    e.stopPropagation();
    let b = e.target.closest && e.target.closest('[role="menuitem"]');
    if (b) _menuChoose(b);
  });
  m.addEventListener('mouseover', e => {
    let b = e.target.closest && e.target.closest('[role="menuitem"]');
    if (!b) return;
    try { b.focus(); } catch (err) {}
    if (m._level !== 0) return;
    if (b._mi.sub && !b._mi.disabled) { if (!_menus[1] || _menus[1]._parentItem !== b) _openSubmenu(b, false); }
    else _closeSubmenu();
  });
  m.addEventListener('keydown', _menuKey);
  document.body.appendChild(m);
  return m;
}
function _placeMenu(m, x, y, altX) {
  let w = window.innerWidth || document.documentElement.clientWidth || 0;
  let h = window.innerHeight || document.documentElement.clientHeight || 0;
  let r = m.getBoundingClientRect();
  if (w && x + r.width > w - 4) x = (altX != null) ? altX - r.width : w - 4 - r.width;
  if (h && y + r.height > h - 4) y = h - 4 - r.height;
  m.style.left = Math.max(4, Math.round(x)) + 'px';
  m.style.top = Math.max(4, Math.round(y)) + 'px';
}
function _focusItem(m, i) {
  let its = _menuItemsOf(m);
  if (!its.length) return;
  i = ((i % its.length) + its.length) % its.length;
  try { its[i].focus(); } catch (e) {}
}
function openMenu(items, x, y, label) {
  closeMenus(false);
  let m = _buildMenu(items, label, 0);
  _menus = [m];
  _placeMenu(m, x, y);
  let its = _menuItemsOf(m);
  let first = its.findIndex(b => !b._mi.disabled);
  _focusItem(m, first < 0 ? 0 : first);
  return m;
}
function _closeSubmenu() {
  let sub = _menus[1];
  if (!sub) return;
  if (sub.parentNode) sub.parentNode.removeChild(sub);
  if (sub._parentItem) sub._parentItem.setAttribute('aria-expanded', 'false');
  _menus.length = 1;
}
function _openSubmenu(b, focus) {
  _closeSubmenu();
  let items = b._mi.sub() || [];
  if (!items.length) items = [{label: 'No other tabs', disabled: true}];
  let sub = _buildMenu(items, b._mi.label, 1);
  sub._parentItem = b;
  b.setAttribute('aria-expanded', 'true');
  _menus[1] = sub;
  let r = b.getBoundingClientRect();
  _placeMenu(sub, r.right + 2, r.top - 5, r.left - 2);
  if (focus) _focusItem(sub, 0);
}
function _menuChoose(b) {
  let it = b._mi;
  if (!it || it.disabled) return;
  if (it.sub) { _openSubmenu(b, true); return; }
  closeMenus(false);
  if (it.act) it.act();
}
function _menuKey(e) {
  let m = e.currentTarget;
  let its = _menuItemsOf(m);
  let i = its.indexOf(document.activeElement);
  let k = e.key;
  let handled = true;
  if (k === 'ArrowDown') _focusItem(m, i + 1);
  else if (k === 'ArrowUp') _focusItem(m, i < 0 ? -1 : i - 1);
  else if (k === 'Home') _focusItem(m, 0);
  else if (k === 'End') _focusItem(m, -1);
  else if (k === 'Enter' || k === ' ') { if (its[i]) _menuChoose(its[i]); }
  else if (k === 'ArrowRight') { if (its[i] && its[i]._mi.sub && !its[i]._mi.disabled) _openSubmenu(its[i], true); }
  else if (k === 'ArrowLeft') {
    if (m._level === 1) { let pb = m._parentItem; _closeSubmenu(); if (pb) { try { pb.focus(); } catch (err) {} } }
  }
  else if (k === 'Escape' || k === 'Tab') closeMenus(true);
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}
document.addEventListener('mousedown', e => {
  if (!_menus.length) return;
  for (let i = 0; i < _menus.length; i++) if (_menus[i].contains(e.target)) return;
  closeMenus(false);
}, true);
window.addEventListener('resize', () => closeMenus(false));
window.addEventListener('blur', () => closeMenus(false));

// A tab's menu: rename it, put its whole layout into another tab (to
// the right of that tab's active pane, as the pane move does), close it.
function openTabMenu(t, x, y) {
  // With one tab there is no tab to move into: the item is left out.
  let items = [{label: 'Rename', icon: 'pencil', act: () => startTabRename(t.id)}];
  if (tabs.length > 1) items.push(
    {label: 'Move into tab', icon: 'move-to',
     sub: () => tabs.filter(o => o !== t).map(o => ({
       label: tabTitle(o) || 'Tab ' + (tabs.indexOf(o) + 1),
       act: () => { if (tabs.indexOf(t) >= 0) mergeTabIntoTab(t.id, o.id); }}))});
  items.push({label: 'Close tab', icon: 'close', danger: true,
     act: () => { if (tabs.indexOf(t) >= 0) closeTab(t.id); }});
  openMenu(items, x, y, 'Tab');
}
// The pane's move button (its bar, or #paneTools for a lone pane): the
// other tabs; the pane goes to the right of the chosen tab's active pane.
// The button is hidden with one tab (body.one-tab, renderPaneTools);
// "No other tabs" is only a guard.
function openPaneMoveMenu(id, btn) {
  let p = panes[id];
  if (!p) return;
  let own = tabOfPane(p);
  let items = tabs.filter(o => o !== own).map(o => ({
    label: tabTitle(o) || 'Tab ' + (tabs.indexOf(o) + 1),
    act: () => { if (panes[id] && tabs.indexOf(o) >= 0) movePaneToTab(id, o.id); }}));
  if (!items.length) items = [{label: 'No other tabs', disabled: true}];
  let r = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : {left: 0, bottom: 0};
  openMenu(items, r.left, r.bottom + 2, 'Move to tab')._pane = id;
}

// ── Split / Close ───────────────────────────────────────────────────
// Split does NOT mutate the DOM. It records the intent and opens the
// login form. The new pane is materialized only on successful connect
// (materializeTarget). Refreshing before connecting leaves layout intact.
function splitPane(id, dir) {
  if (!panes[id]) return;
  pendingSplit = {fromId: id, dir: dir};
  overlayMode = 'split';
  connectingFor = null;
  openConnectForm();
}

// Open the login form for a new pane ('split' or 'tab' overlay mode set
// by the caller).
function openConnectForm() {
  // Auto-connect shortcut for a single ready host — materialize happens
  // inside connectByName via materializeTarget.
  if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1
      && serverConfig.connections[0].kind !== 'prompt') {
    connectByName(serverConfig.connections[0].name);
    return;
  }

  if (selectedPrompt) clearPromptSelection();
  showOverlay();
  if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1
      && serverConfig.connections[0].kind === 'prompt') {
    selectPromptConnection(serverConfig.connections[0].name);
  }
  renderSaved();
}

// Materialize a new pane for the pending 'initial' or 'split' overlay
// mode. Creates the DOM + term, places it in the layout, returns it.
// For 'reauth'/null mode, returns the existing target pane.
function materializeTarget() {
  if (overlayMode === 'initial' || overlayMode === 'tab') {
    // A new tab, shown before the pane is created in it so the pane is
    // fitted to a real box from the start. 'initial' reuses an empty
    // tab if one is somehow left over.
    let t = (overlayMode === 'initial' && tabs.length === 1 && !panesInTab(tabs[0]).length)
      ? tabs[0] : createTab();
    showTab(t.id);
    let np = createPane(t.root);
    activatePane(np.id);
    connectingFor = np.id;
    renderTab(t);
    return np;
  }
  if (overlayMode === 'split' && pendingSplit) {
    let from = panes[pendingSplit.fromId];
    if (!from) { pendingSplit = null; return targetPane(); }
    // The new split keeps the pane's share of its parent (U9).
    let wrap = _wrapInSplit(from.el, pendingSplit.dir);
    let np = createPane(wrap);
    activatePane(np.id);
    connectingFor = np.id;
    pendingSplit = null;
    renderTab(tabOfPane(np));
    return np;
  }
  return targetPane();
}

function cancelConnect() {
  if (!overlayDismissable()) return;
  // Abort any in-flight runConnect and dismiss the status popup so
  // closing the form takes the ongoing attempt with it.
  if (currentConnectRun) {
    currentConnectRun.cancelled = true;
    cleanupRun(currentConnectRun);
    currentConnectRun = null;
  }
  $('tmuxOv').classList.add('h');
  let np = connectingFor ? panes[connectingFor] : null;
  // If we got as far as materializing a pane for this overlay session
  // (user clicked Connect, auth failed, form stayed open, user now
  // dismisses), remove it. For pure intent (no materialize yet) there's
  // nothing to clean up.
  if (np && !np.sid && (overlayMode === 'initial' || overlayMode === 'split' || overlayMode === 'tab')) {
    let wrap = np.el.parentNode;
    if (wrap && wrap.classList.contains('tab-root')) {
      // Initial / new-tab case: the pane sits directly in its tab's
      // root - the tab goes with it.
      let t = tabOfPane(np);
      np.term.dispose();
      delete panes[np.id];
      np.el.remove();
      if (t && !panesInTab(t).length) removeTab(t);
    } else if (wrap) {
      // Split case: unwrap and restore the sibling.
      let t = tabOfPane(np);
      let parent = wrap.parentNode;
      let sibling = null;
      for (let i=0; i<wrap.children.length; i++) {
        let ch = wrap.children[i];
        if (ch !== np.el && ch.classList.contains('pane')) { sibling = ch; break; }
        if (ch !== np.el && (ch.classList.contains('split-h') || ch.classList.contains('split-v'))) { sibling = ch; break; }
      }
      np.term.dispose();
      delete panes[np.id];
      if (sibling && parent) _unwrapSplit(wrap, sibling);   // keeps its share (U9)
      renderTab(t);   // back to one pane: its bar goes again
    }
    saveSessions();
  }
  pendingSplit = null;
  overlayMode = null;
  connectingFor = null;
  hideOverlay();
  let t = activeTab();
  if (t && !panes[activeId]) {
    let ps = panesInTab(t);
    if (ps.length) activatePane(ps[ps.length - 1].id);
  }
}

// User-facing close. Persistent panes with a live tmux session need a
// confirmation step (and a kill-on-server) so we don't quietly leak a
// remote tmux that the UI can no longer reach.
const TERMINATE_NO_ASK_KEY = 'websh_terminate_no_ask';

function closePane(id) {
  let p = panes[id];
  if (!p) return;
  let liveTmux = !!(p.persistent && p.sid && p.slotId);
  if (!liveTmux) { _destroyPane(id, false); return; }
  if (localStorage.getItem(TERMINATE_NO_ASK_KEY)) {
    _destroyPane(id, true);
    return;
  }
  showTerminateModal(p, neverAgain => {
    if (neverAgain) localStorage.setItem(TERMINATE_NO_ASK_KEY, '1');
    _destroyPane(id, true);
  });
}

function _destroyPane(id, terminate) {
  let p = panes[id];
  if (!p) return;
  if (_menus[0] && _menus[0]._pane === id) closeMenus(false);   // its "Move to tab" menu
  // Drop any sessionStorage secrets first — the pane is going away,
  // and so should its plaintext SSH credentials. Vault panes have no
  // entry here; the call is a no-op for them.
  _deletePaneSecret(id);
  // Cancel active transfers
  if (p.upload) { p.upload.cancelled = true; closeUploadSession(p.upload); }
  if (p.download) { p.download.cancelled = true; if (p.download.abort) p.download.abort(); }
  // CURSOR_HIDE: drop any pending onCursorMove subscription / timer
  // pointing at the term we're about to dispose.
  _cancelDragBlurArm(p);
  // fitPaneWhenStable safety-valve timer. Without clearing it here, a
  // pane closed mid-settle keeps the 10 s closure (and its `p` ref)
  // alive until the timer fires — harmless because `panes[p.id] !== p`
  // bails on each step, but a leak under rapid open/close churn.
  if (p._stuckTimer) {
    clearTimeout(p._stuckTimer);
    p._stuckTimer = null;
  }
  // Deferred-save timer (scheduleSaveCommit): same rationale as the
  // _stuckTimer above. The p.sid guard inside the timer would NOT catch
  // a pane closed mid-window — _destroyPane leaves p.sid set (it only
  // reads it for the disconnect body) — so without this a Save ticked
  // then aborted by closing the pane within SAVE_COMMIT_DELAY_MS would
  // still POST and add a card. Clearing it also drops the closure's `p` ref.
  clearTimeout(p.saveCommitTimer);
  p._fitInFlight = false;
  p._pendingSettled = [];     // nothing to resume on a destroyed pane
  clearInterval(p._reconnTimer); p._reconnTimer = null;
  // Disconnect main session
  if (p.sid) {
    p.polling = false;
    stopKeepalive(p);
    closeStream(p);
    abortPoll(p);
    p.outGen = (p.outGen || 0) + 1;
    let body = {session_id: p.sid};
    if (terminate) body.terminate = true;
    api('disconnect', {body: body}).catch(() => {});
  }
  p.term.dispose();

  let wrap = p.el.parentNode;
  let tab = tabOfPane(p);
  delete panes[id];

  // No panes left → back to the initial-login flow. No pane is
  // materialized yet; the form drives creation on submit.
  if (!Object.keys(panes).length) {
    removeAllTabs();
    overlayMode = 'initial';
    pendingSplit = null;
    connectingFor = null;
    showOverlay();
    renderSaved();
    saveSessions();
    return;
  }

  // The tab's last pane: the tab goes, and if it was in front, its
  // right (else left) neighbour comes forward.
  if (wrap && wrap.classList.contains('tab-root')) {
    p.el.remove();
    if (tab) removeTab(tab);
    fitVisiblePanes();
    saveSessions();
    return;
  }

  // Unwrap: replace split container with the remaining child. The
  // remaining pane is re-parented: a focused reconnect password input
  // in it would drop its focus to <body> (_keepRcFocus puts it back).
  let rcInp = _focusedRcInput();
  let sibling = null;
  for (let i=0; i<wrap.children.length; i++) {
    let ch = wrap.children[i];
    if (ch !== p.el && !ch.classList.contains('split-handle')) { sibling = ch; break; }
  }
  if (sibling && wrap.parentNode) {
    _unwrapSplit(wrap, sibling);   // takes the split's share (U9)
  } else {
    p.el.remove();
  }

  // Activate another pane of the same tab - only if the closed one was
  // the active pane (closing a pane of a background tab changes nothing
  // in front).
  if (activeId === id && tab) {
    let ps = panesInTab(tab);
    if (ps.length) activatePane(ps[0].id);
  }
  if (tab) {
    if (tab.lastActive === id) { let ps = panesInTab(tab); tab.lastActive = ps.length ? ps[0].id : null; }
    renderTab(tab);
  }

  // Refit the terminals on screen after the layout change
  fitVisiblePanes();
  if (rcInp) _keepRcFocus(() => {}, rcInp);
  saveSessions();
}

// ── Per-pane session helpers ────────────────────────────────────────
function startKeepalive(p) {
  stopKeepalive(p);
  // Empty input bumps the server's last_activity, so sessions stay alive
  // as long as any tab is open. When the tab closes the interval stops
  // and the server's idle timeout reaps the PTY normally.
  p.keepaliveTimer = setInterval(() => {
    let sid = p.sid;
    if (sid) api('input', {body: {session_id: sid, data: ''}})
      .then(r => { if (!inputSaysSessionGone(p, r, sid)) noteServerCursor(p, r, sid); })
      .catch(() => {});
  }, 30000);
}
// /api/input answering 404 is the server saying this session is gone
// (idle-expired, backend restarted). Act on it as the output loop would
// - persistent panes re-attach, others reconnect: a background tab whose
// stream had stalled kept pinging a dead session once a minute for hours,
// and keys typed into it vanished without a word.
function inputSaysSessionGone(p, r, sid) {
  if (r && r._status === 404 && r.error && p.sid === sid) {
    handleOutputPayload(p, r, sid);
    return true;
  }
  return false;
}

function stopKeepalive(p) {
  if(p.keepaliveTimer){ clearInterval(p.keepaliveTimer); p.keepaliveTimer=null }
}

// ── Pane secret storage (sessionStorage, manual/named panes) ────────
// localStorage[websh_panes] persists layout + non-secret pane metadata
// across browser restarts. SSH plaintext (passwords, key PEMs, key
// passphrases) for manual or prompt-kind connections lives in
// sessionStorage instead — it survives F5 within a tab but doesn't
// land in long-term profile storage (browser-history sync, FDE
// snapshots) and is gone after a tab close. See docs/encryption.md
// for the precise property ("never in long-term profile storage; brief
// crash-recovery shadow during a live session"). Vault-backed panes
// don't use this map; their credentials live on the server.
const SS_PANE_SECRETS_KEY = 'websh_panes_session';
function _loadPaneSecrets() {
  try { return JSON.parse(sessionStorage.getItem(storageKey(SS_PANE_SECRETS_KEY)) || '{}'); }
  catch (e) { return {}; }
}
function _savePaneSecrets(map) {
  try { sessionStorage.setItem(storageKey(SS_PANE_SECRETS_KEY), JSON.stringify(map)); }
  catch (e) {}
}
function _setPaneSecret(uuid, secrets) {
  // No-op if nothing to store — avoid creating empty rows that later
  // F5 would re-read as "secrets exist but are empty."
  if (!secrets || (!secrets.password && !secrets.key && !secrets.key_pass)) {
    return _deletePaneSecret(uuid);
  }
  let m = _loadPaneSecrets();
  m[uuid] = secrets;
  _savePaneSecrets(m);
}
function _getPaneSecret(uuid) { return _loadPaneSecrets()[uuid] || null; }
function _deletePaneSecret(uuid) {
  let m = _loadPaneSecrets();
  if (!(uuid in m)) return;
  delete m[uuid];
  _savePaneSecrets(m);
}

// ── Reconnect ────────────────────────────────────────────────────────
// For manual / named panes whose in-memory password was lost (fresh-tab
// F5 with empty sessionStorage, or _maybeAutoDropLegacy on the source
// saved card before they cliked reconnect), we expose an inline password
// input in the Reconnect control (in the pane's bar, or a lone pane's
// strip - placeReconnect) so the user can recover in place without opening the
// full connect form. Vault-backed panes follow the "no_vault_key" path
// instead (their fix is sign-in, not a typed password). Key-auth panes
// fall back to "Reconnect" only (a multi-line key blob doesn't fit a bar
// input; user opens a new pane to re-enter the key).
function _needsReconnectPwInput(p, reason) {
  if (!p || reason === 'no_vault_key') return false;
  if (p.conn_id) return false;             // vault-backed: different recovery
  if (p.auth === 'key') return false;      // key auth: bar input too narrow
  if (p.password || p.key) return false;   // creds already in memory
  return !!(p.host || p.connection);
}
function showReconnectBar(p, reason) {
  let bar = p.el.querySelector('[data-reconnect]');
  if (!bar) return;
  let msg = bar.querySelector('span');
  let pwInput = bar.querySelector('input[type=password]');
  let showInput = _needsReconnectPwInput(p, reason);
  // Severity drives the control's coloured edge; a plain drop gets none.
  bar.classList.remove('sev-err', 'sev-warn');
  if (msg) {
    if (reason === 'auth_failed') {
      msg.textContent = showInput ? 'Authentication failed — type password' : 'Authentication failed';
      msg.style.color = 'var(--dg)';
      bar.classList.add('sev-err');
    } else if (reason === 'no_vault_key') {
      // Distinct from auth-fail (creds rejected): the encryption key
      // that wraps this pane's saved creds is missing in this browser.
      // Clicking "Reconnect" loops back into connectPane which will
      // hit the same guard and re-show this bar — that's intentional;
      // the user needs to sign in again on this browser to recover.
      msg.textContent = 'Vault key missing — sign in again to recover';
      msg.style.color = 'var(--wn)';
      bar.classList.add('sev-warn');
    } else {
      // The pane badge already says "Disconnected"; repeating it here in
      // red just doubled the alarm. Say only what the control adds - what
      // to do next - and let the lone Reconnect button speak for itself.
      msg.textContent = showInput ? 'Type the password to reconnect' : '';
      msg.style.color = 'var(--dim)';
    }
  }
  if (pwInput) {
    pwInput.classList.toggle('h', !showInput);
    if (showInput) {
      pwInput.value = '';
      // Auto-focus when the bar is revealing the input for the first
      // time so the user can start typing immediately.
      setTimeout(() => { try { pwInput.focus(); } catch(e){} }, 0);
    }
  }
  // Nothing but the button left? Then it is the bare button (.bare);
  // the message and the password input come back as soon as there is
  // something to say or type. Then put the control where it belongs
  // (bar or strip) - after the classes, which decide its width.
  bar.classList.toggle('bare',
    !(msg && msg.textContent) && !(pwInput && !pwInput.classList.contains('h')));
  bar.classList.remove('h');
  placeReconnect(p);
}
function hideReconnectBar(p) {
  let bar = p.el.querySelector('[data-reconnect]');
  if (bar) { bar.classList.add('h'); placeReconnect(p); }
}
function reconnectPane(id) {
  let p = panes[id]; if (!p || (!p.host && !p.connection)) return;
  let bar = p.el.querySelector('[data-reconnect]');
  let pwInput = bar && bar.querySelector('input[type=password]');
  // Inline password recovery: if the input is showing and the user
  // typed something, feed it into connectPane as opts.password.
  // Empty input → focus and wait for them to type.
  if (pwInput && !pwInput.classList.contains('h')) {
    let typed = pwInput.value || '';
    if (!typed) { try { pwInput.focus(); } catch(e){} return; }
    hideReconnectBar(p);
    connectPane(p, {label: p.label, resume: p.persistent, password: typed});
    return;
  }
  hideReconnectBar(p);
  connectPane(p, {label: p.label, resume: p.persistent});
}
// ── Session persistence (localStorage) ──────────────────────────────
// Persistent panes wrap their remote shell in tmux; on refresh we resume
// by slot_id so the layout + running processes come back intact. Layout
// tree is serialized from the DOM so we can rebuild splits verbatim.
//
// Manifest versions:
//   1  legacy key `websh_manifest` (slots + connect bodies), migrated.
//   2  {version, layout, panes}: one layout, no tabs.
//   3  {version, tabs: [{layout, active}], active, panes}: one layout per
//      tab in strip order; `active` is the index of the tab in front,
//      a tab's `active` the id of its last active pane, its optional
//      `name` what the user called it (absent: the automatic title).
//      Version 2 (and 1) load as one tab holding that layout.
const PANES_KEY = 'websh_panes';
const PANES_VERSION = 3;

function slotIdFor(user, host, port) {
  // Human-readable + unique. Sanitize to backend's [A-Za-z0-9_-]{1,64}.
  // The random suffix is what makes two panes to the same target two
  // tmux sessions, so it is never the part that gets cut: truncating the
  // whole string to 64 chars dropped the suffix (and the port) for a
  // long user@host, every persistent pane for it got the same slot, and
  // opening a second one attached to - and detached - the first one's
  // shell. Shorten the readable part instead.
  let base = ((user || 'u') + '_' + (host || 'h') + '_' + (port || 22))
    .replace(/[^A-Za-z0-9_-]/g, '_');
  let rand = '';
  while (rand.length < 8) rand += Math.random().toString(36).slice(2);
  rand = rand.slice(0, 8);
  return base.slice(0, 64 - 1 - rand.length) + '_' + rand;
}

function paneRecord(p) {
  // Disk-safe per-pane record persisted into localStorage. Vault panes
  // store conn_id + display-hint metadata, no key bytes — F5 restore
  // re-derives vault_key from IDB. Manual and named panes still inline
  // plaintext for backward compatibility (manual moves to
  // sessionStorage in the next task).
  if (!p.host && !p.connection && !p.conn_id) return null;
  let rec = {
    label:      p.label || '',
    persistent: !!p.persistent,
    slot_id:    p.slotId || null,
    tmux_cmd:   p.tmuxCmd || 'tmux',
    cols:       p.term.cols,
    rows:       p.term.rows,
  };
  if (p.conn_id) {
    rec.via = 'vault';
    rec.conn_id = p.conn_id;
    // host/port/user persisted as UX hints (badge text + slot id);
    // server fetches the real values from the stored vault record.
    rec.host = p.host || '';
    rec.port = p.port || 22;
    rec.user = p.user || '';
    // The prompt connection this card was saved from, if any. Sent as an
    // authorization disambiguation hint; the server only honours it when it
    // matches the card's stored host:port (so it can't escalate).
    rec.connection = p.connection || null;
  } else if (p.connection) {
    rec.via = 'named';
    rec.connection = p.connection;
    rec.user = p.user || '';
    rec.auth = p.auth || (p.key ? 'key' : 'pw');
    // Plaintext lives in sessionStorage (_setPaneSecret on materialise,
    // _getPaneSecret on restore). Only prompt-kind named connections
    // need a password client-side anyway; ready-kind connections rely
    // on websh.json server-side.
  } else {
    rec.via = 'manual';
    rec.host = p.host;
    rec.port = p.port;
    rec.user = p.user;
    rec.auth = p.auth || (p.key ? 'key' : 'pw');
    // Plaintext moved to sessionStorage — see _setPaneSecret().
  }
  return rec;
}

function buildConnectBody(rec, termCols, termRows) {
  // Translate a pane record into the shape server.py /api/connect wants.
  // Saved-variant: ship the vault tuple; server pulls host/username
  // from the stored record, decrypts the blob with vault_key, and
  // proceeds with ssh. Cols/rows/persistent/slot_id/tmux options still
  // flow through (server-side they apply identically to manual mode).
  if (rec.vault_id && rec.conn_id && rec.vault_key) {
    let b = {
      vault_id: rec.vault_id,
      conn_id:  rec.conn_id,
      vault_key: rec.vault_key,
      cols: termCols || rec.cols || 80,
      rows: termRows || rec.rows || 24,
    };
    if (rec.persistent) {
      b.persistent = true;
      b.slot_id = rec.slot_id || slotIdFor(rec.user, rec.host, rec.port);
      b.tmux_set_clipboard = !!settings.tmuxClipboard;
      let hl = parseInt(settings.tmuxHistory, 10);
      if (Number.isFinite(hl) && hl >= 100) b.tmux_history_limit = hl;
    }
    if (rec.tmux_cmd && rec.tmux_cmd !== 'tmux') b.tmux_cmd = rec.tmux_cmd;
    // Connection-name hint: lets the server authorize the card against the
    // exact prompt connection it was saved from (rename/duplicate-safe),
    // falling back to host:port matching when absent. See
    // _resolve_saved_card_connection in server.py.
    if (rec.connection) b.connection = rec.connection;
    return b;
  }
  let b = {
    username: rec.user,
    cols: termCols || rec.cols || 80,
    rows: termRows || rec.rows || 24
  };
  if (rec.connection) b.connection = rec.connection;
  else { b.host = rec.host; b.port = rec.port || 22; }
  if (rec.auth === 'key') {
    if (rec.key) b.key = rec.key;
    if (rec.key_pass) b.password = rec.key_pass;
  } else if (rec.password) {
    b.password = rec.password;
  }
  if (rec.persistent) {
    b.persistent = true;
    b.slot_id = rec.slot_id || slotIdFor(rec.user, rec.host, rec.port);
    // tmux options from local settings, applied on every connect/resume.
    // Server validates against an allow-list, so unexpected values are
    // dropped silently rather than fail the connect. Mouse is hardcoded
    // on the server side (no user-facing toggle).
    b.tmux_set_clipboard = !!settings.tmuxClipboard;
    let hl = parseInt(settings.tmuxHistory, 10);
    if (Number.isFinite(hl) && hl >= 100) b.tmux_history_limit = hl;
  }
  if (rec.tmux_cmd && rec.tmux_cmd !== 'tmux') b.tmux_cmd = rec.tmux_cmd;
  return b;
}

function serializeLayout(rootEl) {
  // rootEl is a tab's root; walk its single child (pane or split wrapper).
  let first = _layoutNode(rootEl);
  return first ? serializeNode(first) : null;
}
function serializeNode(el) {
  let flex = el.style.flex || '';
  if (el.classList.contains('pane')) {
    return {type: 'leaf', pane: el.getAttribute('data-pane'), flex: flex};
  }
  let dir = el.classList.contains('split-h') ? 'h' : 'v';
  let kids = [];
  for (let i = 0; i < el.children.length; i++) {
    let c = el.children[i];
    if (c.classList.contains('split-handle')) continue;
    kids.push(serializeNode(c));
  }
  return {type: 'split', dir: dir, flex: flex, a: kids[0], b: kids[1]};
}

function saveSessions() {
  let out = {};
  Object.keys(panes).forEach(k => {
    let rec = paneRecord(panes[k]);
    if (rec) out[k] = rec;
  });
  let tabList = [];
  let activeIdx = 0;
  tabs.forEach(t => {
    let layout = serializeLayout(t.root);
    if (!layout) return;
    if (t.id === activeTabId) activeIdx = tabList.length;
    let rec = {layout: layout, active: t.lastActive || null};
    if (t.name) rec.name = t.name;
    tabList.push(rec);
  });
  let manifest = {
    version: PANES_VERSION,
    tabs: tabList,
    active: activeIdx,
    panes: out
  };
  try { localStorage.setItem(storageKey(PANES_KEY), JSON.stringify(manifest)); } catch(e) {}
}
// A version-2 manifest (one layout) as a version-3 one: one tab.
function _manifestV2toV3(m) {
  return {version: PANES_VERSION, tabs: m.layout ? [{layout: m.layout, active: null}] : [],
          active: 0, panes: m.panes};
}
function loadManifest() {
  // Load v3 directly; v2 as one tab; or migrate from the legacy v1
  // "websh_manifest" key.
  try {
    let raw = localStorage.getItem(storageKey(PANES_KEY));
    if (raw) {
      let m = JSON.parse(raw);
      if (m && m.version === PANES_VERSION && Array.isArray(m.tabs)) return m;
      if (m && m.version === 2) return _manifestV2toV3(m);
    }
  } catch(e) {}
  // Migrate v1 → v2, then drop the old key.
  try {
    let raw = localStorage.getItem(storageKey('websh_manifest'));
    if (!raw) return null;
    let old = JSON.parse(raw);
    if (!old || old.version !== 1 || !old.slots) return null;
    let panes = {};
    Object.keys(old.slots).forEach(k => {
      let s = old.slots[k];
      let b = s.connect_body || {};
      panes[k] = {
        label: s.label || '',
        host: b.host || '',
        port: b.port || 22,
        user: b.username || '',
        connection: b.connection || null,
        auth: b.key ? 'key' : 'pw',
        password: b.password || '',
        key: b.key || '',
        key_pass: '',
        persistent: !!s.persistent_requested,
        slot_id: s.slot_id || null,
        tmux_cmd: 'tmux',
        cols: b.cols || 80,
        rows: b.rows || 24
      };
    });
    let migrated = _manifestV2toV3({ layout: old.layout, panes });
    localStorage.setItem(storageKey(PANES_KEY), JSON.stringify(migrated));
    localStorage.removeItem(storageKey('websh_manifest'));
    return migrated;
  } catch(e) { return null; }
}
function clearSavedSessions() {
  try { localStorage.removeItem(storageKey(PANES_KEY)); } catch(e) {}
  try { localStorage.removeItem(storageKey('websh_manifest')); } catch(e) {}
  try { sessionStorage.removeItem('websh_sessions'); } catch(e) {}
}

// ── Export terminal ─────────────────────────────────────────────────
function exportTerminal() {
  let p = panes[activeId]; if (!p) return;
  let filename = (p.label || 'terminal') + '.txt';
  // Persistent panes run inside tmux, which keeps its own scrollback —
  // xterm.js only sees the alt-screen, so its buffers are useless for
  // export. Pull the real buffer over the ControlMaster side-channel.
  if (p.persistent && p.sid) {
    let url = `${API}?action=tmux_capture&session_id=${encodeURIComponent(p.sid)}`;
    apiFetch(url).then(r => {
      if (!r.ok) {
        return r.json().catch(() => ({error: 'capture failed'}))
          .then(j => Promise.reject(j.error || 'capture failed'));
      }
      return r.text();
    }).then(text => {
      // tmux capture-pane keeps trailing blank lines; trim them off so
      // the file ends at the last real output.
      text = text.replace(/\n+$/, '') + '\n';
      saveTextAs(filename, text);
    }).catch(err => {
      console.warn('tmux capture failed, falling back to xterm buffer:', err);
      saveTextAs(filename, dumpXtermBuffers(p));
    });
    return;
  }
  saveTextAs(filename, dumpXtermBuffers(p));
}

function dumpXtermBuffers(p) {
  let lines = [];
  let dump = (buf) => {
    if (!buf) return;
    for (let i = 0; i < buf.length; i++) {
      let line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
  };
  dump(p.term.buffer.normal);
  if (p.term.buffer.active.type === 'alternate') {
    lines.push('');
    lines.push('─── alternate screen ───');
    dump(p.term.buffer.alternate);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n') + '\n';
}

function saveTextAs(filename, text) {
  let blob = new Blob([text], {type: 'text/plain'});
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// Carry the non-enumerable __ephemeralSecrets bag across an Object.
// assign hop. Plaintext secrets travel with a pending-save entry from
// doConnect → finalizeSuccess → commitPendingSave; we hold them
// non-enumerable so a future JSON.stringify on the entry (crash dump,
// debug log, paneRecord-style serializer) can't spill them to disk.
// Object.assign drops non-enumerable props, so each hop must re-attach.
// (Finding 2a in the PR-67 review.)
function _carryEphemeralSecrets(src, dst) {
  if (!src || !src.__ephemeralSecrets) return;
  Object.defineProperty(dst, '__ephemeralSecrets', {
    value: src.__ephemeralSecrets,
    enumerable: false, configurable: true, writable: true,
  });
}

// The output-gated commit in handleOutputPayload only fires when the
// session emits a terminal frame ≥SAVE_COMMIT_DELAY_MS after connect. An
// idle session over SSE (connect, see the prompt, type nothing) emits no
// such frame — EventSource only delivers on real output, and the 30s
// empty-input keepalive doesn't route through handleOutputPayload — so the
// deferred save would never land. Back it with a timer so "tick Save +
// connect" persists regardless of output. Idempotent with the output path:
// commitPendingSave bails once pendingSave is cleared (by the commit itself
// or an auth failure, which also nulls p.sid), and the p.sid guard skips a
// session that has since died.
const SAVE_COMMIT_DELAY_MS = 2600;
function scheduleSaveCommit(p) {
  clearTimeout(p.saveCommitTimer);
  p.saveCommitTimer = setTimeout(() => {
    if (p.sid && p.pendingSave) commitPendingSave(p);
  }, SAVE_COMMIT_DELAY_MS);
}

function commitPendingSave(p) {
  if (!p.pendingSave) return;
  clearTimeout(p.saveCommitTimer);
  let entry = Object.assign({}, p.pendingSave);
  _carryEphemeralSecrets(p.pendingSave, entry);
  // Overwrite persistent with the actual live mode (handles tmux-skip
  // and any other downgrade paths). Also capture a discovered tmux_cmd.
  entry.persistent = !!p.persistent;
  if (p.tmuxCmd && p.tmuxCmd !== 'tmux') entry.tmux_cmd = p.tmuxCmd;
  p.pendingSave = null;
  if ($('iSave').checked) { $('iSave').checked = false; toggleSaveName(); }
  if (entry.__ephemeralSecrets) {
    // Vault path: mint conn_id, encrypt secrets, POST to /api/save; on
    // success the entry (without __ephemeralSecrets) is added to the
    // saved-card list. Failure surfaces as a toast and does not touch
    // the list — the live session keeps running either way.
    commitVaultSave(entry).then(() => {
      // Best-effort UX hook for future Safari ITP / persist() prompt.
      if (typeof _onFirstVaultSave === 'function' && _vaultFirstSave) {
        _vaultFirstSave = false;
        try { _onFirstVaultSave(); } catch(e){}
      }
    }).catch(err => {
      console.warn('vault save failed:', err);
      showToast('Could not save credentials to the server. The session ' +
                'is still open; try Save again later.', 'warn');
    });
    return;
  }
  // No-vault fallback path. Currently unreachable because doConnect now
  // only assembles a saveEntry when serverConfig.vault_enabled is true;
  // kept defensive for any future caller that hand-builds pendingSave.
  let list = loadSaved();
  list = list.filter(c => c.name !== entry.name);
  list.unshift(entry);
  saveSaved(list);
  renderSaved();
}

async function commitVaultSave(entry) {
  // A sign-out (local or from a sibling tab) between this save being
  // initiated in doConnect and now means we should NOT proceed: the
  // user wiped their vault, and silently letting encryptCredentials
  // mint a fresh K + vault_id would resurrect a "row written back into
  // a wiped local list" scenario gorevds raised. The flag is set in
  // the BroadcastChannel handler + confirmSignOut, and cleared in
  // doConnect when the user explicitly initiates a save (which
  // supersedes any past sign-out intent). We can't use a bare IDB
  // probe here because the first-ever save legitimately has empty
  // IDB. (Findings 1 + 4 in the PR-67 review.)
  if (_vaultRecentlySignedOut) {
    // Best-effort scrub before the entry falls out of scope. Symmetric
    // to the post-encrypt + post-POST scrub paths below.
    let s = entry && entry.__ephemeralSecrets;
    if (s) { try { s.password = null; s.key = null; s.key_pass = null; } catch (e) {} }
    showToast('Sign-out happened during save — credentials were NOT saved. ' +
              'Re-enter to save again.', 'warn');
    return;
  }
  let conn_id = generateConnId();
  let secrets = entry.__ephemeralSecrets || {};
  // __ephemeralSecrets is non-enumerable; defineProperty over the same
  // key clears it. Plain `delete` is also fine, used here for symmetry
  // with the previous shape.
  try { delete entry.__ephemeralSecrets; } catch (e) {}
  let dest = vaultDestination(entry.host, entry.port, entry.user);
  let {iv, ct, vault_id} = await encryptCredentials(secrets, conn_id, dest);
  // Post-encrypt re-check: subtle.encrypt yielded the event loop, and a
  // sibling tab's BroadcastChannel signed_out handler may have wiped
  // IDB + invalidateVaultCache() during that gap. Bypass the in-memory
  // cache by reading IDB directly. If vault_id is gone or has been
  // replaced, the ciphertext we just built is bound to a namespace the
  // server can't decrypt — do NOT POST a server-side orphan blob the
  // server has no way to GC. (Finding 1 in the PR-67 review.)
  let idbVaultIdAfter = null;
  try { idbVaultIdAfter = await _idbGet(IDB_VAULT_ID_KEY); } catch (e) {}
  // Belt-and-braces: also re-check the sign-out flag. The
  // BroadcastChannel handler sets it synchronously, but in theory the
  // wipe + new mint could have completed during the encrypt yield and
  // left IDB matching our `vault_id`. The flag closes that window.
  if (idbVaultIdAfter !== vault_id || _vaultRecentlySignedOut) {
    invalidateVaultCache();
    // Best-effort scrub of the local plaintext copy — strings are
    // immutable in JS so this only nulls references, but at least the
    // closure no longer pins them. (Finding 2c in the PR-67 review.)
    try { secrets.password = null; secrets.key = null; secrets.key_pass = null; } catch (e) {}
    showToast('Sign-out happened during save — credentials were NOT saved. ' +
              'Re-enter to save again.', 'warn');
    return;
  }
  let body = {
    vault_id, conn_id,
    // Exactly the values bound into the AAD, so the server derives the
    // same bytes from the stored record at connect time.
    host: dest.host, port: dest.port, username: dest.username,
    iv, ct, aad_v: VAULT_AAD_VERSION,
    // ssh_options is part of the /api/save wire contract (server filters
    // through _filter_ssh_options and persists what survives). The
    // browser has no UI for arbitrary SSH options yet, so we send an
    // empty object — it keeps the server-side filter exercised and
    // lets a future client surface per-entry options without a wire
    // version bump. (Finding 7 in the PR-67 review.)
    ssh_options: {},
  };
  let resp;
  try {
    resp = await api('save', {body: body});
  } finally {
    // Whether the POST succeeded, failed, or rejected, drop the local
    // plaintext copy from the closure so it doesn't outlive the call.
    try { secrets.password = null; secrets.key = null; secrets.key_pass = null; } catch (e) {}
  }
  if (resp && resp.error) {
    throw new Error('save: ' + resp.error);
  }
  // Post-POST re-check: the api('save') round-trip yielded the event
  // loop a second time, and a sibling tab's signed_out broadcast may
  // have wiped IDB during that gap. Without this, list.unshift(entry)
  // below would zombify the entry into the locally-cleared list —
  // bound to a vault_id the server no longer recognises (the BC
  // handler in this tab already cleared its own /api/save_delete loop
  // copy of the entry, but the row we just POSTed was minted after
  // that loop ran so a server-side orphan blob is unavoidable here;
  // the local list is the one we can keep coherent). Symmetric to the
  // pre-encrypt + post-encrypt windows that already guard this.
  // (Original review item F4.)
  let idbVaultIdAfterPOST = null;
  try { idbVaultIdAfterPOST = await _idbGet(IDB_VAULT_ID_KEY); } catch (e) {}
  if (idbVaultIdAfterPOST !== vault_id || _vaultRecentlySignedOut) {
    invalidateVaultCache();
    // No secret scrubbing needed: the finally above already nulled
    // the closure refs, and entry.__ephemeralSecrets was deleted
    // before the encrypt call. The BC sign-out handler surfaces its
    // own toast, so we stay silent here to avoid double-noise.
    return;
  }
  entry.conn_id = conn_id;
  // De-dup by conn_id (and by name, for the pre-vault upgrade path
  // where an old plaintext row with the same label is still around).
  // Same-name re-save ("I'm updating the password") drops the previous
  // row from localStorage; its server-side blob would linger under the
  // old conn_id. Capture those old conn_ids first and fire-and-forget
  // a server-side reap so they don't accumulate in websh.creds.json.
  let allRows = loadSaved();
  let droppedConns = allRows
    .filter(c => c.name === entry.name && c.conn_id && c.conn_id !== conn_id)
    .map(c => c.conn_id);
  let list = allRows.filter(c => c.conn_id !== conn_id && c.name !== entry.name);
  list.unshift(entry);
  saveSaved(list);
  renderSaved();
  // Fire-and-forget: the new entry is already locally committed; a
  // transient server hiccup on cleanup shouldn't block the save flow.
  // _bulkDeleteVaultEntry resolves vault_id from IDB and IfPresent-guards
  // the network call (no fresh vault_id minted in a sign-out state).
  droppedConns.forEach(cid =>
    _bulkDeleteVaultEntry({conn_id: cid}).catch(() => {}));
}

// ── Output transport ────────────────────────────────────────────────
// HTTP/1.x browsers have only six connections per origin. Limit this
// page to three streams (probes included) plus ONE shared long-poll,
// leaving room for keys and connect/resize even with many quiet panes.
// The old endpoints remain available to cached clients/older servers.
const OUTPUT_STREAM_LIMIT = 3;
let _outputWaiters = [];
let _outputBatchCtl = null;
let _outputBatchScheduled = false;

function outputBatchAvailable() {
  return !!(serverConfig && serverConfig.output_batch);
}

function outputStreamRoom() {
  if (!outputBatchAvailable()) return true;
  let used = 0;
  Object.values(panes).forEach(p => {
    if (p.eventSource) used++;
    if (p.sseProbe) used++;
  });
  return used < OUTPUT_STREAM_LIMIT;
}

// Each pane keeps its own loop, cursor, timeout and retry budget.
// Only its waiting request is shared. New/cancelled waiters restart the
// batch with the remaining cursors, never resolve or reject neighbours.
// In particular a newly connected pane does not wait for an idle batch's
// ten-second deadline before its first screen can arrive.
function batchOutput(opts) {
  let query = new URLSearchParams(opts.query || '');
  return new Promise((resolve, reject) => {
    let waiter = {session_id: query.get('session_id') || '',
                  since: Number(query.get('since')) || 0,
                  signal: opts.signal, resolve: resolve, reject: reject};
    waiter.abort = () => {
      let i = _outputWaiters.indexOf(waiter);
      if (i < 0) return;
      _outputWaiters.splice(i, 1);
      if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort);
      reject(new DOMException('aborted', 'AbortError'));
      restartOutputBatch();
    };
    if (waiter.signal && waiter.signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    _outputWaiters.push(waiter);
    if (waiter.signal) waiter.signal.addEventListener('abort', waiter.abort, {once: true});
    restartOutputBatch();
  });
}

function restartOutputBatch() {
  if (_outputBatchCtl) {
    let ctl = _outputBatchCtl;
    _outputBatchCtl = null;       // late replies belong to the old batch
    ctl.abort();
  }
  if (!_outputWaiters.length || _outputBatchScheduled) return;
  _outputBatchScheduled = true;
  // Promise callbacks collect the panes resolved by the same reply
  // without a timer: hidden-page timer throttling must never delay
  // reading their output, or fast output can outrun the replay log.
  Promise.resolve().then(runOutputBatch);
}

function runOutputBatch() {
  _outputBatchScheduled = false;
  if (!_outputWaiters.length || _outputBatchCtl) return;
  let batch = _outputWaiters.slice();
  let ctl = _outputBatchCtl = new AbortController();
  // A restored duplicate pane can wait on the same server session.
  // Read its oldest requested cursor once; each terminal already trims
  // replayed bytes below its own cursor in handleOutputPayload.
  let sessions = [], indices = new Map();
  batch.forEach(w => {
    let i = indices.get(w.session_id);
    if (i === undefined) {
      indices.set(w.session_id, sessions.length);
      sessions.push({session_id: w.session_id, since: w.since});
    } else sessions[i].since = Math.min(sessions[i].since, w.since);
  });
  let finish = (reply, error) => {
    if (_outputBatchCtl !== ctl) return;
    _outputBatchCtl = null;
    batch.forEach(w => {
      let i = _outputWaiters.indexOf(w);
      if (i < 0) return;
      _outputWaiters.splice(i, 1);
      if (w.signal) w.signal.removeEventListener('abort', w.abort);
      if (error) { w.reject(error); return; }
      if (reply && reply.error) { w.resolve(reply); return; }
      let item = reply && Array.isArray(reply.outputs) && reply.outputs[indices.get(w.session_id)];
      if (!item || !item.payload || typeof item.payload !== 'object' ||
          !Number.isInteger(item.status) || item.status < 200 || item.status > 599) {
        w.reject(new Error('Invalid shared output reply'));
        return;
      }
      let payload = Object.assign({}, item.payload);
      Object.defineProperty(payload, '_status', {value: item.status});
      w.resolve(payload);
    });
    if (_outputWaiters.length) restartOutputBatch();
  };
  api('output_many', {body: {sessions: sessions}, signal: ctl.signal})
    .then(r => finish(r, null), e => finish(null, e));
}

// Two transports share one payload shape ({data, alive, auth_failed}).
// Primary: SSE via /api/stream, opened with EventSource. Falls back to
// long-poll automatically if (a) EventSource is missing, (b) the first
// SSE event doesn't arrive within SSE_FIRST_MSG_TIMEOUT_MS (a buffering
// proxy), or (c) the SSE connection errors before any event landed three
// times in a row. A pane that has fallen back probes the stream again
// in the background (maybeProbeSse) and returns to it when it works.

function abortPoll(p) {
  if (p.pollAbort) {
    try { p.pollAbort.abort(); } catch (e) {}
    p.pollAbort = null;
  }
}

function closeStream(p) {
  if (p.eventSource) {
    try { p.eventSource.close(); } catch (e) {}
    p.eventSource = null;
  }
  if (p.sseProbe) {
    try { p.sseProbe.close(); } catch (e) {}
    p.sseProbe = null;
  }
  if (p.sseFirstMsgTimer) {
    clearTimeout(p.sseFirstMsgTimer);
    p.sseFirstMsgTimer = null;
  }
}

// Shared transport teardown for a pane whose session is over. Closes the
// stream, stops keepalive, drops the polling/connecting flags, clears the
// deferred-save timer (its commit guard needs p.sid, which we null here;
// clearing also drops the closure's pane ref), and nulls p.sid. The bits
// call sites genuinely differ on are opt-in:
//   o.disconnect — POST /api/disconnect for the old sid (fire-and-forget)
//   o.save       — persist the session manifest (saveSessions)
//   o.badge      — refresh the pane badge now
function endSession(p, o) {
  o = o || {};
  let sid = p.sid;
  closeStream(p);
  abortPoll(p);
  p.outGen = (p.outGen || 0) + 1;      // any loop still in flight is stale
  // The input queue is left alone: keys typed a moment ago may be for
  // the tmux shell this pane is about to re-attach to. Whoever starts
  // the next session decides (beginSessionIO / openInputGate: never
  // into a new shell, never older than INPUT_HOLD_MS).
  closeInputGate(p);
  stopKeepalive(p);
  p.polling = false;
  p.connecting = false;
  p.sid = null;
  // The tracked cwd belongs to the shell that just went away; a
  // reconnect starts somewhere else and must re-learn it.
  p.cwd = '';
  p.osc7Host = null;     // a new session pins its own OSC 7 host
  p.outCursor = 0;       // cursors are per session
  p.serverCursor = null;
  clearTimeout(p.saveCommitTimer);
  p.saveCommitTimer = null;
  // Nothing accepts keystrokes any more (queueInput is guarded on
  // p.sid), so a blinking cursor is a lie - and, on a pane whose output
  // starts at the top, it sat right under the pane bar looking welded to
  // it. Blurring hides it outright: cursorInactiveStyle is 'none'.
  // Reconnecting focuses the terminal again (activatePane/connectPane).
  try { p.term.blur(); } catch (e) {}
  if (o.disconnect && sid) {
    api('disconnect', {body: {session_id: sid}}).catch(() => {});
  }
  if (o.save) saveSessions();
  if (o.badge) updatePaneBadge(p);
}

// ── Recovery after a long absence ────────────────────────────────────
// Background tabs get frozen by the browser (Chrome's memory saver /
// page lifecycle freeze) after ~5 min hidden: timers stop, EventSource
// pauses, our 30s empty-input keepalive stops going out. The server
// reaps the PTY after SESSION_TIMEOUT idle, the SSE socket rots, but
// EventSource doesn't always fire onerror on resume — the tab looks
// frozen until F5. Persistent panes survive because the real shell
// lives in tmux on the remote host; a fresh connect re-attaches by
// slot_id. bfcache restore (Firefox/Safari Back navigation, sometimes
// Chrome) is a sibling case: pageshow with persisted=true means the
// page was un-bfcached; timers and EventSource state are stale.
//
// Strategy: on either signal — visibility return after >10s hidden,
// or bfcache restore — refit every active pane and reopen its output
// stream. Panes in hidden tabs get the stream restart without the refit
// (fitPaneWhenStable skips them and still runs onSettled); their tab
// fits them when shown. If the server-side session is still alive, the SSE primer
// arrives in one frame and nothing visible happens. If it was reaped,
// the reconnect path fires and tmux brings the shell back.
//
// Long-poll panes don't need the SSE kick (fetch isn't frozen the way
// EventSource is in a backgrounded tab, the existing pollOutput
// recursion keeps running across the freeze; double-firing would
// stack a second poll chain and garble output via destructive
// session.read() races). They DO benefit from the refit, though,
// since the window may have changed size while we were hidden.
function kickPanesAfterAbsence() {
  Object.values(panes).forEach(p => {
    if (!p || !p.sid || !p.polling) return;
    // Settle-loop refit covers the case where the webfont finished
    // loading while the tab was hidden (xterm's measurement was made
    // against the fallback). The onSettled callback chains the SSE
    // reconnect after /api/resize lands, preserving the original
    // server-side ordering guarantee: PTY is resized before the
    // shell next prints into the new stream.
    fitPaneWhenStable(p, { onSettled: (p) => {
      // Long-polling panes too: their request may be parked on a
      // connection that no longer exists.
      kickOutput(p, true);
    }});
  });
}

let _lastHiddenAt = 0;
const VISIBILITY_PROBE_THRESHOLD_MS = 10000;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _lastHiddenAt = Date.now();
    return;
  }
  let hiddenFor = _lastHiddenAt ? (Date.now() - _lastHiddenAt) : 0;
  _lastHiddenAt = 0;
  repaintVisiblePanes();     // any absence (── Paint guard)
  if (hiddenFor < VISIBILITY_PROBE_THRESHOLD_MS) return;
  kickPanesAfterAbsence();
});

// bfcache restore: Firefox / Safari (and Chrome since 96) cache the
// whole page across navigations and restore it on Back. visibilitychange
// is unreliable on this path; pageshow with event.persisted=true is
// the canonical signal per the WICG Page Lifecycle spec.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    kickPanesAfterAbsence();
    // Our pagehide handler closes _vaultBroadcast so a frozen bfcache
    // tab doesn't get spurious replays. Re-open on restore — otherwise
    // a sign-out in another tab while this one was bfcache'd would
    // never reach us. _initVaultBroadcast is idempotent (guards on
    // existing channel) so calling it on every persisted pageshow is
    // safe and covers cold loads where it's already a no-op.
    _initVaultBroadcast();
    // bfcache also froze the in-memory vault caches: a sibling tab
    // could have signed out while we were bfcache'd, wiping IDB. The
    // BC re-init above won't replay that past event (closed channel ⇒
    // no queue), so we'd render saved cards as connectable until the
    // next IDB touch even though K is gone. Mirror the other "IDB
    // may have changed underneath us" call sites: drop in-memory
    // caches first, then re-read presence from IDB, then re-paint.
    invalidateVaultCache();
    _refreshIdbHasKey().then(() => {
      try { renderSaved(); } catch (err) {}
    }, () => {});
  }
});

// ── Paint guard: output that reached the page is on screen ──────────
// Reported by several users (Chrome on macOS, Yandex Browser on Windows):
// back in a tab that had been hidden, they typed and nothing appeared;
// a reload showed it all. The server's log had the keys and the echo.
// The diagnostics beacon (below) caught one (2026-10-18): a pane on a
// visible page had output written 5 ms before the reload and xterm had
// not rendered it for 18 s - and the first version of this guard, which
// only checked from a timer and stood down whenever the page said it
// was hidden, never fired. So:
//  - the check runs on every write (output arrives on network events,
//    which run even when timers do not) and from a timer for when the
//    writes stop; it measures from the FIRST write not rendered since
//    the last render (p.unrenderedSince), so a steady trickle of output
//    (a spinner, a status line) cannot keep postponing it;
//  - "on screen" is the pane's tab shown and the page visible - or the
//    page focused: a page the user is typing into is being looked at,
//    whatever visibilityState says;
//  - a pane coming back on screen (page shown, window focused,
//    pageshow, its tab shown - which covers a pane moved or merged) is
//    repainted in full, refitted first only if its box no longer
//    matches its cols/rows (no /api/resize otherwise: flushPaneResize
//    dedups, and a resize makes tmux redraw everything).
// Two ways xterm 5.5 stops drawing, both read from its source:
//  1. It parses written data in WriteBuffer._innerWrite, from a
//     setTimeout. Nothing there catches an exception, nor does its
//     EventEmitter.fire for listeners called during parsing: one throw
//     leaves the chunks queued and no timer scheduled, and every later
//     write only appends to the queue - nothing is parsed again, so
//     nothing is drawn, until a reload. unwedgeWrites() resumes the loop
//     and skips a chunk that throws (that chunk's output is lost; the
//     screen goes on).
//  2. The DOM renderer draws on requestAnimationFrame and pauses while
//     an IntersectionObserver says the terminal is off screen. A pause
//     never lifted, or a frame that never runs, freezes the screen.
//     renderHard() lifts both by hand and renders the rows at once.
// Recovery, at most once per PAINT_WATCH_MS: resume parsing if it is
// stuck, then a full refresh; next time a renderer reset; then leave the
// pane for PAINT_QUIET_MS. Each step is a console.warn ("paint: ...").
// No work when nothing is written; a pane in a hidden tab is not watched
// (U1/U2: it is repainted when shown).
const PAINT_WATCH_MS = 1000;
const PAINT_QUIET_MS = 10000;
let _paintRecoveries = 0;     // whole page, for the diagnostics beacon
let _visChangedAt = 0;        // last visibilitychange, for the beacon
let _lastPageError = null;    // last uncaught error {at, msg}, for the beacon

function pageLooked() {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState !== 'hidden') return true;
  try { return document.hasFocus(); } catch (e) { return false; }
}

function paneOnScreen(p) {
  if (!p || !p.term || !p.term.element || paneHidden(p)) return false;
  return pageLooked();
}

function notePaneRendered(p) {
  let now = Date.now();
  p.lastRenderAt = now;
  // A render while written chunks still wait unparsed (the cursor blink
  // draws even when parsing has died) does not show that output: keep
  // waiting from when parsing last moved.
  let b = writeBacklog(p);
  if (b && b.chunks && p.unrenderedSince) {
    p.unrenderedSince = p.pendSince || now;
    return;
  }
  p.unrenderedSince = 0;
  p.paintStage = 0;
  if (p.paintTimer) { clearTimeout(p.paintTimer); p.paintTimer = null; }
  if (p.latPaint) latOnRender(p);      // ── Input latency
}

// xterm finished a parse slice.
function notePaneParsed(p) {
  let now = Date.now();
  p.lastParsedAt = now;
  let b = writeBacklog(p);
  p.pendSince = (b && b.chunks) ? now : 0;
}

// Output went into the terminal (called after term.write).
function notePaneWritten(p) {
  let now = Date.now();
  p.lastWriteAt = now;
  let b = writeBacklog(p);
  if (b && b.chunks && !p.pendSince) p.pendSince = now;   // waiting to be parsed
  if (!p.paintWatchable) return;
  if (!paneOnScreen(p)) { p.unrenderedSince = 0; return; }
  if (!p.unrenderedSince) p.unrenderedSince = now;
  checkPaint(p);
}

// Expect a render from now on (a repaint was asked for).
function expectPaint(p) {
  if (!p || !p.paintWatchable || !paneOnScreen(p)) return;
  if (!p.unrenderedSince) p.unrenderedSince = Date.now();
  checkPaint(p);
}

function armPaintCheck(p, ms) {
  if (p.paintTimer) return;
  p.paintTimer = setTimeout(() => { p.paintTimer = null; checkPaint(p); }, Math.max(50, ms));
}

function checkPaint(p) {
  if (panes[p.id] !== p || !p.unrenderedSince) return;
  if (!paneOnScreen(p)) { p.unrenderedSince = 0; p.paintHiddenSkips = (p.paintHiddenSkips || 0) + 1; return; }
  let now = Date.now();
  let due = Math.max(p.unrenderedSince + PAINT_WATCH_MS, (p.lastRecoveryAt || 0) + PAINT_WATCH_MS,
                     p.paintQuietUntil || 0);
  if (now < due) { armPaintCheck(p, due - now); return; }
  let stage = p.paintStage || 0;
  let waited = now - p.unrenderedSince;
  p.lastRecoveryAt = now;
  if (stage >= 2) {
    console.warn('paint: pane', p.id, 'still not rendering after a renderer reset; ' +
                 'leaving it for', PAINT_QUIET_MS, 'ms');
    p.paintStage = 0;
    p.paintQuietUntil = now + PAINT_QUIET_MS;
    armPaintCheck(p, PAINT_QUIET_MS);
    return;
  }
  p.paintRecoveries = (p.paintRecoveries || 0) + 1;
  _paintRecoveries++;
  // Staged and re-armed before the attempt: a render it causes at once
  // (renderHard renders synchronously) clears this via notePaneRendered.
  p.paintStage = stage + 1;
  armPaintCheck(p, PAINT_WATCH_MS);
  unwedgeWrites(p, now);
  if (stage === 0) {
    console.warn('paint: pane', p.id, 'has output not rendered for', waited,
                 'ms; forcing a full refresh');
    renderFull(p);
  } else {
    console.warn('paint: pane', p.id, 'did not render after a full refresh; ' +
                 'resetting the renderer');
    renderHard(p);
  }
}

// xterm's write queue: chunks written but not parsed yet (see 1. above).
function writeBacklog(p) {
  try {
    let wb = p.term._core && p.term._core._writeBuffer;
    if (wb && Array.isArray(wb._writeBuffer) && typeof wb._bufferOffset === 'number') {
      return {wb: wb, chunks: Math.max(0, wb._writeBuffer.length - wb._bufferOffset)};
    }
  } catch (e) {}
  return null;
}

// Parsing stopped with data queued (no parse for PAINT_WATCH_MS while
// chunks wait): run xterm's write loop again; a chunk that throws is
// skipped.
function unwedgeWrites(p, now) {
  let b = writeBacklog(p);
  if (!b || !b.chunks || typeof b.wb._innerWrite !== 'function') return;
  if (!p.pendSince || now - p.pendSince < PAINT_WATCH_MS) return;   // parsing moves
  console.warn('paint: pane', p.id, 'xterm stopped parsing with', b.chunks,
               'chunks queued; resuming it');
  p.parseResumes = (p.parseResumes || 0) + 1;
  for (let i = 0; i < 16; i++) {
    let wb = b.wb;
    if (wb._writeBuffer.length <= wb._bufferOffset) break;
    try { wb._innerWrite(); break; }
    catch (e) {
      p.parseErrors = (p.parseErrors || 0) + 1;
      _lastPageError = {at: Date.now(), msg: String(e && e.message || e)};
      console.warn('paint: pane', p.id, 'a chunk throws in xterm\'s parser; skipping it:', e);
      let d = wb._writeBuffer[wb._bufferOffset];
      wb._bufferOffset++;
      wb._pendingData = Math.max(0, (wb._pendingData || 0) - ((d && d.length) || 0));
    }
  }
}

function renderFull(p) {
  try { p.term.refresh(0, p.term.rows - 1); } catch (e) {}
}

// The terminal's box no longer matches its cols/rows (the window changed
// while the page was hidden or frozen).
function paneNeedsFit(p) {
  try {
    let d = p.fitAddon && p.fitAddon.proposeDimensions();
    return !!d && d.cols > 0 && d.rows > 0 && (d.cols !== p.term.cols || d.rows !== p.term.rows);
  } catch (e) { return false; }
}

// xterm 5.5's render service, private names, every step guarded: a
// different xterm only loses this step, never the page. Lift a pause the
// IntersectionObserver left on a terminal that is on screen, drop an
// animation frame that never ran, re-measure the font, rebuild the glyph
// cache, and render the rows now rather than on a frame.
function renderHard(p) {
  let deb = null;
  try {
    let core = p.term._core;
    let rs = core && core._renderService;
    deb = rs && rs._renderDebouncer;
    if (rs && rs._isPaused) {
      rs._isPaused = false;
      try { if (rs._pausedResizeTask) rs._pausedResizeTask.flush(); } catch (e) {}
    }
    if (deb && deb._animationFrame !== undefined) {
      try { cancelAnimationFrame(deb._animationFrame); } catch (e) {}
      deb._animationFrame = undefined;
    }
    let cs = core && core._charSizeService;
    if (cs && !cs.hasValidSize && cs.measure) cs.measure();
  } catch (e) {}
  try { p.term.clearTextureAtlas(); } catch (e) {}
  renderFull(p);
  try { if (deb && typeof deb._innerRefresh === 'function') deb._innerRefresh(); } catch (e) {}
  if (paneNeedsFit(p)) fitPaneWhenStable(p);
}

// Repaint a pane that may just have come back on screen, and expect it
// to render. A refit only when the box changed.
function repaintPane(p) {
  if (!paneOnScreen(p)) return;
  if (paneNeedsFit(p)) {
    fitPaneWhenStable(p, {onSettled: q => { renderFull(q); expectPaint(q); }});
    return;
  }
  renderFull(p);
  expectPaint(p);
}

function repaintVisiblePanes() {
  Object.values(panes).forEach(p => { if (p && p.term) repaintPane(p); });
}
window.addEventListener('focus', repaintVisiblePanes);
window.addEventListener('pageshow', repaintVisiblePanes);
document.addEventListener('visibilitychange', () => { _visChangedAt = Date.now(); });
window.addEventListener('error', e => {
  _lastPageError = {at: Date.now(), msg: String((e && (e.message || (e.error && e.error.message))) || 'error')};
});

// ── Diagnostics beacon ───────────────────────────────────────────────
// So the next "typed, nothing on screen, reload shows it" is caught in
// the server log: when the page goes away (a reload, a closed tab) and
// some pane looks stuck - output on screen not rendered for over
// PAINT_WATCH_MS, xterm's parse queue stuck, behind the server's output
// offset, or a paint recovery happened - one
// navigator.sendBeacon to ?action=client_diag carries per pane: an
// 8-character session id prefix, offsets, ages of the last write, parse
// and render, how long output has waited unrendered, xterm's parse queue
// and render-pause state, cols/rows against the element's size, the
// transport, counters; and for the page: visibility, focus, the age of
// the last visibility change, the last uncaught error message (cut to 80
// characters). No terminal content, no secrets. Nothing is sent when
// nothing looks stuck. A server without the action answers 404 to a
// beacon nobody reads. pagehide only (not beforeunload, which costs the
// page its back/forward cache): it fires on reload, close and navigation.
let _diagSent = false;

function paneTransport(p) {
  if (p.eventSource) return 'sse';
  if (!p.sid) return 'none';
  let t = p.transport || 'none';
  return t === 'sse' ? 'sse-closed' : t;
}

function paneDiag(p, now) {
  let box = null;
  try { box = p.el.querySelector('.pane-term').getBoundingClientRect(); } catch (e) {}
  let ago = t => (t ? Math.max(0, now - t) : -1);
  let srv = (typeof p.serverCursor === 'number') ? p.serverCursor : -1;
  let b = writeBacklog(p);
  let paused = -1, frame = -1;
  try {
    let rs = p.term._core && p.term._core._renderService;
    if (rs) {
      paused = rs._isPaused ? 1 : 0;
      let deb = rs._renderDebouncer;
      if (deb) frame = deb._animationFrame !== undefined ? 1 : 0;
    }
  } catch (e) {}
  let unrendered = p.unrenderedSince ? now - p.unrenderedSince : -1;
  let pend = b ? b.chunks : -1;
  return {
    sid: String(p.sid || '').slice(0, 8),
    got: p.outCursor || 0,
    srv: srv,
    write_ago: ago(p.lastWriteAt),
    parse_ago: ago(p.lastParsedAt),
    render_ago: ago(p.lastRenderAt),
    unrendered: unrendered,
    pend: pend,
    pend_ms: p.pendSince ? now - p.pendSince : -1,
    paused: paused, frame: frame,
    cols: p.term.cols || 0, rows: p.term.rows || 0,
    w: box ? Math.round(box.width) : -1, h: box ? Math.round(box.height) : -1,
    mode: paneTransport(p),
    tab_hidden: paneHidden(p),
    recoveries: p.paintRecoveries || 0,
    resumes: p.parseResumes || 0,
    hidden_skips: p.paintHiddenSkips || 0,
    unpainted: unrendered > PAINT_WATCH_MS,
    // Chunks queued and parsing has not moved for a while: the loop died.
    wedged: pend > 0 && !!p.pendSince && now - p.pendSince > PAINT_WATCH_MS,
    // The server said there is more output than this pane got, a while ago
    // (serverCursor comes only from /api/input replies, so it may lag).
    behind: !!p.sid && srv > (p.outCursor || 0) && now - (p.serverCursorAt || now) > OUTPUT_LAG_MS
  };
}

function sendDiagBeacon() {
  if (_diagSent || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  // Not sent at all while traffic is sealed: a beacon cannot be.
  if (sealedOn()) return;
  let now = Date.now();
  let list = [];
  Object.values(panes).forEach(p => {
    if (!p || !p.term) return;
    try { list.push(paneDiag(p, now)); } catch (e) {}
  });
  if (!list.some(d => d.unpainted || d.wedged || d.behind || d.recoveries)) return;
  _diagSent = true;
  let focus = false;
  try { focus = document.hasFocus(); } catch (e) {}
  try {
    navigator.sendBeacon(`${API}?action=client_diag`, JSON.stringify({
      vis: document.visibilityState, focus: focus,
      vis_ago: _visChangedAt ? now - _visChangedAt : -1,
      recoveries: _paintRecoveries,
      err: _lastPageError ? _lastPageError.msg.slice(0, 80) : '',
      err_ago: _lastPageError ? now - _lastPageError.at : -1,
      panes: list.slice(0, 16)
    }));
  } catch (e) {}
}
window.addEventListener('pagehide', sendDiagBeacon);
window.addEventListener('pageshow', e => { if (e.persisted) _diagSent = false; });

// ── Output payload (both transports) ────────────────────────────────
// Apply one decoded JSON payload from either transport. Returns true if
// the session ended (auth_failed / alive=false / fatal session error)
// so callers know to stop their read loop.
function handleOutputPayload(p, r, sid) {
  // Stale-frame guard: this frame was produced for `sid`, but the pane has
  // since moved to a different (or no) session — a rapid reconnect or a
  // transport switch replaced it. Acting on a stale frame is harmful: a
  // late "session not found" for the OLD sid would otherwise enter the
  // error branch below and tear down the CURRENT session, wedging the
  // pane. Drop it and tell the stale loop to stop. (Callers that don't
  // pass a sid keep the previous behaviour.)
  if (sid !== undefined && p.sid !== sid) return true;
  if (r.error) {
    // Session not found — stale restore or server restarted. Persistent
    // panes try to re-attach via tmux; short-lived panes just reconnect.
    // Idempotency: only enter this branch on the first frame that
    // signals it; later frames (event:end after data on SSE) find
    // p.sid already nulled by us and bail. Without this guard we'd
    // re-enter connectPane and stomp our own reconnect attempt.
    if (!p.sid) return true;
    console.log('output: session error:', r.error);
    endSession(p, {badge: true});
    if(p.host || p.connection) {
      connectPane(p, {label:p.label, resume:p.persistent});
    } else { doAutoConnect(); }
    return true;
  }
  p.connecting=false;
  // Output cursor (servers with lossless reconnect). A frame covers the
  // bytes [cursor - len, cursor). Anything below our own cursor was
  // already written to this terminal - a replay after a reconnect, or
  // EventSource re-sending its original URL - so it is trimmed rather
  // than printed twice. `reset`: the server did not know our cursor and
  // started over from what it still has.
  let chunk = r.data ? atob(r.data) : '';
  if (typeof r.cursor === 'number') {
    let start = r.cursor - chunk.length;
    let have = p.outCursor || 0;
    if (!r.reset && start < have) chunk = chunk.slice(Math.min(chunk.length, have - start));
    if (r.lost) {
      p.term.write('\r\n\x1b[2m[websh: ' + r.lost + ' bytes of output were produced while ' +
                   'disconnected and no longer available]\x1b[0m\r\n');
    }
    p.outCursor = r.reset ? r.cursor : Math.max(have, r.cursor);
  }
  if(chunk.length){
    if (p.inputGate) noteGateOutput(p, chunk);
    // Always render incoming bytes — even on a tail-drain frame that
    // arrives after the disconnect banner, the bytes may be the last
    // thing the shell wrote (final command output, exit message). We
    // lose nothing by writing them after the banner; xterm renders
    // them where the cursor is. Skipping them on p.sid=null would
    // silently drop end-of-session output.
    updatePaneBadge(p);
    noteTabActivity(p);

    // Tight loop instead of Uint8Array.from(chunk, c => c.charCodeAt(0)):
    // this runs per output chunk on the hottest path (noisy output like
    // `cat`/build logs), and the per-element callback in .from() is a
    // measurable tax there. `chunk` (the binary string) is still needed
    // below for recentOutput, so we don't route through _b64ToBytes.
    let bytes = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) bytes[i] = chunk.charCodeAt(i);
    p.term.write(bytes);
    notePaneWritten(p);       // ── Paint guard
    if (p.latPend && p.latPend.length) latOnOutput(p);   // ── Input latency
    // Keep a short tail of decoded output only while we're still
    // within the tmux-death detection window on a persistent pane.
    if (p.persistent && p.connectedAt && (Date.now() - p.connectedAt) < 8000) {
      p.recentOutput = ((p.recentOutput || '') + chunk).slice(-4096);
    }
  }
  // Idempotency guard for the terminal-state branches below. SSE
  // delivers session-end as {alive:false} on data, then a tail-drain
  // {alive:false}, then event:end{alive:false}; each ends up here, and
  // each branch below nulls p.sid on the first call. Without this we'd
  // re-banner, re-stop-keepalive, re-saveSessions 2-3× per disconnect.
  if (!p.sid) return true;
  // SSH auth rejected our password/key: stop the loop cleanly and
  // do NOT save the entry. Surface the failure on the pane itself
  // (reconnect placeholder). The login form never reopens on its own.
  if (r.auth_failed) {
    p.pendingSave = null;
    p.term.write('\r\n\x1b[31m[websh: authentication failed]\x1b[0m\r\n');
    endSession(p, {disconnect: true, badge: true});
    p.recentOutput = '';
    if (p.host || p.connection) showReconnectBar(p, 'auth_failed');
    saveSessions();
    return true;
  }
  // Commit the deferred save once the session has proven healthy
  // (alive and no auth failure for ≥2.5 s).
  if (p.pendingSave && r.alive !== false &&
      p.connectedAt && (Date.now() - p.connectedAt) >= 2500) {
    commitPendingSave(p);
  }
  if(r.alive===false){
    p.term.write('\r\n\x1b[2m[websh: connection closed]\x1b[0m\r\n');
    endSession(p, {save: true});
    // Smart tmux fallback: a persistent pane whose session dies quickly
    // with a "not found" shape in the output is almost certainly a
    // missing tmux binary on the target. Offer re-probe / short-lived.
    let quick = p.connectedAt && (Date.now() - p.connectedAt) < 5000;
    let tail = p.recentOutput || '';
    // Cover the common shells' wordings for "tmux not installed":
    //   bash/dash/sh:  "bash: tmux: command not found", "/bin/sh: tmux: not found"
    //   zsh:           "zsh: command not found: tmux"
    //   ksh:           "ksh: tmux: not found"
    //   fish:          "Unknown command: tmux"  (literal, case-sensitive in fish)
    //   csh/tcsh:      "tmux: Command not found." (capitalised, with period)
    // Plus the ENOENT path: "tmux: No such file or directory" (when invoked
    // with an explicit path that doesn't exist). Avoid matching a bare
    // "not found" without tmux context to stay clear of unrelated errors.
    let hit = /tmux: (?:command )?not found|command not found:?\s*tmux|tmux:\s*Command not found|Unknown command:?\s*tmux|tmux:\s*No such file/i.test(tail);
    if (p.persistent && quick && hit) {
      showTmuxBar(p, 'tmux seems missing on ' + (p.host || 'target') + '.');
    } else if (p.host || p.connection) {
      showReconnectBar(p);
    }
    p.recentOutput = '';
    updatePaneBadge(p);       // any pane: its tab's dot follows it
    return true;
  }
  return false;
}

// Compute the silent-retry delay. While the failure window is under
// RECONNECT_BUDGET_MS, returns ms to wait for the next attempt and
// bumps the failure clock if needed. Returns -1 once the budget is
// exhausted; the caller should then surface the red banner.
function nextRetryDelay(p) {
  if (!p.firstFailureAt) p.firstFailureAt = Date.now();
  let elapsed = Date.now() - p.firstFailureAt;
  if (elapsed >= RECONNECT_BUDGET_MS) return -1;
  let n = (p.retryCount = (p.retryCount || 0) + 1);
  let i = Math.min(n - 1, RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[i];
}

function clearRetryClock(p) {
  p.firstFailureAt = 0;
  p.retryCount = 0;
  p.pollRetries = 0;
  setReconnecting(p, false);
}

// While the transport retries inside RECONNECT_BUDGET_MS the terminal
// just stopped updating - nothing said the connection was being
// re-established or how long websh would keep trying; the user only
// learned at the end, from a red line. Show it on the pane itself: a
// small banner with the time left, and a "Reconnecting" badge.
function setReconnecting(p, on) {
  if (!p || !p.el) return;
  if (!!p.reconnecting === !!on && (!on || p._reconnTimer)) return;
  p.reconnecting = !!on;
  let el = p.el.querySelector('.pane-reconnect');
  if (!on) {
    clearInterval(p._reconnTimer); p._reconnTimer = null;
    if (el) el.remove();
    updatePaneBadge(p);
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'pane-reconnect';
    el.setAttribute('role', 'status');
    p.el.querySelector('.pane-overlays').appendChild(el);
  }
  let paint = () => {
    let left = Math.max(0, Math.ceil(
      (RECONNECT_BUDGET_MS - (Date.now() - (p.firstFailureAt || Date.now()))) / 1000));
    el.textContent = 'Connection lost — reconnecting… (' + left + ' s)';
  };
  paint();
  clearInterval(p._reconnTimer);
  p._reconnTimer = setInterval(paint, 1000);
  updatePaneBadge(p);
}

function transportFatal(p, e) {
  // Stale-transport guard: a rejected fetch / SSE error from a transport
  // that endSession already tore down (p.polling=false) must not banner
  // the pane again — and must not reset p.connecting, which would defuse
  // connectPane's in-flight duplicate guard during an auto-reconnect.
  if (!p.polling) return;
  setReconnecting(p, false);
  // Final fallback: budget exhausted, give up and surface banner.
  console.error('transport gave up:', p.id, e);
  // All websh-injected lines share one form - dim "[websh: …]" for the
  // expected outcomes, red for a real error - so the terminal doesn't
  // shout in bright red about a link that simply dropped, and our lines
  // are never mistaken for the remote's own output.
  let msg = (e && e.message && e.message.indexOf('502') !== -1)
    ? '\r\n\x1b[2m[websh: backend restarted, session lost]\x1b[0m\r\n'
    : '\r\n\x1b[2m[websh: connection lost]\x1b[0m\r\n';
  p.term.write(msg);
  endSession(p, {save: true});
  if(p.host || p.connection) showReconnectBar(p);
  updatePaneBadge(p);         // any pane: its tab's dot follows it
}

// ── Output channel: SSE stream, long-poll fallback, stall detection ─
// Entry point used in place of the old pollOutput(). Tries SSE first,
// then transparently downgrades to long-poll on incompatible proxies.
function startOutput(p) {
  if (!p.sid || !p.polling) return;
  if (typeof EventSource !== 'undefined' && !p.sseDisabled) {
    streamOutput(p);
  } else {
    pollOutput(p);
  }
}

// Restart the pane's output channel from its cursor. Cheap and safe to
// call on suspicion: output is read by cursor, so a restart of a
// healthy channel costs one request and shows nothing twice.
function kickOutput(p, force) {
  if (!p || !p.sid || !p.polling) return false;
  let now = Date.now();
  if (!force && now - (p.lastKickAt || 0) < KICK_MIN_GAP_MS) return false;
  p.lastKickAt = now;
  closeStream(p);
  abortPoll(p);
  clearRetryClock(p);
  startOutput(p);
  return true;
}

function kickAllOutputs(force) {
  Object.values(panes).forEach(p => kickOutput(p, force));
}

// The server's view of how much output the session has produced, from an
// /api/input reply. If this pane has not caught up shortly after, its
// output channel is not delivering.
function noteServerCursor(p, r, sid) {
  if (!r || typeof r.cursor !== 'number' || p.sid !== sid) return;
  let want = r.cursor;
  if (want !== p.serverCursor) { p.serverCursor = want; p.serverCursorAt = Date.now(); }
  let seen = p.outCursor || 0;
  if (want <= seen || p.lagTimer) return;
  p.lagTimer = setTimeout(() => {
    p.lagTimer = null;
    if (p.sid !== sid || !p.polling) return;
    // Still behind AND nothing arrived meanwhile: dead, not slow. A
    // slow link catching up on a burst keeps moving and is left alone.
    if ((p.outCursor || 0) === seen && seen < want) {
      console.log('output: behind the server by', want - (p.outCursor || 0),
                  'bytes, restarting the channel');
      kickOutput(p);
    }
  }, OUTPUT_LAG_MS);
}

let _watchdogLastTick = Date.now();
function outputWatchdogTick() {
  let now = Date.now();
  let gap = now - _watchdogLastTick;
  _watchdogLastTick = now;
  // The timer runs every 5 s (a hidden tab: about once a minute). A much
  // longer gap means the machine slept or the page was frozen; every
  // connection from before is suspect.
  if (gap > 90000) { kickAllOutputs(true); return; }
  Object.values(panes).forEach(p => {
    if (!p || !p.sid || !p.polling || !p.eventSource || !p.serverPings) return;
    if (now - (p.sseLastAt || now) > SSE_STALL_MS) {
      console.log('SSE: silent for', now - p.sseLastAt, 'ms, restarting the stream');
      kickOutput(p);
    }
  });
}
setInterval(outputWatchdogTick, 5000);
window.addEventListener('online', () => kickAllOutputs(true));
// Page Lifecycle: the browser unfroze a background tab.
document.addEventListener('resume', () => kickAllOutputs(true));

// Long-polling, but the stream may work again (another network, a
// restarted proxy; or it was never broken - the first-message timer can
// misfire on a slow link). Try it NEXT TO the poll loop, so the output
// never pauses for the attempt; switch only once an event has actually
// arrived. Each failure doubles the wait.
function maybeProbeSse(p, sid) {
  if (!p.sseDisabled || p.sseDisabledReason === 'unsupported' || p.sseProbe ||
      typeof EventSource === 'undefined' || !outputStreamRoom()) return;
  let wait = p.sseProbeWait || SSE_RETRY_MS;
  if (Date.now() - (p.sseDisabledAt || 0) < wait) return;
  let es;
  try {
    es = openEventSource(`${API}?action=stream&session_id=${encodeURIComponent(sid)}` +
                         `&since=${p.outCursor || 0}`);
  } catch (e) { return; }
  p.sseProbe = es;
  let timer = null;
  let finish = ok => {
    if (p.sseProbe !== es) return;
    clearTimeout(timer);
    try { es.close(); } catch (e) {}
    p.sseProbe = null;
    if (p.sid !== sid || !p.polling) return;
    if (ok) {
      console.log('SSE: works again, leaving long-poll');
      p.sseDisabled = false;
      p.sseProbeWait = 0;
      p.sseEarlyFails = 0;
      abortPoll(p);
      streamOutput(p);
    } else {
      p.sseDisabledAt = Date.now();
      p.sseProbeWait = Math.min(wait * 2, SSE_RETRY_MAX_MS);
    }
  };
  timer = setTimeout(() => finish(false), SSE_FIRST_MSG_TIMEOUT_MS);
  es.addEventListener('data', () => finish(true));
  es.addEventListener('ping', () => finish(true));
  es.addEventListener('end', () => finish(false));
  es.onerror = () => finish(false);
}

function streamOutput(p) {
  if (!p.sid || !p.polling) return;
  closeStream(p);
  abortPoll(p);
  if (!outputStreamRoom()) { pollOutput(p); return; }
  let gen = p.outGen = (p.outGen || 0) + 1;   // supersedes any poll loop
  let mySid = p.sid;
  // since= our output cursor: a reconnect resumes exactly where this
  // pane's terminal stopped, instead of losing whatever the server had
  // already sent into the dead connection. EventSource's own automatic
  // reconnects send Last-Event-ID (the id: of the last event it got).
  let url = `${API}?action=stream&session_id=${encodeURIComponent(mySid)}` +
            `&since=${p.outCursor || 0}`;
  let es;
  try { es = openEventSource(url); }
  catch (e) {
    console.log('SSE: EventSource construction failed, using long-poll');
    disableSse(p, 'unsupported');
    pollOutput(p);
    return;
  }
  p.eventSource = es;
  p.transport = 'sse';          // for the diagnostics beacon
  p.sseGotAnyMessage = false;
  p.sseLastAt = Date.now();
  let armedAt = Date.now();
  // First-message timer: a buffering proxy will hold the response
  // until N bytes accumulate, so no event reaches us. The backend
  // sends ': ok\n\n' on connect specifically to defeat this — if we
  // don't see anything within the timeout, we're behind a buffer.
  if (p.sseFirstMsgTimer) clearTimeout(p.sseFirstMsgTimer);
  p.sseFirstMsgTimer = setTimeout(() => {
    if (!p.sseGotAnyMessage && p.eventSource === es) {
      // Fired late (the page was frozen or the machine asleep while the
      // timer ran), or the browser knows it is offline: that says
      // nothing about a buffering proxy. Start the stream over.
      if (Date.now() - armedAt > SSE_FIRST_MSG_TIMEOUT_MS + 3000 ||
          (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        kickOutput(p, true);
        return;
      }
      console.log('SSE: no event in', SSE_FIRST_MSG_TIMEOUT_MS,
                  'ms, falling back to long-poll');
      disableSse(p, 'buffering');
      closeStream(p);
      if (p.polling) pollOutput(p);
    }
  }, SSE_FIRST_MSG_TIMEOUT_MS);

  // 'open' fires when HTTP response headers arrive — *before* any body
  // bytes traverse the upstream/proxy chain. A buffering proxy (nginx
  // without X-Accel-Buffering: no, Cloudflare free tier, Apache mod_deflate,
  // fastcgi_buffering on) flushes headers immediately and holds the body,
  // which is exactly the case the first-message timer is designed to detect.
  // So we DO NOT mark sseGotAnyMessage on 'open' — only body events
  // ('data' / 'end') prove the channel actually flushes. We also DO NOT
  // clear the retry clock on 'open': through a buffering proxy the
  // headers arrive but no body ever does, and resetting the budget on
  // every 'open' would let an unbroken series of half-working
  // connections starve the wall-clock retry budget. The first-message
  // timer is the safety net that fires the long-poll fallback; the
  // retry clock should only reset once a real frame proves the channel.
  let onBodyEvent = () => {
    p.sseGotAnyMessage = true;
    p.sseEarlyFails = 0;
    p.sseLastAt = Date.now();
    clearRetryClock(p);
  };
  // Heartbeat (servers that send it): proves the stream is alive while
  // the session is quiet. See outputWatchdogTick.
  es.addEventListener('ping', () => {
    if (p.eventSource !== es) return;
    p.serverPings = true;
    onBodyEvent();
  });
  // EventSource fires onmessage for unnamed events; the ': ok' comment
  // doesn't trigger it but still arrives on the wire. We rely on the
  // 'data' / 'end' named events here.
  es.addEventListener('data', e => {
    onBodyEvent();
    let r;
    try { r = JSON.parse(e.data); }
    catch (err) { console.error('SSE bad payload:', err); return; }
    handleOutputPayload(p, r, mySid);
  });
  es.addEventListener('end', e => {
    onBodyEvent();
    let r = {alive: false};
    try { r = JSON.parse(e.data); } catch (err) {}
    handleOutputPayload(p, r, mySid);
    closeStream(p);
  });
  es.onerror = () => {
    // EventSource auto-reconnects on transient errors; we let it for
    // a while, then escalate. If we never got a message at all, treat
    // it as "this transport doesn't work here" and switch to long-poll.
    if (!p.sseGotAnyMessage) {
      closeStream(p);
      p.sseEarlyFails = (p.sseEarlyFails || 0) + 1;
      if (p.sseEarlyFails >= SSE_EARLY_FAIL_LIMIT) {
        console.log('SSE: failed before the first event', p.sseEarlyFails,
                    'times in a row, using long-poll');
        disableSse(p, 'errors');
        if (p.polling) pollOutput(p);
        return;
      }
      // Used to switch the pane to long-poll for good on the first such
      // error - one 409 during a reconnect, or a deploy restarting the
      // backend, left panes polling (a request per output chunk) for
      // hours. Ask over plain HTTP, then come back to the stream.
      let d = nextRetryDelay(p);
      if (d < 0) { transportFatal(p, new Error('SSE reconnect budget exhausted')); return; }
      setReconnecting(p, true);
      setTimeout(() => recoverClosedStream(p, mySid, gen), d);
      return;
    }
    let d = nextRetryDelay(p);
    if (d < 0) { transportFatal(p, new Error('SSE reconnect budget exhausted')); return; }
    setReconnecting(p, true);
    if (es.readyState === 2 /* EventSource.CLOSED */) {
      // It will never retry on its own: previously the pane then showed
      // "reconnecting… (0 s)" forever and dropped every keystroke.
      closeStream(p);
      setTimeout(() => recoverClosedStream(p, mySid, gen), d);
    }
    // Otherwise EventSource retries by itself (~3 s); we only enforce
    // the total-elapsed budget.
  };
}

// One loop per pane: `gen` is the loop's ticket, and starting any output
// channel (a new loop, a stream) takes a new one. Two loops used to run
// side by side after a reconnect - every request doubled.
function pollOutput(p, gen) {
  if(!p.sid || !p.polling) return;
  if (gen === undefined) { abortPoll(p); gen = p.outGen = (p.outGen || 0) + 1; }
  else if (gen !== p.outGen) return;
  let mySid = p.sid;
  p.transport = 'long-poll';
  // A request parked on a dead connection never answers by itself.
  let ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  p.pollAbort = ctl;
  let stall = setTimeout(() => { if (ctl) { try { ctl.abort(); } catch (e) {} } }, POLL_STALL_MS);
  api('output',{query:'&session_id='+mySid+'&since='+(p.outCursor || 0),
                signal: ctl ? ctl.signal : undefined}).then(r => {
    clearTimeout(stall);
    if (isTransientOutputReply(r)) throw new Error(r.error);
    if (gen !== p.outGen && r && r.error) return;   // stale loop: not its call
    if (gen === p.outGen) clearRetryClock(p);
    if (handleOutputPayload(p, r, mySid)) return;
    if (!p.polling || p.sid !== mySid || gen !== p.outGen) return;
    // A capacity-limited pane can take a stream freed by another pane.
    // Real fallback panes still use the existing explicit probe path.
    if (!p.sseDisabled && typeof EventSource !== 'undefined' && outputStreamRoom()) {
      streamOutput(p);
      return;
    }
    maybeProbeSse(p, mySid);
    pollOutput(p, gen);
  }).catch(e => {
    clearTimeout(stall);
    if (p.sid !== mySid || gen !== p.outGen) return;   // replaced meanwhile
    let d = nextRetryDelay(p);
    if (d < 0) { transportFatal(p, e); return; }
    setReconnecting(p, true);
    setTimeout(() => { if(p.polling) pollOutput(p, gen) }, d);
  });
}

// EventSource gave up for good (readyState CLOSED): it does that on ANY
// non-200 reconnect reply - 404 after a backend restart, 409 while the
// old stream still holds the slot, 502 from a proxy, 503 busy - and
// never retries again. Ask once over plain HTTP, which returns a status:
// a real answer (a frame, or "session not found") goes through the
// normal path - including resume/reconnect for a session that is gone -
// and a transient failure waits and asks again, inside the same budget.
function recoverClosedStream(p, mySid, gen) {
  if (!p.polling || p.sid !== mySid) return;
  if (gen !== undefined && gen !== p.outGen) return;
  p.transport = 'recover';
  let ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  p.pollAbort = ctl;      // kickOutput/abortPoll can cancel it, like a poll
  let stall = setTimeout(() => { if (ctl) { try { ctl.abort(); } catch (e) {} } }, POLL_STALL_MS);
  api('output', {query: '&session_id=' + mySid + '&since=' + (p.outCursor || 0),
                 signal: ctl ? ctl.signal : undefined}).then(r => {
    clearTimeout(stall);
    if (isTransientOutputReply(r)) throw new Error(r.error);
    if (p.sid !== mySid) return;
    if (gen !== undefined && gen !== p.outGen) return;
    clearRetryClock(p);
    if (handleOutputPayload(p, r, mySid)) return;
    if (p.polling) streamOutput(p);     // healthy again: back to SSE
  }).catch(e => {
    clearTimeout(stall);
    if (!p.polling || p.sid !== mySid) return;
    if (gen !== undefined && gen !== p.outGen) return;
    let d = nextRetryDelay(p);
    if (d < 0) { transportFatal(p, e); return; }
    setReconnecting(p, true);
    setTimeout(() => recoverClosedStream(p, mySid, gen), d);
  });
}

// ── Input: ordered, held across a persistent re-attach ─────────────
// Keystrokes leave in order: at most ONE /api/input per pane is in
// flight, and whatever is typed meanwhile goes out as the next batch.
// Firing a request per 10ms batch without waiting let them overtake
// each other - over HTTP/2 a burst reaches the proxy together, fans out
// to the backend on separate connections, and its worker threads write
// to the PTY in whatever order they are scheduled: typed text arrived
// scrambled ("ecoh" for "echo") on any link with jitter.
let INPUT_STALL_MS = 10000;     // a hung request must not freeze typing
const INPUT_RETRIES = 3;

// Keys typed while a persistent pane re-attaches (its server session
// expired during an absence; the tmux shell is the same one) are held
// and sent once it is back - they used to vanish, or sit in the queue
// and go out with whatever was typed after a reconnect hours later.
// Never into a NEW shell (non-persistent reconnect), and never stale:
// the queue is dropped when nothing has been typed for INPUT_HOLD_MS.
const INPUT_HOLD_MS = 20000;

// A persistent pane that has just (re)connected is not ready for keys
// the moment /api/connect answers: ssh is still logging in and tmux has
// not attached, and what is written to the PTY then is eaten by the
// login. Keys wait behind a gate until tmux has drawn its screen (it
// switches to the alternate screen on attach) and gone quiet; never
// longer than INPUT_GATE_MAX_MS.
const INPUT_GATE_MAX_MS = 6000;

function armInputGate(p) {
  closeInputGate(p);
  p.inputGate = true;
  p.inputGateMax = setTimeout(() => openInputGate(p), INPUT_GATE_MAX_MS);
}

function closeInputGate(p) {
  p.inputGate = false;
  clearTimeout(p.inputGateMax); clearTimeout(p.inputGateSoon);
  p.inputGateMax = p.inputGateSoon = null;
}

function noteGateOutput(p, chunk) {
  if (chunk.indexOf('\x1b[?1049h') !== -1) p.inputGateAttached = true;
  // Quiet for a while AFTER the last frame: tmux flushes what arrives
  // while its client is still starting (keys sent 200 ms after the
  // first frame were lost one run in three).
  clearTimeout(p.inputGateSoon);
  let attached = p.inputGateAttached;
  p.inputGateSoon = setTimeout(() => openInputGate(p, attached ? 'tmux attached' : 'output quiet'),
                               attached ? 500 : 1500);
}

function openInputGate(p, why) {
  if (!p.inputGate) return;
  console.log('input gate: open (' + (why || 'timeout') + '), held keys:', p.inputQueue.join('').length);
  closeInputGate(p);
  p.inputGateAttached = false;
  if (!p.inputQueue.length) return;
  if (Date.now() - (p.inputQueuedAt || 0) < INPUT_HOLD_MS) flushInput(p);
  else p.inputQueue = [];
}

function holdInput(p, d) {
  p.inputQueue.unshift(d);
  p.inputQueuedAt = Date.now();
}

function queueInput(p, data) {
  if (!p.sid) {
    // Disconnected and nobody is reconnecting: nothing will read this.
    if (!p.connecting || !p.persistent) return;
  }
  // Expiry is a boundary BEFORE this new keystroke. Otherwise a stale
  // held batch waiting for backoff could later discard fresh input
  // typed after the channel recovered along with its old backlog.
  discardExpiredSealedInput(p);
  p.inputQueuedAt = Date.now();     // freshness of the NEWEST key
  if (!p.inputQueue.length || !p.latKeyAt) p.latKeyAt = latNow();   // ── Input latency
  p.inputQueue.push(data);
  latNoteDepth(p);
  if(!p.flushTimer && !p.inputInFlight) p.flushTimer = setTimeout(() => flushInput(p), 10);
}

// Sealed mode: batches the encrypted channel could not carry (a local
// "sealed_unavailable" reply - nothing was sent) wait in p.sealHeld,
// ahead of anything typed since, and go out when the channel can be
// tried again. Never late (I3): if the oldest of them is older than
// INPUT_HOLD_MS, all of them are dropped, with a notice - never a
// suffix of a command without its start.
function discardExpiredSealedInput(p) {
  let held = p.sealHeld || [];
  if (held.length &&
      (Date.now() - held[0].at > INPUT_HOLD_MS || held[0].sid !== p.sid)) {
    p.sealHeld = [];
    // A suffix queued for the SAME session belongs to its blocked
    // prefix: dropping only the prefix could execute another command.
    // After a session change, queued fresh keys belong to the new
    // session and must survive disposal of the old held batch.
    if (held[0].sid === p.sid) {
      p.inputQueue = [];
      p.latKeyAt = 0;
    }
    showToast('Keys typed while the encrypted channel was unavailable were not sent.', 'warn');
  }
}

function takeSealedHeld(p) {
  discardExpiredSealedInput(p);
  let held = p.sealHeld || [];
  p.sealHeld = [];
  return held;
}

function flushInput(p) {
  p.flushTimer = null;
  // Drop an already queued suffix with its expired prefix even while
  // the channel is still in backoff; it must never become a request.
  discardExpiredSealedInput(p);
  let held = p.sealHeld && p.sealHeld.length;
  if(p.inputInFlight || !p.sid || p.inputGate || (!p.inputQueue.length && !held)) return;
  let parts = [];
  if (held) {
    let wait = _sealWaitMs();
    if (wait > 0) { p.flushTimer = setTimeout(() => flushInput(p), wait); return; }
    parts = takeSealedHeld(p);
  }
  if (p.inputQueue.length) {
    parts.push({d: p.inputQueue.join(''), at: Date.now(), sid: p.sid, k: p.latKeyAt || latNow()});
    p.inputQueue = [];
    p.latKeyAt = 0;
  }
  if (!parts.length) return;
  let d = parts.map(x => x.d).join('');
  // Only a large paste can approach the server body cap; for those, check
  // the real UTF-8 body size and surface an error instead of a silent 400.
  if(d.length > 1048576){
    let body=JSON.stringify({session_id:p.sid,data:d});
    if(new TextEncoder().encode(body).length > MAX_INPUT_BODY){
      showErr('Paste too large to send (server limit ~8 MB) — not sent.');
      return;
    }
  }
  sendInputBatch(p, p.sid, d, 0, parts);
}

// A missing/invalid sealed reply is not proof of non-delivery. Its old
// command suffix must not become a standalone command. A newer session
// owns its own keys, so a late failure from the old one cannot drop them.
function discardUnconfirmedInput(p, sid) {
  if (p.sid !== sid) return;
  p.inputQueue = [];
  p.latKeyAt = 0;
  p.sealHeld = (p.sealHeld || []).filter(x => x.sid !== sid);
  clearTimeout(p.flushTimer);
  p.flushTimer = null;
}

function sendInputBatch(p, sid, d, attempt, parts) {
  if (!parts) parts = [{d: d, at: Date.now(), sid: sid}];
  let lat = latBatch(parts);   // ── Input latency: one per batch, across resends
  let token = {};
  p.inputInFlight = token;
  let settled = false;
  let release = () => {
    if (settled) return;
    settled = true;
    clearTimeout(stall);
    if (p.inputInFlight === token) p.inputInFlight = null;
    if (p.inputQueue.length && !p.flushTimer) flushInput(p);
  };
  // Give up waiting (not on the request): typing resumes; a reply that
  // turns up later changes nothing.
  let ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  // A big paste on a slow uplink legitimately takes long: allow a
  // second per 20 KB on top of the base.
  let stallMs = INPUT_STALL_MS + Math.floor(d.length / 20);
  let stall = setTimeout(() => {
    // Not answered in time: the connection it went out on is probably
    // dead, and so is the output channel's. Cancel it, so it cannot
    // land later, after keys typed since.
    let sent = ctl && _sealSentRequests.get(ctl.signal);
    if (sent) {
      _sealReplyError(sent.ch, true, sent);
      discardUnconfirmedInput(p, sid);
    }
    if (ctl) { try { ctl.abort(); } catch (e) {} }
    latDrop(p, lat);
    if (!sent && d.length > 1024) showErr('A paste of ' + Math.round(d.length / 1024) + ' KB was not delivered (no answer from the server) - paste it again.');
    release();
    kickOutput(p);
  }, stallMs);
  latSent(p, lat);
  api('input',{body:{session_id:sid,data:d}, signal: ctl ? ctl.signal : undefined}).then(r => {
    if (!settled && r && r._status === 404 && r.error) {
      // The session is gone. Someone else may have noticed first (the
      // keepalive's 404 landing a few ms earlier, the output loop) and
      // the pane is already re-attaching, or is back: the keys are held
      // either way. After inputSaysSessionGone, so that endSession's
      // reset cannot touch them; before release().
      if (p.sid === sid) inputSaysSessionGone(p, r, sid);
      if (p.persistent && (p.connecting || p.sid)) holdInput(p, d);
      latDrop(p, lat);
      release();
      return;
    }
    noteServerCursor(p, r, sid);
    // Sealed and the channel could not be used: nothing was sent. Hold
    // the batch (see takeSealedHeld) instead of the quick resends below,
    // which an outage longer than a second would exhaust.
    if (!settled && r && r.code === 'sealed_unavailable' && p.sid === sid) {
      settled = true; clearTimeout(stall);
      if (p.inputInFlight === token) p.inputInFlight = null;
      latDrop(p, lat);
      p.sealHeld = parts.concat(p.sealHeld || []);
      if (!p.flushTimer) p.flushTimer = setTimeout(() => flushInput(p), Math.max(250, _sealWaitMs()));
      return;
    }
    // Only websh's explicit before-write refusals prove that resending
    // is safe. A proxy's generic 502/503/429 can follow a successful
    // PTY write whose reply was lost, so status alone cannot authorize
    // a resend. Keep the exact legacy busy reply for cached servers.
    let st = r && r.error && r._status;
    let safeRetry = (st === 503 && (r.code === 'busy' || r.code === 'restarting' ||
                                  r.error === 'busy')) ||
                    (st === 429 && r.code === 'rate_limited');
    if (!settled && safeRetry &&
        attempt < INPUT_RETRIES && p.sid === sid) {
      settled = true; clearTimeout(stall);
      setTimeout(() => sendInputBatch(p, sid, d, attempt + 1, parts), 200 * (attempt + 1));
      return;
    }
    if (!settled && r && !r.error) latReplied(p, lat); else latDrop(p, lat);
    release();
  }, e => {
    if (!settled && e && e.sealedDeliveryUnknown) discardUnconfirmedInput(p, sid);
    latDrop(p, lat);
    release();
  });
}

// ── Input latency ───────────────────────────────────────────────────
// "What I type shows up late" needs numbers from real use, by stage.
// Per input batch (one /api/input), on performance.now():
//   queue  first key (onData) -> the request sent (behind one in flight,
//          held, resent)
//   rtt    sent -> its reply
//   echo   sent -> the first output for the pane arriving afterwards
//          (SSE or long-poll); none within LAT_ECHO_MS = "no echo"
//          (a password, a silent command): out of echo/paint/total
//   paint  that arrival -> xterm's next render of the pane
//   total  first key -> that render: what the user feels
// Every LAT_INTERVAL_MS (window.WEBSH_LAT_INTERVAL_MS, read at load;
// 5 min) a page that sent input reports p50/p90/max per stage per pane,
// the slowest batch's breakdown and the deepest input queue, through
// api() - so sealed when sealed mode is on (then only over a channel
// that is already open: a report never opens one, never shows a toast).
// At pagehide what is left goes as a beacon, plain mode only. Numbers
// and short words; no keys, no output. A failed or rate-limited report
// is dropped; a 404 (a server without the action) stops reports for the
// page. The hot path only stores timestamps: this never delays, reorders
// or holds a key (I1-I4). Server side: format_client_lat, input_lat.
const LAT_ECHO_MS = 2000;
const LAT_SLOW_MS = 300;
const LAT_SAMPLES_MAX = 2000;
const LAT_STAGES = ['queue', 'rtt', 'echo', 'paint', 'total'];
const LAT_INTERVAL_MS = (() => {
  try { let v = Number(window.WEBSH_LAT_INTERVAL_MS); if (v > 0) return v; } catch (e) {}
  return 300000;
})();
let _latStats = [];          // stats objects with samples in this window
let _latOff = false;         // the server does not know client_lat
let _latWindowAt = Date.now();

function latNow() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function latStatsOf(p) {
  let st = p.latStats;
  if (!st) {
    st = p.latStats = {pane: p, sid: '', mode: '', n: 0, n_echo: 0, slow: 0, depth: 0,
                       s: {queue: [], rtt: [], echo: [], paint: [], total: []},
                       mx: {queue: 0, rtt: 0, echo: 0, paint: 0, total: 0},
                       worst: null, wkey: -1, listed: false};
  }
  if (!st.listed) { st.listed = true; _latStats.push(st); }
  return st;
}

// Requests in flight or queued for this pane right now (I1: at most one
// in flight; the queue becomes one request; batches held by sealed mode).
function latNoteDepth(p) {
  let depth = (p.inputInFlight ? 1 : 0) + (p.sealHeld ? p.sealHeld.length : 0) + 1;
  let st = latStatsOf(p);
  if (depth > st.depth) st.depth = depth;
}

function latBatch(parts) {
  if (parts.lat) return parts.lat;
  let k = Infinity;
  for (let i = 0; i < parts.length; i++) if (parts[i].k && parts[i].k < k) k = parts[i].k;
  return (parts.lat = {k: k === Infinity ? latNow() : k, s: 0, r: 0, e: 0, t: 0});
}

function latSent(p, m) {
  m.s = latNow(); m.r = m.e = m.t = 0;
  m.mode = paneTransport(p);
  let q = p.latPend || (p.latPend = []);
  if (q.indexOf(m) < 0) { q.push(m); if (q.length > 8) q.shift(); }
  latSweep(p, m.s);
}

function latReplied(p, m) { m.r = latNow(); latSweep(p, m.r); }

function latDrop(p, m) {
  let q = p.latPend, i = q ? q.indexOf(m) : -1;
  if (i >= 0) q.splice(i, 1);
}

// Output reached the pane (handleOutputPayload): the echo of every
// batch sent in the last LAT_ECHO_MS that has none yet.
function latOnOutput(p) {
  let now = latNow(), q = p.latPend;
  for (let i = 0; i < q.length; i++) {
    let m = q[i];
    if (!m.e && now - m.s <= LAT_ECHO_MS) { m.e = now; p.latPaint = true; }
  }
}

// xterm rendered the pane with nothing left unparsed (notePaneRendered).
function latOnRender(p) {
  p.latPaint = false;
  let now = latNow(), q = p.latPend || [];
  for (let i = 0; i < q.length; i++) if (q[i].e && !q[i].t) q[i].t = now;
  latSweep(p, now);
}

// Record the batches whose outcome is known.
function latSweep(p, now) {
  let q = p.latPend;
  if (!q || !q.length) return;
  for (let i = 0; i < q.length; ) {
    let m = q[i], done = false;
    if (!m.r) done = now - m.s > 60000;                 // never answered: forget
    else if (m.t) { latRecord(p, m, true); done = true; }
    else if (m.e) { if (now - m.e > LAT_ECHO_MS) { latRecord(p, m, false); done = true; } }
    else if (now - m.s > LAT_ECHO_MS) { latRecord(p, m, false); done = true; }
    if (done) q.splice(i, 1); else i++;
  }
}

function latRecord(p, m, painted) {
  let st = latStatsOf(p);
  st.sid = String(p.sid || st.sid || '').slice(0, 8);
  // The transport the pane used in this window (as each batch went
  // out), not its state when the report goes out: at pagehide the
  // browser has already closed the stream.
  if (st.mode !== 'sse') st.mode = m.mode || paneTransport(p);
  // A batch recorded at pagehide may have no reply yet (rtt -1).
  let v = {queue: m.s - m.k, rtt: m.r ? m.r - m.s : -1, echo: m.e ? m.e - m.s : -1,
           paint: painted ? m.t - m.e : -1, total: painted ? m.t - m.k : -1};
  st.n++;
  if (v.echo >= 0) st.n_echo++;
  if (v.total > LAT_SLOW_MS) st.slow++;
  for (let i = 0; i < LAT_STAGES.length; i++) {
    let k = LAT_STAGES[i], x = v[k];
    if (x < 0) continue;
    x = Math.max(0, x);
    let a = st.s[k];
    if (a.length < LAT_SAMPLES_MAX) a.push(x);
    else { let j = Math.floor(Math.random() * st.n); if (j < LAT_SAMPLES_MAX) a[j] = x; }
    if (x > st.mx[k]) st.mx[k] = x;
  }
  let key = v.total >= 0 ? v.total : v.queue + v.rtt;
  if (key > st.wkey) { st.wkey = key; st.worst = v; }
}

function latPcts(a, mx) {
  if (!a.length) return {p50: -1, p90: -1, max: -1};
  let s = a.slice().sort((x, y) => x - y), n = s.length;
  let pick = q => Math.round(s[Math.min(n - 1, Math.max(0, Math.ceil(n * q / 100) - 1))]);
  return {p50: pick(50), p90: pick(90), max: Math.round(mx)};
}

function latPaneReport(st) {
  let d = {sid: st.sid || '-', mode: st.mode || paneTransport(st.pane), sealed: sealedOn(),
           n: st.n, n_echo: st.n_echo, slow: st.slow, worst: {}, inflight_max: st.depth};
  LAT_STAGES.forEach(k => {
    d[k] = latPcts(st.s[k], st.mx[k]);
    let w = st.worst ? st.worst[k] : -1;
    d.worst[k] = w >= 0 ? Math.round(w) : -1;
  });
  return d;
}

function latReport(leaving) {
  try {
    if (_latOff) return;
    let now = latNow();
    Object.values(panes).forEach(p => {
      if (!p || !p.latPend || !p.latPend.length) return;
      latSweep(p, now);
      // Leaving: the batches still waiting for their reply, echo or
      // render will never finish here. Count them with the stages
      // already known (n; n_echo if the echo came; total if painted).
      if (leaving) { p.latPend.forEach(m => latRecord(p, m, !!m.t)); p.latPend = []; }
    });
    let list = _latStats.filter(st => st.n > 0);
    if (!list.length) return;
    // Sealed: only over a channel that is already open (a report never
    // opens one or shows its toast), and never as a plain beacon.
    if (sealedOn() && (leaving || !_seal)) return;
    let body = {window_ms: Math.round(Date.now() - _latWindowAt),
                vis: document.visibilityState, panes: list.slice(0, 16).map(latPaneReport)};
    _latStats.forEach(st => {
      st.listed = false; st.n = st.n_echo = st.slow = st.depth = 0; st.mode = '';
      st.worst = null; st.wkey = -1;
      LAT_STAGES.forEach(k => { st.s[k] = []; st.mx[k] = 0; });
    });
    _latStats = [];
    _latWindowAt = Date.now();
    let json = JSON.stringify(body);
    if (leaving) {
      let url = `${API}?action=client_lat`;
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) navigator.sendBeacon(url, json);
      else fetch(url, {method: 'POST', body: json, keepalive: true,
                       headers: {'Content-Type': 'application/json'}}).catch(() => {});
      return;
    }
    api('client_lat', {body: body}).then(r => {
      if (r && r._status === 404) _latOff = true;
    }, () => {});
  } catch (e) {}
}
setInterval(() => latReport(false), LAT_INTERVAL_MS);
window.addEventListener('pagehide', () => latReport(true));

// ── Unified connect ─────────────────────────────────────────────────
// opts = { label, host, port, user, connection, auth, password, key, keyPass,
//          conn_id?, persistent, slotId?, resume? }
// `resume` flag triggers attach-by-slot_id on the backend.
// Vault-backed panes (opts.conn_id or p.conn_id set) re-derive vault_key
// from IDB at every connect — caching it on the pane would let a
// sign-out in another tab leave a stale key in memory.
// Shared tail of BOTH connect pipelines (the form flow's
// finalizeSuccess and the reconnect/restore flow in connectPane): the
// session is confirmed, the pane fields are set — close the login
// surfaces and start I/O. The two pipelines genuinely differ in
// everything BEFORE this point (materialize-vs-reuse, opts copying,
// deferred-save arming, slot semantics), so only this verbatim-
// identical tail is shared; do not try to merge more of them without
// re-reading both flows end to end.
// o.fromForm: this session is the one the login form was opened for (the
// form's own success path). Only then does it close the form and clear
// the form's state. A BACKGROUND pane finishing a reconnect or an F5
// restore used to do it too: it hid a form the user was typing in (the
// next keystrokes went to that pane's shell) and nulled pendingSplit, so
// the user's split connect then landed in the active pane - overwriting
// its session, which was never disconnected - instead of a new split.
function beginSessionIO(p, o) {
  if ((o && o.fromForm) || connectingFor === p.id) {
    hideOverlay();
    connectingFor = null;
    overlayMode = null;
    pendingSplit = null;
    p.term.focus();
  } else if (activeId === p.id && $('ov').classList.contains('h')) {
    p.term.focus();            // the pane in front, nothing else open
  }
  p.polling = true;
  p.pollRetries = 0;
  // Force a resize so resumed tmux sessions redraw at the real size.
  // flushPaneResize uses p.term.cols/rows post-fit and updates
  // p.lastSent* so subsequent refit triggers can dedup.
  // A pane in a hidden tab (restored on reload) has no box: the PTY was
  // created at the size the connect asked for, which is what the server
  // now has; showTab() fits it and resizes only if that differs.
  if (paneHidden(p)) {
    p._fitDeferred = true;
    if (p._connectCols && p._connectRows) {
      p.lastSentCols = p._connectCols;
      p.lastSentRows = p._connectRows;
    }
  } else {
    p.fitAddon.fit();
    flushPaneResize(p);
  }
  updatePaneBadge(p);
  startKeepalive(p);
  saveSessions();
  startOutput(p);
  p.inputGateAttached = false;
  if (p.persistent) armInputGate(p);      // held keys go out when it opens
  else p.inputQueue = [];                 // a new shell gets none of the old keys
}

async function connectPane(p, opts) {
  // In-flight guard: a connect is already running for this pane. A second
  // entrant (double Reconnect click, a manual reconnect racing the
  // session-error auto-reconnect in handleOutputPayload) would launch a
  // second /api/connect, overwrite p.sid with the later session, and leak
  // the first server PTY until its idle timeout. Ignore the duplicate.
  if (p.connecting) {
    console.log('connectPane: connect already in flight for pane ' + p.id +
                ', ignoring duplicate');
    return;
  }
  p.label = opts.label || '';
  if (opts.host !== undefined) p.host = opts.host || '';
  if (opts.port !== undefined) p.port = opts.port || 22;
  if (opts.user !== undefined) p.user = opts.user || '';
  if (opts.connection !== undefined) p.connection = opts.connection || null;
  if (opts.auth !== undefined) p.auth = opts.auth || 'pw';
  if (opts.password !== undefined) p.password = opts.password || '';
  if (opts.key !== undefined) p.key = opts.key || '';
  if (opts.keyPass !== undefined) p.keyPass = opts.keyPass || '';
  if (opts.conn_id !== undefined) p.conn_id = opts.conn_id || null;
  if (opts.persistent !== undefined) p.persistent = !!opts.persistent;
  if (opts.slotId) p.slotId = opts.slotId;
  else if (p.persistent && !p.slotId) p.slotId = slotIdFor(p.user, p.host, p.port);
  if (opts.tmuxCmd !== undefined) p.tmuxCmd = opts.tmuxCmd || 'tmux';
  if (opts.saveEntry !== undefined) p.pendingSave = opts.saveEntry;

  hideReconnectBar(p);
  p.connecting = true;
  let labelEl = p.el.querySelector('[data-pane-label]');
  if (labelEl) labelEl.textContent = p.label;
  p.term.reset();
  // Only the active pane owns the document title — a background pane
  // (auto-reconnect while the user works elsewhere) must not clobber it.
  if (activeId === p.id) setTitle(p.label);
  updatePaneBadge(p);

  let rec = paneRecord(p);
  if (rec && rec.via === 'vault') {
    // Use the non-minting variants. If IDB has been wiped between save
    // and now (Safari ITP eviction, user cleared site data, sign-out
    // in another tab), we must NOT silently mint a fresh K — that
    // mints garbage that can't decrypt the server-side blob AND
    // defeats the .nokey cleanup UX in renderSaved. Surface the
    // condition and bail with the reconnect bar showing "no_vault_key".
    let vault_id_b32 = null;
    let key = null;
    try {
      vault_id_b32 = await ensureVaultIdIfPresent();
      key = await ensureVaultKeyIfPresent();
    } catch (e) { /* IDB broken — treat as missing */ }
    if (!vault_id_b32 || !key) {
      p.connecting = false;
      showReconnectBar(p, 'no_vault_key');
      showToast('Saved pane "' + (p.label || (p.user + '@' + p.host)) +
                '" cannot reconnect — vault key missing in this browser. ' +
                'Use the saved-card list to clean up.', 'warn');
      updatePaneBadge(p);
      return;
    }
    rec.vault_id = vault_id_b32;
    // key already in cache; pass it through so exportRawVaultKey doesn't
    // re-read IDB (which a wipe between our IfPresent guard and now
    // would otherwise let it mint from). exportKey can still throw on
    // corrupt CryptoKey / OOM — route to the no-key reconnect bar
    // instead of leaving the pane in connecting=false with an
    // unhandled rejection. (Finding 3 in the PR-67 review.)
    try {
      rec.vault_key = await exportRawVaultKey(key);
    } catch (e) {
      p.connecting = false;
      showReconnectBar(p, 'no_vault_key');
      showToast('Could not export the vault key for "' +
                (p.label || (p.user + '@' + p.host)) +
                '". Try signing out and re-saving.', 'err');
      updatePaneBadge(p);
      return;
    }
  } else if (rec) {
    // Manual / named: paneRecord intentionally strips plaintext from the
    // disk shape (kept in sessionStorage, see _setPaneSecret). Pass the
    // live in-memory credentials through to the body builder.
    rec.password = p.password || '';
    rec.key = p.key || '';
    rec.key_pass = p.keyPass || '';
  }
  let body = buildConnectBody(rec, p.term.cols, p.term.rows);
  if (opts.resume && p.slotId) body.resume_slot_id = p.slotId;
  // The size this PTY starts at (beginSessionIO, for a hidden pane).
  p._connectCols = body.cols; p._connectRows = body.rows;

  if (body.vault_id) {
    console.log('connectPane: vault conn_id=' + body.conn_id +
                ' persistent=' + !!body.persistent);
  } else {
    console.log('connectPane: host=' + body.host + ' user=' + body.username +
                ' persistent=' + !!body.persistent +
                ' pw len=' + ((body.password || '').length) +
                ' key len=' + ((body.key || '').length));
  }

  api('connect', {body: body})
    .then(r => {
      // The pane may have been destroyed while /api/connect was in flight
      // (tab closed, vault sign-out teardown, rapid reconnect churn). Every
      // other async path guards on panes[p.id] === p; this one must too, or
      // it re-arms keepalive/output timers on a dead pane and — worse —
      // leaks the server PTY that connect just created. Reap the orphan.
      if (panes[p.id] !== p) {
        if (r && r.session_id) {
          api('disconnect', {body: {session_id: r.session_id}}).catch(() => {});
        }
        return;
      }
      console.log('connect result:', r);
      p.connecting = false;
      if (r.error) { p.pendingSave = null; surfaceConnectError(p, r.error, 'error'); updatePaneBadge(p); return }
      if (r.auth_failed) {
        p.pendingSave = null;
        updatePaneBadge(p);
        // If the form is still open (user just clicked Connect), keep it
        // visible with an error so they can retry or dismiss. Otherwise
        // (refresh re-auth, reconnect retry) surface on the pane.
        let formOpen = !$('ov').classList.contains('h');
        if (formOpen) {
          showErr('Authentication failed — check password or key.');
        } else {
          p.term.write('\r\n\x1b[31m[websh: authentication failed]\x1b[0m\r\n');
          if (p.host || p.connection) showReconnectBar(p, 'auth_failed');
          connectingFor = null;
          overlayMode = null;
          pendingSplit = null;
        }
        return;
      }
      if (r.alive === false) {
        p.pendingSave = null;
        surfaceConnectError(p, 'SSH process exited immediately', 'error');
        updatePaneBadge(p);
        if (p.persistent) showTmuxBar(p, 'Connection died immediately — tmux may be missing on ' + (p.host || 'target') + '.');
        return;
      }
      p.sid = r.session_id;
      p.outCursor = 0;          // a new session's output starts at offset 0
      if (r.slot_id) p.slotId = r.slot_id;
      if (r.tmux_cmd) p.tmuxCmd = r.tmux_cmd;
      p.connectedAt = Date.now();
      p.recentOutput = '';
      // A deferred save may still be pending from the original connect
      // (session error inside the 2.6s commit window -> auto-reconnect
      // lands here). endSession cleared the old timer; re-arm it against
      // the NEW sid, or an idle SSE session would never commit the save
      // (the output-gated path needs a frame >=2.5s after connectedAt).
      if (p.pendingSave) scheduleSaveCommit(p);
      // Persist a non-default tmux path on the matching saved entry so
      // future connects skip the probe and use the right binary path.
      if (p.persistent && p.tmuxCmd && p.tmuxCmd !== 'tmux') {
        let list = loadSaved();
        let dirty = false;
        for (let i = 0; i < list.length; i++) {
          let c = list[i];
          if (c.host === p.host && c.port === (p.port || 22) && c.user === p.user && c.tmux_cmd !== p.tmuxCmd) {
            c.tmux_cmd = p.tmuxCmd; dirty = true;
          }
        }
        if (dirty) saveSaved(list);
      }
      hideTmuxBar(p);
      beginSessionIO(p);
    })
    .catch(e => {
      // Mirror the .then guard above: if the pane was destroyed while the
      // request was in flight, it failed so there is no session to reap —
      // just bail rather than flashing a global error for a closed pane.
      if (panes[p.id] !== p) return;
      p.connecting = false;
      surfaceConnectError(p, 'Connection failed: ' + e.message, 'error');
      updatePaneBadge(p);
    });
}

function updatePaneTag(p) {
  let labelEl = p.el.querySelector('[data-pane-label]');
  if (!labelEl) return;
  let old = p.el.querySelector('.pane-tag'); if (old) old.remove();
  if (!p.host && !p.connection) return;
  let tag = document.createElement('span');
  tag.className = 'pane-tag ' + (p.persistent ? 'persistent' : 'ephemeral');
  tag.textContent = p.persistent ? 'persistent' : 'short-lived';
  tag.title = p.persistent
    ? 'This pane is wrapped in remote tmux and will survive browser refresh.'
    : 'This pane is NOT persistent — it will be lost on refresh.';
  labelEl.after(tag);
}

function targetPane() {
  // Which pane are we connecting for?
  if (connectingFor && panes[connectingFor]) return panes[connectingFor];
  if (activeId && panes[activeId]) return panes[activeId];
  return null;
}

// ── tmux fallback bar ──────────────────────────────────────────────
// Shown over a persistent pane whose connect died fast with a tmux-
// shaped error ("not found"). Prompts the user to retry or switch the
// pane to a plain (short-lived) session so they can install tmux.
function showTmuxBar(p, note) {
  hideReconnectBar(p);
  let bar = p.el.querySelector('[data-tmux-bar]');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'tmux-bar';
    bar.setAttribute('data-tmux-bar', p.id);
    let msg = document.createElement('span');
    msg.setAttribute('data-tmux-msg', '1');
    bar.appendChild(msg);
    let reBtn = document.createElement('button');
    reBtn.className = 'btn btn-p';
    reBtn.textContent = 'Retry';
    reBtn.onclick = () => { tmuxRetry(p.id); };
    bar.appendChild(reBtn);
    let shortBtn = document.createElement('button');
    shortBtn.className = 'btn';
    shortBtn.textContent = 'Connect short-lived';
    shortBtn.onclick = () => { tmuxSwitchToShortLived(p.id); };
    bar.appendChild(shortBtn);
    // Into the overlay stack, not the pane's flex column: a bar that
    // takes layout space resizes the terminal (and the remote PTY).
    p.el.querySelector('.pane-overlays').appendChild(bar);
  }
  bar.querySelector('[data-tmux-msg]').textContent = note || 'tmux failed on this target';
  bar.classList.remove('h');
}
function hideTmuxBar(p) {
  let bar = p.el.querySelector('[data-tmux-bar]');
  if (bar) bar.classList.add('h');
}
function tmuxRetry(id) {
  let p = panes[id]; if (!p) return;
  hideTmuxBar(p);
  connectPane(p, {label: p.label, persistent: true});
}
function tmuxSwitchToShortLived(id) {
  let p = panes[id]; if (!p) return;
  hideTmuxBar(p);
  p.persistent = false;
  p.slotId = null;
  connectPane(p, {label: p.label, persistent: false});
}

// ── Terminate-session confirm modal ────────────────────────────────
// Shown only when [x] is clicked on a successful tmux-backed pane.
// Three outcomes: cancel, terminate once, terminate + suppress prompt
// for future closes (preference lives in localStorage).
let pendingTerminate = null;

const _confirmTrap = makeModalTrap('confirmOv', () => confirmCancel());
function showTerminateModal(p, onConfirm, title) {
  pendingTerminate = onConfirm;
  // Prefer the human label (saved name or connection name) over the raw
  // host IP — matches what the user sees in the pane's title bar.
  let name = p.label || p.connection || p.host || 'server';
  // `title`: closing a whole tab with several live sessions asks once,
  // for all of them (closeTab).
  $('cfTitle').textContent = title || ('Terminate session on ' + name + '?');
  // Initial focus on Cancel — the safe default for a destructive
  // confirm; Escape cancels too (previously this dialog trapped
  // neither focus nor Escape).
  _confirmTrap.open(() => $('confirmOv').querySelector('button'));
}
function confirmCancel() {
  _confirmTrap.close();
  pendingTerminate = null;
}
function confirmTerminate(neverAgain) {
  _confirmTrap.close();
  let cb = pendingTerminate;
  pendingTerminate = null;
  if (cb) cb(!!neverAgain);
}

// ── Unified connect flow ───────────────────────────────────────────
// Single entry point for every connect attempt (manual form, saved
// card, server-configured card). Rules:
//
//   1. No pane is created until the connection is confirmed. The login
//      form stays visible behind a status popup during the attempt —
//      on success we materialise the pane and close the form in one
//      step; on failure the popup shows the reason and the form is
//      still there, unchanged, for the user to retry.
//   2. All failure states (auth, no-tmux, policy-deny, host-down,
//      timeout, generic error) surface in the same popup with one
//      [OK] button that just dismisses the popup.
//   3. Saved cards run the same flow — clicking one does not bypass
//      the form; the form remains the single "close me" control.
//
// The popup's DOM is #tmuxOv (kept for backwards-compat; the visible
// title is "Connecting" by default).

// Tracks the active attempt so the popup's Cancel / form's × can abort
// it and so we don't leak bg or half-connected sessions.
let currentConnectRun = null;

function runConnect(opts) {
  // A second runConnect supersedes the first.
  if (currentConnectRun) {
    currentConnectRun.cancelled = true;
    cleanupRun(currentConnectRun);
  }
  let run = { cancelled: false, connectSid: null, opts: opts };
  currentConnectRun = run;

  hideErr();
  showConnectStatus('connecting', {host: opts.host, persistent: !!opts.persistent});

  // Persistent panes used to run a tmux-presence probe here (separate
  // bg SSH session + MOTD-drain wait). It added ~2.5 s of latency and
  // duplicated work the reactive showTmuxBar fallback already does
  // post-connect when a "tmux not found" message arrives. Removed.
  // Users with non-default tmux locations need to either symlink to
  // PATH on the target or configure the connection via server-side
  // websh.json.
  realConnect(opts, run).then(result => {
    if (run.cancelled || !result) return;
    finalizeSuccess(opts, result, run);
  }).catch(err => {
    if (run.cancelled) return;
    cleanupRun(run);
    currentConnectRun = null;
    let ctx = mapConnectError(err, opts);
    showConnectStatus(ctx.kind, ctx);
  });
}

function realConnect(opts, run) {
  // Build connect body from opts (no pane yet, so cols/rows default to
  // 80x24 and we /api/resize once the pane is materialised). When the
  // saved-variant fields are present, the body builder ships them
  // instead of host/password/etc — the server resolves the real
  // credentials from the vault.
  let rec = {
    label: opts.label || '',
    host: opts.host || '',
    port: opts.port || 22,
    user: opts.user || '',
    connection: opts.connection || null,
    auth: opts.auth || (opts.key ? 'key' : 'pw'),
    password: opts.password || '',
    key: opts.key || '',
    key_pass: opts.keyPass || '',
    vault_id: opts.vault_id || null,
    conn_id:  opts.conn_id  || null,
    vault_key: opts.vault_key || null,
    persistent: !!opts.persistent,
    slot_id: opts.slotId || (opts.persistent
      ? slotIdFor(opts.user, opts.host, opts.port) : null),
    tmux_cmd: opts.tmuxCmd || 'tmux',
    cols: 80, rows: 24
  };
  opts.slotId = rec.slot_id;
  let body = buildConnectBody(rec, 80, 24);
  return api('connect', {body: body}).then(r => {
    if (run.cancelled) {
      if (r && r.session_id) api('disconnect', {body: {session_id: r.session_id}}).catch(() => {});
      return null;
    }
    if (r && r.session_id) run.connectSid = r.session_id;
    if (r.auth_failed) throw { kind: 'auth_failed' };
    if (r.error) {
      if (/not allowed|not in the allowed list/i.test(r.error)) {
        throw { kind: 'policy_deny', msg: r.error };
      }
      if (isCapacityError(r, r.error)) {
        throw { kind: 'rate_limited', msg: r.error };
      }
      // Saved-variant /api/connect surfaces vault-specific errors:
      //   404 + "saved entry not found"
      //   400 + {error: "vault_decrypt_failed"}
      //   501 + "credential vault unavailable…"
      // Status code is opaque to api() (always parses JSON), so we
      // pattern-match the strings.
      if (/saved entry not found/i.test(r.error)) {
        throw { kind: 'vault_not_found', msg: r.error };
      }
      if (r.error === 'vault_decrypt_failed') {
        // Intentionally do NOT call invalidateVaultCache / clear K here.
        // The failing blob is ONE entry; K may still decrypt every other
        // saved card in this vault. Wiping K on a single decrypt-fail
        // would brick the rest of the user's vault. The .nokey UX is
        // reached through a different signal (IDB itself missing K).
        throw { kind: 'vault_decrypt', msg: r.error };
      }
      if (/credential vault unavailable/i.test(r.error)) {
        throw { kind: 'vault_off', msg: r.error };
      }
      throw { kind: 'error', msg: r.error };
    }
    if (r.alive === false) throw { kind: 'host_down' };
    return r;
  });
}

function finalizeSuccess(opts, result, run) {
  // Connection confirmed — now it's safe to create the pane.
  let p = materializeTarget();
  if (!p) {
    // No materialize target (shouldn't happen under normal flow) —
    // tear down the stray session so it doesn't leak.
    if (result.session_id) api('disconnect', {body: {session_id: result.session_id}}).catch(() => {});
    currentConnectRun = null;
    return;
  }
  p.label = opts.label || '';
  p.host = opts.host || '';
  p.port = opts.port || 22;
  p.user = opts.user || '';
  p.connection = opts.connection || null;
  p.auth = opts.auth || (opts.key ? 'key' : 'pw');
  // Plaintext SSH credentials live on the pane only for manual /
  // prompt-named modes. We mirror them into sessionStorage so F5 within
  // the tab can restore without re-prompting; vault-backed panes carry
  // conn_id instead (their secrets live server-side).
  p.password = opts.password || '';
  p.key = opts.key || '';
  p.keyPass = opts.keyPass || '';
  p.conn_id = opts.conn_id || null;
  if (!p.conn_id) {
    _setPaneSecret(p.id, {
      password: p.password,
      key: p.key,
      key_pass: p.keyPass,
    });
  } else {
    _deletePaneSecret(p.id);
  }
  p.persistent = !!opts.persistent;
  p.slotId = result.slot_id || opts.slotId || null;
  p.tmuxCmd = result.tmux_cmd || opts.tmuxCmd || 'tmux';
  p.sid = result.session_id;
  p.outCursor = 0;              // a new session's output starts at offset 0
  p.connectedAt = Date.now();
  p.recentOutput = '';
  p.connecting = false;
  // Deferred save: commitPendingSave writes it once the session has proven
  // healthy for ≥2.5s with no auth failure — driven both by a healthy output
  // frame (handleOutputPayload) and an output-independent timer
  // (scheduleSaveCommit) so an idle SSE session still commits. The
  // non-enumerable __ephemeralSecrets bag rides along (Finding 2a).
  if (opts.saveEntry) {
    let entry = Object.assign({}, opts.saveEntry);
    _carryEphemeralSecrets(opts.saveEntry, entry);
    entry.persistent = !!p.persistent;
    if (p.tmuxCmd && p.tmuxCmd !== 'tmux') entry.tmux_cmd = p.tmuxCmd;
    p.pendingSave = entry;
    scheduleSaveCommit(p);
  }

  hideReconnectBar(p);
  hideTmuxBar(p);
  let labelEl = p.el.querySelector('[data-pane-label]');
  if (labelEl) labelEl.textContent = p.label;
  p.term.reset();
  // Only the active pane owns the document title — a background pane
  // (auto-reconnect while the user works elsewhere) must not clobber it.
  if (activeId === p.id) setTitle(p.label);
  updatePaneBadge(p);

  // Close the status popup and login form as a single success step.
  $('tmuxOv').classList.add('h');
  currentConnectRun = null;
  beginSessionIO(p, {fromForm: true});
}

function cleanupRun(run) {
  if (run && run.connectSid) {
    api('disconnect', {body: {session_id: run.connectSid}}).catch(() => {});
    run.connectSid = null;
  }
}

function mapConnectError(err, opts) {
  let host = (opts && opts.host) || '';
  let user = (opts && opts.user) || '';
  if (err && err.kind) {
    return Object.assign({host, user}, err);
  }
  if (err && err.authFailed) {
    return {kind: 'auth_failed', host, user};
  }
  let msg = (err && err.message) || String(err || '');
  if (/not allowed|not in the allowed list/i.test(msg)) {
    return {kind: 'policy_deny', host, user, msg};
  }
  if (/timeout/i.test(msg)) {
    return {kind: 'timeout', host, user, msg};
  }
  if (isCapacityError(err, msg)) {
    return {kind: 'rate_limited', host, user, msg};
  }
  return {kind: 'error', host, user, msg};
}

// One popup, many states. Only [OK]/[Cancel] (dismissConnectStatus).
// Connect-status popup content, keyed by outcome kind. `sub` is a
// function of {host, user} (host pre-defaulted to 'target'). `status`:
// the literal 'msg' shows ctx.msg (when present) as an error line; any
// other string is fixed error text; absent = no status line. `btn`
// defaults to 'OK'. Unknown kinds fall back to the generic error entry.
// Adding an outcome is one table row.
const CONNECT_STATUS = {
  connecting: {
    title: 'Connecting',
    sub: c => 'Connecting to ' + c.host + '\u2026',
    btn: 'Cancel',
  },
  auth_failed: {
    title: 'Authentication failed',
    sub: c => 'Could not log in to ' + c.host + '.',
    status: 'Check your password or key and try again.',
  },
  policy_deny: {
    title: 'Connection not allowed',
    sub: c => "The username '" + (c.user || '?') +
              "' is not authorized to connect to " + c.host + '.',
    status: 'msg',
  },
  host_down: {
    title: 'Host unreachable',
    sub: c => 'Could not reach ' + c.host + '.',
    status: 'msg',
  },
  timeout: {
    title: 'Connection timed out',
    sub: c => 'The connection to ' + c.host + ' timed out.',
  },
  rate_limited: {
    title: 'Too many connection attempts',
    sub: () => 'Please wait and try again shortly.',
    status: 'msg',
  },
  vault_not_found: {
    title: 'Saved entry missing on server',
    sub: () => 'This card was deleted or the server vault was cleared.',
    status: 'Delete this card from the saved list, then re-enter to re-save.',
  },
  vault_decrypt: {
    title: 'Cannot decrypt this card',
    sub: () => 'The vault key in this browser does not match the stored blob.',
    status: 'Re-enter the credentials to re-save this connection.',
  },
  vault_off: {
    title: 'Vault is disabled on the server',
    sub: () => 'The server is not accepting saved credentials right now.',
    status: 'msg',
  },
  error: {
    title: 'Connection error',
    sub: c => 'Could not connect to ' + c.host + '.',
    status: 'msg',
  },
};

function showConnectStatus(kind, ctx) {
  let title = $('tmTitle'), sub = $('tmSub'), status = $('tmStatus'), btn = $('tmCancel');
  status.textContent = ''; status.className = 'tm-status';
  btn.classList.remove('h');
  let e = CONNECT_STATUS[kind] || CONNECT_STATUS.error;
  title.textContent = e.title;
  sub.textContent = e.sub({host: ctx.host || 'target', user: ctx.user});
  if (e.status === 'msg') {
    if (ctx.msg) { status.textContent = ctx.msg; status.className = 'tm-status err'; }
  } else if (e.status) {
    status.textContent = e.status;
    status.className = 'tm-status err';
  }
  btn.textContent = e.btn || 'OK';
  $('tmuxOv').classList.remove('h');
}

// Popup [OK]/[Cancel] handler: cancel the in-flight run (if any) and
// hide the popup. The login form is never touched by this — it stays
// open so the user can adjust credentials and retry. If dismissing
// leaves the user on an empty screen (no panes, form also hidden —
// happens when auto-connect fails), fall back to the login form so
// they aren't stranded.
function dismissConnectStatus() {
  if (currentConnectRun) {
    currentConnectRun.cancelled = true;
    cleanupRun(currentConnectRun);
    currentConnectRun = null;
  }
  $('tmuxOv').classList.add('h');
  if (!Object.keys(panes).length && $('ov').classList.contains('h')) {
    overlayMode = 'initial';
    pendingSplit = null;
    connectingFor = null;
    showOverlay();
  }
}

// ── UI ──────────────────────────────────────────────────────────────
let _lastTitle = null;
function setTitle(label) {
  // Memoized: updatePaneBadge re-asserts the title on every output frame
  // (cheap upkeep that also heals stray writes); skip the DOM write when
  // nothing changed. document.title is written nowhere else.
  let t = label ? label + ' \u2014 websh' : 'websh \u2014 Powerful web terminal';
  if (t === _lastTitle) return;
  _lastTitle = t;
  document.title = t;
}


// Dismissable iff the user has somewhere to retreat to:
//   'split'   — the source pane exists (and always will), so yes.
//   'tab'     — the current tab is still there, so yes.
//   'initial' — there's no other pane; they must complete auth.
let _connectBackdropGesture = null;
function overlayDismissable() { return overlayMode === 'split' || overlayMode === 'tab'; }
function showOverlay(){
  _connectBackdropGesture = null;
  $('ov').classList.remove('h');
  $('btnCancel').classList.toggle('h', !overlayDismissable());
  hideErr();
  focusFirst();
}
function hideOverlay(){
  _connectBackdropGesture = null;
  $('ov').classList.add('h');
  // Scrub credentials from the DOM once the overlay is closed so the
  // browser has nothing to offer to save/sync and so a later devtools
  // paste / extension content-script can't read `$('iPw').value` etc.
  // Also clear iName: not a secret, but a residual connection label
  // is leaky and the next connect will re-populate it. (Finding 2b.)
  $('iPw').value = '';
  $('iKey').value = '';
  $('iKeyPw').value = '';
  $('iName').value = '';
}
function showErr(m){
  // #err lives inside the connect overlay. When the overlay is closed
  // (reconnect, F5 restore, a mid-session error), writing to it is
  // invisible — the message would be silently swallowed. Fall back to a
  // toast so it's always seen. When the overlay is open (the user is on
  // the connect form), keep the inline error line as before.
  if ($('ov').classList.contains('h')) { showToast(m, 'err'); return; }
  let e=$('err'); e.textContent=m; e.classList.add('on');
}
function hideErr(){ $('err').classList.remove('on') }

// Surface a connect failure on the right surface. With the connect overlay
// open (user just clicked Connect) the message belongs in the form error
// line so they can fix and retry. With it closed (reconnect / F5 restore /
// auto-retry) the form is invisible — write to the pane terminal and, if
// the pane has a target, show the reconnect bar so the user can recover
// instead of staring at a dead pane. (showErr already falls back to a
// toast, so even a target-less pane never loses the text.)
function surfaceConnectError(p, msg, reason) {
  if (!$('ov').classList.contains('h')) { showErr(msg); return; }
  try { p.term.write('\r\n\x1b[31m[websh: ' + msg + ']\x1b[0m\r\n'); } catch (e) {}
  if (p.host || p.connection) showReconnectBar(p, reason || 'error');
  connectingFor = null;
  overlayMode = null;
  pendingSplit = null;
}

// Non-blocking notification. `kind` is one of '', 'warn', 'err'. Used by
// background flows (e.g. /api/save failures) so the live terminal isn't
// interrupted but the user still sees what happened. Dedups identical
// messages (e.g. two overlapping save-failure retries from the same
// pane would otherwise stack identical toasts). Click to dismiss.
// Error toasts get a longer auto-dismiss and an assertive role so AT
// users hear them — aria-live=polite on the host alone is fine for
// info but wrong for actionable errors. (Finding 5a/b/d, PR-67 review.)
function showToast(message, kind) {
  let host = $('toastHost'); if (!host) return;
  let key = (kind || '') + ':' + message;
  for (let i = 0; i < host.children.length; i++) {
    if (host.children[i].getAttribute('data-toast-key') === key) return;
  }
  let el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.setAttribute('data-toast-key', key);
  el.textContent = message;
  if (kind === 'err') el.setAttribute('role', 'alert');
  el.title = 'Click to dismiss';
  let dismissed = false;
  let dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.remove('on');
    setTimeout(() => { try { el.remove(); } catch(e){} }, 250);
  };
  el.addEventListener('click', dismiss);
  host.appendChild(el);
  // Force layout, then add .on for the transition.
  void el.offsetWidth;
  el.classList.add('on');
  // Error toasts are typically actionable; give the user longer to
  // notice and click. Info/warn toasts stay at 5 s.
  setTimeout(dismiss, kind === 'err' ? 10000 : 5000);
}

function focusFirst() {
  if($('manualForm').classList.contains('h')) return;
  let el=$('iH'); if(!el.value){el.focus();return}
  el=$('iU'); if(!el.value){el.focus();return}
  $('iPw').focus();
}

function toggleSaveName() { $('saveNameWrap').className=$('iSave').checked?'save-name':'save-name h' }

function setAuthTab(mode) {
  authMode=mode;
  $('tabPw').className='auth-tab'+(mode==='pw'?' active':'');
  $('tabKey').className='auth-tab'+(mode==='key'?' active':'');
  $('authPw').className=mode==='pw'?'fg':'fg h';
  $('authKey').className=mode==='key'?'fg':'fg h';
}

// ── Vault primitives (IndexedDB + Web Crypto AES-GCM) ───────────────
// K (AES-256-GCM CryptoKey, extractable=true) and vault_id (128-bit
// base32) live in IndexedDB. extractable is required because the
// /api/connect handshake ships the raw key bytes — the IDB layer is
// not the confidentiality boundary; the absence of ciphertext blobs
// from the client is what closes the threat. See docs/encryption.md.

const IDB_NAME = 'websh_vault';
const IDB_STORE = 'kv';
const IDB_K_KEY = 'K';
const IDB_VAULT_ID_KEY = 'vault_id';

function _idbOpen() {
  return new Promise((resolve, reject) => {
    let req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _idbGet(key) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    let tx = db.transaction(IDB_STORE, 'readonly');
    let req = tx.objectStore(IDB_STORE).get(_idbScopedKey(key));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function _idbPut(key, value) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    let tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, _idbScopedKey(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function _idbDelete(key) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    let tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(_idbScopedKey(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// isolate_storage support: scope IDB keys by URL path the same way
// storageKey() scopes localStorage. Two deployments on the same origin
// at different paths thus get independent vault keys + vault_ids.
function _idbScopedKey(name) {
  return storagePrefix ? storagePrefix + name : name;
}

// 26-char Crockford-style base32 of 128 random bits. Matches the
// server's _VAULT_ID_RE / _CONN_ID_RE: ^[A-Z2-7]{26}$.
// Note: 128 bits / 5 = 25.6 chars, so the 26th char carries only the
// remaining 3 bits (low 2 bits are zero per the RFC 4648 padding
// convention we apply with `acc << (5 - accBits)`). Total entropy is
// still 128 bits — the regex just keeps the alphabet uniform.
const _B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function _generateBase32Id() {
  let bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  let acc = 0, accBits = 0;
  for (let b of bytes) {
    acc = (acc << 8) | b;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      s += _B32_ALPHA[(acc >> accBits) & 0x1f];
    }
  }
  if (accBits > 0) s += _B32_ALPHA[(acc << (5 - accBits)) & 0x1f];
  return s;  // 26 chars
}

let _vaultIdCache = null;
let _vaultKeyCache = null;  // CryptoKey
let _vaultFirstSave = false;  // set when ensureVaultId generates a new id

async function ensureVaultId() {
  if (_vaultIdCache) return _vaultIdCache;
  let id = await _idbGet(IDB_VAULT_ID_KEY);
  if (!id) {
    id = _generateBase32Id();
    await _idbPut(IDB_VAULT_ID_KEY, id);
    _vaultFirstSave = true;
  }
  _vaultIdCache = id;
  return id;
}

async function ensureVaultKey() {
  if (_vaultKeyCache) return _vaultKeyCache;
  let key = await _idbGet(IDB_K_KEY);
  if (!key) {
    // extractable=true: required so exportRawVaultKey can return the
    // raw bytes for the saved-variant /api/connect handshake. The IDB
    // layer is not the confidentiality boundary — see the block
    // comment above (search "extractable is required") and
    // docs/encryption.md "Threat model" for the full rationale.
    key = await crypto.subtle.generateKey(
      {name: 'AES-GCM', length: 256},
      true,
      ['encrypt', 'decrypt']);
    await _idbPut(IDB_K_KEY, key);
  }
  _vaultKeyCache = key;
  _idbHasKeyCache = true;  // K is present, sync-readable for renderSaved
  return key;
}

// Non-minting variants of ensureVaultId / ensureVaultKey. Return the
// IDB-resident value if it exists, null otherwise — NEVER mint.
//
// Why we need both: the mint-allowed variants are correct for the save
// flow (commitVaultSave / _onFirstVaultSave), where "no vault yet" is
// the precondition for creating one. They're wrong for every other
// caller (connectPane on F5 restore, connectSaved click, bulk-delete,
// decryptCredentials). After IDB is wiped — Safari ITP eviction, the
// user cleared site data, sign-out in another tab — those code paths
// must see "no key" and degrade, not silently mint a fresh K that has
// nothing to do with the stored ciphertext. Silent minting after a
// wipe defeats the no-key cleanup UX (the .nokey grayed state goes
// away on the next render) and re-populates IDB right after a sibling
// tab signed out (Finding 3 in the PR-67 review). See connectPane and
// confirmSignOut for the consumers.
async function ensureVaultIdIfPresent() {
  if (_vaultIdCache) return _vaultIdCache;
  let id = await _idbGet(IDB_VAULT_ID_KEY);
  if (!id) return null;
  _vaultIdCache = id;
  return id;
}

async function ensureVaultKeyIfPresent() {
  if (_vaultKeyCache) return _vaultKeyCache;
  let key = await _idbGet(IDB_K_KEY);
  if (!key) {
    // Keep the sync-readable mirror honest. Without this, a caller
    // that observes _idbHasKeyCache=true (stale from boot) would
    // mistake "no key" for "key present" and render a non-grayed row.
    _idbHasKeyCache = false;
    return null;
  }
  _vaultKeyCache = key;
  _idbHasKeyCache = true;
  return key;
}

async function exportRawVaultKey(key) {
  // Prefer the caller's already-resolved CryptoKey handle: a wipe
  // between the caller's ensureVaultKeyIfPresent and this call would
  // otherwise let ensureVaultKey's mint-if-absent fallback silently
  // create a fresh K, and the body we ship to /api/connect would
  // carry key bytes that don't match any server-side blob (Finding 3
  // in the PR-67 review). For direct callers that don't hold a
  // reference (tests, future code) we still mint on demand to keep
  // the convenience contract.
  if (!key) key = await ensureVaultKey();
  let raw = await crypto.subtle.exportKey('raw', key);
  return _bufToB64(raw);
}

function _bufToB64(buf) {
  let bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function _b64ToBytes(b64) {
  let s = atob(b64);
  let bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// AAD version 2: the blob is bound to its slot AND its destination.
// Server-side the record's host/port/username are plaintext metadata,
// and /api/save needs no proof of key possession - so with the old
// slot-only AAD, anyone who could read websh.creds.json could re-POST a
// blob under the same ids with a different host and have the server
// decrypt it (with the victim's key) into the attacker's machine.
// The canonical form must match server.py's _credential_aad() byte for
// byte: trimmed host, integer port (1-65535, else 22), trimmed user.
const VAULT_AAD_VERSION = 2;
function vaultDestination(host, port, username) {
  let p = parseInt(port, 10);
  if (!(p >= 1 && p <= 65535)) p = 22;
  return {host: String(host || '').trim(), port: p,
          username: String(username || '').trim()};
}
function vaultAad(vault_id, conn_id, dest) {
  return new TextEncoder().encode(
    vault_id + ':' + conn_id + ':' + dest.host + ':' + dest.port + ':' +
    dest.username);
}

async function encryptCredentials(plaintext, conn_id, dest) {
  let vault_id = await ensureVaultId();
  let key = await ensureVaultKey();
  // GCM IV reuse under the same key is catastrophic; draw a fresh
  // 12-byte IV on every encrypt. See docs/encryption.md.
  let iv = crypto.getRandomValues(new Uint8Array(12));
  let aad = vaultAad(vault_id, conn_id, dest);
  let pt = new TextEncoder().encode(JSON.stringify(plaintext));
  let ct = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: aad}, key, pt);
  return {iv: _bufToB64(iv), ct: _bufToB64(ct), vault_id};
}

async function decryptCredentials(iv_b64, ct_b64, conn_id, dest) {
  // Non-minting: silently minting a fresh vault_id / K here would just
  // guarantee a decrypt failure with extra garbage left in IDB. Raise
  // a clear error so the caller can surface a useful diagnostic
  // (Finding 8 in the PR-67 review).
  let vault_id = await ensureVaultIdIfPresent();
  let key = await ensureVaultKeyIfPresent();
  if (!vault_id || !key) throw new Error('no_vault_key');
  // `dest` selects the v2 (destination-bound) AAD; without it the v1
  // slot-only binding is used, for blobs saved before aad_v existed.
  let aad = dest ? vaultAad(vault_id, conn_id, dest)
                 : new TextEncoder().encode(vault_id + ':' + conn_id);
  let pt = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: _b64ToBytes(iv_b64), additionalData: aad},
    key, _b64ToBytes(ct_b64));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Fresh conn_id for a new saved card. Same alphabet/length as
// vault_id; the server validates with the same regex.
function generateConnId() { return _generateBase32Id(); }

// Heuristic Safari detection — useragent-based, intentionally
// pessimistic about edge cases (Chrome on iOS reports as Safari and
// gets the same IDB constraint, so the heuristic flags it too).
function _isSafari() {
  let ua = navigator.userAgent || '';
  return /^((?!chrome|chromium|android).)*safari/i.test(ua);
}

// One-shot hook fired by commitPendingSave the first time a vault_id
// gets generated. Asks the browser to retain IndexedDB across storage
// pressure (Firefox shows a permission prompt; Chromium is silent;
// Safari quietly ignores it outside an installed PWA — hence the
// one-line note for Safari users so they understand why their saved
// cards may disappear after a week.
async function _onFirstVaultSave() {
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    try { await navigator.storage.persist(); } catch (e) {}
  }
  if (_isSafari()) {
    showToast('On Safari, saved credentials are cleared after 7 days ' +
              'of inactivity unless you add this site to your home screen.',
              'warn');
  }
}

// Cross-tab signalling. localStorage 'storage' events cover the
// saved-card list (any tab editing websh_connections fires in every
// other tab). IDB / sign-out are out-of-band, so we also open a
// BroadcastChannel where signedOut signals invalidate the other tab's
// in-memory caches. Both layers degrade gracefully — when
// BroadcastChannel is absent the user just won't see immediate
// invalidation in the second tab, and the next render after a manual
// refresh picks up the wipe.
let _vaultBroadcast = null;
let _vaultBroadcastPagehideWired = false;
// Flag set when a sign-out happens (local or via the BroadcastChannel
// signal) and cleared when the user initiates a new save in doConnect.
// commitVaultSave consults it to bail if a sign-out raced the 2.5 s
// stable-connection window. (Finding 4 in the PR-67 review.)
let _vaultRecentlySignedOut = false;
function _initVaultBroadcast() {
  if (typeof BroadcastChannel === 'undefined') return;
  // Path-scope the channel name under isolate_storage. Otherwise a
  // sign-out on /team-a/ would broadcast into /team-b/'s tabs and
  // force-disconnect their unrelated vault panes (the BC handler
  // doesn't re-check that the wipe matched this path's IDB before
  // tearing down the live panes). Re-mint when storagePrefix changes
  // — module-init opens 'websh_vault' with the empty default and
  // loadServerConfig re-inits once cfg.isolate_storage is known.
  // Shape matches storageKey() / _idbScopedKey(): prefix-then-name.
  let expected = storagePrefix + 'websh_vault';
  if (_vaultBroadcast && _vaultBroadcast.name === expected) return;
  if (_vaultBroadcast) {
    try { _vaultBroadcast.close(); } catch (e) {}
    _vaultBroadcast = null;
  }
  try {
    _vaultBroadcast = new BroadcastChannel(expected);
    _vaultBroadcast.onmessage = (e) => {
      if (!e || !e.data) return;
      if (e.data.type === 'signed_out') {
        // Tear down live vault-backed panes BEFORE invalidating caches
        // so the in-flight connectPane / pollOutput on this tab can't
        // race ahead and mint a fresh K from empty IDB (Finding 3).
        _vaultRecentlySignedOut = true;
        _disconnectAllVaultPanesForNoKey();
        invalidateVaultCache();
        renderSaved();
      }
    };
    // Safari's bfcache can keep a frozen tab subscribed to the channel,
    // firing handlers into a page that's effectively dead (touching DOM
    // that may be gone). Close on pagehide so we don't leak listeners
    // into bfcache. Listener is wired once per page lifetime so a
    // re-init after a fresh load doesn't double-bind.
    if (!_vaultBroadcastPagehideWired) {
      _vaultBroadcastPagehideWired = true;
      window.addEventListener('pagehide', () => {
        if (_vaultBroadcast) {
          try { _vaultBroadcast.close(); } catch (e) {}
          _vaultBroadcast = null;
        }
      });
    }
  } catch (e) { _vaultBroadcast = null; }
}
function _broadcastSignedOut() {
  if (!_vaultBroadcast) return;
  try { _vaultBroadcast.postMessage({type: 'signed_out'}); } catch (e) {}
}

window.addEventListener('storage', (e) => {
  if (!e || !e.key) return;  // localStorage.clear() fires with key=null
  if (e.key === storageKey('websh_connections')) {
    // The other tab edited the saved-card list (delete, sign-out
    // wipe, fresh save). Render immediately with the current cache so
    // the visible list matches the just-edited storage in this tick.
    renderSaved();
    // Then refresh the IDB-presence mirror and re-render — a sibling
    // tab that just minted K + vault_id and saved its first card
    // would otherwise leave _idbHasKeyCache=false here, painting every
    // vault row .nokey until the next IDB touch. (Finding 1b in the
    // PR-67 review.) try/catch survives a window close between the
    // event firing and the deferred render.
    _refreshIdbHasKey().then(() => {
      try { renderSaved(); } catch (err) {}
    }, () => {});
  }
});

// Sync-readable mirror of "is K present in IDB?". renderSaved checks
// this to gray out vault-backed rows that can no longer connect
// (Safari ITP cleared IDB after 7 days, user wiped site data, etc).
// Refreshed from loadServerConfig at boot, after save / sign-out
// (which know they just touched IDB), and on the storage / vault
// BroadcastChannel events (Task 11).
let _idbHasKeyCache = false;
async function _refreshIdbHasKey() {
  try { _idbHasKeyCache = !!(await _idbGet(IDB_K_KEY)); }
  catch (e) { _idbHasKeyCache = false; }
  return _idbHasKeyCache;
}

// Invalidate in-memory caches without touching IDB. Used when another
// tab signs out, when sign-out completes locally, and when /api/config
// reports the vault has been disabled out from under us.
function invalidateVaultCache() {
  _vaultIdCache = null;
  _vaultKeyCache = null;
  _idbHasKeyCache = false;
}

// Tear down a live vault-backed pane after the vault key has just been
// wiped (local sign-out, or a sibling tab broadcasting signed_out).
// Lighter than _destroyPane: we keep the pane in the DOM so the user
// sees the no-key state and can act, but stop polling, close the
// stream, and best-effort disconnect the server-side session.
// Reconnect bar shows 'no_vault_key' — clicking Reconnect funnels back
// through connectPane's vault guard, which re-shows the same bar
// (intentional: the user has to sign in again to recover).
function _disconnectVaultPaneForNoKey(p) {
  if (!p) return;
  endSession(p, {disconnect: true, badge: true});
  showReconnectBar(p, 'no_vault_key');
}

// Iterate live panes and tear down every vault-backed one. Shared by
// confirmSignOut (this tab) and the BroadcastChannel signed_out
// handler (sibling tab) so the same pane state is reached either way.
function _disconnectAllVaultPanesForNoKey() {
  Object.keys(panes).forEach(id => {
    let p = panes[id];
    if (p && p.conn_id) _disconnectVaultPaneForNoKey(p);
  });
}

// Toggle vault-on / vault-off on <html> based on the server's
// /api/config response. Elements with class="vault-only" are hidden
// while the vault is off (server lacks cryptography, WEBSH_VAULT_ENABLE
// isn't set, schema version unsupported, or just before /api/config
// returns). Default in the HTML is vault-off — no flash of a "Save"
// affordance the server can't honor.
function _applyVaultEnabledClass() {
  let on = !!(serverConfig && serverConfig.vault_enabled);
  document.documentElement.classList.toggle('vault-on', on);
  document.documentElement.classList.toggle('vault-off', !on);
}

// ── Saved connections (localStorage) ────────────────────────────────
// Post-vault shape: {name, conn_id, host, port, user, auth, persistent,
// tmux_cmd?, connection?}. No `pass` / `key` fields — secrets live in
// the server-side vault under `conn_id`. Legacy entries with `pass` /
// `key` are tolerated (read-only) until the user acks the
// legacy-plaintext banner, which drops those fields.
function loadSaved() { try{return JSON.parse(localStorage.getItem(storageKey('websh_connections'))||'[]')}catch(e){return[]} }
function saveSaved(list) { localStorage.setItem(storageKey('websh_connections'),JSON.stringify(list)) }

// Heuristic for the "(key)" badge: trust `c.auth` first; fall back to
// the legacy `c.key` truthy-check for pre-vault rows that don't carry
// an explicit auth tag.
function _entryUsesKey(c) {
  if (c.auth) return c.auth === 'key';
  return !!c.key;
}

// Detect rows from before the vault shipped — they still carry the
// plaintext password or key inline. _maybeAutoDropLegacy consumes the
// signal once on load: strips pass/key from every legacy row,
// persists the cleaned list, then opens an informational modal so
// the user knows their saved cards will ask for the password the
// next time they're used.
function _hasLegacyPlaintext() {
  return loadSaved().some(c => c.pass || c.key);
}

// Strip pass/key from every legacy row, persist, and open the
// "Saved connections updated" modal. The earlier design asked the
// user to click "Drop plaintext now"; in practice that was just
// bureaucracy — the user can't make a different choice (we'd never
// silently re-encrypt; the original may live in browser-history sync
// or profile backups, and auto-encrypting would create a false sense
// of security). Dropping is purely defensive: it shrinks this
// browser's localStorage footprint without claiming to recover from
// any prior leak. So we do it automatically and just inform.
function _maybeAutoDropLegacy() {
  if (!_hasLegacyPlaintext()) return;
  let cleaned = loadSaved().map(c => {
    let copy = Object.assign({}, c);
    delete copy.pass;
    delete copy.key;
    return copy;
  });
  saveSaved(cleaned);
  // No renderSaved here — loadServerConfig calls it next, after
  // _refreshIdbHasKey, so we'd otherwise paint twice with a brief
  // .nokey flash on vault rows.
  openLegacyUpdateModal();
}

// One-shot callback queued by loadServerConfig when the legacy modal
// preempts doAutoConnect. closeLegacyUpdateModal drains it so the
// user sees the connect overlay only AFTER they've acknowledged the
// migration message.
let _deferredAfterLegacyModal = null;

// ── Shared modal a11y plumbing ──────────────────────────────────────
// Tab focus trap + Escape-to-close + focus restore, shared by every
// dialog. makeModalTrap returns {open, close}; per-modal setup (field
// resets, scope text, deferred actions) stays in the modal's own
// open/close functions, which call into the trap.
//   modalId   — element id of the dialog container
//   onEscape  — called on Escape (the modal's own close/cancel function,
//               so modal-specific close work always runs)
// Assumes one trapped modal open at a time (each open adds a document
// keydown listener; every full-screen .ov backdrop enforces this in
// the UI today).
function makeModalTrap(modalId, onEscape) {
  let prevFocus = null;
  let keyHandler = null;
  return {
    // initialFocus: optional () => element to focus after open (next
    // tick, matching the implicit-default convention of the connect
    // form). Defensive re-open without close tears the old listener
    // down first so we don't leak it or stomp prevFocus.
    open(initialFocus) {
      if (keyHandler) this.close();
      prevFocus = document.activeElement;
      keyHandler = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
        if (e.key !== 'Tab') return;
        let m = $(modalId); if (!m) return;
        let focusables = m.querySelectorAll('input:not([disabled]),button:not([disabled])');
        if (!focusables.length) return;
        let first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener('keydown', keyHandler);
      let modal = $(modalId);
      if (modal) modal.classList.remove('h');
      if (initialFocus) {
        setTimeout(() => { try { let el = initialFocus(); el && el.focus(); } catch(e){} }, 0);
      }
    },
    close() {
      if (keyHandler) {
        document.removeEventListener('keydown', keyHandler);
        keyHandler = null;
      }
      let modal = $(modalId);
      if (modal) modal.classList.add('h');
      // Restore focus to whatever opened the modal — otherwise focus
      // briefly lands on the page body and races any focusFirst logic.
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (e) {}
      }
      prevFocus = null;
    },
  };
}

const _legacyUpdateTrap = makeModalTrap('legacyUpdateModal',
                                        () => closeLegacyUpdateModal());
function openLegacyUpdateModal() {
  if (!$('legacyUpdateModal')) return;
  // Initial focus on the Got-it button so Enter dismisses; matches
  // the implicit-default convention used by the connect form.
  _legacyUpdateTrap.open(() => $('legacyUpdateOk'));
}

function closeLegacyUpdateModal() {
  if (!$('legacyUpdateModal')) return;
  // Trap close also restores focus to whatever opened the modal before
  // draining the deferred autoconnect — otherwise focus would briefly
  // land on the page body and the connect form's focusFirst would race
  // against it.
  _legacyUpdateTrap.close();
  // Drain the queued post-modal action (typically doAutoConnect).
  if (_deferredAfterLegacyModal) {
    let fn = _deferredAfterLegacyModal;
    _deferredAfterLegacyModal = null;
    try { fn(); } catch (e) {}
  }
}

function renderSaved() {
  let list=loadSaved(), el=$('savedList');
  el.innerHTML='';
  $('divider').querySelector('span').textContent=list.length?'Or connect manually':'Connect';
  list.forEach((c,i) => {
    // A vault-backed row is unusable when the browser's IDB key is gone
    // (Safari ITP eviction, user wiped site data, sign-out in another
    // tab). We mark it .nokey so CSS grays it out, and the click
    // handler routes to the bulk-delete path instead of connect.
    let nokey = !!(c.conn_id && !_idbHasKeyCache);
    let div=document.createElement('div');
    div.className = 'sv' + (nokey ? ' nokey' : '');
    div.setAttribute('data-idx', i);
    let suffix = _entryUsesKey(c) ? ' (key)' : '';
    let nokeyTag = nokey ? ' <span class="sv-kind sv-nokey" title="No vault key in this browser — cannot connect; delete to clean up">no key</span>' : '';
    div.innerHTML=
      `<div class="sv-info"><div class="sv-name">${esc(c.name)}</div>`+
      `<div class="sv-host">${esc(c.user)}@${esc(c.host)}:${Number(c.port) || 22}${suffix}${nokeyTag}</div></div>`+
      `<div class="sv-actions">` +
        `<button class="sv-btn edit" data-edit="${i}" title="Edit" aria-label="Edit ${esc(c.name)}">${ic('pencil')}</button>` +
        `<button class="sv-btn del" data-idx="${i}">Delete</button></div>`;
    el.appendChild(div);
  });
  el.onclick=e => {
    let editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      e.stopPropagation();
      editSaved(parseInt(editBtn.getAttribute('data-edit'), 10));
      return;
    }
    if(e.target.classList.contains('del')){
      let idx = parseInt(e.target.getAttribute('data-idx'));
      let c = list[idx];
      if (c && c.conn_id) {
        // Vault-backed: best-effort tell the server to drop its blob.
        // We don't await — local removal proceeds even if the server
        // is unreachable.
        _bulkDeleteVaultEntry(c).catch(() => {});
      }
      list.splice(idx, 1); saveSaved(list); renderSaved();
      return;
    }
    let row=e.target.closest('.sv'); if(!row) return;
    let idx=parseInt(row.getAttribute('data-idx')); if(isNaN(idx)) return;
    let c = list[idx];
    if (c && c.conn_id && !_idbHasKeyCache) {
      // No-key state: the row's click target is delete, not connect.
      // Deleting is irreversible, so ask IndexedDB itself rather than
      // trust the cached flag: a render from a stale cache (config fetch
      // failed at boot, a missed broadcast) must never cost a user a
      // credential whose key is in fact present.
      _refreshIdbHasKey().catch(() => false).then(has => {
        if (has) { renderSaved(); connectSaved(c); return; }
        let cur = loadSaved();
        let at = cur.findIndex(x => x && x.conn_id === c.conn_id);
        if (at < 0) return;
        _bulkDeleteVaultEntry(c).catch(() => {});
        cur.splice(at, 1); saveSaved(cur); renderSaved();
      });
      return;
    }
    connectSaved(c);
  };
}

// Inline editor on a saved card. Without it the only way to fix a typo
// in a name, port or username was Delete + create again - and for a
// vault-backed entry that means re-entering the password.
//
// What can change depends on where the secret lives. A vault entry's
// destination is inside the encrypted blob's AAD and in the server-side
// record, and the client cannot rewrite either without the secret, so
// only the display name is editable there; changing the destination
// means saving the credentials again. Entries without a stored secret
// carry all their metadata locally, so everything is editable.
function editSaved(idx) {
  let list = loadSaved(), c = list[idx];
  if (!c) return;
  let row = $('savedList').querySelector(`.sv[data-idx="${idx}"]`);
  if (!row || row.classList.contains('editing')) return;
  let locked = !!c.conn_id;             // secret lives in the vault
  row.classList.add('editing');
  row.innerHTML =
    '<div class="sv-edit">' +
      '<input class="e-name" maxlength="64" aria-label="Name" placeholder="Name">' +
      '<input class="e-user" maxlength="64" aria-label="User" placeholder="user"' + (locked ? ' disabled' : '') + '>' +
      '<input class="e-host" maxlength="253" aria-label="Host" placeholder="host"' + (locked ? ' disabled' : '') + '>' +
      '<input class="e-port" type="number" min="1" max="65535" aria-label="Port" placeholder="22"' + (locked ? ' disabled' : '') + '>' +
    '</div>' +
    '<span class="sv-edit-note"></span>' +
    '<div class="sv-edit-row">' +
      '<button type="button" class="btn sv-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-p sv-save">Save</button>' +
    '</div>';
  let q = sel => row.querySelector(sel);
  q('.e-name').value = c.name || '';
  q('.e-user').value = c.user || '';
  q('.e-host').value = c.host || '';
  q('.e-port').value = Number(c.port) || 22;
  let note = q('.sv-edit-note');
  if (locked) {
    note.textContent = 'Saved in the vault — re-save the credentials to change the destination.';
  }
  let close = () => renderSaved();
  q('.sv-cancel').addEventListener('click', ev => { ev.stopPropagation(); close(); });
  q('.sv-save').addEventListener('click', ev => { ev.stopPropagation(); commit(); });
  row.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });
  row.addEventListener('click', ev => ev.stopPropagation());   // not a connect click
  function fail(msg, sel) {
    note.textContent = msg;
    note.classList.add('sv-edit-err');
    let el = q(sel); if (el) el.focus();
  }
  function commit() {
    let name = q('.e-name').value.trim();
    if (!name) return fail('Name cannot be empty.', '.e-name');
    let next = Object.assign({}, c, {name: name});
    if (!locked) {
      let user = q('.e-user').value.trim(), host = q('.e-host').value.trim();
      let port = parseInt(q('.e-port').value, 10);
      // The same shapes the server accepts at /api/connect, so a saved
      // entry can't be edited into one that is refused on use.
      if (!/^[A-Za-z0-9._@-]{1,64}$/.test(user)) return fail('User: letters, digits and . _ - @ only.', '.e-user');
      if (!/^[A-Za-z0-9._:\[\]-]{1,253}$/.test(host)) return fail('Host: a hostname or an IP address.', '.e-host');
      if (!(port >= 1 && port <= 65535)) return fail('Port must be between 1 and 65535.', '.e-port');
      Object.assign(next, {user: user, host: host, port: port});
    }
    let all = loadSaved();
    all[idx] = next;
    saveSaved(all);
    renderSaved();
    showToast('Saved “' + name + '”', 'ok');
  }
  q('.e-name').focus();
  q('.e-name').select();
}

// Fire-and-forget DELETE /api/save for a vault-backed entry. The PHP
// proxy translates `?action=save_delete` POST into a backend DELETE.
async function _bulkDeleteVaultEntry(c) {
  if (!c || !c.conn_id) return;
  // Non-minting: if the user wiped IDB and then clicked Delete on a
  // .nokey row, the old ensureVaultId would mint a fresh vault_id
  // that doesn't match the saved entry's namespace — the DELETE
  // would fire against a meaningless URL and the original blob
  // would linger server-side. Skip the network call instead.
  let vault_id = null;
  try { vault_id = await ensureVaultIdIfPresent(); } catch (e) {}
  if (!vault_id) return;  // local removal still proceeds in the caller
  let q = '&vault_id=' + encodeURIComponent(vault_id) +
          '&conn_id='  + encodeURIComponent(c.conn_id);
  // body:{} forces POST through api(); empty body is fine, PHP proxy
  // routes by ?action= regardless of body content.
  await api('save_delete', {query: q, body: {}});
}

async function connectSaved(c) {
  hideErr();
  let label = c.name || (c.user + '@' + c.host);
  // New-shape rows carry a conn_id and use the saved-variant
  // /api/connect — the server fetches host/port/username from the
  // vault record, browser supplies vault_key. Legacy rows (still
  // carrying c.pass / c.key in localStorage from before the vault
  // shipped) keep the old manual-mode flow so they continue to work
  // until _maybeAutoDropLegacy strips those fields on next load or
  // the user re-saves.
  if (c.conn_id) {
    // Non-minting: IDB may be empty (Safari ITP, site-data clear,
    // sign-out in another tab). renderSaved's onclick handler pre-gates
    // on _idbHasKeyCache, but that mirror can be momentarily stale —
    // and direct callers (programmatic or future code paths) bypass it.
    // Guard at the bottom of the funnel so a fresh K is never minted
    // from a no-key state.
    let vault_id = null;
    let key = null;
    try {
      vault_id = await ensureVaultIdIfPresent();
      key = await ensureVaultKeyIfPresent();
    } catch (e) { /* IDB broken — treat as missing */ }
    if (!vault_id || !key) {
      showToast('No vault key in this browser — re-enter to re-save this connection.', 'err');
      return;
    }
    let vault_key;
    try {
      vault_key = await exportRawVaultKey(key);
    } catch (e) {
      showToast('Could not export the vault key for this connection. ' +
                'Try signing out and re-saving.', 'err');
      return;
    }
    runConnect({
      label: label,
      vault_id: vault_id,
      conn_id: c.conn_id,
      vault_key: vault_key,
      // The prompt connection this card was saved from — forwarded as the
      // server-side authorization hint (see _resolve_saved_card_connection).
      // Without it, re-connecting a saved card silently falls back to
      // host:port matching.
      connection: c.connection || null,
      // host/port/user are display hints for the connect popup; the
      // server derives the real values from the stored vault record.
      host: c.host, port: c.port || 22, user: c.user,
      persistent: c.persistent !== false,
      slotId: null,
      tmuxCmd: c.tmux_cmd || 'tmux',
    });
    return;
  }
  // Legacy row whose plaintext was dropped by _maybeAutoDropLegacy
  // (or never had it in the first place). The metadata (name/host/
  // port/user/auth/persistent/connection) is still useful — open the
  // connect form pre-filled and let the user type the password once.
  // We pre-check Save so the next connect re-saves under the vault.
  // For restrict_hosts deployments where the row matches a named
  // prompt connection, route through selectPromptConnection so the
  // server actually accepts the connect (manual host would be denied).
  if (!c.pass && !c.key) {
    let useKey = c.auth === 'key';
    let routedViaPrompt = false;
    if (serverConfig && serverConfig.connections) {
      // First: name match (rows saved after connection-naming shipped).
      let m = null;
      if (c.connection) {
        m = serverConfig.connections.find(
          e => e.name === c.connection && e.kind === 'prompt');
      }
      // Fallback: pre-naming legacy rows have no c.connection. Match
      // by host:port so restrict_hosts deployments don't drop the
      // user into a hidden manual form with no way back. Only the
      // host:port pair uniquely identifies a connection in practice,
      // so this is safe.
      if (!m) {
        m = serverConfig.connections.find(
          e => e.kind === 'prompt' && e.host === c.host && e.port === c.port);
      }
      if (m) { selectPromptConnection(m.name); routedViaPrompt = true; }
    }
    if (!routedViaPrompt) {
      // No prompt match: clear any stale selectedPrompt that a prior
      // in-form selection may have left behind. Otherwise doConnect
      // would use selectedPrompt.name and route to the wrong host.
      if (selectedPrompt) clearPromptSelection();
      $('iH').value = c.host || '';
      $('iP').value = c.port || 22;
    }
    // Username: selectPromptConnection may have locked iU when the
    // named connection fixes it; fill from the saved card otherwise.
    if (!$('iU').disabled && c.user) $('iU').value = c.user;
    $('iName').value = c.name || '';
    if ($('iPersistent')) $('iPersistent').checked = c.persistent !== false;
    if (serverConfig && serverConfig.vault_enabled) {
      $('iSave').checked = true;
      toggleSaveName();
    }
    // Auth-tab + focus run AFTER routing so a legacy key-auth row
    // matching a prompt connection lands on the key tab (the
    // selectPromptConnection call inside routing always sets 'pw').
    setAuthTab(useKey ? 'key' : 'pw');
    showOverlay();
    setTimeout(() => {
      try { (useKey ? $('iKey') : $('iPw')).focus(); } catch(e){}
    }, 0);
    return;
  }
  // Auto-match legacy entries (saved before we tagged with connection name)
  // to a config entry by host:port so they still work under restrict_hosts.
  let connName = c.connection;
  if (!connName && serverConfig && serverConfig.connections) {
    let m = serverConfig.connections.find(e => e.host === c.host && e.port === c.port);
    if (m) connName = m.name;
  }
  runConnect({
    label: label,
    host: c.host, port: c.port || 22, user: c.user,
    connection: connName,
    auth: c.key ? 'key' : 'pw',
    password: c.pass || '',
    key: c.key || '',
    persistent: c.persistent !== false,
    slotId: null,
    tmuxCmd: c.tmux_cmd || 'tmux'
  });
}

function connectByName(name) {
  hideErr();
  let c=null;
  if(serverConfig && serverConfig.connections){
    for(let i=0;i<serverConfig.connections.length;i++){
      if(serverConfig.connections[i].name===name){c=serverConfig.connections[i];break}
    }
  }
  if(!c) return;
  // Prompt connections need user input — switch the form into locked mode.
  if(c.kind === 'prompt') { selectPromptConnection(name); return; }
  runConnect({
    label: name,
    host: c.host || '', port: c.port || 22, user: c.username || '',
    connection: name,
    auth: 'pw',
    persistent: c.persistent !== false,
    slotId: null
  });
}

function doConnect() {
  hideErr();
  let host=$('iH').value.trim(), port=parseInt($('iP').value)||22, username=$('iU').value.trim();
  let password=authMode==='pw'?$('iPw').value:$('iKeyPw').value;
  let key=authMode==='key'?$('iKey').value.trim():'';
  if(!host||!username){showErr('Host and username are required');return}
  if(authMode==='pw'&&!password){showErr('Password is required');return}
  if(authMode==='key'&&!key){showErr('Private key is required');return}
  let label = $('iName').value.trim() || (username+'@'+host);
  let wantPersistent = $('iPersistent') ? $('iPersistent').checked : true;
  // Build the save-intent but defer writing: we only commit after the
  // connect is confirmed stable (no auth failure, still alive). Note:
  // saved entries from earlier versions may carry tmux_cmd from the
  // probe era; that field still flows through buildConnectBody for
  // backward compatibility, but new entries don't capture it.
  let saveEntry = null;
  if ($('iSave').checked && serverConfig && serverConfig.vault_enabled) {
    // The user explicitly initiated a save. Whatever sign-out happened
    // before this click is intent the user has now superseded — clear
    // the flag so commitVaultSave's bail doesn't trip on stale state
    // (legitimate first-save after a sign-out). A subsequent sign-out
    // during the 2.5 s window will re-set it. (Finding 4 polish.)
    _vaultRecentlySignedOut = false;
    // Vault flow: the entry that lands in localStorage carries NO
    // secrets — `__ephemeralSecrets` is consumed by commitVaultSave
    // once the connection is healthy, encrypted, and successfully
    // POSTed to /api/save. The conn_id is minted at commit-time. If
    // vault_enabled is false (UI hidden anyway by Task 2 CSS), no save
    // path runs at all — we deliberately don't fall back to plaintext
    // localStorage.
    saveEntry = {name: label, host: host, port: port, user: username,
                 auth: authMode, persistent: wantPersistent};
    // MUST NEVER BE SERIALIZED. Held in a non-enumerable property so
    // any future JSON.stringify on the entry (crash dump, debug log,
    // paneRecord-style serializer) drops it silently rather than
    // spilling plaintext to localStorage. See _carryEphemeralSecrets
    // for how this survives the Object.assign hops to commitVaultSave.
    Object.defineProperty(saveEntry, '__ephemeralSecrets', {
      value: {
        password: authMode === 'pw' ? password : null,
        key:      authMode === 'key' ? key      : null,
        key_pass: authMode === 'key' ? $('iKeyPw').value : null,
      },
      enumerable: false, configurable: true, writable: true,
    });
    if (selectedPrompt) saveEntry.connection = selectedPrompt.name;
  }
  let opts = {
    label: label,
    host: host, port: port, user: username,
    connection: selectedPrompt ? selectedPrompt.name : null,
    auth: authMode,
    persistent: wantPersistent,
    slotId: null,
    tmuxCmd: 'tmux',
    saveEntry: saveEntry
  };
  if (authMode === 'pw') opts.password = password;
  else { opts.key = key; opts.keyPass = $('iKeyPw').value; }
  if (selectedPrompt && !$('iName').value.trim()) {
    opts.label = username + '@' + host + ' (' + selectedPrompt.name + ')';
  }
  runConnect(opts);
}

// ── Server config ───────────────────────────────────────────────────
// Prefill the manual connect form from websh.json "form_defaults"
// (shipped via /api/config). Only fields the user hasn't already typed
// into are touched, and the port only when it still shows the markup
// default — so a half-filled form or a restored session is never
// overwritten. Skipped when restrict_hosts is on AND connections are
// configured (the manual form is locked to those connections there).
function applyFormDefaults(cfg) {
  let fd = cfg && cfg.form_defaults;
  if (!fd || (cfg.restrict_hosts && (cfg.connections || []).length)) return;
  let h = $('iH'), po = $('iP'), u = $('iU');
  if (fd.host && h && !h.value) h.value = fd.host;
  if (fd.port && po && (!po.value || po.value === '22')) po.value = fd.port;
  if (fd.username && u && !u.value) u.value = fd.username;
}

// Wire-protocol version this client speaks; the server ships its own in
// /api/config ("proto"). A mismatch at page load means the browser is
// running a stale CACHED websh.js against an upgraded server - surface
// a reload prompt instead of letting requests fail obscurely. An absent
// field (older server) stays silent.
const CLIENT_PROTO = 1;

function checkProtoVersion(cfg) {
  if (cfg && cfg.proto !== undefined && cfg.proto !== CLIENT_PROTO) {
    showToast('websh was updated on the server \u2014 reload the page ' +
              '(Ctrl+Shift+R) to get the matching client.', 'warn');
  }
}

function loadServerConfig() {
  return api('config').then(async cfg => {
    serverConfig=cfg;
    applyFormDefaults(cfg);
    checkProtoVersion(cfg);
    if(cfg.isolate_storage) {
      storagePrefix = location.pathname.replace(/[^/]*$/, '');
      // `settings`/`fontSize` were loaded at module init under the empty
      // prefix (the shared key), because the path scope is only known once
      // /api/config returns. saveSettings() writes to the prefixed key, so
      // without reloading here the read and write keys diverge: per-path
      // settings never round-trip and another instance's values bleed in
      // at boot. Re-read from the now-correct path-scoped key.
      settings = loadSettings();
      fontSize = settings.fontSize;
      // The module-init ensureFontLink() above ran under the empty prefix,
      // so it loaded the default family; refresh it to the path-scoped font
      // before any pane materializes (fitPaneWhenStable's document.fonts.load
      // gate then resolves against the correct face).
      ensureFontLink(settings.font);
    }
    // Re-mint the vault BroadcastChannel with the now-known storagePrefix
    // so sign-out signals don't cross path-scoped namespaces. No-op if
    // the prefix matches what the module-init open already used (i.e.
    // isolate_storage is off).
    _initVaultBroadcast();
    _applyVaultEnabledClass();
    renderSealedState();
    // Pre-cache the IDB key presence so the first renderSaved doesn't
    // flash all vault-backed rows as no-key while we wait on IDB.
    await _refreshIdbHasKey();
    // Auto-drop legacy plaintext rows BEFORE the first render so the
    // saved-card list paints in its final shape. Surfaces a modal
    // when something was actually dropped. Gated on vault_enabled:
    // on a vault-off deployment (cryptography missing, schema
    // downgrade, WEBSH_VAULT_ENABLE unset) the legacy plaintext rows
    // are the ONLY working storage path — stripping them strands
    // the user with empty-password forms forever, since the Save UI
    // is hidden by .vault-only CSS so they can't re-save either.
    if (cfg.vault_enabled === true) _maybeAutoDropLegacy();
    renderServerConnections();
    renderSaved();
    // Try to restore sessions from page reload. If there's nothing to
    // restore, kick off the initial-login flow — materialize happens on
    // submit, so the user sees the overlay on an empty workspace.
    if(!tryRestoreSessions()) {
      overlayMode = 'initial';
      // Defer autoconnect while the legacy-migration modal is open:
      // both .ov divs share z-index, and #ov paints on top (later in
      // DOM) — autoconnect would hide the migration message and steal
      // focus to iPw. closeLegacyUpdateModal drains the queued call.
      let legacy = $('legacyUpdateModal');
      if (legacy && !legacy.classList.contains('h')) {
        _deferredAfterLegacyModal = doAutoConnect;
      } else {
        doAutoConnect();
      }
    }
  }).catch(() => {
    overlayMode = 'initial';
    showOverlay();
    // Config unreachable: the prefix can't be known, so show what the
    // unscoped namespace holds (the pre-isolation behaviour) rather
    // than an empty list. Ask IndexedDB whether the vault key is there
    // FIRST: the cache still holds its declaration-time false, and
    // painting with it marked every vault card "no key" - whose click
    // is delete.
    _refreshIdbHasKey().catch(() => {}).then(() => {
      try { renderSaved(); } catch (e) {}
    });
  });
}

// ── Prompt-kind selection (free-form ↔ locked-form transitions) ────
// selectedPrompt is null for free-form mode, or the config entry when a
// prompt card is active. The form fields are kept in sync for doConnect.
let selectedPrompt = null;

function selectPromptConnection(name) {
  if(!serverConfig || !serverConfig.connections) return;
  let entry = serverConfig.connections.find(c => c.name === name && c.kind === 'prompt');
  if(!entry) return;
  selectedPrompt = entry;
  hideErr();

  // Free manual form becomes card-locked: unhide it even when
  // restrict_hosts is on (it was hidden by renderServerConnections).
  $('manualForm').classList.remove('h');
  $('divider').classList.remove('h');

  // Banner with a × to go back.
  let fixedUser = entry.username && entry.username.length;
  let oneAllowed = entry.allowed_users && entry.allowed_users.length === 1;
  $('promptTargetLabel').textContent =
    (fixedUser ? entry.username + '@' : (oneAllowed ? entry.allowed_users[0] + '@' : '')) +
    entry.host + ':' + entry.port + '  (' + esc(entry.name) + ')';
  $('promptTarget').classList.remove('h');

  // Lock host/port; lock username if fixed or whitelist has one entry.
  $('iH').value = entry.host; $('iH').disabled = true;
  $('iP').value = entry.port; $('iP').disabled = true;
  if(fixedUser) { $('iU').value = entry.username; $('iU').disabled = true; }
  else if(oneAllowed) { $('iU').value = entry.allowed_users[0]; $('iU').disabled = true; }
  else { $('iU').value = ''; $('iU').disabled = false; }

  // Clear any stale creds; focus the password field.
  $('iPw').value = ''; $('iKey').value = ''; $('iKeyPw').value = '';
  setAuthTab('pw');
  setTimeout(() => $('iPw').focus(), 0);
}

function clearPromptSelection() {
  selectedPrompt = null;
  $('promptTarget').classList.add('h');
  $('iH').disabled = false; $('iP').disabled = false; $('iU').disabled = false;
  $('iH').value = ''; $('iP').value = '22'; $('iU').value = '';
  // The reset wiped any server-provided prefill; bring it back so the
  // post-card-dismiss form matches the first-load state.
  applyFormDefaults(serverConfig);
  // Restore restrict_hosts kiosk mode if configured.
  if(serverConfig && serverConfig.restrict_hosts) {
    $('manualForm').classList.add('h');
    $('divider').classList.add('h');
  }
  hideErr();
}

function renderServerConnections() {
  if(!serverConfig||!serverConfig.connections||!serverConfig.connections.length){$('serverSection').className='saved-section h';return}
  $('serverSection').className='saved-section';
  let el=$('serverList'); el.innerHTML='';
  serverConfig.connections.forEach(c => {
    let div=document.createElement('div'); div.className='sv'; div.setAttribute('data-name',c.name);
    let userDisplay = c.username ? esc(c.username)
      : (c.allowed_users && c.allowed_users.length===1 ? esc(c.allowed_users[0]) : '<em>user</em>');
    let kindBadge = c.kind === 'prompt' ? `<span class="sv-kind" title="Password required on click">prompt</span>` : '';
    div.innerHTML=`<div class="sv-info"><div class="sv-name">${esc(c.name)}${kindBadge}</div>`+
      `<div class="sv-host">${userDisplay}@${esc(c.host)}:${Number(c.port) || 22}</div></div>`;
    el.appendChild(div);
  });
  el.onclick=e => {let row=e.target.closest('.sv');if(!row)return;connectByName(row.getAttribute('data-name'))};
  // restrict_hosts: no free-form — hide manual form until a Prompt card is clicked.
  // Saved connections stay visible (they reconnect through the named path).
  if(serverConfig.restrict_hosts){$('manualForm').classList.add('h');$('divider').classList.add('h')}
}

// ── File upload (binary stream via SSH ControlMaster) ───────────────
function delay(ms) { return new Promise(r => { setTimeout(r, ms); }); }

function bgSend(u, data) {
  if (!u || !u.bgSid) return Promise.reject(new Error('no background session'));
  return api('input', { body: { session_id: u.bgSid, data: data } });
}
function triggerUpload(id) {
  let p = panes[id];
  if (!p || !p.sid || p.upload || (!p.host && !p.connection)) return;
  p.el.querySelector(`[data-upload-input="${id}"]`).click();
}

function handleUpload(id, input) {
  let files = Array.prototype.slice.call(input.files || []);
  input.value = '';
  startUploadFiles(id, files);
}

// Why a pane can't take an upload right now, or '' when it can. Shared
// by the Upload button path and drag-and-drop, so both refuse for the
// same reasons - and a drop can say which one.
function uploadBlocker(p) {
  if (!p || !p.sid) return 'This pane is not connected.';
  if (!p.host && !p.connection) return 'This pane is not connected.';
  if (p.upload || p.download) return 'A transfer is already running in this pane.';
  return '';
}

// o.destDir: an absolute remote directory to drop the files into -
// what the file browser is showing. Without it the destination is the
// pane's own working directory, as before.
function startUploadFiles(id, files, o) {
  let p = panes[id];
  if (!files.length || uploadBlocker(p)) return;
  let totalSize = 0;
  files.forEach(f => { totalSize += f.size });
  p.upload = {
    files:files, fileIndex:0, cancelled:false,
    destDir: (o && o.destDir) || null,
    totalSize:totalSize, sentBytes:0, fileOffset:0, fileSize:0,
    currentFile:null, currentTmp:null, xhr:null,
    // Persistent sessions: server-side finalize landed each file at
    // a known absolute path. Surfaced in the final banner so the
    // user knows exactly where each upload went.
    placed:[],
    // Non-persistent + alt-screen: mv was skipped, file is at
    // $HOME/.websh-tmp-* and the user must move it themselves.
    staged:[]
  };
  showUploadProgress(p);
  updatePaneBadge(p);
  uploadNextFile(p);
}

// ── Drag-and-drop upload ────────────────────────────────────────────
// Dropping files on a pane uploads them exactly like the Upload button
// (same destination: the pane's working directory on persistent panes,
// $HOME + mv otherwise). Folders are refused - the upload pipeline
// streams single files.
function _dragHasFiles(ev) {
  let t = ev.dataTransfer && ev.dataTransfer.types;
  return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
}

// How long the highlight survives without a dragover. While a drag is
// over an element the browser repeats dragover continuously (at least
// every ~350 ms even when the pointer is still), so silence means the
// drag is over - cancelled with Esc, released outside the window, or
// ended somewhere that sent us nothing.
const DROP_HEARTBEAT_MS = 1200;
let _dropHighlighted = false;

function showDropTargetOn(el, why, msg) {
  el.classList.add('drop-target');
  el.classList.toggle('drop-refused', !!why);
  el.setAttribute('data-drop-msg', why || msg);
  _dropHighlighted = true;
  clearTimeout(el._dropTimer);
  el._dropTimer = setTimeout(() => hideDropTarget(el), DROP_HEARTBEAT_MS);
}

function showDropTarget(p) {
  showDropTargetOn(p.el, uploadBlocker(p), 'Drop to upload');
}

function hideDropTarget(el) {
  clearTimeout(el._dropTimer);
  el._dropTimer = null;
  el.classList.remove('drop-target', 'drop-refused');
}

function clearAllDropTargets() {
  if (!_dropHighlighted) return;
  _dropHighlighted = false;
  document.querySelectorAll('.pane.drop-target,.fb-panel.drop-target')
    .forEach(hideDropTarget);
}

function wirePaneDrop(p) {
  let el = p.el;
  // The highlight used to be driven by a dragenter/dragleave counter
  // alone. A cancelled drag (Esc, or released outside the browser) gets
  // no final dragleave in Chromium, so the counter never reached zero
  // and "Drop to upload" + the dashed outline stayed on the pane for
  // good. Now: dragleave checks whether the pointer really left the
  // pane (relatedTarget), every dragover re-arms a heartbeat, and the
  // document-level listeners below clear on any sign the drag is over.
  el.addEventListener('dragenter', ev => {
    if (!_dragHasFiles(ev)) return;
    ev.preventDefault();
    showDropTarget(p);
  });
  el.addEventListener('dragover', ev => {
    if (!_dragHasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = uploadBlocker(p) ? 'none' : 'copy';
    showDropTarget(p);
  });
  el.addEventListener('dragleave', ev => {
    if (!_dragHasFiles(ev)) return;
    // Moving between the pane's own children fires dragleave on the old
    // child with relatedTarget = the new one: still inside, keep it.
    if (ev.relatedTarget && el.contains(ev.relatedTarget)) return;
    hideDropTarget(el);
  });
  el.addEventListener('drop', ev => {
    if (!_dragHasFiles(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    clearAllDropTargets();
    let why = uploadBlocker(p);
    if (why) { showToast(why, 'warn'); return; }
    let files = droppedFiles(ev);
    if (files.length) { activatePane(p.id); startUploadFiles(p.id, files); }
  });
}

// The files in a drop, minus folders (the upload pipeline streams single
// files), warning once if any were skipped.
function droppedFiles(ev) {
  let items = ev.dataTransfer.items ? Array.from(ev.dataTransfer.items) : [];
  let files = [], folders = 0;
  if (items.length) {
    for (let it of items) {
      if (it.kind !== 'file') continue;
      let entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry && entry.isDirectory) { folders++; continue; }
      let f = it.getAsFile();
      if (f) files.push(f);
    }
  } else {
    files = Array.from(ev.dataTransfer.files || []);
  }
  if (folders) showToast('Folders can’t be uploaded — drop the files inside instead.', 'warn');
  return files;
}

// A file dropped anywhere else would make the browser navigate to it -
// replacing websh and dropping every session. Swallow stray drops.
document.addEventListener('dragover', ev => { if (_dragHasFiles(ev)) ev.preventDefault(); });
document.addEventListener('drop', ev => {
  clearAllDropTargets();
  if (!_dragHasFiles(ev)) return;
  ev.preventDefault();
  showToast('Drop files onto a terminal pane to upload them.', 'warn');
});
// Signals that the drag is over, whatever the pane saw:
// - the pointer left the window (dragleave with no relatedTarget);
// - dragend (a drag that started in the page);
// - ANY mouse/pointer movement or press: browsers suppress these for
//   the whole duration of a drag, so seeing one means it has ended;
// - the window lost focus (user switched away mid-drag).
document.addEventListener('dragleave', ev => { if (!ev.relatedTarget) clearAllDropTargets(); });
document.addEventListener('dragend', clearAllDropTargets);
['mousemove', 'pointermove', 'pointerdown', 'keydown'].forEach(t =>
  document.addEventListener(t, clearAllDropTargets, true));
window.addEventListener('blur', clearAllDropTargets);

// Encode filename as base64 to avoid ANY shell injection
function safeShellName(name) { return btoa(unescape(encodeURIComponent(name))); }

// Move uploaded tmp file from $HOME → cwd of foreground shell, with
// auto-increment if a file with that name already exists.
function makeUploadMvCmd(finalName, tmpName) {
  let bf = safeShellName(finalName);
  let bt = safeShellName(tmpName);
  return `t="$HOME/$(echo ${bt} | base64 -d)"; ` +
    `f="$(echo ${bf} | base64 -d)"; ` +
    'b="${f%.*}"; e="${f##*.}"; ' +
    'if [ "$b.$e" = "$f" ]; then ' +
      'n=1; while [ -e "$f" ]; do f="$b($n).$e"; n=$((n+1)); done; ' +
    'else ' +
      // Build name(1), name(2), ... from the ORIGINAL name. The old
      // ${f%(*)} stripped the shortest "(...)" suffix, mangling real names
      // with parentheses (report(final) -> report(1)). Mirrors the
      // server-side finalize_upload fix.
      'o="$f"; n=1; while [ -e "$f" ]; do f="$o($n)"; n=$((n+1)); done; ' +
    'fi; ' +
    // `--` plus `./` keep mv from parsing the destination as a flag if
    // the user uploaded a file whose name starts with `-`. Mirrors the
    // server-side finalize_upload path.
    'mv -- "$t" "./$f"\n';
}

// After bytes have landed at $HOME/<tmp>, move them into the user's
// shell cwd. Persistent sessions take the server-side path: a single
// /api/upload_finalize call uses tmux's #{pane_current_path} +
// ControlMaster to do the mv with no foreground keystrokes, so vim,
// less, htop etc. are never disturbed. Non-persistent sessions fall
// back to typing the mv into the foreground PTY (the only thing
// that knows their cwd), with an alt-screen guard so the keystrokes
// are skipped while a TUI is in front — those files are surfaced as
// staged at $HOME/.websh-tmp-* in the upload banner so the user can
// move them by hand.
function finalizeUploadedFile(p, file) {
  let u = p.upload;
  let tmp = u.currentTmp, fname = u.currentFile;
  // A named destination needs no tmux and no keystrokes, so it is the
  // server path for every pane - the foreground mv below exists only
  // because a non-persistent shell's cwd is unknowable from here.
  if (p.persistent || u.destDir) {
    let body = { session_id: p.sid, tmp: tmp, final: fname };
    if (u.destDir) body.dir = u.destDir;
    return api('upload_finalize', { body: body })
      .then(r => {
        if (r && r.ok && r.path) {
          u.placed.push({ name: fname, path: r.path });
          return;
        }
        // Server says non-persistent (shouldn't happen for a persistent
        // pane, but is the documented graceful-fallback shape) — fall
        // through to the keystroke path. Any other error is a hard
        // failure.
        if (r && r.non_persistent && !u.destDir) return foregroundMv(p, fname, tmp);
        return Promise.reject(r && r.error ? r.error : 'finalize failed');
      });
  }
  return foregroundMv(p, fname, tmp);
}

// Type the mv into the foreground PTY. Only path that knows the
// non-persistent shell's cwd. Skipped under alt-screen so we don't
// stuff text into a running editor.
function foregroundMv(p, fname, tmp) {
  let u = p.upload;
  let altScreen = p.term && p.term.buffer.active &&
    p.term.buffer.active.type === 'alternate';
  if (altScreen) {
    u.staged.push({ name: fname, tmp: tmp });
    return Promise.resolve();
  }
  return api('input', { body: { session_id: p.sid,
                                data: makeUploadMvCmd(fname, tmp) } });
}

// The bytes are safe in $HOME/<tmp>; only the move failed. Say where
// they are and WHY the move failed - the server's reason (a folder that
// vanished, a read-only one) is what the user needs to act on, and the
// destination is the one they chose, not "the current directory".
function describeFinalizeError(err, u) {
  let where = u && u.destDir ? u.destDir : 'the current directory';
  let tmp = u && u.currentTmp ? ' as ' + u.currentTmp : '';
  let reason = typeof err === 'string' ? err : (err && err.message) || '';
  let why;
  if (/no such file/i.test(reason)) {
    why = where + ' no longer exists';
  } else if (/permission|not permitted|read-only/i.test(reason)) {
    why = 'no permission to write to ' + where;
  } else if (/control socket not ready/i.test(reason)) {
    why = 'the connection to the host is not ready yet';
  } else if (/not a directory/i.test(reason)) {
    why = where + ' is not a folder';
  } else {
    why = 'it could not be moved to ' + where + (reason ? ' (' + reason + ')' : '');
  }
  return 'saved to your home folder' + tmp + ', but ' + why;
}

// Turn a failed upload into a reason that names the actual problem.
// The server already returns a precise {error} string with a matching
// HTTP status (see server.py _upload) — we surface that instead of a
// generic "failed", and translate the machine-y codes into plain
// language. `u` is the in-flight upload state (for byte progress).
function describeUploadError(xhr, resp, u) {
  // status 0 = the request never completed: DNS/TLS/connection, or the
  // file couldn't be read off disk. iOS Safari hands XHR an un-downloaded
  // iCloud stub whose read fails the instant send() touches it — the
  // browser hides the detail for privacy, so we infer from how far we got.
  if (!xhr.status) {
    if (u && u.fileOffset > 0) {
      // Clamp to 1..99: a tiny first chunk rounds to 0% and a drop after
      // the last progress event rounds to 100%, both of which read as
      // nonsense for a connection that was clearly interrupted mid-flight.
      let pct = u.fileSize > 0
        ? Math.min(99, Math.max(1, Math.round(u.fileOffset / u.fileSize * 100)))
        : 0;
      return 'the upload stopped at ' + pct +
        '% (connection dropped, or the file became unreadable)';
    }
    // The motivating case: iOS Safari hands XHR an un-downloaded iCloud
    // stub whose read fails the instant send() touches it — so steer the
    // user to the actual fix rather than a generic network message.
    return 'could not start the upload — if the file is in iCloud/Drive,' +
      ' open it once to download it, then retry; otherwise check your connection';
  }
  // Only the server's own string {error:<string>} is a usable reason; a
  // proxy returning {error:{...}} or {error:123} must not become
  // "[object Object]" — fall through to the HTTP-status line instead.
  let err = resp && typeof resp.error === 'string' ? resp.error : '';
  switch (err) {
    case 'file too large':   return 'file is larger than the server allows';
    case 'empty body':       return 'the file is empty';
    case 'invalid path':     return 'the file name was rejected by the server';
    case 'session not found':
    case 'session is dead':  return 'the terminal session is no longer connected';
    case 'control socket not ready':
      return 'the connection to the host is not ready yet';
    case 'ssh side-channel timeout':
      return 'timed out sending the file to the host';
    case 'client sent fewer bytes than Content-Length':
      return 'the upload was interrupted before all bytes arrived';
  }
  // e.g. "ssh exit 1: ...No space left on device" or "stream error: ..."
  // — the remote-side reason is the useful part, keep it verbatim.
  if (err.indexOf('ssh exit') === 0 || err.indexOf('stream error') === 0) {
    return 'host rejected the file (' + err + ')';
  }
  if (err) return err;
  return 'server error (HTTP ' + xhr.status + ')';
}

// A file goes up in pieces (UPLOAD_CHUNK_BYTES each, its own short POST
// with ?offset=) when the server appends them (config.upload_chunks).
// One long POST of the whole file was cut mid-body by corporate proxies
// and VPNs - the owner had to switch networks to upload anything.
//
// The piece size is ADAPTIVE. A proxy that truncates the body answers
// 400 (sometimes 499) with "client sent fewer bytes than Content-Length"
// before our server is reached, drops the connection outright, or - the
// owner's real case - cuts by size while HOLDING the connection open, so
// the body stalls with no reply; our own short-body reply carries the
// same text. Every such cut - truncation body, dropped connection, a
// mid-body stall (the watchdog in sendUploadPiece), or a timeout - is a
// size/duration the proxy enforces, so it HALVES the piece from the
// FIRST failure (down toward UPLOAD_CHUNK_MIN): a small file already
// gets through, so shrinking reaches a size that passes and the file
// still lands whole. A plain 5xx with no such body is a transient server
// blip, retried at the SAME size. Forward progress (a piece that lands)
// resets the failure/try budget and the wall-clock clock but KEEPS the
// shrunk size. The server refuses a piece that does not start where the
// file ends (409 + the real size) so a retry can never duplicate or skip
// bytes; 429 means slow down, not a failure, and keeps the size.
//
// Fast, visible failure when it truly cannot get through: give up within
// UPLOAD_WALLCLOCK_MS of no landed piece (not tries x the 120 s per-piece
// timeout), and once shrunk to the floor with the first piece still not
// landed, stop after ~2 more attempts. The give-up banner then names the
// probable proxy/firewall cause.
let UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const UPLOAD_CHUNK_MIN = 256 * 1024;
const UPLOAD_CHUNK_TRIES = 8;
let UPLOAD_CHUNK_TIMEOUT_MS = 120000;
let UPLOAD_RETRY_BASE_MS = 500;
// No piece has landed for this long (across retries) - end the upload
// with the "blocked or cut short" banner instead of tries x 120 s. Any
// landed piece resets the clock. A `let` so tests can shrink it.
let UPLOAD_WALLCLOCK_MS = 35000;

function uploadNextFile(p) {
  let u = p.upload;
  if (!u || u.cancelled) return;
  if (u.fileIndex >= u.files.length) { finishUpload(p, true); return; }
  let file = u.files[u.fileIndex];
  u.fileSize = file.size;
  u.fileOffset = 0;
  u.currentFile = file.name;
  // Random tmp name in $HOME — avoids collisions and makes cleanup easy.
  u.currentTmp = '.websh-tmp-' +
    Math.random().toString(36).slice(2, 12) + '-' +
    Date.now().toString(36);
  u.chunkSize = UPLOAD_CHUNK_BYTES;
  u.chunkFails = 0;
  u.floorFails = 0;
  u.cutSeen = false;
  u.lastAdvance = Date.now();
  // Sealed: the bucket this file's traffic is rounded up to, what has
  // been sent towards it, and whether one more pad piece follows.
  u.sealT = sealedUploadBucket(file.size);
  u.sealSent = 0;
  u.sealExtra = Math.random() < 0.5;
  // This browser found binary uploads blocked recently: start as text.
  if (!u.text && uploadTextAvailable() && uploadTextMarked()) u.text = true;
  if (serverConfig && serverConfig.upload_chunks && file.size > 0) {
    sendUploadPiece(p, u, file, 0);
  } else {
    sendUploadWhole(p, u, file);
  }
}

function uploadUrl(p, u, offset) {
  return `${API}?action=upload` +
    `&session_id=${encodeURIComponent(p.sid)}` +
    `&path=${encodeURIComponent(u.currentTmp)}` +
    (offset === undefined ? '' : `&offset=${offset}`);
}

function uploadFileDone(p, u, file) {
  finalizeUploadedFile(p, file).then(() => {
    if (!u || u.cancelled) return;
    u.sentBytes += file.size;
    u.fileOffset = 0;
    u.fileIndex++;
    u.currentFile = null;
    u.currentTmp = null;
    u.xhr = null;
    updateUploadProgress(p);
    uploadNextFile(p);
  })
  // Bytes already landed at $HOME/<tmp>; only the move into the cwd
  // failed. Lead with the reassuring plain-language fact and drop the
  // raw server string + the "$HOME" jargon from the banner (the detail
  // is still logged below). Guard on u.cancelled like the .then() above,
  // so a finalize rejection that lands during the cancel window doesn't
  // clobber the "Cancelled" banner.
  .catch((err) => {
    if (!u || u.cancelled) return;
    if (err) console.warn('websh: upload finalize failed:', err);
    finishUpload(p, false, describeFinalizeError(err, u));
  });
}

// A truncated request body: nginx or another proxy answers "client sent
// fewer bytes than Content-Length" (status 400, sometimes 499) before
// our server is reached, and our own short-body reply carries the same
// text as {error:...}. Match either the JSON error or a plain/HTML proxy
// body - that is the signal to shrink and retry, not to give up.
function uploadBodyTruncated(xhr, resp) {
  let re = /client sent fewer bytes than content-length/i;
  if (resp && typeof resp.error === 'string' && re.test(resp.error)) return true;
  let t = xhr && xhr.responseText;
  return typeof t === 'string' && re.test(t);
}

// ── Uploads as text when binary is blocked ─────────────────────────
// An endpoint-security product that intercepts HTTPS on the owner's Mac
// answers every application/octet-stream POST itself (503 text/html);
// the same bytes as base64 inside JSON pass. Uploads start binary as
// always; when binary is blocked - a reply that is not websh's, or cuts
// that go on at the smallest piece size, where the upload would
// otherwise give up - the upload switches to {"b64": ...} pieces and
// carries on from the size the server has (409 resume), and the browser
// remembers it for UPLOAD_TEXT_DAYS. Only with a server that says
// upload_text: an older one would write the JSON into the file.
const UPLOAD_TEXT_KEY = 'websh_upload_text';
const UPLOAD_TEXT_DAYS = 30;

function uploadTextAvailable() {
  return !!(serverConfig && serverConfig.upload_text);
}

function uploadTextMarked() {
  try {
    let at = parseInt(localStorage.getItem(storageKey(UPLOAD_TEXT_KEY)) || '', 10);
    if (!at) return false;
    if (Date.now() - at < UPLOAD_TEXT_DAYS * 86400000) return true;
    localStorage.removeItem(storageKey(UPLOAD_TEXT_KEY));
  } catch (e) {}
  return false;
}

// Switch this upload to text pieces. False when that is not possible
// (sealed - already text -, a server without upload_text, or already
// text): the caller then does what it did before.
function switchUploadToText(p, u) {
  if (u.text || sealedOn() || !uploadTextAvailable()) return false;
  u.text = true;
  try { localStorage.setItem(storageKey(UPLOAD_TEXT_KEY), String(Date.now())); } catch (e) {}
  showToast('Binary uploads are blocked on this computer (antivirus or proxy); ' +
            'sending uploads as text from now on.', 'warn');
  // Fresh tries for the new form; the piece size stays as it is. The
  // wall-clock budget does NOT start over (u.lastAdvance is kept): one
  // upload has one, so a path that fails either way still ends with the
  // visible failure in time (O7b).
  u.chunkFails = 0;
  u.floorFails = 0;
  u.cutSeen = false;
  console.log('upload: binary blocked, continuing as text');
  return true;
}

function sendUploadPiece(p, u, file, offset) {
  if (!u || u.cancelled || p.upload !== u) return;
  // Sealed, every piece of the file is the same size on the wire: the
  // (possibly shrunk) piece size, but never more than the file's bucket.
  let sealed = sealedOn();
  let step = sealed ? Math.min(u.chunkSize, u.sealT) : u.chunkSize;
  let end = Math.min(file.size, offset + step);
  let xhr = newApiXhr(sealed ? {to: step} : null);
  // Text piece: the same bytes as {"b64": ...} (sealed mode is text already).
  let asText = !sealed && !!u.text;
  u.xhr = xhr;
  xhr.open('POST', uploadUrl(p, u, offset), true);
  xhr.setRequestHeader('Content-Type', asText ? 'application/json' : 'application/octet-stream');
  xhr.timeout = UPLOAD_CHUNK_TIMEOUT_MS;

  // Mid-body stall watchdog. The owner's proxy cut uploads by SIZE while
  // HOLDING the connection open: the body stalls partway (the bar froze
  // at some %), onprogress stops ADVANCING, and nothing ends until the
  // 120 s xhr.timeout - a piece was retried only every ~2 min. So if the
  // uploaded byte count does not advance for a whole UPLOAD_WALLCLOCK_MS,
  // abort the piece and treat it as a cut. A real advance (see below)
  // re-arms it, so a slow-but-progressing upload (bytes still moving,
  // however slowly) is never killed by the cap - only a genuine stall,
  // with no byte of progress for the full budget, is. It stays armed
  // through the response wait too, since a proxy can hold the connection
  // after taking the body; xhr.onload (a landed piece) clears it.
  let stallMs = UPLOAD_WALLCLOCK_MS;
  let watchdog = null;
  let clearWatchdog = () => { if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; } };
  let armWatchdog = () => {
    clearWatchdog();
    let deadline = Date.now() + stallMs;
    let expire = () => {
      if (!u || u.cancelled || p.upload !== u) return;
      // Timer/clock rounding can run this callback a millisecond early.
      // Wait only the remaining time: treating that as a failed attempt
      // would retry before the shared budget expires, then grant a new
      // whole stall interval. Genuine byte progress alone re-arms it.
      let remaining = deadline - Date.now();
      if (remaining > 0) { watchdog = setTimeout(expire, remaining); return; }
      watchdog = null;
      xhr.onload = xhr.onerror = xhr.ontimeout = null;   // the abort must not re-enter
      try { xhr.abort(); } catch (e) {}
      u.xhr = null;
      retry('stalled - no data moved for ' + Math.round(stallMs / 1000) + ' s', true, true);
    };
    watchdog = setTimeout(expire, stallMs);
  };

  // Re-arm the stall watchdog only on a real ADVANCE of the byte count,
  // not on every onprogress event: a proxy that stops forwarding mid-body
  // but holds the connection open can keep firing onprogress with the
  // SAME e.loaded, and re-arming on those would keep the watchdog alive
  // forever (the bar froze at 67% of the piece with no failure). Only
  // bytes actually moving keep a slow-but-live upload alive.
  let lastLoaded = 0;
  xhr.upload.onprogress = e => {
    if (!u || u.cancelled) return;
    // A text piece is ~4/3 of the bytes it carries: show file bytes.
    u.fileOffset = offset + (asText && e.total
      ? Math.floor((end - offset) * Math.min(1, e.loaded / e.total)) : e.loaded);
    updateUploadProgress(p);
    if (e.loaded > lastLoaded) { lastLoaded = e.loaded; armWatchdog(); }
  };
  // The watchdog is NOT disarmed when the body finishes uploading: the
  // proxy can hold the connection open AFTER taking the body and never
  // answer, so the response wait is bounded by the same timer - no piece
  // has LANDED until xhr.onload runs, which clears it. (A server append
  // slower than UPLOAD_WALLCLOCK_MS is then treated as a stall too; the
  // budget is the whole no-forward-progress window, not just body bytes.)

  // Give up now. Once a cut has been seen (a proxy/nginx body truncation,
  // a dropped connection, or a mid-body stall / timeout) name the
  // probable cause and an action; otherwise fall back to the specific
  // reason the caller computed.
  let giveUp = fallback => {
    // Cut even at the smallest piece: binary itself may be what is
    // blocked. Try text before giving up (once; see switchUploadToText).
    // A stall is not that (no reply says binary was refused).
    if (u.cutSeen && !u.lastFailStall && switchUploadToText(p, u)) {
      sendUploadPiece(p, u, file, offset);
      return;
    }
    finishUpload(p, false, u.cutSeen
      ? 'blocked or cut short — a proxy or firewall on this network is' +
        ' likely limiting uploads; a smaller file may still go through'
      : fallback);
  };

  // `stall`: no reply at all (the watchdog, a timeout) - a cut, but never
  // a reason to try text: nothing says binary was refused.
  let retry = (why, cut, stall) => {
    if (!u || u.cancelled || p.upload !== u) return;
    clearWatchdog();
    if (cut) u.cutSeen = true;
    u.lastFailStall = !!stall;
    u.chunkFails++;
    // Halve from the first cut (down toward the floor); a non-cut
    // failure (a plain 5xx server blip) keeps the size - the piece is
    // not known to be too big.
    if (cut) u.chunkSize = Math.max(UPLOAD_CHUNK_MIN, u.chunkSize >> 1);
    // Wall-clock budget: no piece has landed for this long - stop now
    // (with the cut banner if cuts were seen) rather than tries x 120 s.
    if (Date.now() - u.lastAdvance >= UPLOAD_WALLCLOCK_MS) { giveUp(why); return; }
    // This attempt was already at the floor and the first piece still
    // has not landed: shrinking is exhausted, so stop after ~2 such
    // attempts instead of the whole try budget. (end - offset is the
    // size we just sent, before the halving above takes effect.)
    if (cut && offset === 0 && (end - offset) <= UPLOAD_CHUNK_MIN) {
      u.floorFails = (u.floorFails || 0) + 1;
      if (u.floorFails >= 2) { giveUp(why); return; }
    }
    if (u.chunkFails >= UPLOAD_CHUNK_TRIES) { giveUp(why); return; }
    let delay = Math.min(16 * UPLOAD_RETRY_BASE_MS, UPLOAD_RETRY_BASE_MS * Math.pow(2, u.chunkFails - 1));
    console.log('upload: piece at', offset, 'failed (' + why + '), retry', u.chunkFails,
                'in', delay, 'ms, piece size', u.chunkSize);
    setTimeout(() => sendUploadPiece(p, u, file, offset), delay);
  };
  xhr.onload = () => {
    if (!u || u.cancelled) return;
    clearWatchdog();
    let resp = null;
    try { resp = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status === 409 && resp && typeof resp.size === 'number' && resp.size >= 0) {
      // The remote file is not where we thought (a piece died after
      // part of it landed): continue from where it really ends. If it
      // is already complete - the last piece landed and only its reply
      // was lost - there is nothing left to send. Longer than the file
      // cannot be ours: leave it alone, never reset this occupied path.
      if (resp.size > file.size) {
        finishUpload(p, false, 'The temporary upload contains more data than the selected file. Start the upload again.');
        return;
      }
      u.chunkFails++;
      if (u.chunkFails >= UPLOAD_CHUNK_TRIES) { finishUpload(p, false, 'the upload could not be resumed'); return; }
      if (resp.size === file.size) { u.fileOffset = file.size; updateUploadProgress(p); uploadDataDone(p, u, file); return; }
      sendUploadPiece(p, u, file, resp.size);
      return;
    }
    if (xhr.status === 429) {
      // The server's side-channel rate limit (240 calls a minute per
      // address): a fast link sends 4 MB pieces faster than that. Not a
      // failure - wait, keep the piece size, do not count it as a try.
      u.throttled = (u.throttled || 0) + 1;     // in a row; a delivered piece resets it
      if (u.throttled > 30) { finishUpload(p, false, 'the server kept asking to slow down'); return; }
      setTimeout(() => sendUploadPiece(p, u, file, offset), 3000);
      return;
    }
    // Not websh's reply at all (an interceptor's own 503 text/html): the
    // binary body is what is refused. Switch to text at once, no halving.
    if ((xhr.status < 200 || xhr.status > 299) &&
        !(resp && typeof resp === 'object' && typeof resp.error === 'string') &&
        !uploadBodyTruncated(xhr, resp) && switchUploadToText(p, u)) {
      sendUploadPiece(p, u, file, offset);
      return;
    }
    if (xhr.status !== 200 || !resp || !resp.ok) {
      // nginx or a proxy that truncated the body answers 400 (sometimes
      // 499) with "client sent fewer bytes than Content-Length" before
      // our server is reached, and our own short-body reply carries the
      // same text: that is a cut - retry AND shrink. A plain 408/5xx is
      // transient too, but retried at the SAME size (a server blip, not
      // a size limit). Everything else - 413, invalid path, a session
      // error, a plain 400 - is the server's final verdict and stops.
      let cut = uploadBodyTruncated(xhr, resp);
      let transient = cut || xhr.status === 408 || xhr.status >= 500;
      if (!transient) { finishUpload(p, false, describeUploadError(xhr, resp, u)); return; }
      retry(describeUploadError(xhr, resp, u), cut);
      return;
    }
    // A piece landed: forward progress. Reset the failure/try budget,
    // the wall-clock clock and the cut flag, but KEEP the shrunk size.
    u.chunkFails = 0;
    u.throttled = 0;
    u.floorFails = 0;
    u.cutSeen = false;
    u.lastAdvance = Date.now();
    u.fileOffset = end;
    if (sealed) u.sealSent += step;
    updateUploadProgress(p);
    if (end < file.size) sendUploadPiece(p, u, file, end);
    else uploadDataDone(p, u, file);
  };
  // A dropped connection (status 0, no HTTP reply) and a timeout are both
  // how a proxy/VPN that cuts the body by size/duration shows up when no
  // usable reply reaches us: treat each as a cut - shrink and retry, and
  // name the proxy cause on give-up - not a final "could not start"
  // (describeUploadError keeps that reason for its own callers and the
  // log line here).
  xhr.onerror = () => { clearWatchdog(); retry(describeUploadError(xhr, null, u), true); };
  xhr.ontimeout = () => { clearWatchdog(); retry('no answer from the server for ' + Math.round(UPLOAD_CHUNK_TIMEOUT_MS / 1000) + ' s', true, true); };
  armWatchdog();
  if (!asText) { xhr.send(file.slice(offset, end)); return; }
  file.slice(offset, end).arrayBuffer().then(buf => {
    if (!u || u.cancelled || u.xhr !== xhr) return;
    xhr.send('{"b64":"' + _b64enc(new Uint8Array(buf)) + '"}');
  }, () => { if (u.xhr === xhr) { clearWatchdog(); retry('the file could not be read', false); } });
}

// Every byte of the file is on the target. Sealed, pad-only pieces of
// the same size follow until the file's bucket is covered (plus one
// more half of the time), so the number of requests does not tell the
// size either. They are best effort: the file is already whole, so a
// failed one ends the padding, not the upload.
function uploadDataDone(p, u, file) {
  if (!sealedOn() || !u.sealT) { uploadFileDone(p, u, file); return; }
  sendUploadPadding(p, u, file);
}

function sendUploadPadding(p, u, file) {
  if (!u || u.cancelled || p.upload !== u) return;
  if (u.sealSent >= u.sealT) {
    if (!u.sealExtra) { uploadFileDone(p, u, file); return; }
    u.sealExtra = false;
  }
  let step = Math.min(u.chunkSize, u.sealT);
  let xhr = newApiXhr({to: step, pad: true});
  if (!(xhr instanceof SealedXhr)) { uploadFileDone(p, u, file); return; }  // turned off meanwhile
  u.xhr = xhr;
  xhr.open('POST', uploadUrl(p, u, file.size), true);
  xhr.timeout = UPLOAD_CHUNK_TIMEOUT_MS;
  let done = () => { if (u && !u.cancelled && p.upload === u) uploadFileDone(p, u, file); };
  xhr.onload = () => {
    if (!u || u.cancelled || p.upload !== u) return;
    if (xhr.status !== 200) { done(); return; }
    u.sealSent += step;
    sendUploadPadding(p, u, file);
  };
  xhr.onerror = xhr.ontimeout = done;
  xhr.send(null);
}

// Older servers (no config.upload_chunks) and empty files: one request.
function sendUploadWhole(p, u, file) {
  let xhr = newApiXhr(sealedOn() ? {to: u.sealT || sealedUploadBucket(file.size)} : null);
  u.xhr = xhr;
  xhr.open('POST', uploadUrl(p, u), true);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = e => {
    if (!u || u.cancelled) return;
    u.fileOffset = e.loaded;
    updateUploadProgress(p);
  };
  xhr.onload = () => {
    if (!u || u.cancelled) return;
    let resp = null;
    try { resp = JSON.parse(xhr.responseText); } catch(e) {}
    if (xhr.status !== 200 || !resp || !resp.ok) {
      finishUpload(p, false, describeUploadError(xhr, resp, u)); return;
    }
    uploadFileDone(p, u, file);
  };
  xhr.onerror = () => {
    if (u && !u.cancelled) finishUpload(p, false, describeUploadError(xhr, null, u));
  };
  xhr.send(file);
}

function showUploadProgress(p) {
  let label = p.el.querySelector('[data-pane-label]');
  let prog = p.el.querySelector('[data-upload-progress]');
  if (label) label.classList.add('h');
  if (prog) {
    // Reset state from previous operation
    prog.querySelector('.upload-progress-bar').style.width = '0%';
    prog.querySelector('.upload-progress-bar').style.background = '';
    prog.querySelector('.upload-progress-text').textContent = '';
    prog.classList.remove('h');
  }
  paintFbXfer(p);
}

function hideUploadProgress(p) {
  let label = p.el.querySelector('[data-pane-label]');
  let prog = p.el.querySelector('[data-upload-progress]');
  if (label) label.classList.remove('h');
  if (prog) prog.classList.add('h');
  paintFbXfer(p);
}

function updateUploadProgress(p) {
  if (!p.upload) return;
  let el = p.el.querySelector('[data-upload-progress]');
  if (!el) return;
  let u = p.upload;
  let total = u.files.length, done = u.fileIndex;
  let file = done < total ? u.files[done] : null;
  let name = file ? file.name : 'Done';
  let bytesDone = u.sentBytes + (u.fileSize > 0 ? u.fileOffset : 0);
  let pct = u.totalSize > 0 ? Math.min(100, Math.round(bytesDone / u.totalSize * 100)) : 0;
  el.querySelector('.upload-progress-bar').style.width = pct + '%';
  let prefix = total > 1 ? `(${Math.min(done + 1, total)}/${total}) ` : '';
  el.querySelector('.upload-progress-text').textContent = prefix + name + ' ' + pct + '%';
  paintFbXfer(p);
}

function closeUploadSession(u) {
  if (!u) return;
  if (u.xhr) { try { u.xhr.abort(); } catch(e) {} u.xhr = null; }
}

// Shared tail of every transfer outcome (upload/download x finish/cancel):
// paint the progress bar + text for this outcome, then after `delay` clear
// the transfer slot, hide the bar and refresh the badge. Painting differs
// per outcome and stays at the call sites via `paint(bar, text)`.
// Resolves once the slot is released - the moment another transfer may
// start. A queue (fbBulkDownload) must wait for THAT, not for the bytes:
// the finished transfer keeps p[slot] set while its banner is showing,
// and startFastDownload refuses to start while it is.
function settleTransfer(p, slot, delay, paint) {
  let el = p.el && p.el.querySelector('[data-upload-progress]');
  if (el && paint) {
    paint(el.querySelector('.upload-progress-bar'),
          el.querySelector('.upload-progress-text'));
    paintFbXfer(p);          // the outcome, not just the progress
  }
  let mine = p[slot];
  return new Promise(resolve => setTimeout(() => {
    // Only release the transfer this call settled: if the banner was
    // dismissed early and a new transfer has started since, this late
    // timer must not null (and hide) the new one.
    if (p[slot] === mine) {
      p[slot] = null;
      hideUploadProgress(p);
      updatePaneBadge(p);
      if (el) el.querySelector('.upload-progress-bar').style.background = '';
    }
    resolve();
  }, delay));
}

// The X on a transfer that has already ENDED only dismisses its banner.
function dismissTransfer(p, slot) {
  p[slot] = null;
  hideUploadProgress(p);
  updatePaneBadge(p);
  let el = p.el && p.el.querySelector('[data-upload-progress] .upload-progress-bar');
  if (el) el.style.background = '';
}

function finishUpload(p, success, reason) {
  if (!p.upload) return;
  let u = p.upload;
  u.cancelled = true;
  closeUploadSession(u);
  let staged = u.staged || [];
  let placed = u.placed || [];
  // The browser is showing the directory the file just landed in: list
  // it again so the user sees the file instead of having to refresh.
  if (success && u.destDir && _fbId === p.id && _fbCurPath === u.destDir
      && !$('fbOv').classList.contains('h')) {
    reloadFbDir();
  }
  // Banner stays visible longer when there's something the user needs to
  // read and act on — a destination path, or a specific failure reason —
  // so it doesn't vanish before they can take it in.
  let dismissAfter = (!success || staged.length || placed.length === 1)
    ? 6000 : 2000;
  settleTransfer(p, 'upload', dismissAfter, (bar, text) => {
    if (success) {
      bar.style.width = '100%'; bar.style.background = 'var(--ok)';
      if (staged.length) {
        // Files landed in $HOME but auto-mv was skipped (alt-screen).
        // Tell the user where to look so the upload isn't a silent no-op.
        text.textContent = staged.length === 1
          ? 'Saved to $HOME/' + staged[0].tmp + ' (alt-screen — mv manually)'
          : 'Saved ' + staged.length + ' files to $HOME/.websh-tmp-* (alt-screen)';
      } else if (placed.length === 1) {
        // Persistent finalize gave us the absolute path — show it.
        text.textContent = 'Saved to ' + placed[0].path;
      } else if (placed.length > 1 && u.destDir) {
        text.textContent = 'Saved ' + placed.length + ' files to ' + u.destDir;
      } else {
        text.textContent = 'Upload complete';
      }
    } else {
      bar.style.background = 'var(--dg)';
      text.textContent = reason ? 'Upload failed: ' + reason : 'Upload failed';
    }
  });
}

function cancelUpload(id) {
  let p = panes[id];
  if (!p || !p.upload) return;
  let u = p.upload;
  // Finished already (success or failure; finishUpload sets cancelled):
  // the X is dismissing the result banner. Cancelling here used to POST
  // upload_cancel for the staged file - after a failed move that is the
  // ONLY copy, which the banner had just said was safe in $HOME - and
  // relabel a "Saved to ..." banner as "Cancelled".
  if (u.cancelled) { dismissTransfer(p, 'upload'); return; }
  let tmpName = u.currentTmp;
  u.cancelled = true;
  if (u.xhr) { try { u.xhr.abort(); } catch(e) {} u.xhr = null; }
  // Best-effort cleanup of the partial $HOME/<tmp> via the
  // ControlMaster side-channel — keystroke-free, so a TUI in front
  // of the foreground PTY (vim/less/htop) is left alone.
  if (tmpName) {
    api('upload_cancel', { body: { session_id: p.sid, tmp: tmpName } })
      .catch(() => {});
  }

  settleTransfer(p, 'upload', 2000, (bar, text) => {
    bar.style.background = 'var(--wn)';
    text.textContent = 'Cancelled';
  });
}

function cancelTransfer(id) {
  let p = panes[id];
  if (p && p.upload) cancelUpload(id);
  else if (p && p.download) cancelDownload(id);
}

// ── File download ────────────────────────────────────────────────────
function triggerDownload(id) {
  let p = panes[id];
  if (!p || !p.sid || p.upload || p.download || (!p.host && !p.connection)) return;
  showFileBrowser(id);
}

// Resolves true when the file has been saved, false on any failure or
// cancellation - fbBulkDownload chains the queue on it. o.settleDelay
// shortens how long the finished transfer stays on the pane bar so the
// next file in a queue isn't blocked behind it.
function startFastDownload(id, path, o) {
  let p = panes[id];
  if (!p || !p.sid || p.upload || p.download) return Promise.resolve(false);
  let settleDelay = (o && o.settleDelay) || 2000;
  let filename = path.split('/').pop() || 'download';
  let ctrl = new AbortController();
  p.download = {cancelled: false, filename: filename, abort: () => ctrl.abort()};
  showUploadProgress(p);
  updatePaneBadge(p);

  let url = API + '?action=download&session_id=' + encodeURIComponent(p.sid) +
            '&path=' + encodeURIComponent(path);
  return apiFetch(url, {signal: ctrl.signal})
    .then(resp => {
      if (!resp.ok) {
        return resp.json().then(e => { throw new Error(e.error || 'failed'); });
      }
      let total = parseInt(resp.headers.get('Content-Length') || '0', 10);
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error('file too large (' + (total / 1048576).toFixed(0) + ' MB)');
      }
      let chunks = [], received = 0;
      let reader = resp.body.getReader();
      // Cache the progress nodes once. pump() runs per stream chunk, so
      // re-querying three selectors every chunk is needless DOM work on a
      // large download; the nodes are stable for the pane's lifetime.
      let progBar = p.el && p.el.querySelector(
        '[data-upload-progress] .upload-progress-bar');
      let progText = p.el && p.el.querySelector(
        '[data-upload-progress] .upload-progress-text');
      function pump() {
        return reader.read().then(({done, value}) => {
          if (done) return;
          if (!p.download || p.download.cancelled) { reader.cancel(); return; }
          chunks.push(value);
          received += value.length;
          if (received > MAX_DOWNLOAD_BYTES) {
            // Server didn't advertise Content-Length but the stream is
            // overrunning the cap. Abort before the tab OOMs.
            reader.cancel();
            throw new Error('download exceeded ' +
              (MAX_DOWNLOAD_BYTES / 1073741824).toFixed(0) + ' GB cap');
          }
          if (progBar) {
            let pct = total > 0 ? Math.round(received / total * 100) : 30;
            progBar.style.width = pct + '%';
            let sz = received < 1048576
              ? Math.round(received / 1024) + ' KB'
              : (received / 1048576).toFixed(1) + ' MB';
            if (progText) progText.textContent = filename + ' (' + sz + ')';
          }
          return pump();
        });
      }
      return pump().then(() => {
        // Cancellation: pump returns undefined on cancel, which resolves
        // the promise. Without this guard we'd still build a partial
        // Blob and trigger a save dialog with success UI. The .catch
        // branch below has the same guard.
        if (!p.download || p.download.cancelled) return false;
        let blob = new Blob(chunks, {type: 'application/octet-stream'});
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        return finishDownload(p, true, null, settleDelay).then(() => true);
      });
    })
    .catch(e => {
      if (p.download && !p.download.cancelled)
        return finishDownload(p, false, e.message || 'download failed', settleDelay)
          .then(() => false);
      return false;
    });
}

// Resolves when the pane can take another transfer (see settleTransfer).
function finishDownload(p, success, msg, settleDelay) {
  let dl = p.download;
  if (!dl) return Promise.resolve();
  dl.cancelled = true;
  return settleTransfer(p, 'download', settleDelay || 2000, (bar, text) => {
    if (success) {
      bar.style.width = '100%'; bar.style.background = 'var(--ok)';
      text.textContent = 'Download complete';
    } else {
      bar.style.background = 'var(--dg)';
      text.textContent = msg || 'Download failed';
    }
  });
}

function cancelDownload(id) {
  let p = panes[id];
  if (!p || !p.download) return;
  if (p.download.cancelled) { dismissTransfer(p, 'download'); return; }
  p.download.cancelled = true;
  if (p.download.abort) p.download.abort();
  settleTransfer(p, 'download', 2000, (bar, text) => {
    bar.style.background = 'var(--wn)';
    text.textContent = 'Cancelled';
  });
}

// ── File browser ─────────────────────────────────────────────────────
let _fbId = null;
// The directory the browser is currently showing (absolute, server-
// resolved). Breadcrumbs, "up", reload, and new-folder all read it
// rather than scraping it back out of the DOM.
let _fbCurPath = '';
// Request generation for /api/ls. Only the newest request may paint:
// a slow reply from an earlier directory (or an earlier pane) used to
// overwrite a newer listing - and the breadcrumbs with it, so nothing
// looked wrong while rm/mv/mkdir then targeted the wrong directory, or
// the wrong HOST when the browser had been reopened on another pane.
let _fbSeq = 0;
// The session id whose listing is on screen. Every mutating action is
// checked against it so a row from pane A can never be deleted through
// pane B's session.
let _fbListedSid = null;

// The `done` closure of the row currently showing an inline editor — a
// delete confirmation, a rename field, or the new-folder input — or
// null. At most one is open at a time: opening a second runs this to
// dismiss the first, so the list never shows two competing editors.
let _fbConfirm = null;
// The entries behind the rows on screen, for client-side re-sorting.
let _fbEntries = null;

// Escape while an inline editor is open dismisses it ("no") instead of
// closing the whole browser, which is what the user means and saves
// re-navigating to the directory they were in.
function cancelFbConfirm() {
  if (!_fbConfirm) return false;
  let done = _fbConfirm;
  _fbConfirm = null;
  done();
  return true;
}

const _fbTrap = makeModalTrap('fbOv', () => {
  if (cancelFbConfirm()) return;
  closeFb();
});
function showFileBrowser(id) {
  let p = panes[id];
  if (!p || !p.sid) return;
  _fbId = id;
  // Which machine this is. The browser can delete and rename, and with
  // several panes open (or after a nested ssh changed OSC 7) the rows
  // alone don't say which host they live on.
  let hostEl = $('fbHost');
  if (hostEl) {
    let who = (p.user ? p.user + '@' : '') + (p.host || '');
    hostEl.textContent = who;
    hostEl.title = who ? 'Files on ' + who : '';
    hostEl.hidden = !who;
  }
  // A fresh open never shows another pane's rows: clear the previous
  // listing (and invalidate its in-flight request) before the first
  // load, so the keep-while-loading logic has nothing stale to keep.
  _fbSeq++;
  _fbListedSid = null;
  $('fbList').innerHTML = '';
  setFbPath('');
  $('fbManual').value = '';
  // Escape now closes the browser and Tab cycles inside it (previously
  // neither worked); focus starts in the manual-path input.
  _fbTrap.open(() => $('fbManual'));
  syncFbSortUi();
  syncFbHiddenUi();
  paintFbXfer(p);            // a transfer may already be running
  let f = $('fbFilter'); if (f) f.value = '';
  // Open where the user is standing, not at $HOME. Three sources, best
  // first: OSC 7 told us directly; the server can ask tmux; otherwise
  // fall back to the historical ~.
  if (p.cwd) loadFbDir(p.cwd, {fallbackHome: true});
  else loadFbDir('~', {paneCwd: true});
}

// Store the resolved directory and repaint the breadcrumb trail. The
// full path also lands in data-path on the <nav> so scripts and tests
// have one unambiguous place to read it.
function setFbPath(path) {
  _fbCurPath = path || '';
  let copy = $('fbCopyPath');
  if (copy) copy.disabled = !_fbCurPath;
  let nav = $('fbPath');
  if (!nav) return;
  nav.innerHTML = '';
  nav.setAttribute('data-path', _fbCurPath);
  if (!_fbCurPath) return;               // loading (pane-cwd not resolved yet)
  let parts = _fbCurPath.split('/').filter(s => s.length);
  let crumb = (label, full, cur) => {
    let b = document.createElement('button');
    b.type = 'button';
    b.className = 'fb-crumb' + (cur ? ' cur' : '');
    b.textContent = label;
    if (cur) {
      // Where you already are: announced, but not a do-nothing Tab stop.
      b.setAttribute('aria-current', 'location');
      b.tabIndex = -1;
    }
    if (!cur) b.addEventListener('click', () => loadFbDir(full));
    return b;
  };
  // Root "/" first; its trailing slash doubles as the separator before
  // the first segment, so separators are only drawn between segments.
  nav.appendChild(crumb('/', '/', parts.length === 0));
  let acc = '';
  parts.forEach((seg, i) => {
    if (i > 0) {
      let sep = document.createElement('span');
      sep.className = 'fb-crumb-sep'; sep.textContent = '/';
      nav.appendChild(sep);
    }
    acc += '/' + seg;
    nav.appendChild(crumb(seg, acc, i === parts.length - 1));
  });
  // Keep the deepest crumb in view on a long path.
  nav.scrollLeft = nav.scrollWidth;
}

function fbCopyPath() {
  // The committed breadcrumb path, never an unsubmitted manual path or
  // an in-flight destination. Copy exactly what this click refers to.
  let path = _fbCurPath;
  if (!path || !_fbId) return;
  copyText(path).then(ok => showToast(ok ? 'Path copied.' :
    'Could not copy the path. Allow clipboard access and try again.', ok ? 'ok' : 'err'));
}

function closeFb() {
  // Drop any armed confirmation without running its DOM restore — the
  // list is about to be discarded, and a stale closure would otherwise
  // keep a detached row alive.
  _fbConfirm = null;
  fbClearSel();
  _fbTrap.close();
  _fbId = null;
  _fbSeq++;              // a reply still in flight must not paint a closed browser
  _fbListedSid = null;
}

function fbUp() {
  let cur = _fbCurPath;
  if (!cur || cur === '/') return;
  let parent = cur.lastIndexOf('/') > 0 ? cur.substring(0, cur.lastIndexOf('/')) : '/';
  loadFbDir(parent);
}

// o.paneCwd: ignore `path` and let the server start from the pane's
// working directory (it can resolve one for tmux-backed sessions, and
// falls back to $HOME otherwise). The response's `path` is always the
// directory we actually landed in, so the header stays truthful either
// way.
function loadFbDir(path, o) {
  let p = _fbId && panes[_fbId];
  if (!p || !p.sid) return;
  let list = $('fbList');
  let req = ++_fbSeq, reqPane = _fbId, reqSid = p.sid;
  // Keep the current listing on screen until the new one arrives, then
  // swap path + rows in one go. Replacing the list with a "Loading…"
  // line made the panel collapse and repaint on every navigation,
  // delete and rename; the only time a placeholder is shown is when
  // there is nothing to keep (first open).
  if (!list.querySelector('.fb-row')) {
    list.innerHTML = '<div class="fb-msg">Loading…</div>';
  }
  list.setAttribute('aria-busy', 'true');
  let stale = () => req !== _fbSeq || _fbId !== reqPane ||
                    !panes[reqPane] || panes[reqPane].sid !== reqSid;
  apiFetch(API + '?action=ls&session_id=' + encodeURIComponent(reqSid) +
        '&path=' + encodeURIComponent(path) +
        ((o && o.paneCwd) ? '&cwd=1' : ''))
    .then(r => r.json())
    .then(r => {
      if (stale()) return;
      list.removeAttribute('aria-busy');
      // A response with no resolved path is not a listing we can render:
      // every downstream path is built by joining onto r.path, so an
      // absent one would produce "undefined/name" download targets.
      if (r.error || !r.path || !Array.isArray(r.entries)) {
        fbLoadFailed(list, path, o, r.error || 'Failed to load');
        return;
      }
      // A fresh directory starts unfiltered — a filter left over from
      // the previous listing would silently hide most of the new one.
      // A re-list of the SAME directory (after rm/mv/mkdir) keeps it.
      if (r.path !== _fbCurPath) {
        let f = $('fbFilter'); if (f) f.value = '';
      }
      setFbPath(r.path);
      _fbListedSid = reqSid;
      renderFbEntries(r.entries, r.path);
    })
    .catch(() => {
      if (stale()) return;
      list.removeAttribute('aria-busy');
      fbLoadFailed(list, path, o, 'Failed to load');
    });
}

// A listing that could not be loaded. If a usable listing is still on
// screen (a click into an unreadable folder, a network blip), keep it -
// breadcrumbs, Up and every row still work - and say what failed. Only
// with nothing to keep does the list show the error. A start directory
// that came from the shell (OSC 7) may be stale - deleted, or on
// another host after a nested ssh - so that one falls back to the
// pane's own directory / $HOME instead of a dead end.
function fbLoadFailed(list, path, o, msg) {
  // The page (or the list) may be gone by the time a slow reply fails.
  if (!list || !list.isConnected) return;
  if (o && o.fallbackHome) {
    showToast(path + ': ' + msg + ' — showing the pane directory instead', 'warn');
    loadFbDir('~', {paneCwd: true});
    return;
  }
  if (_fbListedSid && list.querySelector('.fb-row')) {
    showToast(path + ': ' + msg, 'err');
    return;
  }
  list.innerHTML = '<div class="fb-msg err">' + esc(msg) + '</div>';
}

// The pane whose listing is on screen - or null (with a reload kicked
// off) when the session has changed underneath the rows, so a queued
// rm/mv/mkdir can never run against a different host than the one the
// user was looking at.
function fbSessionForAction() {
  let p = _fbId && panes[_fbId];
  if (p && p.sid && p.sid === _fbListedSid) return p;
  showToast('Listing is out of date — reloading', 'warn');
  reloadFbDir();
  return null;
}

// Re-list the current directory. Used after a create/rename/delete so
// the view reflects the remote rather than a locally patched guess.
function reloadFbDir() {
  if (_fbCurPath) loadFbDir(_fbCurPath);
}

function renderFbEntries(entries, absPath) {
  let list = $('fbList');
  // Every row here is about to be replaced, so an armed confirmation
  // from the previous listing no longer refers to anything on screen.
  _fbConfirm = null;
  _fbEntries = entries;
  // Names are only meaningful within one listing: keeping them across a
  // navigation (or a delete) would aim an action at a different file.
  _fbSel.clear();
  _fbSelAnchor = null;
  list.innerHTML = '';
  if (absPath !== '/') {
    let parent = absPath.lastIndexOf('/') > 0
      ? absPath.substring(0, absPath.lastIndexOf('/')) : '/';
    let row = makeFbRow('d', '..', null, null, {noActions: true});
    // Marked so the dotfile/filter visibility pass never hides it — ".."
    // both starts with a dot and matches no filter term.
    row.dataset.parent = '1';
    row.addEventListener('click', () => loadFbDir(parent));
    makeFbRowKeyboardable(row);
    list.appendChild(row);
  }
  for (let e of sortFbEntries(entries)) {
    let fullPath = absPath.endsWith('/') ? absPath + e.name : absPath + '/' + e.name;
    let row = makeFbRow(e.type, e.name, fbIsDir(e) ? null : e.size, e.mtime,
                        {dirLink: fbIsDir(e) && e.type === 'l'});
    // While a row is showing an inline editor (delete-confirm or rename)
    // it stops being a download/navigate target — otherwise the click
    // that lands next to the editor would act on the row underneath.
    let activate = fn => row.addEventListener('click', () => {
      if (row.classList.contains('fb-confirm') ||
          row.classList.contains('fb-edit')) return;
      fn();
    });
    if (fbIsDir(e)) {
      // A link to a folder opens at the link's own path: the breadcrumbs
      // show it, and Up goes back to the folder the link is in.
      activate(() => loadFbDir(fullPath));
    } else {
      activate(() => {
        let id = _fbId;
        let tp = id && panes[id];
        // One transfer per pane. startFastDownload() refuses a second
        // one silently, and we used to close the browser first - so the
        // click did nothing at all and said nothing. Keep the browser
        // open and explain.
        if (tp && (tp.upload || tp.download)) {
          showToast('A ' + (tp.upload ? 'upload' : 'download') +
                    ' is already running in this pane — wait for it or cancel it first.',
                    'warn');
          return;
        }
        closeFb();
        if (id) startFastDownload(id, fullPath);
      });
    }
    wireFbRow(row, fullPath, e.name, e.type);
    makeFbRowKeyboardable(row);
    list.appendChild(row);
  }
  if (!entries.length) {
    let m = document.createElement('div');
    m.className = 'fb-msg'; m.textContent = 'Empty directory';
    list.appendChild(m);
  }
  // Apply the dotfile toggle and any active name filter to the fresh rows.
  applyFbVisibility();
}

// Rows were plain <div>s with a click handler: a keyboard user could
// reach the ✎/✕ buttons but never open a folder or download a file.
// Enter/Space on the ROW itself (not on a button or editor inside it,
// whose own keys must keep their meaning) acts like a click.
function makeFbRowKeyboardable(row) {
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('keydown', ev => {
    if (ev.target !== row) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      row.click();
    }
  });
}

// A folder, or a symlink whose target is one (the server's "dir": true;
// the owner's ~/job/<name> -> an rclone mount was listed with the files
// and a click downloaded it). Such a link is shown, sorted and opened as
// a folder; delete and rename still act on the link only (type stays
// "l"). A link to a file and a dangling link are unchanged.
function fbIsDir(e) {
  return e.type === 'd' || (e.type === 'l' && e.dir === true);
}
function fbRowIsDir(row) {
  return row.dataset.type === 'd' || row.dataset.dirlink === '1';
}

function makeFbRow(type, name, size, mtime, o) {
  let row = document.createElement('div');
  row.className = 'fb-row';
  let dirLink = !!(o && o.dirLink);
  let icon = ic(type === 'd' || dirLink ? 'folder' : type === 'l' ? 'link' : 'file');
  let sizeStr = '';
  if (size !== null && size !== undefined) {
    if (size < 1024) sizeStr = size + ' B';
    else if (size < 1048576) sizeStr = (size / 1024).toFixed(1) + ' KB';
    else if (size < 1073741824) sizeStr = (size / 1048576).toFixed(1) + ' MB';
    else sizeStr = (size / 1073741824).toFixed(1) + ' GB';
  }
  // Rename + delete live in a fixed-width group at the far right, after
  // the metadata columns. The ".." row gets no buttons, but the empty
  // group keeps its width so the size/date columns stay aligned.
  row.dataset.type = type;
  if (dirLink) { row.dataset.dirlink = '1'; row.title = 'Link to a folder'; }
  row.innerHTML =
    (o && o.noActions ? '<span class="fb-ck-sp" style="width:14px;flex-shrink:0"></span>'
                      : '<input type="checkbox" class="fb-ck" tabindex="-1">') +
    '<span class="fb-ic">' + icon + '</span>' +
    '<span class="fb-nm">' + esc(name) +
      (dirLink ? '<span class="fb-lnk" title="Link to a folder">' + ic('link') + '</span>' : '') +
    '</span>' +
    '<span class="fb-sz">' + esc(sizeStr) + '</span>' +
    '<span class="fb-dt">' + esc(fbDate(mtime)) + '</span>' +
    '<span class="fb-act"></span>';
  // The action buttons carry the (remote-controlled) filename in an
  // attribute, so they are built with the DOM API: setAttribute never
  // parses markup, whatever the name contains.
  if (!(o && o.noActions)) {
    let acts = row.querySelector('.fb-act');
    for (let [cls, attr, title, glyph] of [
        ['fb-ren', 'data-fb-ren', 'Rename', 'pencil'],
        ['fb-del', 'data-fb-del', 'Delete', 'close']]) {
      let b = document.createElement('button');
      b.type = 'button'; b.className = cls;
      b.setAttribute(attr, '');
      b.title = title;
      b.setAttribute('aria-label', title + ' ' + name);
      b.appendChild(icEl(glyph));
      acts.appendChild(b);
    }
  }
  let ck = row.querySelector('.fb-ck');
  if (ck) ck.setAttribute('aria-label', 'Select ' + name);
  // The visibility pass (dotfile toggle + name filter) reads the name here.
  row.dataset.name = name;
  return row;
}

// "3 Feb 14:05" within the last ~6 months, "3 Feb 2024" beyond it —
// the same trade-off `ls -l` makes: recent files are the ones where
// the time of day disambiguates, older ones need the year.
function fbDate(mtime) {
  if (!mtime) return '';
  let d = new Date(mtime * 1000);
  if (isNaN(d.getTime())) return '';
  let recent = Math.abs(Date.now() - d.getTime()) < 15778800000;
  let mon = ['Jan','Feb','Mar','Apr','May','Jun',
             'Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  let day = String(d.getDate()).padStart(2, ' ');
  if (!recent) return day + ' ' + mon + '  ' + d.getFullYear();
  return day + ' ' + mon + ' ' + String(d.getHours()).padStart(2, '0') +
         ':' + String(d.getMinutes()).padStart(2, '0');
}

// Directories stay pinned above files in every sort mode. That's the
// convention in every file manager, and it keeps navigation stable:
// switching to size- or date-order shouldn't scatter the folders you
// are trying to click through into the middle of the list.
function sortFbEntries(entries) {
  let dir = settings.fbSortDir < 0 ? -1 : 1;
  let byName = (a, b) => {
    let x = a.name.toLowerCase(), y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  };
  // 'name' is handled by the byName branch below; anything unrecognised
  // (a settings blob from a future build, say) degrades to name order
  // rather than throwing.
  let cmp = {
    size: (a, b) => (a.size || 0) - (b.size || 0),
    mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0),
  }[settings.fbSort];
  return entries.slice().sort((a, b) => {
    let ad = fbIsDir(a) ? 0 : 1, bd = fbIsDir(b) ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (!cmp) return byName(a, b) * dir;
    // Ties broken by name ascending regardless of `dir`, so equal sizes
    // or identical mtimes (common — a tarball unpacked in one second)
    // still come out in a stable, readable order.
    return cmp(a, b) * dir || byName(a, b);
  });
}

function setFbSort(key) {
  // Clicking the active column flips direction; switching column starts
  // from the direction that's useful for it — Z-to-A is never what you
  // want from a name, newest/largest usually is.
  if (settings.fbSort === key) settings.fbSortDir = -settings.fbSortDir;
  else { settings.fbSort = key; settings.fbSortDir = key === 'name' ? 1 : -1; }
  saveSettings();
  syncFbSortUi();
  // Sorting is a reorder of rows already on screen - no roundtrip. It
  // used to re-fetch the directory, which destroyed an open rename
  // editor (and its typed text) and, offline, replaced a good listing
  // with "Failed to load". The row NODES are moved, so an open editor
  // or an armed delete confirmation survives the reorder.
  if (!reorderFbRows()) reloadFbDir();
}

function reorderFbRows() {
  let list = $('fbList');
  if (!list || !_fbEntries) return false;
  let byName = new Map();
  for (let row of list.querySelectorAll('.fb-row')) {
    if (row.dataset.parent !== '1') byName.set(row.dataset.name, row);
  }
  let parent = list.querySelector('.fb-row[data-parent="1"]');
  let anchor = parent ? parent.nextSibling : list.firstChild;
  for (let e of sortFbEntries(_fbEntries)) {
    let row = byName.get(e.name);
    if (!row) continue;
    list.insertBefore(row, anchor);
    anchor = row.nextSibling;
  }
  return true;
}

// Paint the active column and its arrow. Called on open as well as on
// change, so a browser reopened in a later session shows the choice
// that was persisted to settings.
function syncFbSortUi() {
  let arrow = settings.fbSortDir < 0 ? '↓' : '↑';
  for (let key of ['name', 'size', 'mtime']) {
    let b = $('fbSort-' + key);
    if (!b) continue;
    let active = settings.fbSort === key;
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.textContent = b.getAttribute('data-label') + (active ? ' ' + arrow : '');
  }
}

// Two-step confirm, inline in the row. A nested modal would have to
// fight the file browser's own focus trap for Escape and Tab, and a
// window.confirm() blocks the SSE pump; swapping the row's contents
// costs neither and keeps the target filename in front of the user.
// Both inline editors (delete confirm, rename) swap the row's innerHTML
// out and back, which drops every listener on the buttons - so every
// restore must re-wire BOTH. One helper, so neither `done()` can forget
// one: the delete editor used to re-wire only its own button, and the
// orphaned Rename click then bubbled to the row and downloaded the file.
// Everything a row's markup needs to work - called on first render AND
// after an editor (delete confirm, rename) restores the row's innerHTML,
// which recreates every element inside it without its listeners. A
// handler wired anywhere else is lost on the first Cancel.
function wireFbRow(row, fullPath, name, type) {
  wireFbDelete(row, fullPath, name, type);
  wireFbRename(row, fullPath, name, type);
  wireFbSelect(row);
}

function wireFbDelete(row, fullPath, name, type) {
  let btn = row.querySelector('[data-fb-del]');
  if (!btn) return;
  btn.addEventListener('click', ev => {
    // Without this the row's own handler would start a download of the
    // very file we are asking about.
    ev.stopPropagation();
    askFbDelete(row, fullPath, name, type);
  });
}

function askFbDelete(row, fullPath, name, type) {
  if (row.classList.contains('fb-confirm')) return;
  cancelFbConfirm();
  let restore = row.innerHTML;
  row.classList.add('fb-confirm');
  // Say what kind of thing is about to go. A folder is removed only
  // when empty (rmdir, never recursive) - say that up front instead of
  // letting the user find out from an error.
  let what = type === 'd' ? 'folder ' : type === 'l' ? 'link ' : '';
  let note = type === 'd' ? ' <span class="fb-cf-note">(only if empty)</span>' : '';
  row.innerHTML =
    '<span class="fb-cf-q">Delete ' + what + '<b>' + esc(name) + '</b>?' + note + '</span>' +
    '<button type="button" class="fb-cf-no">Cancel</button>' +
    '<button type="button" class="fb-cf-yes">Delete</button>';
  let done = () => {
    // Only pull focus back if it was inside this editor - an editor
    // closed because the user started one on another row must not
    // yank focus away from where they now are.
    let hadFocus = row.contains(document.activeElement);
    _fbConfirm = null;
    row.classList.remove('fb-confirm');
    row.innerHTML = restore;
    wireFbRow(row, fullPath, name, type);
    applyFbVisibility();
    // The focused Cancel button was just destroyed; without this, focus
    // fell to <body> and the next Tab restarted at the top of the modal.
    if (hadFocus) { let b = row.querySelector('[data-fb-del]'); if (b) b.focus(); }
  };
  _fbConfirm = done;
  row.querySelector('.fb-cf-no').addEventListener('click', ev => {
    ev.stopPropagation(); done();
  });
  row.querySelector('.fb-cf-yes').addEventListener('click', ev => {
    ev.stopPropagation();
    _fbConfirm = null;
    doFbDelete(row, fullPath, name, done, type);
  });
  // The button that opened this strip was just destroyed by the
  // innerHTML swap, so a keyboard user's focus would fall to <body> and
  // Tab would restart from the top of the modal. Land it on Cancel —
  // the safe half of the choice.
  try { row.querySelector('.fb-cf-no').focus(); } catch (e) {}
}

function fbKindLabel(type) {
  return type === 'd' ? 'folder ' : type === 'l' ? 'link ' : '';
}

function doFbDelete(row, fullPath, name, undo, type) {
  let p = fbSessionForAction();
  if (!p) return;
  row.innerHTML = '<span class="fb-cf-q">Deleting ' + esc(name) + '…</span>';
  api('rm', {body: {session_id: p.sid, path: fullPath}})
    .then(r => {
      if (r && r.error) throw new Error(r.error);
      showToast((r && r.already_gone ? 'Already deleted: ' : 'Deleted ') +
                fbKindLabel(type) + name, 'ok');
      // Re-list rather than dropping the row locally: the directory may
      // have changed for other reasons, and a delete already costs one
      // roundtrip.
      reloadFbDir();
    })
    .catch(e => {
      showToast('Delete failed: ' + (e.message || 'error'), 'err');
      undo();
    });
}

// ── File browser: dotfile toggle + name filter ──────────────────────
// Both are pure client-side view state layered on the already-fetched
// rows: no roundtrip, so typing in the filter or flipping "Hidden" is
// instant even on a directory of hundreds of entries.
function applyFbVisibility() {
  let list = $('fbList'); if (!list) return;
  let fInp = $('fbFilter');
  let filt = (fInp && fInp.value || '').trim().toLowerCase();
  let showHidden = !!settings.fbShowHidden;
  let total = 0, shown = 0;
  for (let row of list.querySelectorAll('.fb-row')) {
    if (row.dataset.parent === '1') { row.classList.remove('fb-hide'); continue; }
    total++;
    // An open editor or an ARMED DELETE CONFIRMATION is always shown:
    // hiding a pending destructive question (by typing in the filter or
    // flipping Hidden) left it answerable by the next blind Escape.
    if (row.classList.contains('fb-edit') ||
        row.classList.contains('fb-confirm')) {
      row.classList.remove('fb-hide'); shown++; continue;
    }
    let name = row.dataset.name || '';
    let hideDot = !showHidden && name.charAt(0) === '.';
    let hideFilt = filt && name.toLowerCase().indexOf(filt) < 0;
    row.classList.toggle('fb-hide', !!(hideDot || hideFilt));
    if (!(hideDot || hideFilt)) shown++;
  }
  // A directory with entries but nothing visible must not look empty.
  let note = $('fbNoMatch');
  if (total && !shown) {
    if (!note) {
      note = document.createElement('div');
      note.id = 'fbNoMatch'; note.className = 'fb-msg';
      list.appendChild(note);
    }
    note.textContent = filt ? 'No matches for “' + filt + '”'
                            : 'Only hidden files here — toggle Hidden to show them';
  } else if (note) {
    note.remove();
  }
  // Rows just hidden by the filter drop out of the selection: the strip
  // must never count something the user can no longer see.
  syncFbSel();
}
function applyFbFilter() { applyFbVisibility(); }

function toggleFbHidden() {
  settings.fbShowHidden = !settings.fbShowHidden;
  saveSettings();
  syncFbHiddenUi();
  applyFbVisibility();
}
function syncFbHiddenUi() {
  let b = $('fbHidden'); if (!b) return;
  let on = !!settings.fbShowHidden;
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? 'Hide dotfiles' : 'Show dotfiles';
}

// ── File browser: rename (mv) ───────────────────────────────────────
function wireFbRename(row, fullPath, name, type) {
  let btn = row.querySelector('[data-fb-ren]');
  if (!btn) return;
  btn.addEventListener('click', ev => {
    ev.stopPropagation();               // don't navigate/download the row
    askFbRename(row, fullPath, name, type);
  });
}

function askFbRename(row, fullPath, name, type) {
  if (row.classList.contains('fb-edit')) return;
  cancelFbConfirm();                    // close any other open editor
  let restore = row.innerHTML;
  let icon = ic(type === 'd' ? 'folder' : type === 'l' ? 'link' : 'file');
  row.classList.add('fb-edit');
  row.innerHTML =
    '<span class="fb-ic">' + icon + '</span>' +
    '<input type="text" class="fb-ed-inp" aria-label="New name">' +
    '<button type="button" class="fb-ed-no">Cancel</button>' +
    '<button type="button" class="fb-ed-ok">Save</button>';
  let inp = row.querySelector('.fb-ed-inp');
  inp.value = name;
  let done = () => {
    let hadFocus = row.contains(document.activeElement);
    _fbConfirm = null;
    row.classList.remove('fb-edit');
    row.innerHTML = restore;
    wireFbRow(row, fullPath, name, type);
    applyFbVisibility();
    if (hadFocus) { let b = row.querySelector('[data-fb-ren]'); if (b) b.focus(); }
  };
  _fbConfirm = done;
  let commit = () => {
    let next = inp.value.trim();
    // Nothing to do if the name is empty or unchanged.
    if (!next || next === name) { done(); return; }
    if (next.indexOf('/') >= 0) {
      showToast('Name cannot contain "/"', 'err'); return;
    }
    doFbRename(row, fullPath, next, done, type);
  };
  row.querySelector('.fb-ed-no').addEventListener('click', ev => {
    ev.stopPropagation(); done();
  });
  row.querySelector('.fb-ed-ok').addEventListener('click', ev => {
    ev.stopPropagation(); commit();
  });
  inp.addEventListener('keydown', ev => {
    ev.stopPropagation();               // keep Escape/Enter out of the modal trap
    if (ev.key === 'Enter') commit();
    else if (ev.key === 'Escape') done();
  });
  // Select the basename (name minus extension) so a quick retype keeps
  // the suffix — the common case is fixing the stem, not the ".txt".
  try {
    inp.focus();
    let dot = name.lastIndexOf('.');
    inp.setSelectionRange(0, dot > 0 ? dot : name.length);
  } catch (e) {}
}

function doFbRename(row, fullPath, newName, undo, type) {
  let p = fbSessionForAction();
  if (!p) return;
  row.innerHTML = '<span class="fb-cf-q">Renaming…</span>';
  api('mv', {body: {session_id: p.sid, path: fullPath, name: newName}})
    .then(r => {
      if (r && r.error) throw new Error(r.error);
      showToast('Renamed ' + fbKindLabel(type) + 'to ' + newName, 'ok');
      reloadFbDir();
    })
    .catch(e => {
      showToast('Rename failed: ' + (e.message || 'error'), 'err');
      undo();
    });
}

// ── File browser: selecting several entries ─────────────────────────
// Names (not paths) of the picked entries in the directory on screen.
// A fresh listing always starts empty: a name that survived a navigation
// or a delete would point at a different file.
let _fbSel = new Set();
let _fbSelAnchor = null;        // last row toggled, for shift-range picks

function fbClearSel() {
  _fbSel.clear();
  _fbSelAnchor = null;
  syncFbSel();
}

function fbVisibleRows() {
  let list = $('fbList');
  if (!list) return [];
  return Array.from(list.querySelectorAll('.fb-row'))
    .filter(r => r.dataset.parent !== '1' && !r.classList.contains('fb-hide'));
}

// One place decides what the checkboxes, the row tint and the action
// strip say, so they cannot drift apart.
function syncFbSel() {
  let list = $('fbList'), bar = $('fbSel');
  if (!list || !bar) return;
  // Drop names that are no longer on screen (filtered out, or gone from
  // the listing) - acting on them would act on something unseen.
  let onScreen = new Set(fbVisibleRows().map(r => r.dataset.name));
  for (let n of Array.from(_fbSel)) if (!onScreen.has(n)) _fbSel.delete(n);
  for (let row of list.querySelectorAll('.fb-row')) {
    let picked = _fbSel.has(row.dataset.name) && row.dataset.parent !== '1';
    row.classList.toggle('fb-picked', picked);
    let ck = row.querySelector('.fb-ck');
    if (ck) ck.checked = picked;
  }
  list.classList.toggle('has-sel', _fbSel.size > 0);
  bar.classList.toggle('h', _fbSel.size === 0);
  if (!_fbSel.size) return;
  let files = 0, dirs = 0;
  for (let row of fbVisibleRows()) {
    if (!_fbSel.has(row.dataset.name)) continue;
    if (fbRowIsDir(row)) dirs++; else files++;
  }
  let parts = [];
  if (files) parts.push(files + (files === 1 ? ' file' : ' files'));
  if (dirs) parts.push(dirs + (dirs === 1 ? ' folder' : ' folders'));
  $('fbSelN').textContent = parts.join(', ') + ' selected';
  let acts = $('fbSelActs');
  acts.innerHTML = '';
  // Folders are not downloadable (the transfer streams one file), so the
  // button is offered only when there is something it can act on.
  if (files) fbSelButton(acts, 'fb-sel-go', 'Download', fbBulkDownload);
  fbSelButton(acts, 'fb-sel-del', 'Delete', fbAskBulkDelete);
  fbSelButton(acts, '', 'Clear', fbClearSel);
}

function fbSelButton(acts, cls, label, fn) {
  let b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = label;
  b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
  acts.appendChild(b);
  return b;
}

// Shift-click picks the run between the last toggled row and this one -
// the behaviour every file manager has, and the only bearable way to
// pick forty files.
function fbToggleRow(row, shiftKey) {
  let rows = fbVisibleRows();
  let name = row.dataset.name;
  if (shiftKey && _fbSelAnchor !== null) {
    let a = rows.findIndex(r => r.dataset.name === _fbSelAnchor);
    let b = rows.indexOf(row);
    if (a >= 0 && b >= 0) {
      let [lo, hi] = a <= b ? [a, b] : [b, a];
      let want = !_fbSel.has(name);
      for (let i = lo; i <= hi; i++) {
        if (want) _fbSel.add(rows[i].dataset.name);
        else _fbSel.delete(rows[i].dataset.name);
      }
      _fbSelAnchor = name;
      syncFbSel();
      return;
    }
  }
  if (_fbSel.has(name)) _fbSel.delete(name); else _fbSel.add(name);
  _fbSelAnchor = name;
  syncFbSel();
}

function wireFbSelect(row) {
  let ck = row.querySelector('.fb-ck');
  if (!ck) return;
  // The row's own click navigates or downloads; the checkbox must not.
  // No preventDefault here: a checkbox is toggled BEFORE its click event,
  // and preventing the default reverts it after the handler has run - so
  // the box that syncFbSel had just ticked went blank again (visible on a
  // shift-range pick). Let the native toggle stand; syncFbSel then writes
  // the authoritative state onto every box.
  ck.addEventListener('click', ev => {
    ev.stopPropagation();
    fbToggleRow(row, ev.shiftKey);
  });
  ck.addEventListener('keydown', ev => {
    if (ev.key !== ' ' && ev.key !== 'Enter') return;
    ev.preventDefault();
    ev.stopPropagation();
    fbToggleRow(row, ev.shiftKey);
  });
}

// The absolute paths of the selected rows, in the order they appear.
function fbSelected(kind) {
  let dir = _fbCurPath;
  return fbVisibleRows()
    .filter(r => _fbSel.has(r.dataset.name))
    .filter(r => !kind || (kind === 'f' ? !fbRowIsDir(r) : fbRowIsDir(r)))
    .map(r => ({name: r.dataset.name, type: r.dataset.type, row: r,
                path: (dir === '/' ? '' : dir) + '/' + r.dataset.name}));
}

// ── Bulk delete ─────────────────────────────────────────────────────
// One question for the whole batch, then one rm per entry: each delete
// stays a separate, individually audited side-channel call, and a
// failure in the middle names the entry that failed.
function fbAskBulkDelete() {
  let items = fbSelected();
  if (!items.length) return;
  let dirs = items.filter(i => i.type === 'd').length;
  let bar = $('fbSel');
  $('fbSelN').textContent = 'Delete ' + items.length +
    (items.length === 1 ? ' item' : ' items') + '?' +
    (dirs ? ' (folders only if empty)' : '');
  let acts = $('fbSelActs');
  acts.innerHTML = '';
  fbSelButton(acts, '', 'Cancel', syncFbSel);
  let go = fbSelButton(acts, 'fb-sel-del armed', 'Delete ' + items.length,
                       () => fbBulkDelete(items));
  try { go.focus(); } catch (e) {}
  bar.classList.remove('h');
}

function fbBulkDelete(items) {
  let p = fbSessionForAction();
  if (!p) return;
  let sid = p.sid;
  $('fbSelActs').innerHTML = '';
  let done = 0, failed = [];
  let step = () => {
    if (done >= items.length) return Promise.resolve();
    let it = items[done];
    $('fbSelN').textContent = 'Deleting ' + (done + 1) + '/' + items.length +
                              ' — ' + it.name;
    return api('rm', {body: {session_id: sid, path: it.path}})
      .then(r => {
        if (r && r.error) {
          // The side-channel rate limit is the one failure that makes
          // continuing pointless: stop and say so.
          if (r.code === 'rate_limited' || /rate.?limit/i.test(r.error)) {
            throw new Error('rate_limited');
          }
          failed.push(it.name + ': ' + r.error);
        }
        done++;
        return step();
      });
  };
  step()
    .catch(e => {
      if (e && e.message === 'rate_limited') {
        showToast('Too many requests — deleted ' + done + ' of ' + items.length +
                  ', try the rest in a moment.', 'warn');
      } else {
        failed.push(e && e.message ? e.message : 'error');
      }
    })
    .then(() => {
      let ok = done - failed.length;
      if (failed.length) {
        showToast('Deleted ' + ok + ' of ' + items.length + ' — ' + failed[0] +
                  (failed.length > 1 ? ' (+' + (failed.length - 1) + ' more)' : ''), 'err');
      } else if (ok) {
        showToast('Deleted ' + ok + (ok === 1 ? ' item' : ' items'), 'ok');
      }
      fbClearSel();
      reloadFbDir();
    });
}

// ── Bulk download ───────────────────────────────────────────────────
// Strictly one at a time: a pane carries one transfer, and the browser
// stays open so the queue's progress is visible.
function fbBulkDownload() {
  let items = fbSelected('f');
  if (!items.length) return;
  let p = fbSessionForAction();
  if (!p) return;
  let why = uploadBlocker(p);
  if (why && /already running/.test(why)) { showToast(why, 'warn'); return; }
  let skipped = fbSelected().length - items.length;
  if (skipped) showToast('Folders can’t be downloaded — skipping ' + skipped + '.', 'warn');
  let id = p.id, done = 0, stopped = null;
  let step = () => {
    if (done >= items.length || stopped) return Promise.resolve();
    let it = items[done];
    $('fbSelN').textContent = 'Downloading ' + (done + 1) + '/' + items.length +
                              ' — ' + it.name;
    // startFastDownload resolves once the pane's slot is free again; a
    // short settle keeps the queue moving instead of showing each
    // "Download complete" for two seconds.
    return startFastDownload(id, it.path, {settleDelay: 250})
      .then(ok => {
        if (!ok) { stopped = it.name; return; }
        done++;
        return step();
      });
  };
  step().then(() => {
    if (stopped) {
      showToast('Stopped at ' + stopped + ' — downloaded ' + done +
                ' of ' + items.length + '.', 'err');
    } else {
      showToast('Downloaded ' + done + (done === 1 ? ' file' : ' files'), 'ok');
    }
    fbClearSel();
  });
}

// ── File browser: upload into the directory on screen ───────────────
// Until the server learned to take a destination, an upload always
// landed wherever the shell happened to be standing - so the folder the
// user had just navigated to in the browser was the one place they
// could not send a file to.

// Why this browser can't take an upload right now, or '' when it can.
function fbUploadBlocker() {
  let p = _fbId && panes[_fbId];
  if (!p || !p.sid) return 'This pane is not connected.';
  // Never upload into a path we are not sure of: the rows (and _fbCurPath)
  // must belong to the session we are about to send the file through.
  if (!_fbCurPath || p.sid !== _fbListedSid) return 'The listing is still loading.';
  return uploadBlocker(p);
}

function fbUploadHere() {
  let why = fbUploadBlocker();
  if (why) { showToast(why, 'warn'); return; }
  let inp = $('fbUploadInput');
  if (inp) inp.click();
}

function fbHandleUpload(input) {
  let files = Array.prototype.slice.call(input.files || []);
  input.value = '';
  fbStartUpload(files);
}

function fbStartUpload(files) {
  if (!files.length) return;
  let why = fbUploadBlocker();
  if (why) { showToast(why, 'warn'); return; }
  // showUploadProgress (inside startUploadFiles) paints the strip.
  startUploadFiles(_fbId, files, {destDir: _fbCurPath});
}

function fbCancelXfer() {
  if (_fbId) cancelTransfer(_fbId);
}

// The pane's own progress bar is behind this modal, so mirror it into
// the browser's footer while the browser is the thing the user is
// looking at. Reads the pane's bar rather than keeping a second copy of
// the state, so the two can't disagree.
function paintFbXfer(p) {
  let el = $('fbXfer');
  if (!el) return;
  let open = _fbId && p && p.id === _fbId && !$('fbOv').classList.contains('h');
  let src = open && p.el && p.el.querySelector('[data-upload-progress]');
  if (!src || src.classList.contains('h')) { el.classList.add('h'); return; }
  let bar = src.querySelector('.upload-progress-bar');
  let mine = el.querySelector('.fb-xfer-bar');
  mine.style.width = bar.style.width;
  mine.style.background = bar.style.background || '';
  el.querySelector('.fb-xfer-text').textContent =
    src.querySelector('.upload-progress-text').textContent;
  el.classList.remove('h');
}

function wireFbDrop() {
  let el = document.querySelector('#fbOv .fb-panel');
  if (!el) return;
  let msg = () => 'Drop to upload to ' + (_fbCurPath || 'this folder');
  el.addEventListener('dragenter', ev => {
    if (!_dragHasFiles(ev)) return;
    ev.preventDefault();
    showDropTargetOn(el, fbUploadBlocker(), msg());
  });
  el.addEventListener('dragover', ev => {
    if (!_dragHasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = fbUploadBlocker() ? 'none' : 'copy';
    showDropTargetOn(el, fbUploadBlocker(), msg());
  });
  el.addEventListener('dragleave', ev => {
    if (!_dragHasFiles(ev)) return;
    if (ev.relatedTarget && el.contains(ev.relatedTarget)) return;
    hideDropTarget(el);
  });
  el.addEventListener('drop', ev => {
    if (!_dragHasFiles(ev)) return;
    // Stop here: the document-level handler would otherwise tell the user
    // to drop onto a pane, about a drop that just worked.
    ev.preventDefault();
    ev.stopPropagation();
    clearAllDropTargets();
    let why = fbUploadBlocker();
    if (why) { showToast(why, 'warn'); return; }
    fbStartUpload(droppedFiles(ev));
  });
}

// The panel exists before this script runs (scripts are at the end of
// the body), but guard anyway so load-order changes can't silently drop
// the browser's drop zone.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireFbDrop);
} else {
  wireFbDrop();
}

// ── File browser: new folder (mkdir) ────────────────────────────────
// An editor row inserted at the top of the list, above the entries.
function fbNewFolder() {
  let list = $('fbList');
  if (!list || !_fbCurPath) return;
  cancelFbConfirm();
  let row = document.createElement('div');
  row.className = 'fb-row fb-edit';
  row.innerHTML =
    '<span class="fb-ic">' + ic('folder') + '</span>' +
    '<input type="text" class="fb-ed-inp" placeholder="Folder name" aria-label="Folder name">' +
    '<button type="button" class="fb-ed-no">Cancel</button>' +
    '<button type="button" class="fb-ed-ok">Create</button>';
  // Above everything, including "..", so it's where the eye already is.
  list.insertBefore(row, list.firstChild);
  let inp = row.querySelector('.fb-ed-inp');
  let done = () => {
    let hadFocus = row.contains(document.activeElement);
    _fbConfirm = null;
    if (row.parentNode) row.parentNode.removeChild(row);
    if (hadFocus) {
      let b = document.querySelector('.fb-tool[onclick^="fbNewFolder"]');
      if (b) b.focus();
    }
  };
  _fbConfirm = done;
  let commit = () => {
    let name = inp.value.trim();
    if (!name) { done(); return; }
    if (name.indexOf('/') >= 0) {
      showToast('Name cannot contain "/"', 'err'); return;
    }
    doFbMkdir(row, name, done);
  };
  row.querySelector('.fb-ed-no').addEventListener('click', ev => {
    ev.stopPropagation(); done();
  });
  row.querySelector('.fb-ed-ok').addEventListener('click', ev => {
    ev.stopPropagation(); commit();
  });
  inp.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit();
    else if (ev.key === 'Escape') done();
  });
  try { inp.focus(); } catch (e) {}
}

function doFbMkdir(row, name, undo) {
  let p = fbSessionForAction();
  if (!p) return;
  // Join onto the current directory; avoid a double slash at the root.
  let base = _fbCurPath === '/' ? '' : _fbCurPath;
  let full = base + '/' + name;
  row.innerHTML = '<span class="fb-ic">' + ic('folder') + '</span>' +
                  '<span class="fb-cf-q">Creating…</span>';
  api('mkdir', {body: {session_id: p.sid, path: full}})
    .then(r => {
      if (r && r.error) throw new Error(r.error);
      showToast('Created folder ' + name, 'ok');
      reloadFbDir();
    })
    .catch(e => {
      showToast('Create failed: ' + (e.message || 'error'), 'err');
      undo();
    });
}

function fbDownloadManual() {
  let id = _fbId;
  let path = $('fbManual').value.trim();
  if (!path || !id) return;
  closeFb();
  startFastDownload(id, path);
}

// ── Search ──────────────────────────────────────────────────────────
// Passing `decorations` to findNext/findPrevious is what engages
// highlight-all (every match in the SearchAddon's highlightLimit window
// gets painted, not just the current one). Without it, only the active
// match is rendered — and the PR-description perf note about
// highlightLimit defends a code path the addon never takes.
const SEARCH_OPTS = {decorations: Object.assign({}, THEMES.dark.search)};
function activeSearch() { let p=panes[activeId]; return p?p.searchAddon:null }
function toggleSearch() {
  let p=panes[activeId]; if(!p) return;
  let bar=p.el.querySelector('[data-search]');
  if(bar.classList.contains('h')){bar.classList.remove('h');bar.querySelector('input').focus()}
  else closeSearch();
}
function closeSearch(){
  let p=panes[activeId]; if(!p) return;
  p.el.querySelector('[data-search]').classList.add('h');
  p.searchAddon.clearDecorations(); p.term.focus();
}
function searchNext(){ let s=activeSearch(); if(s){let p=panes[activeId];s.findNext(p.el.querySelector('[data-search] input').value, SEARCH_OPTS)} }
function searchPrev(){ let s=activeSearch(); if(s){let p=panes[activeId];s.findPrevious(p.el.querySelector('[data-search] input').value, SEARCH_OPTS)} }

// Search input events — delegated
document.addEventListener('keydown', e => {
  if(e.target && e.target.closest && e.target.closest('[data-search]')){
    if(e.key==='Enter'){e.shiftKey?searchPrev():searchNext()}
    if(e.key==='Escape') closeSearch();
  }
});

// ── Zoom ────────────────────────────────────────────────────────────
// Hotkey zoom uses forceFlush:false so a held-key autorepeat (~30Hz)
// doesn't fire one /api/resize POST per tick. The 150ms term.onResize
// debounce coalesces the burst — 30 keystrokes → 1 POST 150ms after
// release. Trade-off: the server learns the new size 150ms late, so
// any shell output during that window may be wrapped at the old cols.
// On a quiet terminal this is invisible; on a streaming command (top,
// tail -f) the user sees one stale row. Acceptable for a hotkey burst
// that, by definition, the user is mid-tweaking anyway.
function zoomIn(){ settings.fontSize=Math.min(settings.fontSize+2,32); fontSize=settings.fontSize; saveSettings(); applySettings({forceFlush:false}); }
function zoomOut(){ settings.fontSize=Math.max(settings.fontSize-2,8); fontSize=settings.fontSize; saveSettings(); applySettings({forceFlush:false}); }
// Cancel any pending /api/resize debounce and post the current xterm
// dimensions to the server immediately. Used after a programmatic
// refit when we want the server to learn the new geometry without the
// 150ms debounce window in term.onResize.
//
// Dedup guard: skip the POST when (cols,rows) matches the last value
// the server has confirmed receiving. Two real cases hit this:
//   - fitPaneWhenStable iterates the settle loop up to 8 times — once
//     cols stops changing the final flushPaneResize would re-POST the
//     same value the last successful iteration already sent.
//   - held Ctrl+= autorepeat past the fontSize cap (32) — fontSize
//     stops changing, dims stop changing, every additional keystroke
//     would otherwise re-POST the same value 30 times/sec.
//
// Commit-on-success: lastSentCols/Rows are updated only after the POST
// resolves cleanly. Network failure (rejection), business error (e.g.
// 404 session not found), or any non-JSON response leaves lastSent
// untouched, so the next refit will retry against the actual server
// state. Without this discipline, a swallowed POST failure silently
// desynced client and server until the user happened to resize to a
// DIFFERENT value — exactly the right-edge-overflow class of bug
// commit 7738ed1 was meant to eliminate.
function flushPaneResize(p) {
  if (!p || !p.sid) return;
  let cols = p.term.cols, rows = p.term.rows;
  if (p.lastSentCols === cols && p.lastSentRows === rows) return;
  if (p.resizeTimer) { clearTimeout(p.resizeTimer); p.resizeTimer = null; }
  api('resize', {body: {session_id: p.sid, cols: cols, rows: rows}})
    .then(r => {
      if (r && r.error) return;
      p.lastSentCols = cols;
      p.lastSentRows = rows;
    })
    .catch(() => { /* leave lastSent alone so the next refit retries */ });
}

// applySettings(opts):
//   forceFlush=true  (default — discrete user intent: zoom hotkey,
//                     reset, font select)  → bypass term.onResize
//                     150ms debounce, post /api/resize immediately.
//   forceFlush=false (continuous input: slider drag in Options)
//                     → let the existing term.onResize debounce
//                     coalesce a burst of mutations into one POST.
//
// Why the RAF: xterm v5's CharSizeService measures cell width
// synchronously when fontSize changes (offsetWidth forces a layout),
// so xterm itself is not the cause of stale cols. The bug we fix is
// (a) webfont rasterisation lag — for a webfont not yet rendered at
// the new size, the glyph metric the browser hands to xterm can lag
// the visible glyph by one frame; and (b) applySettings mutates five
// options back-to-back (fontSize, fontWeight, fontWeightBold,
// lineHeight, fontFamily) and each one re-fires the measure cascade.
// One animation frame after the last mutation, layout has settled and
// the webfont is laid out at its new size, so fit() reads stable
// metrics and proposeDimensions returns the correct cols.
function applySettings(opts){
  opts = opts || {};
  let forceFlush = opts.forceFlush !== false;
  ensureFontLink(settings.font);
  Object.keys(panes).forEach(k => {
    let p = panes[k];
    // A pane in a hidden tab gets the new font when its tab is shown
    // (showTab -> applyTermSettings): xterm measures the cell on every
    // font change, and in a display:none box that measures nothing.
    if (paneHidden(p)) { p._fitDeferred = true; return; }
    applyTermSettings(p);
    // Single fit path: the settle loop inside fitPaneWhenStable does
    // both the font-load wait AND the multi-frame convergence check,
    // replacing the old "immediate-RAF fit AND a deferred refit after
    // document.fonts.load" pair that was racing.
    fitPaneWhenStable(p, { flush: forceFlush });
  });
}
// The display settings onto one terminal. Setting an unchanged value is
// a no-op in xterm (its option setter compares), so this is cheap to
// repeat.
function applyTermSettings(p) {
  let t = p && p.term;
  if (!t || !t.options) return;
  let stack = fontStack(settings.font);
  t.options.fontSize = settings.fontSize;
  t.options.fontWeight = settings.fontWeight;
  t.options.fontWeightBold = Math.min(900, settings.fontWeight + 300);
  t.options.lineHeight = settings.lineHeight;
  if (t.options.fontFamily !== stack) t.options.fontFamily = stack;
}
// Refit a pane with a font-load gate and a settle loop.
//
// Why a settle loop (not just one RAF deferral): the previous version
// did `document.fonts.load → fontFamily round-trip → 1 × RAF → fit`.
// That works most of the time, but on slow renderers (low-end mobile,
// throttled background tabs, or parallel font-face loads) the cycle
// `JS → style recalc → layout → paint` does not always complete in
// one animation frame. `document.fonts.load(...)` resolves once the
// FontFace is registered, NOT once it has been applied to the
// measurement <span> xterm uses for CharSizeService — that
// application happens on the next style/layout pass. Result: fit
// reads a cell-width that was computed with the fallback font, cols
// is wrong, glyphs render with the (wider) webfont and overflow the
// pane on the right, selection drifts by one cell. The only reliable
// signal we have for "the cell-width xterm now caches is the one it
// will use to render" is: two consecutive fits return the same cols.
// So we iterate fit-once-per-RAF until cols stabilises (or hit a
// safety cap of 8 attempts — at most ~130 ms total, imperceptible).
// Callbacks waiting for the pane's in-flight fit to finish. Every exit
// of a fit - settled, aborted, font load failed, or the 10 s stuck
// timer - drains this, so a caller's onSettled is never lost. It used
// to be: a second call while a fit was running returned early and
// dropped its onSettled, and kickPanesAfterAbsence only reopens the SSE
// stream from that callback - so a tab brought back while the 1 s drift
// watchdog (or a hung font load) held the flag stayed frozen.
function _drainPendingSettled(p) {
  let q = p._pendingSettled;
  if (!q || !q.length) return;
  p._pendingSettled = [];
  if (panes[p.id] !== p) return;          // pane gone: nothing to resume
  q.forEach(cb => { try { cb(p); } catch (e) { console.error(e); } });
}

function fitPaneWhenStable(p, opts){
  if (!p || !panes[p.id] || !p.fitAddon) return;
  let onSettled = (opts && opts.onSettled) || null;
  if (onSettled) (p._pendingSettled = p._pendingSettled || []).push(onSettled);
  // A pane in a hidden tab has no box to fit to (see ── Tabs): skip the
  // fit and the resize, mark it for showTab(), and still resume whoever
  // was waiting - the absence kick restarts output from onSettled, and
  // a hidden tab's panes need that as much as visible ones.
  if (!p._fitInFlight && paneHidden(p)) {
    p._fitDeferred = true;
    _drainPendingSettled(p);
    return;
  }
  // Re-entry guard: settle-loop forceMeasure() and the fontFamily
  // round-trip both cause xterm to fire its own change events. If a
  // second fitPaneWhenStable call races in before the first finishes
  // (watchdog tick, settings change, any future event-driven caller),
  // they pile up async Promises that each trigger the same xterm
  // chain, exponentially saturating the event loop. Skip cleanly —
  // the in-flight call will land on the latest values anyway.
  if (p._fitInFlight) return;             // queued above; drained on its exit
  p._fitInFlight = true;
  // Identity of THIS fit. The stuck timer can clear the flag and a new
  // fit can set it again while this one's promise chain is still
  // pending; the token keeps the old chain from acting as the owner.
  let token = {};
  p._fitToken = token;
  // Stuck-timer safety. If the font load hangs (CDN unreachable,
  // captive portal, document.fonts.ready waiting on an unrelated
  // never-completing face) the flag would stay true forever and every
  // subsequent fitPaneWhenStable call — including the 1 s watchdog —
  // would silently bail. After 10 s, force-release the flag; the
  // settle-loop checks p._fitInFlight at every iteration and exits
  // cleanly if the timer fired mid-flight (no double-fit, no leak).
  // Store the handle on `p` so _destroyPane can cancel it. Without that,
  // a pane closed mid-settle keeps the timer's closure-captured `p`
  // alive for up to 10 s.
  let stuckTimer = setTimeout(() => {
    if (p._fitToken === token) { p._fitInFlight = false; p._fitToken = null; }
    p._stuckTimer = null;
    _drainPendingSettled(p);
  }, 10000);
  p._stuckTimer = stuckTimer;
  let shouldFlush = !opts || opts.flush !== false;
  let owns = () => p._fitInFlight && p._fitToken === token && panes[p.id] === p;
  let release = () => {
    clearTimeout(stuckTimer);
    if (p._stuckTimer === stuckTimer) p._stuckTimer = null;
    if (p._fitToken === token) { p._fitInFlight = false; p._fitToken = null; }
  };
  // Aborted exits still resume whoever was waiting (the stream restart
  // matters more than a perfect fit).
  let abort = () => { release(); _drainPendingSettled(p); };
  let f = FONTS[settings.font];
  let webfont = f && f[1];
  // `document.fonts.load(spec)` actively triggers the load AND resolves
  // when that face is registered. Chaining `document.fonts.ready` adds
  // a global "all currently-loading fonts done" gate — needed because
  // load(spec) resolves before the FontFace is applied to any laid-out
  // <span>, and we measure via offsetWidth which depends on layout.
  let waitFont = (webfont && document.fonts && document.fonts.load)
    ? document.fonts.load(
        `${settings.fontWeight} ${settings.fontSize}px '${webfont}'`)
        .then(() => document.fonts.ready)
    : Promise.resolve();
  waitFont.then(() => {
    if (!owns()) { abort(); return; }
    // Invalidate xterm's CharSizeService cache via a no-op fontFamily
    // round-trip. xterm v5's options setter has a value-equality
    // short-circuit (`rawOptions[k] !== v && fire(k)`), so the
    // intermediate value MUST differ from the original — otherwise
    // both setters get filtered out and no re-measure happens. Pair
    // the canonical fallback families ('monospace' / 'serif') so the
    // sentinel is guaranteed to differ from the user's actual stack.
    let ff = p.term.options.fontFamily;
    let invalidator = (ff === 'monospace' ? 'serif' : 'monospace');
    p.term.options.fontFamily = invalidator;
    p.term.options.fontFamily = ff;
    // Belt-and-suspenders: directly invoke xterm's internal measurement
    // service. The options round-trip is supposed to trigger this via
    // its options-change listener, but the actual measure() reads
    // offsetWidth from a hidden <span> that must have been laid out
    // with the new font face. Calling it again from each settle
    // iteration guarantees the cached width can't pin the loop at a
    // wrong-cols fixed point.
    let forceMeasure = () => {
      try { p.term._core._charSizeService.measure(); } catch(e){}
    };
    // Settle loop: fit, observe cols, fit again next frame until two
    // consecutive iterations agree, or we hit the cap of 8 attempts
    // (~130 ms total, imperceptible).
    let attempts = 0, lastCols = -1;
    let step = () => {
      if (!owns()) { abort(); return; }
      // Its tab was hidden while this fit was settling: stop before
      // fitting to the 0x0 box; showTab() fits it again.
      if (paneHidden(p)) { p._fitDeferred = true; abort(); return; }
      forceMeasure();
      try { p.fitAddon.fit(); } catch(e){}
      let cols = p.term.cols;
      if (cols === lastCols || attempts >= 8) {
        release();
        if (shouldFlush) flushPaneResize(p);
        _drainPendingSettled(p);
        return;
      }
      lastCols = cols;
      attempts++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }).catch(() => { abort(); });
}

// Periodic drift watchdog. Even with the settle loop, edge cases can
// leave a pane with a cached cell-width that disagrees with what xterm
// actually renders: a webfont may finish loading well after every
// fit-triggering event fired, or a re-measure may have been called
// before layout applied the new font face. Once every PANE_DRIFT_*
// interval, compare what xterm thinks it can fit (cols × cellWidth)
// against the parent container's actual content area. If the visible
// glyphs overflow by more than a few sub-pixel-rounding pixels — or
// underflow by a full cell — trigger a settle-loop fit to correct it.
const PANE_DRIFT_CHECK_MS = 1000;
const PANE_DRIFT_TOLERANCE_PX = 3;
// Named so the tick can be invoked synchronously from tests against
// stubbed getComputedStyle / charSizeService. Returns true when the
// drift crossed a refit threshold (negative past tolerance, or
// positive over one cell + tolerance), false otherwise. Catches any
// xterm-internals reshuffle and bails quietly.
function _driftWatchdogTick(p) {
  if (!p || !p.term || !p.term.element || !p.term.element.parentElement) {
    return false;
  }
  if (paneHidden(p)) return false;      // 0x0 box: nothing to compare
  try {
    let cs = p.term._core && p.term._core._charSizeService;
    if (!cs || !cs.width) return false;
    let parent = p.term.element.parentElement;
    let parentCss = window.getComputedStyle(parent);
    let parentWidth = parseInt(parentCss.getPropertyValue('width'), 10);
    let elCss = window.getComputedStyle(p.term.element);
    let pad = parseInt(elCss.getPropertyValue('padding-left'), 10)
            + parseInt(elCss.getPropertyValue('padding-right'), 10);
    let available = parentWidth - pad;
    let rendered = p.term.cols * cs.width;
    let drift = available - rendered;
    // Negative drift (rendered > available) is the user-visible bug:
    // right-edge glyphs spill past the pane. Tolerate a few pixels of
    // sub-pixel rounding. Positive drift over one cell means we're
    // wasting a column of space — also worth a refit.
    if (drift < -PANE_DRIFT_TOLERANCE_PX
        || drift > cs.width + PANE_DRIFT_TOLERANCE_PX) {
      fitPaneWhenStable(p);
      return true;
    }
  } catch (e) { /* xterm internals shifted — bail quietly */ }
  return false;
}

setInterval(() => {
  // Skip when no panes are open — no panes means no terminals to fit,
  // and getComputedStyle / Object.values churn every second is silly.
  if (!Object.keys(panes).length) return;
  Object.values(panes).forEach(_driftWatchdogTick);
}, PANE_DRIFT_CHECK_MS);

// ── Options dialog ─────────────────────────────────────────────────
const OPT_PREVIEW = [
  ['c-dim','$ '],['','ls -la /usr/local/bin | head\n'],
  ['c-dim','total 248\n'],
  ['','-rwxr-xr-x 1 root root 12840 Apr 17 09:42 '],['c-green','claude\n'],
  ['','-rwxr-xr-x 1 root root  8192 Feb 11 12:30 '],['c-green','tmux\n'],
  ['c-dim','$ '],['','git log --oneline -2\n'],
  ['c-red','81e8260 '],['','tests: close HTTPServer sockets\n'],
  ['c-red','eaab909 '],['','README: polish — persistent-sessions docs\n'],
  ['c-dim','# '],['','illiI1lO0o  {} [] () <> =>  "hello" ~!@#$%^&*\n'],
  ['c-dim','# '],['','if (x === null) return obj?.value ?? 42;']
];
function renderOptPreview(){
  let el = $('optPreview'); if (!el) return;
  el.style.fontFamily = fontStack(settings.font);
  el.style.fontSize = settings.fontSize + 'px';
  el.style.fontWeight = settings.fontWeight;
  el.style.lineHeight = settings.lineHeight;
  el.textContent = '';
  for (let [cls, txt] of OPT_PREVIEW) {
    let s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = txt;
    el.appendChild(s);
  }
}
function openOptions(){
  let sel = $('optFont');
  if (sel && !sel.options.length) {
    Object.keys(FONTS).forEach(id => {
      let o = document.createElement('option');
      o.value = id; o.textContent = FONTS[id][0];
      sel.appendChild(o);
    });
  }
  sel.value = settings.font;
  $('optSize').value = settings.fontSize;
  $('optSizeVal').textContent = settings.fontSize + 'px';
  $('optLineHeight').value = settings.lineHeight;
  $('optLineHeightVal').textContent = Number(settings.lineHeight).toFixed(2);
  $('optWeight').value = settings.fontWeight;
  $('optWeightVal').textContent = settings.fontWeight;
  let cv = $('optCtrlVPaste'); if (cv) cv.checked = !!settings.ctrlVPaste;
  let cc = $('optTmuxClipboard'); if (cc) cc.checked = !!settings.tmuxClipboard;
  let ch = $('optTmuxHistory'); if (ch) ch.value = settings.tmuxHistory;
  renderSealedState();
  renderOptPreview();
  $('ovOpt').classList.remove('h');
}
function closeOptions(){ $('ovOpt').classList.add('h'); }

// ── Sign out of this browser ────────────────────────────────────────
// Permanently deletes every saved credential in this vault from the
// server and clears the key in this browser. Typed-DELETE confirm
// gate because the action is irreversible. WCAG: role=dialog +
// aria-modal in the markup; focus trap + Escape + restore-focus
// wired here. (Finding 9 in the PR-67 review.)
const _signOutTrap = makeModalTrap('signOutModal', () => closeSignOutModal());
function openSignOutModal() {
  let input = $('signOutInput');
  let confirm = $('signOutConfirm');
  let status = $('signOutStatus');
  let scope = $('signOutScope');
  if (input) input.value = '';
  if (confirm) confirm.disabled = true;
  if (status) { status.textContent = ''; status.className = 'tm-status'; }
  if (input && !input._wired) {
    input._wired = true;
    input.addEventListener('input', () => {
      let ok = input.value === 'DELETE';
      if (confirm) confirm.disabled = !ok;
    });
  }
  // Show how much this affects: count + a few names + a heads-up that
  // live saved-card panes across tabs will disconnect. The list-of-
  // names confirmation comes from the same loadSaved that confirmSignOut
  // iterates, so what we show is exactly what we'll delete.
  if (scope) {
    let list = loadSaved();
    let vaultRows = list.filter(c => c.conn_id);
    let names = vaultRows.map(c => c.name || (c.user + '@' + c.host));
    if (vaultRows.length === 0) {
      scope.textContent = 'No vault-backed cards are stored in this browser. ' +
        'Sign-out will still clear the vault key.';
    } else {
      let shown = names.slice(0, 5).join(', ');
      let more = names.length > 5 ? ', and ' + (names.length - 5) + ' more' : '';
      scope.textContent = 'This affects ' + vaultRows.length + ' saved ' +
        (vaultRows.length === 1 ? 'card' : 'cards') + ': ' + shown + more +
        '. Live sessions opened from these cards will disconnect across all tabs.';
    }
  }
  _signOutTrap.open(() => input);
}

function closeSignOutModal() {
  // Trap close restores focus to whatever opened the modal (typically
  // the "Sign out of this browser" button in the Options panel).
  _signOutTrap.close();
}

async function confirmSignOut() {
  let confirm = $('signOutConfirm');
  let status = $('signOutStatus');
  if (confirm) confirm.disabled = true;
  if (status) { status.textContent = 'Deleting saved credentials…'; status.className = 'tm-status'; }
  // Best-effort: tell the server to drop each blob in this vault. We
  // continue on per-row failure (404/network) — the local wipe still
  // happens, and the orphaned server-side blob (if any) is just a
  // namespace squat with no plaintext leak.
  //
  // Use the non-minting variant: on a fresh tab where the user clicks
  // Sign Out without ever having signed in, ensureVaultId() would MINT
  // a vault_id just to delete it on the next line, and worse —
  // _broadcastSignedOut at the end would still fire, telling sibling
  // tabs to invalidate their active vault session for nothing.
  // `preexisting` records whether there was ever anything to sign out;
  // the pane teardown / broadcast are gated on it.
  let vault_id = null;
  try { vault_id = await ensureVaultIdIfPresent(); } catch (e) {}
  let preexisting = !!vault_id;
  let list = loadSaved();
  for (let c of list) {
    if (!vault_id || !c.conn_id) continue;
    let q = '&vault_id=' + encodeURIComponent(vault_id) +
            '&conn_id='  + encodeURIComponent(c.conn_id);
    try { await api('save_delete', {query: q, body: {}}); } catch (e) {}
  }
  // Local wipe: IDB (K + vault_id), saved-card list, pane-secrets.
  try { await _idbDelete(IDB_K_KEY); } catch (e) {}
  try { await _idbDelete(IDB_VAULT_ID_KEY); } catch (e) {}
  saveSaved([]);
  try { sessionStorage.removeItem(storageKey(SS_PANE_SECRETS_KEY)); } catch (e) {}
  // Filter vault entries out of the pane manifest in localStorage.
  // Without this, an open vault-backed pane's record survives the wipe
  // and the next F5 would hit connectPane's vault branch with no key
  // → silently mint a fresh K (the original Finding 1 scenario). We
  // filter rather than nuking the whole manifest so any non-vault
  // panes (manual / named) the user had open still restore on F5.
  try {
    let raw = localStorage.getItem(storageKey(PANES_KEY));
    if (raw) {
      let m = JSON.parse(raw);
      if (m && m.panes) {
        let kept = {};
        let dropped = false;
        Object.keys(m.panes).forEach(k => {
          let rec = m.panes[k];
          if (rec && (rec.via === 'vault' || rec.conn_id)) { dropped = true; return; }
          kept[k] = rec;
        });
        if (dropped) {
          m.panes = kept;
          localStorage.setItem(storageKey(PANES_KEY), JSON.stringify(m));
        }
      }
    }
  } catch (e) {}
  // Tear down any live vault-backed panes in this tab — they're now
  // running with a key that was just wiped from disk, so the next
  // disconnect/reconnect would silently re-mint a fresh K. Only fire
  // the broadcast + tear-down when there was a vault to sign out of:
  // on the empty-vault path no panes exist and there's nothing to
  // signal sibling tabs about.
  if (preexisting) {
    _disconnectAllVaultPanesForNoKey();
    invalidateVaultCache();
    _vaultRecentlySignedOut = true;
    _broadcastSignedOut();
  }
  closeSignOutModal();
  renderSaved();
  showToast(preexisting
    ? 'Signed out. All saved credentials in this browser have been removed.'
    : 'No saved credentials in this browser to remove.', '');
}
function resetOptions(){
  let wasSealed = sealedOn();
  settings = { ...DEFAULT_SETTINGS };
  if (wasSealed) setSealed(false);
  fontSize = settings.fontSize;
  saveSettings();
  applySettings();
  openOptions();
}
function onOptInput(key, el, valEl, fmt){
  let v = key === 'lineHeight' ? parseFloat(el.value) : parseInt(el.value, 10);
  settings[key] = v;
  if (key === 'fontSize') fontSize = v;
  valEl.textContent = fmt(v);
  saveSettings();
  // Slider 'input' fires per pixel of mouse movement — let the existing
  // 150ms term.onResize debounce coalesce the burst into a single
  // /api/resize POST instead of force-flushing on every step.
  applySettings({forceFlush: false});
  renderOptPreview();
}
document.addEventListener('DOMContentLoaded', () => {
  let s = $('optSize'), sv = $('optSizeVal');
  let lh = $('optLineHeight'), lhv = $('optLineHeightVal');
  let w = $('optWeight'), wv = $('optWeightVal');
  let f = $('optFont');
  if (!s || !lh || !w || !f) return;
  s.addEventListener('input', () => onOptInput('fontSize', s, sv, v => v+'px'));
  lh.addEventListener('input', () => onOptInput('lineHeight', lh, lhv, v => v.toFixed(2)));
  w.addEventListener('input', () => onOptInput('fontWeight', w, wv, v => String(v)));
  f.addEventListener('change', () => { settings.font = f.value; saveSettings(); applySettings(); renderOptPreview(); });
  let cv = $('optCtrlVPaste');
  // Read live by _ctrlVShouldPaste, so the change takes effect in every
  // open pane immediately - no re-attaching of key handlers.
  if (cv) cv.addEventListener('change', () => {
    settings.ctrlVPaste = cv.checked; saveSettings();
  });
  let sc = $('optSealed');
  if (sc) sc.addEventListener('change', () => setSealed(sc.checked));
  let cc = $('optTmuxClipboard'), ch = $('optTmuxHistory');
  if (cc) cc.addEventListener('change', () => { settings.tmuxClipboard = cc.checked; saveSettings(); pushTmuxOptionsToActiveSessions(); });
  if (ch) ch.addEventListener('change', () => {
    let v = parseInt(ch.value, 10);
    if (!Number.isFinite(v) || v < 100) v = DEFAULT_SETTINGS.tmuxHistory;
    settings.tmuxHistory = v; ch.value = v; saveSettings();
    pushTmuxOptionsToActiveSessions();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('ovOpt').classList.contains('h')) closeOptions();
  });
});

// Ship the current tmux toggles into every running persistent pane so
// the change takes effect immediately (no reconnect). Routed through
// /api/tmux_options, which runs `tmux set -g …` over the existing
// ControlMaster channel server-side — so the change can't bleed into
// a running editor / pager that happens to occupy the foreground PTY.
function pushTmuxOptionsToActiveSessions() {
  let payload = {
    tmux_set_clipboard: !!settings.tmuxClipboard,
  };
  let hl = parseInt(settings.tmuxHistory, 10);
  if (Number.isFinite(hl) && hl >= 100) payload.tmux_history_limit = hl;
  Object.keys(panes).forEach(k => {
    let p = panes[k];
    if (!p || !p.sid || !p.persistent) return;
    api('tmux_options', { body: Object.assign({ session_id: p.sid }, payload) })
      .catch(() => {});
  });
}

// ── Fullscreen ──────────────────────────────────────────────────────
function toggleFullscreen(){
  if(!document.fullscreenElement)document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}

// ── Split handle drag resize (mouse + touch) ───────────────────────
(function(){
  let dragging=null;
  function startDrag(handle, clientX, clientY) {
    let wrap=handle.parentNode;
    let isH=wrap.classList.contains('split-h');
    let children=[];
    for(let i=0;i<wrap.children.length;i++){
      let ch=wrap.children[i];
      if(!ch.classList.contains('split-handle')) children.push(ch);
    }
    if(children.length<2) return;
    dragging={handle:handle,wrap:wrap,isH:isH,a:children[0],b:children[1]};
    handle.classList.add('dragging');
    document.body.classList.add(isH?'resizing':'resizing-v');
  }
  function moveDrag(clientX, clientY) {
    if(!dragging) return;
    let rect=dragging.wrap.getBoundingClientRect();
    let ratio = dragging.isH
      ? (clientX-rect.left)/rect.width
      : (clientY-rect.top)/rect.height;
    ratio=Math.max(0.1,Math.min(0.9,ratio));
    dragging.a.style.flex=ratio+'';
    dragging.b.style.flex=(1-ratio)+'';
    fitVisiblePanes();
    // The tab's miniature follows the proportion; renderTab's memo holds
    // whole-pixel boxes, so only a move that changes one redraws it.
    renderTab(dragTab());
  }
  function dragTab() {
    let root=dragging&&dragging.wrap.closest?dragging.wrap.closest('.tab-root'):null;
    return root?tabById(root.getAttribute('data-tab')):null;
  }
  function endDrag() {
    if(!dragging) return;
    dragging.handle.classList.remove('dragging');
    document.body.classList.remove('resizing','resizing-v');
    let t=dragTab();
    dragging=null;
    fitVisiblePanes();
    renderTab(t);
    saveSessions();
  }
  // Mouse events
  document.addEventListener('mousedown', e => {
    if(!e.target.classList.contains('split-handle')) return;
    e.preventDefault(); startDrag(e.target, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', e => { moveDrag(e.clientX, e.clientY) });
  document.addEventListener('mouseup', endDrag);
  // Touch events
  document.addEventListener('touchstart', e => {
    if(!e.target.classList.contains('split-handle')) return;
    e.preventDefault(); let t=e.touches[0]; startDrag(e.target, t.clientX, t.clientY);
  }, {passive:false});
  document.addEventListener('touchmove', e => {
    if(!dragging) return; e.preventDefault(); let t=e.touches[0]; moveDrag(t.clientX, t.clientY);
  }, {passive:false});
  document.addEventListener('touchend', endDrag);
  document.addEventListener('touchcancel', endDrag);
})();

// CURSOR_HIDE: defer the focus restore on every drag-blurred pane.
// Between mouseup and tmux's drag-end processing (copy-pipe-and-cancel
// → cursor returns to the shell prompt) there's a ~50–200ms window
// where the cursor still sits at end-of-orange. Calling focus()
// immediately would paint the cursor bar back on that cell — the exact
// "dim symbol after the orange" we set out to fix. So we hook xterm's
// onCursorMove (tmux moving the cursor back is the signal that copy-
// mode is gone) and restore focus then. Fallback timer for sessions
// where the cursor doesn't move on its own (raw shell, no tmux).
// Click-without-drag panes restore immediately.
document.addEventListener('mouseup', () => {
  Object.keys(panes).forEach(id => {
    let p = panes[id];
    if (!p || !p._dragBlurred) return;
    if (!p._dragMoved) {
      _restorePaneFromDrag(p);
      return;
    }
    // Defensive: cancel any stale subscription/timer from a prior drag.
    _cancelDragBlurArm(p);
    let restore = () => _restorePaneFromDrag(p);
    try { p._selDisp = p.term.onCursorMove(restore); } catch(e){}
    p._selTimer = setTimeout(restore, POST_DRAG_HIDE_FALLBACK_MS);
  });
});

// If the window loses focus mid-drag (Alt-Tab, click another window),
// the mouseup may never reach us. Treat blur as a drag-end signal so
// `.dragBlurred` panes don't stay stuck without their cursor.
window.addEventListener('blur', () => {
  Object.keys(panes).forEach(id => {
    let p = panes[id];
    if (p && p._dragBlurred) _restorePaneFromDrag(p);
  });
});

// ── Keyboard shortcuts ──────────────────────────────────────────────
// Tab keys: Alt+1..Alt+8 go to tab N, Alt+9 to the last tab, Alt+T is
// the "+" button, Alt+W closes the tab on screen (closeTab: the same
// confirm as its x), Alt+Shift+[ / Alt+Shift+] go to the previous /
// next tab, wrapping. Not Alt+Left/Right: Option+arrows move by word in
// the shell on a Mac.
//
// Matched by e.code, never e.key: a Cyrillic layout gives key 'е' for
// Alt+T, and macOS Option gives a symbol ('¡' for Option+1, '’' for
// Option+Shift+]). Plain Alt only: Ctrl+Alt is AltGr on Windows (it
// types characters on many layouts), and Meta/Ctrl combos belong to the
// browser. Any other Alt combo is not ours and reaches the shell as
// before (readline's Alt+B/F/./D, Alt+[ ...).
//
// Two entry points, one rule:
//  - the terminal: xterm's attachCustomKeyEventHandler sees the key
//    before xterm sends ESC+x and stops it, so a document listener never
//    would. Returning false there leaves the event alone; we also
//    preventDefault, or macOS would type the Option symbol into xterm's
//    textarea and it would reach the shell through the input event.
//  - the page outside a terminal (tab strip, body): the document
//    listener below. A key handled in the terminal bubbles on to it, so
//    the event is marked and acted on once.
// While any dialog is up (login form, options, confirm, file browser:
// every .ov) the keys do nothing and are not taken. In a text field
// that is not a terminal (search box, a pane's reconnect password,
// any contenteditable) they are not ours either: every Alt/Option
// character must type there (a Mac password with ¡ or ™ in it).
// During a tab or pane drag (from the press on) they are taken but do
// nothing: switching or closing a tab under the pointer would change
// what the release drops onto.
function _tabKeyAction(e) {
  if (!e || !e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.getModifierState && e.getModifierState('AltGraph')) return null;
  let c = e.code || '';
  if (e.shiftKey) {
    if (c === 'BracketLeft') return 'prev';
    if (c === 'BracketRight') return 'next';
    return null;
  }
  let m = /^Digit([1-9])$/.exec(c);
  if (m) return m[1];
  if (c === 'KeyT') return 'new';
  if (c === 'KeyW') return 'close';
  return null;
}
function _isPageTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.classList && el.classList.contains('xterm-helper-textarea')) return false;
  let tag = (el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable
    || (el.getAttribute && /^(|true|plaintext-only)$/i.test(el.getAttribute('contenteditable') || 'x'));
}
function tabKeyHandled(e) {
  let act = _tabKeyAction(e);
  if (!act || !tabs.length || document.querySelector('.ov:not(.h)')) return false;
  if (_isPageTextField(e.target)) return false;
  if (e.type === 'keydown' && !e._wsTabKey && !_tabDrag && !_paneDrag) {
    e._wsTabKey = true;
    let idx = tabs.indexOf(activeTab());
    if (act === 'new') newTab();
    else if (act === 'close') { if (activeTabId) closeTab(activeTabId); }
    else if (act === 'prev' || act === 'next') {
      let n = tabs.length;
      let i = idx < 0 ? 0 : (idx + (act === 'next' ? 1 : n - 1)) % n;
      if (tabs[i].id !== activeTabId) showTab(tabs[i].id);
    } else {
      let i = act === '9' ? tabs.length - 1 : Number(act) - 1;
      if (tabs[i] && tabs[i].id !== activeTabId) showTab(tabs[i].id);
    }
  }
  try { e.preventDefault(); } catch (err) {}
  return true;
}
document.addEventListener('keydown', e => {
  if (e._wsTabKey) return;
  tabKeyHandled(e);
});

function cyclePanes(reverse) {
  // Within the tab on screen: a pane in a hidden tab is not a target.
  let ids = panesInTab(activeTab()).map(p => p.id);
  if (ids.length < 2) return;
  let idx = ids.indexOf(activeId);
  if (reverse) idx = (idx - 1 + ids.length) % ids.length;
  else idx = (idx + 1) % ids.length;
  activatePane(ids[idx]);
}
document.addEventListener('keydown', e => {
  if(e.ctrlKey&&e.shiftKey&&e.key==='F'){e.preventDefault();toggleSearch()}
  if(e.ctrlKey&&!e.shiftKey&&(e.key==='='||e.key==='+')){e.preventDefault();zoomIn()}
  if(e.ctrlKey&&!e.shiftKey&&e.key==='-'){e.preventDefault();zoomOut()}
  if(e.key==='F11'){e.preventDefault();toggleFullscreen()}
  // Ctrl+Tab / Ctrl+Shift+Tab to switch panes
  if(e.ctrlKey&&e.key==='Tab'){e.preventDefault();cyclePanes(e.shiftKey)}
  // Escape: status popup first (topmost), then the login overlay.
  if(e.key==='Escape' && !$('tmuxOv').classList.contains('h')){
    e.preventDefault(); dismissConnectStatus(); return;
  }
  if(e.key==='Escape' && !$('ov').classList.contains('h')
     && $('tmuxOv').classList.contains('h') && overlayDismissable()){
    e.preventDefault(); cancelConnect();
  }
});
// A text selection can start in Host/Username and finish outside the
// card: the browser then clicks their common ancestor, the backdrop.
// Dismiss only a primary gesture that both starts and ends on it.
document.addEventListener('pointerdown', e => {
  let ov = $('ov');
  _connectBackdropGesture = e.target === ov && e.button === 0 &&
    e.isPrimary !== false && !ov.classList.contains('h') && overlayDismissable()
      ? {id: e.pointerId, ended: false} : null;
}, true);
document.addEventListener('pointerup', e => {
  let g = _connectBackdropGesture;
  if (!g || g.id !== e.pointerId) { _connectBackdropGesture = null; return; }
  // Touch may implicitly capture the pointer to the backdrop, so use
  // the actual release position as well as the event target.
  g.ended = e.button === 0 && e.target === $('ov') &&
    document.elementFromPoint(e.clientX, e.clientY) === $('ov');
}, true);
document.addEventListener('pointercancel', () => { _connectBackdropGesture = null; }, true);
window.addEventListener('blur', () => { _connectBackdropGesture = null; });
document.addEventListener('visibilitychange', () => { _connectBackdropGesture = null; });
$('ov').addEventListener('click', e => {
  let g = _connectBackdropGesture;
  _connectBackdropGesture = null;
  if (g && g.ended && e.target === e.currentTarget &&
      !$('ov').classList.contains('h') && overlayDismissable()) cancelConnect();
});

// ── Enter to connect ────────────────────────────────────────────────
// Enter in the login form's fields connects. Bound to THE LOGIN panel:
// `document.querySelector('.panel')` found the first .panel in the page,
// which is the Options panel - so Enter in the form did nothing, and
// Enter in an Options field (Scrollback) fired doConnect() and toasted
// "Host and username are required". The form's own fields only: the
// inline editor of a saved card handles its own Enter.
document.querySelector('#ov .panel').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  let t = e.target;
  if (!t.matches || !t.matches('input:not([type=checkbox]):not([type=hidden])')) return;
  if (t.closest('.sv-edit, .sv, #savedList')) return;
  e.preventDefault();
  doConnect();
});

// ── Auto-connect logic ──────────────────────────────────────────────
function doAutoConnect() {
  // URL anchor: #connect=ConnectionName
  let hash = location.hash.replace(/^#/, '');
  let m = hash.match(/^connect=(.+)/);
  if (m && serverConfig && serverConfig.connections) {
    let name = decodeURIComponent(m[1]);
    let found = serverConfig.connections.some(c => c.name===name);
    if (found) { connectByName(name); return; }
  }
  // Single server connection with restrict_hosts:
  //   - Ready  → connect immediately (no overlay, no form).
  //   - Prompt → show the overlay with the form pre-locked, password focused.
  //     Always pre-lock: there is exactly one allowed host, so pre-filling it
  //     is unambiguous. Saved cards still render below for one-click reconnect.
  if (serverConfig && serverConfig.restrict_hosts && serverConfig.connections.length === 1) {
    let only = serverConfig.connections[0];
    if (only.kind === 'prompt') {
      showOverlay();
      selectPromptConnection(only.name);
      return;
    }
    connectByName(only.name);
    return;
  }
  showOverlay();
}

// ── Session restore ─────────────────────────────────────────────────
// Rebuild layout + reconnect every pane from the localStorage manifest.
// Persistent panes attach via tmux (resume_slot_id); short-lived panes
// just re-run a plain connect with the saved credentials.
function tryRestoreSessions() {
  let m = loadManifest();
  if (!m || !m.tabs || !m.tabs.length || !m.panes || !Object.keys(m.panes).length) return false;

  let restored = {};
  Object.keys(panes).forEach(k => { try { panes[k].term.dispose(); } catch(e) {} delete panes[k]; });
  removeAllTabs();

  function build(parent, node) {
    if (!node) return null;
    if (node.type === 'leaf') {
      let p = createPane(parent);
      if (node.flex) p.el.style.flex = node.flex;
      restored[node.pane] = p;
      return p.el;
    }
    let wrap = document.createElement('div');
    wrap.className = 'split-' + (node.dir === 'v' ? 'v' : 'h');
    if (node.flex) wrap.style.flex = node.flex;
    parent.appendChild(wrap);
    build(wrap, node.a);
    let handle = document.createElement('div');
    handle.className = 'split-handle';
    wrap.appendChild(handle);
    build(wrap, node.b);
    return wrap;
  }
  // One tab at a time, each built while its root is the one on screen:
  // xterm opens into a laid-out element and every pane gets a real size
  // (fitted synchronously below) before the connect body reads it. A
  // pane opened in a hidden root would connect at whatever it had, and
  // never be fitted until its tab is shown. Then the root is hidden
  // again and the saved active tab comes forward.
  let built = [];
  let front = null;
  m.tabs.forEach((tm, idx) => {
    if (!tm || !tm.layout) return;
    let t = createTab();
    t.name = _cleanTabName(tm.name);
    tabs.forEach(o => o.root.classList.toggle('h', o !== t));
    let before = Object.keys(restored).length;
    build(t.root, tm.layout);
    if (Object.keys(restored).length === before) { removeTab(t); return; }
    renderTab(t);    // solo or not BEFORE the fit below: a lone pane has no bar
    panesInTab(t).forEach(q => { try { q.fitAddon.fit(); } catch (e) {} });
    t.lastActive = (tm.active && restored[tm.active]) ? restored[tm.active].id
                                                      : panesInTab(t)[0].id;
    built.push(t);
    if (idx === m.active) front = t;
  });
  tabs.forEach(o => o.root.classList.add('h'));
  if (!built.length) { removeAllTabs(); return false; }
  showTab((front || built[0]).id, {noSave: true});   // records are not filled yet

  // Re-key every pane's sessionStorage secret from its old id to the id
  // build() just minted (ids restart at p1 on every page load, and the
  // next saveSessions() writes the manifest under the new ids; secrets
  // left under the old ones would be unreachable on the next F5). Do it
  // eagerly, so it survives a failed connect, and in TWO passes. build() mints ids in layout
  // order, the manifest is walked in creation order, so old->new is a
  // permutation (after splits, old p3 can become new p2 and old p2 new
  // p3). Moving in place overwrote a secret that a later step had not
  // read yet, and a pane reconnected with ANOTHER host's password - and
  // every later F5 repeated it. Read them all first, then write.
  let secretsByOld = {};
  Object.keys(m.panes).forEach(oldId => { secretsByOld[oldId] = _getPaneSecret(oldId); });
  Object.keys(m.panes).forEach(oldId => {
    let p = restored[oldId];
    if (p && secretsByOld[oldId] && oldId !== p.id) _deletePaneSecret(oldId);
  });
  Object.keys(m.panes).forEach(oldId => {
    let p = restored[oldId];
    if (p && secretsByOld[oldId] && oldId !== p.id) _setPaneSecret(p.id, secretsByOld[oldId]);
  });

  let missingCreds = 0;
  Object.keys(m.panes).forEach(oldId => {
    let rec = m.panes[oldId];
    let p = restored[oldId];
    if (!p || !rec) return;
    // `via` is set by paneRecord post-vault; legacy v2 records without
    // via are treated as manual (their plaintext is in password/key
    // inline, which connectPane consumes once and saveSessions will
    // overwrite with the new shape on the next save).
    // Plaintext for manual / prompt-named panes lives in sessionStorage
    // (Task 7). Legacy v2 records carry password / key inline; we
    // prefer sessionStorage when present, fall back to legacy fields,
    // and finally surface a toast if both are empty for a non-vault
    // pane that needs creds at connect time.
    let secrets = secretsByOld[oldId];
    let password = (secrets && secrets.password) || rec.password || '';
    let key      = (secrets && secrets.key)      || rec.key      || '';
    let keyPass  = (secrets && secrets.key_pass) || rec.key_pass || '';
    let isVault  = !!rec.conn_id;
    let isReady  = rec.via === 'named' && !password && !key;
    // Manual mode (free-form host) needs credentials; prompt-named
    // panes do too. Ready-kind named panes connect with no body creds
    // (server has them in websh.json), so missing-cred toast doesn't
    // apply to those — but we have no kind on the client, so treat
    // empty named entries as "server provides" (`isReady` above).
    if (!isVault && !isReady && !password && !key) {
      missingCreds++;
    }
    connectPane(p, {
      label: rec.label, host: rec.host, port: rec.port, user: rec.user,
      connection: rec.connection, auth: rec.auth,
      password: password, key: key, keyPass: keyPass,
      conn_id: rec.conn_id,
      persistent: rec.persistent, slotId: rec.slot_id,
      tmuxCmd: rec.tmux_cmd || 'tmux',
      resume: !!rec.persistent
    });
  });
  if (missingCreds > 0) {
    showToast(missingCreds + ' pane' + (missingCreds === 1 ? ' was' : 's were') +
              ' restored without saved credentials. Open the login form to re-enter.',
              'warn');
  }
  return true;
}

// ── Init ────────────────────────────────────────────────────────────
// One-time cleanup: theme toggle was dropped (single dark theme now),
// so the legacy `websh_theme` key from users who flipped the toggle
// before the change is an orphan. Remove it once so a fresh devtools
// pass on a returning user's browser doesn't show stray entries.
try { localStorage.removeItem('websh_theme'); } catch(e){}
applyTheme(currentTheme);
ensureFontLink(settings.font);

// Open the vault BroadcastChannel early so a sign-out fired in another
// tab during loadServerConfig still gets observed by this tab.
_initVaultBroadcast();

// No pane is created eagerly. loadServerConfig drives next step:
// either tryRestoreSessions rebuilds the saved layout, or overlayMode is
// set to 'initial' and the user sees the login form on an empty canvas.
// Settles once boot has finished acting on /api/config (restore or the
// login form) - the frontend tests wait on it instead of guessing a delay.
const bootReady = loadServerConfig();
// No renderSaved() here: under isolate_storage the storage prefix is
// only known once /api/config answers, and a render now read the
// SHARED namespace - the login screen showed another deployment's
// saved cards (name, user, host) until config arrived, and a click in
// that window connected with the wrong entry. loadServerConfig()
// renders once the prefix is right (and its failure path renders too).
focusFirst();
