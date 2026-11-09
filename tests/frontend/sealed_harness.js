// Shared harness for the browser-side transfer tests (test_sealed.js,
// test_upload_text.js): websh.js under jsdom, a fake websh server that
// speaks the sealed wire contract and the plain API, every request
// recorded raw (fetch, XHR, beacons). Moved out of test_sealed.js
// unchanged when a second file needed it.
const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');
const nodeCrypto = require('node:crypto');
const {IDBFactory, IDBKeyRange} = require('fake-indexeddb');

const REPO = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(REPO, 'websh.js'), 'utf8');
const subtle = nodeCrypto.webcrypto.subtle;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await sleep(5); }
  return false;
}
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u8 => Buffer.from(u8).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const hex = u8 => Buffer.from(u8).toString('hex');
// Every base64 run of 16+ characters in a text body, decoded and joined.
function b64runs(u8) {
  const t = Buffer.from(u8).toString('latin1');
  return new Uint8Array(Buffer.concat((t.match(/[A-Za-z0-9+/]{16,}={0,2}/g) || []).map(m => Buffer.from(m, 'base64'))));
}
function has(hay, needle) {           // bytes contain bytes
  if (typeof needle === 'string') needle = enc.encode(needle);
  return Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0;
}

// ── the fake websh server ────────────────────────────────────────────

