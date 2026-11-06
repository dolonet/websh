#!/usr/bin/env python3
"""Sealed mode: a second encryption layer under TLS (the owner's request,
2026-10: "nobody between my browser and my server may read or even
partly understand what I type or upload" - ISP/state DPI, a work laptop
behind a TLS-inspecting proxy).

Written from the behaviour spec, not from the code. The tests talk to
the server only over HTTP, with a small reference client below that
implements the wire contract from the spec:

  POST /api.php?action=seal_open   {"wire": 2, "pub": b64(client P-256 raw 65 B)}
    -> {"channel": 32 hex, "pub": b64(server raw), "identity": b64(SPKI DER),
        "sig": b64(r||s over client_pub || server_pub || channel_ascii || ":sealed:2")}
  K_c2s / K_s2c = HKDF-SHA256(ECDH, salt=client_pub||server_pub,
                              info="websh sealed c2s" / "... s2c")
  frame = iv(12) || AES-256-GCM(ct+tag), AAD c2s = channel + ":c2s"; s2c = channel + ":s2c:2:<request_seq>:<frame_index>"
  POST /api.php?action=sealed&c=<channel>  body = one c2s frame of
    {"seq","method","action","query"[,"len","pad"]} "\\n" <inner body>
    -> 200, body = (uint32 BE length || s2c frame)*; first = {"status",
       "headers"}, then body chunks, then an empty frame = clean end.

Every request in the sealed classes goes through a recording TCP proxy,
so the "an observer sees nothing" checks look at the real bytes on the
wire, not at what a client library chose to show.

A real shell is needed for the round trip (keys in, echo out). The
backend suite has no ssh target (loopback is on websh's deny-list, CI
has no sshd), so `ssh` is replaced, for these classes only, by a fake on
PATH: the master "connection" is an interactive `sh` in websh's PTY in a
private $HOME, and ControlMaster side-channel commands (ls, download,
upload) run the real remote snippets in `sh` against that $HOME. The
server code under test - the PTY, the read loop, the side-channel
snippets, the HTTP handlers - is the real one.

Without `cryptography` the sealed classes skip; TestSealedUnavailable
runs everywhere (it blocks the import in a child server).
"""

import base64
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

from tests.backend._base import REPO_ROOT, LiveServerCase, _FakeNotifyMixin  # noqa: F401
import server

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import (
        encode_dss_signature)
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.exceptions import InvalidSignature, InvalidTag
    HAVE_CRYPTO = True
except ImportError:  # the CI legs without cryptography
    HAVE_CRYPTO = False

NEEDS_CRYPTO = unittest.skipUnless(
    HAVE_CRYPTO, "cryptography not installed: sealed mode is unavailable "
                 "(TestSealedUnavailable covers that side)")

FP_RE = re.compile(r"^[0-9A-F]{4}( [0-9A-F]{4}){15}$")
CHANNEL_RE = re.compile(r"^[0-9a-f]{32}$")

# Anything in the repo root this module may have caused (a key file
# created next to the default creds path) is reported at the end.
_REPO_KEY = os.path.join(REPO_ROOT, "websh.sealed.key")
_REPO_KEY_EXISTED = os.path.exists(_REPO_KEY)


def tearDownModule():
    if not _REPO_KEY_EXISTED and os.path.exists(_REPO_KEY):
        os.remove(_REPO_KEY)
        raise AssertionError(
            "the sealed identity key was written into the repository "
            "(websh.sealed.key in the repo root) although "
            "WEBSH_SEALED_KEY_FILE pointed elsewhere")


def fingerprint(spki_der):
    h = hashlib.sha256(spki_der).hexdigest().upper()
    return " ".join(h[i:i + 4] for i in range(0, 64, 4))


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ── recording proxy: what an on-path observer sees ───────────────────

class WireTap(object):
    """A TCP relay that records every byte in both directions. An
    observer who has broken TLS (the corporate proxy) sees exactly this
    plaintext HTTP."""

    def __init__(self, target_port):
        self.target_port = target_port
        self.lock = threading.Lock()
        self.c2s = bytearray()
        self.s2c = bytearray()
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        self.closed = False
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while not self.closed:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            try:
                u = socket.create_connection(("127.0.0.1", self.target_port))
            except OSError:
                c.close()
                continue
            threading.Thread(target=self._pump, args=(c, u, self.c2s),
                             daemon=True).start()
            threading.Thread(target=self._pump, args=(u, c, self.s2c),
                             daemon=True).start()

    def _pump(self, src, dst, buf):
        try:
            while True:
                d = src.recv(65536)
                if not d:
                    break
                with self.lock:
                    buf.extend(d)
                dst.sendall(d)
        except OSError:
            pass
        finally:
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def wire(self):
        with self.lock:
            return bytes(self.c2s), bytes(self.s2c)

    def request_lines(self):
        c2s, _ = self.wire()
        return re.findall(rb"(?m)^(GET|POST|PUT|DELETE) (\S+) HTTP/1\.[01]\r$",
                          c2s)

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass


# ── reference client ─────────────────────────────────────────────────

class Truncated(Exception):
    """The response body ended without the empty end frame."""


class SealedReply(object):
    def __init__(self, outer_status, outer_body=b"", header=None,
                 chunks=None, clean_end=None):
        self.outer_status = outer_status
        self.outer_body = outer_body       # only for a non-200 outer reply
        self.header = header or {}
        self.chunks = chunks or []
        self.clean_end = clean_end

    @property
    def status(self):
        return self.header.get("status")

    @property
    def body(self):
        return b"".join(self.chunks)

    def json(self):
        return json.loads(self.body.decode("utf-8"))

    def outer_json(self):
        try:
            return json.loads(self.outer_body.decode("utf-8"))
        except ValueError:
            return {"_raw": self.outer_body[:200]}

    def header_value(self, name):
        for k, v in (self.header.get("headers") or {}).items():
            if k.lower() == name.lower():
                return v
        return None


