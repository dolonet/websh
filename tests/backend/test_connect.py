#!/usr/bin/env python3
"""Tests for websh server.py — connect validation, prompt connect, per-IP caps, rate limiting, scan pattern, ssh command building.

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


class TestPromptConnectHTTP(LiveServerCase):
    """Named /api/connect for Prompt entries — body carries creds, server
    enforces allowed_users / denied_users when no fixed username."""

    CONFIG = {
        "connections": [
            {"name": "free", "host": "free.example.com"},
            {"name": "wl", "host": "wl.example.com",
             "allowed_users": ["alice", "bob"]},
            {"name": "bl", "host": "bl.example.com",
             "denied_users": ["root"]},
            {"name": "fixed", "host": "fx.example.com",
             "username": "ops", "allowed_users": ["neverchecked"]},
        ]
    }

    def setUp(self):
        server._rate_limits.clear()

    def test_config_lists_kinds(self):
        body, code = self._get("/api/config")
        self.assertEqual(code, 200)
        kinds = [c["kind"] for c in body["connections"]]
        self.assertEqual(kinds, ["prompt", "prompt", "prompt", "prompt"])
        # Fixed-user Prompt entry does NOT expose allowed_users (never checked)
        fixed = next(c for c in body["connections"] if c["name"] == "fixed")
        self.assertEqual(fixed["username"], "ops")

    def test_prompt_requires_username(self):
        body, code = self._post("/api/connect", {
            "connection": "free", "password": "x", "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("username", body["error"])

    def test_prompt_requires_password_or_key(self):
        body, code = self._post("/api/connect", {
            "connection": "free", "username": "alice",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("password", body["error"])

    def test_whitelist_allows_listed_user(self):
        body, code = self._post("/api/connect", {
            "connection": "wl", "username": "alice", "password": "x",
            "cols": 80, "rows": 24
        })
        # Not 403 — the allowlist is satisfied (SSH itself may fail later).
        self.assertNotEqual(code, 403)

    def test_whitelist_rejects_other_user(self):
        body, code = self._post("/api/connect", {
            "connection": "wl", "username": "eve", "password": "x",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 403)
        self.assertIn("allowed list", body["error"])

    def test_blacklist_rejects_listed_user(self):
        body, code = self._post("/api/connect", {
            "connection": "bl", "username": "root", "password": "x",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 403)

    def test_blacklist_allows_other_user(self):
        body, code = self._post("/api/connect", {
            "connection": "bl", "username": "alice", "password": "x",
            "cols": 80, "rows": 24
        })
        self.assertNotEqual(code, 403)

    def test_fixed_username_ignores_user_lists(self):
        """When entry has a fixed username, allowed_users is not consulted."""
        body, code = self._post("/api/connect", {
            "connection": "fixed", "username": "attacker",
            "password": "x", "cols": 80, "rows": 24
        })
        # Connect proceeds with the config's fixed username "ops" —
        # no 403 even though body's "attacker" isn't in allowed_users.
        self.assertNotEqual(code, 403)

    def test_manual_free_form_is_unrestricted_when_no_restrict_hosts(self):
        """Free-form manual connects are NOT constrained by Prompt entries."""
        body, code = self._post("/api/connect", {
            "host": "anything.example.com", "port": 22,
            "username": "anyone", "password": "x", "cols": 80, "rows": 24
        })
        # No 403 — server accepts free-form manual connects here.
        self.assertNotEqual(code, 403)

    def test_background_session_same_enforcement(self):
        """File transfer uses background:true on the same path."""
        body, code = self._post("/api/connect", {
            "connection": "wl", "username": "eve", "password": "x",
            "cols": 80, "rows": 24, "background": True
        })
        self.assertEqual(code, 403)


class TestClientIp(unittest.TestCase):
    """Unit tests for Handler._client_ip — XFF parsing and validation.

    Covers Issue 2 (must reject non-IP-literal first XFF token, NOT
    silently use it as the rate-limit / per-IP-cap key) and Issue 6
    (attacker-controlled bytes must not end up as the registry
    comparison key for `client_ip`).
    """

    class _FakeHeaders(object):
        """Minimal stand-in for http.client.HTTPMessage. _client_ip only
        calls `.get(name, default)`; we do not need the rest."""

        def __init__(self, mapping):
            self._m = dict(mapping or {})

        def get(self, name, default=""):
            return self._m.get(name, default)

    def _make_handler(self, peer, headers=None):
        h = server.Handler.__new__(server.Handler)
        h.client_address = (peer, 12345)
        h.headers = self._FakeHeaders(headers or {})
        return h

    def setUp(self):
        # Pin TRUSTED_PROXIES to a known value so other tests that
        # mutate it cannot bleed in.
        self._orig_trusted = server._TRUSTED_PROXIES
        server._TRUSTED_PROXIES = {"127.0.0.1", "10.0.0.5"}

    def tearDown(self):
        server._TRUSTED_PROXIES = self._orig_trusted

    def test_no_xff_returns_peer(self):
        h = self._make_handler("127.0.0.1")
        self.assertEqual(h._client_ip(), "127.0.0.1")

    def test_untrusted_peer_ignores_xff(self):
        h = self._make_handler("8.8.8.8",
                               {"X-Forwarded-For": "1.2.3.4"})
        self.assertEqual(h._client_ip(), "8.8.8.8")

    def test_trusted_peer_uses_first_xff_token(self):
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": "1.2.3.4, 5.6.7.8"})
        self.assertEqual(h._client_ip(), "1.2.3.4")

    def test_trusted_peer_ipv6_token_is_accepted(self):
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": "2001:db8::1"})
        self.assertEqual(h._client_ip(), "2001:db8::1")

    def test_garbage_first_xff_token_falls_back_to_peer(self):
        # The crucial regression: pre-fix, "garbage" would be the
        # returned IP and end up in the rate-limit dict and as
        # SSHSession.client_ip.
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": "garbage,1.2.3.4"})
        self.assertEqual(h._client_ip(), "127.0.0.1")
        # Sanity: the *peer* never silently picks up the garbage as a
        # substring or prefix.
        self.assertNotIn("garbage", h._client_ip())

    def test_oversized_non_ip_token_falls_back_to_peer(self):
        # Issue 6: attacker-controlled bytes must not propagate as the
        # registry key. 1 KiB of binary garbage is well past anything
        # ipaddress.ip_address would accept.
        blob = "A" * 1024
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": blob + ",1.2.3.4"})
        self.assertEqual(h._client_ip(), "127.0.0.1")

    def test_empty_first_token_falls_back_to_peer(self):
        # ", 1.2.3.4" — first token is the empty string. Validation is
        # gated on truthiness so we still hit the peer fallback.
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": ", 1.2.3.4"})
        self.assertEqual(h._client_ip(), "127.0.0.1")

    def test_whitespace_only_token_falls_back_to_peer(self):
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": "   ,1.2.3.4"})
        self.assertEqual(h._client_ip(), "127.0.0.1")

    def test_token_is_stripped_before_validation(self):
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": "  1.2.3.4  ,5.6.7.8"})
        self.assertEqual(h._client_ip(), "1.2.3.4")

    def test_invalid_ip_with_extra_chars_falls_back(self):
        # "1.2.3.4abc" is not a valid IP literal even though it starts
        # with a valid IP — strict ip_address() parsing.
        h = self._make_handler("127.0.0.1",
                               {"X-Forwarded-For": "1.2.3.4abc"})
        self.assertEqual(h._client_ip(), "127.0.0.1")


class TestRateLimit(unittest.TestCase):

    def setUp(self):
        server._rate_limits.clear()

    def test_allowed_within_limit(self):
        for _ in range(server.RATE_LIMIT_MAX):
            self.assertTrue(server._check_rate_limit("10.0.0.1"))

    def test_blocked_over_limit(self):
        for _ in range(server.RATE_LIMIT_MAX):
            server._check_rate_limit("10.0.0.2")
        self.assertFalse(server._check_rate_limit("10.0.0.2"))

    def test_different_ips_independent(self):
        for _ in range(server.RATE_LIMIT_MAX):
            server._check_rate_limit("10.0.0.3")
        self.assertTrue(server._check_rate_limit("10.0.0.4"))


class TestScanPatternDetection(unittest.TestCase):
    """Unit tests for the scan-pattern detector.

    Two safety properties matter as much as the positive detection:
      1. A legitimate user with one or two typos does NOT trip.
      2. ANY successful connect from an IP clears its accumulated
         deny-list state, so a power user with many real targets is
         immune.
    """

    def setUp(self):
        # Detector is module-state; snapshot+clear so tests can't leak.
        with server._scan_pattern_lock:
            self._snapshot = dict(server._scan_pattern)
            server._scan_pattern.clear()
        self._orig_threshold = server.SCAN_PATTERN_THRESHOLD
        self._orig_window = server.SCAN_PATTERN_WINDOW

    def tearDown(self):
        with server._scan_pattern_lock:
            server._scan_pattern.clear()
            server._scan_pattern.update(self._snapshot)
        server.SCAN_PATTERN_THRESHOLD = self._orig_threshold
        server.SCAN_PATTERN_WINDOW = self._orig_window

    # ── safety: detector disabled by default ──

    def test_disabled_by_default(self):
        """SCAN_PATTERN_THRESHOLD=0 means the detector is a no-op no
        matter what an IP does. Default config must NOT ban anyone."""
        server.SCAN_PATTERN_THRESHOLD = 0
        for i in range(100):
            self.assertFalse(server._record_deny_for_scan(
                "1.2.3.4", "host{}.example".format(i)))

    # ── positive detection ──

    def test_triggers_past_threshold(self):
        server.SCAN_PATTERN_THRESHOLD = 3
        # Convention matches _check_rate_limit: fire on the threshold
        # itself (>=), not threshold+1. SCAN_PATTERN_THRESHOLD=3 means
        # "the 3rd distinct host trips the ban".
        self.assertFalse(server._record_deny_for_scan("1.2.3.4", "h1"))
        self.assertFalse(server._record_deny_for_scan("1.2.3.4", "h2"))
        self.assertTrue(server._record_deny_for_scan("1.2.3.4", "h3"))
        # And every probe AFTER fires too (so fail2ban keeps seeing
        # the signal — single line is easy to miss in log rotation).
        self.assertTrue(server._record_deny_for_scan("1.2.3.4", "h4"))

    def test_repeats_to_same_host_do_not_count(self):
        """An IP retrying the SAME blocked host (e.g. a script with a
        config error pinning to one bad target) is annoying but it is
        not a scan — no broad probing. Threshold counts DISTINCT hosts."""
        server.SCAN_PATTERN_THRESHOLD = 3
        for _ in range(20):
            self.assertFalse(server._record_deny_for_scan(
                "1.2.3.4", "stuck.example"))

    def test_other_ips_independent(self):
        server.SCAN_PATTERN_THRESHOLD = 2
        for h in ("a", "b", "c"):
            server._record_deny_for_scan("attacker", h)
        # Innocent IP not affected
        self.assertFalse(server._record_deny_for_scan(
            "innocent.10.0.0.5", "real.example"))

    # ── safety: success forgives ──

    def test_successful_connect_clears_state(self):
        """The asymmetry: only deny_blocked accumulates, only ok forgives.
        A power user who legitimately connects to many servers always
        forgives themselves, so they never accumulate to a ban."""
        server.SCAN_PATTERN_THRESHOLD = 3
        # IP gets close to the threshold via a string of typoed denies
        for h in ("rfc1918-typo-a", "rfc1918-typo-b", "rfc1918-typo-c"):
            server._record_deny_for_scan("power-user", h)
        # Then they successfully connect to a real server
        server._forgive_scan_for_ip("power-user")
        # Their state is gone; one more deny doesn't trigger
        self.assertFalse(server._record_deny_for_scan(
            "power-user", "another-typo"))
        # Another distinct host: still under threshold (count=2)
        self.assertFalse(server._record_deny_for_scan("power-user", "d"))
        # Third distinct host since the forgive: hits threshold (>=3)
        self.assertTrue(server._record_deny_for_scan("power-user", "e"))

    def test_window_expires_old_events(self):
        """Old deny events fall out of the window — slow-and-low
        scanners stretching their probes across hours never accumulate
        enough inside the 5-minute (default) window. Use a clock mock
        so the test runs in milliseconds rather than burning real time
        on a CI runner."""
        server.SCAN_PATTERN_THRESHOLD = 3
        server.SCAN_PATTERN_WINDOW = 60
        # Plant three denies at virtual time t=1000.
        with unittest.mock.patch("server.time.time", return_value=1000.0):
            for h in ("a", "b", "c"):
                server._record_deny_for_scan("slow-scanner", h)
        # Fast-forward past the window: the next probe is the first
        # event inside the (new) window — count drops to 1 — no fire.
        with unittest.mock.patch("server.time.time", return_value=1100.0):
            self.assertFalse(server._record_deny_for_scan(
                "slow-scanner", "d"))

    # ── safety: realistic devops user does NOT trigger ──

    def test_devops_with_50_servers_never_triggers(self):
        """Simulate a power user touching 50 real servers, with one
        typo'd RFC1918 attempt. Must never trigger."""
        server.SCAN_PATTERN_THRESHOLD = 5
        for i in range(50):
            # Each successful connect clears any accumulated state
            server._forgive_scan_for_ip("devops")
            # And imagine they had a typo somewhere
            if i % 7 == 3:
                triggered = server._record_deny_for_scan(
                    "devops", "10.0.0.{}".format(i))
                self.assertFalse(
                    triggered,
                    "devops user must not trigger after iter {}".format(i))

    def test_empty_ip_returns_false(self):
        server.SCAN_PATTERN_THRESHOLD = 1
        self.assertFalse(server._record_deny_for_scan("", "h"))
        self.assertFalse(server._record_deny_for_scan(None, "h"))

    def test_forgive_no_op_on_empty_ip(self):
        # Should not raise
        server._forgive_scan_for_ip("")
        server._forgive_scan_for_ip(None)

    # ── safety: stored host string is capped and normalised ──

    def test_long_target_host_is_capped(self):
        """Per-IP buffer must not let a 100KB host inflate memory.
        Stored entries must be truncated to _DEFAULT_FIELD_CAP chars."""
        server.SCAN_PATTERN_THRESHOLD = 1
        server._record_deny_for_scan("1.2.3.4", "x" * 100000)
        with server._scan_pattern_lock:
            events = list(server._scan_pattern.get("1.2.3.4", []))
        self.assertEqual(len(events), 1)
        _, stored = events[0]
        self.assertLessEqual(len(stored), server._DEFAULT_FIELD_CAP)

    def test_case_variants_collapse_to_one_distinct_host(self):
        """An attacker probing one host with 10 case variants must not
        clear the distinct-host threshold — same host = one bucket."""
        server.SCAN_PATTERN_THRESHOLD = 3
        # 10 case variants of the same host — all should normalise
        # to a single distinct entry, no fire.
        variants = [
            "Host.Example", "HOST.EXAMPLE", "host.example",
            "hOsT.ExAmPlE", "HOST.example", "host.EXAMPLE",
            "Host.example", "host.Example", "HoSt.eXaMpLe",
            "HOST.Example",
        ]
        for h in variants:
            self.assertFalse(server._record_deny_for_scan("1.2.3.4", h))
        with server._scan_pattern_lock:
            unique = set(h for _, h in server._scan_pattern.get("1.2.3.4", []))
        self.assertEqual(unique, {"host.example"})

    def test_trailing_dot_collapses_to_one_distinct_host(self):
        """FQDN with trailing dot ('host.example.') and same host
        without ('HOST.example') must both count as the same bucket."""
        server.SCAN_PATTERN_THRESHOLD = 3
        server._record_deny_for_scan("1.2.3.4", "host.example")
        server._record_deny_for_scan("1.2.3.4", "HOST.example.")
        server._record_deny_for_scan("1.2.3.4", "  Host.Example.  ")
        with server._scan_pattern_lock:
            unique = set(h for _, h in server._scan_pattern.get("1.2.3.4", []))
        self.assertEqual(unique, {"host.example"})

    # ── memory bound: cleanup() prunes expired IPs ──

    def test_cleanup_prunes_expired_scan_pattern_entries(self):
        """`cleanup()` must drop any IP whose entire event list has
        aged out of the window — otherwise the dict grows for every
        unique attacker IP and never shrinks (slow leak proportional
        to attacker activity, the worst scaling profile)."""
        server.SCAN_PATTERN_THRESHOLD = 3
        server.SCAN_PATTERN_WINDOW = 60
        # Plant events from two IPs at virtual time t=1000.
        with unittest.mock.patch("server.time.time", return_value=1000.0):
            server._record_deny_for_scan("scanner-a", "h1")
            server._record_deny_for_scan("scanner-a", "h2")
            server._record_deny_for_scan("scanner-b", "h3")
        # Sanity: both IPs are present.
        with server._scan_pattern_lock:
            self.assertIn("scanner-a", server._scan_pattern)
            self.assertIn("scanner-b", server._scan_pattern)
        # Fast-forward past the window, then run cleanup. Both IPs'
        # events are now stale and the entries should disappear.
        with unittest.mock.patch("server.time.time", return_value=1100.0):
            server.cleanup()
        with server._scan_pattern_lock:
            self.assertNotIn("scanner-a", server._scan_pattern)
            self.assertNotIn("scanner-b", server._scan_pattern)

    def test_cleanup_keeps_fresh_scan_pattern_entries(self):
        """An IP with at least one in-window event must NOT be evicted
        by cleanup() — otherwise we lose live state mid-attack."""
        server.SCAN_PATTERN_THRESHOLD = 3
        server.SCAN_PATTERN_WINDOW = 60
        with unittest.mock.patch("server.time.time", return_value=1000.0):
            server._record_deny_for_scan("active", "h1")
        # Run cleanup at t=1030 — still inside the 60s window.
        with unittest.mock.patch("server.time.time", return_value=1030.0):
            server.cleanup()
        with server._scan_pattern_lock:
            self.assertIn("active", server._scan_pattern)