// Revision 2: every dispatched sealed reply is an event stream.
const SSE_HEADERS = {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'};
function ctypeOf(h) {
  if (!h) return '';
  if (typeof h.get === 'function') return h.get('Content-Type') || '';
  for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-type') return String(h[k]);
  return '';
}

class FakeWebsh {
  constructor(o) {
    o = o || {};
    this.available = o.available !== false;
    this.reportSealed = o.reportSealed !== false;   // false: an older server (no "sealed" in config)
    this.wire = [];          // every request: {kind, url, action, method, body: Uint8Array, status}
    this.inner = [];         // decrypted sealed requests: {action, method, query, header, body, wireLen}
    this.channels = new Map();
    this.sessions = {};
    this.files = {};
    this.uploads = [];
    this.beacons = [];
    this.sealOpenFail = null;      // null | 'neterr' | <status>
    this.forgetEvery = false;      // every sealed request answers 410 (channel store lost each time)
    this.hooks = {};               // action -> fn(req) returning a reply, or undefined to fall through
    this.nSid = 0;
  }
  async init() { await this.newIdentity(); return this; }
  async newIdentity() {
    this.identity = await subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
    this.spki = new Uint8Array(await subtle.exportKey('spki', this.identity.publicKey));
    const h = hex(new Uint8Array(await subtle.digest('SHA-256', this.spki))).toUpperCase();
    this.fp = h.match(/.{4}/g).join(' ');
  }
  restart() { this.channels.clear(); }      // channels live in memory only
  config() {
    const c = {restrict_hosts: false, connections: [], upload_chunks: true, proto: 1, version: 'test',
               session_timeout: 300};
    if (this.reportSealed) c.sealed = {available: this.available, wire: this.wireVersion || 2, identity: this.available ? this.fp : null};
    // upload-text spec: the server takes {"b64"} JSON upload bodies.
    // uploadText === false models an older server (no flag; it would
    // write the JSON itself into the file).
    if (this.uploadText !== false) c.upload_text = true;
    return c;
  }

  // ── sessions: a tiny shell that echoes what is typed ──
  newSession() {
    const sid = '7e57' + String(++this.nSid).padStart(4, '0') + '-aaaa-4bbb-8ccc-' + nodeCrypto.randomBytes(6).toString('hex');
    this.sessions[sid] = {input: '', out: '', streams: new Set(), alive: true, inputCalls: 0};
    return sid;
  }
  emit(sid, text) {
    const s = this.sessions[sid]; if (!s) return;
    const from = s.out.length;
    s.out += text;
    for (const st of s.streams) st.send(from);
  }

  // ── the inner API (what a plain URL would reach) ──
  async handle(req) {
    if (this.hooks[req.action]) {
      const r = await this.hooks[req.action](req);
      if (r !== undefined) return r;
    }
    const q = req.query, j = () => JSON.parse(dec.decode(req.body) || '{}');
    const json = (obj, status) => ({status: status || 200, headers: {'Content-Type': 'application/json'}, body: enc.encode(JSON.stringify(obj))});
    switch (req.action) {
      case 'config': return json(this.config());
      case 'ping': return json({ok: true, version: 'test', proto: 1});
      case 'connect': {
        const sid = this.newSession();
        setTimeout(() => this.emit(sid, 'Welcome\r\n$ '), 5);
        return json({session_id: sid, status: 'connecting', alive: true, auth_failed: false,
                     persistent: !!j().persistent, slot_id: j().slot_id || null, tmux_cmd: 'tmux'});
      }
      case 'input': {
        const b = j(); const s = this.sessions[b.session_id];
        if (!s) return json({error: 'session not found'}, 404);
        s.inputCalls++;
        s.input += b.data;
        setTimeout(() => this.emit(b.session_id, b.data.replace(/\r/g, '\r\n')), 2);
        return json({ok: true, alive: true, cursor: s.out.length});
      }
      case 'output': {
        const s = this.sessions[q.session_id];
        if (!s) return json({error: 'session not found'}, 404);
        const since = q.since !== undefined ? +q.since : s.out.length;
        await until(() => s.out.length > since, 40);
        const data = s.out.slice(since);
        return json({data: b64(enc.encode(data)), alive: true, auth_failed: false, cursor: s.out.length});
      }
      case 'stream': {
        const s = this.sessions[q.session_id];
        if (!s) return json({error: 'session not found'}, 404);
        const since = q.since !== undefined ? +q.since : 0;
        return {status: 200, headers: {'Content-Type': 'text/event-stream'}, sse: {s, since}};
      }
      case 'resize': return json({ok: true});
      case 'disconnect': { const b = j(); if (this.sessions[b.session_id]) this.sessions[b.session_id].alive = false; return json({ok: true}); }
      case 'tmux_options': return json({ok: true});
      case 'tmux_capture': return json({data: ''});
      case 'ls': return json({path: q.path || '/home/u', entries: [{name: 'secret-plan-Q7.txt', type: 'f', size: 5, mtime: 0}]});
      case 'download': {
        const f = this.files[q.path];
        if (!f) return json({error: 'File not found'}, 404);
        return {status: 200, headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(f.length),
                'Content-Disposition': 'attachment; filename="' + q.path.split('/').pop() + '"'}, body: f};
      }
      case 'upload': {
        const name = q.path, off = q.offset === undefined ? null : +q.offset;
        const h = req.header || {};
        let text = false;
        if (!req.sealed && /^application\/json\b/i.test(req.ctype || '') && this.uploadText !== false) {
          // A text piece: {"b64": base64}; the decoded bytes are the piece.
          let b;
          try { b = JSON.parse(dec.decode(req.body)).b64; } catch (e) { b = null; }
          if (typeof b !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b) || b.length % 4) {
            this.uploads.push({name, offset: off, text: true, bad: true, wireLen: req.body.length});
            return json({error: 'invalid upload body'}, 400);
          }
          req = Object.assign({}, req, {body: unb64(b), wireLen: req.body.length});
          text = true;
        }
        const real = h.len !== undefined ? h.len : req.body.length;
        this.uploads.push({name, offset: off, len: h.len, pad: h.pad, bodyLen: req.body.length, wireLen: req.wireLen, text,
                           ctype: req.ctype || ''});
        if (h.pad) return json({ok: true, size: (this.files[name] || new Uint8Array(0)).length});
        const cur = this.files[name] || new Uint8Array(0);
        if (off !== null && off !== 0 && cur.length !== off) return json({error: 'offset mismatch', size: cur.length}, 409);
        const piece = req.body.slice(0, real);
        this.files[name] = off ? cat(cur, piece) : piece;
        return json({ok: true, bytes: real, size: this.files[name].length});
      }
      case 'upload_finalize': {
        const b = j();
        this.files['/final/' + b.final] = this.files[b.tmp];
        return json({ok: true, path: (b.dir || '/home/u') + '/' + b.final});
      }
      case 'upload_cancel': return json({ok: true});
      default: return json({error: 'not found'}, 404);
    }
  }

  // ── sealed: handshake and frames ──
  async sealOpen(bodyU8) {
    let pub;
    const hello = JSON.parse(dec.decode(bodyU8));
    if (hello.wire !== 2) return {status: 409, json: {code: 'sealed_upgrade_required', error: 'Reload for sealed wire 2'}};
    try { pub = unb64(hello.pub); } catch (e) { return {status: 400, json: {error: 'bad key'}}; }
    let cpubKey;
    try { cpubKey = await subtle.importKey('raw', pub, {name: 'ECDH', namedCurve: 'P-256'}, true, []); }
    catch (e) { return {status: 400, json: {error: 'bad key'}}; }
    const eph = await subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits']);
    const spub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    const channel = nodeCrypto.randomBytes(16).toString('hex');
    const shared = await subtle.deriveBits({name: 'ECDH', public: cpubKey}, eph.privateKey, 256);
    const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const salt = cat(pub, spub);
    const key = async info => subtle.importKey('raw',
      await subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info)}, hk, 256),
      'AES-GCM', false, ['encrypt', 'decrypt']);
    const ch = {c2s: await key('websh sealed c2s'), s2c: await key('websh sealed s2c'), seen: new Set(), max: 0, channel};
    this.channels.set(channel, ch);
    const sig = new Uint8Array(await subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, this.identity.privateKey,
                                                  cat(pub, spub, enc.encode(channel + ':sealed:2'))));
    return {status: 200, json: {wire: this.wireVersion || 2, channel, pub: b64(spub), identity: b64(this.spki), sig: b64(sig)}};
  }
  async frameOut(ch, pt) {
    const iv = nodeCrypto.randomBytes(12);
    const ct = new Uint8Array(await subtle.encrypt({name: 'AES-GCM', iv, additionalData: enc.encode(ch.channel + ':s2c:2:' + ch.responseSeq + ':' + ch.responseIndex++)}, ch.s2c, pt));
    // Revision 2: one SSE event per frame, the frame in base64.
    return enc.encode('data: ' + b64(cat(new Uint8Array(iv), ct)) + '\n\n');
  }
  async sealed(channel, wireU8, ctype) {
    if (this.forgetEvery) this.channels.clear();
    let ch = this.channels.get(channel);
    if (!ch) return {status: 410, json: {error: 'channel unknown'}};
    // Revision 2: the request is JSON text {"f": base64(frame)}.
    if (!/^application\/json\b/i.test(ctype || '')) this.badCtype = (this.badCtype || 0) + 1;
    let bodyU8;
    try {
      const f = JSON.parse(dec.decode(wireU8)).f;
      if (typeof f !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f)) throw new Error('f');
      bodyU8 = unb64(f);
    } catch (e) { return {status: 400, json: {error: 'bad frame'}}; }
    let pt;
    try {
      pt = new Uint8Array(await subtle.decrypt({name: 'AES-GCM', iv: bodyU8.slice(0, 12), additionalData: enc.encode(channel + ':c2s')},
                                               ch.c2s, bodyU8.slice(12)));
    } catch (e) { return {status: 400, json: {error: 'bad frame'}}; }
    const nl = pt.indexOf(10);
    const header = JSON.parse(dec.decode(pt.slice(0, nl)));
    if (ch.seen.has(header.seq) || header.seq < ch.max - 4096) return {status: 400, json: {error: 'replay'}};
    ch.seen.add(header.seq); ch.max = Math.max(ch.max, header.seq);
    const req = {action: header.action, method: header.method, query: header.query || {}, header,
                 body: pt.slice(nl + 1), wireLen: wireU8.length, sealed: true};
    this.inner.push(req);
    if (['seal_open', 'sealed', 'config', 'ping', 'client_diag'].includes(req.action)) return {status: 400, json: {error: 'not allowed'}};
    const r = await this.handle(req);
    ch = Object.assign({}, ch, {responseSeq: header.seq, responseIndex: 0});
    const self = this;
    if (r.sse) {
      // A sealed SSE stream: frames go out as events happen.
      let ctl, chain = Promise.resolve(), closed = false;
      const s = r.sse.s;
      const st = {
        cur: r.sse.since,
        send() {
          if (closed) return;
          const data = s.out.slice(st.cur); if (!data) return;
          st.cur = s.out.length;
          const ev = 'id: ' + st.cur + '\nevent: data\ndata: ' + JSON.stringify({data: b64(enc.encode(data)), alive: true, auth_failed: false, cursor: st.cur}) + '\n\n';
          chain = chain.then(async () => { push(await self.frameOut(ch, enc.encode(ev))); });
        },
        endEvent() {
          chain = chain.then(async () => { push(await self.frameOut(ch, enc.encode('event: end\ndata: {"alive": false, "auth_failed": false}\n\n'))); push(await self.frameOut(ch, new Uint8Array(0))); closed = true; try { ctl.close(); } catch (e) {} });
          s.streams.delete(st);
        },
        cut() { closed = true; s.streams.delete(st); chain.then(() => { try { ctl.close(); } catch (e) {} }); },
        endClean() { s.streams.delete(st); chain.then(async () => { push(await self.frameOut(ch, new Uint8Array(0))); closed = true; ctl.close(); }); },
      };
      const stream = new ReadableStream({start(c) { ctl = c; }, cancel() { closed = true; s.streams.delete(st); }});
      // How the bytes reach the reader: one chunk per frame (default),
      // the opening frames and the waiting output in ONE chunk (TCP
      // coalesces them whenever output is already waiting - the real
      // server writes the primer and the backlog back to back), or
      // every frame split at arbitrary byte boundaries.
      const push = bytes => {
        if (closed) return;
        if (self.chunking === 'split') { let i = 0; while (i < bytes.length) { const n = 1 + Math.floor(Math.random() * 7); ctl.enqueue(bytes.slice(i, i + n)); i += n; } }
        else ctl.enqueue(bytes);
      };
      const backlogFirst = self.chunking === 'together';
      // Everything a frame says is fixed NOW: send() may move st.cur
      // before the encryption below resolves.
      const primerCursor = st.cur;
      let backlog = '', backlogCursor = st.cur;
      if (backlogFirst) { backlog = s.out.slice(st.cur); st.cur = backlogCursor = s.out.length; }
      chain = chain.then(async () => {
        const head = await self.frameOut(ch, enc.encode(JSON.stringify({status: 200, headers: r.headers})));
        const primer = await self.frameOut(ch, enc.encode(': ok\n\nevent: data\ndata: {"data": "", "alive": true, "auth_failed": false, "cursor": ' + primerCursor + '}\n\n'));
        if (!backlogFirst) { push(head); push(primer); return; }
        let first = cat(head, primer);
        if (backlog)
          first = cat(first, await self.frameOut(ch, enc.encode('id: ' + backlogCursor + '\nevent: data\ndata: ' + JSON.stringify({data: b64(enc.encode(backlog)), alive: true, auth_failed: false, cursor: backlogCursor}) + '\n\n')));
        push(first);
      });
      s.streams.add(st);
      (this.sseStreams = this.sseStreams || []).push(st);
      setTimeout(() => st.send(), 1);
      return {status: 200, stream, headers: SSE_HEADERS, innerRequest: req};
    }
    const parts = [await this.frameOut(ch, enc.encode(JSON.stringify({status: r.status, headers: r.headers || {}})))];
    if (r.body && r.body.length) {
      const step = this.replyChunkSize || r.body.length;
      for (let at = 0; at < r.body.length; at += step)
        parts.push(await this.frameOut(ch, r.body.slice(at, at + step)));
    }
    if (!r.truncate) parts.push(await this.frameOut(ch, new Uint8Array(0)));
    // Test-only identity stays outside the wire and binds interception to this reply.
    return {status: 200, bytes: cat(...parts), headers: SSE_HEADERS, innerRequest: req};
  }

  // ── transport: one entry for fetch, XHR and beacons ──
  async exchange(kind, url, method, body, ctype) {
    const u = new URL(url, 'http://localhost/');
    const action = u.searchParams.get('action') || (u.pathname.match(/\/api\/(\w+)/) || [])[1] || '';
    const rec = {kind, url: String(url), action, method, body, ctype: ctype || ''};
    this.wire.push(rec);
    let out;
    if (action === 'seal_open') {
      if (this.sealOpenFail === 'neterr') { rec.status = 0; throw new TypeError('Failed to fetch'); }
      if (this.sealOpenFail) out = {status: this.sealOpenFail, json: {error: 'boom'}};
      else if (!this.available) out = {status: 501, json: {error: 'sealed mode unavailable'}};
      else out = await this.sealOpen(body);
    } else if (action === 'sealed') {
      out = !this.available ? {status: 501, json: {error: 'sealed mode unavailable'}} : await this.sealed(u.searchParams.get('c'), body, ctype);
    } else {
      const query = {};
      u.searchParams.forEach((v, k) => { if (k !== 'action') query[k] = v; });
      // An interceptor in front of websh (endpoint-security software,
      // measured 2026-10-21): it answers an application/octet-stream POST
      // itself (503 text/html), or cuts it (O7b's 400 "fewer bytes").
      // blockBinary / cutBinary: true, or a function(rec) -> bool.
      const binary = method === 'POST' && /octet-stream/i.test(ctype || '');
      const on = f => typeof f === 'function' ? f(rec) : !!f;
      if (binary && on(this.blockBinary)) {
        rec.status = 503; rec.intercepted = 'blocked';
        const html = enc.encode('<html><head><title>503 Service Unavailable</title></head><body>Blocked by policy</body></html>');
        return {status: 503, bytes: html, headers: {'Content-Type': 'text/html'}};
      }
      // A stall: the body is taken, no answer ever comes (O7b's "stall").
      const textUpload = method === 'POST' && action === 'upload' && /^application\/json/i.test(ctype || '');
      if ((binary && action === 'upload' && on(this.stallBinary)) || (textUpload && on(this.stallText))) {
        rec.status = 0; rec.intercepted = 'stalled';
        return new Promise(() => {});
      }
      if (textUpload && this.busyText) {
        // websh answering "busy" (a transient, retried reply) after a while.
        if (this.cutDelay) await new Promise(r => setTimeout(r, this.cutDelay));
        rec.status = 503; rec.intercepted = 'busy';
        return {status: 503, bytes: enc.encode(JSON.stringify({error: 'server busy'})), headers: {'Content-Type': 'application/json'}};
      }
      if (textUpload && on(this.cutText)) {
        if (this.cutDelay) await new Promise(r => setTimeout(r, this.cutDelay));
        rec.status = 400; rec.intercepted = 'cut';
        return {status: 400, bytes: enc.encode(JSON.stringify({error: 'client sent fewer bytes than Content-Length'})), headers: {'Content-Type': 'application/json'}};
      }
      if (binary && action === 'upload' && on(this.cutBinary)) {
        if (this.cutDelay) await new Promise(r => setTimeout(r, this.cutDelay));
        rec.status = 400; rec.intercepted = 'cut';
        return {status: 400, bytes: enc.encode(JSON.stringify({error: 'client sent fewer bytes than Content-Length'})), headers: {'Content-Type': 'application/json'}};
      }
      // A proxy that cuts any upload body over a size (O7b), text ones too.
      if (method === 'POST' && action === 'upload' && this.cutOver && body.length > this.cutOver) {
        rec.status = 400; rec.intercepted = 'cut';
        return {status: 400, bytes: enc.encode(JSON.stringify({error: 'client sent fewer bytes than Content-Length'})), headers: {'Content-Type': 'application/json'}};
      }
      const r = await this.handle({action, method, query, body, sealed: false, ctype: ctype || ''});
      if (r.sse) out = {status: 404, json: {error: 'no EventSource in this harness'}};
      else out = {status: r.status, bytes: r.body, headers: r.headers};
    }
    rec.status = out.status;
    if (out.json) out = {status: out.status, bytes: enc.encode(JSON.stringify(out.json)), headers: {'Content-Type': 'application/json'}};
    rec.reply = out.bytes;
    return out;
  }
}

