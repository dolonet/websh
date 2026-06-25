#!/usr/bin/env python3
"""Tests for websh server.py — tmux capture/options, upload/finalize/cancel, ls, download, side-channel rate limit.

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


class TestSideChannelRateLimit(unittest.TestCase):
    """The side-channel endpoints (ls/download/upload/tmux_capture) each
    spawn an ssh subprocess; they get their own, higher per-IP limit so an
    unbounded loop can't amplify into thread/process exhaustion."""

    def setUp(self):
        server._side_channel_rate_limits.clear()

    def test_allowed_within_limit(self):
        for _ in range(server.SIDE_CHANNEL_RATE_MAX):
            self.assertTrue(server._check_side_channel_rate_limit("10.1.0.1"))

    def test_blocked_over_limit(self):
        for _ in range(server.SIDE_CHANNEL_RATE_MAX):
            server._check_side_channel_rate_limit("10.1.0.2")
        self.assertFalse(server._check_side_channel_rate_limit("10.1.0.2"))

    def test_independent_from_connect_limiter(self):
        server._rate_limits.clear()
        orig = server.SIDE_CHANNEL_RATE_MAX
        server.SIDE_CHANNEL_RATE_MAX = 2
        try:
            ip = "10.1.0.3"
            self.assertTrue(server._check_side_channel_rate_limit(ip))
            self.assertTrue(server._check_side_channel_rate_limit(ip))
            self.assertFalse(server._check_side_channel_rate_limit(ip))
            # Exhausting the side-channel bucket leaves the connect bucket
            # for the same IP with its full budget.
            self.assertTrue(server._check_rate_limit(ip))
        finally:
            server.SIDE_CHANNEL_RATE_MAX = orig

    def test_ls_endpoint_returns_429_when_throttled(self):
        # HTTP-level: the throttle fires before sid validation, so even
        # bad-sid calls count and eventually 429 (rather than 404).
        import http.client
        orig = server.SIDE_CHANNEL_RATE_MAX
        server.SIDE_CHANNEL_RATE_MAX = 2
        server._side_channel_rate_limits.clear()
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        time.sleep(0.1)
        try:
            codes = []
            for _ in range(3):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                c.request("GET", "/api/ls?session_id=bad&path=~")
                r = c.getresponse()
                r.read()
                codes.append(r.status)
                c.close()
            self.assertEqual(codes[:2], [404, 404],
                             "first calls pass the throttle (bad sid → 404)")
            self.assertEqual(codes[2], 429, "3rd call throttled")
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.SIDE_CHANNEL_RATE_MAX = orig
            server._side_channel_rate_limits.clear()

    def test_post_side_channel_endpoints_are_throttled(self):
        # tmux_options / upload_finalize / upload_cancel each spawn an ssh
        # subprocess too, so they share the same per-IP throttle — the guard
        # fires before body parsing or any ssh work. MAX=0 blocks every
        # side-channel call, so the first hit on each endpoint must 429.
        import http.client
        orig = server.SIDE_CHANNEL_RATE_MAX
        server.SIDE_CHANNEL_RATE_MAX = 0
        server._side_channel_rate_limits.clear()
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        time.sleep(0.1)
        try:
            for action in ("tmux_options", "upload_finalize", "upload_cancel"):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                c.request("POST", "/api/" + action,
                          body=b'{"session_id":"bad","tmp":"x","final":"y"}',
                          headers={"Content-Type": "application/json"})
                r = c.getresponse()
                r.read()
                c.close()
                self.assertEqual(
                    r.status, 429,
                    action + " must be throttled like the other side-channel "
                    "endpoints (got %d)" % r.status)
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.SIDE_CHANNEL_RATE_MAX = orig
            server._side_channel_rate_limits.clear()


class TestSlotIdRegex(unittest.TestCase):

    def test_valid_simple(self):
        self.assertTrue(server._SLOT_ID_RE.match("alexey_prod-1"))

    def test_valid_all_allowed_chars(self):
        self.assertTrue(server._SLOT_ID_RE.match("ABCxyz_-09"))

    def test_valid_max_length(self):
        self.assertTrue(server._SLOT_ID_RE.match("a" * 64))

    def test_invalid_empty(self):
        self.assertIsNone(server._SLOT_ID_RE.match(""))

    def test_invalid_too_long(self):
        self.assertIsNone(server._SLOT_ID_RE.match("a" * 65))

    def test_invalid_at_sign(self):
        # The logical slot identity is "user@host#n" but we sanitize it
        # into the regex-safe form before feeding it to the backend;
        # raw "@" must not slip through.
        self.assertIsNone(server._SLOT_ID_RE.match("alexey@host"))

    def test_invalid_space(self):
        self.assertIsNone(server._SLOT_ID_RE.match("slot 1"))

    def test_invalid_semicolon(self):
        self.assertIsNone(server._SLOT_ID_RE.match("x;rm -rf"))

    def test_invalid_dollar(self):
        self.assertIsNone(server._SLOT_ID_RE.match("x$(id)"))

    def test_invalid_backtick(self):
        self.assertIsNone(server._SLOT_ID_RE.match("x`id`"))

    def test_invalid_newline(self):
        self.assertIsNone(server._SLOT_ID_RE.match("x\ny"))

    def test_invalid_unicode(self):
        self.assertIsNone(server._SLOT_ID_RE.match("caf\u00e9"))

    def test_invalid_null_byte(self):
        self.assertIsNone(server._SLOT_ID_RE.match("x\x00y"))


class TestTmuxCmdRegex(unittest.TestCase):

    def test_valid_default(self):
        self.assertTrue(server._TMUX_CMD_RE.match("tmux"))

    def test_valid_absolute_path(self):
        self.assertTrue(server._TMUX_CMD_RE.match("/usr/local/bin/tmux"))

    def test_valid_tilde_path(self):
        self.assertTrue(server._TMUX_CMD_RE.match("~/.local/bin/tmux"))

    def test_valid_dotted(self):
        self.assertTrue(server._TMUX_CMD_RE.match("./tmux"))

    def test_valid_max_length(self):
        self.assertTrue(server._TMUX_CMD_RE.match("a" * 128))

    def test_invalid_empty(self):
        self.assertIsNone(server._TMUX_CMD_RE.match(""))

    def test_invalid_too_long(self):
        self.assertIsNone(server._TMUX_CMD_RE.match("a" * 129))

    def test_invalid_space(self):
        # Shell metacharacter — would let a user append arbitrary flags
        # or chain commands on the target.
        self.assertIsNone(server._TMUX_CMD_RE.match("tmux -vvv"))

    def test_invalid_semicolon(self):
        self.assertIsNone(server._TMUX_CMD_RE.match("tmux;id"))

    def test_invalid_pipe(self):
        self.assertIsNone(server._TMUX_CMD_RE.match("tmux|id"))

    def test_invalid_ampersand(self):
        self.assertIsNone(server._TMUX_CMD_RE.match("tmux&id"))

    def test_invalid_dollar(self):
        self.assertIsNone(server._TMUX_CMD_RE.match("tmux$HOME"))

    def test_invalid_backtick(self):
        self.assertIsNone(server._TMUX_CMD_RE.match("tmux`id`"))

    def test_invalid_quote(self):
        self.assertIsNone(server._TMUX_CMD_RE.match('tmux"x"'))


