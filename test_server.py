#!/usr/bin/env python3
"""Tests for websh server.py — config loading, restrict_hosts, API."""

import base64
import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
import uuid
import weakref

# Import server module
sys.path.insert(0, os.path.dirname(__file__))
import server


class _FakeNotifyMixin(object):
    """Mixin for in-test fake sessions: provides the surface that the
    real Session.wait_for_data + _signal contract expects, but as a
    cheap no-op. Tests that need to exercise the real signal-then-wake
    path use Session itself (see TestSessionNotify); fakes here are
    for higher-level protocol tests where the wait helper just needs
    to not blow up and let the loop tick forward."""
    _notify_r = None
    _notify_w = None
    # The /api/stream handler now enforces "at most one stream per
    # session" by reading-then-setting this attribute under sessions_lock.
    # Tests that plant fake sessions inherit this default and the guard
    # works the same way it does for real Sessions.
    _stream_active = False

    def _signal(self):
        pass

    def wait_for_data(self, client_socket, timeout, selector=None):
        # Mirror Session.wait_for_data's notify_r=None fallback so
        # the protocol-level loop progresses without busy-spinning.
        time.sleep(min(timeout, 0.01))


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


class TestConfigLoading(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        server._config_cache = None
        server._config_mtime = 0

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def _write_config(self, data):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump(data, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0
        return path

    def _clear_config(self):
        os.environ.pop("WEBSH_CONFIG", None)
        server._config_cache = None
        server._config_mtime = 0

    def test_no_config(self):
        self._clear_config()
        cfg = server.load_config()
        self.assertEqual(cfg["connections"], [])
        self.assertFalse(cfg["restrict_hosts"])

    def test_missing_file(self):
        os.environ["WEBSH_CONFIG"] = "/nonexistent/websh.json"
        cfg = server.load_config()
        self.assertEqual(cfg["connections"], [])
        self.assertFalse(cfg["restrict_hosts"])

    def test_valid_config(self):
        self._write_config({
            "restrict_hosts": True,
            "connections": [
                {"name": "prod", "host": "srv.example.com", "port": 22,
                 "username": "admin", "password": "secret123"}
            ]
        })
        cfg = server.load_config()
        self.assertTrue(cfg["restrict_hosts"])
        self.assertEqual(len(cfg["connections"]), 1)
        self.assertEqual(cfg["connections"][0]["name"], "prod")
        self.assertEqual(cfg["connections"][0]["password"], "secret123")

    def test_defaults_applied(self):
        self._write_config({
            "connections": [{"name": "minimal", "host": "example.com"}]
        })
        cfg = server.load_config()
        conn = cfg["connections"][0]
        self.assertEqual(conn["port"], 22)
        self.assertEqual(conn["username"], "")
        self.assertFalse(cfg["restrict_hosts"])

    def test_invalid_json(self):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            f.write("{broken json")
        os.environ["WEBSH_CONFIG"] = path
        cfg = server.load_config()
        self.assertEqual(cfg["connections"], [])

    def test_cache_reloads_on_change(self):
        """Config cache should reload when file is modified."""
        self._write_config({
            "connections": [{"name": "v1", "host": "a.com"}]
        })
        cfg1 = server.load_config()
        self.assertEqual(cfg1["connections"][0]["name"], "v1")

        # Modify the file (ensure mtime changes)
        time.sleep(0.1)
        self._write_config({
            "connections": [{"name": "v2", "host": "b.com"}]
        })
        cfg2 = server.load_config()
        self.assertEqual(cfg2["connections"][0]["name"], "v2")


class TestConfigPublic(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)
        os.environ.pop("WEBSH_CONFIG", None)

    def test_secrets_stripped(self):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({
                "connections": [{
                    "name": "srv", "host": "h", "port": 22, "username": "u",
                    "password": "secret", "key": "-----BEGIN KEY-----"
                }]
            }, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

        pub = server.config_public()
        conn = pub["connections"][0]
        self.assertEqual(conn["name"], "srv")
        self.assertEqual(conn["host"], "h")
        self.assertEqual(conn["username"], "u")
        self.assertNotIn("password", conn)
        self.assertNotIn("key", conn)


class TestFindConfigConnection(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({
                "connections": [
                    {"name": "alpha", "host": "a.com", "username": "u1",
                     "password": "p1"},
                    {"name": "beta", "host": "b.com", "username": "u2",
                     "password": "p2"},
                ]
            }, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)
        os.environ.pop("WEBSH_CONFIG", None)

    def test_found(self):
        conn = server.find_config_connection("alpha")
        self.assertIsNotNone(conn)
        self.assertEqual(conn["host"], "a.com")
        self.assertEqual(conn["password"], "p1")

    def test_not_found(self):
        conn = server.find_config_connection("gamma")
        self.assertIsNone(conn)


class TestIsHostAllowed(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)
        os.environ.pop("WEBSH_CONFIG", None)

    def _write_config(self, data):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump(data, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

    def test_no_restriction(self):
        self._write_config({"restrict_hosts": False, "connections": []})
        self.assertTrue(server.is_host_allowed("any.com", 22, "root"))

    def test_restricted_blocks_manual(self):
        """When restrict_hosts is on, manual-path POSTs are always rejected —
        even if host/port/user match a configured connection. Callers must
        use the named connection path instead."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [
                {"name": "srv", "host": "ok.com", "port": 22,
                 "username": "admin", "password": "p"}
            ]
        })
        self.assertFalse(server.is_host_allowed("ok.com", 22, "admin"))
        self.assertFalse(server.is_host_allowed("evil.com", 22, "x"))


class TestParseDeniedHosts(unittest.TestCase):
    """Unit tests for _parse_denied_hosts splitting hostnames vs IP/CIDR."""

    def test_empty_or_missing(self):
        h, n = server._parse_denied_hosts(None)
        self.assertEqual(h, frozenset())
        self.assertEqual(n, ())
        h, n = server._parse_denied_hosts([])
        self.assertEqual(h, frozenset())
        self.assertEqual(n, ())

    def test_hostnames_lowercased(self):
        h, n = server._parse_denied_hosts(["EVIL.com", "Bad.Example"])
        self.assertEqual(h, frozenset({"evil.com", "bad.example"}))
        self.assertEqual(n, ())

    def test_ip_literal_becomes_host_network(self):
        h, n = server._parse_denied_hosts(["127.0.0.1", "::1"])
        self.assertEqual(h, frozenset())
        self.assertEqual(len(n), 2)
        # /32 for v4 host literal, /128 for v6 host literal
        self.assertEqual(str(n[0]), "127.0.0.1/32")
        self.assertEqual(str(n[1]), "::1/128")

    def test_cidr_ranges(self):
        h, n = server._parse_denied_hosts(
            ["10.0.0.0/8", "192.168.0.0/16", "fe80::/10"])
        self.assertEqual(h, frozenset())
        nets = [str(x) for x in n]
        self.assertIn("10.0.0.0/8", nets)
        self.assertIn("192.168.0.0/16", nets)
        self.assertIn("fe80::/10", nets)

    def test_mixed(self):
        h, n = server._parse_denied_hosts(
            ["evil.com", "10.0.0.0/8", "127.0.0.1", "  ", "", None, 42])
        self.assertEqual(h, frozenset({"evil.com"}))
        self.assertEqual(len(n), 2)

    def test_invalid_string_treated_as_hostname(self):
        # "not-an-ip!!" is not parseable as ip_network → goes to host_set
        h, n = server._parse_denied_hosts(["not-an-ip!!"])
        self.assertEqual(h, frozenset({"not-an-ip!!"}))
        self.assertEqual(n, ())


class TestResolveHostIPs(unittest.TestCase):
    """Unit tests for _resolve_host_ips."""

    def test_returns_empty_on_gaierror(self):
        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        side_effect=server.socket.gaierror):
            self.assertEqual(server._resolve_host_ips("nope.example"), [])

    def test_returns_empty_on_unicode_error(self):
        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        side_effect=UnicodeError):
            self.assertEqual(server._resolve_host_ips("​"), [])

    def test_returns_unique_addresses(self):
        # getaddrinfo may return the same address from v4/v6 plus duplicates
        infos = [
            (None, None, None, None, ("10.0.0.5", 0)),
            (None, None, None, None, ("10.0.0.5", 0)),
            (None, None, None, None, ("fe80::1%eth0", 0)),
        ]
        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        return_value=infos):
            ips = server._resolve_host_ips("foo.example")
        self.assertEqual(len(ips), 2)
        self.assertEqual(str(ips[0]), "10.0.0.5")
        self.assertEqual(str(ips[1]), "fe80::1")  # scope stripped


class TestDeniedHosts(unittest.TestCase):
    """End-to-end deny-list behaviour at is_host_allowed boundary."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)
        os.environ.pop("WEBSH_CONFIG", None)

    def _write_config(self, data):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump(data, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

    def _patched_resolve(self, ip):
        """Patch _resolve_host_ips to deterministically return one IP."""
        return unittest.mock.patch.object(
            server, "_resolve_host_ips",
            return_value=[server.ipaddress.ip_address(ip)])

    def test_empty_deny_list_allows_all(self):
        self._write_config({"restrict_hosts": False, "connections": []})
        with self._patched_resolve("8.8.8.8"):
            self.assertTrue(server.is_host_allowed("public.example", 22, "u"))

    def test_hostname_exact_match_blocked(self):
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["evil.example"],
        })
        with self._patched_resolve("8.8.8.8"):
            self.assertFalse(server.is_host_allowed("evil.example", 22, "u"))
            self.assertFalse(server.is_host_allowed("EVIL.example", 22, "u"))
            self.assertTrue(server.is_host_allowed("ok.example", 22, "u"))

    def test_ip_literal_in_target_blocked_by_cidr(self):
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["10.0.0.0/8"],
        })
        with self._patched_resolve("10.5.6.7"):
            self.assertFalse(server.is_host_allowed("10.5.6.7", 22, "u"))

    def test_loopback_blocked_by_cidr(self):
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["127.0.0.0/8"],
        })
        with self._patched_resolve("127.0.0.1"):
            self.assertFalse(server.is_host_allowed("localhost", 22, "u"))
        with self._patched_resolve("127.5.5.5"):
            self.assertFalse(server.is_host_allowed("loopback.example", 22, "u"))

    def test_dns_resolves_to_denied_range_blocked(self):
        """The whole point: hostname looks innocent, but A record points
        into a denied range → blocked."""
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["192.168.0.0/16"],
        })
        with self._patched_resolve("192.168.1.42"):
            self.assertFalse(
                server.is_host_allowed("looks-public.example", 22, "u"))

    def test_dns_resolution_failure_fails_open(self):
        """When DNS doesn't resolve at all, we let the request through —
        ssh will produce its own resolution error. Failing closed here
        would block any typo'd hostname unnecessarily."""
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["192.168.0.0/16"],
        })
        with unittest.mock.patch.object(server, "_resolve_host_ips",
                                        return_value=[]):
            self.assertTrue(
                server.is_host_allowed("nonexistent.example", 22, "u"))

    def test_ipv6_cidr_blocked(self):
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["fe80::/10"],
        })
        with self._patched_resolve("fe80::1"):
            self.assertFalse(server.is_host_allowed("link-local.example", 22, "u"))

    def test_mixed_hostname_and_cidr(self):
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": [
                "blocked-name.example",
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "127.0.0.0/8",
                "169.254.0.0/16",
            ],
        })
        with self._patched_resolve("10.0.0.5"):
            self.assertFalse(server.is_host_allowed("any-rfc1918.example", 22, "u"))
        with self._patched_resolve("8.8.8.8"):
            self.assertTrue(server.is_host_allowed("ok.example", 22, "u"))
            self.assertFalse(server.is_host_allowed("blocked-name.example", 22, "u"))

    def test_restrict_hosts_takes_precedence(self):
        """When restrict_hosts is on, the deny-list never even runs —
        all manual connects are rejected by the prior gate."""
        self._write_config({
            "restrict_hosts": True,
            "denied_hosts": ["evil.example"],
        })
        # Even a non-blocked host is rejected because of restrict_hosts.
        with self._patched_resolve("8.8.8.8"):
            self.assertFalse(server.is_host_allowed("ok.example", 22, "u"))


