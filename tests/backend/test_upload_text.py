#!/usr/bin/env python3
"""Plain uploads with a text body (upload-text spec, 2026-10-21).

Endpoint-security software on the owner's Mac answers every
`application/octet-stream` POST itself (503 text/html) - it never
reaches websh - while the same bytes as base64 inside JSON pass. So
/api/upload also takes `Content-Type: application/json` with
`{"b64": "<base64>"}`: the decoded bytes are the piece, and everything
else (offset rules, 409 with the size, reply shape, MAX_UPLOAD_SIZE on
the decoded size, access-log bytes) is what a raw piece gets. A raw body
is handled exactly as before.

Written from the spec. The uploads run the real remote snippets in a
local `sh` with $HOME pointed at a temp dir (as TestSideChannelSnippets-
Executed does), behind the real HTTP handler.
"""

import base64
import json
import os
import shutil
import socket
import tempfile
import time
import unittest
import unittest.mock
import uuid

from tests.backend._base import LiveServerCase
import server


def _local_session(home):
    """An SSHSession whose ControlMaster commands run locally in `sh`
    with HOME=home: the real upload snippet, a local disk."""
    s = server.SSHSession.__new__(server.SSHSession)
    s.id = "up"
    s.persistent = False
    s.slot_id = None
    s.alive = True
    s.auth_failed = False
    s.owner = ""
    s.client_ip = "127.0.0.1"
    s.is_background = False
    s.last_activity = time.time()
    s._control_path = "/tmp/fake.sock"
    s._host = "h.example"
    s._port = 22
    s._username = "u"
    s._mux_ready = lambda: True
    s._mux_argv = lambda cmd: ["env", "HOME=" + home, "sh", "-c", cmd]
    s.is_expired = lambda: False
    s.close = lambda: None
    return s


