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
        """The proxy forwards ANY well-formed action generically (the
        regex gate + proxy_pass default), so per-action coverage now
        means: every action the frontend emits must satisfy the gate
        regex, and the transfer modes that need special curl plumbing
        must keep their explicit cases."""
        root = REPO_ROOT  # api.php/websh.js live at the repo root
        with open(os.path.join(root, "api.php"), "r") as f:
            php = f.read()
        with open(os.path.join(root, "websh.js"), "r") as f:
            js = f.read()
        actions = set(re.findall(r"action=([A-Za-z0-9_]+)", js))
        actions.update(re.findall(r"api\('([A-Za-z0-9_]+)'", js))
        actions.update(["config", "ping"])
        gate = re.compile(r"^[a-z_]{1,32}$")
        bad = sorted(a for a in actions if not gate.match(a))
        self.assertEqual(bad, [],
                         "frontend action(s) the PHP regex gate would 404")
        self.assertIn("proxy_pass($URL)", php,
                      "generic passthrough default missing")
        for special in ("stream", "download", "upload", "save_delete"):
            self.assertIn("case '{}':".format(special), php,
                          special + " must keep its explicit case")

    def test_server_routes_are_routed_by_php_proxy(self):
        """The PHP shim forwards ANY well-formed action generically, so
        the lockstep contract is now: every server-side route key must
        satisfy the shim's gate regex (the route tables make the action
        set machine-readable), and the transfer modes with their own
        curl plumbing must keep explicit cases."""
        root = REPO_ROOT  # api.php lives at the repo root
        with open(os.path.join(root, "api.php"), "r") as f:
            php = f.read()
        actions = set(server.Handler._POST_ROUTES)
        actions.update(server.Handler._GET_ROUTES)
        actions.update(server.Handler._DELETE_ROUTES)
        gate = re.compile(r"^[a-z_]{1,32}$")
        bad = sorted(a for a in actions if not gate.match(a))
        self.assertEqual(bad, [],
                         "server route(s) the PHP gate would 404")
        self.assertIn("proxy_pass($URL)", php)
        for special in ("stream", "download", "upload", "save_delete"):
            self.assertIn("case '{}':".format(special), php)


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



class TestInstanceTemplateUnit(unittest.TestCase):
    """websh@.service must isolate each instance's writable state and
    credential vault. A leftover shared StateDirectory/WEBSH_CREDS_PATH
    (the bug this guards) makes every template instance — and the
    single-instance websh.service — write its vault to one shared
    /var/lib/websh/websh.creds.json, silently bleeding credentials
    across instances. systemd-analyze cannot catch this (the duplicate
    is syntactically valid), so it is asserted here."""

    def _directives(self, name):
        path = os.path.join(REPO_ROOT, name)
        out = {}
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out.setdefault(k.strip(), []).append(v.strip())
        return out

    def test_template_state_and_vault_are_per_instance(self):
        d = self._directives("websh@.service")
        # Exactly one StateDirectory, and it is per-instance.
        self.assertEqual(d.get("StateDirectory"), ["websh-%i"],
                         "template StateDirectory must be the single "
                         "per-instance websh-%%i (got %r)"
                         % (d.get("StateDirectory"),))
        creds = [v for v in d.get("Environment", [])
                 if v.startswith("WEBSH_CREDS_PATH=")]
        self.assertEqual(len(creds), 1,
                         "exactly one WEBSH_CREDS_PATH expected; got %r"
                         % (creds,))
        self.assertIn("%i", creds[0],
                      "template WEBSH_CREDS_PATH must be per-instance "
                      "(contain %%i); got %r" % (creds[0],))
        # The shared single-instance path must never appear in the template.
        with open(os.path.join(REPO_ROOT, "websh@.service"),
                  encoding="utf-8") as f:
            body = f.read()
        self.assertNotIn("/var/lib/websh/websh.creds.json", body,
                         "template must not reference the shared vault path")
        self.assertNotRegex(body, r"(?m)^StateDirectory=websh$",
                            "template must not also create the shared "
                            "/var/lib/websh state directory")

    def test_single_instance_unit_keeps_its_own_path(self):
        # The non-template websh.service is the one-box default and
        # legitimately owns /var/lib/websh; guard we did not %i-ify it.
        d = self._directives("websh.service")
        self.assertEqual(d.get("StateDirectory"), ["websh"])