class TestConnectionKinds(unittest.TestCase):
    """Classification of connections[] entries as Ready vs Prompt."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        server._config_cache = None
        server._config_mtime = 0

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)
        os.environ.pop("WEBSH_CONFIG", None)

    def _write(self, data):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump(data, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

    def test_ready_when_password(self):
        self._write({"connections": [
            {"name": "r", "host": "h", "username": "u", "password": "p"}
        ]})
        self.assertEqual(server.load_config()["connections"][0]["kind"], "ready")

    def test_ready_when_key(self):
        self._write({"connections": [
            {"name": "k", "host": "h", "username": "u", "key": "---KEY---"}
        ]})
        self.assertEqual(server.load_config()["connections"][0]["kind"], "ready")

    def test_prompt_when_no_creds(self):
        self._write({"connections": [
            {"name": "p", "host": "h", "username": "u"}
        ]})
        self.assertEqual(server.load_config()["connections"][0]["kind"], "prompt")

    def test_prompt_user_lists_parsed(self):
        self._write({"connections": [
            {"name": "p", "host": "h", "allowed_users": ["alice", "bob"]},
            {"name": "p2", "host": "h2", "denied_users": ["root"]},
        ]})
        cs = server.load_config()["connections"]
        self.assertEqual(cs[0]["allowed_users"], ["alice", "bob"])
        self.assertIsNone(cs[0]["denied_users"])
        self.assertIsNone(cs[1]["allowed_users"])
        self.assertEqual(cs[1]["denied_users"], ["root"])


class TestCheckPromptUser(unittest.TestCase):
    def _entry(self, **kw):
        return {"allowed_users": kw.get("au"), "denied_users": kw.get("du")}

    def test_no_rules_permits(self):
        self.assertTrue(server.check_prompt_user(self._entry(), "anyone")[0])

    def test_whitelist_hit(self):
        ok, _ = server.check_prompt_user(self._entry(au=["alice"]), "alice")
        self.assertTrue(ok)

    def test_whitelist_miss(self):
        ok, _ = server.check_prompt_user(self._entry(au=["alice"]), "eve")
        self.assertFalse(ok)

    def test_blacklist_hit_rejected(self):
        ok, _ = server.check_prompt_user(self._entry(du=["root"]), "root")
        self.assertFalse(ok)

    def test_blacklist_miss_allowed(self):
        ok, _ = server.check_prompt_user(self._entry(du=["root"]), "alice")
        self.assertTrue(ok)

    def test_whitelist_wins(self):
        ok, _ = server.check_prompt_user(
            self._entry(au=["alice"], du=["alice"]), "alice")
        self.assertTrue(ok)


class TestConfigPublicKind(unittest.TestCase):
    """config_public exposes kind + user lists for Prompt entries."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        server._config_cache = None
        server._config_mtime = 0

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)
        os.environ.pop("WEBSH_CONFIG", None)

    def test_kind_exposed_secrets_stripped(self):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({"connections": [
                {"name": "r", "host": "h", "username": "u", "password": "p"},
                {"name": "p", "host": "h2", "allowed_users": ["a"]},
            ]}, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

        pub = server.config_public()
        r, p = pub["connections"]
        self.assertEqual(r["kind"], "ready")
        self.assertNotIn("password", r)
        self.assertNotIn("allowed_users", r)
        self.assertEqual(p["kind"], "prompt")
        self.assertEqual(p["allowed_users"], ["a"])


class TestHTTPApi(unittest.TestCase):
    """Integration tests: start the server and hit the API with HTTP."""

    @classmethod
    def setUpClass(cls):
        # Use a random port to avoid conflicts
        cls.port = 18765
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.tmpdir = tempfile.mkdtemp()

        path = os.path.join(cls.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({
                "restrict_hosts": True,
                "connections": [
                    {"name": "allowed", "host": "localhost", "port": 22,
                     "username": "testuser", "password": "testpass"}
                ]
            }, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        os.environ.pop("WEBSH_CONFIG", None)
        import shutil
        shutil.rmtree(cls.tmpdir)

    def _get(self, path):
        if sys.version_info >= (3, 0):
            from urllib.request import urlopen
            from urllib.error import HTTPError
        url = "http://127.0.0.1:{0}{1}".format(self.port, path)
        try:
            resp = urlopen(url, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            if hasattr(e, 'read'):
                return json.loads(e.read().decode("utf-8")), e.code
            raise

    def _post(self, path, body):
        if sys.version_info >= (3, 0):
            from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{0}{1}".format(self.port, path)
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data,
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            if hasattr(e, 'read'):
                return json.loads(e.read().decode("utf-8")), e.code
            raise

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

    def test_stream_happy_path(self):
        """Plant a fake session that emits one chunk then dies.
        Verify SSE headers, the initial ': ok' comment, the encoded
        'data' event, and the closing 'end' event, in that order."""
        import http.client
        sid = str(uuid.uuid4())

        class FakeSession(_FakeNotifyMixin):
            def __init__(self, echo_off=False):
                self.alive = True
                self.auth_failed = False
                self._chunks = [b"hello\r\n"]
                self._echo_off = echo_off
            def read(self):
                if self._chunks:
                    return self._chunks.pop(0)
                self.alive = False
                return b""
            def echo_off_hint(self):
                return self._echo_off

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
            # echo_off propagates from the session into every payload
            # (primer included) so the client can gate local-echo
            # prediction at echo-disabled prompts.
            self.assertIn("echo_off", data_payloads[0])
            self.assertFalse(data_payloads[0]["echo_off"])
            self.assertIn("echo_off", chunk_payload)
            self.assertFalse(chunk_payload["echo_off"])
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
            def echo_off_hint(self):
                return False

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
            self.assertFalse(primer["echo_off"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_stream_propagates_echo_off_hint(self):
        """When the session reports echo_off_hint=True (recent output
        looks like a password prompt), every SSE 'data' frame — primer
        included — must carry echo_off=true so the client suppresses
        local-echo prediction from the very first event."""
        import http.client
        sid = str(uuid.uuid4())

        class FakeSession(_FakeNotifyMixin):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
                self._chunks = [b"[sudo] password for alexey: "]
            def read(self):
                if self._chunks:
                    return self._chunks.pop(0)
                self.alive = False
                return b""
            def echo_off_hint(self):
                return True

        with server.sessions_lock:
            server.sessions[sid] = FakeSession()
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
            data_payloads = [
                json.loads(line[len("data: "):])
                for line in text.splitlines()
                if line.startswith("data: ") and '"data"' in line
            ]
            self.assertGreaterEqual(len(data_payloads), 1)
            for p in data_payloads:
                self.assertTrue(p["echo_off"],
                    "echo_off=True from session must propagate "
                    "to wire on every frame, got: " + repr(p))
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
            def echo_off_hint(self):
                return False

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

    def test_stream_event_end_carries_echo_off(self):
        """The terminating event:end frame must include echo_off so the
        client can reset its prediction gate consistently with data
        frames. Missing field would leave the prediction in a stale
        state if the disconnect arrives mid-prompt."""
        import http.client
        sid = str(uuid.uuid4())

        class Sess(_FakeNotifyMixin):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
                self._calls = 0
            def read(self):
                self._calls += 1
                if self._calls > 2:
                    self.alive = False
                return b""
            def echo_off_hint(self):
                return True

        with server.sessions_lock:
            server.sessions[sid] = Sess()
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
            self.assertIn("event: end", text,
                          "stream did not deliver event:end")
            # Find the JSON immediately after `event: end`.
            end_idx = text.find("event: end")
            tail = text[end_idx:]
            data_line = next(line for line in tail.splitlines()
                             if line.startswith("data: "))
            payload = json.loads(data_line[len("data: "):])
            self.assertIn("echo_off", payload,
                "event:end must include echo_off for client consistency")
            self.assertTrue(payload["echo_off"])
            self.assertFalse(payload["alive"])
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

    def test_stream_returns_undelivered_bytes_to_buffer(self):
        """Regression: when the client closes /api/stream mid-flight,
        bytes the SSE handler had already drained from the session must
        not vanish. The handler peeks the socket for FIN before each
        read(); if it sees FIN after a read but before delivery, it
        pushes the bytes back via session.unread(). Either way the next
        consumer (e.g. long-poll fallback) can still pick them up."""
        import socket as _socket
        sid = str(uuid.uuid4())

        # Real-ish session: holds bytes in output_buf under buf_lock and
        # supports the same read()/unread() contract as SSHSession.
        class Sess(_FakeNotifyMixin):
            def __init__(self):
                self.alive = True
                self.auth_failed = False
                self.buf_lock = __import__("threading").Lock()
                self.output_buf = b""
                self.last_activity = 0
            def read(self):
                with self.buf_lock:
                    d = self.output_buf
                    self.output_buf = b""
                return d
            def unread(self, data):
                if not data:
                    return
                with self.buf_lock:
                    self.output_buf = data + self.output_buf
            def feed(self, b):
                with self.buf_lock:
                    self.output_buf += b
            def echo_off_hint(self):
                return False

        sess = Sess()
        with server.sessions_lock:
            server.sessions[sid] = sess
        try:
            # Raw socket so we can read what's actually arrived without
            # blocking on http.client buffering. We just need to confirm
            # the handler reached its main loop (the ': ok' priming
            # comment was sent).
            s = _socket.create_connection(("127.0.0.1", self.port),
                                          timeout=5)
            req = ("GET /api/stream?session_id=" + sid + " HTTP/1.1\r\n"
                   "Host: 127.0.0.1\r\nConnection: close\r\n\r\n")
            s.sendall(req.encode("ascii"))
            buf = b""
            deadline = time.time() + 2
            s.settimeout(0.2)
            while time.time() < deadline and b": ok" not in buf:
                try:
                    chunk = s.recv(256)
                    if not chunk:
                        break
                    buf += chunk
                except _socket.timeout:
                    pass
            self.assertIn(b": ok", buf,
                "handler did not reach its main loop")

            # Plant bytes, then tear down the client. The handler may
            # either (a) peek FIN first and leave the buffer untouched,
            # or (b) read the bytes, hit a write failure, and unread()
            # them. Both paths must end with the bytes still in the
            # session for the next reader.
            sess.feed(b"do-not-lose-me\r\n")
            try:
                s.shutdown(_socket.SHUT_RDWR)
            except OSError:
                pass
            s.close()

            deadline = time.time() + 3
            recovered = False
            while time.time() < deadline:
                with sess.buf_lock:
                    if b"do-not-lose-me" in sess.output_buf:
                        recovered = True
                        break
                time.sleep(0.05)
            self.assertTrue(recovered,
                "bytes drained by SSE handler were lost when client "
                "disconnected; peek/unread did not preserve them")
        finally:
            with server.sessions_lock:
                server.sessions.pop(sid, None)

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


class TestPromptConnectHTTP(unittest.TestCase):
    """Named /api/connect for Prompt entries — body carries creds, server
    enforces allowed_users / denied_users when no fixed username."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18766
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.tmpdir = tempfile.mkdtemp()
        path = os.path.join(cls.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({
                "connections": [
                    {"name": "free", "host": "free.example.com"},
                    {"name": "wl", "host": "wl.example.com",
                     "allowed_users": ["alice", "bob"]},
                    {"name": "bl", "host": "bl.example.com",
                     "denied_users": ["root"]},
                    {"name": "fixed", "host": "fx.example.com",
                     "username": "ops", "allowed_users": ["neverchecked"]},
                ]
            }, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        os.environ.pop("WEBSH_CONFIG", None)
        import shutil
        shutil.rmtree(cls.tmpdir)

    def setUp(self):
        server._rate_limits.clear()

    def _post(self, path, body):
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{}{}".format(self.port, path)
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data,
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            return json.loads(e.read().decode("utf-8")), e.code

    def _get(self, path):
        from urllib.request import urlopen
        url = "http://127.0.0.1:{}{}".format(self.port, path)
        try:
            resp = urlopen(url, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            return json.loads(e.read().decode("utf-8")), e.code

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


# ── Input validation regexes (slot_id, tmux_cmd) ───────────────────────
# These guard the remote ssh command string, so any hole here is a
# potential RCE on the target. Tests the regex in isolation and then the
# HTTP layer in TestHTTPApi below.

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

class TestIdleTimer(unittest.TestCase):

    def _fake_session(self, age_seconds=10):
        """Build a minimal SSHSession without spawning ssh."""
        s = server.SSHSession.__new__(server.SSHSession)
        s.buf_lock = threading.Lock()
        s.output_buf = b""
        s.last_activity = time.time() - age_seconds
        s.alive = True
        s.master_fd = None
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


# ── Echo-off prompt detection ──────────────────────────────────────────
# Heuristic that hints the client to suppress local-echo prediction at
# prompts where the remote pty disables ECHO (sudo / mysql -p / passwd /
# ssh passphrase / read -s). The local pty between server.py and the ssh
# client is in raw mode regardless of remote ECHO state, so a tail-of-
# output regex is the next-best signal we can derive on the proxy side.

class TestEchoOffHint(unittest.TestCase):

    def _fake_session(self, recent_tail=b""):
        s = server.SSHSession.__new__(server.SSHSession)
        s.buf_lock = threading.Lock()
        s._recent_tail = recent_tail
        return s

    def test_sudo_prompt_matches(self):
        s = self._fake_session(b"[sudo] password for alexey: ")
        self.assertTrue(s.echo_off_hint())

    def test_mysql_prompt_matches(self):
        s = self._fake_session(b"Enter password: ")
        self.assertTrue(s.echo_off_hint())

    def test_ssh_passphrase_matches(self):
        s = self._fake_session(
            b"Enter passphrase for key '/home/u/.ssh/id_rsa': ")
        self.assertTrue(s.echo_off_hint())

    def test_passcode_prompt_matches(self):
        s = self._fake_session(b"Passcode: ")
        self.assertTrue(s.echo_off_hint())

    def test_uppercase_prompt_matches(self):
        s = self._fake_session(b"PASSWORD: ")
        self.assertTrue(s.echo_off_hint())

    def test_colored_prompt_with_sgr_reset_matches(self):
        """Distros and PAM modules sometimes wrap the prompt in ANSI
        SGR sequences (bold, color). The trailing class admits whitespace
        and SGR runs after the colon so these still hit."""
        s = self._fake_session(b"\x1b[1mPassword:\x1b[0m ")
        self.assertTrue(s.echo_off_hint())

    def test_colored_prompt_trailing_sgr_matches(self):
        s = self._fake_session(b"Password: \x1b[0m")
        self.assertTrue(s.echo_off_hint())

    def test_non_prompt_text_after_colon_does_not_match(self):
        """ANSI CSI stripping must not turn non-prompt content into a
        false match — the post-colon content still has to be whitespace
        for the regex's `:\\s*$` anchor to fire."""
        s = self._fake_session(b"Password:\x1b[Knot a prompt")
        self.assertFalse(s.echo_off_hint())

    def test_only_last_line_considered(self):
        """Earlier lines containing the keyword must not trip detection
        — only the line the cursor is on can be a live prompt."""
        s = self._fake_session(
            b"changing password for alexey\nuser@host:~$ ")
        self.assertFalse(s.echo_off_hint())

    def test_prompt_followed_by_newline_does_not_match(self):
        """If the prompt has scrolled past with a trailing newline, the
        cursor is on a fresh line and the user has already moved on."""
        s = self._fake_session(b"[sudo] password for alexey: \n")
        self.assertFalse(s.echo_off_hint())

    def test_word_inside_running_text_does_not_match(self):
        s = self._fake_session(
            b"i could tell you my password but i won't, $ ")
        self.assertFalse(s.echo_off_hint())

    def test_prose_ending_with_password_colon_does_not_match(self):
        """The keyword must be the label of the prompt, not a word
        inside running prose. 'I forgot my password yesterday: ' has
        the keyword and a trailing colon but is clearly not a prompt
        — the conservative regex rejects it because the gap between
        keyword and colon is filled with prose words rather than the
        narrow PAM-style ' for X' shape."""
        s = self._fake_session(b"I forgot my password yesterday: ")
        self.assertFalse(s.echo_off_hint())
        s = self._fake_session(b"echo password is supersecret: ")
        self.assertFalse(s.echo_off_hint())
        s = self._fake_session(b"My password: hunter2 was hacked")
        self.assertFalse(s.echo_off_hint())

    def test_doas_prompt_matches(self):
        """doas, OpenBSD's sudo equivalent, uses the same shape."""
        s = self._fake_session(b"doas (alexey@host) password: ")
        self.assertTrue(s.echo_off_hint())

    def test_passwd_change_prompts_match(self):
        """passwd(1) emits three prompts in sequence."""
        for tail in (b"(current) UNIX password: ",
                     b"New password: ",
                     b"Retype new password: "):
            s = self._fake_session(tail)
            self.assertTrue(s.echo_off_hint(),
                            "expected match on " + repr(tail))

    def test_osc_title_around_prompt_stripped(self):
        """OSC sequences (terminal title updates from PAM modules) must
        not break detection. xterm/gnome-terminal style: ESC ] 0; <title>
        BEL or ST."""
        # OSC with BEL terminator
        s = self._fake_session(b"\x1b]0;sudo prompt\x07Password: ")
        self.assertTrue(s.echo_off_hint())
        # OSC with ST terminator
        s = self._fake_session(b"\x1b]2;Sudo\x1b\\Password: ")
        self.assertTrue(s.echo_off_hint())

    def test_empty_tail(self):
        s = self._fake_session(b"")
        self.assertFalse(s.echo_off_hint())

    def test_shell_prompt_does_not_match(self):
        s = self._fake_session(b"alexey@hetzner-hel:~$ ")
        self.assertFalse(s.echo_off_hint())

    def test_regex_anchored_to_recent_tail_only(self):
        """RECENT_TAIL_MAX bounds prevent unbounded buffer growth and
        keep the regex cheap regardless of session output volume."""
        s = self._fake_session()
        # Lots of preceding output, then a newline, then the prompt —
        # the realistic shape after truncation.
        big = b"some output\n" * 30
        s._recent_tail = (big + b"Password: ")[-server.RECENT_TAIL_MAX:]
        self.assertTrue(s.echo_off_hint())

    def test_tail_grows_then_truncates(self):
        """End-to-end: feeding bytes through the same path the read loop
        uses keeps _recent_tail bounded and still detects a final prompt."""
        s = self._fake_session()
        cap = server.RECENT_TAIL_MAX
        for _ in range(20):
            chunk = b"some shell output line\n"
            s._recent_tail = (s._recent_tail + chunk)[-cap:]
        self.assertLessEqual(len(s._recent_tail), cap)
        prompt = b"\n[sudo] password for alexey: "
        s._recent_tail = (s._recent_tail + prompt)[-cap:]
        self.assertTrue(s.echo_off_hint())


# ── Notification-pipe wait machinery ───────────────────────────────────
# _stream and _output used to busy-poll session.read() at 100 Hz via
# time.sleep(POLL_INTERVAL). They now park in Session.wait_for_data(),
# which selectors-blocks on (notify_pipe, client_socket) until the PTY
# reader signals new data, the client closes, or a deadline elapses.
# Latency drops from ~5 ms median (POLL_INTERVAL/2) to scheduler jitter,
# and idle sessions stop spinning a 100 Hz wakeup loop.

@unittest.skipUnless(server._HAVE_SELECTABLE_PIPES,
                     "notification pipe requires POSIX selectors")
class TestSessionNotify(unittest.TestCase):

    def _fake(self):
        s = server.SSHSession.__new__(server.SSHSession)
        s.buf_lock = threading.Lock()
        s.alive = True
        s.output_buf = b""
        s._recent_tail = b""
        s.last_activity = time.time()
        s.master_fd = None
        s.pid = None
        s._key_file = None
        s._control_path = None
        s._notify_r, s._notify_w = os.pipe()
        os.set_blocking(s._notify_r, False)
        os.set_blocking(s._notify_w, False)
        return s

    def _close_pipe(self, s):
        for attr in ("_notify_r", "_notify_w"):
            fd = getattr(s, attr, None)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(s, attr, None)

    def test_signal_then_wait_returns_immediately(self):
        s = self._fake()
        try:
            s._signal()
            t0 = time.time()
            s.wait_for_data(None, timeout=2.0)
            elapsed = time.time() - t0
            self.assertLess(elapsed, 0.05,
                "wait should return immediately on pre-existing signal; "
                "took {:.1f} ms".format(elapsed * 1000))
        finally:
            self._close_pipe(s)

    def test_wait_blocks_full_timeout_when_unsignaled(self):
        s = self._fake()
        try:
            t0 = time.time()
            s.wait_for_data(None, timeout=0.1)
            elapsed = time.time() - t0
            self.assertGreaterEqual(elapsed, 0.05,
                "wait must actually block, not spin; elapsed {:.1f} ms"
                .format(elapsed * 1000))
            # Upper bound is generous (was 0.30s) — on a heavily-loaded
            # CI runner scheduler jitter alone can push the wakeup well
            # past the timeout. The intent is "doesn't hang forever",
            # not "hits the timeout exactly".
            self.assertLess(elapsed, 1.0,
                "wait shouldn't overshoot; elapsed {:.1f} ms"
                .format(elapsed * 1000))
        finally:
            self._close_pipe(s)

    def test_cross_thread_signal_wakes_within_milliseconds(self):
        """Producer thread signals after a short delay; consumer parked
        in wait_for_data() must wake within tens of ms — this is the
        whole point of the refactor (replaces ~5 ms busy-poll latency)."""
        s = self._fake()
        try:
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
            # Target is <5ms (selectors should wake within tens of µs +
            # scheduler jitter). 200ms is the slow-CI flake margin: on
            # GitHub Actions free tier under contention we've seen 50-
            # 150ms. The test still proves the wait actually blocked
            # via the lower bound below.
            self.assertLess(latency_ms, 200,
                "signal->wakeup latency too high: {:.1f} ms (target <5 ms, "
                "200 ms is the CI-flake margin)".format(latency_ms))
            self.assertGreaterEqual(wakeup - t0, 0.04,
                "consumer woke before producer signaled — false wakeup?")
        finally:
            self._close_pipe(s)

    def test_repeated_signals_coalesce(self):
        """100 K signals on an undrained pipe must not block, raise, or
        leave the pipe in a state where wait_for_data spuriously fires."""
        s = self._fake()
        try:
            for _ in range(100000):
                s._signal()
            # First wait sees the existing signals — should drain them.
            t0 = time.time()
            s.wait_for_data(None, timeout=2.0)
            self.assertLess(time.time() - t0, 0.10)
            # Second wait must actually block (drain emptied the pipe).
            t0 = time.time()
            s.wait_for_data(None, timeout=0.1)
            self.assertGreaterEqual(time.time() - t0, 0.05)
        finally:
            self._close_pipe(s)

    def test_wait_returns_when_client_socket_has_fin(self):
        """The selector also watches the client socket so a peer FIN
        wakes the consumer immediately instead of waiting on the
        keepalive deadline. We simulate FIN by half-closing one end of
        a socketpair and passing the other to wait_for_data."""
        import socket
        a, b = socket.socketpair()
        s = self._fake()
        try:
            b.shutdown(socket.SHUT_WR)
            t0 = time.time()
            s.wait_for_data(a, timeout=2.0)
            elapsed = time.time() - t0
            self.assertLess(elapsed, 0.10,
                "FIN must wake wait_for_data; took {:.1f} ms"
                .format(elapsed * 1000))
        finally:
            a.close()
            b.close()
            self._close_pipe(s)

    def test_signal_after_pipe_torn_down_is_noop(self):
        """close() may race with another thread calling _signal — the
        signal must absorb EBADF rather than crashing the reader."""
        s = self._fake()
        self._close_pipe(s)
        s._signal()
        s._signal()  # idempotent

    def test_wait_after_pipe_torn_down_falls_back(self):
        """After teardown, wait_for_data falls back to a brief sleep
        instead of spinning at selector-error rate."""
        s = self._fake()
        self._close_pipe(s)
        t0 = time.time()
        s.wait_for_data(None, timeout=0.5)
        elapsed = time.time() - t0
        self.assertLess(elapsed, 0.10,
            "torn-down pipe must short-circuit the wait; elapsed {:.1f} ms"
            .format(elapsed * 1000))

    def test_zero_timeout_returns_immediately(self):
        s = self._fake()
        try:
            t0 = time.time()
            s.wait_for_data(None, timeout=0)
            self.assertLess(time.time() - t0, 0.01)
        finally:
            self._close_pipe(s)

    def test_close_does_not_close_pipe_fds(self):
        """Regression guard: Session.close() must NOT call os.close on
        the notification pipes. Fd lifetime is bound to GC so concurrent
        _signal()/wait_for_data callers can't race with fd reuse. If a
        future patch adds an explicit close in close(), this test fails
        loudly. See the design comment in Session.__init__."""
        # Build a Session shell that has just the bits close() touches.
        s = server.SSHSession.__new__(server.SSHSession)
        s.alive = True
        s._notify_r, s._notify_w = os.pipe()
        os.set_blocking(s._notify_r, False)
        os.set_blocking(s._notify_w, False)
        # close() needs a real child pid (not 0 — kill(0, sig) signals
        # the entire process group, including this test runner). Fork
        # a stub that exits immediately; close() will reap it.
        s.master_fd, slave_fd = os.pipe()
        os.close(slave_fd)  # close() will close master_fd; that's fine.
        child_pid = os.fork()
        if child_pid == 0:
            os._exit(0)
        s.pid = child_pid
        s._key_file = None
        s._control_path = None
        try:
            s.close()
            # Both pipe fds must still be open. fstat raises OSError if not.
            os.fstat(s._notify_r)
            os.fstat(s._notify_w)
            # And _signal() must still work without raising.
            s._signal()
        finally:
            for fd in (s._notify_r, s._notify_w):
                try:
                    os.close(fd)
                except OSError:
                    pass

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

        try:
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
        finally:
            self._close_pipe(s)

    def test_pipe_fds_closed_by_finalizer(self):
        """Pipe fds are NOT closed in Session.close() — they're tied to
        Session GC via weakref.finalize. This closes the fd-reuse race
        where a reader thread's _signal() could land in a freshly-
        allocated unrelated fd. The price is a brief leak between
        close() and the next GC pass; verify here that GC actually
        does close them."""
        import gc
        # Build a real Session (skipping __init__'s ssh-spawn) so the
        # finalizer is registered. _fake() doesn't register one because
        # it bypasses __init__.
        s = server.SSHSession.__new__(server.SSHSession)
        s.buf_lock = threading.Lock()
        s.alive = True
        s.output_buf = b""
        s._recent_tail = b""
        s.last_activity = time.time()
        s.master_fd = None
        s.pid = None
        s._key_file = None
        s._control_path = None
        s._notify_r, s._notify_w = os.pipe()
        os.set_blocking(s._notify_r, False)
        os.set_blocking(s._notify_w, False)
        weakref.finalize(s, server._close_pipe_fds,
                         s._notify_r, s._notify_w)
        r, w = s._notify_r, s._notify_w
        # Both fds should be open right now.
        os.fstat(r); os.fstat(w)
        # Drop the only reference and force collection.
        del s
        gc.collect()
        # Finalizer should have closed both fds.
        with self.assertRaises(OSError):
            os.fstat(r)
        with self.assertRaises(OSError):
            os.fstat(w)

    def test_wait_with_cached_selector_fast_path(self):
        """Hot-loop scenario: caller pre-builds a selector with notify_r
        registered and reuses it across many wait_for_data calls. This
        avoids per-call epoll_create1+ctl+close overhead. Verify the
        wakeup contract still holds when this path is exercised."""
        s = self._fake()
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(s._notify_r, selectors.EVENT_READ)
                # Pre-existing signal: cached selector path drains the
                # pipe and returns immediately, just like the one-shot
                # path.
                s._signal()
                t0 = time.time()
                s.wait_for_data(None, timeout=2.0, selector=sel)
                self.assertLess(time.time() - t0, 0.05)
                # Drained by previous wait → next wait must block.
                t0 = time.time()
                s.wait_for_data(None, timeout=0.1, selector=sel)
                self.assertGreaterEqual(time.time() - t0, 0.05)
                # And cross-thread signal still wakes it up via the
                # cached selector.
                feed_time = []

                def producer():
                    time.sleep(0.05)
                    feed_time.append(time.time())
                    s._signal()

                threading.Thread(target=producer, daemon=True).start()
                t0 = time.time()
                s.wait_for_data(None, timeout=2.0, selector=sel)
                self.assertEqual(len(feed_time), 1)
                latency_ms = (time.time() - feed_time[0]) * 1000
                # Same generous CI margin as the one-shot path — see
                # test_cross_thread_signal_wakes_within_milliseconds.
                self.assertLess(latency_ms, 200,
                    "cached-selector signal->wakeup: {:.1f} ms"
                    .format(latency_ms))
        finally:
            self._close_pipe(s)


# ── HTTP-level validation of slot_id + tmux_cmd ────────────────────────
# Separate class so we can start the server *without* restrict_hosts;
# slot_id/tmux_cmd validation happens before any host/connection check,
# so responses are deterministic 400s.

class TestConnectValidation(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.port = 18767
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.tmpdir = tempfile.mkdtemp()
        # No restrict_hosts, no connections — tests only exercise the
        # early-validation codepath.
        path = os.path.join(cls.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({"connections": []}, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        os.environ.pop("WEBSH_CONFIG", None)
        import shutil
        shutil.rmtree(cls.tmpdir)

    def setUp(self):
        # Rate limiter is process-global; clear it between tests so a
        # handful of POSTs don't exhaust the budget.
        server._rate_limits.clear()

    def _post(self, path, body):
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{0}{1}".format(self.port, path)
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data,
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            if hasattr(e, 'read'):
                return json.loads(e.read().decode("utf-8")), e.code
            raise

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
            'exec tmux new-session -A -D -s websh-alice -- "$SHELL" -l')

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
            'exec tmux new-session -A -D -s websh-alice -- "$SHELL" -l'))

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
        whether the session was newly created or re-attached."""
        cmd = server._build_remote_command(
            "ok", "tmux", 0,
            tmux_options=[("mouse", "on"), ("set-clipboard", "on"),
                          ("history-limit", "100000")])
        self.assertIn(
            'new-session -A -D -s websh-ok -- "$SHELL" -l'
            ' \\; set -g mouse on'
            ' \\; set -g set-clipboard on'
            ' \\; set -g history-limit 100000',
            cmd)

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
            tmux_options=[("mouse", "off"), ("history-limit", "50000")]))
        self.assertTrue(ok, "sh -n rejected with tmux_options: " + err)


# ── _validate_tmux_options ─────────────────────────────────────────────

class TestValidateTmuxOptions(unittest.TestCase):
    """The /api/connect body is untrusted — only the keys/values listed
    in _TMUX_BOOL_OPTS / _TMUX_INT_OPTS may flow into the tmux command,
    and only with values that pass the type/range checks. Everything
    else must be silently dropped (we don't want to fail a connect over
    a stale toggle from a future client)."""

    def test_bool_true_becomes_on(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_mouse": True}),
            [("mouse", "on")])

    def test_bool_false_becomes_off(self):
        self.assertEqual(
            server._validate_tmux_options({"tmux_mouse": False}),
            [("mouse", "off")])

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
                server._validate_tmux_options({"tmux_mouse": v}), [],
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
            "tmux_mouse": True,
        }
        self.assertEqual(
            server._validate_tmux_options(body), [("mouse", "on")])

    def test_combined_body(self):
        body = {
            "tmux_mouse": True,
            "tmux_set_clipboard": False,
            "tmux_history_limit": 200000,
        }
        self.assertEqual(
            server._validate_tmux_options(body),
            [("mouse", "on"),
             ("set-clipboard", "off"),
             ("history-limit", "200000")])


# Fake tmux used by TestWatchdogRuntime — simulates has-session,
# display, kill-session, new-session using a files-on-disk state
# store so we can inspect what the watchdog actually does.
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
        import shutil
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
        # branch resets the seen-file each poll.
        time.sleep(3.0)
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
                      alive=True, master_fd=None, control_path=None):
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
            slot_id="ok", master_fd=None,
            control_path="/nonexistent/websh-mux-xxxx.sock")
        called = {"n": 0}
        def fake_run(cmd, **kw):
            called["n"] += 1
            class R:
                returncode = 0
            return R()
        # master_fd is None so the fallback path's os.write would raise,
        # but alive check short-circuits it when we flip alive=False.
        s.alive = False
        with unittest.mock.patch.object(server.subprocess, "run", fake_run):
            s.terminate_remote_tmux()
        self.assertEqual(called["n"], 0)


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
        s.master_fd = None
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


class TestTmuxOptionsHTTPDispatch(unittest.TestCase):
    """HTTP-level dispatch for POST /api/tmux_options — checks routing,
    body validation, and unknown-session handling. Live ssh is mocked
    via push_tmux_options."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18768
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(
            target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _post(self, path, body):
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{}{}".format(self.port, path)
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data,
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            if hasattr(e, "read"):
                return json.loads(e.read().decode("utf-8")), e.code
            raise

    def test_unknown_session_404(self):
        body, code = self._post("/api/tmux_options",
                                {"session_id": str(uuid.uuid4()),
                                 "tmux_mouse": True})
        self.assertEqual(code, 404)

    def test_invalid_session_id_404(self):
        body, code = self._post("/api/tmux_options",
                                {"session_id": "not-a-uuid",
                                 "tmux_mouse": True})
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
                "tmux_mouse": True,
                "tmux_set_clipboard": False,
                "tmux_history_limit": 50000,
                # Garbage that must be dropped by validation, never passed
                # through to the session:
                "tmux_evil": "rm -rf /",
                "tmux_status": "on",
            })
            self.assertEqual(code, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(set(body["applied"]),
                             {"mouse", "set-clipboard", "history-limit"})
            self.assertIn(("mouse", "on"), captured["opts"])
            self.assertIn(("set-clipboard", "off"), captured["opts"])
            self.assertIn(("history-limit", "50000"), captured["opts"])
            self.assertEqual(len(captured["opts"]), 3)
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
                                    {"session_id": sid, "tmux_mouse": True})
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
        s.master_fd = None
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

    def test_no_extension_increment_strips_prior_suffix(self):
        """Regression: the no-extension branch of the auto-increment
        loop must strip a prior `(n)` before appending the next one,
        matching the JS client's makeUploadMvCmd. Otherwise repeated
        collisions on a name like `Makefile` produce `Makefile(1)(2)(3)`
        instead of `Makefile(1)`, `Makefile(2)`, `Makefile(3)`."""
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
            # The fixed pattern uses ${f%(*)} to drop any prior `(n)`
            # before appending the new one.
            self.assertIn('${f%(*)}($n)', remote)
            # The buggy pattern f="$f($n)" must not be present.
            self.assertNotIn('f="$f($n)"', remote)
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
        s.master_fd = None
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


class TestUploadFinalizeHTTPDispatch(unittest.TestCase):
    """HTTP-level dispatch for /api/upload_finalize and /api/upload_cancel.
    The session methods are mocked; we're testing routing, body
    validation, and the non_persistent-vs-error response shape."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18769
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(
            target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _post(self, path, body):
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{}{}".format(self.port, path)
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data,
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            if hasattr(e, "read"):
                return json.loads(e.read().decode("utf-8")), e.code
            raise

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


class TestUploadPathNULRejection(unittest.TestCase):
    """The /api/upload validator rejects \\x00 in rel_path because bash
    silently truncates NUL bytes in variable values, which would land
    a file at a different name than the client asked for."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18770
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(
            target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

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


class TestDisconnectTerminateFlag(unittest.TestCase):
    """HTTP-level: /api/disconnect routes the terminate flag correctly."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18768
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.tmpdir = tempfile.mkdtemp()
        path = os.path.join(cls.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({"connections": []}, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0
        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        os.environ.pop("WEBSH_CONFIG", None)
        import shutil
        shutil.rmtree(cls.tmpdir)

    def setUp(self):
        with server.sessions_lock:
            server.sessions.clear()

    def tearDown(self):
        with server.sessions_lock:
            server.sessions.clear()

    def _post(self, path, body):
        from urllib.request import urlopen, Request
        url = "http://127.0.0.1:{0}{1}".format(self.port, path)
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data,
                      headers={"Content-Type": "application/json"})
        try:
            resp = urlopen(req, timeout=5)
            return json.loads(resp.read().decode("utf-8")), resp.getcode()
        except Exception as e:
            if hasattr(e, "read"):
                return json.loads(e.read().decode("utf-8")), e.code
            raise

    def _seed_fake(self, sid, persistent=True):
        s = server.SSHSession.__new__(server.SSHSession)
        s.id = sid
        s.persistent = persistent
        s.slot_id = "ok" if persistent else None
        s.alive = True
        s.master_fd = None
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


class TestEndToEndPersistent(unittest.TestCase):
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

    _skip_reason = None

    @classmethod
    def setUpClass(cls):
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
        """Regression: the find -printf format must end with \\0 so that
        embedded newlines in filenames don't corrupt the listing."""
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
        self.assertIn(r'%y\t%s\t%Ts\t%f\0', captured["remote"])
        self.assertNotIn(r'%y\t%s\t%Ts\t%f\n', captured["remote"])

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


class TestLsHTTPDispatch(unittest.TestCase):
    """HTTP-level tests for GET /api/ls."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18781
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(
            target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _get(self, qs):
        from urllib.request import urlopen
        url = "http://127.0.0.1:{}/api/ls?{}".format(self.port, qs)
        try:
            with urlopen(url) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if hasattr(e, 'read'):
                return json.loads(e.read())
            raise

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


class TestDownloadHTTPDispatch(unittest.TestCase):
    """HTTP-level tests for GET /api/download."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18782
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.thread = threading.Thread(
            target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _url(self, qs):
        return "http://127.0.0.1:{}/api/download?{}".format(self.port, qs)

    def _get_json(self, qs):
        from urllib.request import urlopen
        try:
            with urlopen(self._url(qs)) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if hasattr(e, 'read'):
                return json.loads(e.read())
            raise

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
        self.assertGreater(fake_session.last_activity, 0)


if __name__ == "__main__":
    unittest.main()