# ── Auth-failure pattern matching ──────────────────────────────────────
# AUTH_FAIL_PATTERNS is scanned against lowered PTY output. Wrong hits
# kill live sessions on benign text; wrong misses loop on bad creds.


class TestValidateTmuxOptions(unittest.TestCase):
    """The /api/connect body is untrusted — only the keys/values listed
    in _TMUX_BOOL_OPTS / _TMUX_INT_OPTS may flow into the tmux command,
    and only with values that pass the type/range checks. Everything
    else must be silently dropped (we don't want to fail a connect over
    a stale toggle from a future client)."""

    def test_bool_true_becomes_on(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_set_clipboard": True}),
            [("set-clipboard", "on")])

    def test_bool_false_becomes_off(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_set_clipboard": False}),
            [("set-clipboard", "off")])

    def test_bool_string_on_off(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_set_clipboard": "on"}),
            [("set-clipboard", "on")])
        self.assertEqual(
            server._validate_tmux_options({"tmux_set_clipboard": "off"}),
            [("set-clipboard", "off")])

    def test_bool_garbage_dropped(self):
        # 'true', 2, None — none of these match the allow-list
        for v in ("true", 2, None, "yes", [], {}):
            self.assertEqual(
                server._validate_tmux_options({"tmux_set_clipboard": v}),
                [],
                "value %r should have been dropped" % (v,))

    def test_history_limit_in_range(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_history_limit": 100000}),
            [("history-limit", "100000")])

    def test_history_limit_string_int_accepted(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_history_limit": "5000"}),
            [("history-limit", "5000")])

    def test_history_limit_below_min_dropped(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_history_limit": 50}), [])

    def test_history_limit_above_max_dropped(self):
        self.assertEqual(
            server._validate_tmux_options(
                {"tmux_history_limit": 99_999_999}),
            [])

    def test_history_limit_non_numeric_dropped(self):
        self.assertEqual(
            server._validate_tmux_options(
                {"tmux_history_limit": "lots"}),
            [])

    def test_unknown_keys_ignored(self):
        body = {
            "tmux_evil": "rm -rf /",
            "tmux_status": "on",  # not on the allow-list
            "host": "ignored",
            "tmux_mouse": True,  # legacy key, no longer on the allow-list
            "tmux_set_clipboard": True,
        }
        self.assertEqual(
            server._validate_tmux_options(body),
            [("set-clipboard", "on")])

    def test_combined_body(self):
        body = {
            "tmux_set_clipboard": False,
            "tmux_history_limit": 200000,
        }
        self.assertEqual(
            server._validate_tmux_options(body),
            [("set-clipboard", "off"),
             ("history-limit", "200000")])


# Fake tmux used by TestWatchdogRuntime — simulates has-session,
# display, kill-session, new-session using a files-on-disk state
# store so we can inspect what the watchdog actually does.


class TestPushTmuxOptions(unittest.TestCase):
    """Direct unit tests for SSHSession.push_tmux_options() — the
    side-channel path that applies tmux options live without typing
    into the foreground PTY."""

    def _fake_session(self, persistent=True, slot_id="ok", control_path=None,
                      tmux_cmd="tmux"):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = "fake-tmuxopts"
        s.persistent = persistent
        s.slot_id = slot_id
        s.alive = True
        s.master_fd = -1
        s._control_path = control_path
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        s.tmux_cmd = tmux_cmd
        return s

    def test_noop_when_not_persistent(self):
        s = self._fake_session(persistent=False)
        ok, err = s.push_tmux_options([("mouse", "on")])
        self.assertFalse(ok)
        self.assertIn("not a persistent", err)

    def test_noop_when_no_slot_id(self):
        s = self._fake_session(slot_id=None)
        ok, err = s.push_tmux_options([("mouse", "on")])
        self.assertFalse(ok)

    def test_error_when_socket_missing(self):
        s = self._fake_session(control_path="/nonexistent/mux.sock")
        ok, err = s.push_tmux_options([("mouse", "on")])
        self.assertFalse(ok)
        self.assertIn("control socket", err)

    def test_empty_options_no_ssh_invocation(self):
        # An empty list should short-circuit before spawning ssh.
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            called = {"n": 0}
            def fake_run(cmd, **kw):
                called["n"] += 1
                class R:
                    returncode = 0
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, err = s.push_tmux_options([])
            self.assertTrue(ok)
            self.assertEqual(called["n"], 0)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_invokes_ssh_with_chained_set_g(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            calls = []
            def fake_run(cmd, **kw):
                calls.append(cmd)
                class R:
                    returncode = 0
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, err = s.push_tmux_options(
                    [("mouse", "on"), ("set-clipboard", "off"),
                     ("history-limit", "200000")])
            self.assertTrue(ok, err)
            self.assertEqual(len(calls), 1)
            cmd = calls[0]
            self.assertEqual(cmd[0], "ssh")
            self.assertIn("ControlPath=" + sock, cmd)
            # The remote command is the last element. All three set-g
            # lines must end up chained into a *single* tmux invocation
            # via tmux's own `\;` separator — one ssh roundtrip, one
            # tmux server fork on the target, atomic application.
            remote = cmd[-1]
            self.assertEqual(
                remote,
                "tmux set -g mouse on \\; set -g set-clipboard off "
                "\\; set -g history-limit 200000")
            # `--` separator must precede the host so an attacker-controlled
            # _host can never be parsed as an ssh flag.
            self.assertIn("--", cmd)
            self.assertLess(cmd.index("--"), cmd.index(s._host))
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_nonzero_exit_returns_error(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            def fake_run(cmd, **kw):
                class R:
                    returncode = 2
                    stderr = b"unknown option mouse"
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, err = s.push_tmux_options([("mouse", "on")])
            self.assertFalse(ok)
            self.assertIn("tmux exit", err)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_timeout_returns_error(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            def fake_run(cmd, **kw):
                raise subprocess.TimeoutExpired(cmd, 10)
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, err = s.push_tmux_options([("mouse", "on")])
            self.assertFalse(ok)
            self.assertIn("timeout", err)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_custom_tmux_cmd_inlined(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock,
                                   tmux_cmd="/usr/local/bin/tmux")
            calls = []
            def fake_run(cmd, **kw):
                calls.append(cmd)
                class R:
                    returncode = 0
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                s.push_tmux_options([("mouse", "on")])
            # Single option case: no chaining, just one set-g.
            self.assertEqual(
                calls[0][-1], "/usr/local/bin/tmux set -g mouse on")
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


class TestTmuxOptionsHTTPDispatch(LiveServerCase):
    """HTTP-level dispatch for POST /api/tmux_options — checks routing,
    body validation, and unknown-session handling. Live ssh is mocked
    via push_tmux_options."""

    def test_unknown_session_404(self):
        body, code = self._post("/api/tmux_options",
                                {"session_id": str(uuid.uuid4()),
                                 "tmux_set_clipboard": True})
        self.assertEqual(code, 404)

    def test_invalid_session_id_404(self):
        body, code = self._post("/api/tmux_options",
                                {"session_id": "not-a-uuid",
                                 "tmux_set_clipboard": True})
        self.assertEqual(code, 404)

    def test_invalid_json_400(self):
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{}/api/tmux_options".format(self.port)
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

    def test_dispatches_to_session_with_validated_options(self):
        # Plant a fake session in the registry, capture push_tmux_options call.
        sid = str(uuid.uuid4())
        captured = {}
        class FakeSession:
            persistent = True
            slot_id = "ok"
            def push_tmux_options(self, opts):
                captured["opts"] = list(opts)
                return True, ""
        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            body, code = self._post("/api/tmux_options", {
                "session_id": sid,
                "tmux_set_clipboard": False,
                "tmux_history_limit": 50000,
                # Garbage that must be dropped by validation, never passed
                # through to the session. `tmux_mouse` lands here too —
                # mouse is hardcoded on the server side and no longer
                # configurable per-session.
                "tmux_mouse": True,
                "tmux_evil": "rm -rf /",
                "tmux_status": "on",
            })
            self.assertEqual(code, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(set(body["applied"]),
                             {"set-clipboard", "history-limit"})
            self.assertIn(("set-clipboard", "off"), captured["opts"])
            self.assertIn(("history-limit", "50000"), captured["opts"])
            self.assertEqual(len(captured["opts"]), 2)
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_session_error_propagated_as_502(self):
        sid = str(uuid.uuid4())
        class FakeSession:
            persistent = True
            slot_id = "ok"
            def push_tmux_options(self, opts):
                return False, "control socket not ready"
        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            body, code = self._post("/api/tmux_options",
                                    {"session_id": sid,
                                     "tmux_set_clipboard": True})
            self.assertEqual(code, 502)
            self.assertIn("control socket", body["error"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)


class TestFinalizeUpload(unittest.TestCase):
    """Direct unit tests for SSHSession.finalize_upload() — the
    side-channel path that mv's an uploaded $HOME/<tmp> into the
    pane's cwd via tmux's #{pane_current_path}."""

    def _fake_session(self, persistent=True, slot_id="ok",
                      control_path=None, tmux_cmd="tmux"):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = "fake-finalize"
        s.persistent = persistent
        s.slot_id = slot_id
        s.alive = True
        s.master_fd = -1
        s._control_path = control_path
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        s.tmux_cmd = tmux_cmd
        return s

    def test_non_persistent_returns_signal(self):
        # Caller relies on the literal "non-persistent" string to know
        # it should fall back to the foreground-mv path. Test guards
        # the exact return value so a typo doesn't break that contract.
        s = self._fake_session(persistent=False)
        ok, msg = s.finalize_upload("tmp", "final.txt")
        self.assertFalse(ok)
        self.assertEqual(msg, "non-persistent")

    def test_no_slot_id_returns_signal(self):
        s = self._fake_session(slot_id=None)
        ok, msg = s.finalize_upload("tmp", "final.txt")
        self.assertFalse(ok)
        self.assertEqual(msg, "non-persistent")

    def test_socket_missing_errors(self):
        s = self._fake_session(control_path="/nonexistent/mux.sock")
        ok, msg = s.finalize_upload("tmp", "final.txt")
        self.assertFalse(ok)
        self.assertIn("control socket", msg)

    def test_remote_command_uses_pane_current_path(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            calls = []
            def fake_run(cmd, **kw):
                calls.append(cmd)
                class R:
                    returncode = 0
                    stdout = b"/home/alice/work/file.txt"
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, path = s.finalize_upload(
                    ".websh-tmp-abc", "file.txt")
            self.assertTrue(ok, path)
            self.assertEqual(path, "/home/alice/work/file.txt")
            self.assertEqual(len(calls), 1)
            cmd = calls[0]
            remote = cmd[-1]
            # Must ask tmux for pane_current_path — that's the whole
            # point of going server-side. /proc isn't portable; tmux is.
            self.assertIn("#{pane_current_path}", remote)
            self.assertIn("websh-ok", remote)
            # Filenames must be base64-encoded — never interpolated raw.
            import base64
            self.assertIn(
                base64.b64encode(b".websh-tmp-abc").decode(), remote)
            self.assertIn(
                base64.b64encode(b"file.txt").decode(), remote)
            # `--` after rm/mv/cd protects against `-`-prefixed inputs.
            # (mv and cd both get `--`; we don't currently use rm here.)
            self.assertIn('mv -- "$HOME/$t"', remote)
            self.assertIn('cd -- "$cwd"', remote)
            # ssh argv: `--` must precede the host.
            self.assertIn("--", cmd)
            self.assertLess(cmd.index("--"), cmd.index(s._host))
            # ControlMaster path threaded through.
            self.assertIn("ControlPath=" + sock, cmd)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_falls_back_to_home_when_tmux_unavailable(self):
        # The remote command does `[ -n "$cwd" ] || cwd="$HOME"` —
        # we want to make sure that fallback is in the script, since
        # tmux can fail (e.g. session was killed between connect and
        # finalize) and we don't want the mv to end up in /.
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            captured = {}
            def fake_run(cmd, **kw):
                captured["remote"] = cmd[-1]
                class R:
                    returncode = 0
                    stdout = b""
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                s.finalize_upload("t", "f")
            self.assertIn('cwd="$HOME"', captured["remote"])
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_nonzero_exit_returns_error(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            def fake_run(cmd, **kw):
                class R:
                    returncode = 1
                    stdout = b""
                    stderr = b"mv: target not writable"
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, msg = s.finalize_upload("tmp", "final.txt")
            self.assertFalse(ok)
            self.assertIn("finalize exit", msg)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_timeout_returns_error(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            def fake_run(cmd, **kw):
                raise subprocess.TimeoutExpired(cmd, 15)
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, msg = s.finalize_upload("tmp", "final.txt")
            self.assertFalse(ok)
            self.assertIn("timeout", msg)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_pathological_filename_stays_base64(self):
        """A filename with shell metacharacters / newline must end up
        base64-encoded — never interpolated raw into the remote command."""
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            captured = {}
            def fake_run(cmd, **kw):
                captured["remote"] = cmd[-1]
                class R:
                    returncode = 0
                    stdout = b""
                    stderr = b""
                return R()
            evil = "; rm -rf ~; echo \"\n"
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                s.finalize_upload(".websh-tmp-x", evil)
            # The literal string must NOT appear — only its base64.
            self.assertNotIn(evil, captured["remote"])
            self.assertNotIn("rm -rf", captured["remote"])
            import base64
            self.assertIn(
                base64.b64encode(evil.encode()).decode(), captured["remote"])
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_no_extension_increment_builds_from_original_name(self):
        """The no-extension branch must build name(1), name(2), ... from the
        ORIGINAL name (kept in $o), not strip a trailing "(...)" via the old
        ${f%(*)}. The strip both mangled real parenthesized names
        (report(final) -> report(1)) and was the wrong mechanism; building
        from $o yields Makefile(1), Makefile(2), ... with no accumulation and
        leaves parenthesized names intact. Behavioral coverage lives in
        TestUploadRenameCollision; this guards the emitted server command."""
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            captured = {}
            def fake_run(cmd, **kw):
                captured["remote"] = cmd[-1]
                class R:
                    returncode = 0
                    stdout = b""
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                s.finalize_upload("tmp", "Makefile")
            remote = captured["remote"]
            self.assertIn('o="$f"', remote)
            self.assertIn('f="$o($n)"', remote)
            # The fragile suffix-strip must be gone.
            self.assertNotIn('${f%(*)}', remote)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


class TestRemoveRemoteTmp(unittest.TestCase):
    """Direct unit tests for SSHSession.remove_remote_tmp() — the
    side-channel cancel-cleanup path."""

    def _fake_session(self, control_path=None):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = "fake-rmtmp"
        s.persistent = True
        s.slot_id = "ok"
        s.alive = True
        s.master_fd = -1
        s._control_path = control_path
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        s.tmux_cmd = "tmux"
        return s

    def test_socket_missing_errors(self):
        s = self._fake_session(control_path="/nonexistent/mux.sock")
        ok, err = s.remove_remote_tmp(".websh-tmp-x")
        self.assertFalse(ok)
        self.assertIn("control socket", err)

    def test_runs_rm_with_double_dash(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            captured = {}
            def fake_run(cmd, **kw):
                captured["cmd"] = cmd
                class R:
                    returncode = 0
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, err = s.remove_remote_tmp(".websh-tmp-abc")
            self.assertTrue(ok, err)
            remote = captured["cmd"][-1]
            self.assertIn('rm -f -- "$HOME/$n"', remote)
            # `--` separator before host in the ssh argv.
            self.assertIn("--", captured["cmd"])
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_nonzero_exit_returns_error(self):
        tmpdir = tempfile.mkdtemp()
        sock = os.path.join(tmpdir, "mux.sock")
        open(sock, "w").close()
        try:
            s = self._fake_session(control_path=sock)
            def fake_run(cmd, **kw):
                class R:
                    returncode = 1
                    stderr = b""
                return R()
            with unittest.mock.patch.object(server.subprocess, "run", fake_run):
                ok, err = s.remove_remote_tmp(".websh-tmp-x")
            self.assertFalse(ok)
            self.assertIn("rm exit", err)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


class TestUploadFinalizeHTTPDispatch(LiveServerCase):
    """HTTP-level dispatch for /api/upload_finalize and /api/upload_cancel.
    The session methods are mocked; we're testing routing, body
    validation, and the non_persistent-vs-error response shape."""

    # ── /api/upload_finalize ──
    def test_finalize_unknown_session_404(self):
        body, code = self._post("/api/upload_finalize", {
            "session_id": str(uuid.uuid4()),
            "tmp": ".websh-tmp-x", "final": "f.txt"})
        self.assertEqual(code, 404)

    def test_finalize_invalid_tmp_400(self):
        # absolute path must be rejected
        body, code = self._post("/api/upload_finalize", {
            "session_id": str(uuid.uuid4()),
            "tmp": "/etc/passwd", "final": "f.txt"})
        self.assertEqual(code, 400)
        self.assertIn("tmp", body["error"])

    def test_finalize_traversal_in_tmp_400(self):
        body, code = self._post("/api/upload_finalize", {
            "session_id": str(uuid.uuid4()),
            "tmp": "../etc/passwd", "final": "f.txt"})
        self.assertEqual(code, 400)

    def test_finalize_nul_in_tmp_400(self):
        body, code = self._post("/api/upload_finalize", {
            "session_id": str(uuid.uuid4()),
            "tmp": "ok\x00.tmp", "final": "f.txt"})
        self.assertEqual(code, 400)

    def test_finalize_slash_in_final_400(self):
        # final must be a basename — slashes would let the client
        # write outside the pane cwd.
        body, code = self._post("/api/upload_finalize", {
            "session_id": str(uuid.uuid4()),
            "tmp": "ok.tmp", "final": "../escape.txt"})
        self.assertEqual(code, 400)
        self.assertIn("final", body["error"])

    def test_finalize_dot_in_final_400(self):
        for f in (".", "..", ""):
            body, code = self._post("/api/upload_finalize", {
                "session_id": str(uuid.uuid4()),
                "tmp": "ok.tmp", "final": f})
            self.assertEqual(code, 400, "final=%r should reject" % f)

    def test_finalize_success_returns_path(self):
        sid = str(uuid.uuid4())
        captured = {}
        class FakeSession:
            persistent = True
            slot_id = "ok"
            last_activity = 0
            def finalize_upload(self, tmp, final):
                captured["tmp"] = tmp
                captured["final"] = final
                return True, "/home/alice/work/" + final
        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            body, code = self._post("/api/upload_finalize", {
                "session_id": sid, "tmp": ".websh-tmp-x",
                "final": "report.csv"})
            self.assertEqual(code, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(body["path"], "/home/alice/work/report.csv")
            self.assertEqual(captured["tmp"], ".websh-tmp-x")
            self.assertEqual(captured["final"], "report.csv")
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_finalize_non_persistent_returns_200_with_flag(self):
        # The client uses non_persistent: true to know it should fall
        # back to its foreground-mv path. This must NOT be a 502 — the
        # client treats 502 as a hard failure.
        sid = str(uuid.uuid4())
        class FakeSession:
            persistent = False
            slot_id = None
            last_activity = 0
            def finalize_upload(self, tmp, final):
                return False, "non-persistent"
        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            body, code = self._post("/api/upload_finalize", {
                "session_id": sid, "tmp": "x", "final": "f"})
            self.assertEqual(code, 200)
            self.assertFalse(body["ok"])
            self.assertTrue(body["non_persistent"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_finalize_session_error_502(self):
        sid = str(uuid.uuid4())
        class FakeSession:
            persistent = True
            slot_id = "ok"
            last_activity = 0
            def finalize_upload(self, tmp, final):
                return False, "finalize exit 1: mv refused"
        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            body, code = self._post("/api/upload_finalize", {
                "session_id": sid, "tmp": "x", "final": "f"})
            self.assertEqual(code, 502)
            self.assertIn("mv refused", body["error"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    # ── /api/upload_cancel ──
    def test_cancel_unknown_session_404(self):
        body, code = self._post("/api/upload_cancel", {
            "session_id": str(uuid.uuid4()), "tmp": ".websh-tmp-x"})
        self.assertEqual(code, 404)

    def test_cancel_invalid_tmp_400(self):
        body, code = self._post("/api/upload_cancel", {
            "session_id": str(uuid.uuid4()), "tmp": "/abs/path"})
        self.assertEqual(code, 400)

    def test_cancel_success(self):
        sid = str(uuid.uuid4())
        captured = {}
        class FakeSession:
            def remove_remote_tmp(self, tmp):
                captured["tmp"] = tmp
                return True, ""
        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            body, code = self._post("/api/upload_cancel", {
                "session_id": sid, "tmp": ".websh-tmp-abc"})
            self.assertEqual(code, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(captured["tmp"], ".websh-tmp-abc")
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_cancel_session_error_502(self):
        sid = str(uuid.uuid4())
        class FakeSession:
            def remove_remote_tmp(self, tmp):
                return False, "rm exit 1"
        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
        try:
            body, code = self._post("/api/upload_cancel", {
                "session_id": sid, "tmp": ".websh-tmp-x"})
            self.assertEqual(code, 502)
            self.assertIn("rm exit", body["error"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)


class TestUploadPathNULRejection(LiveServerCase):
    """The /api/upload validator rejects \\x00 in rel_path because bash
    silently truncates NUL bytes in variable values, which would land
    a file at a different name than the client asked for."""

    def test_nul_byte_in_path_400(self):
        from urllib.request import urlopen, Request
        # %00 in the URL-encoded path query.
        url = "http://127.0.0.1:{}/api/upload?session_id={}&path=ok%00.tmp".format(
            self.port, uuid.uuid4())
        req = Request(url, data=b"hello",
                      headers={"Content-Type": "application/octet-stream"})
        try:
            resp = urlopen(req, timeout=5)
            body = json.loads(resp.read().decode("utf-8"))
            code = resp.getcode()
        except Exception as e:
            body = json.loads(e.read().decode("utf-8"))
            code = e.code
        self.assertEqual(code, 400)
        self.assertIn("invalid", body["error"])


class TestSlotIdSecurity(unittest.TestCase):
    """Document the security model around slot_id.

    slot_id is a per-browser label for resuming a remote tmux session,
    not an authentication credential. These tests pin the two
    guarantees we actually rely on:

      1. The slot_id regex keeps the label safe to interpolate into
         the remote shell command that ssh executes on the target.
      2. /api/connect rejects slot_ids that would escape that safety.

    Cross-user isolation (tmux namespaces per UID on the target) is
    enforced by tmux itself — we don't test it here, but it's the
    reason loose slot_id validation is acceptable.
    """

    def test_regex_rejects_shell_metacharacters(self):
        bad_ids = [
            "alice; rm -rf /",     # command separator
            "alice && id",         # command chain
            "alice|nc host 80",    # pipe
            "alice`whoami`",       # backtick
            "alice$(whoami)",      # command substitution
            "alice\nwhoami",       # newline injection
            "alice'quote",         # single quote
            "alice\"quote",        # double quote
            "alice space",         # space
            "alice/slash",         # path separator
            "../etc/passwd",       # traversal
            "",                    # empty
            "x" * 65,              # too long
        ]
        for bad in bad_ids:
            self.assertIsNone(
                server._SLOT_ID_RE.match(bad),
                "regex should reject: {!r}".format(bad))

    def test_regex_accepts_realistic_slot_ids(self):
        good_ids = [
            "alice_prod-1_22_abc1",
            "deploy_example-com_2222_xyz9",
            "a",                            # single char
            "a" * 64,                       # max length
            "user123_host-name_42_abcd",
        ]
        for good in good_ids:
            self.assertIsNotNone(
                server._SLOT_ID_RE.match(good),
                "regex should accept: {!r}".format(good))

    def test_tmux_name_interpolation_is_safe(self):
        # Whatever the regex accepts must produce a tmux session name
        # that contains no shell metacharacters when wrapped as
        # "websh-<slot>". This is the actual invariant that matters.
        for slot in ["abc", "user_host-1_22_xy", "A_B-C_9"]:
            name = "websh-" + slot
            for bad_char in ";&|`$(){}<>\"'\\\n\r\t *?[]!#":
                self.assertNotIn(bad_char, name)


class TestListDir(unittest.TestCase):
    """Unit tests for SSHSession.list_dir()."""

    def _fake_session(self, control_path=None):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = "fake-ls"
        s.persistent = True
        s.slot_id = "ok"
        s.alive = True
        s._control_path = control_path
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        return s

    def test_no_socket_errors(self):
        s = self._fake_session(control_path="/nonexistent/mux.sock")
        entries, path, err = s.list_dir("~")
        self.assertIsNone(entries)
        self.assertIn("control socket", err)

    def test_parses_entries_and_path(self):
        s = self._fake_session(control_path="/tmp/fake.sock")
        # PWD line is \n-terminated; entry rows are \0-terminated so a
        # filename containing \n can't split a row in half.
        stdout = (
            b"PWD:/home/alice\n"
            b"d\t4096\t1700000000\tdocs\0"
            b"f\t12345\t1700000001\tfile.txt\0"
            b"l\t0\t1700000002\tlink\0"
        )
        result = unittest.mock.MagicMock()
        result.returncode = 0
        result.stdout = stdout
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.run", return_value=result):
            entries, abs_path, err = s.list_dir("~")
        self.assertIsNone(err)
        self.assertEqual(abs_path, "/home/alice")
        # dirs sorted before files
        self.assertEqual(entries[0]["name"], "docs")
        self.assertEqual(entries[0]["type"], "d")
        self.assertEqual(entries[1]["name"], "file.txt")
        self.assertEqual(entries[1]["size"], 12345)
        self.assertEqual(entries[2]["type"], "l")

    def test_nonzero_exit_returns_error(self):
        s = self._fake_session(control_path="/tmp/fake.sock")
        result = unittest.mock.MagicMock()
        result.returncode = 1
        result.stdout = b""
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.run", return_value=result):
            entries, path, err = s.list_dir("/nonexistent")
        self.assertIsNone(entries)
        self.assertIsNotNone(err)

    def test_timeout_returns_error(self):
        s = self._fake_session(control_path="/tmp/fake.sock")
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.run",
                                 side_effect=subprocess.TimeoutExpired("ssh", 10)):
            entries, path, err = s.list_dir("~")
        self.assertIsNone(entries)
        self.assertEqual(err, "timeout")

    def test_filename_with_embedded_newline_preserved(self):
        """Regression: NUL-terminated rows mean a filename containing
        \\n is not split across two rows. Old \\n-separated parser
        produced a truncated entry name and silently dropped the rest."""
        s = self._fake_session(control_path="/tmp/fake.sock")
        weird = "weird\nname.txt"
        stdout = (
            b"PWD:/home/alice\n"
            b"f\t10\t1700000000\t" + weird.encode() + b"\0"
            b"f\t20\t1700000001\tnext.txt\0"
        )
        result = unittest.mock.MagicMock()
        result.returncode = 0
        result.stdout = stdout
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.run", return_value=result):
            entries, _, err = s.list_dir("~")
        self.assertIsNone(err)
        names = [e["name"] for e in entries]
        self.assertIn(weird, names)
        self.assertIn("next.txt", names)

    def test_remote_cmd_uses_nul_terminator(self):
        """Regression: each entry row must end with \\0 so embedded
        newlines in filenames don't corrupt the listing. The remote
        loop is POSIX-portable (no GNU `find -printf`); the contract
        is the NUL-separated rows, not any specific format-string."""
        s = self._fake_session(control_path="/tmp/fake.sock")
        captured = {}
        def fake_run(cmd, **kw):
            captured["remote"] = cmd[-1]
            r = unittest.mock.MagicMock()
            r.returncode = 0
            r.stdout = b"PWD:/home/alice\n"
            return r
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.run", side_effect=fake_run):
            s.list_dir("~")
        cmd = captured["remote"]
        # Row terminator: per-entry printf must end with \0, not \n.
        self.assertIn(r'\t%s\0', cmd)
        self.assertNotIn(r'\t%s\n', cmd)
        # Portability marker: the loop must NOT rely on `find -printf`
        # (BusyBox/Alpine/dash targets don't have it).
        self.assertNotIn('-printf', cmd)

    def test_dirs_sorted_before_files(self):
        s = self._fake_session(control_path="/tmp/fake.sock")
        stdout = (
            b"PWD:/home/alice\n"
            b"f\t100\t1700000000\taardvark.txt\0"
            b"d\t4096\t1700000000\tzebra_dir\0"
            b"f\t200\t1700000000\tbeta.py\0"
        )
        result = unittest.mock.MagicMock()
        result.returncode = 0
        result.stdout = stdout
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.run", return_value=result):
            entries, _, err = s.list_dir("~")
        self.assertIsNone(err)
        self.assertEqual(entries[0]["type"], "d")
        self.assertEqual(entries[1]["type"], "f")
        self.assertEqual(entries[2]["type"], "f")


class TestDownloadFile(unittest.TestCase):
    """Unit tests for SSHSession.download_file()."""

    def _fake_session(self, control_path=None):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = "fake-dl"
        s.persistent = True
        s.slot_id = "ok"
        s.alive = True
        s._control_path = control_path
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        return s

    def test_no_socket_errors(self):
        s = self._fake_session(control_path="/nonexistent/mux.sock")
        proc, err = s.download_file("/home/alice/file.txt")
        self.assertIsNone(proc)
        self.assertIn("control socket", err)

    def test_returns_popen_on_success(self):
        s = self._fake_session(control_path="/tmp/fake.sock")
        fake_proc = unittest.mock.MagicMock()
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.Popen", return_value=fake_proc):
            proc, err = s.download_file("/home/alice/file.txt")
        self.assertIsNone(err)
        self.assertIs(proc, fake_proc)

    def test_popen_exception_returns_error(self):
        s = self._fake_session(control_path="/tmp/fake.sock")
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.Popen",
                                 side_effect=OSError("no ssh")):
            proc, err = s.download_file("/home/alice/file.txt")
        self.assertIsNone(proc)
        self.assertIn("no ssh", err)

    def test_stderr_is_devnull_not_pipe(self):
        """Regression: stderr=PIPE without a draining reader can block the
        side-channel ssh once it writes >~64 KB of warnings (host-key
        prompts, banners). The protocol header on stdout already conveys
        OK/ERR so stderr is discarded."""
        s = self._fake_session(control_path="/tmp/fake.sock")
        captured = {}
        def fake_popen(cmd, **kw):
            captured.update(kw)
            return unittest.mock.MagicMock()
        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch("subprocess.Popen", side_effect=fake_popen):
            s.download_file("/home/alice/file.txt")
        self.assertEqual(captured.get("stderr"), subprocess.DEVNULL)


class TestLsHTTPDispatch(LiveServerCase):
    """HTTP-level tests for GET /api/ls."""

    def _get(self, qs):
        body, _code = LiveServerCase._get(self, "/api/ls?" + qs)
        return body

    def test_invalid_session_404(self):
        r = self._get("session_id=not-a-uuid")
        self.assertIn("error", r)

    def test_nul_in_path_400(self):
        from urllib.parse import quote
        r = self._get("session_id={}&path={}".format(
            str(uuid.uuid4()), quote("dir\x00bad")))
        self.assertIn("error", r)

    def test_unknown_session_id_404(self):
        r = self._get("session_id=" + str(uuid.uuid4()))
        self.assertIn("error", r)

    def test_ls_dispatches_to_session(self):
        sid = str(uuid.uuid4())
        fake_session = unittest.mock.MagicMock()
        fake_session.list_dir.return_value = (
            [{"name": "file.txt", "type": "f", "size": 42, "mtime": 0}],
            "/home/alice",
            None,
        )
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            r = self._get("session_id={}&path=~".format(sid))
        self.assertEqual(r["path"], "/home/alice")
        self.assertEqual(len(r["entries"]), 1)
        self.assertEqual(r["entries"][0]["name"], "file.txt")

    def test_session_error_propagated_502(self):
        sid = str(uuid.uuid4())
        fake_session = unittest.mock.MagicMock()
        fake_session.list_dir.return_value = (None, None, "control socket not ready")
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            r = self._get("session_id={}".format(sid))
        self.assertIn("error", r)


class TestDownloadHTTPDispatch(LiveServerCase):
    """HTTP-level tests for GET /api/download."""

    def _url(self, qs):
        # NB: query-string semantics, unlike LiveServerCase._server_url —
        # several tests open this URL directly with urlopen.
        return self._server_url("/api/download?" + qs)

    def _get_json(self, qs):
        body, _code = self._get("/api/download?" + qs)
        return body

    def test_invalid_session_404(self):
        r = self._get_json("session_id=not-a-uuid&path=/etc/hosts")
        self.assertIn("error", r)

    def test_missing_path_400(self):
        r = self._get_json("session_id=" + str(uuid.uuid4()))
        self.assertIn("error", r)

    def test_nul_in_path_400(self):
        from urllib.parse import quote
        r = self._get_json("session_id={}&path={}".format(
            str(uuid.uuid4()), quote("/home/alice/bad\x00.txt")))
        self.assertIn("error", r)

    def test_unknown_session_404(self):
        r = self._get_json("session_id={}&path=/tmp/x".format(str(uuid.uuid4())))
        self.assertIn("error", r)

    def test_file_not_found_returns_error(self):
        sid = str(uuid.uuid4())
        fake_proc = unittest.mock.MagicMock()
        fake_proc.stdout.read.side_effect = [b"E", b"R", b"R", b"\t",
                                              b"F", b"i", b"l", b"e",
                                              b" ", b"n", b"o", b"t",
                                              b" ", b"f", b"o", b"u",
                                              b"n", b"d", b"\n"]
        fake_session = unittest.mock.MagicMock()
        fake_session.download_file.return_value = (fake_proc, None)
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            r = self._get_json("session_id={}&path=/tmp/missing.txt".format(sid))
        self.assertIn("error", r)
        # Regression: ERR-header early-return path must reap the side-channel
        # ssh after kill — otherwise it lingers as a zombie. Same defect
        # class as the upload_file TimeoutExpired branch fixed in PR #21.
        self.assertTrue(fake_proc.kill.called)
        self.assertTrue(fake_proc.wait.called)

    def test_oversize_file_returns_413(self):
        """Regression: download must refuse files larger than
        MAX_DOWNLOAD_SIZE before sending HTTP 200, so the browser
        doesn't try to accumulate a multi-GB Blob into memory."""
        sid = str(uuid.uuid4())
        # Header advertises a 4 GB file.
        oversize = server.MAX_DOWNLOAD_SIZE + 1
        header = "OK\t{}\n".format(oversize).encode()
        fake_proc = unittest.mock.MagicMock()
        fake_proc.stdout.read.side_effect = [bytes([b]) for b in header]
        fake_session = unittest.mock.MagicMock()
        fake_session.download_file.return_value = (fake_proc, None)
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            r = self._get_json("session_id={}&path=/tmp/huge.bin".format(sid))
        self.assertIn("error", r)
        self.assertIn("too large", r["error"])
        self.assertTrue(fake_proc.kill.called)
        self.assertTrue(fake_proc.wait.called)

    def test_header_read_exception_reaps_proc(self):
        """Regression: when the protocol header read itself raises, the
        early-return path must call proc.wait() after proc.kill() so the
        side-channel ssh child is reaped, not leaked as a zombie."""
        sid = str(uuid.uuid4())
        fake_proc = unittest.mock.MagicMock()
        fake_proc.stdout.read.side_effect = OSError("pipe broken")
        fake_session = unittest.mock.MagicMock()
        fake_session.download_file.return_value = (fake_proc, None)
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            r = self._get_json("session_id={}&path=/tmp/x".format(sid))
        self.assertIn("error", r)
        self.assertTrue(fake_proc.kill.called)
        self.assertTrue(fake_proc.wait.called)

    def test_successful_download_streams_binary(self):
        from urllib.request import urlopen
        sid = str(uuid.uuid4())
        payload = b"hello world binary\x00\xff"
        # Header: "OK\t<size>\n" then payload
        header = "OK\t{}\n".format(len(payload)).encode()
        all_bytes = header + payload
        pos = [0]
        def read_one(_=None):
            if pos[0] >= len(all_bytes):
                return b""
            b = all_bytes[pos[0]:pos[0]+1]
            pos[0] += 1
            return b
        # bulk read for the file body
        def read_bulk(n):
            chunk = all_bytes[pos[0]:pos[0]+n]
            pos[0] += len(chunk)
            return chunk
        fake_proc = unittest.mock.MagicMock()
        # read(1) calls consume header byte by byte; read(BUF) reads body
        fake_proc.stdout.read.side_effect = (
            [bytes([b]) for b in header[:-1]] +  # all header bytes except \n
            [b"\n"] +                              # \n terminates header
            [payload, b""]                         # body then EOF
        )
        fake_session = unittest.mock.MagicMock()
        fake_session.download_file.return_value = (fake_proc, None)
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            url = self._url("session_id={}&path=/tmp/file.bin".format(sid))
            with urlopen(url) as resp:
                self.assertEqual(resp.headers.get("Content-Disposition"),
                                 "attachment; filename*=UTF-8''file.bin")
                body = resp.read()
        self.assertEqual(body, payload)
        # Regression: the streaming loop must stamp last_activity per chunk
        # so multi-GB downloads don't outlive SESSION_TIMEOUT and get reaped
        # mid-stream. Symmetric with upload_file. The fake_session is a
        # MagicMock, so any attribute assignment is recorded.
        # urlopen returns once Content-Length bytes are read, but the server
        # worker thread may still be in the loop / finally block — poll for
        # the assignment to land before asserting.
        deadline = time.time() + 2.0
        while time.time() < deadline and not isinstance(
                fake_session.last_activity, (int, float)):
            time.sleep(0.01)
        self.assertIsInstance(fake_session.last_activity, (int, float))
        self.assertGreater(fake_session.last_activity, 0)

    def test_unknown_size_download_aborts_past_cap(self):
        """When stat fails the header is 'OK\\t-1' and content_length stays
        None, so the upfront 413 is skipped. The streaming loop must still
        bound the bytes and kill the side-channel, or a growing/unbounded
        file (a live log, /dev/zero, a fifo) pins the worker forever."""
        from urllib.request import urlopen
        sid = str(uuid.uuid4())
        header = b"OK\t-1\n"          # stat failed -> unknown size
        big_chunk = b"Z" * 4096
        fake_proc = unittest.mock.MagicMock()
        fake_proc.stdout.read.side_effect = (
            [bytes([b]) for b in header[:-1]] + [b"\n"] +
            [big_chunk, big_chunk, b""]
        )
        fake_session = unittest.mock.MagicMock()
        fake_session.download_file.return_value = (fake_proc, None)
        with unittest.mock.patch.object(server, "MAX_DOWNLOAD_SIZE", 1000), \
             unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            url = self._url("session_id={}&path=/tmp/grow.log".format(sid))
            with urlopen(url) as resp:
                body = resp.read()
        # Bytes sent are bounded near the cap, not the full 8192 streamed.
        self.assertLessEqual(len(body), 1000 + len(big_chunk))
        # The side-channel ssh was killed to stop the runaway stream.
        deadline = time.time() + 2.0
        while time.time() < deadline and not fake_proc.kill.called:
            time.sleep(0.01)
        self.assertTrue(fake_proc.kill.called, "runaway download not aborted")


class TestUploadFileNoDeadlock(unittest.TestCase):
    """Regression: upload_file must drain the side-channel ssh's stderr
    while it streams stdin. An undrained stderr=PIPE deadlocks once ssh
    emits >~64 KB (host-key/banner/MOTD warnings, or a remote `cat` error
    like 'No space left on device'): ssh blocks on the full stderr pipe,
    stops reading our stdin, and proc.stdin.write() blocks forever. Unlike
    download_file (which can discard stderr via DEVNULL), upload_file needs
    the text for its 'ssh exit N: <msg>' error, so it must drain — not
    discard — concurrently."""

    def _fake_session(self, control_path):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = "fake-ul"
        s.persistent = True
        s.slot_id = "ok"
        s.alive = True
        s._control_path = control_path
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        s.last_activity = 0
        return s

    def test_large_stderr_does_not_deadlock_and_is_reported(self):
        s = self._fake_session("/tmp/fake.sock")
        # A child that floods stderr (>64 KB) BEFORE draining stdin, then
        # exits non-zero — the exact shape that deadlocks an undrained PIPE.
        child = [
            sys.executable, "-c",
            "import sys; sys.stderr.buffer.write(b'E' * 200000);"
            " sys.stderr.flush(); sys.stdin.buffer.read(); sys.exit(7)",
        ]
        real_popen = subprocess.Popen

        def fake_popen(cmd, **kw):
            # Honor the stdin/stdout/stderr wiring upload_file chose, but
            # run our controlled child instead of the real ssh argv.
            return real_popen(child, **kw)

        body = io.BytesIO(b"D" * (512 * 1024))
        result = {}

        def run():
            with unittest.mock.patch("os.path.exists", return_value=True), \
                 unittest.mock.patch("subprocess.Popen", side_effect=fake_popen):
                result["v"] = s.upload_file("dest", body, 512 * 1024, timeout=20)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(15)
        self.assertFalse(
            t.is_alive(),
            "upload_file deadlocked (still running after 15s)")
        ok, err = result["v"]
        self.assertFalse(ok)
        self.assertIn("ssh exit 7", err)
        self.assertIn("E", err)  # stderr text preserved for the user

    def test_broken_pipe_surfaces_remote_stderr(self):
        # Remote `cat >` dies mid-upload (disk full): ssh exits and tears down
        # our stdin pipe; the next write() raises BrokenPipeError. The captured
        # remote stderr must be surfaced, not discarded for a bare Broken pipe.
        s = self._fake_session("/tmp/fake.sock")
        child = [
            sys.executable, "-c",
            "import sys; sys.stderr.buffer.write(b'No space left on device');"
            " sys.stderr.flush(); sys.exit(1)",
        ]
        real_popen = subprocess.Popen

        def fake_popen(cmd, **kw):
            return real_popen(child, **kw)

        body = io.BytesIO(b"D" * (8 * 1024 * 1024))
        result = {}

        def run():
            with unittest.mock.patch("os.path.exists", return_value=True), \
                 unittest.mock.patch("subprocess.Popen", side_effect=fake_popen):
                result["v"] = s.upload_file("dest", body, 8 * 1024 * 1024,
                                            timeout=20)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(15)
        self.assertFalse(t.is_alive(),
                         "upload_file deadlocked (still running after 15s)")
        ok, err = result["v"]
        self.assertFalse(ok)
        self.assertIn("No space left on device", err)

    def test_local_stream_error_without_stderr_stays_generic(self):
        # Purely local failure (body read raises) with no remote stderr must
        # NOT grow a spurious "(remote: ...)" suffix.
        s = self._fake_session("/tmp/fake.sock")
        child = [
            sys.executable, "-c",
            "import sys; sys.stdin.buffer.read(); sys.exit(0)",
        ]
        real_popen = subprocess.Popen

        def fake_popen(cmd, **kw):
            return real_popen(child, **kw)

        class BoomReader(object):
            def read(self_, n):
                raise IOError("local disk read failed")

        result = {}

        def run():
            with unittest.mock.patch("os.path.exists", return_value=True), \
                 unittest.mock.patch("subprocess.Popen", side_effect=fake_popen):
                result["v"] = s.upload_file("dest", BoomReader(), 4096,
                                            timeout=20)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(15)
        self.assertFalse(t.is_alive())
        ok, err = result["v"]
        self.assertFalse(ok)
        self.assertIn("local disk read failed", err)
        self.assertNotIn("remote:", err)

    def test_local_error_with_stderr_banner_not_attributed_to_remote(self):
        # A purely-local failure (body read raises) must NOT be blamed on the
        # remote even when ssh wrote a benign banner to stderr — only a
        # torn-down pipe (BrokenPipe/ConnectionReset) earns the "(remote: ...)"
        # suffix. Guards the isinstance() gate. (Safe under load: if the banner
        # is not captured in time the message is generic anyway, so this can
        # only false-PASS, never false-FAIL.)
        s = self._fake_session("/tmp/fake.sock")
        child = [
            sys.executable, "-c",
            "import sys; sys.stderr.buffer.write(b'Welcome to Ubuntu (MOTD)');"
            " sys.stderr.flush(); sys.stdin.buffer.read(); sys.exit(0)",
        ]
        real_popen = subprocess.Popen

        def fake_popen(cmd, **kw):
            return real_popen(child, **kw)

        class SlowBoomReader(object):
            def read(self_, n):
                # Give the child time to emit its stderr banner (which the
                # drain thread captures) before the local read fails, so the
                # _err_buf-is-non-empty path is actually exercised.
                time.sleep(0.3)
                raise IOError("local disk read failed")

        result = {}

        def run():
            with unittest.mock.patch("os.path.exists", return_value=True), \
                 unittest.mock.patch("subprocess.Popen", side_effect=fake_popen):
                result["v"] = s.upload_file("dest", SlowBoomReader(), 4096,
                                            timeout=20)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(15)
        self.assertFalse(t.is_alive())
        ok, err = result["v"]
        self.assertFalse(ok)
        self.assertIn("local disk read failed", err)
        self.assertNotIn("remote:", err)  # local cause must not blame remote


class TestUploadRenameCollision(unittest.TestCase):
    """The extension-less collision loop must build name(1), name(2), ...
    from the original name, not strip a "(...)" suffix — which mangled real
    names containing parentheses (report(final) -> report(1))."""

    # The exact fixed loop emitted by finalize_upload / makeUploadMvCmd.
    _LOOP = ('cd "$1"; f="$2"; '
             'o="$f"; n=1; while [ -e "$f" ]; do f="$o($n)"; n=$((n+1)); done; '
             'printf %s "$f"')

    def _resolve(self, existing, final):
        tmp = tempfile.mkdtemp()
        try:
            for name in existing:
                open(os.path.join(tmp, name), "w").close()
            out = subprocess.check_output(
                ["sh", "-c", self._LOOP, "sh", tmp, final])
            return out.decode()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_parenthesized_name_not_mangled(self):
        self.assertEqual(
            self._resolve(["report(final)"], "report(final)"),
            "report(final)(1)")

    def test_counter_increments_not_accumulates(self):
        self.assertEqual(self._resolve(["data", "data(1)"], "data"), "data(2)")

    def test_no_collision_keeps_name(self):
        self.assertEqual(self._resolve([], "Makefile"), "Makefile")

    def test_server_finalize_uses_fixed_loop(self):
        s = server.SSHSession.__new__(server.SSHSession)
        s.persistent = True
        s.slot_id = "ok"
        s._control_path = "/tmp/fake.sock"
        s._host = "host.example"
        s.tmux_cmd = "tmux"
        calls = []

        def fake_run(cmd, **kw):
            calls.append(cmd)

            class R:
                returncode = 0
                stdout = b"/home/a/f"
                stderr = b""
            return R()

        with unittest.mock.patch("os.path.exists", return_value=True), \
             unittest.mock.patch.object(server.subprocess, "run", fake_run):
            s.finalize_upload(".websh-tmp-x", "report(final)")
        remote = calls[0][-1]
        self.assertIn('o="$f"', remote)
        self.assertNotIn('${f%(*)}', remote)


class TestTmuxCapture(unittest.TestCase):
    """SSHSession.tmux_capture() must bound the captured scrollback so a
    huge tmux history can't be buffered whole into server RAM."""

    def _fake_session(self, tmux_cmd="tmux"):
        s = server.SSHSession.__new__(server.SSHSession)
        s.persistent = True
        s.slot_id = "ok"
        s.alive = True
        s.master_fd = -1
        self._cp = tempfile.NamedTemporaryFile(delete=False)
        self._cp.close()
        s._control_path = self._cp.name  # must exist for the readiness check
        s._host = "host.example"
        s._port = 22
        s._username = "alice"
        s.tmux_cmd = tmux_cmd
        return s

    def tearDown(self):
        try:
            os.unlink(self._cp.name)
        except Exception:
            pass

    def _run_with(self, stdout, returncode=0):
        seen = {}
        def fake_run(cmd, **kw):
            seen["cmd"] = cmd
            class R:
                pass
            R.returncode = returncode
            R.stdout = stdout
            R.stderr = b""
            return R()
        with unittest.mock.patch.object(server.subprocess, "run", fake_run):
            data, err = self._fake_session().tmux_capture()
        return data, err, seen.get("cmd")

    def test_capture_uses_bounded_line_range(self):
        data, err, cmd = self._run_with(b"hello\n")
        self.assertIsNone(err)
        remote_cmd = cmd[-1]  # ssh argv ends with the remote command
        self.assertIn(
            "capture-pane -p -J -S -" + str(server.MAX_TMUX_CAPTURE_LINES),
            remote_cmd)
        # Must not be the old unbounded "from the start of history" form.
        self.assertNotIn("-S - ", remote_cmd)

    def test_capture_truncates_oversized_output(self):
        orig = server.MAX_TMUX_CAPTURE_BYTES
        server.MAX_TMUX_CAPTURE_BYTES = 100
        try:
            data, err, _ = self._run_with(b"x" * 500)
            self.assertIsNone(err)
            self.assertIn(b"truncated to the last 100 bytes", data)
            # The freshest (tail) bytes are kept.
            self.assertTrue(data.endswith(b"x" * 100))
            # Only the small marker is added beyond the byte cap.
            self.assertLessEqual(len(data) - 100, 80)
        finally:
            server.MAX_TMUX_CAPTURE_BYTES = orig

    def test_capture_under_cap_is_untouched(self):
        data, err, _ = self._run_with(b"small output\n")
        self.assertIsNone(err)
        self.assertEqual(data, b"small output\n")

    def test_capture_not_persistent(self):
        s = self._fake_session()
        s.persistent = False
        data, err = s.tmux_capture()
        self.assertIsNone(data)
        self.assertIn("not a persistent", err)


if __name__ == "__main__":
    unittest.main()