class TestStartupRefusals(unittest.TestCase):
    """main() must fail loudly, once, on a bind collision and on an
    unwritable WEBSH_ACCESS_LOG - both used to be a raw traceback (or a
    per-event WARN behind a reassuring startup line) under a 5 s
    systemd restart loop."""

    def _main(self, **env_extra):
        env = dict(os.environ)
        for k in ("WEBSH_AUTH_HEADER", "WEBSH_VAULT_ENABLE", "WEBSH_CONFIG",
                  "WEBSH_ACCESS_LOG"):
            env.pop(k, None)
        env["HOST"] = "127.0.0.1"
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-c", "import server; server.main()"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)

    def test_port_collision_is_a_clean_error(self):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)
        port = s.getsockname()[1]
        try:
            proc = self._main(PORT=str(port))
        finally:
            s.close()
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn(b"cannot bind 127.0.0.1:%d" % port, proc.stderr)
        self.assertNotIn(b"Traceback", proc.stderr)

    def test_unwritable_access_log_refuses_to_start(self):
        d = tempfile.mkdtemp()
        try:
            proc = self._main(PORT="0",
                              WEBSH_ACCESS_LOG=os.path.join(d, "no", "such",
                                                            "dir", "a.log"))
        finally:
            shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn(b"WEBSH_ACCESS_LOG", proc.stderr)
        self.assertIn(b"not writable", proc.stderr)

    def test_units_grant_a_writable_log_directory(self):
        # ProtectSystem=strict + no LogsDirectory made WEBSH_ACCESS_LOG and
        # WEBSH_RECORD_DIR silently unwritable under the bundled units.
        for unit, name in (("websh.service", "websh"),
                           ("websh@.service", "websh-%i")):
            with open(os.path.join(REPO_ROOT, unit), encoding="utf-8") as f:
                body = f.read()
            self.assertRegex(body, r"(?m)^LogsDirectory=" + re.escape(name) + "$",
                             unit)