class TestPerIpSessionCount(unittest.TestCase):
    """Unit tests for the per-IP session-count helper."""

    def setUp(self):
        self._snapshot = dict(server.sessions)
        server.sessions.clear()

    def tearDown(self):
        server.sessions.clear()
        server.sessions.update(self._snapshot)

    def _fake(self, client_ip, is_background=False):
        s = type("_FakeS", (), {})()
        s.client_ip = client_ip
        s.is_background = is_background
        return s

    def test_empty_registry(self):
        self.assertEqual(server._per_ip_session_count("1.2.3.4"), 0)

    def test_counts_matching_ips(self):
        server.sessions["a"] = self._fake("1.2.3.4")
        server.sessions["b"] = self._fake("1.2.3.4")
        server.sessions["c"] = self._fake("9.9.9.9")
        self.assertEqual(server._per_ip_session_count("1.2.3.4"), 2)
        self.assertEqual(server._per_ip_session_count("9.9.9.9"), 1)
        self.assertEqual(server._per_ip_session_count("0.0.0.0"), 0)

    def test_counts_bg_and_fg_together(self):
        # The cap is anti-abuse, not anti-resource-class — count everything.
        server.sessions["a"] = self._fake("1.2.3.4", is_background=False)
        server.sessions["b"] = self._fake("1.2.3.4", is_background=True)
        self.assertEqual(server._per_ip_session_count("1.2.3.4"), 2)

    def test_session_without_client_ip_not_counted(self):
        s = type("_FakeS", (), {})()
        s.is_background = False
        # intentionally missing client_ip — getattr default None never matches
        server.sessions["a"] = s
        self.assertEqual(server._per_ip_session_count("1.2.3.4"), 0)

    def test_empty_or_none_ip_returns_zero(self):
        server.sessions["a"] = self._fake("1.2.3.4")
        self.assertEqual(server._per_ip_session_count(""), 0)
        self.assertEqual(server._per_ip_session_count(None), 0)