class SealedClient(object):
    """Implements the client side of the spec's wire contract."""

    def __init__(self, port, rest=False):
        self.port = port
        self.rest = rest
        self.seq = 0
        self.channel = None

    # -- transport --

    def _conn(self, timeout=10):
        return http.client.HTTPConnection("127.0.0.1", self.port,
                                          timeout=timeout)

    def _url(self, action, extra=""):
        if self.rest:
            return "/api/" + action + ("?" + extra if extra else "")
        return "/api.php?action=" + action + ("&" + extra if extra else "")

    def open(self):
        self.priv = ec.generate_private_key(ec.SECP256R1())
        self.cpub = self.priv.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint)
        c = self._conn()
        c.request("POST", self._url("seal_open"),
                  body=json.dumps({"pub": base64.b64encode(self.cpub).decode(), "wire": 2}),
                  headers={"Content-Type": "application/json"})
        r = c.getresponse()
        raw = r.read()
        c.close()
        self.open_status = r.status
        if r.status != 200:
            self.open_body = raw
            return r.status
        j = json.loads(raw.decode("utf-8"))
        self.open_reply = j
        if j.get("wire") != 2:
            raise AssertionError("server did not negotiate sealed wire 2")
        self.channel = j["channel"]
        self.spub = base64.b64decode(j["pub"])
        self.identity_der = base64.b64decode(j["identity"])
        self.sig = base64.b64decode(j["sig"])
        spub_key = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), self.spub)
        shared = self.priv.exchange(ec.ECDH(), spub_key)
        salt = self.cpub + self.spub
        self.k_c2s = HKDF(hashes.SHA256(), 32, salt,
                          b"websh sealed c2s").derive(shared)
        self.k_s2c = HKDF(hashes.SHA256(), 32, salt,
                          b"websh sealed s2c").derive(shared)
        return 200

    def verify_identity(self):
        """Raises InvalidSignature when sig does not verify."""
        ident = serialization.load_der_public_key(self.identity_der)
        if len(self.sig) != 64:
            raise InvalidSignature("signature is not raw r||s (64 bytes)")
        r = int.from_bytes(self.sig[:32], "big")
        s = int.from_bytes(self.sig[32:], "big")
        ident.verify(encode_dss_signature(r, s),
                     self.cpub + self.spub + self.channel.encode("ascii") + b":sealed:2",
                     ec.ECDSA(hashes.SHA256()))
        return fingerprint(self.identity_der)

    # -- frames --

    def seal(self, header, body=b"", key=None, aad=None):
        pt = json.dumps(header).encode("utf-8") + b"\n" + body
        iv = os.urandom(12)
        k = key or self.k_c2s
        a = aad if aad is not None else (self.channel + ":c2s").encode("ascii")
        frame = iv + AESGCM(k).encrypt(iv, pt, a)
        if not hasattr(self, "frame_sequences"):
            self.frame_sequences = {}
        self.frame_sequences[frame] = header.get("seq")
        return frame

    def unseal_s2c(self, frame, sequence, index):
        aad = (self.channel + ":s2c:2:%s:%s" % (sequence, index)).encode("ascii")
        return AESGCM(self.k_s2c).decrypt(frame[:12], frame[12:], aad)

    def frame_for(self, action, method="GET", query=None, body=b"",
                  seq=None, extra=None):
        if seq is None:
            self.seq += 1
            seq = self.seq
        hdr = {"seq": seq, "method": method, "action": action,
               "query": {k: str(v) for k, v in (query or {}).items()}}
        if extra:
            hdr.update(extra)
        return self.seal(hdr, body)

    @staticmethod
    def wrap(frame):
        """Revision 2: a c2s frame travels as JSON text, {"f": base64}."""
        return json.dumps({"f": base64.b64encode(frame).decode("ascii")}).encode()

    def post_frame(self, frame, channel=None, timeout=15, raw_body=None,
                   ctype="application/json"):
        """Send a c2s frame (or, with raw_body, exactly those bytes);
        return (HTTPConnection, HTTPResponse)."""
        c = self._conn(timeout=timeout)
        c.request("POST", self._url("sealed", "c=" + (channel or self.channel)),
                  body=self.wrap(frame) if raw_body is None else raw_body,
                  headers={"Content-Type": ctype})
        response = c.getresponse()
        response.sealed_sequence = getattr(self, "frame_sequences", {}).get(frame)
        response.sealed_index = 0
        return c, response

    def read_frame(self, resp):
        """Next s2c plaintext, or None at a clean EOF between events.
        Revision 2: the reply is text/event-stream, one `data: <base64>`
        event per frame."""
        data = []
        while True:
            line = resp.readline()
            if not line:
                if data:
                    raise Truncated("cut inside an event")
                return None
            if not line.endswith(b"\n"):
                raise Truncated("cut inside a line")
            line = line.rstrip(b"\r\n")
            if line == b"":
                if not data:
                    continue            # a stray blank line
                b = b"".join(data)
                plaintext = self.unseal_s2c(base64.b64decode(b, validate=True),
                                             resp.sealed_sequence, resp.sealed_index)
                resp.sealed_index += 1
                return plaintext
            if line.startswith(b":"):
                continue                # SSE comment
            if line.startswith(b"data:"):
                v = line[5:]
                if v.startswith(b" "):
                    v = v[1:]
                data.append(v)
            # other fields (event:, id:, retry:) carry nothing here

    def request(self, action, method="GET", query=None, body=b"", seq=None,
                extra=None, channel=None, frame=None, timeout=15):
        if frame is None:
            frame = self.frame_for(action, method, query, body, seq, extra)
        c, r = self.post_frame(frame, channel=channel, timeout=timeout)
        try:
            if r.status != 200:
                return SealedReply(r.status, r.read())
            self.last_outer_headers = dict((k.lower(), v) for k, v in r.getheaders())
            first = self.read_frame(r)
            if first is None:
                raise Truncated("no header frame")
            header = json.loads(first.decode("utf-8"))
            chunks = []
            while True:
                pt = self.read_frame(r)
                if pt is None:
                    return SealedReply(200, header=header, chunks=chunks,
                                       clean_end=False)
                if pt == b"":
                    rest = r.read()
                    if rest:
                        raise AssertionError(
                            "bytes after the end frame: %r" % rest[:40])
                    return SealedReply(200, header=header, chunks=chunks,
                                       clean_end=True)
                chunks.append(pt)
        finally:
            c.close()

    def post_json(self, action, obj, **kw):
        return self.request(action, "POST", kw.pop("query", None),
                            json.dumps(obj).encode("utf-8"), **kw)

    def open_stream(self, action, query, timeout=15):
        """Start a never-ending sealed request (the SSE stream). Returns
        (conn, resp, header); read more with read_frame(resp)."""
        frame = self.frame_for(action, "GET", query)
        c, r = self.post_frame(frame, timeout=timeout)
        if r.status != 200:
            body = r.read()
            c.close()
            raise AssertionError("stream: outer %d %r" % (r.status, body[:200]))
        header = json.loads(self.read_frame(r).decode("utf-8"))
        return c, r, header


class SseText(object):
    """Collect terminal output from sealed SSE chunks."""

    def __init__(self):
        self.buf = b""
        self.text = b""
        self.events = []

    def feed(self, chunk):
        self.buf += chunk
        while b"\n\n" in self.buf:
            ev, self.buf = self.buf.split(b"\n\n", 1)
            data = None
            for line in ev.split(b"\n"):
                if line.startswith(b"data: "):
                    data = json.loads(line[6:].decode("utf-8"))
            if data is None:
                continue
            self.events.append(data)
            if data.get("data"):
                self.text += base64.b64decode(data["data"])


# ── fake ssh: a real PTY shell and real side-channel snippets ───────

FAKE_SSH = r"""#!/bin/sh
# Test double for ssh (tests/backend/test_sealed.py). Never a network.
for a in "$@"; do [ "$a" = "-O" ] && exit 0; done
mux=0; cp=""
for a in "$@"; do
  case "$a" in
    ControlPath=*) cp="${a#ControlPath=}";;
    -T) mux=1;;
  esac
done
export HOME="$FAKE_SSH_HOME"
cd "$HOME" || exit 1
if [ $mux = 1 ]; then
  for last in "$@"; do :; done
  if [ -n "$FAKE_SSH_SLOW" ]; then
    # A slow link: the remote output trickles out, 256 KiB every 0.15 s.
    /bin/sh -c "$last" | python3 -c 'import sys, time
while True:
    d = sys.stdin.buffer.read1(262144)
    if not d:
        break
    sys.stdout.buffer.write(d); sys.stdout.buffer.flush(); time.sleep(0.15)'
    exit $?
  fi
  exec /bin/sh -c "$last"
fi
[ -n "$cp" ] && : > "$cp"
PS1='$ ' ENV= exec /bin/sh -i
"""


