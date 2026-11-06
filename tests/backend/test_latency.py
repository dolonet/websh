#!/usr/bin/env python3
"""Typing-latency measurements in the server log (latency spec,
2026-10-25). Written from the spec, not from the code.

The owner reports "regular delays in what I typed"; nothing records how
long a keystroke takes or which stage is slow. Two log lines answer it:

  client_lat  - the page's report (POST /api/client_lat, ?action=client_lat):
                one line, [INFO] (or [WARN] when a pane's total p90 > 300 ms
                or its worst total > 1000 ms), every field sanitised like
                client_diag; 400 for a malformed body, nothing logged;
                rate-limited per IP (~30 per 10 min, 429 beyond); allowed
                inside the sealed channel.
  input_lat   - the server's own per-session summary for every session that
                received input in the window (5 minutes): srv (handler ->
                PTY write) and pty (PTY write -> next PTY read, within 2 s).

Log format assumed by these tests (the spec fixes the field names; the
layout below is what they parse, and it is what the report to the
implementer asks for):

  client_lat window_ms=N vis=W panes=N [sid=W mode=W sealed=0|1 n=N
      n_echo=N slow=N queue p50/p90/max=a/b/c rtt p50/p90/max=a/b/c
      echo p50/p90/max=... paint p50/p90/max=... total p50/p90/max=...
      worst queue/rtt/echo/paint/total=a/b/c/d/e inflight_max=N] [sid=...]
  input_lat sid=W n=N srv p50/p90/max=a/b/c pty p50/p90/max=a/b/c pty_n=N

(`name=a/b/c` without the "p50/p90/max" label is accepted too; panes
are found by their `sid=`, brackets optional.)

Test-only hooks the server must provide (module globals of server.py):
  INPUT_LAT_WINDOW   seconds per input_lat window (default 300)
  input_lat_flush()  emit the input_lat line of every session that received
                     input since the previous emission, and start a new
                     window for all of them
  cleanup()          (exists) emits the summaries once INPUT_LAT_WINDOW has
                     passed since the previous emission
"""

import json
import os
import re
import shutil
import tempfile
import time
import unittest
import unittest.mock

from tests.backend._base import LiveServerCase
from tests.backend.test_sealed import (FAKE_SSH, NEEDS_CRYPTO, SealedClient)
import server


# ── parsing what was logged ──────────────────────────────────────────

def _segments(msg):
    """(top-level text, [one text per pane]) - panes split at `sid=`."""
    parts = re.split(r"(?=\bsid=)", msg)
    return parts[0], parts[1:]


def _word(seg, k):
    m = re.search(r"(?<![\w/])" + re.escape(k) + r"=([^\s\]]*)", seg)
    return m.group(1) if m else None


def _int(seg, k):
    v = _word(seg, k)
    return int(v) if v is not None and re.fullmatch(r"-?\d+", v) else None


def _stat(seg, k):
    m = re.search(r"(?<![\w/])" + re.escape(k)
                  + r"(?: p50/p90/max)?=(-?\d+)/(-?\d+)/(-?\d+)\b", seg)
    return tuple(int(x) for x in m.groups()) if m else None


def _worst(seg):
    m = re.search(r"(?<![\w/])worst(?: queue/rtt/echo/paint/total)?="
                  r"(-?\d+)/(-?\d+)/(-?\d+)/(-?\d+)/(-?\d+)\b", seg)
    return tuple(int(x) for x in m.groups()) if m else None


def _bool(seg, k):
    v = _word(seg, k)
    if v in ("1", "true", "True", "yes"):
        return True
    if v in ("0", "false", "False", "no"):
        return False
    return None


STAGES = ("queue", "rtt", "echo", "paint", "total")


def _stats(p50, p90, mx):
    return {"p50": p50, "p90": p90, "max": mx}


def good_pane(**over):
    p = {"sid": "a1b2c3d4", "mode": "sse", "sealed": False, "n": 42,
         "n_echo": 40, "slow": 3,
         "queue": _stats(1, 4, 30), "rtt": _stats(35, 80, 400),
         "echo": _stats(60, 120, 700), "paint": _stats(8, 16, 90),
         "total": _stats(75, 150, 820),
         "worst": {"queue": 30, "rtt": 400, "echo": 700, "paint": 90,
                   "total": 820},
         "inflight_max": 2}
    p.update(over)
    return p


def good_body(**over):
    b = {"window_ms": 300000, "vis": "visible", "panes": [good_pane()]}
    b.update(over)
    return b