def _make_stub_session_cls(spawn_delay=0.0):
    """Build a fake SSHSession class for `server.SSHSession` patches.

    Real SSHSession `pty.fork()`s ssh and is the source of the
    `forkpty() may lead to deadlocks` DeprecationWarning when the
    HTTP test harness drives /api/connect from a multi-threaded
    server. Tests that exercise `_connect`'s success path don't care
    about the ssh side at all — they care about session-registry
    bookkeeping. This stub gives the success path the attributes it
    serializes (`alive`, `auth_failed`, `tmux_cmd`) plus the ones the
    cleanup/cap iteration reads (`client_ip`, `is_background`,
    `persistent`, `slot_id`, `is_expired`, `close`) and nothing else.

    `spawn_delay` lets the concurrency test widen the race window the
    cap is meant to close (the real spawn is wall-clock-slow; that's
    the reason the placeholder swap exists).
    """

    class _StubSession(object):

        def __init__(self, session_id, host, port, username, password,
                     cols, rows, key=None, ssh_options=None,
                     is_background=False, persistent=False, slot_id=None,
                     tmux_cmd="tmux", tmux_options=None, client_ip=None):
            if spawn_delay:
                time.sleep(spawn_delay)
            self.id = session_id
            self.client_ip = client_ip
            self.is_background = is_background
            # Mirror the real SSHSession: persistent only sticks if a
            # slot_id was provided. _connect's response reads the local
            # `persistent`/`slot_id` rather than ours, but be symmetric.
            self.persistent = bool(persistent and slot_id)
            self.slot_id = slot_id if self.persistent else None
            self.tmux_cmd = tmux_cmd
            self.alive = True
            self.auth_failed = False
            self.last_activity = time.time()

        def is_expired(self):
            return False

        def close(self):
            pass

    return _StubSession


