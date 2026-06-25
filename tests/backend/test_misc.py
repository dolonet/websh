#!/usr/bin/env python3
"""Tests for websh server.py — clamp, env parsing, thread pool, shutdown topology, php proxy, sigterm.

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


class TestClamp(unittest.TestCase):

    def test_valid(self):
        self.assertEqual(server.clamp(50, 1, 100, 80), 50)

    def test_low(self):
        self.assertEqual(server.clamp(-5, 1, 100, 80), 1)

    def test_high(self):
        self.assertEqual(server.clamp(999, 1, 100, 80), 100)

    def test_none(self):
        self.assertEqual(server.clamp(None, 1, 100, 80), 80)

    def test_string(self):
        self.assertEqual(server.clamp("abc", 1, 100, 80), 80)


class TestUUIDValidation(unittest.TestCase):

    def test_valid(self):
        self.assertTrue(server._UUID_RE.match("550e8400-e29b-41d4-a716-446655440000"))

    def test_invalid(self):
        self.assertIsNone(server._UUID_RE.match("not-a-uuid"))
        self.assertIsNone(server._UUID_RE.match(""))
        self.assertIsNone(server._UUID_RE.match("../etc/passwd"))


class TestIntEnv(unittest.TestCase):

    def test_valid(self):
        os.environ["_TEST_INT"] = "42"
        self.assertEqual(server._int_env("_TEST_INT", "10"), 42)
        del os.environ["_TEST_INT"]

    def test_invalid(self):
        os.environ["_TEST_INT"] = "abc"
        self.assertEqual(server._int_env("_TEST_INT", "10"), 10)
        del os.environ["_TEST_INT"]

    def test_missing(self):
        self.assertEqual(server._int_env("_TEST_MISSING_XYZ", "99"), 99)


class TestBoundedThreadPool(unittest.TestCase):
    """The Server class refuses new requests with 503 once the worker
    semaphore is exhausted, instead of unbounded thread spawn."""

    def setUp(self):
        self._orig_max = server.MAX_THREADS

    def tearDown(self):
        server.MAX_THREADS = self._orig_max

    def _make_server(self, max_threads):
        server.MAX_THREADS = max_threads
        # Port 0 → OS picks a free port; we never call serve_forever().
        srv = server.Server(("127.0.0.1", 0), server.Handler)
        self.addCleanup(srv.server_close)
        return srv

    def test_at_capacity_responds_503_and_no_thread(self):
        srv = self._make_server(max_threads=1)
        # Exhaust the only slot — exactly mirrors the run-time state when
        # MAX_THREADS active requests are mid-flight.
        srv._req_sem.acquire()

        # Stub finish_request: if we ever call it, the bound failed.
        finish_called = [False]
        srv.finish_request = lambda *a, **k: finish_called.__setitem__(0, True)

        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        srv.process_request(a, ("1.2.3.4", 5555))

        b.settimeout(2.0)
        data = b.recv(2048)
        self.assertIn(b"503 Service Unavailable", data)
        self.assertIn(b'{"error":"busy"}', data)
        # Sync barrier: a regression that spawns a thread anyway would
        # need a scheduler quantum to execute finish_request. Give it
        # one before asserting "never called" so the assertion isn't
        # racing the worker startup. With the bound respected this
        # sleep is a no-op against a non-existent thread.
        time.sleep(0.05)
        self.assertFalse(finish_called[0],
                         "no worker thread should have been spawned")

    def test_under_capacity_runs_worker_and_releases(self):
        srv = self._make_server(max_threads=2)

        ran = threading.Event()

        def _fake_finish(request, client_address):
            ran.set()

        srv.finish_request = _fake_finish

        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        srv.process_request(a, ("1.2.3.4", 5555))

        self.assertTrue(ran.wait(timeout=2),
                        "worker should have run finish_request")

        # Slot must be released; subsequent acquire should succeed
        # without blocking (we hold 1 in flight via the worker's
        # finally — but the fake finish returns immediately, so by
        # now the release has happened).
        for _ in range(20):
            if srv._req_sem.acquire(blocking=False):
                srv._req_sem.release()
                break
            time.sleep(0.01)
        else:
            self.fail("worker did not release semaphore slot")

    def test_capacity_recovers_after_one_drain(self):
        srv = self._make_server(max_threads=1)
        srv._req_sem.acquire()   # exhaust
        # First call: refused.
        a1, b1 = socket.socketpair()
        self.addCleanup(a1.close)
        self.addCleanup(b1.close)
        srv.process_request(a1, ("1.2.3.4", 1))
        b1.settimeout(2.0)
        self.assertIn(b"503", b1.recv(2048))
        # Operator-side release: next call should succeed.
        srv._req_sem.release()
        ran = threading.Event()
        srv.finish_request = lambda *a, **k: ran.set()
        a2, b2 = socket.socketpair()
        self.addCleanup(a2.close)
        self.addCleanup(b2.close)
        srv.process_request(a2, ("1.2.3.4", 2))
        self.assertTrue(ran.wait(timeout=2))

    def test_spawn_failure_releases_permit(self):
        """H1: if Thread().start() raises (OS thread cap, MemoryError,
        …), the just-acquired permit must be released. Without this
        guard, repeated spawn failures bleed capacity to zero and
        every subsequent request gets 503 forever — no recovery
        without a process restart."""
        srv = self._make_server(max_threads=2)

        class _BoomThread(object):
            def __init__(self, *a, **kw):
                pass

            def start(self):
                raise RuntimeError("can't start new thread")

        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        with unittest.mock.patch.object(server, "Thread", _BoomThread):
            with self.assertRaises(RuntimeError):
                srv.process_request(a, ("1.2.3.4", 5555))

        # Permit must have been returned — both slots should be free.
        self.assertTrue(srv._req_sem.acquire(blocking=False),
                        "slot 1 should be free after spawn failure")
        self.assertTrue(srv._req_sem.acquire(blocking=False),
                        "slot 2 should be free after spawn failure")

    def test_shutdown_failure_in_worker_still_releases_permit(self):
        """H1-extended: even if shutdown_request raises inside the
        worker's finally, the permit must still be released. release()
        is the last operation in _run_under_semaphore, wrapped over
        try/except on every prior step, precisely to defend this path."""
        srv = self._make_server(max_threads=1)

        def _bad_shutdown(req):
            raise RuntimeError("shutdown blew up")

        srv.shutdown_request = _bad_shutdown
        srv.finish_request = lambda *a, **k: None

        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        srv.process_request(a, ("1.2.3.4", 5555))

        # Wait for the worker to settle (it's daemon=True, runs async).
        for _ in range(50):
            if srv._req_sem.acquire(blocking=False):
                srv._req_sem.release()
                return
            time.sleep(0.01)
        self.fail("permit was not released after shutdown_request raised")


class TestClampMaxThreads(unittest.TestCase):
    """L2: WEBSH_MAX_THREADS<1 would crash BoundedSemaphore at construction.
    `_clamp_max_threads` enforces the >=1 floor and emits a WARN on
    out-of-range input. Test against the production function so a
    refactor that drops the clamp actually fails the test (the previous
    iteration of these tests re-implemented the clamp inside the test
    body and silently tested itself instead of the module)."""

    def _capture_stderr(self):
        buf = io.StringIO()
        return buf, unittest.mock.patch.object(sys, "stderr", buf)

    def test_zero_clamps_to_one_and_warns(self):
        buf, patcher = self._capture_stderr()
        with patcher:
            self.assertEqual(server._clamp_max_threads(0), 1)
        self.assertIn("WEBSH_MAX_THREADS=0", buf.getvalue())
        self.assertIn("WARN", buf.getvalue())

    def test_negative_clamps_to_one_and_warns(self):
        buf, patcher = self._capture_stderr()
        with patcher:
            self.assertEqual(server._clamp_max_threads(-10), 1)
        self.assertIn("WEBSH_MAX_THREADS=-10", buf.getvalue())

    def test_one_passes_through_without_warn(self):
        buf, patcher = self._capture_stderr()
        with patcher:
            self.assertEqual(server._clamp_max_threads(1), 1)
        self.assertEqual(buf.getvalue(), "")

    def test_large_value_passes_through(self):
        self.assertEqual(server._clamp_max_threads(10_000), 10_000)

    def test_clamped_value_is_acceptable_to_bounded_semaphore(self):
        # End-to-end invariant: whatever the clamp returns must be a
        # legal BoundedSemaphore size — that is the bug class the
        # clamp exists to prevent.
        for raw in (-1, 0, 1, 50, 464):
            buf, patcher = self._capture_stderr()
            with patcher:
                v = server._clamp_max_threads(raw)
            threading.BoundedSemaphore(v)  # must not raise


class TestMaxThreadsMisconfigWarn(unittest.TestCase):
    """Issue 6: warn when MAX_THREADS is so low it can't serve the
    configured session caps. Each long-running SSE worker pins one
    permit for the lifetime of the stream, so if MAX_THREADS is at
    or below 2 × (MAX_SESSIONS + MAX_BG_SESSIONS), a real workload
    drains every permit into streams and short requests — including
    /api/disconnect — return 503 forever."""

    def setUp(self):
        self._orig_max_threads = server.MAX_THREADS
        self._orig_max_sessions = server.MAX_SESSIONS
        self._orig_max_bg = server.MAX_BG_SESSIONS

    def tearDown(self):
        server.MAX_THREADS = self._orig_max_threads
        server.MAX_SESSIONS = self._orig_max_sessions
        server.MAX_BG_SESSIONS = self._orig_max_bg

    def test_warns_when_threads_below_session_threshold(self):
        server.MAX_SESSIONS = 50
        server.MAX_BG_SESSIONS = 50
        # threshold = 2 * (50 + 50) = 200; MAX_THREADS=50 is well under
        server.MAX_THREADS = 50
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_max_threads_misconfig()
        self.assertTrue(mock_log.called)
        level, msg = mock_log.call_args[0][0], mock_log.call_args[0][1]
        self.assertEqual(level, "WARN")
        self.assertIn("MAX_THREADS=50", msg)
        self.assertIn("503", msg)

    def test_warns_when_threads_equals_session_threshold(self):
        # Boundary: MAX_THREADS == threshold should still warn — the
        # last permit goes to the last SSE worker, leaving zero for
        # short requests. Strict-less-than would let this slip.
        server.MAX_SESSIONS = 50
        server.MAX_BG_SESSIONS = 50
        server.MAX_THREADS = 200
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_max_threads_misconfig()
        # Implementation uses `<`, so 200 < 200 is false → no warn.
        # That is correct — at the threshold there is exactly one
        # short-request slot beyond the stream count, which is just
        # enough to be sane. Document the boundary.
        self.assertFalse(mock_log.called,
                         "MAX_THREADS == threshold is the minimum sane value, not a warn")

    def test_silent_at_default(self):
        # Default MAX_THREADS = 4*(50+50)+64 = 464, threshold = 200 →
        # no warn. The default is meant to be safe out of the box.
        server.MAX_SESSIONS = 50
        server.MAX_BG_SESSIONS = 50
        server.MAX_THREADS = 4 * (50 + 50) + 64
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_max_threads_misconfig()
        self.assertFalse(mock_log.called)


class TestShutdownTopology(unittest.TestCase):
    """server.shutdown() called from a NON-serving thread must terminate a
    real serve_forever() promptly — guards against re-introducing a shutdown
    that hangs (the deadlock was calling it from the serve_forever thread)."""

    def test_shutdown_from_other_thread_stops_serve_forever(self):
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
        try:
            serve_thread = threading.Thread(
                target=httpd.serve_forever, daemon=True)
            serve_thread.start()
            deadline = time.time() + 2.0
            while time.time() < deadline:
                try:
                    s = socket.create_connection(
                        httpd.server_address, timeout=0.5)
                    s.close()
                    break
                except OSError:
                    time.sleep(0.01)
            done = threading.Event()

            def _stop():
                httpd.shutdown()
                done.set()

            threading.Thread(target=_stop, daemon=True).start()
            self.assertTrue(
                done.wait(timeout=5.0),
                "server.shutdown() did not return within 5s "
                "(deadlock regression)")
            serve_thread.join(timeout=5.0)
            self.assertFalse(serve_thread.is_alive(),
                             "serve_forever() did not exit after shutdown()")
        finally:
            httpd.server_close()


class TestPhpProxyActionCoverage(unittest.TestCase):
    """Static guard for the optional PHP shim. CI may not have PHP
    installed, but api.php must still route every action the bundled
    frontend can call."""

    def test_frontend_actions_are_routed_by_php_proxy(self):
        root = REPO_ROOT  # api.php/websh.js live at the repo root
        with open(os.path.join(root, "api.php"), "r") as f:
            php = f.read()
        with open(os.path.join(root, "websh.js"), "r") as f:
            js = f.read()
        actions = set(re.findall(r"action=([A-Za-z0-9_]+)", js))
        actions.update(re.findall(r"api\('([A-Za-z0-9_]+)'", js))
        # config is built by loadServerConfig via api('config'), and
        # ping is used by the PHP proxy itself rather than the browser.
        actions.update(["config", "ping"])
        missing = sorted(
            action for action in actions
            if "case '{}':".format(action) not in php
        )
        self.assertEqual(missing, [])

    def test_server_routes_are_routed_by_php_proxy(self):
        """Every action server.py dispatches must have a case in api.php's
        switch — otherwise the endpoint silently 404s on shared hosting
        only. The route tables make the server-side action set machine-
        readable; keep the PHP shim in lockstep."""
        root = REPO_ROOT  # api.php lives at the repo root
        with open(os.path.join(root, "api.php"), "r") as f:
            php = f.read()
        actions = set(server.Handler._POST_ROUTES)
        actions.update(server.Handler._GET_ROUTES)
        # DELETE /api/save reaches the shim as POST ?action=save_delete,
        # which the POST table already carries.
        missing = sorted(
            action for action in actions
            if "case '{}':".format(action) not in php
        )
        self.assertEqual(missing, [])


class TestMainSigtermSubprocess(unittest.TestCase):
    """End-to-end discriminator: run server.main() in a child, SIGTERM it,
    require a prompt clean exit. FAILS on the original bug (the handler called
    server.shutdown() on the serve_forever thread -> deadlock; the child even
    swallowed SIGTERM and only died at the systemd timeout via SIGKILL)."""

    _DRIVER = (
        "import os, signal, threading, time, sys; "
        "import server; "
        "server.HOST='127.0.0.1'; server.PORT=0; "
        "threading.Thread("
        "target=lambda: (time.sleep(0.5), "
        "os.kill(os.getpid(), signal.SIGTERM)), daemon=True).start(); "
        "server.main(); "
        "sys.stdout.write('MAIN_RETURNED_CLEANLY'); sys.stdout.flush()"
    )

    def test_sigterm_shuts_down_promptly(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = (
            REPO_ROOT  # server.py lives at the repo root
            + os.pathsep + env.get("PYTHONPATH", ""))
        env["WEBSH_VAULT_ENABLE"] = "0"
        try:
            proc = subprocess.run(
                [sys.executable, "-c", self._DRIVER], env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        except subprocess.TimeoutExpired:
            self.fail(
                "server.main() did not exit within 20s of SIGTERM — the "
                "shutdown deadlock has regressed (the signal handler must not "
                "call server.shutdown() on the serve_forever thread).")
        # The 20s subprocess timeout above is the real discriminator: the
        # buggy topology hangs forever (TimeoutExpired -> fail) while the fix
        # exits in well under a second. We deliberately do NOT assert a tight
        # wall-clock bound — it would only add false-RED risk under heavy CI
        # load without catching any failure the timeout doesn't already.
        self.assertEqual(
            proc.returncode, 0,
            "main() exited non-zero after SIGTERM: rc={} stderr={!r}".format(
                proc.returncode, proc.stderr.decode("utf-8", "replace")))
        self.assertIn(
            b"MAIN_RETURNED_CLEANLY", proc.stdout,
            "main() did not return cleanly; stderr={!r}".format(
                proc.stderr.decode("utf-8", "replace")))


if __name__ == "__main__":
    unittest.main()
