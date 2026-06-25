#!/usr/bin/env python3
"""Tests for websh server.py — access log events, sanitizer, security headers.

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


class TestAccessLogEmit(unittest.TestCase):
    """Unit tests for _access_log_emit (the JSON-line writer)."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.logpath = os.path.join(self.tmpdir, "access.log")
        self._orig = server.ACCESS_LOG_PATH

    def tearDown(self):
        server.ACCESS_LOG_PATH = self._orig
        shutil.rmtree(self.tmpdir)

    def _read_lines(self):
        if not os.path.exists(self.logpath):
            return []
        with open(self.logpath, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def test_noop_when_path_unset(self):
        server.ACCESS_LOG_PATH = ""
        server._access_log_emit("connect", "1.2.3.4", result="ok")
        # No file created in tmpdir, no exception raised.
        self.assertFalse(os.path.exists(self.logpath))

    def test_writes_one_json_line_with_required_fields(self):
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", "1.2.3.4", result="ok",
                                target_host="srv.example", sid="abc")
        recs = self._read_lines()
        self.assertEqual(len(recs), 1)
        r = recs[0]
        # Required fields
        self.assertEqual(r["event"], "connect")
        self.assertEqual(r["ip"], "1.2.3.4")
        self.assertIn("ts", r)
        # Custom fields
        self.assertEqual(r["result"], "ok")
        self.assertEqual(r["target_host"], "srv.example")
        self.assertEqual(r["sid"], "abc")
        # ts is ISO-Z UTC format
        self.assertTrue(r["ts"].endswith("Z"), r["ts"])

    def test_appends_multiple_records(self):
        server.ACCESS_LOG_PATH = self.logpath
        for i in range(3):
            server._access_log_emit("connect", "1.2.3.4",
                                    result="rate_limited", n=i)
        recs = self._read_lines()
        self.assertEqual(len(recs), 3)
        self.assertEqual([r["n"] for r in recs], [0, 1, 2])

    def test_empty_ip_normalized(self):
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", None, result="ok")
        r = self._read_lines()[0]
        self.assertEqual(r["ip"], "")

    def test_oserror_swallowed_no_crash(self):
        # Path is a directory — open(..., "a") raises IsADirectoryError on Linux.
        server.ACCESS_LOG_PATH = self.tmpdir
        try:
            server._access_log_emit("connect", "1.2.3.4", result="ok")
        except OSError:
            self.fail("_access_log_emit must swallow OSError, not raise")

    def test_unicode_in_fields_does_not_break(self):
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", "1.2.3.4",
                                target_host="кириллица.example",
                                target_user="бот")
        r = self._read_lines()[0]
        self.assertEqual(r["target_host"], "кириллица.example")
        self.assertEqual(r["target_user"], "бот")

    def test_sanitises_control_and_bidi_chars(self):
        # ESC + ANSI CSI + RLO (right-to-left override) — all of these
        # would render funkily in a terminal if an operator `cat`'d the
        # log, and JSON's ensure_ascii=False does not escape them.
        server.ACCESS_LOG_PATH = self.logpath
        hostile = "\x1b[31m‮evil\x00"
        server._access_log_emit("connect", "1.2.3.4",
                                target_host=hostile, target_user="alice")
        r = self._read_lines()[0]
        self.assertNotIn("\x1b", r["target_host"])
        self.assertNotIn("‮", r["target_host"])
        self.assertNotIn("\x00", r["target_host"])
        # The sanitiser replaces each bad codepoint with "?" rather
        # than dropping it, so the structure is preserved.
        self.assertEqual(r["target_host"], "?[31m?evil?")

    def test_target_host_truncated_to_dns_max(self):
        server.ACCESS_LOG_PATH = self.logpath
        long_host = "h" * 1000
        server._access_log_emit("connect", "1.2.3.4",
                                target_host=long_host, target_user="u")
        r = self._read_lines()[0]
        self.assertEqual(len(r["target_host"]), 253)
        self.assertTrue(all(ch == "h" for ch in r["target_host"]))

    def test_target_user_truncated_to_64(self):
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", "1.2.3.4",
                                target_host="h", target_user="u" * 1000)
        r = self._read_lines()[0]
        self.assertEqual(len(r["target_user"]), 64)

    def test_error_truncated_to_200_codepoints(self):
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", "1.2.3.4", result="error",
                                error="X" * 1000)
        r = self._read_lines()[0]
        self.assertEqual(len(r["error"]), 200)

    def test_error_truncation_is_codepoint_not_byte(self):
        # "й" is U+0439, two bytes in UTF-8. A 1000-codepoint string of
        # "й" is 2000 bytes; the cap is 200 _codepoints_ (≈400 bytes
        # UTF-8), not 200 bytes — verifies the README's clarification.
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", "1.2.3.4", result="error",
                                error="й" * 1000)
        r = self._read_lines()[0]
        self.assertEqual(len(r["error"]), 200)
        self.assertEqual(len(r["error"].encode("utf-8")), 400)

    def test_target_host_with_embedded_nul_is_sanitised(self):
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", "1.2.3.4",
                                target_host="srv\x00.example",
                                target_user="u")
        r = self._read_lines()[0]
        self.assertNotIn("\x00", r["target_host"])
        self.assertEqual(r["target_host"], "srv?.example")

    def test_record_serialises_with_single_os_write(self):
        # Smoke-check that the implementation switched to os.write on
        # an O_APPEND fd — i.e. the line still ends with a newline and
        # round-trips intact even when the buffered TextIOWrapper path
        # is gone. Two emits in a row must yield exactly two lines.
        server.ACCESS_LOG_PATH = self.logpath
        server._access_log_emit("connect", "1.2.3.4", result="ok",
                                target_host="a")
        server._access_log_emit("connect", "1.2.3.4", result="ok",
                                target_host="b")
        with open(self.logpath, "rb") as f:
            raw = f.read()
        # Each record terminates with exactly one '\n', so the byte
        # count must equal len(records) for a well-formed file.
        self.assertEqual(raw.count(b"\n"), 2)