class TestPerIpSessionCapHTTP(LiveServerCase):
    """Integration: per-IP cap returns 429 before reaching the SSH spawn.

    Plants fake session objects in the live registry and posts to
    /api/connect — the handler runs the gate inside `with sessions_lock:`
    so the count is observed atomically. The real SSHSession is replaced
    with a stub for the duration of the class so the success path
    doesn't pty.fork() ssh against `ignored.example` (which leaks file
    descriptors and emits a DeprecationWarning under multi-threaded
    test servers).
    """

    CONFIG = {"connections": []}

    def setUp(self):
        server._rate_limits.clear()
        self._sessions_snapshot = dict(server.sessions)
        server.sessions.clear()
        self._orig_cap = server.MAX_SESSIONS_PER_IP
        # Stub SSHSession so the success path doesn't pty.fork() ssh
        # against `ignored.example` (slow, leaks fds, fires the
        # forkpty() DeprecationWarning under a multi-threaded server).
        self._orig_session_cls = server.SSHSession
        server.SSHSession = _make_stub_session_cls()
        # CONNECT_SETTLE_TIME is a 0.5 s post-spawn sleep that
        # serializes the response. It exists to give real ssh a moment
        # before the client tries to read; with a stubbed Session it's
        # pure dead weight.
        self._orig_settle = server.CONNECT_SETTLE_TIME
        server.CONNECT_SETTLE_TIME = 0

    def tearDown(self):
        server.sessions.clear()
        server.sessions.update(self._sessions_snapshot)
        server.MAX_SESSIONS_PER_IP = self._orig_cap
        server.SSHSession = self._orig_session_cls
        server.CONNECT_SETTLE_TIME = self._orig_settle

    def _fake(self, client_ip):
        s = type("_FakeS", (), {})()
        s.client_ip = client_ip
        s.is_background = False
        s.persistent = False
        return s

    def _post(self, body):
        return LiveServerCase._post(self, "/api/connect", body)

    _PAYLOAD = {"host": "ignored.example", "username": "u",
                "password": "p", "cols": 80, "rows": 24}

    def _assert_connect_ok(self, body, code):
        """Success-path assertion: 200 + a real session_id we can lookup.

        Replaces the old one-sided `if code == 429: assertNotIn(...)`
        pattern, which silently passed when the gate dropped entirely
        or always passed.
        """
        self.assertEqual(
            code, 200,
            "expected 200 from connect, got {} body={}".format(code, body))
        sid = body.get("session_id", "")
        self.assertTrue(server._UUID_RE.match(sid),
                        "expected uuid session_id, got {!r}".format(sid))
        # Real (stubbed) Session was swapped in for the placeholder —
        # if the swap had been skipped, sessions[sid] would still be
        # the _SessionPlaceholder.
        self.assertIn(sid, server.sessions)
        self.assertNotIsInstance(server.sessions[sid],
                                 server._SessionPlaceholder)

    def test_cap_allows_at_or_below_limit(self):
        # 1 active session, cap is 2 → next connect must succeed (200)
        # and register a real session.
        server.MAX_SESSIONS_PER_IP = 2
        server.sessions["one"] = self._fake("127.0.0.1")
        body, code = self._post(self._PAYLOAD)
        self._assert_connect_ok(body, code)

    def test_cap_does_not_block_other_ips(self):
        # Two sessions from a different IP at cap=2 must NOT block
        # 127.0.0.1's connect.
        server.MAX_SESSIONS_PER_IP = 2
        for i in range(2):
            server.sessions["fake-{}".format(i)] = self._fake("9.9.9.9")
        body, code = self._post(self._PAYLOAD)
        self._assert_connect_ok(body, code)

    def test_cap_zero_disables_gate(self):
        # Cap 0 = disabled: even with 5 active sessions from this IP
        # the connect must succeed.
        server.MAX_SESSIONS_PER_IP = 0
        for i in range(5):
            server.sessions["fake-{}".format(i)] = self._fake("127.0.0.1")
        body, code = self._post(self._PAYLOAD)
        self._assert_connect_ok(body, code)

    def test_cap_at_exact_limit_blocks_one_more(self):
        # Boundary: with cap-1 fakes preloaded, the first request must
        # pass (count == cap-1 < cap, registers, count becomes cap) and
        # the second must hit the per-IP 429 (count == cap >= cap).
        # Verifies the gate's inequality direction is `>=` and not `>`.
        cap = 3
        server.MAX_SESSIONS_PER_IP = cap
        for i in range(cap - 1):
            server.sessions["fake-{}".format(i)] = self._fake("127.0.0.1")

        body1, code1 = self._post(self._PAYLOAD)
        self._assert_connect_ok(body1, code1)

        body2, code2 = self._post(self._PAYLOAD)
        self.assertEqual(
            code2, 429,
            "expected per-IP 429 on the second request, got {} body={}".format(
                code2, body2))
        self.assertIn("from your IP", body2.get("error", ""))