async function bodyBytes(win, body) {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') return enc.encode(body);
  if (body instanceof ArrayBuffer || Object.prototype.toString.call(body) === '[object ArrayBuffer]') return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (body instanceof win.Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error('unsupported request body type: ' + Object.prototype.toString.call(body));
}

function installTransport(win, srv) {
  const st = {dead: false};
  win.fetch = async function(url, init) {
    init = init || {};
    const body = await bodyBytes(win, init.body);
    if (st.dead) return new Promise(() => {});
    const out = await srv.exchange('fetch', url, (init.method || 'GET').toUpperCase(), body, ctypeOf(init.headers));
    if (st.dead) return new Promise(() => {});
    if (out.stream) {
      // Like a browser: aborting the request's signal errors the body
      // being read (AbortError) - the page must expect that.
      const sig = init.signal;
      const rd = out.stream.getReader();
      const body = new ReadableStream({
        start(c) {
          if (sig) sig.addEventListener('abort', () => { try { c.error(new DOMException('signal is aborted without reason', 'AbortError')); } catch (e) {} try { rd.cancel(); } catch (e) {} });
        },
        async pull(c) {
          try { const {done, value} = await rd.read(); if (done) c.close(); else c.enqueue(value); } catch (e) { try { c.error(e); } catch (x) {} }
        },
        cancel() { try { rd.cancel(); } catch (e) {} },
      });
      return new Response(body, {status: out.status, headers: out.headers || {'Content-Type': 'application/octet-stream'}});
    }
    if (srv.chunking === 'split' && out.bytes && out.bytes.length && /action=sealed/.test(String(url))) {
      const b = out.bytes;
      const rs = new ReadableStream({start(c) { let i = 0; while (i < b.length) { const n = 1 + Math.floor(Math.random() * 7); c.enqueue(b.slice(i, i + n)); i += n; } c.close(); }});
      return new Response(rs, {status: out.status, headers: out.headers || {'Content-Type': 'application/octet-stream'}});
    }
    return new Response(out.bytes && out.bytes.length ? out.bytes : null,
                        {status: out.status, headers: out.headers || {'Content-Type': 'application/octet-stream'}});
  };
  win.fetch.__state = st;
  win.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.response = null; this.responseType = ''; this.readyState = 0; this._h = {}; }
    open(m, url) { this.method = m; this.url = url; this.readyState = 1; }
    setRequestHeader(k, v) { (this._rq = this._rq || {})[k] = v; }
    getResponseHeader(n) { return this._h[n.toLowerCase()] || null; }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    send(body) {
      (async () => {
        const b = await bodyBytes(win, body);
        if (srv.xhrCut && srv.xhrCut(this, b)) { if (this.onerror) this.onerror(); return; }
        let out;
        try { out = await srv.exchange('xhr', this.url, this.method.toUpperCase(), b, ctypeOf(this._rq)); }
        catch (e) { if (!this.aborted && this.onerror) this.onerror(); return; }
        if (this.aborted || st.dead) return;
        if (this.upload.onprogress) this.upload.onprogress({loaded: b.length, total: b.length, lengthComputable: true});
        let bytes = out.bytes || new Uint8Array(0);
        if (out.stream) {
          const rd = out.stream.getReader(); const acc = [];
          for (;;) { const {done, value} = await rd.read(); if (done) break; acc.push(value); }
          bytes = cat(...acc);
        }
        this.status = out.status; this.readyState = 4;
        this._h = {}; for (const [k, v] of Object.entries(out.headers || {})) this._h[k.toLowerCase()] = v;
        if (this.responseType === 'arraybuffer') this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        else if (this.responseType === 'blob') this.response = new win.Blob([bytes]);
        else { this.responseText = Buffer.from(bytes).toString('latin1'); this.response = this.responseText; }
        if (this.onreadystatechange) this.onreadystatechange();
        if (this.onload) this.onload();
        if (this.onloadend) this.onloadend();
      })();
    }
  };
  win.navigator.sendBeacon = (url, data) => {
    srv.beacons.push({url, data});
    srv.wire.push({kind: 'beacon', url: String(url), action: new URL(url, 'http://localhost/').searchParams.get('action'),
                   method: 'POST', body: enc.encode(typeof data === 'string' ? data : '')});
    return true;
  };
  return st;
}