class TestResolveLogPath(unittest.TestCase):
    """Unit tests for _resolve_log_path (WEBSH_ACCESS_LOG normalisation)."""

    def test_empty_returns_empty(self):
        self.assertEqual(server._resolve_log_path(""), "")
        self.assertEqual(server._resolve_log_path(None), "")
        self.assertEqual(server._resolve_log_path("   "), "")
        self.assertEqual(server._resolve_log_path("\t\n"), "")

    def test_tilde_is_expanded(self):
        result = server._resolve_log_path("~/x.log")
        expected = os.path.abspath(os.path.expanduser("~/x.log"))
        self.assertEqual(result, expected)
        # Sanity: ~ must actually expand (no literal "~" surviving).
        self.assertNotIn("~", result)

    def test_relative_resolved_against_cwd(self):
        result = server._resolve_log_path("x.log")
        self.assertTrue(os.path.isabs(result))
        self.assertEqual(result, os.path.abspath("x.log"))

    def test_absolute_passthrough(self):
        # Already absolute: stays absolute, unchanged shape.
        result = server._resolve_log_path("/var/log/websh.log")
        self.assertEqual(result, "/var/log/websh.log")

    def test_strips_surrounding_whitespace(self):
        result = server._resolve_log_path("  /tmp/x.log  ")
        self.assertEqual(result, "/tmp/x.log")