class TestPerIpSessionCapConcurrency(LiveServerCase):
    """Regression: per-IP cap must not be racy under concurrent connects.

    The original implementation released sessions_lock between the gate
    check and the registry insert, with the SSH spawn (wall-clock-slow)
    in the middle. N concurrent POSTs from the same IP all observed
    `count == cap-1`, all passed the gate, all spawned ssh, all
    inserted — final count = cap + N - 1.

    The fix reserves a counted slot (a `_SessionPlaceholder`) under the
    gate lock before spawning. Concurrent connects from the same IP
    observe the in-flight slots and trip the cap. We widen the spawn
    window via a stubbed SSHSession that sleeps 50 ms in __init__, then
    fire cap+5 concurrent POSTs and assert exactly `cap` succeed.
    """

    CONFIG = {"connections": []}

    def setUp(self):
        server._rate_limits.clear()
        self._sessions_snapshot = dict(server.sessions)
        server.sessions.clear()
        self._orig_cap = server.MAX_SESSIONS_PER_IP
        self._orig_settle = server.CONNECT_SETTLE_TIME
        # The settle sleep is post-spawn and serializes the response;
        # zero it so we don't wait 0.5s per request needlessly.
        server.CONNECT_SETTLE_TIME = 0
        # Allow plenty of rate-limit budget — we fire cap+5 in one
        # window. Default RATE_LIMIT_MAX is 50 which is fine, but be
        # explicit.
        self._orig_rate_max = server.RATE_LIMIT_MAX
        server.RATE_LIMIT_MAX = 100
        self._orig_session_cls = server.SSHSession
        # Reuse the HTTP-tests stub but with a 50 ms spawn_delay to
        # widen the race window the gate is meant to close.
        server.SSHSession = _make_stub_session_cls(spawn_delay=0.05)

    def tearDown(self):
        server.sessions.clear()
        server.sessions.update(self._sessions_snapshot)
        server.MAX_SESSIONS_PER_IP = self._orig_cap
        server.CONNECT_SETTLE_TIME = self._orig_settle
        server.RATE_LIMIT_MAX = self._orig_rate_max
        server.SSHSession = self._orig_session_cls

    def _post(self):
        # timeout=10: cap+5 concurrent connects with spawn_delay can
        # queue behind each other on a loaded box; the old fixture
        # deliberately doubled the default.
        body, code = LiveServerCase._post(
            self, "/api/connect",
            {"host": "ignored.example", "username": "u",
             "password": "p", "cols": 80, "rows": 24}, timeout=10)
        return code, body

    def test_concurrent_connects_respect_cap(self):
        from concurrent.futures import ThreadPoolExecutor
        cap = 3
        burst = cap + 5
        server.MAX_SESSIONS_PER_IP = cap

        with ThreadPoolExecutor(max_workers=burst) as pool:
            futures = [pool.submit(self._post) for _ in range(burst)]
            results = [f.result() for f in futures]

        codes = [code for code, _ in results]
        ok = [r for r in results if 200 <= r[0] < 300]
        rate_limited = [r for r in results
                        if r[0] == 429
                        and "from your IP" in r[1].get("error", "")]

        self.assertEqual(
            len(ok), cap,
            "expected exactly cap={} successful connects, got {} (codes: {})".format(
                cap, len(ok), codes))
        self.assertEqual(
            len(rate_limited), burst - cap,
            "expected exactly {} per-IP 429s, got {} (codes: {})".format(
                burst - cap, len(rate_limited), codes))
        # And no other failure modes — every response must have been
        # accounted for above.
        self.assertEqual(len(ok) + len(rate_limited), burst,
                         "unexpected response codes: {}".format(codes))


class TestPerIpMisconfigWarn(unittest.TestCase):
    """Issue 7: warn when MAX_SESSIONS_PER_IP is set so high it can
    never trip — the operator is paying the per-session inventory cost
    for a gate that's effectively dead code."""

    def setUp(self):
        self._orig_per_ip = server.MAX_SESSIONS_PER_IP
        self._orig_max = server.MAX_SESSIONS
        self._orig_bg = server.MAX_BG_SESSIONS

    def tearDown(self):
        server.MAX_SESSIONS_PER_IP = self._orig_per_ip
        server.MAX_SESSIONS = self._orig_max
        server.MAX_BG_SESSIONS = self._orig_bg

    def test_warns_when_at_or_above_global_max(self):
        server.MAX_SESSIONS = 50
        server.MAX_BG_SESSIONS = 50
        server.MAX_SESSIONS_PER_IP = 50  # exactly at the threshold
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_per_ip_misconfig()
        self.assertTrue(mock_log.called)
        level, msg = mock_log.call_args[0][0], mock_log.call_args[0][1]
        self.assertEqual(level, "WARN")
        self.assertIn("MAX_SESSIONS_PER_IP=50", msg)
        self.assertIn("never", msg.lower())

    def test_warns_when_above_global_max(self):
        server.MAX_SESSIONS = 30
        server.MAX_BG_SESSIONS = 20
        server.MAX_SESSIONS_PER_IP = 100
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_per_ip_misconfig()
        self.assertTrue(mock_log.called)
        self.assertEqual(mock_log.call_args[0][0], "WARN")

    def test_silent_when_strictly_below_global_max(self):
        server.MAX_SESSIONS = 50
        server.MAX_BG_SESSIONS = 50
        server.MAX_SESSIONS_PER_IP = 5
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_per_ip_misconfig()
        self.assertFalse(
            mock_log.called,
            "no WARN expected for a normally-configured per-IP cap")

    def test_silent_when_disabled(self):
        # 0 is the documented "off" sentinel — must not warn.
        server.MAX_SESSIONS = 50
        server.MAX_BG_SESSIONS = 50
        server.MAX_SESSIONS_PER_IP = 0
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_per_ip_misconfig()
        self.assertFalse(mock_log.called)

    def test_threshold_uses_max_of_global_caps(self):
        # If MAX_SESSIONS is small but MAX_BG_SESSIONS is large, the
        # threshold is the larger of the two — only above that does
        # the per-IP cap become dead.
        server.MAX_SESSIONS = 10
        server.MAX_BG_SESSIONS = 100
        # Below the larger cap → no warn.
        server.MAX_SESSIONS_PER_IP = 50
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_per_ip_misconfig()
        self.assertFalse(mock_log.called)
        # At the larger cap → warn.
        server.MAX_SESSIONS_PER_IP = 100
        with unittest.mock.patch.object(server, "_log") as mock_log:
            server._warn_per_ip_misconfig()
        self.assertTrue(mock_log.called)


# ── Input validation regexes (slot_id, tmux_cmd) ───────────────────────
# These guard the remote ssh command string, so any hole here is a
# potential RCE on the target. Tests the regex in isolation and then the
# HTTP layer in TestHTTPApi below.


class TestAuthFailPatterns(unittest.TestCase):

    def _hit(self, text):
        t = text.lower()
        return any(p in t for p in server.AUTH_FAIL_PATTERNS)

    def test_permission_denied(self):
        self.assertTrue(self._hit(
            "Permission denied, please try again."))

    def test_permission_denied_uppercase(self):
        self.assertTrue(self._hit("PERMISSION DENIED"))

    def test_authentication_failed(self):
        self.assertTrue(self._hit("ssh: Authentication failed"))

    def test_access_denied(self):
        self.assertTrue(self._hit("Access denied for user"))

    def test_too_many_auth_failures(self):
        self.assertTrue(self._hit(
            "Received disconnect from 1.2.3.4: Too many "
            "authentication failures"))

    def test_benign_login_banner(self):
        self.assertFalse(self._hit(
            "Welcome to Ubuntu 24.04.1 LTS\nLast login: Tue Apr 15"))

    def test_benign_shell_prompt(self):
        self.assertFalse(self._hit("user@host:~$ "))