// A plain EventSource wired to the fake server (the browser's own SSE
// client in the plain mode), recorded on the wire like everything else.
function liveEventSource(win, srv) {
  return class {
    constructor(url) {
      this.url = url; this.readyState = 0; this._l = {};
      (srv.esInstances = srv.esInstances || []).push(this);
      const u = new URL(url, 'http://localhost/');
      srv.wire.push({kind: 'eventsource', url: String(url), action: u.searchParams.get('action'), method: 'GET', body: new Uint8Array(0)});
      const s = srv.sessions[u.searchParams.get('session_id')];
      setTimeout(() => {
        if (this.readyState === 2) return;
        if (!s) { this.readyState = 2; this._fire('error', {}); return; }
        this.readyState = 1; this._fire('open', {});
        const since = u.searchParams.get('since');
        const es = this;
        this._st = {cur: since !== null ? +since : 0,
          send() {
            if (es.readyState !== 1) return;
            const data = s.out.slice(this.cur); if (!data) return;
            this.cur = s.out.length;
            es._fire('data', {data: JSON.stringify({data: b64(enc.encode(data)), alive: true, auth_failed: false, cursor: this.cur}), lastEventId: String(this.cur)});
          }};
        s.streams.add(this._st); this._s = s;
        this._fire('data', {data: JSON.stringify({data: '', alive: true, auth_failed: false, cursor: this._st.cur}), lastEventId: ''});
        this._st.send();
      }, 2);
    }
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
    removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter(x => x !== f); }
    _fire(t, ev) { ev.type = t; for (const f of (this._l[t] || [])) try { f(ev); } catch (e) { console.log('es handler threw', e); } if (this['on' + t]) this['on' + t](ev); if (t === 'data' && this.onmessage) {} }
    close() { this.readyState = 2; if (this._s) this._s.streams.delete(this._st); }
  };
}