class _UploadCase(LiveServerCase):
    TOLERANT_JSON = True

    def setUp(self):
        server._side_channel_rate_limits.clear()
        self.home = tempfile.mkdtemp(prefix="websh-uptext-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.sid = str(uuid.uuid4())
        p = unittest.mock.patch.dict(server.sessions, {self.sid: _local_session(self.home)})
        p.start()
        self.addCleanup(p.stop)

    def up(self, name, data, offset=None, text=True, ctype=None, raw_body=None):
        q = "/api/upload?session_id={}&path={}".format(self.sid, name)
        if offset is not None:
            q += "&offset={}".format(offset)
        if raw_body is not None:
            body = raw_body
        elif text:
            body = json.dumps({"b64": base64.b64encode(data).decode("ascii")}).encode()
        else:
            body = data
        ct = ctype or ("application/json" if text else "application/octet-stream")
        code, raw = self._request_raw(q, data=body, method="POST",
                                      headers={"Content-Type": ct}, timeout=30)
        try:
            j = json.loads(raw.decode("utf-8"))
        except ValueError:
            j = {"_raw": raw[:200]}
        return code, j

    def file(self, name):
        p = os.path.join(self.home, name)
        if not os.path.exists(p):
            return None
        with open(p, "rb") as f:
            return f.read()


class TestUploadTextConfig(LiveServerCase):

    def test_config_says_the_server_takes_text_uploads(self):
        body, code = self._get("/api/config")
        self.assertEqual(code, 200)
        self.assertIs(body.get("upload_text"), True, "config must announce upload_text: true")
        self.assertEqual(body["proto"], 1, "additive: proto stays 1")


class TestUploadTextBody(_UploadCase):

    def test_decoded_bytes_are_written_with_the_raw_reply_shape(self):
        data = os.urandom(70000) + b"\x00\xff\n{\"b64\": \"x\"}"
        code, j = self.up(".websh-tmp-t1", data, offset=0)
        self.assertEqual(code, 200, j)
        self.assertEqual(self.file(".websh-tmp-t1"), data, "the decoded bytes, byte for byte")
        code2, j2 = self.up(".websh-tmp-r1", data, offset=0, text=False)
        self.assertEqual(code2, 200, j2)
        self.assertEqual(self.file(".websh-tmp-r1"), data)
        self.assertEqual(sorted(j), sorted(j2), "same reply keys as a raw piece")
        self.assertEqual(j.get("bytes"), len(data))
        self.assertEqual(j.get("size"), len(data))

    def test_whole_file_mode_without_offset(self):
        data = b"whole file, no offset\n" * 10
        code, j = self.up(".websh-tmp-w", data)
        self.assertEqual(code, 200, j)
        self.assertEqual(self.file(".websh-tmp-w"), data)

    def test_pieces_append_at_the_offset_and_mix_with_raw_ones(self):
        a, b, c = os.urandom(1000), os.urandom(2000), os.urandom(3000)
        self.assertEqual(self.up(".websh-tmp-mix", a, offset=0, text=False)[0], 200)
        # The switch to text happens mid-file: the next piece is text.
        code, j = self.up(".websh-tmp-mix", b, offset=1000)
        self.assertEqual(code, 200, j)
        self.assertEqual(j.get("size"), 3000)
        self.assertEqual(self.up(".websh-tmp-mix", c, offset=3000)[0], 200)
        self.assertEqual(self.file(".websh-tmp-mix"), a + b + c)

    def test_a_text_piece_at_the_wrong_offset_is_409_with_the_real_size(self):
        self.assertEqual(self.up(".websh-tmp-o", b"x" * 10, offset=0)[0], 200)
        code, j = self.up(".websh-tmp-o", b"y" * 50, offset=40)
        self.assertEqual(code, 409, j)
        self.assertEqual(j, {"error": "offset mismatch", "size": 10})
        self.assertEqual(self.file(".websh-tmp-o"), b"x" * 10, "file untouched")
        # offset 0 again starts over, as for raw pieces
        self.assertEqual(self.up(".websh-tmp-o", b"z", offset=0)[0], 200)
        self.assertEqual(self.file(".websh-tmp-o"), b"z")

    def test_a_bad_text_body_is_400_and_writes_nothing(self):
        good = base64.b64encode(b"hello").decode()
        bad = {
            "not JSON": b'{"b64": ',
            "JSON array": json.dumps([good]).encode(),
            "no b64": json.dumps({"data": good}).encode(),
            "b64 not a string": json.dumps({"b64": 12}).encode(),
            "b64 not base64": json.dumps({"b64": "!!" + good}).encode(),
            "b64 unpadded garbage": json.dumps({"b64": "abc"}).encode(),
        }
        self.assertEqual(self.up(".websh-tmp-keep", b"KEEP", offset=0)[0], 200)
        for what, body in bad.items():
            for name, off in ((".websh-tmp-new", 0), (".websh-tmp-keep", 4)):
                code, j = self.up(name, None, offset=off, raw_body=body, ctype="application/json")
                self.assertEqual(code, 400, (what, j))
                self.assertEqual(j, {"error": "invalid upload body"}, what)
            self.assertIsNone(self.file(".websh-tmp-new"), what + ": no file created")
            self.assertEqual(self.file(".websh-tmp-keep"), b"KEEP", what + ": file untouched")

    def test_the_cap_applies_to_the_decoded_size(self):
        with unittest.mock.patch.object(server, "MAX_UPLOAD_SIZE", 100):
            # 90 bytes decoded, ~150 bytes of JSON on the wire: allowed.
            code, j = self.up(".websh-tmp-cap", os.urandom(90), offset=0)
            self.assertEqual(code, 200, j)
            # 101 bytes decoded: too large, as a raw 101-byte piece is.
            code, j = self.up(".websh-tmp-cap2", os.urandom(101), offset=0)
            self.assertEqual(code, 413, j)
            self.assertIsNone(self.file(".websh-tmp-cap2"))
            # offset + decoded size over the cap: 413 as for raw.
            code, j = self.up(".websh-tmp-cap", os.urandom(20), offset=90)
            self.assertEqual(code, 413, j)
            self.assertEqual(len(self.file(".websh-tmp-cap")), 90)

    def test_a_raw_body_is_handled_exactly_as_before(self):
        # A raw piece that happens to look like the JSON form is written
        # verbatim: the choice is the Content-Type, never sniffing.
        looks = json.dumps({"b64": base64.b64encode(b"NOT THIS").decode()}).encode()
        for ct in ("application/octet-stream", "text/plain"):
            name = ".websh-tmp-raw-" + ct.split("/")[0]
            code, j = self.up(name, looks, offset=0, text=False, ctype=ct)
            self.assertEqual(code, 200, (ct, j))
            self.assertEqual(self.file(name), looks, ct + ": written as sent")
        # No Content-Type at all: raw, as before.
        q = "/api/upload?session_id={}&path=.websh-tmp-noct&offset=0".format(self.sid)
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest("POST", q)
        c.putheader("Content-Length", str(len(looks)))
        c.endheaders(looks)
        r = c.getresponse()
        r.read()
        c.close()
        self.assertEqual(r.status, 200)
        self.assertEqual(self.file(".websh-tmp-noct"), looks)

    def _cut(self, name, body, ctype):
        k = socket.create_connection(("127.0.0.1", self.port), timeout=30)
        try:
            k.sendall((
                "POST /api/upload?session_id={}&path={}&offset=0 HTTP/1.1\r\nHost: x\r\n"
                "Content-Type: {}\r\nContent-Length: {}\r\n\r\n"
                .format(self.sid, name, ctype, len(body) + 5000)).encode() + body)
            k.shutdown(socket.SHUT_WR)
            data = b""
            while True:
                d = k.recv(65536)
                if not d:
                    break
                data += d
        finally:
            k.close()
        head, _, rest = data.partition(b"\r\n\r\n")
        return head.split(b"\r\n")[0], rest

    def test_a_cut_text_body_gets_the_same_cut_answer_as_a_raw_one(self):
        raw = os.urandom(3000)
        status_raw, body_raw = self._cut(".websh-tmp-cutraw", raw, "application/octet-stream")
        text = json.dumps({"b64": base64.b64encode(raw).decode()}).encode()
        status_txt, body_txt = self._cut(".websh-tmp-cuttxt", text, "application/json")
        self.assertIn(b"client sent fewer bytes than Content-Length", body_raw, "(the raw reference)")
        self.assertIn(b"client sent fewer bytes than Content-Length", body_txt,
                      "the cut text body names the cut, so the client shrinks (O7b)")
        # The spec says "the same 400 as a raw one"; a raw piece cut on its
        # way into websh is answered 502 by websh itself (nginx says 400).
        # Both are truncation signals the client shrinks on (O7b); what
        # matters is that it is one of them, with the text.
        self.assertIn(status_txt.split(b" ")[1], (b"400", b"502"),
                      "a truncation status: %r (raw got %r)" % (status_txt, status_raw))
        got = self.file(".websh-tmp-cuttxt") or b""
        self.assertTrue(raw.startswith(got),
                        "whatever a cut text piece left is a prefix of the decoded bytes "
                        "(never JSON text); the client resumes from the size: %r" % got[:40])


class TestUploadTextAccessLog(_UploadCase):

    def setUp(self):
        super().setUp()
        self._orig = server.ACCESS_LOG_PATH
        fd, self.logp = tempfile.mkstemp(suffix=".log")
        os.close(fd)
        server.ACCESS_LOG_PATH = self.logp

    def tearDown(self):
        server.ACCESS_LOG_PATH = self._orig
        os.unlink(self.logp)

    def test_the_access_log_counts_the_decoded_bytes(self):
        data = os.urandom(3000)
        self.assertEqual(self.up(".websh-tmp-log", data, offset=0)[0], 200)
        deadline = time.time() + 2
        recs = []
        while time.time() < deadline:
            with open(self.logp) as f:
                recs = [json.loads(x) for x in f if x.strip()]
            if any(r.get("event") == "upload" for r in recs):
                break
            time.sleep(0.02)
        up = [r for r in recs if r.get("event") == "upload"]
        self.assertEqual(len(up), 1, recs)
        self.assertEqual(up[0]["bytes"], 3000, "decoded bytes, not the base64 length")
        self.assertEqual(up[0]["result"], "ok")


if __name__ == "__main__":
    unittest.main()