# ── SSHSession idle-timer semantics ────────────────────────────────────
# After the fix, SSHSession.read() only bumps last_activity on non-empty
# reads. Previously every call (~100/s during long-poll) reset it and
# defeated the server-side idle timeout.


class TestConnectValidation(LiveServerCase):

    # No restrict_hosts, no connections — tests only exercise the
    # early-validation codepath.
    CONFIG = {"connections": []}

    def setUp(self):
        # Rate limiter is process-global; clear it between tests so a
        # handful of POSTs don't exhaust the budget.
        server._rate_limits.clear()

    def test_persistent_without_slot_id_rejected(self):
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "u", "password": "p",
            "persistent": True, "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("slot_id", body["error"])

    def test_slot_id_with_shell_chars_rejected(self):
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "u", "password": "p",
            "persistent": True, "slot_id": "a;rm -rf /",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("slot_id", body["error"])

    def test_slot_id_too_long_rejected(self):
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "u", "password": "p",
            "persistent": True, "slot_id": "a" * 65,
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)

    def test_resume_slot_id_implies_persistent(self):
        """resume_slot_id alone must trigger the slot_id validator."""
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "u", "password": "p",
            "resume_slot_id": "bad id with spaces",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("slot_id", body["error"])

    def test_tmux_cmd_with_shell_chars_rejected(self):
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "u", "password": "p",
            "persistent": True, "slot_id": "ok",
            "tmux_cmd": "tmux; cat /etc/shadow",
            "cols": 80, "rows": 24
        })
        self.assertEqual(code, 400)
        self.assertIn("tmux_cmd", body["error"])

    def test_tmux_cmd_valid_absolute_accepted(self):
        """Valid tmux_cmd passes validation; later failure is fine."""
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "u", "password": "p",
            "persistent": True, "slot_id": "ok",
            "tmux_cmd": "/usr/local/bin/tmux",
            "cols": 80, "rows": 24
        })
        # Connect may fail downstream (no real ssh target), but must NOT
        # fail validation.
        self.assertNotEqual(code, 400)

    def test_non_persistent_ignores_slot_id(self):
        """Without persistent flag, any slot_id value is ignored."""
        body, code = self._post("/api/connect", {
            "host": "example.com", "username": "u", "password": "p",
            "slot_id": "anything goes ;$`",
            "cols": 80, "rows": 24
        })
        # Not 400 from slot_id validator — request proceeds to spawn.
        self.assertNotEqual(code, 400)


# ── _build_remote_command (TTL watchdog) ───────────────────────────────


