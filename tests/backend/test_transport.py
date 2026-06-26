#!/usr/bin/env python3
"""Tests for websh server.py — HTTP API output/stream/SSE, request timeout, session lifecycle, reap/cleanup, watchdog.

Split from the original test_server.py; class bodies are verbatim.
"""

import base64
import io
import json
import os
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
import uuid

from tests.backend._base import (  # noqa: F401
    REPO_ROOT, LiveServerCase, _FakeNotifyMixin)
import server


class TestHTTPApi(LiveServerCase):
    """Integration tests: start the server and hit the API with HTTP."""

    CONFIG = {
        "restrict_hosts": True,
        "connections": [
            {"name": "allowed", "host": "localhost", "port": 22,
             "username": "testuser", "password": "testpass"}
        ]
    }

    def test_ping(self):
        body, code = self._get("/api/ping")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertIn("version", body)

    def test_config_returns_no_secrets(self):
        body, code = self._get("/api/config")
        self.assertEqual(code, 200)
        self.assertTrue(body["restrict_hosts"])
        self.assertIn("session_timeout", body)
        self.assertIn("version", body)
        self.assertEqual(len(body["connections"]), 1)
        conn = body["connections"][0]
        self.assertEqual(conn["name"], "allowed")
        self.assertNotIn("password", conn)
        self.assertNotIn("key", conn)

    def test_connect_restricted_host_rejected(self):
        body, code = self._post("/api/connect", {
            "host": "evil.com", "port": 22, "username": "hacker",
            "password": "x", "cols": 80, "rows": 24
        })
        self.assertEqual(code, 403)
        self.assertIn("not allowed", body["error"])

    def test_connect_by_name_not_found(self):
        body, code = self._post("/api/connect", {
            "connection": "nonexistent", "cols": 80, "rows": 24
        })
        self.assertEqual(code, 404)
        self.assertIn("not found", body["error"])

    def test_connect_missing_fields(self):
        body, code = self._post("/api/connect", {
            "host": "", "username": "", "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)

    def test_connect_host_flag_injection(self):
        """Host starting with dash must be rejected."""
        body, code = self._post("/api/connect", {
            "host": "-o ProxyCommand=evil", "username": "user",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("invalid", body["error"])

    def test_connect_username_flag_injection(self):
        """Username starting with dash must be rejected."""
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "-o Something",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("invalid", body["error"])

    def test_not_found(self):
        body, code = self._get("/api/nonexistent")
        self.assertEqual(code, 404)

    def test_disconnect_unknown_session(self):
        body, code = self._post("/api/disconnect", {"session_id": "fake"})
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])

    def test_input_missing_session(self):
        body, code = self._post("/api/input", {"session_id": "fake", "data": "x"})
        self.assertEqual(code, 404)

    def test_stream_unknown_session(self):
        # Well-formed UUID but no such session: SSE handler 404s as JSON
        # (same shape as /api/output) before opening the event stream.
        body, code = self._get(
            "/api/stream?session_id=12345678-1234-1234-1234-123456789abc")
        self.assertEqual(code, 404)
        self.assertIn("error", body)

    def test_stream_invalid_uuid(self):
        body, code = self._get("/api/stream?session_id=not-a-uuid")
        self.assertEqual(code, 404)
        self.assertIn("error", body)

    def test_stream_on_placeholder_session_404s_not_500(self):
        """During the connect window the registry holds a _SessionPlaceholder
        (no _stream_active slot). /api/stream must treat it as not-ready and
        404, not dereference the missing attr and crash the worker (500)."""
        sid = str(uuid.uuid4())
        placeholder = server._SessionPlaceholder("1.2.3.4", False)
        with server.sessions_lock:
            server.sessions[sid] = placeholder
        try:
            body, code = self._get("/api/stream?session_id=" + sid)
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)
        self.assertEqual(code, 404)
        self.assertIn("error", body)

    def test_stream_happy_path(self):
        """Plant a fake session that emits one chunk then dies.
        Verify SSE headers, the initial ': ok' comment, the encoded
        'data' event, and the closing 'end' event, in that order."""
        import http.client
        sid = str(uuid.uuid4())

        class FakeSession(_FakeNotifyMixin):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
                self._chunks = [b"hello\r\n"]
            def read(self):
                if self._chunks:
                    return self._chunks.pop(0)
                self.alive = False
                return b""

        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port,
                                              timeout=5)
            conn.request("GET", "/api/stream?session_id=" + sid)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.getheader("Content-Type"),
                             "text/event-stream")
            self.assertEqual(resp.getheader("X-Accel-Buffering"), "no")
            # Read until we see both events. The session emits one chunk
            # then read() returns b"" + alive=False, which the handler
            # turns into 'event: end'. ~1 KB is plenty.
            buf = b""
            deadline = time.time() + 3
            while time.time() < deadline and b"event: end" not in buf:
                chunk = resp.read(256)
                if not chunk:
                    break
                buf += chunk
            conn.close()
            text = buf.decode("utf-8")
            self.assertIn(": ok", text)
            self.assertIn("event: data", text)
            self.assertIn("event: end", text)
            # The handler emits a primer 'event: data' immediately (so
            # the client's first-message timer disarms even on streams
            # that have no PTY output yet). Skip past it to find the
            # frame carrying our actual chunk.
            data_payloads = [
                json.loads(line[len("data: "):])
                for line in text.splitlines()
                if line.startswith("data: ") and '"data"' in line
            ]
            self.assertGreaterEqual(len(data_payloads), 2,
                "expected primer + chunk, got: " + repr(data_payloads))
            self.assertEqual(data_payloads[0]["data"], "",
                "first data event must be the empty primer")
            chunk_payload = next(
                p for p in data_payloads if p["data"] != ""
            )
            self.assertEqual(base64.b64decode(chunk_payload["data"]),
                             b"hello\r\n")
            self.assertFalse(chunk_payload["auth_failed"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_stream_primer_disarms_timer_on_idle_session(self):
        """A session that produces no PTY output still gets a real
        'event: data' frame right after the headers, so the client's
        first-message buffer-detection timer disarms instead of falling
        back to long-poll on an otherwise healthy SSE channel."""
        import http.client
        sid = str(uuid.uuid4())

        class IdleSession(_FakeNotifyMixin):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
                self._calls = 0
            def read(self):
                # First few read()s return nothing; then we mark dead so
                # the handler exits cleanly without ever emitting a
                # non-primer data frame.
                self._calls += 1
                if self._calls > 3:
                    self.alive = False
                return b""

        with server.sessions_lock:
            server.sessions[sid] = IdleSession()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port,
                                              timeout=5)
            conn.request("GET", "/api/stream?session_id=" + sid)
            resp = conn.getresponse()
            buf = b""
            deadline = time.time() + 3
            while time.time() < deadline and b"event: end" not in buf:
                chunk = resp.read(256)
                if not chunk:
                    break
                buf += chunk
            conn.close()
            text = buf.decode("utf-8")
            # The primer is an 'event: data' carrying empty data — that's
            # what disarms the client's timer on a quiet channel.
            self.assertIn("event: data", text,
                "primer 'event: data' must be sent even when idle")
            primer = json.loads(next(
                line[len("data: "):] for line in text.splitlines()
                if line.startswith("data: ") and '"data"' in line))
            self.assertEqual(primer["data"], "",
                "primer carries empty data")
            self.assertTrue(primer["alive"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_stream_rejects_duplicate_with_409(self):
        """A second /api/stream for an already-streaming session must
        be rejected with 409 instead of silently racing two destructive
        readers for the same buffer. The first stream is unaffected."""
        import http.client
        import socket as _socket
        import threading as _threading
        sid = str(uuid.uuid4())

        # Long-running session: read() blocks on a flag we control so
        # the first stream stays parked in its loop while we open the
        # second one. The handler only releases _stream_active in the
        # outer try/finally, so the slot remains held the whole time.
        gate = _threading.Event()

        class Sess(_FakeNotifyMixin):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
            def read(self):
                if not gate.is_set():
                    gate.wait(timeout=5)
                self.alive = False
                return b""

        with server.sessions_lock:
            server.sessions[sid] = Sess()
        try:
            # Open the first stream via a raw socket so we can keep it
            # alive (no early close) without the http.client lifecycle
            # closing the connection on us when we read.
            s1 = _socket.create_connection(("127.0.0.1", self.port),
                                           timeout=5)
            req = ("GET /api/stream?session_id=" + sid + " HTTP/1.1\r\n"
                   "Host: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n")
            s1.sendall(req.encode("ascii"))
            buf = b""
            s1.settimeout(0.3)
            deadline = time.time() + 3
            while time.time() < deadline and b"\r\n\r\n" not in buf:
                try:
                    chunk = s1.recv(256)
                    if not chunk:
                        break
                    buf += chunk
                except _socket.timeout:
                    pass
            self.assertIn(b"HTTP/1.0 200", buf,
                "first stream must respond 200; got: " + repr(buf[:80]))
            # First handler is now parked in read()/wait; _stream_active=True.

            # Second stream: should be rejected immediately with 409.
            c2 = http.client.HTTPConnection("127.0.0.1", self.port,
                                            timeout=3)
            c2.request("GET", "/api/stream?session_id=" + sid)
            r2 = c2.getresponse()
            self.assertEqual(r2.status, 409,
                "second concurrent /api/stream must be 409, got "
                + str(r2.status))
            body = json.loads(r2.read().decode("utf-8"))
            self.assertIn("stream already active", body.get("error", ""))
            c2.close()

            # Release the first handler so the slot is freed cleanly.
            gate.set()
            try:
                # Drain a bit so server side can finish writing event:end
                # before we tear down.
                s1.settimeout(2.0)
                while True:
                    chunk = s1.recv(1024)
                    if not chunk:
                        break
            except (_socket.timeout, OSError):
                pass
            try:
                s1.close()
            except OSError:
                pass

            # After slot release, a fresh stream is accepted again.
            # Reseat the session so the same gate-based fake serves
            # the next request without hanging this time.
            gate.clear()
            with server.sessions_lock:
                server.sessions[sid] = Sess()
            gate.set()
            c3 = http.client.HTTPConnection("127.0.0.1", self.port,
                                            timeout=5)
            c3.request("GET", "/api/stream?session_id=" + sid)
            r3 = c3.getresponse()
            self.assertEqual(r3.status, 200,
                "fresh stream after slot release must be 200")
            r3.read()
            c3.close()
        finally:
            gate.set()
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_stream_session_path_a_skips_read_when_client_gone(self):
        """White-box (deterministic): if _client_gone() is already True when
        the stream loop ticks, the handler must NOT call session.read() —
        draining destructive PTY output into a socket we know is dead would
        lose it. Replaces the former timing-dependent integration test
        (test_stream_returns_undelivered_bytes_to_buffer), whose 'buffer
        empty' assertion could not distinguish a lost byte from one
        successfully written into a half-closed socket (the first write
        after a peer FIN always succeeds). FIN peek itself is covered by
        test_client_gone_detects_fin / _false_with_pending_data.

        Discriminating: fails if the `if self._client_gone()` guard before
        `data = session.read()` is removed from _stream_session — the loop
        would then read() (read_calls > 0)."""
        class _Wfile(object):
            def __init__(self):
                self.chunks = []
            def write(self, b):
                self.chunks.append(b)
            def flush(self):
                pass

        class _Sess(object):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
                self.read_calls = 0
                self.unread_calls = []
                self.last_activity = 0
            def read(self):
                self.read_calls += 1
                return b""
            def unread(self, data):
                self.unread_calls.append(data)
            def wait_for_data(self, client_socket, timeout, selector=None):
                # Should never be reached on this path; if it is, end the
                # session so the test can't hang.
                self.alive = False

        h = server.Handler.__new__(server.Handler)
        h.send_response = lambda *a, **k: None
        h.send_header = lambda *a, **k: None
        h.end_headers = lambda *a, **k: None
        h.connection = None
        h._build_session_selector = lambda session: type(
            "_Sel", (), {"close": lambda self: None})()
        h._client_gone = lambda: True
        h.wfile = _Wfile()

        sess = _Sess()
        h._stream_session(sess)

        self.assertEqual(sess.read_calls, 0,
            "handler drained a socket already known dead (FIN seen) — "
            "_client_gone() guard before read() is missing or ineffective")
        self.assertEqual(sess.unread_calls, [],
            "nothing was read, so nothing should have been unread")

    def test_stream_session_path_b_unreads_on_write_failure(self):
        """White-box (deterministic): if wfile.write() of a real data event
        fails (peer FIN/RST), the bytes the handler drained from the session
        must be pushed back via session.unread() so the long-poll fallback
        (or a reconnecting EventSource) can still deliver them.

        Discriminating: fails if the except-clause `if data: session.unread(
        data)` is removed from _stream_session — unread_calls would be
        empty (bytes silently lost). The empty-data priming event must
        still succeed: only the chunk carrying base64(planted) raises,
        proving the unread targets the real-data write, not priming."""
        planted = b"do-not-lose-me\r\n"
        marker = base64.b64encode(planted)

        class _Wfile(object):
            def __init__(self):
                self.chunks = []
            def write(self, b):
                # Priming ('data: ""') must go through; only the real
                # base64-bearing payload fails, mimicking a peer that
                # FIN'd after the stream opened.
                if marker in b:
                    raise BrokenPipeError("peer closed")
                self.chunks.append(b)
            def flush(self):
                pass

        class _Sess(object):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
                self._reads = [planted]
                self.read_calls = 0
                self.unread_calls = []
                self.last_activity = 0
            def read(self):
                self.read_calls += 1
                return self._reads.pop(0) if self._reads else b""
            def unread(self, data):
                self.unread_calls.append(data)
            def wait_for_data(self, client_socket, timeout, selector=None):
                self.alive = False

        h = server.Handler.__new__(server.Handler)
        h.send_response = lambda *a, **k: None
        h.send_header = lambda *a, **k: None
        h.end_headers = lambda *a, **k: None
        h.connection = None
        h._build_session_selector = lambda session: type(
            "_Sel", (), {"close": lambda self: None})()
        h._client_gone = lambda: False
        h.wfile = _Wfile()

        sess = _Sess()
        h._stream_session(sess)

        self.assertEqual(sess.unread_calls, [planted],
            "drained bytes were not pushed back exactly once after the "
            "data-event write failed — except-clause unread() is missing")

    def test_client_gone_detects_fin(self):
        """_client_gone() returns True after the peer half-closes (sends
        FIN) and False while the connection is just idle. This is what
        lets _stream and /api/output bail before draining the session
        into a dead socket."""
        import socket as _socket
        a, b = _socket.socketpair()
        try:
            h = server.Handler.__new__(server.Handler)
            h.connection = a
            self.assertFalse(h._client_gone(),
                             "fresh idle socket reported as gone")
            b.shutdown(_socket.SHUT_WR)
            # Tiny sleep to let the FIN propagate through the local
            # socketpair; on Linux this is essentially instant.
            time.sleep(0.05)
            self.assertTrue(h._client_gone(),
                            "FIN from peer not detected by peek")
        finally:
            a.close(); b.close()

    def test_client_gone_false_with_pending_data(self):
        """Peer wrote bytes but didn't close — peek returns those bytes,
        not EOF, so _client_gone() must say False."""
        import socket as _socket
        a, b = _socket.socketpair()
        try:
            h = server.Handler.__new__(server.Handler)
            h.connection = a
            b.send(b"hello")
            time.sleep(0.05)
            self.assertFalse(h._client_gone(),
                             "pending data should not be confused with FIN")
        finally:
            a.close(); b.close()

    def test_session_unread_prepends(self):
        """Session.unread() must push bytes back to the FRONT of the
        buffer so they're delivered in original order on the next read."""
        s = server.SSHSession.__new__(server.SSHSession)
        s.output_buf = b"world"
        s.buf_lock = __import__("threading").Lock()
        s.last_activity = 0
        s.unread(b"hello ")
        self.assertEqual(s.read(), b"hello world")
        # Idempotent on empty input
        s.unread(b"")
        self.assertEqual(s.output_buf, b"")

    def test_session_unread_with_overflow_drops_oldest(self):
        """When the unread bytes plus existing buffer would exceed
        OUTPUT_BUF_MAX, the truncation rule keeps the LAST OUTPUT_BUF_KEEP
        bytes — that's the freshest terminal state. The unread bytes are
        older so they're the ones dropped. Documented in
        docs/sse-transport.md as a deliberate trade-off."""
        s = server.SSHSession.__new__(server.SSHSession)
        s.buf_lock = __import__("threading").Lock()
        s.last_activity = 0
        # Recent buffer just under the cap.
        s.output_buf = b"y" * (server.OUTPUT_BUF_MAX - 100)
        # Unread bytes that, prepended, push us over the cap.
        s.unread(b"x" * 1000)
        # Result is exactly OUTPUT_BUF_KEEP and contains the freshest
        # bytes (the y's), with the unread x's dropped.
        self.assertEqual(len(s.output_buf), server.OUTPUT_BUF_KEEP)
        self.assertNotIn(b"x", s.output_buf)
        self.assertEqual(s.output_buf, b"y" * server.OUTPUT_BUF_KEEP)

    def test_resize_missing_session(self):
        body, code = self._post("/api/resize", {
            "session_id": "fake", "cols": 80, "rows": 24
        })
        self.assertEqual(code, 404)

    def test_input_invalid_json(self):
        """Malformed request body."""
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{}/api/input".format(self.port)
        req = Request(url, data=b"not json",
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            body = json.loads(resp.read().decode("utf-8"))
            code = resp.getcode()
        except Exception as e:
            body = json.loads(e.read().decode("utf-8"))
            code = e.code
        self.assertEqual(code, 400)
        self.assertIn("invalid json", body["error"])

    def test_connect_invalid_json(self):
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{}/api/connect".format(self.port)
        req = Request(url, data=b"{bad",
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            body = json.loads(resp.read().decode("utf-8"))
            code = resp.getcode()
        except Exception as e:
            body = json.loads(e.read().decode("utf-8"))
            code = e.code
        self.assertEqual(code, 400)

    def test_non_dict_json_body_returns_400(self):
        """_json_body must reject valid-JSON-but-not-an-object bodies
        (bare list/string/number) with the same 400 malformed JSON gets.
        Previously body.get() raised AttributeError and the client saw a
        dropped connection with no response at all."""
        for payload in ([1, 2, 3], "just a string", 42, None, True):
            body, code = self._post("/api/resize", payload)
            self.assertEqual(code, 400, "payload %r" % (payload,))
            self.assertEqual(body.get("error"), "invalid json")

    def test_placeholder_session_404s_on_plain_endpoints(self):
        """_require_session must reject _SessionPlaceholder slots on every
        endpoint, not just /api/stream. Before the helper, hitting input/
        output/resize inside the connect window dereferenced attributes the
        placeholder's __slots__ omit — an AttributeError surfacing as a 500
        from /api/input (its write is wrapped in try/except) and as a
        dropped connection with no response from the other endpoints. /api/ls
        rides along to pin one side-channel-throttled endpoint too."""
        sid = str(uuid.uuid4())
        placeholder = server._SessionPlaceholder("1.2.3.4", False)
        with server.sessions_lock:
            server.sessions[sid] = placeholder
        try:
            for fetch in (
                lambda: self._get("/api/output?session_id=" + sid),
                lambda: self._post("/api/input",
                                   {"session_id": sid, "data": "x"}),
                lambda: self._post("/api/resize",
                                   {"session_id": sid, "cols": 80, "rows": 24}),
                lambda: self._get("/api/ls?session_id=" + sid),
            ):
                body, code = fetch()
                self.assertEqual(code, 404)
                self.assertIn("error", body)
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)


class TestIdleTimer(unittest.TestCase):

    def _fake_session(self, age_seconds=10):
        """Build a minimal SSHSession without spawning ssh."""
        s = server.SSHSession.__new__(server.SSHSession)
        s.buf_lock = threading.Lock()
        s.output_buf = b""
        s.last_activity = time.time() - age_seconds
        s.alive = True
        s.master_fd = -1
        return s

    def test_empty_read_does_not_bump(self):
        s = self._fake_session(age_seconds=100)
        before = s.last_activity
        out = s.read()
        self.assertEqual(out, b"")
        self.assertEqual(s.last_activity, before)

    def test_many_empty_reads_keep_last_activity_stale(self):
        """Long-poll regression: 500 empty reads must not freshen the timer."""
        s = self._fake_session(age_seconds=1000)
        before = s.last_activity
        for _ in range(500):
            s.read()
        self.assertEqual(s.last_activity, before)

    def test_nonempty_read_bumps(self):
        s = self._fake_session(age_seconds=1000)
        before = s.last_activity
        s.output_buf = b"hello"
        out = s.read()
        self.assertEqual(out, b"hello")
        self.assertGreater(s.last_activity, before)

    def test_is_expired_true_when_idle(self):
        s = self._fake_session(age_seconds=server.SESSION_TIMEOUT + 1)
        # Drain empty — must stay expired.
        s.read()
        self.assertTrue(s.is_expired())

    def test_is_expired_false_after_nonempty_read(self):
        s = self._fake_session(age_seconds=server.SESSION_TIMEOUT + 1)
        s.output_buf = b"x"
        s.read()
        self.assertFalse(s.is_expired())


# ── Cross-thread wake machinery ────────────────────────────────────────
# _stream and _output used to busy-poll session.read() at 100 Hz via
# time.sleep(POLL_INTERVAL). They now park in Session.wait_for_data(),
# which interleaves threading.Event waits with non-blocking selector
# polls of the client socket. Wake-on-data: instant (Event.wait returns
# from set() in microseconds). Wake-on-FIN: ≤20ms (one slice). Wake-on-
# timeout: at deadline ±20ms. Idle sessions stop spinning a 100 Hz loop.


class TestSessionNotify(unittest.TestCase):

    def _fake(self):
        s = server.SSHSession.__new__(server.SSHSession)
        s.buf_lock = threading.Lock()
        s.alive = True
        s.output_buf = b""
        s.last_activity = time.time()
        s.master_fd = -1
        s.pid = None
        s._key_file = None
        s._control_path = None
        s._data_event = threading.Event()
        return s

    def test_signal_then_wait_returns_immediately(self):
        s = self._fake()
        s._signal()
        t0 = time.time()
        s.wait_for_data(None, timeout=2.0)
        elapsed = time.time() - t0
        self.assertLess(elapsed, 0.05,
            "wait should return immediately on pre-existing signal; "
            "took {:.1f} ms".format(elapsed * 1000))

    def test_wait_blocks_full_timeout_when_unsignaled(self):
        s = self._fake()
        t0 = time.time()
        s.wait_for_data(None, timeout=0.1)
        elapsed = time.time() - t0
        self.assertGreaterEqual(elapsed, 0.05,
            "wait must actually block, not spin; elapsed {:.1f} ms"
            .format(elapsed * 1000))
        # Upper bound is generous — on a heavily-loaded CI runner
        # scheduler jitter alone can push the wakeup well past the
        # timeout. The intent is "doesn't hang forever", not "hits
        # the timeout exactly".
        self.assertLess(elapsed, 1.0,
            "wait shouldn't overshoot; elapsed {:.1f} ms"
            .format(elapsed * 1000))

    def test_cross_thread_signal_wakes_within_milliseconds(self):
        """Producer thread signals after a short delay; consumer parked
        in wait_for_data() must wake within tens of ms — this is the
        whole point of the refactor (replaces ~5 ms busy-poll latency).
        threading.Event has the same kernel-multiplexed wakeup
        guarantee the os.pipe() version had."""
        s = self._fake()
        feed_time = []

        def producer():
            time.sleep(0.05)
            feed_time.append(time.time())
            s._signal()

        threading.Thread(target=producer, daemon=True).start()
        t0 = time.time()
        s.wait_for_data(None, timeout=2.0)
        wakeup = time.time()
        self.assertEqual(len(feed_time), 1)
        latency_ms = (wakeup - feed_time[0]) * 1000
        # Target is <5ms (Event.wait should wake within tens of µs +
        # scheduler jitter). 200ms is the slow-CI flake margin: on
        # GitHub Actions free tier under contention we've seen 50-
        # 150ms. The test still proves the wait actually blocked
        # via the lower bound below.
        self.assertLess(latency_ms, 200,
            "signal->wakeup latency too high: {:.1f} ms (target <5 ms, "
            "200 ms is the CI-flake margin)".format(latency_ms))
        self.assertGreaterEqual(wakeup - t0, 0.04,
            "consumer woke before producer signaled — false wakeup?")

    def test_repeated_signals_coalesce(self):
        """100 K signals must not block, raise, or leave the Event in
        a state where wait_for_data spuriously fires after the first
        consumed wakeup. (Setting an already-set Event is a no-op, so
        coalescing is intrinsic — the test guards against any future
        regression that introduces a counter or queue here.)"""
        s = self._fake()
        for _ in range(100000):
            s._signal()
        # First wait sees the existing signal — should clear and return.
        t0 = time.time()
        s.wait_for_data(None, timeout=2.0)
        self.assertLess(time.time() - t0, 0.10)
        # Second wait must actually block (clear emptied the Event).
        t0 = time.time()
        s.wait_for_data(None, timeout=0.1)
        self.assertGreaterEqual(time.time() - t0, 0.05)

    def test_wait_returns_when_client_socket_has_fin(self):
        """The interleaved-short-waits loop polls the client-socket
        selector each slice so a peer FIN wakes the consumer within
        one slice (~20 ms) instead of waiting on the keepalive
        deadline. We simulate FIN by half-closing one end of a
        socketpair and passing the other to wait_for_data via a
        caller-owned selector."""
        a, b = socket.socketpair()
        s = self._fake()
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(a.fileno(), selectors.EVENT_READ)
                b.shutdown(socket.SHUT_WR)
                t0 = time.time()
                s.wait_for_data(a, timeout=2.0, selector=sel)
                elapsed = time.time() - t0
            # Slice is 20ms; FIN can land just after a slice started,
            # so worst-case real latency is ~one slice. 200ms is the
            # slow-CI flake margin (kept consistent with other latency
            # tests).
            self.assertLess(elapsed, 0.20,
                "FIN must wake wait_for_data within ~one slice; took "
                "{:.1f} ms".format(elapsed * 1000))
        finally:
            a.close()
            b.close()

    def test_signal_idempotent_after_event_stripped(self):
        """If a future code path nulls _data_event (e.g. a teardown
        race or a __new__-bypass test fixture), _signal must absorb
        the no-op rather than crashing the reader."""
        s = self._fake()
        s._data_event = None
        s._signal()
        s._signal()  # idempotent

    def test_wait_after_event_stripped_falls_back(self):
        """If _data_event is None, wait_for_data falls back to a
        brief sleep so the caller's loop progresses instead of
        spinning."""
        s = self._fake()
        s._data_event = None
        t0 = time.time()
        s.wait_for_data(None, timeout=0.5)
        elapsed = time.time() - t0
        # The fallback sleeps min(timeout, POLL_INTERVAL=0.01).
        self.assertLess(elapsed, 0.10,
            "stripped Event must short-circuit the wait; elapsed "
            "{:.1f} ms".format(elapsed * 1000))

    def test_zero_timeout_returns_immediately(self):
        s = self._fake()
        t0 = time.time()
        s.wait_for_data(None, timeout=0)
        self.assertLess(time.time() - t0, 0.01)

    def test_close_does_not_touch_data_event(self):
        """Regression guard: Session.close() must not invalidate the
        cross-thread wake mechanism — concurrent _signal() calls from
        a still-running reader thread must remain safe even after
        close() returns. With threading.Event there's nothing to free
        (no fd, no kernel resource), so this is implicit, but we test
        it explicitly so a future regression that, e.g., clears the
        event reference is caught."""
        s = server.SSHSession.__new__(server.SSHSession)
        s.alive = True
        s._data_event = threading.Event()
        # close() needs a real child pid (not 0 — kill(0, sig) signals
        # the entire process group). Fork a stub that exits immediately;
        # close() will reap it.
        s.master_fd, slave_fd = os.pipe()
        os.close(slave_fd)  # close() will close master_fd; that's fine.
        child_pid = os.fork()
        if child_pid == 0:
            os._exit(0)
        s.pid = child_pid
        s._key_file = None
        s._control_path = None
        # close() now reaps via _reap_child, which needs these.
        s._exit_status = None
        s._reap_lock = threading.Lock()
        s._child_reaped = False
        s.close()
        # Event must still be usable after close().
        self.assertIsNotNone(s._data_event)
        s._signal()
        self.assertTrue(s._data_event.is_set())

    def test_unread_signals_consumer(self):
        """Regression: after unread(), a consumer parked in
        wait_for_data must wake up so the bytes are delivered without
        waiting for the next PTY signal or the keepalive deadline."""
        s = self._fake()
        s.output_buf = b""
        wakeup = []

        def consumer():
            t0 = time.time()
            s.wait_for_data(None, timeout=2.0)
            wakeup.append(time.time() - t0)

        t = threading.Thread(target=consumer, daemon=True)
        t.start()
        time.sleep(0.05)  # ensure consumer is parked
        s.unread(b"deferred bytes")
        t.join(timeout=1.0)
        self.assertEqual(len(wakeup), 1,
                         "consumer did not wake on unread()")
        self.assertLess(wakeup[0], 0.3,
                        "wakeup latency too high: {:.1f} ms"
                        .format(wakeup[0] * 1000))

    def test_wait_with_cached_selector_fast_path(self):
        """Hot-loop scenario: caller pre-builds a selector with the
        client socket registered and reuses it across many
        wait_for_data calls. This avoids per-call epoll_create1+ctl+
        close overhead. Verify the wakeup contract still holds when
        this path is exercised."""
        a, b = socket.socketpair()
        s = self._fake()
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(a.fileno(), selectors.EVENT_READ)
                # Pre-existing signal: cached-selector path returns
                # immediately just like the one-shot path.
                s._signal()
                t0 = time.time()
                s.wait_for_data(a, timeout=2.0, selector=sel)
                self.assertLess(time.time() - t0, 0.05)
                # Cleared by previous wait → next wait must block.
                t0 = time.time()
                s.wait_for_data(a, timeout=0.1, selector=sel)
                self.assertGreaterEqual(time.time() - t0, 0.05)
                # And cross-thread signal still wakes it up via the
                # cached-selector path.
                feed_time = []

                def producer():
                    time.sleep(0.05)
                    feed_time.append(time.time())
                    s._signal()

                threading.Thread(target=producer, daemon=True).start()
                t0 = time.time()
                s.wait_for_data(a, timeout=2.0, selector=sel)
                self.assertEqual(len(feed_time), 1)
                latency_ms = (time.time() - feed_time[0]) * 1000
                # Same generous CI margin as the one-shot path — see
                # test_cross_thread_signal_wakes_within_milliseconds.
                self.assertLess(latency_ms, 200,
                    "cached-selector signal->wakeup: {:.1f} ms"
                    .format(latency_ms))
        finally:
            a.close()
            b.close()


# ── HTTP-level validation of slot_id + tmux_cmd ────────────────────────
# Separate class so we can start the server *without* restrict_hosts;
# slot_id/tmux_cmd validation happens before any host/connection check,
# so responses are deterministic 400s.


_FAKE_TMUX = r"""#!/bin/sh
state=${TMUX_STATE:-/tmp/fake-tmux-state}
sessions=$state/sessions
mkdir -p "$state"; touch "$sessions"
sub=$1; shift
name=""
while [ $# -gt 0 ]; do
  case "$1" in
    -t|-s) shift; name=$1; shift ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
case "$sub" in
  new-session)
    grep -Fxq "$name" "$sessions" 2>/dev/null || echo "$name" >> "$sessions"
    exit 0 ;;
  has-session)
    grep -Fxq "$name" "$sessions" 2>/dev/null ;;
  display)
    # Format we care about: "#{session_attached} #{session_last_attached}"
    cat "$state/info-$name" 2>/dev/null || echo "0 0" ;;
  kill-session)
    grep -vxF "$name" "$sessions" > "$sessions.tmp" 2>/dev/null || :
    mv "$sessions.tmp" "$sessions" 2>/dev/null || :
    # Breadcrumb for the test to assert against.
    echo "killed $name at $(date +%s)" >> "$state/kill.log"
    ;;
esac
"""


class TestWatchdogRuntime(unittest.TestCase):
    """Integration test: run the actual shell command against a fake
    tmux and verify the watchdog kills the session after TTL seconds.

    This covers the behavior that sh -n can't — loop control, TTL
    arithmetic, pidfile idempotency, seen-file freshness."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="websh-wd-test-")
        self.state = os.path.join(self.tmpdir, "state")
        os.makedirs(self.state)
        self.fake_tmux = os.path.join(self.tmpdir, "tmux")
        with open(self.fake_tmux, "w") as f:
            f.write(_FAKE_TMUX)
        os.chmod(self.fake_tmux, 0o755)
        self.env = os.environ.copy()
        self.env["HOME"] = self.tmpdir
        self.env["TMUX_STATE"] = self.state
        # Deliberately don't put fake tmux on PATH — _build_remote_command
        # is called with the full path, so every tmux invocation uses it.

    def tearDown(self):
        # Reap any lingering watchdog so the test doesn't leak processes.
        pidfile = os.path.join(self.tmpdir, ".websh-ttl-rt.pid")
        try:
            with open(pidfile) as f:
                pid = int(f.read().strip())
            os.kill(pid, signal.SIGTERM)
        except (OSError, ValueError):
            pass
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _run(self, cmd, timeout=5):
        # The command ends with `exec <fake-tmux> new-session ...` which
        # exits immediately (fake doesn't attach). The backgrounded
        # watchdog keeps running — that's the process we actually want
        # to observe.
        p = subprocess.Popen(
            ["sh", "-c", cmd], env=self.env, cwd=self.tmpdir,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p.wait(timeout=timeout)

    def _sessions(self):
        path = os.path.join(self.state, "sessions")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [ln.strip() for ln in f if ln.strip()]

    def test_watchdog_kills_abandoned_session_after_ttl(self):
        # Pre-seed info: att=0 (not attached), last_attached=0 (epoch).
        # Combined with a seen-file that _build will stamp at NOW, the
        # watchdog's baseline is NOW. It should kill after TTL seconds.
        info = os.path.join(self.state, "info-websh-rt")
        with open(info, "w") as f:
            f.write("0 0")

        cmd = server._build_remote_command(
            "rt", self.fake_tmux, ttl_seconds=1, poll_seconds=1)
        self._run(cmd)

        # Session should exist right after creation.
        self.assertIn("websh-rt", self._sessions())

        # Wait for the watchdog to fire. TTL=1, poll=1 → kills no later
        # than ~3s after connect (two polls to observe stale baseline).
        deadline = time.time() + 8
        while time.time() < deadline:
            if "websh-rt" not in self._sessions():
                break
            time.sleep(0.2)
        self.assertNotIn(
            "websh-rt", self._sessions(),
            "watchdog did not kill abandoned session within deadline")

    def test_watchdog_keeps_alive_while_attached(self):
        # Simulate a client staying attached: att=1.
        info = os.path.join(self.state, "info-websh-rt")
        with open(info, "w") as f:
            f.write("1 0")

        cmd = server._build_remote_command(
            "rt", self.fake_tmux, ttl_seconds=1, poll_seconds=1)
        self._run(cmd)

        # Even past TTL, session must survive because the attached
        # branch resets the seen-file each poll. 1.5 s covers 1-2 full
        # poll cycles past TTL — enough to observe that the keep-alive
        # path consistently fires (the killing path would have run by
        # the second cycle).
        time.sleep(1.5)
        self.assertIn(
            "websh-rt", self._sessions(),
            "watchdog killed a session that still had an attached client")

    def test_watchdog_idempotent_across_reconnects(self):
        # Two consecutive runs must not produce two watchdogs.
        info = os.path.join(self.state, "info-websh-rt")
        with open(info, "w") as f:
            f.write("1 0")  # keep alive so we can observe pidfile

        cmd = server._build_remote_command(
            "rt", self.fake_tmux, ttl_seconds=60, poll_seconds=60)
        self._run(cmd)

        pidfile = os.path.join(self.tmpdir, ".websh-ttl-rt.pid")
        # Give the bg watchdog a beat to write its pidfile.
        deadline = time.time() + 2
        while time.time() < deadline and not os.path.exists(pidfile):
            time.sleep(0.05)
        self.assertTrue(os.path.exists(pidfile), "pidfile not written")
        with open(pidfile) as f:
            first_pid = int(f.read().strip())

        # Second "connect" — the idempotency check should keep the
        # same watchdog; pidfile must still reference first_pid.
        self._run(cmd)
        time.sleep(0.3)
        with open(pidfile) as f:
            second_pid = int(f.read().strip())
        self.assertEqual(
            first_pid, second_pid,
            "reconnect spawned a second watchdog instead of reusing the first")


# ── terminate_remote_tmux + /api/disconnect terminate flag ─────────────


class TestTerminateRemoteTmux(unittest.TestCase):
    """Direct unit tests for SSHSession.terminate_remote_tmux()."""

    def _fake_session(self, persistent=True, slot_id="alice_host_22_xy",
                      alive=True, master_fd=-1, control_path=None):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = "fake-" + (slot_id or "x")
        s.persistent = persistent
        s.slot_id = slot_id
        s.alive = alive
        s.master_fd = master_fd
        s._control_path = control_path
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        s.tmux_cmd = "tmux"
        return s

    def test_noop_when_not_persistent(self):
        # No master_fd: a write would raise. Passes only if early-returned.
        s = self._fake_session(persistent=False)
        s.terminate_remote_tmux()

    def test_noop_when_no_slot_id(self):
        s = self._fake_session(slot_id=None)
        s.terminate_remote_tmux()

    def test_noop_when_dead(self):
        s = self._fake_session(alive=False)
        s.terminate_remote_tmux()

    def test_writes_both_kill_channels(self):
        r, w = os.pipe()
        try:
            s = self._fake_session(slot_id="alice_host_22_xy", master_fd=w)
            # Skip the real sleeps to keep the test fast.
            with unittest.mock.patch.object(time, "sleep", lambda _: None):
                s.terminate_remote_tmux()
            os.set_blocking(r, False)
            try:
                data = os.read(r, 8192)
            except (BlockingIOError, OSError):
                data = b""
            self.assertIn(
                b"\x02:kill-session -t websh-alice_host_22_xy\r", data)
            self.assertIn(
                b"\x03tmux kill-session -t websh-alice_host_22_xy\r", data)
        finally:
            for fd in (r, w):
                try:
                    os.close(fd)
                except OSError:
                    pass

    def test_skips_second_write_when_session_died_after_first(self):
        r, w = os.pipe()
        try:
            s = self._fake_session(slot_id="ok", master_fd=w)
            # First sleep flips alive=False so the second write is skipped.
            calls = {"n": 0}
            def fake_sleep(_):
                calls["n"] += 1
                if calls["n"] == 1:
                    s.alive = False
            with unittest.mock.patch.object(time, "sleep", fake_sleep):
                s.terminate_remote_tmux()
            os.set_blocking(r, False)
            try:
                data = os.read(r, 8192)
            except (BlockingIOError, OSError):
                data = b""
            self.assertIn(b"\x02:kill-session -t websh-ok\r", data)
            self.assertNotIn(b"\x03tmux kill-session", data)
        finally:
            for fd in (r, w):
                try:
                    os.close(fd)
                except OSError:
                    pass

    def test_oserror_on_write_is_swallowed(self):
        r, w = os.pipe()
        os.close(w)
        try:
            s = self._fake_session(slot_id="ok", master_fd=w)
            # Must not raise even though the FD is closed.
            with unittest.mock.patch.object(time, "sleep", lambda _: None):
                s.terminate_remote_tmux()
        finally:
            try:
                os.close(r)
            except OSError:
                pass

    def test_primary_uses_controlmaster_when_socket_exists(self):
        # Create a real file so os.path.exists() returns True.
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        with open(sock, "w") as f:
            f.write("")
        try:
            s = self._fake_session(slot_id="ok", control_path=sock)
            calls = []
            def fake_run(cmd, **kw):
                calls.append(cmd)
                class R:
                    returncode = 0
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                s.terminate_remote_tmux()
            self.assertEqual(len(calls), 1)
            cmd = calls[0]
            self.assertEqual(cmd[0], "ssh")
            self.assertIn("ControlPath=" + sock, cmd)
            self.assertIn("kill-session", cmd)
            self.assertIn("websh-ok", cmd)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_primary_falls_back_to_pty_on_nonzero_exit(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        with open(sock, "w") as f:
            f.write("")
        r, w = os.pipe()
        try:
            s = self._fake_session(
                slot_id="ok", master_fd=w, control_path=sock)
            def fake_run(cmd, **kw):
                class R:
                    returncode = 1
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                with unittest.mock.patch.object(time, "sleep", lambda _: None):
                    s.terminate_remote_tmux()
            os.set_blocking(r, False)
            try:
                data = os.read(r, 8192)
            except (BlockingIOError, OSError):
                data = b""
            # Fallback path: both PTY writes should have happened.
            self.assertIn(b"\x02:kill-session -t websh-ok\r", data)
            self.assertIn(b"\x03tmux kill-session -t websh-ok\r", data)
        finally:
            for fd in (r, w):
                try:
                    os.close(fd)
                except OSError:
                    pass
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_primary_skipped_when_socket_missing(self):
        # control_path is set but the file doesn't exist (master still
        # authenticating, or crashed).
        s = self._fake_session(
            slot_id="ok", master_fd=-1,
            control_path="/nonexistent/websh-mux-xxxx.sock")
        called = {"n": 0}
        def fake_run(cmd, **kw):
            called["n"] += 1
            class R:
                returncode = 0
            return R()
        # master_fd is -1 (sentinel) so the fallback path early-returns,
        # but the alive check also short-circuits it when alive=False.
        s.alive = False
        with unittest.mock.patch.object(server.subprocess, "run", fake_run):
            s.terminate_remote_tmux()
        self.assertEqual(called["n"], 0)


class TestDisconnectTerminateFlag(LiveServerCase):
    """HTTP-level: /api/disconnect routes the terminate flag correctly."""

    CONFIG = {"connections": []}

    def setUp(self):
        with server.sessions_lock:
            server.sessions.clear()

    def tearDown(self):
        with server.sessions_lock:
            server.sessions.clear()

    def _seed_fake(self, sid, persistent=True):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = sid
        s.persistent = persistent
        s.slot_id = "ok" if persistent else None
        s.alive = True
        s.master_fd = -1
        s._key_file = None
        s._control_path = None
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        s.tmux_cmd = "tmux"
        s.terminate_calls = 0
        s.close_calls = 0
        def fake_terminate():
            s.terminate_calls += 1
        def fake_close():
            s.close_calls += 1
        s.terminate_remote_tmux = fake_terminate
        s.close = fake_close
        with server.sessions_lock:
            server.sessions[sid] = s
        return s

    def test_terminate_true_calls_terminate_then_close(self):
        sid = "fake-sess-1"
        s = self._seed_fake(sid, persistent=True)
        body, code = self._post("/api/disconnect",
                                {"session_id": sid, "terminate": True})
        self.assertEqual(code, 200)
        self.assertEqual(s.terminate_calls, 1)
        self.assertEqual(s.close_calls, 1)

    def test_terminate_false_skips_terminate(self):
        sid = "fake-sess-2"
        s = self._seed_fake(sid, persistent=True)
        body, code = self._post("/api/disconnect",
                                {"session_id": sid, "terminate": False})
        self.assertEqual(code, 200)
        self.assertEqual(s.terminate_calls, 0)
        self.assertEqual(s.close_calls, 1)

    def test_default_no_terminate(self):
        sid = "fake-sess-3"
        s = self._seed_fake(sid, persistent=True)
        # No terminate field at all → defaults to no-terminate.
        body, code = self._post("/api/disconnect", {"session_id": sid})
        self.assertEqual(code, 200)
        self.assertEqual(s.terminate_calls, 0)
        self.assertEqual(s.close_calls, 1)

    def test_terminate_on_non_persistent_still_calls_method(self):
        # The handler doesn't filter on persistent — the method itself
        # is the no-op gate. This documents that contract.
        sid = "fake-sess-4"
        s = self._seed_fake(sid, persistent=False)
        body, code = self._post("/api/disconnect",
                                {"session_id": sid, "terminate": True})
        self.assertEqual(code, 200)
        self.assertEqual(s.terminate_calls, 1)
        self.assertEqual(s.close_calls, 1)

    def test_unknown_session_id_is_ok(self):
        body, code = self._post("/api/disconnect",
                                {"session_id": "no-such-session",
                                 "terminate": True})
        self.assertEqual(code, 200)


class TestEndToEndPersistent(LiveServerCase):
    """End-to-end: spawn a real SSHSession against localhost, verify
    the remote tmux session materializes, then verify
    terminate_remote_tmux actually kills it via the ControlMaster
    side-channel.

    Auto-skips unless localhost accepts key-based ssh and has tmux
    installed. This is a confidence check — the contract is already
    covered by TestTerminateRemoteTmux; this proves the pieces fit
    when a real ssh + tmux are in the loop.

    Set WEBSH_E2E=1 to force-require (fail if probe fails) — useful
    in CI environments where the fixture is guaranteed.
    """

    START_SERVER = False  # talks straight to SSHSession, no HTTP server
    _skip_reason = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._skip_reason = cls._probe()
        if cls._skip_reason and os.environ.get("WEBSH_E2E") == "1":
            raise RuntimeError(
                "WEBSH_E2E=1 set but probe failed: " + cls._skip_reason)

    @staticmethod
    def _probe():
        try:
            r = subprocess.run(
                ["ssh",
                 "-o", "BatchMode=yes",
                 "-o", "ConnectTimeout=2",
                 "-o", "StrictHostKeyChecking=no",
                 "-o", "UserKnownHostsFile=/dev/null",
                 "localhost", "tmux -V"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            if r.returncode != 0:
                return "ssh localhost tmux -V failed (rc={}): {}".format(
                    r.returncode,
                    r.stderr[:160].decode("latin-1", errors="replace").strip())
            if b"tmux " not in r.stdout:
                return "tmux -V returned unexpected output"
            return None
        except (OSError, subprocess.SubprocessError) as e:
            return "probe raised: {}".format(e)

    def setUp(self):
        if self._skip_reason:
            self.skipTest(self._skip_reason)

    @staticmethod
    def _ssh_cmd(*args):
        return ["ssh",
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=2",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "localhost"] + list(args)

    def _has_session(self, slot):
        r = subprocess.run(
            self._ssh_cmd("tmux", "has-session", "-t", "websh-" + slot),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5)
        return r.returncode == 0

    def _force_kill(self, slot):
        subprocess.run(
            self._ssh_cmd("tmux", "kill-session", "-t", "websh-" + slot),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5)

    def test_spawn_then_controlmaster_terminate(self):
        # Per-run unique label so parallel/reruns don't collide.
        slot = "ete{}".format(str(int(time.time() * 1000))[-10:])
        self.addCleanup(self._force_kill, slot)

        # Pre-condition: no leftover session from a previous run.
        if self._has_session(slot):
            self._force_kill(slot)
            time.sleep(0.2)

        sid = str(uuid.uuid4())
        user = os.environ.get("USER") or "root"
        session = server.SSHSession(
            session_id=sid,
            host="localhost",
            port=22,
            username=user,
            password="",
            cols=80, rows=24,
            persistent=True,
            slot_id=slot,
        )
        try:
            # Wait for the tmux session to materialize.
            deadline = time.time() + 8
            while time.time() < deadline:
                if self._has_session(slot):
                    break
                time.sleep(0.2)
            self.assertTrue(
                self._has_session(slot),
                "remote tmux session never appeared")

            # Wait for ControlMaster socket to be ready.
            deadline = time.time() + 4
            while time.time() < deadline:
                if (session._control_path
                        and os.path.exists(session._control_path)):
                    break
                time.sleep(0.1)
            self.assertTrue(
                session._control_path
                and os.path.exists(session._control_path),
                "ControlMaster socket never appeared at {}".format(
                    session._control_path))

            # The actual test: terminate via the primary (mux) path.
            session.terminate_remote_tmux()

            # Give the remote side a moment to reap.
            time.sleep(0.3)
            self.assertFalse(
                self._has_session(slot),
                "tmux session still alive after terminate_remote_tmux")
        finally:
            session.close()


class TestBodySizeCap(unittest.TestCase):
    """_body() must reject an oversize Content-Length BEFORE reading it, so
    a bogus header can't make the single-process server buffer gigabytes."""

    def _handler(self, content_length, rfile):
        h = server.Handler.__new__(server.Handler)
        h.headers = {"Content-Length": str(content_length)}
        h.rfile = rfile
        return h

    def test_oversize_body_rejected_before_read(self):
        class TrackingRfile(object):
            def __init__(self_):
                self_.read_called = False

            def read(self_, n):
                self_.read_called = True
                return b"x" * min(n, 10)

        rf = TrackingRfile()
        h = self._handler(server.MAX_BODY_SIZE + 1, rf)
        with self.assertRaises(ValueError):
            h._body()
        self.assertFalse(rf.read_called,
                         "oversize body must not be read into memory")

    def test_body_at_cap_is_read(self):
        payload = b"a" * 32
        h = self._handler(len(payload), io.BytesIO(payload))
        self.assertEqual(h._body(), payload)

    def test_empty_body(self):
        h = self._handler(0, io.BytesIO(b""))
        self.assertEqual(h._body(), b"")


class TestCleanupLockContention(unittest.TestCase):
    """cleanup() must not hold sessions_lock while calling session.close(),
    which blocks for up to ~0.5s (SIGTERM -> WNOHANG polls -> SIGKILL ->
    waitpid). Holding the lock across that stalls every endpoint."""

    def test_cleanup_releases_lock_before_close(self):
        observed = {}

        class FakeExpired(object):
            def is_expired(self_):
                return True

            def close(self_):
                # sessions_lock is a plain (non-reentrant) Lock, so if
                # cleanup() still held it, this non-blocking acquire — even
                # from the same thread — returns False.
                got = server.sessions_lock.acquire(blocking=False)
                observed["lock_free_during_close"] = got
                if got:
                    server.sessions_lock.release()

        sid = str(uuid.uuid4())
        with unittest.mock.patch.dict(
                server.sessions, {sid: FakeExpired()}, clear=True):
            server.cleanup()
            self.assertNotIn(sid, server.sessions,
                             "expired session should be removed")
        self.assertTrue(
            observed.get("lock_free_during_close"),
            "cleanup() held sessions_lock while calling close()")


class TestReapChild(unittest.TestCase):
    """_read_loop's auth-fail branch SIGTERMs the child and breaks before
    the inline WNOHANG reap, so _reap_child() in the finally must reap it —
    otherwise it lingers as a zombie holding a counted slot until timeout."""

    def test_reaps_unreaped_child(self):
        s = server.SSHSession.__new__(server.SSHSession)
        s._exit_status = None
        s._reap_lock = threading.Lock()
        s._child_reaped = False
        child = os.fork()
        if child == 0:
            # Mimic ssh after the auth-fail SIGTERM: blocked, killed by
            # the signal _reap_child sends.
            try:
                time.sleep(30)
            finally:
                os._exit(0)
        s.pid = child
        s._reap_child()
        self.assertIsNotNone(s._exit_status, "child was not reaped")
        # A second waitpid proves it is gone, not a lingering zombie.
        with self.assertRaises(ChildProcessError):
            os.waitpid(child, os.WNOHANG)

    def test_noop_when_already_reaped(self):
        s = server.SSHSession.__new__(server.SSHSession)
        s._exit_status = 1234
        s._reap_lock = threading.Lock()
        s._child_reaped = False
        s.pid = 999999  # never touched: the guard returns first
        with unittest.mock.patch("os.kill",
                                 side_effect=AssertionError("must not kill")):
            s._reap_child()
        self.assertEqual(s._exit_status, 1234)

    def test_auth_fail_path_in_read_loop_reaps_child(self):
        """Integration guard for the actual reported path: _read_loop's
        auth-fail branch SIGTERMs the child and breaks *before* the inline
        WNOHANG reap, so only the finally's _reap_child() collects it. The
        two tests above exercise _reap_child() in isolation; this drives the
        real loop end-to-end and leaves a zombie (fails) without the fix."""
        import pty
        master, slave = pty.openpty()
        pid = os.fork()
        if pid == 0:  # child: emit an auth-fail line, then block until killed
            os.close(master)
            try:
                os.write(slave, b"Permission denied, please try again.\r\n")
                time.sleep(30)
            finally:
                os._exit(0)
        os.close(slave)
        s = server.SSHSession.__new__(server.SSHSession)
        s.master_fd = master
        s.pid = pid
        s.id = "test-authfail"
        s.alive = True
        s.is_background = False
        s._password = None
        s._password_sent = True   # take the auth-watch branch, not pw-typing
        s.auth_failed = False
        s._auth_buf = b""
        s._auth_bytes_seen = 0
        s.output_buf = b""
        s.buf_lock = threading.Lock()
        s._exit_status = None
        s._reap_lock = threading.Lock()
        s._child_reaped = False
        s._signal = lambda: None  # isolate: we assert on reaping, not signaling
        try:
            t = threading.Thread(target=s._read_loop, daemon=True)
            t.start()
            t.join(15)
            self.assertFalse(t.is_alive(),
                             "_read_loop did not exit on auth fail")
            self.assertTrue(s.auth_failed, "auth failure was not detected")
            self.assertIsNotNone(s._exit_status,
                                 "child was not reaped (zombie leak)")
            with self.assertRaises(ChildProcessError):
                os.waitpid(pid, os.WNOHANG)
        finally:
            try:
                os.close(master)
            except OSError:
                pass
            # Safety net: if an assertion failed before the reap, don't leak
            # the child process into the rest of the suite.
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (OSError, ChildProcessError):
                pass

    def test_poll_child_exit_holds_lock_during_waitpid(self):
        """#85: the inline self-exit reap must take _reap_lock BEFORE calling
        os.waitpid and keep it held while writing _exit_status. waitpid frees
        the child's pid for OS recycling the instant it reaps; if the lock is
        not held across waitpid+write, a concurrent _reap_child() can see
        _exit_status None / _child_reaped False and SIGTERM the recycled pid."""
        s = server.SSHSession.__new__(server.SSHSession)
        s._reap_lock = threading.Lock()
        s._exit_status = None
        s._child_reaped = False
        s.pid = 4242  # never signalled: mocked waitpid reports immediate exit

        observed = {}

        def fake_waitpid(pid, flags):
            # The whole point of the fix: the reap-serializing lock must
            # already be held at the moment waitpid (which reaps + frees the
            # pid) is invoked, and stay held through the status write.
            observed["locked_at_waitpid"] = s._reap_lock.locked()
            self.assertTrue(
                s._reap_lock.locked(),
                "os.waitpid called WITHOUT _reap_lock held — the reaped pid "
                "can be recycled before _exit_status is recorded (#85)")
            return (pid, 0)  # exited, status 0

        with unittest.mock.patch("os.waitpid", side_effect=fake_waitpid):
            broke = s._poll_child_exit()

        self.assertTrue(broke, "_poll_child_exit must return True on child exit")
        self.assertTrue(observed.get("locked_at_waitpid"),
                        "waitpid did not run under _reap_lock")
        self.assertEqual(s._exit_status, 0,
                         "_exit_status not recorded from the reap")
        self.assertTrue(s._child_reaped,
                        "_child_reaped not set — finally's _reap_child would "
                        "then re-issue a kill on a possibly-recycled pid")
        # Lock must be released again afterwards (no leak across the gate).
        self.assertFalse(s._reap_lock.locked())

    def test_reap_child_is_noop_after_poll_recorded_exit(self):
        """#85 second half: once _poll_child_exit records the self-exit and
        sets _child_reaped, the finally's _reap_child() must issue NO os.kill
        (the child is already gone; any kill now races a recycled pid)."""
        s = server.SSHSession.__new__(server.SSHSession)
        s._reap_lock = threading.Lock()
        s._exit_status = None
        s._child_reaped = False
        s.pid = 4242

        with unittest.mock.patch("os.waitpid", return_value=(4242, 0)):
            self.assertTrue(s._poll_child_exit())

        # _reap_child must take the same one-shot guard and bail without
        # signalling. Patch BOTH kill and waitpid so any teardown syscall
        # would be loud.
        with unittest.mock.patch(
                "os.kill",
                side_effect=AssertionError("reap_child must not kill after "
                                           "poll already reaped the child")), \
             unittest.mock.patch(
                "os.waitpid",
                side_effect=AssertionError("reap_child must not waitpid after "
                                           "poll already reaped the child")):
            s._reap_child()  # must be a clean no-op

        self.assertEqual(s._exit_status, 0)
        self.assertTrue(s._child_reaped)

    def test_poll_child_exit_returns_false_while_child_alive(self):
        """Steady state: WNOHANG returns (0, 0) while the child runs, so
        _poll_child_exit reports 'keep looping' and records nothing."""
        s = server.SSHSession.__new__(server.SSHSession)
        s._reap_lock = threading.Lock()
        s._exit_status = None
        s._child_reaped = False
        s.pid = 4242
        with unittest.mock.patch("os.waitpid", return_value=(0, 0)):
            self.assertFalse(s._poll_child_exit())
        self.assertIsNone(s._exit_status)
        self.assertFalse(s._child_reaped)
        self.assertFalse(s._reap_lock.locked())


class TestCloseAllSessions(unittest.TestCase):
    """_close_all_sessions() — the teardown helper the SIGINT/SIGTERM path
    runs on the main thread (moved out of the signal handler)."""

    def setUp(self):
        server.sessions.clear()

    def tearDown(self):
        server.sessions.clear()

    def test_closes_every_session_and_clears_registry(self):
        closed = []

        class Sess(object):
            def __init__(self, sid):
                self.id = sid
            def close(self):
                closed.append(self.id)

        for i in range(3):
            server.sessions["s{}".format(i)] = Sess("s{}".format(i))
        server._close_all_sessions()
        self.assertEqual(sorted(closed), ["s0", "s1", "s2"])
        self.assertEqual(len(server.sessions), 0)

    def test_one_failing_close_does_not_skip_the_rest(self):
        closed = []

        class GoodSess(object):
            def __init__(self, sid):
                self.id = sid
            def close(self):
                closed.append(self.id)

        class BadSess(object):
            id = "bad"
            def close(self):
                raise RuntimeError("wedged teardown")

        server.sessions["a"] = GoodSess("a")
        server.sessions["bad"] = BadSess()
        server.sessions["b"] = GoodSess("b")
        server._close_all_sessions()  # must not propagate
        self.assertEqual(sorted(closed), ["a", "b"])
        self.assertEqual(len(server.sessions), 0)

    def test_empty_registry_is_a_noop(self):
        server._close_all_sessions()
        self.assertEqual(len(server.sessions), 0)


class TestRequestTimeout(unittest.TestCase):
    """A slow/stalled client must not pin a worker thread forever.

    Regression guard for the missing per-connection socket timeout: with
    Handler.timeout unset, a client that opens a connection and dribbles
    (or never finishes) its request holds a worker until the peer goes
    away on its own. Under the hard MAX_THREADS cap that is a trivial DoS.
    """

    def test_timeout_attribute_is_set(self):
        self.assertIsNotNone(
            server.Handler.timeout,
            "Handler.timeout must be set so StreamRequestHandler bounds the "
            "request-read/response-write phases")

    def test_stalled_request_is_reclaimed(self):
        import socket as _socket
        orig = server.Handler.timeout
        server.Handler.timeout = 0.5  # shrink so the test runs fast
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        time.sleep(0.1)
        try:
            s = _socket.create_connection(("127.0.0.1", port), timeout=5)
            # Send a complete request line but never the blank line that
            # ends the headers — a classic slowloris stall.
            s.sendall(b"GET /api/ping HTTP/1.1\r\n")
            s.settimeout(5)
            start = time.time()
            try:
                # When the header read times out at ~0.5s the server closes
                # the connection; recv then returns b'' (clean EOF). If the
                # timeout were missing, recv would block until our own 5s
                # client timeout fires instead.
                data = s.recv(1024)
            except (ConnectionResetError, _socket.timeout):
                data = b""
            elapsed = time.time() - start
            s.close()
            self.assertLess(
                elapsed, 3.0,
                "stalled connection was not reclaimed near Handler.timeout "
                "(took {:.2f}s)".format(elapsed))
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.Handler.timeout = orig


class TestParkedWaiterWake(unittest.TestCase):
    """The per-wait socketpair path: instant wake from _signal while
    parked in ONE blocking select, FIN wake via the client socket, and
    teardown while a waiter is parked."""

    def _session(self):
        s = server.SSHSession.__new__(server.SSHSession)
        s._data_event = threading.Event()
        s._waiters = set()
        s._waiters_lock = threading.Lock()
        return s

    def test_signal_wakes_parked_waiter_fast(self):
        s = self._session()
        woke = []
        def waiter():
            t0 = time.time()
            s.wait_for_data(None, timeout=5)
            woke.append(time.time() - t0)
        th = threading.Thread(target=waiter, daemon=True)
        th.start()
        time.sleep(0.1)            # let it park
        t0 = time.time()
        s._signal()
        th.join(2)
        self.assertTrue(woke, "waiter never returned")
        self.assertLess(time.time() - t0, 0.5,
                        "signal wake took too long")
        with s._waiters_lock:
            self.assertEqual(len(s._waiters), 0, "wake socket leaked")

    def test_client_fin_wakes_parked_waiter(self):
        import socket as _socket
        s = self._session()
        a, b = _socket.socketpair()
        woke = []
        def waiter():
            t0 = time.time()
            s.wait_for_data(a, timeout=5)
            woke.append(time.time() - t0)
        th = threading.Thread(target=waiter, daemon=True)
        th.start()
        time.sleep(0.1)
        b.close()                  # FIN
        th.join(2)
        a.close()
        self.assertTrue(woke and woke[0] < 1.0,
                        "FIN did not wake the parked waiter; %r" % woke)

    def test_close_while_parked_does_not_hang_or_crash(self):
        s = self._session()
        s.alive = True
        s.master_fd = -1
        s.pid = None
        s._reap_lock = threading.Lock()
        s._child_reaped = True
        s._exit_status = 0
        s._key_file = None
        s._control_path = None
        s.persistent = False
        s.slot_id = None
        done = []
        def waiter():
            s.wait_for_data(None, timeout=5)
            done.append(1)
        th = threading.Thread(target=waiter, daemon=True)
        th.start()
        time.sleep(0.1)
        s.close()                  # signals via _signal()
        th.join(2)
        self.assertTrue(done, "waiter did not return after close()")
        with s._waiters_lock:
            self.assertEqual(len(s._waiters), 0)

    def test_signal_in_registration_window_is_not_lost(self):
        # The lost-wakeup window: a signal that lands AFTER the first
        # is_set() check but BEFORE the wake socket is registered gets
        # no byte — the post-registration re-check must catch it.
        # Deterministic: fire the signal from inside socketpair(),
        # which runs exactly inside that window.
        s = self._session()
        import socket as _socket
        real_pair = _socket.socketpair
        def evil_pair(*a, **kw):
            s._data_event.set()      # the signal, mid-window
            return real_pair(*a, **kw)
        orig = server.socket.socketpair
        server.socket.socketpair = evil_pair
        try:
            t0 = time.time()
            s.wait_for_data(None, timeout=5)
            self.assertLess(time.time() - t0, 0.5,
                            "mid-window signal was lost")
            self.assertFalse(s._data_event.is_set())
        finally:
            server.socket.socketpair = orig

    def test_socketpair_exhaustion_falls_back_to_slice_loop(self):
        s = self._session()
        orig = server.socket.socketpair
        server.socket.socketpair = unittest.mock.Mock(
            side_effect=OSError("EMFILE"))
        try:
            woke = []
            def waiter():
                t0 = time.time()
                s.wait_for_data(None, timeout=5)
                woke.append(time.time() - t0)
            th = threading.Thread(target=waiter, daemon=True)
            th.start()
            time.sleep(0.1)
            s._signal()
            th.join(2)
            self.assertTrue(woke, "fallback waiter never returned")
            self.assertLess(woke[0], 1.0,
                            "slice-loop fallback did not wake on signal")
        finally:
            server.socket.socketpair = orig

    def test_pre_set_event_returns_immediately_without_socketpair(self):
        s = self._session()
        s._data_event.set()
        t0 = time.time()
        s.wait_for_data(None, timeout=5)
        self.assertLess(time.time() - t0, 0.1)
        self.assertFalse(s._data_event.is_set(), "event consumed")


class TestSessionRecording(unittest.TestCase):
    """asciicast v2 recording: header shape, event framing, 0600 mode,
    input off by default, best-effort failure, knob-off zero-cost."""

    def _bare_session(self):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = str(uuid.uuid4())
        s._rec = None
        s._rec_t0 = 0.0
        s._rec_lock = threading.Lock()
        s.alive = True
        s.master_fd = -1
        s.last_activity = 0
        return s

    def test_open_record_close_roundtrip(self):
        d = tempfile.mkdtemp()
        orig = server.WEBSH_RECORD_DIR
        server.WEBSH_RECORD_DIR = d
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            self.assertIsNotNone(s._rec)
            s._record("o", b"hello \xff world")   # invalid utf-8 replaced
            s._record("r", "100x30")
            s._rec_close()
            files = os.listdir(d)
            self.assertEqual(len(files), 1)
            path = os.path.join(d, files[0])
            self.assertTrue(files[0].endswith("-" + s.id + ".cast"))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            lines = open(path, encoding="utf-8").read().splitlines()
            header = json.loads(lines[0])
            self.assertEqual(header["version"], 2)
            self.assertEqual(header["width"], 80)
            self.assertEqual(header["height"], 24)
            self.assertIsInstance(header["timestamp"], int)
            ev1 = json.loads(lines[1])
            self.assertEqual(ev1[1], "o")
            self.assertIn("hello", ev1[2])
            self.assertGreaterEqual(ev1[0], 0)
            ev2 = json.loads(lines[2])
            self.assertEqual(ev2[1:], ["r", "100x30"])
            self.assertGreaterEqual(ev2[0], ev1[0])
        finally:
            server.WEBSH_RECORD_DIR = orig
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_knob_off_is_inert(self):
        orig = server.WEBSH_RECORD_DIR
        server.WEBSH_RECORD_DIR = ""
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            self.assertIsNone(s._rec)
            s._record("o", b"data")   # no-op, must not raise
            s._rec_close()
        finally:
            server.WEBSH_RECORD_DIR = orig

    def test_input_is_never_recorded_even_when_flag_forced(self):
        # Keystroke/input recording is hard-disabled (compiled out): the 'i'
        # event is never written, so a password typed at an in-session prompt
        # cannot reach disk. The env var can't enable it; this forces the
        # in-process flag True to prove the input tee itself is gone. Output
        # recording still works (the control assertion).
        d = tempfile.mkdtemp()
        orig_dir = server.WEBSH_RECORD_DIR
        orig_in = server.WEBSH_RECORD_INPUT
        server.WEBSH_RECORD_DIR = d
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            r, w = os.pipe()
            s.master_fd = w
            server.WEBSH_RECORD_INPUT = True   # force-enable: must STILL not record
            s.write(b"secret-keystrokes")
            s._record("o", b"server-output")   # output IS recorded (control)
            s._rec_close()
            os.close(r); os.close(w)
            body = open(os.path.join(d, os.listdir(d)[0]),
                        encoding="utf-8").read()
            self.assertNotIn("secret-keystrokes", body,
                             "input must never be recorded (hard-disabled)")
            self.assertIn("server-output", body,
                          "output recording still works")
        finally:
            server.WEBSH_RECORD_DIR = orig_dir
            server.WEBSH_RECORD_INPUT = orig_in
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_write_failure_disables_not_kills(self):
        d = tempfile.mkdtemp()
        orig = server.WEBSH_RECORD_DIR
        server.WEBSH_RECORD_DIR = d
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            s._rec.close()          # sabotage: closed file -> write raises
            s._record("o", b"x")    # must swallow and disable
            self.assertIsNone(s._rec)
            s._record("o", b"y")    # still inert
            s._rec_close()
        finally:
            server.WEBSH_RECORD_DIR = orig
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_split_utf8_survives_chunk_boundary(self):
        d = tempfile.mkdtemp()
        orig = server.WEBSH_RECORD_DIR
        server.WEBSH_RECORD_DIR = d
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            two = "Привет".encode("utf-8")   # 12 bytes, 2 per char
            s._record("o", two[:3])           # splits the 2nd char
            s._record("o", two[3:])
            s._rec_close()
            lines = open(os.path.join(d, os.listdir(d)[0]),
                         encoding="utf-8").read().splitlines()
            text = "".join(json.loads(ln)[2] for ln in lines[1:])
            self.assertEqual(text, "Привет")    # reassembled across chunks
            self.assertNotIn("\ufffd", text,
                             "split sequence must not become U+FFFD")
        finally:
            server.WEBSH_RECORD_DIR = orig
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_resize_emits_r_event(self):
        d = tempfile.mkdtemp()
        orig = server.WEBSH_RECORD_DIR
        server.WEBSH_RECORD_DIR = d
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            s._set_winsize = lambda c, r: None
            s.resize(132, 43)
            s._rec_close()
            lines = open(os.path.join(d, os.listdir(d)[0]),
                         encoding="utf-8").read().splitlines()
            ev = json.loads(lines[1])
            self.assertEqual(ev[1:], ["r", "132x43"])
        finally:
            server.WEBSH_RECORD_DIR = orig
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_size_cap_stops_recording(self):
        d = tempfile.mkdtemp()
        orig = server.WEBSH_RECORD_DIR
        orig_cap = server.WEBSH_RECORD_MAX_BYTES
        server.WEBSH_RECORD_DIR = d
        server.WEBSH_RECORD_MAX_BYTES = 64
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            s._record("o", b"x" * 200)
            self.assertIsNone(s._rec, "cap must disable the recording")
            s._record("o", b"more")   # inert
        finally:
            server.WEBSH_RECORD_DIR = orig
            server.WEBSH_RECORD_MAX_BYTES = orig_cap
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    def test_record_dir_is_0700(self):
        base = tempfile.mkdtemp()
        d = os.path.join(base, "rec")
        orig = server.WEBSH_RECORD_DIR
        server.WEBSH_RECORD_DIR = d
        try:
            s = self._bare_session()
            s._rec_open(80, 24)
            s._rec_close()
            self.assertEqual(os.stat(d).st_mode & 0o777, 0o700,
                             "filenames carry live sids - dir must be 0700")
        finally:
            server.WEBSH_RECORD_DIR = orig
            import shutil
            shutil.rmtree(base, ignore_errors=True)

    def test_unwritable_dir_disables_recording(self):
        orig = server.WEBSH_RECORD_DIR
        server.WEBSH_RECORD_DIR = "/proc/no-such-dir/websh"
        try:
            s = self._bare_session()
            s._rec_open(80, 24)     # must not raise
            self.assertIsNone(s._rec)
        finally:
            server.WEBSH_RECORD_DIR = orig


if __name__ == "__main__":
    unittest.main()