class TestSanitizeForLog(unittest.TestCase):
    """Direct unit tests for the sanitisation helper."""

    def test_passthrough_for_safe_text(self):
        self.assertEqual(server._sanitize_for_log("alice", 64), "alice")
        # Cyrillic and emoji are fine — they're not in the bad set.
        self.assertEqual(server._sanitize_for_log("кириллица", 64),
                         "кириллица")

    def test_truncates_to_codepoints(self):
        self.assertEqual(len(server._sanitize_for_log("x" * 1000, 10)),
                         10)
        # Two-byte UTF-8 codepoint: cap is by codepoint, not byte.
        self.assertEqual(len(server._sanitize_for_log("й" * 1000,
                                                     10)),
                         10)

    def test_replaces_c0(self):
        self.assertEqual(server._sanitize_for_log("a\x00b\x1bc", 64),
                         "a?b?c")

    def test_replaces_c1_and_del(self):
        # 0x7F (DEL) and 0x80–0x9F (C1) are all bad.
        self.assertEqual(server._sanitize_for_log("a\x7fb\x9fc", 64),
                         "a?b?c")

    def test_replaces_bidi(self):
        for cp in (0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
                   0x2066, 0x2067, 0x2068, 0x2069):
            s = "a" + chr(cp) + "b"
            self.assertEqual(server._sanitize_for_log(s, 64), "a?b",
                             "U+{:04X}".format(cp))

    def test_coerces_non_str(self):
        self.assertEqual(server._sanitize_for_log(42, 64), "42")
        self.assertEqual(server._sanitize_for_log(None, 64), "None")