class TestBuildRemoteCommand(unittest.TestCase):
    """Static tests for the remote shell command that ssh runs on the
    target to create-or-attach a persistent tmux session, with and
    without the idle-TTL watchdog."""

    def _sh_syntax_ok(self, script):
        """Return (ok, stderr). Runs `sh -n` — parses but does not
        execute the script. Catches quoting errors and other syntax
        bugs in the generated string without actually spawning tmux."""
        r = subprocess.run(
            ["sh", "-n"], input=script, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        return r.returncode == 0, r.stderr

    def test_ttl_zero_returns_plain_exec(self):
        cmd = server._build_remote_command("alice", "tmux", 0)
        self.assertEqual(
            cmd,
            'exec tmux new-session -A -D -s websh-alice -- "$SHELL" -l'
            ' \\; set -g mouse on'
            ' \\; set -g status off')

    def test_ttl_negative_treated_as_disabled(self):
        # The _build function is called with TMUX_IDLE_TTL which is
        # already clamped, but defensive behavior matters if a caller
        # passes a raw value.
        cmd = server._build_remote_command("alice", "tmux", -1)
        self.assertNotIn("kill-session", cmd)
        self.assertNotIn("watchdog", cmd.lower())

    def test_ttl_positive_spawns_watchdog_and_exec_attach(self):
        cmd = server._build_remote_command("alice", "tmux", 3600)
        # The watchdog is spawned in the background, then we exec tmux.
        self.assertIn("nohup sh -c", cmd)
        self.assertIn("kill-session -t websh-alice", cmd)
        self.assertIn("-ge 3600", cmd)  # the TTL comparison
        # Ends with the exec so the login shell doesn't linger.
        self.assertTrue(cmd.rstrip().endswith(
            'exec tmux new-session -A -D -s websh-alice -- "$SHELL" -l'
            ' \\; set -g mouse on'
            ' \\; set -g status off'))

    def test_status_off_baked_into_command(self):
        """tmux's status bar is hidden by default — every command must
        include `set -g status off` regardless of options passed in,
        and must never include a later `set -g status on` that could
        win on tmux's last-write-wins option semantics."""
        for tmux_options in (None, [], [("set-clipboard", "off")]):
            for ttl in (0, 3600):
                cmd = server._build_remote_command(
                    "ok", "tmux", ttl, tmux_options=tmux_options)
                self.assertIn(' \\; set -g status off', cmd,
                    "missing baked-in `status off` for "
                    "tmux_options=%r, ttl=%d" % (tmux_options, ttl))
                self.assertNotIn(' \\; set -g status on', cmd,
                    "stray `status on` would override the baseline "
                    "for tmux_options=%r, ttl=%d" % (tmux_options, ttl))

    def test_ttl_uses_session_last_attached(self):
        """Watchdog must read session_last_attached so reconnects reset
        the clock automatically (tmux updates it on attach)."""
        cmd = server._build_remote_command("ok", "tmux", 3600)
        self.assertIn("session_last_attached", cmd)
        self.assertIn("session_attached", cmd)

    def test_ttl_resets_on_every_connect(self):
        """The orchestration shell stamps the seen-file before
        spawning, so even a reconnect that finds an existing watchdog
        still pushes the deadline forward."""
        cmd = server._build_remote_command("ok", "tmux", 3600)
        # First non-whitespace statement must be the seen-file stamp.
        first_line = cmd.lstrip().split("\n", 1)[0]
        self.assertIn("date +%s", first_line)
        self.assertIn(".websh-ttl-ok.seen", first_line)

    def test_ttl_resets_while_attached(self):
        """Watchdog must refresh the seen-file whenever it sees
        att > 0. Without this a user who stays attached longer than
        TTL would be killed seconds after detaching."""
        cmd = server._build_remote_command("ok", "tmux", 3600)
        # The watchdog body contains a refresh of the seen-file gated
        # on the attached-client count being non-zero.
        self.assertIn('if [ "$att" != 0 ]; then date +%s >', cmd)

    def test_ttl_idempotent_via_pidfile(self):
        """Back-to-back connects must not stack watchdogs; the pidfile
        + `kill -0` gate is how we enforce that."""
        cmd = server._build_remote_command("ok", "tmux", 3600)
        self.assertIn(".websh-ttl-ok.pid", cmd)
        self.assertIn("kill -0", cmd)

    def test_custom_tmux_cmd_used_everywhere(self):
        cmd = server._build_remote_command(
            "ok", "/usr/local/bin/tmux", 3600)
        # Must use the custom path in all tmux invocations, including
        # inside the watchdog loop. Count > 1 because of has-session,
        # display, kill-session, and the final attach.
        self.assertGreaterEqual(cmd.count("/usr/local/bin/tmux"), 4)
        # And never the bare word `tmux ` (space-terminated) — would
        # indicate a hardcoded fallback leaking through.
        self.assertNotIn(" tmux ", " " + cmd)

    def test_sh_syntax_valid_ttl_zero(self):
        ok, err = self._sh_syntax_ok(
            server._build_remote_command("slot_1", "tmux", 0))
        self.assertTrue(ok, "sh -n rejected ttl=0 command: " + err)

    def test_sh_syntax_valid_ttl_positive(self):
        ok, err = self._sh_syntax_ok(
            server._build_remote_command("slot_1", "tmux", 86400))
        self.assertTrue(ok, "sh -n rejected ttl=86400 command: " + err)

    def test_sh_syntax_valid_with_path_tmux(self):
        ok, err = self._sh_syntax_ok(
            server._build_remote_command(
                "slot_1", "/usr/local/bin/tmux", 86400))
        self.assertTrue(ok, "sh -n rejected custom tmux path: " + err)

    def test_watchdog_body_has_no_single_quotes(self):
        """The watchdog body is embedded inside `nohup sh -c '...'`.
        A single quote inside would close the wrapper early. Keep this
        guarantee pinned so future edits don't silently break it."""
        cmd = server._build_remote_command("ok", "tmux", 3600)
        # Extract the body between the first `sh -c '` and the
        # closing `'` before the stderr redirection.
        start = cmd.index("sh -c '") + len("sh -c '")
        end = cmd.index("' >/dev/null 2>&1")
        body = cmd[start:end]
        self.assertNotIn("'", body)

    def test_watchdog_loop_exits_when_session_dies(self):
        """Watchdog must not outlive the tmux session it's guarding —
        otherwise [x] would terminate tmux but the watchdog would keep
        polling forever."""
        cmd = server._build_remote_command("ok", "tmux", 3600)
        self.assertIn("has-session -t websh-ok 2>/dev/null || exit", cmd)

    def test_tmux_options_chained_after_new_session(self):
        """Per-connect tmux options are tacked onto the same `tmux …`
        invocation via `\\;`, so they apply to the global tmux server
        whether the session was newly created or re-attached. `set -g
        mouse on` is part of the baseline (hardcoded, not via the
        options list) so the chain starts with it before user options."""
        cmd = server._build_remote_command(
            "ok", "tmux", 0,
            tmux_options=[("set-clipboard", "on"),
                          ("history-limit", "100000")])
        self.assertIn(
            'new-session -A -D -s websh-ok -- "$SHELL" -l'
            ' \\; set -g mouse on'
            ' \\; set -g status off'
            ' \\; set -g set-clipboard on'
            ' \\; set -g history-limit 100000',
            cmd)

    def test_mouse_on_baked_into_command(self):
        """Mouse is hardcoded on the server side — every command must
        include `set -g mouse on` regardless of options passed in,
        and must never include a later `set -g mouse off` that could
        win on tmux's last-write-wins option semantics."""
        for tmux_options in (None, [], [("set-clipboard", "off")]):
            for ttl in (0, 3600):
                cmd = server._build_remote_command(
                    "ok", "tmux", ttl, tmux_options=tmux_options)
                self.assertIn(' \\; set -g mouse on', cmd,
                    "missing baked-in mouse on for "
                    "tmux_options=%r, ttl=%d" % (tmux_options, ttl))
                self.assertNotIn(' \\; set -g mouse off', cmd,
                    "stray `mouse off` would override the baseline "
                    "for tmux_options=%r, ttl=%d" % (tmux_options, ttl))

    def test_tmux_options_none_leaves_command_unchanged(self):
        baseline = server._build_remote_command("ok", "tmux", 0)
        self.assertEqual(
            server._build_remote_command("ok", "tmux", 0, tmux_options=None),
            baseline)
        self.assertEqual(
            server._build_remote_command("ok", "tmux", 0, tmux_options=[]),
            baseline)

    def test_tmux_options_sh_syntax_valid_with_ttl(self):
        ok, err = self._sh_syntax_ok(server._build_remote_command(
            "ok", "tmux", 86400,
            tmux_options=[("set-clipboard", "off"),
                          ("history-limit", "50000")]))
        self.assertTrue(ok, "sh -n rejected with tmux_options: " + err)


# ── _validate_tmux_options ─────────────────────────────────────────────


class TestFilterSshOptions(unittest.TestCase):
    """Allow-list for `ssh -o` options coming from websh.json. Keys not
    on the list (ProxyCommand, LocalCommand, Include, KnownHostsCommand,
    IdentityAgent, …) are dropped — they turn an editable config into
    RCE on the websh host."""

    def test_safe_keys_pass(self):
        opts = {"StrictHostKeyChecking": "yes", "ProxyJump": "bastion",
                "UserKnownHostsFile": "/home/x/.ssh/k",
                "ServerAliveInterval": "30"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, opts)
        self.assertEqual(dropped, [])

    def test_auth_method_toggles_pass(self):
        """Boolean / integer auth-method controls have no exec surface
        and operators reach for them regularly (force key-only on prod,
        force password-only on a legacy box). Allow them through."""
        opts = {"BatchMode": "yes",
                "PasswordAuthentication": "no",
                "PubkeyAuthentication": "yes",
                "KbdInteractiveAuthentication": "no",
                "NumberOfPasswordPrompts": "1"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, opts)
        self.assertEqual(dropped, [])

    def test_identity_file_pass(self):
        """IdentityFile points at a key file ssh opens and parses; an
        attacker-controlled path can at worst trigger a parse failure
        (= auth failure, not RCE). Allow it — operators reach for it
        when one config has multiple per-host keys."""
        opts = {"IdentityFile": "/home/deploy/.ssh/id_prod"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, opts)
        self.assertEqual(dropped, [])

    def test_proxy_command_dropped(self):
        opts = {"ProxyCommand": "evil-script"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, {})
        self.assertEqual(dropped, ["ProxyCommand"])

    def test_local_command_dropped(self):
        opts = {"LocalCommand": "id", "PermitLocalCommand": "yes"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, {})
        self.assertEqual(sorted(dropped),
                         ["LocalCommand", "PermitLocalCommand"])

    def test_include_and_match_dropped(self):
        opts = {"Include": "/etc/ssh/evil.conf",
                "Match": "exec /tmp/evil"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, {})
        self.assertEqual(sorted(dropped), ["Include", "Match"])

    def test_known_hosts_command_dropped(self):
        opts = {"KnownHostsCommand": "/tmp/evil"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, {})

    def test_identity_agent_dropped(self):
        opts = {"IdentityAgent": "/tmp/evil.sock"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, {})

    def test_case_insensitive(self):
        opts = {"stricthostkeychecking": "yes", "PROXYJUMP": "b",
                "ProxyJUMP": "c"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, opts)
        self.assertEqual(dropped, [])

    def test_mixed_pass_and_drop(self):
        opts = {"StrictHostKeyChecking": "yes", "ProxyCommand": "evil",
                "ConnectTimeout": "10"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, {"StrictHostKeyChecking": "yes",
                                    "ConnectTimeout": "10"})
        self.assertEqual(dropped, ["ProxyCommand"])

    def test_non_string_key_dropped(self):
        opts = {None: "x", 5: "y", "StrictHostKeyChecking": "yes"}
        filtered, dropped = server._filter_ssh_options(opts)
        self.assertEqual(filtered, {"StrictHostKeyChecking": "yes"})
        # Non-string keys come back through repr() so the WARN message
        # never crashes on the join.
        self.assertEqual(sorted(dropped), ["5", "None"])

    def test_empty_inputs(self):
        self.assertEqual(server._filter_ssh_options({}), ({}, []))
        self.assertEqual(server._filter_ssh_options(None), ({}, []))


class TestBuildSshCommand(unittest.TestCase):
    """Final ssh argv assembly. OpenSSH keeps the first value for many
    repeated `-o` options, so allow-list tests alone are not enough."""

    def _session(self, ssh_options=None, persistent=False):
        s = server.SSHSession.__new__(server.SSHSession)
        s._ssh_options, _ = server._filter_ssh_options(ssh_options or {})
        s._key_file = None
        s._control_path = "/tmp/websh-test.sock"
        s.persistent = persistent
        s.slot_id = "slot" if persistent else None
        s.tmux_cmd = "tmux"
        s._tmux_options = []
        return s

    def _option_values(self, cmd, key):
        prefix = key.lower() + "="
        vals = []
        for i, part in enumerate(cmd[:-1]):
            if part == "-o" and cmd[i + 1].lower().startswith(prefix):
                vals.append(cmd[i + 1].split("=", 1)[1])
        return vals

    def test_default_disables_host_key_checks_and_known_hosts_writes(self):
        cmd = self._session()._build_ssh_cmd("example.com", 22, "alice")
        self.assertEqual(self._option_values(cmd, "StrictHostKeyChecking"),
                         ["no"])
        self.assertEqual(self._option_values(cmd, "UserKnownHostsFile"),
                         ["/dev/null"])

    def test_profile_strict_host_key_checking_replaces_default(self):
        cmd = self._session({
            "StrictHostKeyChecking": "yes",
        })._build_ssh_cmd("example.com", 22, "alice")
        self.assertEqual(self._option_values(cmd, "StrictHostKeyChecking"),
                         ["yes"])
        self.assertEqual(self._option_values(cmd, "UserKnownHostsFile"), [])

    def test_profile_known_hosts_file_replaces_devnull_default(self):
        cmd = self._session({
            "StrictHostKeyChecking": "yes",
            "UserKnownHostsFile": "/home/alice/.ssh/known_hosts",
        })._build_ssh_cmd("example.com", 22, "alice")
        self.assertEqual(
            self._option_values(cmd, "UserKnownHostsFile"),
            ["/home/alice/.ssh/known_hosts"])

    def test_profile_timeout_replaces_default(self):
        cmd = self._session({
            "ConnectTimeout": "30",
        })._build_ssh_cmd("example.com", 22, "alice")
        self.assertEqual(self._option_values(cmd, "ConnectTimeout"), ["30"])


class TestRestrictHostsDoesNotFeedScanPattern(LiveServerCase):
    """Integration: under restrict_hosts: true, a manual /api/connect
    is rejected because the policy disallows free-form connects (use a
    named connection), NOT because the target was on the deny-list. So
    the scan-pattern detector must NOT count those rejections — a
    buggy or stale UI POSTing `host` instead of `connection` from one
    legitimate IP could otherwise rapidly accumulate to a ban."""

    CONFIG = {
        "restrict_hosts": True,
        "denied_hosts": [],
        "connections": [],
    }

    def setUp(self):
        # Generous rate-limit budget so 100 POSTs all reach the
        # is_host_allowed gate (the bit we actually want to test).
        server._rate_limits.clear()
        with server._scan_pattern_lock:
            self._snap = dict(server._scan_pattern)
            server._scan_pattern.clear()
        self._orig_threshold = server.SCAN_PATTERN_THRESHOLD
        self._orig_window = server.SCAN_PATTERN_WINDOW
        self._orig_rate_max = server.RATE_LIMIT_MAX
        # Threshold low enough that the test would fire if the bug
        # were present (probing 100 distinct hosts > 5).
        server.SCAN_PATTERN_THRESHOLD = 5
        server.SCAN_PATTERN_WINDOW = 300
        server.RATE_LIMIT_MAX = 1000
        self.logfile = tempfile.NamedTemporaryFile(
            mode="w", suffix=".log", delete=False)
        self.logfile.close()
        self._orig_path = server.ACCESS_LOG_PATH
        server.ACCESS_LOG_PATH = self.logfile.name

    def tearDown(self):
        server.ACCESS_LOG_PATH = self._orig_path
        os.unlink(self.logfile.name)
        with server._scan_pattern_lock:
            server._scan_pattern.clear()
            server._scan_pattern.update(self._snap)
        server.SCAN_PATTERN_THRESHOLD = self._orig_threshold
        server.SCAN_PATTERN_WINDOW = self._orig_window
        server.RATE_LIMIT_MAX = self._orig_rate_max
        server._rate_limits.clear()

    def _read_records(self):
        with open(self.logfile.name, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def _post_connect(self, body):
        return self._post("/api/connect", body)

    def test_restrict_hosts_does_not_feed_scan_pattern(self):
        """100 raw manual /api/connect POSTs from one IP, each to a
        different host, must all reject as deny_blocked but must NOT
        produce any scan_pattern records — restrict_hosts: true is a
        policy mismatch, not a deny-list hit."""
        for i in range(100):
            _, code = self._post_connect({
                "host": "host{}.example".format(i),
                "username": "u", "password": "p",
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 403)
        recs = self._read_records()
        # All 100 deny_blocked records present (operator visibility):
        deny = [r for r in recs
                if r["event"] == "connect" and r["result"] == "deny_blocked"]
        self.assertEqual(len(deny), 100)
        # But zero scan_pattern records — that's the whole point.
        scan = [r for r in recs
                if r["event"] == "connect" and r["result"] == "scan_pattern"]
        self.assertEqual(scan, [],
                         "restrict_hosts must not feed scan-pattern: {}"
                         .format(scan))


if __name__ == "__main__":
    unittest.main()