class _LogCapture(object):
    """server._log replaced by a recorder (level, msg)."""

    def __init__(self, case):
        self.lines = []
        p = unittest.mock.patch.object(server, "_log",
                                       side_effect=lambda lv, m: self.lines.append((lv, m)))
        p.start()
        case.addCleanup(p.stop)

    def named(self, name):
        return [(lv, m) for lv, m in self.lines
                if re.match(r"^" + name + r"\b", m)]


_ip_n = [0]


def _fresh_ip():
    """A private client IP per test (the server trusts X-Forwarded-For
    from 127.0.0.1), so one test's rate-limit budget is not another's."""
    _ip_n[0] += 1
    return "10.77.{}.{}".format(_ip_n[0] // 250, _ip_n[0] % 250 + 1)


# ═════════════════════════════════════════════════════════════════════
# /api/client_lat

class TestClientLatEndpoint(LiveServerCase):

    def setUp(self):
        self.log = _LogCapture(self)
        self.ip = _fresh_ip()

    def post(self, body, path="/api/client_lat", ctype="application/json",
             ip=None, raw=None):
        data = raw if raw is not None else json.dumps(body).encode("utf-8")
        return self._request_raw(path, data=data, method="POST",
                                 headers={"Content-Type": ctype,
                                          "X-Forwarded-For": ip or self.ip})

    def one_line(self):
        got = self.log.named("client_lat")
        self.assertEqual(len(got), 1, "exactly one client_lat line; log: %r"
                         % self.log.lines)
        return got[0]

    # -- the line and what is in it --

    def test_report_is_one_info_line_with_every_field(self):
        st, body = self.post(good_body())
        self.assertEqual(st, 200, body[:200])
        self.assertEqual(json.loads(body.decode()).get("ok"), True, body[:200])
        lv, msg = self.one_line()
        self.assertEqual(lv, "INFO", msg)
        self.assertNotIn("\n", msg)
        top, panes = _segments(msg)
        self.assertEqual(_int(top, "window_ms"), 300000, msg)
        self.assertEqual(_word(top, "vis"), "visible", msg)
        self.assertEqual(len(panes), 1, msg)
        p = panes[0]
        self.assertEqual(_word(p, "sid"), "a1b2c3d4", msg)
        self.assertEqual(_word(p, "mode"), "sse", msg)
        self.assertIs(_bool(p, "sealed"), False, msg)
        self.assertEqual(_int(p, "n"), 42, msg)
        self.assertEqual(_int(p, "n_echo"), 40, msg)
        self.assertEqual(_int(p, "slow"), 3, msg)
        self.assertEqual(_int(p, "inflight_max"), 2, msg)
        self.assertEqual(_stat(p, "queue"), (1, 4, 30), msg)
        self.assertEqual(_stat(p, "rtt"), (35, 80, 400), msg)
        self.assertEqual(_stat(p, "echo"), (60, 120, 700), msg)
        self.assertEqual(_stat(p, "paint"), (8, 16, 90), msg)
        self.assertEqual(_stat(p, "total"), (75, 150, 820), msg)
        self.assertEqual(_worst(p), (30, 400, 700, 90, 820), msg)

    def test_action_query_form_reaches_the_same_handler(self):
        st, body = self.post(good_body(), path="/api.php?action=client_lat")
        self.assertEqual(st, 200, body[:200])
        self.one_line()

    def test_text_plain_body_is_accepted(self):
        # sendBeacon at pagehide sends a string, i.e. text/plain.
        st, body = self.post(good_body(), ctype="text/plain;charset=UTF-8")
        self.assertEqual(st, 200, body[:200])
        self.one_line()

    def test_sealed_true_is_logged_as_true(self):
        self.post(good_body(panes=[good_pane(sealed=True, mode="poll")]))
        _, msg = self.one_line()
        p = _segments(msg)[1][0]
        self.assertIs(_bool(p, "sealed"), True, msg)
        self.assertEqual(_word(p, "mode"), "poll", msg)

    def test_several_panes_each_logged(self):
        self.post(good_body(panes=[good_pane(sid="aaaa1111"),
                                   good_pane(sid="bbbb2222", n=7)]))
        _, msg = self.one_line()
        panes = _segments(msg)[1]
        self.assertEqual([_word(p, "sid") for p in panes],
                         ["aaaa1111", "bbbb2222"], msg)
        self.assertEqual(_int(panes[1], "n"), 7, msg)

    def test_missing_and_unknown_fields_are_minus_one(self):
        self.post({"panes": [{"sid": "a1b2c3d4"}]})
        _, msg = self.one_line()
        top, panes = _segments(msg)
        self.assertEqual(_int(top, "window_ms"), -1, msg)
        p = panes[0]
        for k in ("n", "n_echo", "slow", "inflight_max"):
            self.assertEqual(_int(p, k), -1, (k, msg))
        for k in STAGES:
            self.assertEqual(_stat(p, k), (-1, -1, -1), (k, msg))
        self.assertEqual(_worst(p), (-1, -1, -1, -1, -1), msg)

    def test_wrong_types_are_minus_one(self):
        self.post(good_body(window_ms="300000", panes=[good_pane(
            n="42", rtt={"p50": "35", "p90": None, "max": [1]},
            worst="slow", total=[1, 2, 3])]))
        _, msg = self.one_line()
        top, panes = _segments(msg)
        self.assertEqual(_int(top, "window_ms"), -1, msg)
        p = panes[0]
        self.assertEqual(_int(p, "n"), -1, msg)
        self.assertEqual(_stat(p, "rtt"), (-1, -1, -1), msg)
        self.assertEqual(_stat(p, "total"), (-1, -1, -1), msg)
        self.assertEqual(_worst(p), (-1, -1, -1, -1, -1), msg)

    def test_numbers_are_clamped_integers(self):
        self.post(good_body(window_ms=1e300, panes=[good_pane(
            n=-500, slow=float("nan"), rtt=_stats(12.7, 1e40, -3))]))
        _, msg = self.one_line()
        top, panes = _segments(msg)
        wm = _int(top, "window_ms")
        self.assertIsNotNone(wm, "window_ms is an integer: " + msg)
        self.assertTrue(0 <= wm <= 10 ** 15, msg)
        p = panes[0]
        self.assertTrue(-1 <= _int(p, "n") <= 10 ** 15, msg)
        self.assertEqual(_int(p, "slow"), -1, "NaN -> -1: " + msg)
        rtt = _stat(p, "rtt")
        self.assertIsNotNone(rtt, "rtt as three integers: " + msg)
        self.assertIn(rtt[0], (12, 13), msg)
        self.assertTrue(rtt[1] <= 10 ** 15, msg)
        self.assertTrue(rtt[2] >= -1, msg)

    def test_words_and_ids_that_are_not_short_words_are_replaced(self):
        evil = "x\n2026-10-25T00:00:00 [ERROR] forged"
        self.post(good_body(vis="<script>alert(1)</script>", panes=[good_pane(
            sid=evil, mode="s se;rm -rf")]))
        _, msg = self.one_line()
        self.assertNotIn("\n", msg)
        self.assertNotIn("forged", msg)
        self.assertNotIn("<script>", msg)
        self.assertNotIn("rm -rf", msg)
        top, panes = _segments(msg)
        self.assertEqual(len(panes), 1, msg)
        self.assertNotIn("[ERROR]", msg)

    def test_sid_is_logged_as_given_short_word_only(self):
        full = "0123abcd-ffff-4eee-8ddd-0123456789ab"
        self.post(good_body(panes=[good_pane(sid=full)]))
        _, msg = self.one_line()
        self.assertNotIn(full, msg, "a full session id is not a short word")

    def test_no_free_text_is_logged(self):
        body = good_body(panes=[good_pane(data="SECRET-TYPED-ls", out="SECRET-OUT")],
                         err="SECRET-ERR", keys="SECRET-KEYS")
        self.post(body)
        _, msg = self.one_line()
        self.assertNotIn("SECRET", msg, "unknown fields never reach the log")

    def test_at_most_16_panes(self):
        panes = [good_pane(sid="p%07d" % i) for i in range(20)]
        st, _ = self.post(good_body(panes=panes))
        self.assertEqual(st, 200)
        _, msg = self.one_line()
        self.assertEqual(len(_segments(msg)[1]), 16, msg)

    def test_non_object_panes_are_skipped(self):
        self.post(good_body(panes=["x", 5, None, good_pane(sid="real0001")]))
        _, msg = self.one_line()
        sids = [_word(p, "sid") for p in _segments(msg)[1]]
        self.assertEqual(sids, ["real0001"], msg)

    def test_panes_not_a_list_still_logs_the_page_fields(self):
        st, _ = self.post({"window_ms": 1000, "vis": "hidden", "panes": "x"})
        self.assertEqual(st, 200)
        _, msg = self.one_line()
        top, panes = _segments(msg)
        self.assertEqual(panes, [], msg)
        self.assertEqual(_word(top, "vis"), "hidden", msg)

    # -- WARN threshold --

    def _level_for(self, p90, worst_total, other=None):
        panes = [good_pane(total=_stats(50, p90, worst_total),
                           worst={"queue": 1, "rtt": 2, "echo": 3, "paint": 4,
                                  "total": worst_total})]
        if other:
            panes.insert(0, other)
        self.log.lines.clear()
        st, _ = self.post(good_body(panes=panes))
        self.assertEqual(st, 200)
        return self.one_line()[0]

    def test_warn_when_total_p90_over_300(self):
        self.assertEqual(self._level_for(301, 400), "WARN")

    def test_info_at_exactly_300_and_1000(self):
        self.assertEqual(self._level_for(300, 1000), "INFO")

    def test_warn_when_worst_total_over_1000(self):
        self.assertEqual(self._level_for(100, 1001), "WARN")

    def test_warn_when_any_pane_is_slow(self):
        # The slow pane is the second one.
        self.assertEqual(self._level_for(900, 2000, other=good_pane(sid="fast0001")),
                         "WARN")

    def test_info_for_a_fast_page(self):
        self.assertEqual(self._level_for(120, 600), "INFO")

    def test_garbage_numbers_do_not_warn(self):
        # A string "9999" is not a number: -1, not a reason to warn.
        st, _ = self.post(good_body(panes=[good_pane(
            total={"p50": "9999", "p90": "9999", "max": "9999"},
            worst={"total": "9999"})]))
        self.assertEqual(st, 200)
        self.assertEqual(self.one_line()[0], "INFO")

    # -- refusals --

    def test_malformed_body_is_400_and_nothing_logged(self):
        for raw in (b"not json", b"[1,2,3]", b"\"str\"", b"", b"{\"panes\": [",
                    b"\xff\xfe\x00"):
            self.log.lines.clear()
            st, body = self.post(None, raw=raw)
            self.assertEqual(st, 400, (raw, st, body[:200]))
            self.assertEqual(self.log.named("client_lat"), [], raw)

    def test_body_over_16k_is_refused_and_nothing_logged(self):
        big = good_body(pad="x" * (16 * 1024 + 10))
        st, _ = self.post(big)
        self.assertIn(st, (400, 413), st)
        self.assertEqual(self.log.named("client_lat"), [])

    def test_body_of_16_full_panes_fits(self):
        panes = [good_pane(sid="p%07d" % i) for i in range(16)]
        raw = json.dumps(good_body(panes=panes)).encode()
        self.assertLess(len(raw), 16 * 1024)
        st, _ = self.post(None, raw=raw)
        self.assertEqual(st, 200)
        self.one_line()

    def test_rate_limited_per_ip(self):
        statuses = []
        for _ in range(40):
            st, _ = self.post(good_body())
            statuses.append(st)
        self.assertTrue(all(s == 200 for s in statuses[:30]),
                        "the first 30 in 10 minutes are logged: %r" % statuses)
        self.assertIn(429, statuses, "beyond ~30 per 10 minutes: 429; got %r"
                      % statuses)
        n200 = statuses.count(200)
        self.assertEqual(len(self.log.named("client_lat")), n200,
                         "a refused report is not logged")
        self.assertTrue(n200 <= 35, statuses)
        # Another IP is not affected.
        st, _ = self.post(good_body(), ip=_fresh_ip())
        self.assertEqual(st, 200, "the limit is per IP")

    def test_rate_limit_is_its_own_budget(self):
        # Many reports must not cost the IP its client_diag beacons or
        # connects, nor the other way round: the diag budget spent first.
        for _ in range(12):
            self._request_raw("/api/client_diag", data=b"{}", method="POST",
                              headers={"Content-Type": "application/json",
                                       "X-Forwarded-For": self.ip})
        st, _ = self.post(good_body())
        self.assertEqual(st, 200, "client_diag's limit is not client_lat's")


# ═════════════════════════════════════════════════════════════════════
# client_lat inside the sealed channel

@NEEDS_CRYPTO
class TestClientLatSealed(LiveServerCase):

    def setUp(self):
        self.log = _LogCapture(self)

    def test_allowed_inside_the_sealed_channel(self):
        c = SealedClient(self.port)
        self.assertEqual(c.open(), 200)
        r = c.post_json("client_lat", good_body(panes=[good_pane(sealed=True)]))
        self.assertEqual(r.outer_status, 200)
        self.assertEqual(r.status, 200, r.body[:200])
        got = self.log.named("client_lat")
        self.assertEqual(len(got), 1, self.log.lines)
        self.assertIs(_bool(_segments(got[0][1])[1][0], "sealed"), True, got)

    def test_malformed_inside_the_sealed_channel_is_400(self):
        c = SealedClient(self.port)
        self.assertEqual(c.open(), 200)
        r = c.request("client_lat", "POST", None, b"[nope")
        self.assertEqual(r.outer_status, 200)
        self.assertEqual(r.status, 400, r.body[:200])
        self.assertEqual(self.log.named("client_lat"), [])


# ═════════════════════════════════════════════════════════════════════
# input_lat: the server's own summary, from a real PTY

class TestInputLatSummary(LiveServerCase):
    """A real session: websh's PTY around a fake `ssh` that is an
    interactive /bin/sh (the same double as test_sealed.py), so the PTY,
    the read loop and the input handler under test are the real ones."""

    CONFIG = {"connections": [{"name": "target", "host": "target.example"}]}

    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp(prefix="websh-lat-")
        cls.home = os.path.join(cls.work, "home")
        os.makedirs(cls.home)
        bindir = os.path.join(cls.work, "bin")
        os.makedirs(bindir)
        p = os.path.join(bindir, "ssh")
        with open(p, "w") as f:
            f.write(FAKE_SSH)
        os.chmod(p, 0o755)
        cls.ENV = {"PATH": bindir + os.pathsep + os.environ.get("PATH", ""),
                   "FAKE_SSH_HOME": cls.home}
        cls._saved_env = {k: os.environ.get(k) for k in cls.ENV}
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        for k, v in cls._saved_env.items():
            if v is not None:
                os.environ[k] = v
        shutil.rmtree(cls.work, ignore_errors=True)

    def setUp(self):
        server._rate_limits.clear()
        self.log = _LogCapture(self)
        self.sid = self._connect()
        self.cursor = 0
        self._wait_output(b"$ ")
        # A clean window: whatever the connect produced is not ours.
        self._flush()
        self.log.lines.clear()

    def _connect(self):
        body, st = self._post("/api/connect", {
            "connection": "target", "username": "latuser",
            "password": "Pw-lat-1", "cols": 80, "rows": 24})
        self.assertEqual(st, 200, body)
        sid = body["session_id"]
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

    def _flush(self):
        fl = getattr(server, "input_lat_flush", None)
        self.assertTrue(callable(fl), "server.input_lat_flush() is the test hook "
                        "that emits the input_lat summaries now")
        fl()

    def _out(self):
        s = server.sessions[self.sid]
        with s.buf_lock:
            return bytes(s.output_buf)

    def _wait_output(self, needle, timeout=10):
        deadline = time.time() + timeout
        while needle not in self._out()[self.cursor:]:
            if time.time() > deadline:
                self.fail("not seen in %ds: %r; got %r"
                          % (timeout, needle, self._out()[-300:]))
            time.sleep(0.01)
        self.cursor = self._out().index(needle, self.cursor) + len(needle)

    def _input(self, data):
        body, st = self._post("/api/input", {"session_id": self.sid, "data": data})
        self.assertEqual(st, 200, body)
        self.assertTrue(body.get("ok"), body)

    def _summary(self):
        mine = [(lv, m) for lv, m in self.log.named("input_lat")
                if _word(m, "sid") == self.sid[:8]]
        return mine

    def _one(self):
        mine = self._summary()
        self.assertEqual(len(mine), 1, "one input_lat line for the session; "
                         "log: %r" % self.log.lines)
        lv, msg = mine[0]
        self.assertEqual(lv, "INFO", msg)
        return msg

    def test_summary_after_typing(self):
        for i in range(5):
            self._input("echo LATMARK%d\r" % i)
            self._wait_output(b"LATMARK%d\r\n" % i)   # the command's output
            self._wait_output(b"$ ")
        self._flush()
        msg = self._one()
        self.assertEqual(_word(msg, "sid"), self.sid[:8], msg)
        self.assertNotIn(self.sid, msg, "only the 8-character prefix")
        self.assertEqual(_int(msg, "n"), 5, msg)
        srv = _stat(msg, "srv")
        pty = _stat(msg, "pty")
        self.assertIsNotNone(srv, msg)
        self.assertIsNotNone(pty, msg)
        self.assertTrue(0 <= srv[0] <= srv[1] <= srv[2] < 1000, msg)
        self.assertTrue(0 <= pty[0] <= pty[1] <= pty[2] < 2000, msg)
        self.assertEqual(_int(msg, "pty_n"), 5, msg)
        self.assertNotIn("LATMARK", msg, "no typed content in the log")

    def test_every_echoed_key_is_counted(self):
        # The echo can be read before the input handler returns: the pty
        # clock must already be running when the bytes reach the PTY,
        # else that key goes unmeasured and the NEXT output is booked to it.
        keys = "abcdefghijklmnopqrstuvwxyz0123"
        for c in keys:
            self._input(c)
            self._wait_output(c.encode())
        self._input("\x15")
        self._flush()
        msg = self._one()
        self.assertEqual(_int(msg, "n"), len(keys) + 1, msg)
        self.assertGreaterEqual(_int(msg, "pty_n"), len(keys),
                                "every echoed key has a pty sample: " + msg)

    def test_pty_measures_the_application_not_the_echo(self):
        # Echo off: the first output after each write is the command's,
        # 0.4 s later - pty is target + application time.
        self._input("stty -echo\r")
        self._wait_output(b"$ ")
        self._flush()
        self.log.lines.clear()
        for i in range(3):
            self._input("sleep 0.4; echo SLOW%d\n" % i)
            self._wait_output(b"SLOW%d" % i)
            self._wait_output(b"$ ")
        self._flush()
        msg = self._one()
        self.assertEqual(_int(msg, "n"), 3, msg)
        self.assertEqual(_int(msg, "pty_n"), 3, msg)
        pty = _stat(msg, "pty")
        self.assertTrue(350 <= pty[0] <= pty[2] < 2000,
                        "pty p50 ~400 ms, in ms: %s" % msg)

    def test_output_after_two_seconds_is_not_counted(self):
        self._input("stty -echo\r")
        self._wait_output(b"$ ")
        self._flush()
        self.log.lines.clear()
        # A key the PTY answers with nothing (echo off, no newline)...
        self._input("a")
        time.sleep(2.3)   # the 2 s window itself is what is tested
        # ...then one it answers at once (kill the line, run nothing: a prompt).
        self._input("\x15\n")
        self._wait_output(b"$ ")
        self._flush()
        msg = self._one()
        self.assertEqual(_int(msg, "n"), 2, msg)
        self.assertEqual(_int(msg, "pty_n"), 1,
                         "the silent key is not counted, the answered one is: " + msg)
        self.assertLess(_stat(msg, "pty")[2], 2000, msg)

    def test_no_line_for_a_window_without_input(self):
        self._input("echo ONE\r")
        self._wait_output(b"ONE\r\n")
        self._flush()
        self.assertEqual(len(self._summary()), 1)
        self.log.lines.clear()
        self._flush()
        self.assertEqual(self._summary(), [], "nothing typed since: no line")

    def test_keepalive_is_not_input(self):
        # The page's keepalive is an /api/input with empty data every 30 s.
        for _ in range(3):
            self._input("")
        self._flush()
        self.assertEqual(self._summary(), [],
                         "empty keepalive inputs are not typing: %r" % self.log.lines)

    def test_a_new_window_starts_after_each_summary(self):
        self._input("echo W1\r")
        self._wait_output(b"W1\r\n")
        self._flush()
        self.log.lines.clear()
        self._input("echo W2\r")
        self._wait_output(b"W2\r\n")
        self._flush()
        self.assertEqual(_int(self._one(), "n"), 1, "the window was reset")

    def test_cleanup_emits_once_the_window_has_passed(self):
        self.assertTrue(hasattr(server, "INPUT_LAT_WINDOW"),
                        "server.INPUT_LAT_WINDOW (seconds) is the test hook")
        self.assertEqual(server.INPUT_LAT_WINDOW, 300, "5 minutes by default")
        self._input("echo C1\r")
        self._wait_output(b"C1\r\n")
        server.cleanup()
        self.assertEqual(self._summary(), [], "not before 5 minutes")
        old = server.INPUT_LAT_WINDOW
        server.INPUT_LAT_WINDOW = 0
        try:
            server.cleanup()
        finally:
            server.INPUT_LAT_WINDOW = old
        self.assertEqual(len(self._summary()), 1, "due: the periodic tick emits "
                         "the summary; log: %r" % self.log.lines)


if __name__ == "__main__":
    unittest.main()
