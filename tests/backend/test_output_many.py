"""Shared output polling keeps many panes responsive without consuming output."""
import base64
import concurrent.futures
import json
import socket
import threading
import time
import unittest.mock
import uuid

from tests.backend._base import LiveServerCase
import server


class TestOutputMany(LiveServerCase):
    def setUp(self):
        self.sessions = {}
        self.registry = unittest.mock.patch.dict(server.sessions, self.sessions)
        self.registry.start()
        self.addCleanup(self.registry.stop)

    def session(self, data=b"", owner=""):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = str(uuid.uuid4())
        s.alive = True
        s.auth_failed = False
        s.buf_lock = threading.Lock()
        s.output_buf = b""
        s._replay = b""
        s._replay_end = 0
        s._data_event = threading.Event()
        s._waiters = set()
        s._waiters_lock = threading.Lock()
        s._stream_active = False
        s.owner = owner
        s.client_ip = "127.0.0.1"
        s.last_activity = time.time()
        s.is_background = False
        server.sessions[s.id] = s
        if data:
            self.put(s, data)
        return s

    @staticmethod
    def put(s, data):
        with s.buf_lock:
            s._append_output_locked(data)
        s._signal()

    def many(self, entries, headers=None):
        return self._request_json(
            "/api/output_many", data=json.dumps({"sessions": entries}).encode(),
            headers={"Content-Type": "application/json", **(headers or {})}, timeout=3)

    @staticmethod
    def entry(s, since=0):
        return {"session_id": s.id, "since": since}

    def rows(self, response):
        body, status = response
        self.assertEqual(status, 200, body)
        self.assertIsInstance(body.get("outputs"), list, body)
        return [{**row["payload"], "_status": row["status"]} for row in body["outputs"]]

    @staticmethod
    def text(row):
        return base64.b64decode(row.get("data") or "")

    def test_config_advertises_batch_support(self):
        body, status = self._get("/api/config")
        self.assertEqual(status, 200)
        self.assertIs(body.get("output_batch"), True)

    def test_independent_cursors_are_lossless_and_replayable(self):
        a, b = self.session(b"abc"), self.session(b"01234")
        entries = [self.entry(a, 1), self.entry(b, 3)]
        for _ in range(2):
            rows = self.rows(self.many(entries))
            self.assertEqual(self.text(rows[0]), b"bc")
            self.assertEqual(self.text(rows[1]), b"34")
            self.assertEqual(rows[0]["cursor"], 3)
            self.assertEqual(rows[1]["cursor"], 5)
        self.put(a, b"def")
        rows = self.rows(self.many([self.entry(a, 3), self.entry(b, 3)]))
        self.assertEqual(self.text(rows[0]), b"def")
        self.assertEqual(self.text(rows[1]), b"34")

    def test_missing_session_isolated_from_valid_output(self):
        a = self.session(b"kept")
        missing = str(uuid.uuid4())
        rows = self.rows(self.many([{"session_id": missing, "since": 0}, self.entry(a)]))
        self.assertEqual(rows[0].get("_status"), 404)
        self.assertEqual(self.text(rows[1]), b"kept")

    def test_forbidden_session_does_not_leak_or_block_owned_session(self):
        a, b = self.session(b"own", "alice"), self.session(b"secret", "bob")
        with unittest.mock.patch.object(server, "WEBSH_AUTH_HEADER", "Remote-User"):
            rows = self.rows(self.many([self.entry(a), self.entry(b)], {"Remote-User": "alice"}))
        self.assertEqual(self.text(rows[0]), b"own")
        self.assertEqual(rows[1].get("_status"), 403)
        self.assertNotIn("data", rows[1])
        self.assertNotIn("cursor", rows[1])

    def test_busy_panes_share_a_bounded_reply_and_replay_every_byte(self):
        expected = [bytes([65 + i]) * (512 * 1024) for i in range(3)]
        panes = [self.session(data) for data in expected]
        cursors = [0, 0, 0]
        received = [b"", b"", b""]
        for round_no in range(8):
            rows = self.rows(self.many([self.entry(s, cursors[i]) for i, s in enumerate(panes)]))
            pieces = [self.text(row) for row in rows]
            self.assertLessEqual(sum(map(len, pieces)), 1024 * 1024, "raw batch reply is bounded")
            if round_no == 0:
                self.assertTrue(all(pieces), "every busy pane gets a fair share")
            for i, row in enumerate(rows):
                self.assertFalse(row.get("lost", 0))
                self.assertFalse(row.get("reset", False))
                received[i] += pieces[i]
                cursors[i] = row["cursor"]
                self.assertEqual(cursors[i], len(received[i]), "cursor advances only by delivered bytes")
            if received == expected:
                break
        self.assertEqual(received, expected, "later batches replay the remainder without loss or duplication")

    def test_ended_and_auth_failed_panes_deliver_all_backlog_before_terminal_status(self):
        expected = [b"a" * (512 * 1024), b"b" * (512 * 1024), b"c" * (512 * 1024)]
        panes = [self.session(data) for data in expected]
        panes[0].alive = False
        panes[1].alive = False
        panes[1].auth_failed = True
        cursors = [0, 0, 0]
        received = [b"", b"", b""]
        rows = []
        for _ in range(8):
            rows = self.rows(self.many([self.entry(s, cursors[i]) for i, s in enumerate(panes)]))
            for i, row in enumerate(rows):
                received[i] += self.text(row)
                cursors[i] = row["cursor"]
                if len(received[i]) < len(expected[i]):
                    self.assertTrue(row["alive"], "a partial backlog is not terminal yet")
                    self.assertFalse(row.get("auth_failed"), "auth failure must not stop delivery of its tail")
            if received == expected:
                break
        self.assertEqual(received, expected)
        self.assertFalse(rows[0]["alive"])
        self.assertFalse(rows[0].get("auth_failed"))
        self.assertFalse(rows[1]["alive"])
        self.assertTrue(rows[1]["auth_failed"])

    def test_final_append_between_cursor_snapshot_and_status_does_not_end_early(self):
        class FinalAppendSession(server.SSHSession):
            @property
            def _replay_end(self):
                value = self._end_value
                if self.armed:
                    self.end_reads += 1
                    if self.end_reads == 2:
                        # The handler already read its chunk. The PTY
                        # reader now appends final bytes and stops.
                        self.armed = False
                        TestOutputMany.put(self, b"-tail")
                        self.alive = False
                return value

            @_replay_end.setter
            def _replay_end(self, value):
                self._end_value = value

        s = self.session(b"head")
        s._end_value = s._replay_end
        s.armed = True
        s.end_reads = 0
        s.__class__ = FinalAppendSession
        first = self.rows(self.many([self.entry(s)]))[0]
        self.assertFalse(s.armed, "the final append raced this reply")
        self.assertEqual(self.text(first), b"head")
        self.assertTrue(first["alive"], "the client must fetch the final append before ending")
        second = self.rows(self.many([self.entry(s, first["cursor"])]))[0]
        self.assertEqual(self.text(second), b"-tail")
        self.assertFalse(second["alive"])

    def test_replay_gap_and_reset_remain_per_session(self):
        with unittest.mock.patch.object(server, "OUTPUT_REPLAY_BYTES", 4096):
            a, b = self.session(b"a" * 8192), self.session(b"hello")
        rows = self.rows(self.many([self.entry(a), self.entry(b, 100)]))
        self.assertEqual(rows[0].get("lost"), 4096)
        self.assertEqual(self.text(rows[0]), b"a" * 4096)
        self.assertTrue(rows[1].get("reset"))
        self.assertEqual(self.text(rows[1]), b"hello")
        self.assertEqual(rows[1]["cursor"], 5)

    def test_duplicate_sessions_are_rejected_before_reading_output(self):
        s = self.session(b"keep")
        with unittest.mock.patch.object(s, "read_since", wraps=s.read_since) as read:
            body, status = self.many([self.entry(s), self.entry(s)])
        self.assertEqual(status, 400, body)
        read.assert_not_called()

    def test_oversized_batch_is_rejected_before_reading_any_session(self):
        s = self.session(b"keep")
        entries = [self.entry(s)] + [
            {"session_id": str(uuid.uuid4()), "since": 0} for _ in range(1024)]
        with unittest.mock.patch.object(s, "read_since", wraps=s.read_since) as read:
            body, status = self.many(entries)
        self.assertIn(status, (400, 413), body)
        read.assert_not_called()

    def test_non_list_sessions_body_is_rejected(self):
        body, status = self.many("not-a-session-list")
        self.assertEqual(status, 400, body)

    def test_any_quiet_session_wakes_the_shared_poll_promptly(self):
        a, b = self.session(), self.session()
        observed = threading.Event()
        read = b.read_since

        def observe(cursor, **kwargs):
            result = read(cursor, **kwargs)
            observed.set()
            return result
        b.read_since = observe
        with concurrent.futures.ThreadPoolExecutor() as pool:
            result = pool.submit(self.many, [self.entry(a), self.entry(b)])
            try:
                self.assertTrue(observed.wait(1), "batch checked the second quiet session")
                start = time.monotonic()
                self.put(b, b"echo-now")
                rows = self.rows(result.result(timeout=1))
                self.assertLess(time.monotonic() - start, 0.75)
                self.assertEqual(self.text(rows[1]), b"echo-now")
            finally:
                self.put(a, b"cleanup")
                self.put(b, b"cleanup")

    def test_cancelling_one_batch_does_not_cancel_a_second_waiter(self):
        s = self.session()
        entered = threading.Condition()
        reads = [0]
        read = s.read_since

        def observe(cursor, **kwargs):
            result = read(cursor, **kwargs)
            with entered:
                reads[0] += 1
                entered.notify_all()
            return result
        s.read_since = observe
        raw = socket.create_connection(("127.0.0.1", self.port), timeout=2)
        payload = json.dumps({"sessions": [self.entry(s)]}).encode()
        raw.sendall(b"POST /api/output_many HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: "
                    + str(len(payload)).encode() + b"\r\n\r\n" + payload)
        self.addCleanup(raw.close)
        with entered:
            self.assertTrue(entered.wait_for(lambda: reads[0] > 0, 1), "first waiter entered")
            reads[0] = 0
        with concurrent.futures.ThreadPoolExecutor() as pool:
            second = pool.submit(self.many, [self.entry(s)])
            try:
                with entered:
                    self.assertTrue(entered.wait_for(lambda: reads[0] > 0, 1), "second waiter entered")
                raw.shutdown(socket.SHUT_RDWR)
                raw.close()
                self.put(s, b"still-delivered")
                rows = self.rows(second.result(timeout=1))
                self.assertEqual(self.text(rows[0]), b"still-delivered")
            finally:
                self.put(s, b"cleanup")