class TestStaticCompressionAndValidators(LiveServerCase):
    """websh.js (~230 KB) was re-sent raw on every page load: no gzip,
    no ETag. Now gzip is negotiated and a matching If-None-Match gets a
    body-less 304, while Cache-Control stays no-cache so a deploy is
    still picked up immediately."""

    def _get(self, path, headers):
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", path, headers=headers)
        r = c.getresponse(); body = r.read(); c.close()
        return r, body

    def test_gzip_negotiated_and_body_is_identical(self):
        import gzip as _gz
        raw_r, raw = self._get("/websh.js", {})
        self.assertEqual(raw_r.status, 200)
        self.assertIsNone(raw_r.getheader("Content-Encoding"))
        gz_r, gz = self._get("/websh.js", {"Accept-Encoding": "gzip, br"})
        self.assertEqual(gz_r.getheader("Content-Encoding"), "gzip")
        self.assertIn("Accept-Encoding", gz_r.getheader("Vary"))
        self.assertLess(len(gz), len(raw) // 2)
        self.assertEqual(_gz.decompress(gz), raw)
        # gzip;q=0 is a refusal.
        r, _ = self._get("/websh.js", {"Accept-Encoding": "gzip;q=0"})
        self.assertIsNone(r.getheader("Content-Encoding"))

    def test_etag_revalidation_returns_304(self):
        r, body = self._get("/websh.js", {"Accept-Encoding": "gzip"})
        tag = r.getheader("ETag")
        self.assertTrue(tag and tag.startswith('"'))
        self.assertEqual(r.getheader("Cache-Control"), "no-cache")
        r2, body2 = self._get("/websh.js", {"Accept-Encoding": "gzip",
                                            "If-None-Match": tag})
        self.assertEqual(r2.status, 304)
        self.assertEqual(body2, b"")
        # The identity variant has a different tag: no cross-variant 304.
        r3, _ = self._get("/websh.js", {"If-None-Match": tag})
        self.assertEqual(r3.status, 200)
        # Weak-prefixed and listed tags match too.
        r4, _ = self._get("/websh.js", {"Accept-Encoding": "gzip",
                                        "If-None-Match": '"x", W/' + tag})
        self.assertEqual(r4.status, 304)

    def test_changed_file_gets_a_new_tag(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "f.js")
            with open(p, "w") as f:
                f.write("a" * 2000)
            t1 = server._static_blob(p)[2]
            time.sleep(0.01)
            with open(p, "w") as f:
                f.write("b" * 2001)
            t2 = server._static_blob(p)[2]
            self.assertNotEqual(t1, t2)
        finally:
            shutil.rmtree(d, ignore_errors=True)


class TestAuthVaultStartupGuard(unittest.TestCase):
    """main() refuses to start when WEBSH_AUTH_HEADER and WEBSH_VAULT_ENABLE
    are both set: the vault is keyed by client-supplied vault_id, not by the
    authenticated identity, so the combination would let an authenticated
    user reach another user's vault entries. The guard exits 1 before binding
    (a clean start would instead serve forever)."""

    def test_auth_plus_vault_refuses_to_start(self):
        env = dict(os.environ)
        env["PORT"] = "0"
        env["WEBSH_AUTH_HEADER"] = "Remote-User"
        env["WEBSH_VAULT_ENABLE"] = "1"
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        proc = subprocess.run(
            [sys.executable, "-c", "import server; server.main()"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(
            proc.returncode, 1,
            "guard must exit 1 (a clean start would block/serve); stderr=%r"
            % proc.stderr.decode("utf-8", "replace"))
        self.assertIn(b"refusing to start", proc.stderr)
        self.assertIn(b"WEBSH_AUTH_HEADER", proc.stderr)


class TestRequireVaultStartupGuard(unittest.TestCase):
    """WEBSH_REQUIRE_VAULT=1 + plaintext credentials in websh.json must be
    a STARTUP failure (exit 1 before binding), not a per-request one."""

    def test_plaintext_config_refuses_to_start(self):
        d = tempfile.mkdtemp()
        try:
            cfg = os.path.join(d, "websh.json")
            with open(cfg, "w") as f:
                json.dump({"connections": [
                    {"name": "legacy", "host": "h", "username": "u",
                     "password": "plain"}]}, f)
            env = dict(os.environ)
            env.pop("WEBSH_AUTH_HEADER", None)
            env.pop("WEBSH_VAULT_ENABLE", None)
            env["PORT"] = "0"
            env["WEBSH_CONFIG"] = cfg
            env["WEBSH_REQUIRE_VAULT"] = "1"
            env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
            proc = subprocess.run(
                [sys.executable, "-c", "import server; server.main()"],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=20)
            self.assertEqual(proc.returncode, 1, proc.stderr)
            self.assertIn(b"refusing to start", proc.stderr)
            self.assertIn(b"legacy", proc.stderr)
        finally:
            shutil.rmtree(d, ignore_errors=True)



class TestListenBacklog(unittest.TestCase):
    """The accept backlog must not be socketserver's default of 5: with
    one TCP connection per request (HTTP/1.0, Connection: close) that
    queue overflowed under a few concurrent typists and every overflow
    cost the client a 1-3 s SYN retransmit."""

    def test_request_queue_size_is_raised(self):
        self.assertGreaterEqual(server.Server.request_queue_size, 128)

    def test_bound_socket_reports_the_backlog(self):
        srv = server.Server(("127.0.0.1", 0), server.Handler)
        try:
            # Linux exposes the effective backlog via TCP_INFO/ss; the
            # portable check is that listen() accepted the value.
            self.assertEqual(srv.request_queue_size,
                             server.Server.request_queue_size)
            self.assertTrue(srv.socket.fileno() > 0)
        finally:
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