class _FakeSshCase(LiveServerCase):
    """LiveServerCase with `ssh` replaced by FAKE_SSH and a Prompt
    connection whose credentials travel in the connect body."""

    CONFIG = {"connections": [{"name": "target", "host": "target.example"}]}
    USER = "sealeduser"
    PASSWORD = "Pw-SEALED-7f3a9c"

    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp(prefix="websh-sealed-")
        cls.home = os.path.join(cls.work, "home")
        os.makedirs(cls.home)
        bindir = os.path.join(cls.work, "bin")
        os.makedirs(bindir)
        p = os.path.join(bindir, "ssh")
        with open(p, "w") as f:
            f.write(FAKE_SSH)
        os.chmod(p, 0o755)
        cls.key_file = os.path.join(cls.work, "id", "websh.sealed.key")
        os.makedirs(os.path.dirname(cls.key_file))
        cls.ENV = {
            "PATH": bindir + os.pathsep + os.environ.get("PATH", ""),
            "FAKE_SSH_HOME": cls.home,
            "WEBSH_SEALED_KEY_FILE": cls.key_file,
        }
        cls.GLOBALS = {"SIDE_CHANNEL_RATE_MAX": 100000}
        # LiveServerCase.tearDownClass POPS every ENV key it set - PATH
        # included, which would leave the rest of the suite without one.
        cls._saved_env = {k: os.environ.get(k) for k in cls.ENV}
        super().setUpClass()
        cls.tap = WireTap(cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.tap.close()
        with server.sessions_lock:
            mine = list(server.sessions.items())
        for sid, s in mine:
            try:
                s.close()
            except Exception:
                pass
            server.sessions.pop(sid, None)
        super().tearDownClass()
        for k, v in cls._saved_env.items():
            if v is not None:
                os.environ[k] = v
        shutil.rmtree(cls.work, ignore_errors=True)

    def setUp(self):
        server._rate_limits.clear()
        server._side_channel_rate_limits.clear()

    def client(self, rest=False, via_tap=True):
        c = SealedClient(self.tap.port if via_tap else self.port, rest=rest)
        self.assertEqual(c.open(), 200, "seal_open: %r" % getattr(c, "open_body", b""))
        return c

    def sealed_connect(self, c):
        r = c.post_json("connect", {
            "connection": "target", "username": self.USER,
            "password": self.PASSWORD, "cols": 80, "rows": 24})
        self.assertEqual(r.outer_status, 200, r.outer_json())
        self.assertEqual(r.status, 200, r.body[:300])
        sid = r.json().get("session_id")
        self.assertTrue(sid, r.json())
        self.addCleanup(self._drop, sid)
        return sid

    def _drop(self, sid):
        with server.sessions_lock:
            s = server.sessions.pop(sid, None)
        if s is not None:
            try:
                s.close()
            except Exception:
                pass

    def stream_until(self, c, sid, needle, timeout=10, since=0):
        """Open the sealed SSE stream and read until `needle` appears in
        the terminal output. Returns the SseText."""
        conn, resp, header = c.open_stream(
            "stream", {"session_id": sid, "since": since}, timeout=timeout)
        self.assertEqual(header.get("status"), 200, header)
        out = SseText()
        deadline = time.time() + timeout
        try:
            while needle not in out.text:
                if time.time() > deadline:
                    self.fail("not seen in %ds: %r; got %r"
                              % (timeout, needle, out.text[-300:]))
                pt = c.read_frame(resp)
                if pt is None or pt == b"":
                    self.fail("stream ended before %r appeared: %r"
                              % (needle, out.text[-300:]))
                out.feed(pt)
        finally:
            conn.close()
        return out


class _RecSession(_FakeNotifyMixin):
    """A planted session that records what reaches its PTY."""

    def __init__(self, sid):
        self.id = sid
        self.alive = True
        self.auth_failed = False
        self.owner = ""
        self.client_ip = "127.0.0.1"
        self.is_background = False
        self.persistent = False
        self.slot_id = None
        self.last_activity = time.time()
        self._replay_end = 0
        self._host = "h.example"
        self.writes = []

    def write(self, data):
        self.writes.append(data)
        return True

    def resize(self, cols, rows):
        self.writes.append(("resize", cols, rows))

    def is_expired(self):
        return False

    def close(self):
        pass


# ═════════════════════════════════════════════════════════════════════
# Handshake, identity, config

@NEEDS_CRYPTO
class TestSealedHandshake(_FakeSshCase):

    def test_old_or_missing_wire_version_is_refused_before_dispatch(self):
        key = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        for wire in (None, 1, 99):
            body = {"pub": base64.b64encode(key).decode()}
            if wire is not None:
                body["wire"] = wire
            status, raw = self._request_raw("/api.php?action=seal_open",
                data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            self.assertEqual(status, 409, (wire, raw))
            self.assertEqual(json.loads(raw)["code"], "sealed_upgrade_required")

    def test_every_response_frame_is_bound_to_request_and_position(self):
        client = self.client()
        frame = client.frame_for("tmux_capture", query={"session_id": str(uuid.uuid4())})
        sequence = client.seq
        conn, response = client.post_frame(frame)
        try:
            self.assertEqual(response.status, 200)
            events = re.findall(rb"data: ([A-Za-z0-9+/=]+)\n\n", response.read())
            self.assertGreaterEqual(len(events), 3)
            for index, event in enumerate(events):
                raw = base64.b64decode(event)
                plaintext = client.unseal_s2c(raw, sequence, index)
                if index == len(events) - 1:
                    self.assertEqual(plaintext, b"")
                with self.assertRaises(InvalidTag):
                    client.unseal_s2c(raw, sequence + 1, index)
                with self.assertRaises(InvalidTag):
                    client.unseal_s2c(raw, sequence, index + 1)
        finally:
            conn.close()

    def test_config_reports_available_with_the_identity_fingerprint(self):
        body, code = self._get("/api/config")
        self.assertEqual(code, 200)
        self.assertIn("sealed", body, "config has no 'sealed' object")
        self.assertIs(body["sealed"].get("available"), True, body["sealed"])
        self.assertRegex(body["sealed"].get("identity") or "", FP_RE)
        self.assertEqual(body["proto"], 1, "sealed is additive: proto stays 1")

    def test_handshake_signature_verifies_against_the_identity(self):
        c = self.client()
        self.assertRegex(c.channel, CHANNEL_RE)
        self.assertEqual(len(c.spub), 65, "server pub is raw uncompressed P-256")
        self.assertEqual(c.spub[:1], b"\x04")
        fp = c.verify_identity()
        body, _ = self._get("/api/config")
        self.assertEqual(fp, body["sealed"]["identity"],
                         "the identity in seal_open is the one /api/config names")

    def test_signature_binds_the_client_key_and_the_channel(self):
        # The signature must cover client_pub || server_pub || channel:
        # a MITM that swaps any one of them cannot reuse it.
        c = self.client()
        c.verify_identity()
        ident = serialization.load_der_public_key(c.identity_der)
        r = int.from_bytes(c.sig[:32], "big")
        s = int.from_bytes(c.sig[32:], "big")
        der = encode_dss_signature(r, s)
        other = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        for name, msg in (
                ("another client key", other + c.spub + c.channel.encode()),
                ("another server key", c.cpub + other + c.channel.encode()),
                ("another channel", c.cpub + c.spub + ("0" * 32).encode())):
            with self.assertRaises(InvalidSignature, msg=name):
                ident.verify(der, msg, ec.ECDSA(hashes.SHA256()))

    def test_every_channel_gets_fresh_keys(self):
        a, b = self.client(), self.client()
        self.assertNotEqual(a.channel, b.channel)
        self.assertNotEqual(a.spub, b.spub, "server ephemeral key reused")
        self.assertEqual(a.identity_der, b.identity_der, "one identity")

    def test_rest_path_works_too(self):
        c = self.client(rest=True)
        c.verify_identity()
        r = c.request("tmux_capture", query={"session_id": str(uuid.uuid4())})
        self.assertEqual(r.outer_status, 200)
        self.assertEqual(r.status, 404, "inner answer for an unknown session")

    def test_bad_client_key_is_400(self):
        for pub in ("", "!!notbase64", base64.b64encode(b"\x04" + b"\x00" * 64).decode(),
                    base64.b64encode(b"\x04" + b"\x01" * 10).decode()):
            code, raw = self._request_raw(
                "/api.php?action=seal_open",
                data=json.dumps({"pub": pub, "wire": 2}).encode(),
                headers={"Content-Type": "application/json"})
            self.assertEqual(code, 400, (pub, raw[:200]))
        code, raw = self._request_raw(
            "/api.php?action=seal_open", data=b'{"wire":2}',
            headers={"Content-Type": "application/json"})
        self.assertEqual(code, 400, raw[:200])

    def test_seal_open_is_rate_limited_per_ip(self):
        old = server.SIDE_CHANNEL_RATE_MAX
        server.SIDE_CHANNEL_RATE_MAX = 0
        server._side_channel_rate_limits.clear()
        try:
            c = SealedClient(self.port)
            self.assertEqual(c.open(), 429, getattr(c, "open_body", b""))
        finally:
            server.SIDE_CHANNEL_RATE_MAX = old
            server._side_channel_rate_limits.clear()

    # Key file creation, mode and reuse: TestSealedIdentityLifecycle (a
    # real server process - the identity is loaded once per process, so
    # an in-process class cannot choose where it lives).


# ═════════════════════════════════════════════════════════════════════
# The real server process: startup log, key file, restarts

class _ChildServer(object):
    def __init__(self, env, block_crypto=False):
        self.port = _free_port()
        self.err = tempfile.NamedTemporaryFile(delete=False, suffix=".log")
        e = dict(os.environ)
        e.pop("WEBSH_CONFIG", None)
        e.update({"PORT": str(self.port), "HOST": "127.0.0.1",
                  "WEBSH_CONFIG": "/nonexistent/websh.json"})
        e.update(env)
        if block_crypto:
            code = ("import sys, runpy; sys.modules['cryptography'] = None; "
                    "sys.argv = ['server.py']; "
                    "runpy.run_path('server.py', run_name='__main__')")
            argv = [sys.executable, "-c", code]
        else:
            argv = [sys.executable, "server.py"]
        self.proc = subprocess.Popen(argv, cwd=REPO_ROOT, env=e,
                                     stdout=self.err, stderr=self.err)
        deadline = time.time() + 10
        while True:
            try:
                c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
                c.request("GET", "/api/ping")
                c.getresponse().read()
                c.close()
                return
            except OSError:
                if self.proc.poll() is not None or time.time() > deadline:
                    self.stop()
                    raise AssertionError("child server did not start: "
                                         + self.log())
                time.sleep(0.05)

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", path)
        r = c.getresponse()
        return r.status, r.read()

    def post(self, path, body, ctype="application/json"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", path, body=body, headers={"Content-Type": ctype})
        r = c.getresponse()
        return r.status, r.read()

    def log(self):
        with open(self.err.name, "rb") as f:
            return f.read().decode("utf-8", "replace")

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def close(self):
        self.stop()
        try:
            os.unlink(self.err.name)
        except OSError:
            pass


@NEEDS_CRYPTO
class TestSealedIdentityLifecycle(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websh-sealed-id-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _start(self, env):
        s = _ChildServer(env)
        self.addCleanup(s.close)
        return s

    def _identity(self, s):
        code, raw = s.get("/api/config")
        self.assertEqual(code, 200)
        return json.loads(raw.decode())["sealed"]["identity"]

    def test_startup_logs_the_fingerprint_and_it_matches_config(self):
        key = os.path.join(self.tmp, "k.pem")
        s = self._start({"WEBSH_SEALED_KEY_FILE": key,
                         "WEBSH_CREDS_PATH": os.path.join(self.tmp, "c.json")})
        fp = self._identity(s)
        self.assertRegex(fp or "", FP_RE)
        deadline = time.time() + 3
        while "sealed channel" not in s.log() and time.time() < deadline:
            time.sleep(0.05)
        self.assertIn("[INFO] sealed channel: identity " + fp, s.log())

    def test_key_file_is_created_0600_and_reused_across_restarts(self):
        key = os.path.join(self.tmp, "k.pem")
        env = {"WEBSH_SEALED_KEY_FILE": key,
               "WEBSH_CREDS_PATH": os.path.join(self.tmp, "c.json")}
        s = self._start(env)
        fp1 = self._identity(s)
        self.assertTrue(os.path.exists(key), "key created at first start")
        self.assertEqual(stat.S_IMODE(os.stat(key).st_mode), 0o600)
        with open(key, "rb") as f:
            pem1 = f.read()
        s.stop()
        s2 = self._start(env)
        self.assertEqual(self._identity(s2), fp1,
                         "a restart must not change the identity (every "
                         "browser's pin would break)")
        with open(key, "rb") as f:
            self.assertEqual(f.read(), pem1, "the key file is not rewritten")

    def test_default_key_path_is_next_to_the_vault_store(self):
        d = os.path.join(self.tmp, "state")
        os.makedirs(d)
        s = self._start({"WEBSH_CREDS_PATH": os.path.join(d, "websh.creds.json"),
                         "WEBSH_SEALED_KEY_FILE": ""})
        self._identity(s)
        p = os.path.join(d, "websh.sealed.key")
        self.assertTrue(os.path.exists(p), "default key path " + p)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)

    def test_available_without_the_vault(self):
        s = self._start({"WEBSH_SEALED_KEY_FILE": os.path.join(self.tmp, "k"),
                         "WEBSH_CREDS_PATH": os.path.join(self.tmp, "c.json"),
                         "WEBSH_VAULT_ENABLE": "0"})
        code, raw = s.get("/api/config")
        self.assertIs(json.loads(raw.decode())["sealed"]["available"], True)


class TestSealedUnavailable(unittest.TestCase):
    """Without `cryptography` (a CI leg, and some hosts): the mode is
    reported unavailable and its endpoints say so; nothing else moves."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websh-sealed-nc-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.s = _ChildServer({
            "WEBSH_SEALED_KEY_FILE": os.path.join(self.tmp, "k.pem"),
            "WEBSH_CREDS_PATH": os.path.join(self.tmp, "c.json")},
            block_crypto=True)
        self.addCleanup(self.s.close)

    def test_config_says_unavailable(self):
        code, raw = self.s.get("/api/config")
        self.assertEqual(code, 200)
        cfg = json.loads(raw.decode())
        self.assertEqual(cfg.get("sealed"), {"available": False, "identity": None, "wire": 2})
        self.assertEqual(cfg["proto"], 1)

    def test_seal_open_and_sealed_answer_501(self):
        code, raw = self.s.post("/api.php?action=seal_open",
                                json.dumps({"pub": base64.b64encode(b"\x04" * 65).decode(), "wire": 2}))
        self.assertEqual(code, 501, raw)
        self.assertEqual(json.loads(raw.decode()), {"error": "sealed mode unavailable"})
        code, raw = self.s.post("/api.php?action=sealed&c=" + "a" * 32,
                                json.dumps({"f": base64.b64encode(b"\x00" * 64).decode()}))
        self.assertEqual(code, 501, raw)
        self.assertEqual(json.loads(raw.decode()), {"error": "sealed mode unavailable"})
        code, raw = self.s.post("/api/seal_open", b"{}")
        self.assertEqual(code, 501, raw)

    def test_no_key_file_and_no_log_line_without_cryptography(self):
        self.s.get("/api/ping")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "k.pem")))
        self.assertNotIn("sealed channel: identity", self.s.log())

    def test_everything_else_unchanged(self):
        code, raw = self.s.get("/api/ping")
        self.assertEqual(code, 200)
        code, raw = self.s.get("/")
        self.assertEqual(code, 200)


# ═════════════════════════════════════════════════════════════════════
# Round trips through a real PTY shell and the real side-channel snippets

@NEEDS_CRYPTO
class TestSealedRoundTrip(_FakeSshCase):

    def test_connect_type_and_see_the_echo_over_the_sealed_stream(self):
        c = self.client()
        sid = self.sealed_connect(c)
        self.stream_until(c, sid, b"$ ")
        r = c.post_json("input", {"session_id": sid,
                                  "data": "echo SEALMARK_$((6*7))_ok\n"})
        self.assertEqual(r.status, 200, r.body)
        self.assertTrue(r.json().get("ok"), r.json())
        self.assertIsInstance(r.json().get("cursor"), int,
                              "the input reply carries the output cursor (O3)")
        out = self.stream_until(c, sid, b"SEALMARK_42_ok")
        self.assertIn(b"SEALMARK_42_ok", out.text)

    def test_stream_frames_arrive_while_the_request_is_open(self):
        # The SSE stream never ends; if the sealed wrapper buffered the
        # inner response, nothing would arrive at all.
        c = self.client()
        sid = self.sealed_connect(c)
        conn, resp, header = c.open_stream("stream", {"session_id": sid, "since": 0})
        try:
            self.assertEqual(header["status"], 200)
            ctype = ""
            for k, v in header.get("headers", {}).items():
                if k.lower() == "content-type":
                    ctype = v
            self.assertIn("text/event-stream", ctype, header)
            out = SseText()
            while b"$ " not in out.text:
                out.feed(c.read_frame(resp))
            # Now type on a second request while this one is still open.
            c.post_json("input", {"session_id": sid, "data": "echo LIVE_$((1+1))\n"})
            while b"LIVE_2" not in out.text:
                pt = c.read_frame(resp)
                self.assertTrue(pt, "stream ended")
                out.feed(pt)
        finally:
            conn.close()

    def test_output_long_poll_resize_and_disconnect(self):
        c = self.client()
        sid = self.sealed_connect(c)
        r = c.post_json("input", {"session_id": sid, "data": "echo POLL_$((2*3))\n"})
        self.assertEqual(r.status, 200)
        got = b""
        cursor = 0
        deadline = time.time() + 10
        while b"POLL_6" not in got and time.time() < deadline:
            r = c.request("output", query={"session_id": sid, "since": cursor})
            self.assertEqual(r.status, 200, r.body)
            j = r.json()
            if j.get("data"):
                got += base64.b64decode(j["data"])
            if isinstance(j.get("cursor"), int):
                cursor = j["cursor"]
        self.assertIn(b"POLL_6", got)
        r = c.post_json("resize", {"session_id": sid, "cols": 100, "rows": 30})
        self.assertEqual(r.status, 200, r.body)
        r = c.post_json("disconnect", {"session_id": sid})
        self.assertEqual(r.status, 200, r.body)
        with server.sessions_lock:
            self.assertNotIn(sid, server.sessions)

    def test_ls_and_download(self):
        c = self.client()
        sid = self.sealed_connect(c)
        d = os.path.join(self.home, "proj-Zq81")
        os.makedirs(d, exist_ok=True)
        payload = os.urandom(300000) + b"FILEBODY-MARK-5521"
        with open(os.path.join(d, "secret-plan-Q7.bin"), "wb") as f:
            f.write(payload)
        r = c.request("ls", query={"session_id": sid, "path": d})
        self.assertEqual(r.status, 200, r.body[:300])
        names = [e["name"] for e in r.json()["entries"]]
        self.assertIn("secret-plan-Q7.bin", names)
        self.assertEqual(r.json()["path"], d)
        r = c.request("download", query={"session_id": sid,
                                         "path": os.path.join(d, "secret-plan-Q7.bin")})
        self.assertEqual(r.status, 200, r.body[:300])
        self.assertTrue(r.clean_end)
        self.assertEqual(r.body, payload, "downloaded bytes identical")
        self.assertEqual(r.header_value("Content-Length"), str(len(payload)))
        self.assertIn("secret-plan-Q7.bin", r.header_value("Content-Disposition") or "")

    def _upload(self, c, sid, rel, data, piece, pad_pieces=0, offset0=0):
        """Upload `data` as sealed pieces of exactly `piece` bytes of
        plaintext body each (padded with random bytes), then `pad_pieces`
        padding-only pieces. Returns the replies."""
        replies = []
        off = offset0
        while off < len(data):
            chunk = data[off:off + piece]
            body = chunk + os.urandom(piece - len(chunk))
            r = c.request("upload", "POST",
                          {"session_id": sid, "path": rel, "offset": off},
                          body, extra={"len": len(chunk)})
            replies.append(r)
            if r.status != 200:
                return replies
            off += len(chunk)
        for _ in range(pad_pieces):
            r = c.request("upload", "POST",
                          {"session_id": sid, "path": rel, "offset": off},
                          os.urandom(piece), extra={"len": 0, "pad": True})
            replies.append(r)
        return replies

    def test_padded_upload_lands_byte_identical(self):
        c = self.client()
        sid = self.sealed_connect(c)
        data = os.urandom(150000) + b"UPLOAD-MARK-9031"
        replies = self._upload(c, sid, ".websh-tmp-sealed1", data, 65536,
                               pad_pieces=2)
        for r in replies:
            self.assertEqual(r.outer_status, 200, r.outer_body)
            self.assertEqual(r.status, 200, r.body[:300])
        with open(os.path.join(self.home, ".websh-tmp-sealed1"), "rb") as f:
            got = f.read()
        self.assertEqual(len(got), len(data), "only `len` bytes of each piece written")
        self.assertEqual(got, data, "byte-identical")
        dest = os.path.join(self.home, "inbox")
        os.makedirs(dest, exist_ok=True)
        r = c.post_json("upload_finalize", {"session_id": sid,
                                            "tmp": ".websh-tmp-sealed1",
                                            "final": "secret-plan-Q7.bin",
                                            "dir": dest})
        self.assertEqual(r.status, 200, r.body[:300])
        with open(os.path.join(dest, "secret-plan-Q7.bin"), "rb") as f:
            self.assertEqual(f.read(), data)

    def test_padding_only_pieces_never_touch_the_file(self):
        c = self.client()
        sid = self.sealed_connect(c)
        p = os.path.join(self.home, ".websh-tmp-padonly")
        data = b"0123456789"
        self._upload(c, sid, ".websh-tmp-padonly", data, 4096)
        st = os.stat(p)
        for off in (10, 10, 0, 999):
            r = c.request("upload", "POST",
                          {"session_id": sid, "path": ".websh-tmp-padonly",
                           "offset": off},
                          os.urandom(4096), extra={"len": 0, "pad": True})
            self.assertEqual(r.status, 200, (off, r.body[:200]))
        with open(p, "rb") as f:
            self.assertEqual(f.read(), data, "a pad piece (even at offset 0) "
                             "neither truncates nor appends")
        self.assertEqual(os.stat(p).st_mtime_ns, st.st_mtime_ns)

    def test_resume_by_offset_still_works_padded(self):
        c = self.client()
        sid = self.sealed_connect(c)
        data = os.urandom(20000)
        self._upload(c, sid, ".websh-tmp-resume", data[:8192], 8192)
        # A piece at the wrong offset: 409 with the real size, file untouched.
        r = c.request("upload", "POST",
                      {"session_id": sid, "path": ".websh-tmp-resume",
                       "offset": 16384},
                      data[16384:] + os.urandom(8192 - len(data[16384:])),
                      extra={"len": len(data[16384:])})
        self.assertEqual(r.status, 409, r.body[:200])
        self.assertEqual(r.json().get("size"), 8192)
        self._upload(c, sid, ".websh-tmp-resume", data, 8192, offset0=8192)
        with open(os.path.join(self.home, ".websh-tmp-resume"), "rb") as f:
            self.assertEqual(f.read(), data)

    def test_len_beyond_the_piece_is_refused_and_writes_nothing(self):
        c = self.client()
        sid = self.sealed_connect(c)
        r = c.request("upload", "POST",
                      {"session_id": sid, "path": ".websh-tmp-badlen", "offset": 0},
                      b"x" * 100, extra={"len": 101})
        refused = r.outer_status == 400 or (r.outer_status == 200 and 400 <= r.status < 500)
        self.assertTrue(refused, (r.outer_status, r.status, r.body[:200]))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".websh-tmp-badlen")))

    def test_save_and_tmux_options_and_rm_mkdir_mv_dispatch_inside(self):
        c = self.client()
        sid = self.sealed_connect(c)
        base = os.path.join(self.home, "fs-ops")
        os.makedirs(base, exist_ok=True)
        r = c.post_json("mkdir", {"session_id": sid, "path": os.path.join(base, "d1")})
        self.assertEqual(r.status, 200, r.body[:200])
        self.assertTrue(os.path.isdir(os.path.join(base, "d1")))
        r = c.post_json("mv", {"session_id": sid, "path": os.path.join(base, "d1"),
                               "name": "d2"})
        self.assertEqual(r.status, 200, r.body[:200])
        r = c.post_json("rm", {"session_id": sid, "path": os.path.join(base, "d2")})
        self.assertEqual(r.status, 200, r.body[:200])
        self.assertEqual(os.listdir(base), [])


# ═════════════════════════════════════════════════════════════════════
# What must never execute

@NEEDS_CRYPTO
class TestSealedRefusals(_FakeSshCase):

    def _plant(self):
        sid = str(uuid.uuid4())
        s = _RecSession(sid)
        with server.sessions_lock:
            server.sessions[sid] = s
        self.addCleanup(self._drop, sid)
        return sid, s

    def test_a_replayed_frame_is_400_and_not_executed(self):
        c = self.client()
        sid, s = self._plant()
        frame = c.frame_for("input", "POST", None,
                            json.dumps({"session_id": sid, "data": "rm -rf x\r"}).encode())
        r1 = c.request(None, frame=frame)
        self.assertEqual(r1.status, 200, r1.body)
        r2 = c.request(None, frame=frame)
        self.assertEqual(r2.outer_status, 400, r2.outer_body)
        self.assertEqual(r2.outer_json(), {"error": "replay"})
        self.assertEqual(s.writes, [b"rm -rf x\r"], "typed once, never twice")

    def test_a_reused_seq_with_new_content_is_replay(self):
        c = self.client()
        sid, s = self._plant()
        c.post_json("input", {"session_id": sid, "data": "a"}, seq=7)
        r = c.post_json("input", {"session_id": sid, "data": "b"}, seq=7)
        self.assertEqual(r.outer_status, 400)
        self.assertEqual(r.outer_json(), {"error": "replay"})
        self.assertEqual(s.writes, [b"a"])

    def test_seq_far_below_the_highest_is_replay_near_is_fine(self):
        c = self.client()
        sid, s = self._plant()
        c.post_json("input", {"session_id": sid, "data": "1"}, seq=10000)
        r = c.post_json("input", {"session_id": sid, "data": "2"}, seq=10000 - 4097)
        self.assertEqual(r.outer_status, 400, "more than 4096 below the highest")
        self.assertEqual(r.outer_json(), {"error": "replay"})
        r = c.post_json("input", {"session_id": sid, "data": "3"}, seq=9990)
        self.assertEqual(r.status, 200, "unseen and inside the window: accepted "
                         "(requests overtake each other on HTTP/2)")
        self.assertEqual(s.writes, [b"1", b"3"])

    def test_a_tampered_frame_is_400_and_not_executed(self):
        c = self.client()
        sid, s = self._plant()
        good = c.frame_for("input", "POST", None,
                           json.dumps({"session_id": sid, "data": "X"}).encode())
        for i in (0, 12, len(good) // 2, len(good) - 1):
            bad = bytearray(good)
            bad[i] ^= 0x01
            r = c.request(None, frame=bytes(bad))
            self.assertEqual(r.outer_status, 400, i)
            self.assertEqual(r.outer_json(), {"error": "bad frame"})
        for bad in (b"", good[:20], good[:-1]):
            r = c.request(None, frame=bad)
            self.assertEqual(r.outer_status, 400, len(bad))
        self.assertEqual(s.writes, [])
        # The untouched frame still works: a bad frame does not burn its seq.
        self.assertEqual(c.request(None, frame=good).status, 200)
        self.assertEqual(s.writes, [b"X"])

    def test_wrong_direction_or_channel_aad_is_bad_frame(self):
        c = self.client()
        sid, s = self._plant()
        hdr = {"seq": 1, "method": "POST", "action": "input", "query": {}}
        body = json.dumps({"session_id": sid, "data": "Y"}).encode()
        for aad in ((c.channel + ":s2c").encode(), b"0" * 32 + b":c2s", b""):
            r = c.request(None, frame=c.seal(hdr, body, aad=aad))
            self.assertEqual(r.outer_status, 400, aad)
        r = c.request(None, frame=c.seal(hdr, body, key=c.k_s2c))
        self.assertEqual(r.outer_status, 400, "s2c key used for c2s")
        self.assertEqual(s.writes, [])

    def test_a_cut_body_is_the_truncation_signal_and_not_executed(self):
        # O7b: a proxy that cuts the request body. The client recognises
        # "client sent fewer bytes than Content-Length" (nginx says the
        # same) and shrinks its upload pieces; nothing may run.
        c = self.client(via_tap=False)
        sid, s = self._plant()
        fr = c.wrap(c.frame_for("input", "POST", None,
                                json.dumps({"session_id": sid, "data": "CUT"}).encode()))
        k = socket.create_connection(("127.0.0.1", self.port), timeout=20)
        try:
            k.sendall((
                "POST /api.php?action=sealed&c={} HTTP/1.1\r\nHost: x\r\n"
                "Content-Type: application/json\r\n"
                "Content-Length: {}\r\n\r\n".format(c.channel, len(fr) + 5000)
            ).encode() + fr)
            k.shutdown(socket.SHUT_WR)
            data = b""
            while True:
                d = k.recv(65536)
                if not d:
                    break
                data += d
        finally:
            k.close()
        head, _, body = data.partition(b"\r\n\r\n")
        self.assertRegex(head.split(b"\r\n")[0], rb" 400 ", head[:200])
        self.assertIn(b"client sent fewer bytes than Content-Length", body)
        self.assertEqual(s.writes, [])

    def test_a_bad_json_wrapper_is_bad_frame_and_not_executed(self):
        c = self.client()
        sid, s = self._plant()
        good = c.frame_for("input", "POST", None,
                           json.dumps({"session_id": sid, "data": "W"}).encode())
        b64 = base64.b64encode(good).decode()
        for what, body in (
                ("not JSON", b"{\"f\": "),
                ("JSON but not an object", json.dumps([b64]).encode()),
                ("no f", json.dumps({"g": b64}).encode()),
                ("f not a string", json.dumps({"f": 12}).encode()),
                ("f not base64", json.dumps({"f": "!!!" + b64[3:]}).encode()),
                ("the frame in binary (the old format)", good)):
            for ctype in ("application/json", "application/octet-stream"):
                cn, r = c.post_frame(None, raw_body=body, ctype=ctype)
                raw = r.read()
                cn.close()
                self.assertEqual(r.status, 400, (what, ctype, raw[:120]))
                if ctype == "application/json":
                    self.assertEqual(json.loads(raw.decode()), {"error": "bad frame"}, what)
        self.assertEqual(s.writes, [], "nothing executed")
        # The well-formed one still works (no seq burned by the bad ones).
        self.assertEqual(c.request(None, frame=good).status, 200)
        self.assertEqual(s.writes, [b"W"])

    def test_the_reply_is_an_unbuffered_event_stream(self):
        c = self.client()
        sid, s = self._plant()
        r = c.post_json("input", {"session_id": sid, "data": "h"})
        self.assertEqual(r.status, 200)
        h = c.last_outer_headers
        self.assertTrue(h.get("content-type", "").startswith("text/event-stream"), h)
        self.assertEqual(h.get("cache-control"), "no-cache", h)
        self.assertEqual(h.get("x-accel-buffering"), "no", h)

    def test_unknown_channel_is_410_and_not_executed(self):
        c = self.client()
        sid, s = self._plant()
        frame = c.frame_for("input", "POST", None,
                            json.dumps({"session_id": sid, "data": "Z"}).encode())
        for ch in ("0" * 32, uuid.uuid4().hex):
            r = c.request(None, frame=frame, channel=ch)
            self.assertEqual(r.outer_status, 410, ch)
            self.assertEqual(r.outer_json(), {"error": "channel unknown"})
        self.assertEqual(s.writes, [])

    def test_oldest_channel_is_dropped_beyond_2000(self):
        first = self.client(via_tap=False)
        sid, s = self._plant()
        for _ in range(2000):
            SealedClient(self.port).open()
        r = first.post_json("input", {"session_id": sid, "data": "late"})
        self.assertEqual(r.outer_status, 410, "2001st channel pushed out the oldest")
        self.assertEqual(s.writes, [])

    def test_forbidden_inner_actions_are_400(self):
        c = self.client()
        for action, method in (("seal_open", "POST"), ("sealed", "POST"),
                               ("config", "GET"), ("ping", "GET"),
                               ("client_diag", "POST"), ("websh.js", "GET"),
                               ("index.html", "GET")):
            body = b"{}" if method == "POST" else b""
            r = c.request(action, method, {}, body)
            refused = r.outer_status == 400 or (r.outer_status == 200 and r.status == 400)
            self.assertTrue(refused, (action, r.outer_status, r.status, r.body[:120]))
            self.assertNotIn(b"restrict_hosts", r.body, action + ": config leaked")
            self.assertNotIn(b"\"version\"", r.body, action)
            self.assertNotIn(b"<html", r.body.lower(), action)

    def test_inner_requests_are_rate_limited_like_plain_ones(self):
        c = self.client()
        old = server.SIDE_CHANNEL_RATE_MAX
        server.SIDE_CHANNEL_RATE_MAX = 0
        server._side_channel_rate_limits.clear()
        try:
            r = c.request("ls", query={"session_id": str(uuid.uuid4())})
            self.assertEqual(r.outer_status, 200)
            self.assertEqual(r.status, 429, r.body[:200])
        finally:
            server.SIDE_CHANNEL_RATE_MAX = old

    def test_every_dispatched_reply_ends_with_a_clean_end_frame(self):
        c = self.client()
        sid, s = self._plant()
        for action, method, q, body in (
                ("input", "POST", None, json.dumps({"session_id": sid, "data": "q"}).encode()),
                ("input", "POST", None, json.dumps({"session_id": "nope", "data": "q"}).encode()),
                ("ls", "GET", {"session_id": str(uuid.uuid4())}, b""),
                ("nonexistent_action", "GET", {}, b"")):
            r = c.request(action, method, q, body)
            self.assertEqual(r.outer_status, 200, action)
            self.assertIs(r.clean_end, True, action)
            self.assertIsInstance(r.status, int)
        r = c.request("nonexistent_action")
        self.assertEqual(r.status, 404, "same answer as the plain URL")


# ═════════════════════════════════════════════════════════════════════
# Access log and the observer's view

@NEEDS_CRYPTO
class TestSealedAccessLog(_FakeSshCase):

    def setUp(self):
        super().setUp()
        self._orig = server.ACCESS_LOG_PATH
        fd, self.logp = tempfile.mkstemp(suffix=".log")
        os.close(fd)
        server.ACCESS_LOG_PATH = self.logp

    def tearDown(self):
        server.ACCESS_LOG_PATH = self._orig
        os.unlink(self.logp)

    def _records(self, event, want=1):
        deadline = time.time() + 3
        while True:
            with open(self.logp) as f:
                recs = [json.loads(x) for x in f if x.strip()]
            hits = [r for r in recs if r.get("event") == event]
            if len(hits) >= want or time.time() > deadline:
                return recs, hits
            time.sleep(0.02)

    def test_the_access_log_records_the_inner_action(self):
        c = self.client()
        sid = self.sealed_connect(c)
        with open(os.path.join(self.home, "dl.txt"), "wb") as f:
            f.write(b"hello")
        c.request("download", query={"session_id": sid,
                                     "path": os.path.join(self.home, "dl.txt")})
        c.request("upload", "POST", {"session_id": sid, "path": ".websh-tmp-al",
                                     "offset": 0},
                  b"abc" + os.urandom(61), extra={"len": 3})
        c.post_json("disconnect", {"session_id": sid})
        recs, _ = self._records("disconnect")
        events = [r.get("event") for r in recs]
        for ev in ("connect", "download", "upload", "disconnect"):
            self.assertIn(ev, events, events)
        self.assertNotIn("sealed", events)
        up = [r for r in recs if r.get("event") == "upload"][0]
        self.assertEqual(up.get("bytes"), 3, "logged bytes = real bytes, not the padding")
        conn = [r for r in recs if r.get("event") == "connect"][0]
        self.assertEqual(conn.get("ip"), "127.0.0.1", conn)


@NEEDS_CRYPTO
class TestSealedObserverSeesNothing(_FakeSshCase):
    """The whole point: a reader of the decrypted TLS stream learns
    nothing about the session from the bytes after the page load."""

    def test_nothing_sensitive_crosses_the_wire_in_clear(self):
        c = self.client()
        sid = self.sealed_connect(c)
        self.stream_until(c, sid, b"$ ")
        c.post_json("input", {"session_id": sid,
                              "data": "echo TYPEDMARK_$((7*6))_zz\n"})
        self.stream_until(c, sid, b"TYPEDMARK_42_zz")
        d = os.path.join(self.home, "dir-PATHMARK-77")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "NAMEMARK-plan.txt"), "wb") as f:
            f.write(b"CONTENTMARK-download-31337" * 20)
        c.request("ls", query={"session_id": sid, "path": d})
        c.request("download", query={"session_id": sid,
                                     "path": os.path.join(d, "NAMEMARK-plan.txt")})
        up = b"CONTENTMARK-upload-4242" * 50
        c.request("upload", "POST", {"session_id": sid,
                                     "path": ".websh-tmp-UPNAMEMARK", "offset": 0},
                  up + os.urandom(4096 - len(up)), extra={"len": len(up)})
        c.post_json("upload_finalize", {"session_id": sid,
                                        "tmp": ".websh-tmp-UPNAMEMARK",
                                        "final": "UPFINALMARK.bin", "dir": d})
        c.post_json("disconnect", {"session_id": sid})
        time.sleep(0.2)  # let the relay flush its last segments

        c2s, s2c = self.tap.wire()
        wire = c2s + s2c
        secrets = {
            "session id": sid.encode(),
            "password": self.PASSWORD.encode(),
            "username": self.USER.encode(),
            "connection name": b"\"target\"",
            "typed text": b"TYPEDMARK",
            "typed text, base64": base64.b64encode(b"echo TYPEDMARK")[:12],
            "terminal output": b"TYPEDMARK_42_zz",
            "terminal output, base64 (SSE payload)": b"VFlQRURNQVJLXzQy",
            "path": b"PATHMARK",
            "file name": b"NAMEMARK",
            "upload name": b"UPNAMEMARK",
            "final name": b"UPFINALMARK",
            "download content": b"CONTENTMARK-download",
            "upload content": b"CONTENTMARK-upload",
            "JSON key session_id": b"session_id",
            "JSON key action": b"\"action\"",
            "SSE framing of the inner stream": b"data: {",
            "inner event name": b"event: data",
            "Content-Disposition": b"Content-Disposition",
        }
        # Revision 2: the frames are base64 text on the wire. Search the
        # raw text, and every base64 run decoded (ciphertext - nothing in
        # it may be readable either).
        decoded = b"".join(base64.b64decode(m + b"=" * (-len(m) % 4))
                           for m in re.findall(rb"[A-Za-z0-9+/]{16,}={0,2}", wire))
        for what, needle in secrets.items():
            self.assertNotIn(needle, wire, what + " seen in clear on the wire")
            self.assertNotIn(needle, decoded, what + " seen in a decoded base64 run")
        # The wire format itself: JSON requests, event-stream replies, no
        # binary octet-stream anywhere (endpoint-security software on the
        # owner's machine answered every such POST with its own 503).
        self.assertNotIn(b"application/octet-stream", c2s)
        self.assertIn(b"Content-Type: application/json", c2s)
        self.assertIn(b"text/event-stream", s2c)
        # Every API request line names only seal_open or sealed&c=<hex>.
        lines = self.tap.request_lines()
        self.assertTrue(lines)
        for method, url in lines:
            ok = (url == b"/api.php?action=seal_open"
                  or re.match(rb"^/api\.php\?action=sealed&c=[0-9a-f]{32}$", url))
            self.assertTrue(ok, "request line in clear: %r %r" % (method, url))
            self.assertEqual(method, b"POST")


# ═════════════════════════════════════════════════════════════════════
# Through the PHP proxy (shared hosting): the same bytes, unbuffered

def _php_route():
    """How the PHP proxy check runs php here: a local php, else the
    websh-php-smoke image (scripts/check.sh's route). None = neither."""
    if shutil.which("php"):
        return "local"
    if shutil.which("docker"):
        r = subprocess.run(["docker", "image", "inspect", "websh-php-smoke:latest"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if r.returncode == 0:
            return "docker"
    return None


class _SealedThroughAFront(object):
    """The same sealed exchanges through a front (api.php, nginx): the
    event-stream reply must pass byte for byte and frame by frame."""

    def front_client(self):
        c = SealedClient(self.front_port)
        self.assertEqual(c.open(), 200, getattr(c, "open_body", b""))
        c.verify_identity()
        return c

    def test_a_sealed_stream_arrives_frame_by_frame_for_seconds(self):
        c = self.front_client()
        sid = self.sealed_connect(c)
        conn, resp, header = c.open_stream("stream", {"session_id": sid, "since": 0},
                                           timeout=20)
        try:
            self.assertEqual(header.get("status"), 200, header)
            out = SseText()
            while b"$ " not in out.text:
                out.feed(c.read_frame(resp))
            # Five rounds over several seconds, each typed only after the
            # previous echo came back through the SAME open request: a
            # buffering proxy would deliver nothing until the end.
            for k in range(5):
                mark = ("PHPMARK_%d_" % k).encode()
                t0 = time.time()
                r = c.post_json("input", {"session_id": sid,
                                          "data": "echo PHPMARK_%d_$((%d*2))\n" % (k, k)})
                self.assertEqual(r.status, 200)
                want = mark + str(k * 2).encode()
                while want not in out.text:
                    pt = c.read_frame(resp)
                    self.assertTrue(pt, "the stream ended (or was cut) in the front")
                    out.feed(pt)
                self.assertLess(time.time() - t0, 3.0, "round %d took too long" % k)
                time.sleep(0.8)
        finally:
            conn.close()

    def test_a_multi_megabyte_sealed_download_is_identical_and_streamed(self):
        c = self.front_client()
        sid = self.sealed_connect(c)
        payload = os.urandom(5 * 1024 * 1024 + 123)
        p = os.path.join(self.home, "big-php.bin")
        with open(p, "wb") as f:
            f.write(payload)
        os.environ["FAKE_SSH_SLOW"] = "1"     # the remote trickles it out over ~3 s
        try:
            frame = c.frame_for("download", "GET", {"session_id": sid, "path": p})
            t0 = time.time()
            conn, r = c.post_frame(frame, timeout=60)
            self.assertEqual(r.status, 200)
            header = json.loads(c.read_frame(r).decode())
            self.assertEqual(header["status"], 200, header)
            chunks, first_at, clean = [], None, False
            while True:
                pt = c.read_frame(r)
                if pt is None:
                    break
                if pt == b"":
                    clean = True
                    break
                if first_at is None:
                    first_at = time.time() - t0
                chunks.append(pt)
            total = time.time() - t0
            conn.close()
        finally:
            os.environ.pop("FAKE_SSH_SLOW", None)
        body = b"".join(chunks)
        self.assertTrue(clean, "the reply ends with the end frame")
        self.assertEqual(len(body), len(payload))
        self.assertEqual(hashlib.sha256(body).hexdigest(),
                         hashlib.sha256(payload).hexdigest(), "byte-identical")
        self.assertGreater(total, 1.5, "the remote really was slow (%.1f s)" % total)
        self.assertLess(first_at, total / 2,
                        "first body frame at %.1f s of %.1f s: php buffered the reply"
                        % (first_at, total))

    def test_replay_and_unknown_channel_answers_pass_through(self):
        c = self.front_client()
        sid = str(uuid.uuid4())
        s = _RecSession(sid)
        with server.sessions_lock:
            server.sessions[sid] = s
        self.addCleanup(self._drop, sid)
        frame = c.frame_for("input", "POST", None,
                            json.dumps({"session_id": sid, "data": "P"}).encode())
        self.assertEqual(c.request(None, frame=frame).status, 200)
        r = c.request(None, frame=frame)
        self.assertEqual((r.outer_status, r.outer_json()), (400, {"error": "replay"}))
        r = c.request(None, frame=frame, channel="0" * 32)
        self.assertEqual((r.outer_status, r.outer_json()), (410, {"error": "channel unknown"}))
        self.assertEqual(s.writes, [b"P"])




@NEEDS_CRYPTO
@unittest.skipUnless(_php_route(), "no php and no websh-php-smoke image "
                     "(docker build -t websh-php-smoke tests/php)")
class TestSealedThroughPhpProxy(_SealedThroughAFront, _FakeSshCase):
    """api.php in front of the server (php -S, the way tests/php/smoke.sh
    runs it): a sealed request and its long, streamed sealed reply pass
    byte for byte, and frames arrive while the request is still open."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.php_port = _free_port()
        # The proxy uses Unix sockets. Point it at this in-process fixture,
        # otherwise it auto-starts another backend without our sessions or
        # slow-link controls and the assertions exercise the wrong server.
        unix = server.UnixServer(os.path.join(cls.work, "proxy.sock"), server.Handler)
        thread = threading.Thread(target=unix.serve_forever, daemon=True)
        thread.start()
        def stop_unix():
            unix.shutdown()
            unix.server_close()
            thread.join(timeout=5)
        cls.addClassCleanup(stop_unix)
        # WEBSH_PHP_DOCROOT: another api.php to put in front (to prove these
        # tests fail on an older proxy).
        root = os.environ.get("WEBSH_PHP_DOCROOT") or REPO_ROOT
        # php -S serves one request at a time unless told otherwise; the
        # open stream would block every other request (shared hosting has
        # a pool of workers).
        env = {"WEBSH_SOCKET": unix.server_address, "PHP_CLI_SERVER_WORKERS": "4"}
        if _php_route() == "local":
            e = dict(os.environ)
            e.update(env)
            cls.php = subprocess.Popen(
                ["php", "-S", "127.0.0.1:%d" % cls.php_port, "-t", root],
                env=e, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            cls.php_name = None
        else:
            cls.php_name = "websh-sealed-php-%d-%d" % (os.getpid(), cls.php_port)
            cls.php = subprocess.Popen(
                ["docker", "run", "--rm", "--name", cls.php_name, "--network", "bridge",
                 "--user", "%d:%d" % (os.getuid(), os.getgid()),
                 "-p", "127.0.0.1:%d:%d" % (cls.php_port, cls.php_port),
                 "-e", "WEBSH_SOCKET=" + unix.server_address,
                 "-e", "PHP_CLI_SERVER_WORKERS=4", "-v", cls.work + ":" + cls.work,
                 "-v", root + ":/w:ro", "-w", "/w",
                 "websh-php-smoke:latest",
                 "php", "-S", "0.0.0.0:%d" % cls.php_port, "-t", "/w"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 30
        while True:
            try:
                c = http.client.HTTPConnection("127.0.0.1", cls.php_port, timeout=2)
                c.request("GET", "/api.php?action=ping")
                if c.getresponse().status == 200:
                    break
            except OSError:
                pass
            if cls.php.poll() is not None or time.time() > deadline:
                cls._stop_php()
                raise RuntimeError("php -S did not come up on :%d" % cls.php_port)
            time.sleep(0.1)
        cls.front_port = cls.php_port

    @classmethod
    def _stop_php(cls):
        if cls.php_name:
            subprocess.run(["docker", "stop", "-t", "2", cls.php_name],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if cls.php.poll() is None:
            if not cls.php_name:
                os.killpg(cls.php.pid, signal.SIGTERM)
            else:
                cls.php.terminate()
            try:
                cls.php.wait(10)
            except subprocess.TimeoutExpired:
                cls.php.kill()
                cls.php.wait(5)

    @classmethod
    def tearDownClass(cls):
        cls._stop_php()
        super().tearDownClass()


@NEEDS_CRYPTO
@unittest.skipUnless(shutil.which("php") and hasattr(socket, "AF_UNIX"),
                     "requires local PHP and Unix sockets")
class TestSealedThroughUnixPhpProxy(_SealedThroughAFront, _FakeSshCase):
    """Sealed streaming and text uploads through PHP's Unix backend route."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.unix = server.UnixServer(os.path.join(cls.work, "backend.sock"), server.Handler)
        cls.unix_thread = threading.Thread(target=cls.unix.serve_forever, daemon=True)
        cls.unix_thread.start()
        cls.addClassCleanup(cls._stop_unix)
        cls.front_port = _free_port()
        env = dict(os.environ, WEBSH_SOCKET=cls.unix.server_address,
                   WEBSH_PORT="1", PHP_CLI_SERVER_WORKERS="4")
        cls.php = subprocess.Popen(
            ["php", "-S", "127.0.0.1:%d" % cls.front_port, "-t",
             os.environ.get("WEBSH_PHP_DOCROOT") or REPO_ROOT],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        cls.addClassCleanup(cls._stop_php_group)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                c = http.client.HTTPConnection("127.0.0.1", cls.front_port, timeout=1)
                c.request("GET", "/api.php?action=ping")
                response = c.getresponse()
                response.read()
                c.close()
                if response.status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.05)
        raise RuntimeError("private PHP Unix proxy did not become ready")

    @classmethod
    def _stop_php_group(cls):
        try:
            os.killpg(cls.php.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        cls.php.wait(timeout=5)

    @classmethod
    def _stop_unix(cls):
        cls.unix.shutdown()
        cls.unix.server_close()
        cls.unix_thread.join(timeout=5)

    def test_text_upload_through_unix_php_preserves_decoded_bytes(self):
        client = self.front_client()
        sid = self.sealed_connect(client)
        data = bytes(range(256)) * 17
        c = http.client.HTTPConnection("127.0.0.1", self.front_port, timeout=5)
        try:
            c.request("POST", "/api.php?action=upload&session_id=" + sid +
                      "&path=text-upload.bin&offset=0",
                      body=json.dumps({"b64": base64.b64encode(data).decode()}),
                      headers={"Content-Type": "application/json"})
            response = c.getresponse()
            raw = response.read()
            self.assertEqual(response.status, 200, raw)
            with open(os.path.join(self.home, "text-upload.bin"), "rb") as file:
                self.assertEqual(file.read(), data)
        finally:
            c.close()


@NEEDS_CRYPTO
@unittest.skipUnless(shutil.which("nginx"), "no nginx binary")
class TestSealedThroughNginx(_SealedThroughAFront, _FakeSshCase):
    """A private nginx with production's proxy directives
    (/etc/nginx/sites-enabled/websh: proxy_http_version 1.1,
    proxy_buffering off, proxy_request_buffering off; gzip on at http
    level). Plain HTTP here; TLS and HTTP/2 are the e2e ProdFront's."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ngx_dir = tempfile.mkdtemp(prefix="websh-sealed-nginx-")
        cls.front_port = _free_port()
        d = cls.ngx_dir
        conf = """
daemon off; pid {d}/nginx.pid; error_log {d}/error.log info;
events {{ worker_connections 256; }}
http {{
  default_type application/octet-stream;
  access_log {d}/access.log;
  gzip on;
  client_body_temp_path {d}/body; proxy_temp_path {d}/proxy;
  fastcgi_temp_path {d}/fcgi; uwsgi_temp_path {d}/uwsgi; scgi_temp_path {d}/scgi;
  server {{
    listen 127.0.0.1:{port};
    client_max_body_size 2g;
    proxy_request_buffering off;
    location / {{
      proxy_pass http://127.0.0.1:{up};
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 1800s; proxy_send_timeout 1800s;
      proxy_buffering off;
    }}
  }}
}}""".format(d=d, port=cls.front_port, up=cls.port)
        with open(os.path.join(d, "nginx.conf"), "w") as f:
            f.write(conf)
        cls.ngx = subprocess.Popen(["nginx", "-p", d, "-c", os.path.join(d, "nginx.conf")],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 10
        while True:
            try:
                c = http.client.HTTPConnection("127.0.0.1", cls.front_port, timeout=2)
                c.request("GET", "/api/ping")
                if c.getresponse().status == 200:
                    break
            except OSError:
                pass
            if cls.ngx.poll() is not None or time.time() > deadline:
                cls._stop_ngx()
                raise RuntimeError("private nginx did not start: see " + d)
            time.sleep(0.05)

    @classmethod
    def _stop_ngx(cls):
        if cls.ngx.poll() is None:
            cls.ngx.send_signal(signal.SIGQUIT)
            try:
                cls.ngx.wait(5)
            except subprocess.TimeoutExpired:
                cls.ngx.kill()
                cls.ngx.wait()
        shutil.rmtree(cls.ngx_dir, ignore_errors=True)

    @classmethod
    def tearDownClass(cls):
        cls._stop_ngx()
        super().tearDownClass()


if __name__ == "__main__":
    unittest.main()