class TestAccessLogConnectEvents(LiveServerCase):
    """Integration: each /api/connect rejection path emits the right event."""

    CONFIG = {
        "restrict_hosts": False,
        "denied_hosts": ["10.0.0.0/8", "blocked.example"],
        "connections": [],
    }

    def setUp(self):
        server._rate_limits.clear()
        self.logfile = tempfile.NamedTemporaryFile(
            mode="w", suffix=".log", delete=False)
        self.logfile.close()
        self._orig_path = server.ACCESS_LOG_PATH
        server.ACCESS_LOG_PATH = self.logfile.name

    def tearDown(self):
        server.ACCESS_LOG_PATH = self._orig_path
        os.unlink(self.logfile.name)

    def _read_records(self):
        with open(self.logfile.name, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def _post_connect(self, body):
        return self._post("/api/connect", body)

    def test_deny_blocked_emits_event(self):
        _, code = self._post_connect({
            "host": "10.5.6.7", "username": "u", "password": "p",
            "cols": 80, "rows": 24,
        })
        self.assertEqual(code, 403)
        recs = self._read_records()
        self.assertTrue(any(r["event"] == "connect" and
                            r["result"] == "deny_blocked" and
                            r["target_host"] == "10.5.6.7"
                            for r in recs),
                        "expected deny_blocked event, got {}".format(recs))

    def test_rate_limited_emits_event(self):
        # Burn the budget on this IP, then try one more.
        for _ in range(server.RATE_LIMIT_MAX):
            server._check_rate_limit("127.0.0.1")
        _, code = self._post_connect({
            "host": "blocked.example", "username": "u", "password": "p",
            "cols": 80, "rows": 24,
        })
        self.assertEqual(code, 429)
        recs = self._read_records()
        rl = [r for r in recs
              if r["event"] == "connect" and r["result"] == "rate_limited"]
        self.assertEqual(len(rl), 1, "expected one rate_limited, got {}".format(recs))

    def test_record_format_stable_for_fail2ban(self):
        """fail2ban's filter regex matches "ip":"<HOST>" then "result":"deny_blocked"
        on a single line. Make sure the record has those keys with those exact
        names and serialised values, and that everything is on one line."""
        _, _ = self._post_connect({
            "host": "blocked.example", "username": "abuser",
            "password": "p", "cols": 80, "rows": 24,
        })
        with open(self.logfile.name, "r", encoding="utf-8") as f:
            lines = f.readlines()
        self.assertGreaterEqual(len(lines), 1)
        line = lines[-1].rstrip("\n")
        # No embedded newlines (atomic single-line writes for logrotate +
        # fail2ban regex sanity).
        self.assertNotIn("\n", line)
        # Keys are present with the expected casing/quoting.
        self.assertIn('"ip":"127.0.0.1"', line)
        self.assertIn('"result":"deny_blocked"', line)
        self.assertIn('"target_host":"blocked.example"', line)

    # ── Session-cap, disconnect, and error-path coverage ──

    def _seed_cap_filler(self, count, is_background):
        """Plant `count` minimal stub sessions so the cap check trips
        without us having to actually open SSH connections."""
        class _CapFiller(object):
            pass
        seeded = []
        with server.sessions_lock:
            for i in range(count):
                s = _CapFiller()
                s.is_background = is_background
                sid = "cap-fill-{}-{}".format(
                    "bg" if is_background else "fg", i)
                server.sessions[sid] = s
                seeded.append(sid)
        return seeded

    def _drop_seeded(self, sids):
        with server.sessions_lock:
            for sid in sids:
                server.sessions.pop(sid, None)

    def test_session_cap_foreground_emits_classification(self):
        # Force the foreground cap to bite by filling at MAX_SESSIONS.
        seeded = self._seed_cap_filler(server.MAX_SESSIONS,
                                       is_background=False)
        try:
            _, code = self._post_connect({
                "host": "ok.example", "username": "u", "password": "p",
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 429)
            recs = self._read_records()
            cap = [r for r in recs
                   if r["event"] == "connect" and
                      r["result"] == "session_cap_global"]
            self.assertEqual(len(cap), 1, recs)
            self.assertEqual(cap[0]["classification"], "foreground")
            self.assertEqual(cap[0]["target_host"], "ok.example")
        finally:
            self._drop_seeded(seeded)

    def test_session_cap_background_emits_classification(self):
        seeded = self._seed_cap_filler(server.MAX_BG_SESSIONS,
                                       is_background=True)
        try:
            _, code = self._post_connect({
                "host": "ok.example", "username": "u", "password": "p",
                "cols": 80, "rows": 24, "background": True,
            })
            self.assertEqual(code, 429)
            recs = self._read_records()
            cap = [r for r in recs
                   if r["event"] == "connect" and
                      r["result"] == "session_cap_global"]
            self.assertEqual(len(cap), 1, recs)
            self.assertEqual(cap[0]["classification"], "background")
        finally:
            self._drop_seeded(seeded)

    def test_error_path_truncates_long_exception(self):
        """Monkeypatch SSHSession to raise a 1000-char exception; the
        emitted record must have result=error and len(error) == 200."""
        class _BadSession(object):
            def __init__(self, **kwargs):
                raise RuntimeError("X" * 1000)
        orig = server.SSHSession
        server.SSHSession = _BadSession
        try:
            _, code = self._post_connect({
                "host": "ok.example", "username": "u", "password": "p",
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 500)
            recs = self._read_records()
            err = [r for r in recs
                   if r["event"] == "connect" and r["result"] == "error"]
            self.assertEqual(len(err), 1, recs)
            self.assertEqual(len(err[0]["error"]), 200)
            self.assertTrue(all(ch == "X" for ch in err[0]["error"]))
        finally:
            server.SSHSession = orig


class TestAccessLogDisconnectEvents(LiveServerCase):
    """Integration: /api/disconnect emits an access-log record with the
    right `result` value (and surfaces close failures via close_error)."""

    CONFIG = {"connections": []}

    def setUp(self):
        with server.sessions_lock:
            server.sessions.clear()
        self.logfile = tempfile.NamedTemporaryFile(
            mode="w", suffix=".log", delete=False)
        self.logfile.close()
        self._orig_path = server.ACCESS_LOG_PATH
        server.ACCESS_LOG_PATH = self.logfile.name

    def tearDown(self):
        server.ACCESS_LOG_PATH = self._orig_path
        os.unlink(self.logfile.name)
        with server.sessions_lock:
            server.sessions.clear()

    def _read_records(self):
        with open(self.logfile.name, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def _seed(self, sid, host="host.example", close_raises=None):
        class _Stub(object):
            pass
        s = _Stub()
        s._host = host
        s.terminated = False
        s.closed = False
        def _term():
            s.terminated = True
        def _close():
            s.closed = True
            if close_raises is not None:
                raise close_raises
        s.terminate_remote_tmux = _term
        s.close = _close
        with server.sessions_lock:
            server.sessions[sid] = s
        return s

    def test_disconnect_terminate_false_logs_closed(self):
        sid = "12345678-1234-1234-1234-aaaaaaaaaaaa"
        s = self._seed(sid, host="srv.example")
        _, code = self._post("/api/disconnect",
                             {"session_id": sid, "terminate": False})
        self.assertEqual(code, 200)
        recs = self._read_records()
        d = [r for r in recs if r["event"] == "disconnect"]
        self.assertEqual(len(d), 1, recs)
        self.assertEqual(d[0]["result"], "closed")
        self.assertEqual(d[0]["sid"], sid)
        self.assertEqual(d[0]["terminate"], False)
        self.assertEqual(d[0]["target_host"], "srv.example")
        self.assertNotIn("error", d[0])

    def test_disconnect_terminate_true_logs_terminated(self):
        sid = "12345678-1234-1234-1234-bbbbbbbbbbbb"
        self._seed(sid, host="srv.example")
        _, code = self._post("/api/disconnect",
                             {"session_id": sid, "terminate": True})
        self.assertEqual(code, 200)
        recs = self._read_records()
        d = [r for r in recs if r["event"] == "disconnect"]
        self.assertEqual(len(d), 1, recs)
        self.assertEqual(d[0]["result"], "terminated")
        self.assertEqual(d[0]["terminate"], True)
        self.assertEqual(d[0]["target_host"], "srv.example")

    def test_disconnect_close_failure_logs_close_error(self):
        """If session.close raises, the access-log record must still
        appear, with result=close_error and `error` carrying the
        exception text (capped to 200 codepoints)."""
        sid = "12345678-1234-1234-1234-cccccccccccc"
        self._seed(sid, host="srv.example",
                   close_raises=RuntimeError("kaboom" * 100))
        _, code = self._post("/api/disconnect",
                             {"session_id": sid, "terminate": False})
        self.assertEqual(code, 200)
        recs = self._read_records()
        d = [r for r in recs if r["event"] == "disconnect"]
        self.assertEqual(len(d), 1, recs)
        self.assertEqual(d[0]["result"], "close_error")
        self.assertIn("error", d[0])
        # 200-char cap (RuntimeError args + cap = 600 chars truncated to 200).
        self.assertEqual(len(d[0]["error"]), 200)
        self.assertEqual(d[0]["target_host"], "srv.example")

    def test_disconnect_unknown_sid_emits_no_record(self):
        # No session in the table → handler is a 200-OK no-op, no
        # access-log entry. Otherwise an attacker could spam disconnect
        # with random sids and inflate the log.
        _, code = self._post("/api/disconnect",
                             {"session_id": "no-such",
                              "terminate": False})
        self.assertEqual(code, 200)
        self.assertEqual(self._read_records(), [])


class TestSecurityHeaders(LiveServerCase):
    """The credential-handling page must ship CSP + companion hardening
    headers, and the CSP must still permit what the app actually loads."""

    def _headers(self, path):
        from urllib.request import urlopen
        with urlopen(self._server_url(path)) as r:
            return r.headers

    def test_index_emits_hardening_headers(self):
        h = self._headers("/")
        self.assertIsNotNone(h.get("Content-Security-Policy"))
        self.assertIn("frame-ancestors 'none'",
                      h.get("Content-Security-Policy"))
        self.assertEqual(h.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(h.get("X-Frame-Options"), "DENY")
        self.assertEqual(h.get("Referrer-Policy"), "no-referrer")

    def test_csp_permits_what_the_app_loads(self):
        csp = self._headers("/").get("Content-Security-Policy")
        # Must not break the real app: self scripts, the xterm CDN, Google
        # Fonts, and data: URIs are all in use today.
        self.assertIn("script-src 'self'", csp)
        self.assertIn("https://cdn.jsdelivr.net", csp)
        self.assertIn("https://fonts.googleapis.com", csp)
        self.assertIn("img-src 'self' data:", csp)
        self.assertIn("connect-src 'self'", csp)


class TestTransferAccessLog(LiveServerCase):
    """Download and upload must emit access-log records so bulk data
    transfer through a logged-in session is auditable (fail2ban /
    forensics), with a byte count and the (sanitized) path."""

    def setUp(self):
        self._orig_log = server.ACCESS_LOG_PATH
        self._logf = tempfile.NamedTemporaryFile(suffix=".log", delete=False)
        self._logf.close()
        server.ACCESS_LOG_PATH = self._logf.name

    def tearDown(self):
        server.ACCESS_LOG_PATH = self._orig_log
        try:
            os.unlink(self._logf.name)
        except Exception:
            pass

    def _records(self, event, want=1, timeout=2.0):
        # The download record is emitted after the response body is fully
        # streamed, so the client's urlopen can return before the server
        # finishes writing the log line — poll briefly for it.
        deadline = time.time() + timeout
        while True:
            with open(self._logf.name) as f:
                recs = [json.loads(line) for line in f if line.strip()]
            hits = [r for r in recs if r.get("event") == event]
            if len(hits) >= want or time.time() >= deadline:
                return hits
            time.sleep(0.02)

    def test_download_emits_access_log(self):
        from urllib.request import urlopen
        sid = str(uuid.uuid4())
        payload = b"secret-data-1234"
        header = "OK\t{}\n".format(len(payload)).encode()
        fake_proc = unittest.mock.MagicMock()
        fake_proc.stdout.read.side_effect = (
            [bytes([b]) for b in header[:-1]] + [b"\n"] + [payload, b""])
        fake_session = unittest.mock.MagicMock()
        fake_session._host = "h.example"
        fake_session.download_file.return_value = (fake_proc, None)
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            url = "http://127.0.0.1:{}/api/download?session_id={}&path={}".format(
                self.port, sid, "/home/alice/secret.txt")
            with urlopen(url) as resp:
                resp.read()
        recs = self._records("download")
        self.assertEqual(len(recs), 1, "one download record; got " + repr(recs))
        r = recs[0]
        self.assertEqual(r["sid"], sid)
        self.assertEqual(r["bytes"], len(payload))
        self.assertEqual(r["result"], "ok")
        self.assertEqual(r["target_host"], "h.example")
        self.assertIn("secret.txt", r["path"])

    def test_upload_emits_access_log(self):
        from urllib.request import urlopen, Request
        sid = str(uuid.uuid4())
        data = b"infiltrated-bytes!!"
        fake_session = unittest.mock.MagicMock()
        fake_session._host = "h.example"
        fake_session.upload_file.return_value = (True, "")
        with unittest.mock.patch.dict(server.sessions, {sid: fake_session}):
            url = "http://127.0.0.1:{}/api/upload?session_id={}&path={}".format(
                self.port, sid, "drop.sh")
            req = Request(url, data=data, method="POST")
            req.add_header("Content-Type", "application/octet-stream")
            with urlopen(req) as resp:
                resp.read()
        recs = self._records("upload")
        self.assertEqual(len(recs), 1, "one upload record; got " + repr(recs))
        r = recs[0]
        self.assertEqual(r["sid"], sid)
        self.assertEqual(r["bytes"], len(data))
        self.assertEqual(r["result"], "ok")
        self.assertEqual(r["target_host"], "h.example")
        self.assertIn("drop.sh", r["path"])


if __name__ == "__main__":
    unittest.main()