// ── the page ─────────────────────────────────────────────────────────

function fakes(win, rec) {
  win.Terminal = class {
    constructor(opts) {
      this.options = Object.assign({}, opts || {});
      this.cols = 80; this.rows = 24; this.written = '';
      this.modes = {mouseTrackingMode: 'none'};
      (rec.terms = rec.terms || []).push(this);
    }
    loadAddon() {} open(el) { this.element = el; } reset() {} focus() {} blur() {} dispose() {} clear() {} scrollToBottom() {} refresh() {}
    write(d, cb) { this.written += typeof d === 'string' ? d : dec.decode(d); if (cb) setTimeout(cb, 0); }
    onData(cb) { this._onData = cb; return {dispose() {}}; }
    onBinary() { return {dispose() {}}; } onResize() { return {dispose() {}}; } onBell() { return {dispose() {}}; }
    onTitleChange() { return {dispose() {}}; } onScroll() { return {dispose() {}}; } onRender() { return {dispose() {}}; }
    onWriteParsed() { return {dispose() {}}; } onSelectionChange() { return {dispose() {}}; } onCursorMove() { return {dispose() {}}; }
    onKey() { return {dispose() {}}; } onLineFeed() { return {dispose() {}}; }
    attachCustomKeyEventHandler() {} registerLinkProvider() { return {dispose() {}}; }
    registerDecoration() { return null; } registerMarker() { return null; }
    getSelection() { return ''; } hasSelection() { return false; }
    paste(d) { if (this._onData) this._onData(d); }
    get parser() { return {registerOscHandler() { return {dispose() {}}; }, registerCsiHandler() { return {dispose() {}}; }}; }
    get buffer() { return {active: {length: 0, viewportY: 0, baseY: 0, cursorY: 0, getLine: () => null}}; }
    get unicode() { return {activeVersion: '11'}; }
  };
  win.FitAddon = {FitAddon: class { activate() {} fit() {} proposeDimensions() { return {cols: 80, rows: 24}; } }};
  win.SearchAddon = {SearchAddon: class { activate() {} findNext() { return true; } findPrevious() { return true; } clearDecorations() {} dispose() {} onDidChangeResults() { return {dispose() {}}; } }};
  win.WebLinksAddon = {WebLinksAddon: class { activate() {} dispose() {} }};
  win.Unicode11Addon = {Unicode11Addon: class { activate() {} dispose() {} }};
  win.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  Object.defineProperty(win.crypto, 'subtle', {value: subtle, configurable: true});
  win.TextEncoder = TextEncoder; win.TextDecoder = TextDecoder;
  win.indexedDB = new IDBFactory(); win.IDBKeyRange = IDBKeyRange;
  // What a browser has and jsdom lacks; the sealed client may use any.
  win.Response = Response; win.Headers = Headers; win.ReadableStream = ReadableStream;
  win.AbortController = AbortController;
  if (!win.Blob.prototype.arrayBuffer) {
    win.Blob.prototype.arrayBuffer = function() {
      return new Promise((res, rej) => { const fr = new win.FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(this); });
    };
  }
  win.URL.createObjectURL = () => 'blob:x'; win.URL.revokeObjectURL = () => {};
}

const EXPOSE = `
; (function(){
  Object.defineProperty(window, 'panes', {get: () => panes, configurable: true});
  Object.defineProperty(window, 'settings', {get: () => settings, configurable: true});
  Object.defineProperty(window, 'bootReady', {get: () => bootReady, configurable: true});
  for (const k of ['UPLOAD_CHUNK_BYTES', 'UPLOAD_CHUNK_TIMEOUT_MS', 'UPLOAD_RETRY_BASE_MS', 'UPLOAD_WALLCLOCK_MS', 'INPUT_STALL_MS'])
    try { Object.defineProperty(window, k, {get: () => eval(k), set: v => { eval(k + ' = v'); }, configurable: true}); } catch (e) {}
})();`;

const envs = [];
async function mkEnv(o) {
  o = o || {};
  const srv = o.server || await new FakeWebsh(o).init();
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/websh/'});
  const win = dom.window;
  const rec = {};
  fakes(win, rec);
  const st = installTransport(win, srv);
  // jsdom has no EventSource, so the page would never try a stream. A
  // browser has one; a scenario that needs the (sealed) stream says so.
  // This stub never connects: a plain stream through it would sit idle.
  if (o.eventSource === 'live') win.EventSource = liveEventSource(win, srv);
  else if (o.eventSource) win.EventSource = class { constructor(u) { this.url = u; this.readyState = 0; } addEventListener() {} close() { this.readyState = 2; } };
  win.localStorage.clear();
  const store = Object.assign({}, o.storage || {});
  if (o.sealed) {
    const s = JSON.parse(store.websh_settings || '{}'); s.sealed = true;
    store.websh_settings = JSON.stringify(s);
  }
  for (const [k, v] of Object.entries(store)) win.localStorage.setItem(k, v);
  // A test's own fakes that must be in place before websh.js runs (a
  // virtual clock, a Terminal that renders): o.beforeBoot(win, rec).
  if (o.beforeBoot) o.beforeBoot(win, rec);
  win.eval(js + EXPOSE);
  await Promise.race([win.bootReady, sleep(2000)]);
  await sleep(20);
  const env = {dom, win, srv, rec, st, skew: 0};
  // The page's clock, movable: "25 s pass" without waiting 25 s. Timers
  // are real; a test that needs a timer to fire shortens it.
  const realNow = win.Date.now.bind(win.Date);
  win.Date.now = () => realNow() + env.skew;
  envs.push(env);
  return env;
}
function cleanup(env) {
  try {
    for (const p of Object.values(env.win.panes || {})) { p.polling = false; try { env.win.stopKeepalive(p); } catch (e) {} }
    env.st.dead = true;
    for (const s of (env.srv.sseStreams || [])) try { s.cut(); } catch (e) {}
  } catch (e) {}
  // Closed a moment later: a crypto operation already in flight would
  // otherwise resolve into a closed window (document undefined) and
  // count as an unhandled rejection of whatever test runs next.
  setTimeout(() => { try { env.dom.window.close(); } catch (e) {} }, 300);
}
const $ = (win, id) => win.document.getElementById(id);
const visible = el => !!el && !el.classList.contains('h') && !el.hidden && el.style.display !== 'none';
const storageDump = win => { const o = {}; for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); o[k] = win.localStorage.getItem(k); } return o; };
function setCheckbox(win, el, v) { el.checked = v; el.dispatchEvent(new win.Event('change', {bubbles: true})); el.dispatchEvent(new win.Event('input', {bubbles: true})); }
const plainApi = srv => srv.wire.filter(w => !['config', 'ping', 'seal_open', 'sealed'].includes(w.action));
const innerActions = srv => srv.inner.map(r => r.action);
const PASSWORD = 'Pw-SEALED-7f3a9c', HOST = 'target-HOSTMARK.example', USER = 'userMARK';

async function connect(env) {
  const win = env.win;
  $(win, 'iH').value = HOST; $(win, 'iU').value = USER; $(win, 'iPw').value = PASSWORD;
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await until(() => Object.values(win.panes).some(p => p.sid), 3000);
  const p = Object.values(win.panes).find(x => x.sid);
  return p;
}
const termText = p => (p && p.term && p.term.written) || '';
function typeKeys(win, p, s) { for (const c of s) win.queueInput(p, c); }


module.exports = {sleep, until, enc, dec, b64, unb64, cat, hex, b64runs, has, SSE_HEADERS, ctypeOf, FakeWebsh, bodyBytes, installTransport, liveEventSource, fakes, EXPOSE, envs, mkEnv, cleanup, $, visible, storageDump, setCheckbox, plainApi, innerActions, PASSWORD, HOST, USER, connect, termText, typeKeys, subtle};
