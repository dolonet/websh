#!/usr/bin/env python3
"""Tests for websh server.py — config loading, public view, connection kinds, denied hosts, user lists.

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


class TestConfigLoading(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        server._config_cache = None
        server._config_mtime = 0

    def tearDown(self):
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

        # Rewrite, then bump mtime explicitly so the cache reload
        # check observes a strictly-later timestamp. Using os.utime
        # instead of a sleep avoids ~100 ms of wall-clock dead time
        # and is deterministic on filesystems with 1 s mtime
        # resolution.
        self._write_config({
            "connections": [{"name": "v2", "host": "b.com"}]
        })
        path = os.path.join(self.tmpdir, "websh.json")
        st = os.stat(path)
        os.utime(path, (st.st_atime, st.st_mtime + 1))

        cfg2 = server.load_config()
        self.assertEqual(cfg2["connections"][0]["name"], "v2")


    def test_plaintext_password_emits_deprecation_warn(self):
        self._write_config({
            "connections": [
                {"name": "Production", "host": "p", "username": "u",
                 "password": "secret"},
                {"name": "Staging",    "host": "s", "username": "u"},
                {"name": "Dev",        "host": "d", "username": "u",
                 "key": "-----BEGIN----"},
            ]
        })
        with unittest.mock.patch.object(server, "_log") as mock_log:
            os.environ["WEBSH_CONFIG"] = os.path.join(self.tmpdir,
                                                       "websh.json")
            server._config_cache = None
            server._config_mtime = 0
            server.load_config()
            warnings = [c for c in mock_log.call_args_list
                        if c.args[0] == "WARN"
                        and "plaintext credentials" in c.args[1]]
            self.assertEqual(len(warnings), 1)
            msg = warnings[0].args[1]
            self.assertIn("Production", msg)
            self.assertIn("Dev", msg)
            self.assertNotIn("Staging", msg)

    def test_clean_config_no_deprecation_warn(self):
        self._write_config({
            "connections": [
                {"name": "Staging", "host": "s", "username": "u"},
            ]
        })
        with unittest.mock.patch.object(server, "_log") as mock_log:
            os.environ["WEBSH_CONFIG"] = os.path.join(self.tmpdir,
                                                       "websh.json")
            server._config_cache = None
            server._config_mtime = 0
            server.load_config()
            warns = [c for c in mock_log.call_args_list
                     if c.args[0] == "WARN"
                     and "plaintext credentials" in c.args[1]]
            self.assertEqual(warns, [])

    def test_require_vault_makes_plaintext_a_startup_error(self):
        self._write_config({
            "connections": [
                {"name": "Production", "host": "p", "username": "u",
                 "password": "secret"},
            ]
        })
        original = server.WEBSH_REQUIRE_VAULT
        try:
            server.WEBSH_REQUIRE_VAULT = True
            os.environ["WEBSH_CONFIG"] = os.path.join(self.tmpdir,
                                                       "websh.json")
            server._config_cache = None
            server._config_mtime = 0
            with self.assertRaises(SystemExit) as ctx:
                server.load_config()
            self.assertEqual(ctx.exception.code, 1)
        finally:
            server.WEBSH_REQUIRE_VAULT = original


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

    # ── authorize_target: gate for connects with no `connection` name
    #    (saved vault cards + free-form manual POSTs) ──

    def test_authorize_unrestricted_allows_manual_and_saved(self):
        """restrict_hosts off: a manual POST and a saved vault card are
        both allowed when the host is not deny-listed."""
        self._write_config({"restrict_hosts": False, "connections": []})
        self.assertEqual(
            server.authorize_target("any.com", 22, "root", is_saved=False),
            (True, None))
        self.assertEqual(
            server.authorize_target("any.com", 22, "root", is_saved=True),
            (True, None))

    def test_authorize_manual_rejected_under_restrict_hosts(self):
        """restrict_hosts on: a free-form manual POST is always rejected,
        even to a configured host — it must use the named connection."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "hel", "host": "h.example",
                             "port": 22, "username": ""}],
        })
        ok, err = server.authorize_target("h.example", 22, "alice",
                                          is_saved=False)
        self.assertFalse(ok)
        self.assertEqual(err, "connections to this host are not allowed")

    def test_authorize_saved_card_matches_named_prompt_connection(self):
        """A saved vault card whose host:port matches a named prompt
        connection is authorized under restrict_hosts, even though it
        carries no `connection` name."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "hel", "host": "h.example",
                             "port": 22, "username": "",
                             "denied_users": ["root"]}],
        })
        self.assertEqual(
            server.authorize_target("h.example", 22, "alice", is_saved=True),
            (True, None))

    def test_authorize_saved_card_rejected_when_host_not_configured(self):
        """A saved vault card to a host with no matching named connection
        stays rejected under restrict_hosts."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "hel", "host": "h.example",
                             "port": 22, "username": ""}],
        })
        ok, err = server.authorize_target("other.example", 22, "alice",
                                          is_saved=True)
        self.assertFalse(ok)
        self.assertEqual(err, "connections to this host are not allowed")

    def test_authorize_saved_card_honors_denied_users(self):
        """A saved vault card matching a prompt connection is still
        subject to that connection's denied_users list."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "hel", "host": "h.example",
                             "port": 22, "username": "",
                             "denied_users": ["root"]}],
        })
        ok, err = server.authorize_target("h.example", 22, "root",
                                          is_saved=True)
        self.assertFalse(ok)
        self.assertEqual(err, "username is not allowed on this connection")

    def test_authorize_saved_card_honors_allowed_users(self):
        """allowed_users on the matched prompt connection constrains the
        saved card's username."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "hel", "host": "h.example",
                             "port": 22, "username": "",
                             "allowed_users": ["alice"]}],
        })
        self.assertEqual(
            server.authorize_target("h.example", 22, "alice", is_saved=True),
            (True, None))
        ok, _ = server.authorize_target("h.example", 22, "bob", is_saved=True)
        self.assertFalse(ok)

    def test_authorize_saved_card_pinned_to_fixed_username(self):
        """When the matched prompt connection fixes a username, a saved
        card with a different username does not slip past restrict_hosts."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "hel", "host": "h.example",
                             "port": 22, "username": "deploy"}],
        })
        self.assertEqual(
            server.authorize_target("h.example", 22, "deploy", is_saved=True),
            (True, None))
        ok, _ = server.authorize_target("h.example", 22, "intruder",
                                        is_saved=True)
        self.assertFalse(ok)

    def test_authorize_saved_card_hint_selects_named_connection(self):
        """When two prompt connections share host:port, the client-supplied
        connection hint selects the exact one — deterministic, not the
        file-order first match (resolves the ambiguity in #74)."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [
                {"name": "primary", "host": "h.example", "port": 22,
                 "username": "", "denied_users": ["alice"]},
                {"name": "secondary", "host": "h.example", "port": 22,
                 "username": "", "allowed_users": ["alice"]},
            ],
        })
        # No hint → first match ('primary') governs → alice denied.
        ok, _ = server.authorize_target("h.example", 22, "alice",
                                        is_saved=True)
        self.assertFalse(ok)
        # Hint to 'secondary' → that connection governs → alice allowed.
        self.assertEqual(
            server.authorize_target("h.example", 22, "alice", is_saved=True,
                                    conn_hint="secondary"),
            (True, None))
        # An empty hint (what the call site sends after .strip() of a blank
        # `connection`) is falsy → falls back to the first host:port match.
        ok, _ = server.authorize_target("h.example", 22, "alice",
                                        is_saved=True, conn_hint="")
        self.assertFalse(ok)

    def test_authorize_saved_card_hint_ignored_when_host_mismatch(self):
        """Security: the client-supplied hint can only disambiguate among
        connections that match the card's (server-resolved) host:port. A hint
        pointing at a different host is ignored — it must not borrow that
        connection's policy (which would bypass denied_users)."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [
                {"name": "host-a", "host": "a.example", "port": 22,
                 "username": "", "denied_users": ["bob"]},
                {"name": "host-b", "host": "b.example", "port": 22,
                 "username": "", "allowed_users": ["bob"]},
            ],
        })
        # Card targets host A (denies bob); hint claims 'host-b' (allows bob).
        # The hint is ignored — host-a's denied_users still applies.
        ok, err = server.authorize_target("a.example", 22, "bob",
                                          is_saved=True, conn_hint="host-b")
        self.assertFalse(ok)
        self.assertEqual(err, "username is not allowed on this connection")

    def test_authorize_saved_card_hint_cannot_reach_unconfigured_host(self):
        """Security: a hint to a real connection cannot authorize a card whose
        host matches no connection — restrict_hosts stays un-bypassable by
        attaching a permissive connection name to an arbitrary saved card."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "real", "host": "ok.example",
                             "port": 22, "username": ""}],
        })
        ok, err = server.authorize_target("evil.example", 22, "alice",
                                          is_saved=True, conn_hint="real")
        self.assertFalse(ok)
        self.assertEqual(err, "connections to this host are not allowed")

    def test_authorize_saved_card_host_match_case_insensitive(self):
        """A saved card whose host casing differs from websh.json still
        matches its prompt connection (denied_hosts already casefolds)."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "hel", "host": "h.example", "port": 22,
                             "username": "", "allowed_users": ["alice"]}],
        })
        self.assertEqual(
            server.authorize_target("H.Example", 22, "alice", is_saved=True),
            (True, None))

    def test_authorize_saved_card_host_match_not_unicode_casefolded(self):
        """Host match uses .lower() (the denied_hosts convention), NOT
        .casefold() — casefold over-collapses distinct IDN labels (German
        'straße' → 'strasse', Turkish dotless-i, Greek final sigma), which
        would let a card escape restrict_hosts to a different, unconfigured
        host that merely casefold-collides with a configured one."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "idn", "host": "strasse.example",
                             "port": 22, "username": "",
                             "allowed_users": ["root"]}],
        })
        # 'straße.example'.casefold() == 'strasse.example', but they are
        # different DNS names — must NOT match.
        ok, err = server.authorize_target("straße.example", 22, "root",
                                          is_saved=True)
        self.assertFalse(ok)
        self.assertEqual(err, "connections to this host are not allowed")

    def test_authorize_saved_card_not_matched_to_ready_connection(self):
        """A `ready` (fixed-credential) connection is never matched for a
        saved card — those connect with operator-stored creds, not a user's
        card. A card targeting a ready connection's host:port is rejected."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "r", "host": "r.example", "port": 22,
                             "username": "svc", "password": "p"}],
        })
        ok, err = server.authorize_target("r.example", 22, "svc",
                                          is_saved=True)
        self.assertFalse(ok)
        self.assertEqual(err, "connections to this host are not allowed")

    def test_authorize_saved_card_rejected_on_port_mismatch(self):
        """A card whose port differs from the prompt connection's is not
        matched (host alone is not enough)."""
        self._write_config({
            "restrict_hosts": True,
            "connections": [{"name": "p", "host": "h.example", "port": 2222,
                             "username": ""}],
        })
        ok, err = server.authorize_target("h.example", 22, "alice",
                                          is_saved=True)
        self.assertFalse(ok)
        self.assertEqual(err, "connections to this host are not allowed")

    def test_authorize_saved_card_deny_listed_when_restrict_off(self):
        """restrict_hosts off: a saved card is gated by the deny-list, like a
        manual connect — a deny-listed host is rejected."""
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["bad.example"],
            "connections": [],
        })
        ok, err = server.authorize_target("bad.example", 22, "alice",
                                          is_saved=True)
        self.assertFalse(ok)
        self.assertEqual(err, "connections to this host are not allowed")


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

    def test_strips_ipv6_brackets_before_resolution(self):
        """`getaddrinfo("[::1]")` raises gaierror on glibc — without bracket
        stripping, an attacker writes `[::1]` and resolution fails open,
        slipping past the deny-list. Verify _resolve_host_ips passes the
        bracket-less form to getaddrinfo."""
        captured = []

        def fake_gai(host, *args, **kwargs):
            captured.append(host)
            return [(None, None, None, None, ("::1", 0, 0, 0))]

        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        side_effect=fake_gai):
            ips = server._resolve_host_ips("[::1]")
        self.assertEqual(captured, ["::1"])
        self.assertEqual([str(ip) for ip in ips], ["::1"])

    def test_brackets_only_stripped_when_well_formed(self):
        """Stray opening bracket without closing must NOT be stripped —
        `[evil` should still be passed to getaddrinfo as-is so DNS is
        the only thing that decides."""
        captured = []

        def fake_gai(host, *args, **kwargs):
            captured.append(host)
            raise server.socket.gaierror

        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        side_effect=fake_gai):
            server._resolve_host_ips("[evil")
            server._resolve_host_ips("evil]")
        self.assertEqual(captured, ["[evil", "evil]"])

    def test_empty_brackets_does_not_strip_to_empty(self):
        """Literal `"[]"` must not strip to `""`. Otherwise the resolver
        would call `getaddrinfo("")` (gaierror) and the deny-list would
        fall open. The bracket-strip predicate is `len(h) > 2`, so `"[]"`
        is left unmodified and behaves like any other malformed input."""
        self.assertEqual(server._normalize_host("[]"), "[]")
        captured = []

        def fake_gai(host, *args, **kwargs):
            captured.append(host)
            raise server.socket.gaierror

        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        side_effect=fake_gai):
            server._resolve_host_ips("[]")
        self.assertEqual(captured, ["[]"])

    def test_ipv4_mapped_ipv6_yields_both_forms(self):
        """`::ffff:127.0.0.1` is the IPv6 representation of the IPv4
        address 127.0.0.1; an operator's `denied_hosts: ["127.0.0.0/8"]`
        must block it. Verify the resolver returns BOTH the v6 form and
        the unwrapped v4 form (in that order — v6 from getaddrinfo, then
        the IPv4 buddy appended) so the deny-list iteration sees both.

        Compare via `ipaddress.ip_address`, not strings: the canonical
        compressed IPv6 form for `::ffff:10.5.6.7` is implementation-
        defined (CPython has shifted between `"::ffff:a05:607"` and the
        dotted-quad form across versions), so a string-equality assert
        is brittle. Comparing parsed addresses is stable."""
        infos = [
            (None, None, None, None, ("::ffff:10.5.6.7", 0, 0, 0)),
        ]
        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        return_value=infos):
            ips = server._resolve_host_ips("foo.example")
        # Order matters: getaddrinfo's v6 first, synthesised v4 second.
        self.assertEqual(len(ips), 2)
        self.assertEqual(ips[0], server.ipaddress.ip_address("::ffff:10.5.6.7"))
        self.assertEqual(ips[1], server.ipaddress.ip_address("10.5.6.7"))

    def test_pure_ipv6_does_not_synth_ipv4(self):
        """An ordinary IPv6 address has no ipv4_mapped buddy and the
        resolver shouldn't invent one."""
        infos = [
            (None, None, None, None, ("2001:db8::1", 0, 0, 0)),
        ]
        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        return_value=infos):
            ips = server._resolve_host_ips("foo.example")
        self.assertEqual([str(ip) for ip in ips], ["2001:db8::1"])


class TestDeniedHosts(unittest.TestCase):
    """End-to-end deny-list behaviour at is_host_allowed boundary."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
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

    def test_hostname_exact_match_bypass_via_brackets(self):
        """End-to-end regression: target `[localhost]` must be denied
        when `denied_hosts: ["localhost"]` is configured (hostname-only,
        no CIDR). Pre-fix, the bracket-strip lived only inside
        `_resolve_host_ips`, so the hostname-exact-match step at the
        top of `_is_denied_host` saw `"[localhost]"` (miss), `net_list`
        was empty, and the function returned False without ever
        resolving — full bypass.

        We patch `_resolve_host_ips` to a benign IP so that if the
        hostname-exact-match step misses (the regression we guard
        against), the resolution path doesn't accidentally rescue us."""
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["localhost"],
        })
        with self._patched_resolve("8.8.8.8"):
            self.assertFalse(server.is_host_allowed("[localhost]", 22, "u"))

    def test_ipv6_brackets_target_blocked_by_loopback_cidr(self):
        """End-to-end regression: target `[::1]` must be denied when
        `::1/128` (or `127.0.0.0/8` for the IPv4-mapped form) is in
        denied_hosts. Pre-fix, `getaddrinfo("[::1]")` raised gaierror
        and the request fell open."""
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["::1/128"],
        })

        def fake_gai(host, *args, **kwargs):
            # Mirror real getaddrinfo: "[::1]" raises, "::1" resolves.
            if host == "[::1]":
                raise server.socket.gaierror
            return [(None, None, None, None, ("::1", 0, 0, 0))]

        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        side_effect=fake_gai):
            self.assertFalse(server.is_host_allowed("[::1]", 22, "u"))

    def test_ipv4_mapped_ipv6_blocked_by_ipv4_cidr(self):
        """End-to-end regression: target `::ffff:10.5.6.7` must be
        denied when `10.0.0.0/8` is in denied_hosts (RFC 4291 §2.5.5.2:
        the lower 32 bits ARE the IPv4 address)."""
        self._write_config({
            "restrict_hosts": False,
            "denied_hosts": ["10.0.0.0/8"],
        })
        infos = [(None, None, None, None, ("::ffff:10.5.6.7", 0, 0, 0))]
        with unittest.mock.patch.object(server.socket, "getaddrinfo",
                                        return_value=infos):
            self.assertFalse(
                server.is_host_allowed("looks-public.example", 22, "u"))


class TestConnectionKinds(unittest.TestCase):
    """Classification of connections[] entries as Ready vs Prompt."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        server._config_cache = None
        server._config_mtime = 0

    def tearDown(self):
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
        shutil.rmtree(self.tmpdir)
        os.environ.pop("WEBSH_CONFIG", None)

    def test_kind_exposed_secrets_stripped(self):
        path = os.path.join(self.tmpdir, "websh.json")
        with open(path, "w") as f:
            json.dump({"connections": [
                {"name": "r", "host": "h", "username": "u",
                 "password": "p", "key": "-----BEGIN KEY-----"},
                {"name": "p", "host": "h2", "allowed_users": ["a"]},
            ]}, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0

        pub = server.config_public()
        r, p = pub["connections"]
        self.assertEqual(r["kind"], "ready")
        self.assertNotIn("password", r)
        self.assertNotIn("key", r)
        self.assertNotIn("allowed_users", r)
        self.assertEqual(p["kind"], "prompt")
        self.assertEqual(p["allowed_users"], ["a"])

    def _config_with(self, extra):
        path = os.path.join(self.tmpdir, "websh.json")
        body = {"connections": []}
        body.update(extra)
        with open(path, "w") as f:
            json.dump(body, f)
        os.environ["WEBSH_CONFIG"] = path
        server._config_cache = None
        server._config_mtime = 0
        return server.config_public()

    def test_form_defaults_passed_through(self):
        pub = self._config_with({"form_defaults": {
            "host": " 192.0.2.10 ", "port": 22, "username": "deploy"}})
        self.assertEqual(pub["form_defaults"],
                         {"host": "192.0.2.10", "port": 22,
                          "username": "deploy"})

    def test_form_defaults_field_level_validation(self):
        # Bad types/ranges drop the FIELD, never the response; a section
        # with nothing valid left is omitted entirely.
        pub = self._config_with({"form_defaults": {
            "host": 12345,            # not a string -> dropped
            "port": "22",             # not an int -> dropped
            "username": "x" * 65,     # over-long -> dropped
        }})
        self.assertNotIn("form_defaults", pub)
        pub = self._config_with({"form_defaults": {
            "host": "ok.example", "port": 99999}})   # port out of range
        self.assertEqual(pub["form_defaults"], {"host": "ok.example"})
        # bool is an int subclass in Python; must NOT pass as a port.
        pub = self._config_with({"form_defaults": {"port": True}})
        self.assertNotIn("form_defaults", pub)
        # Port boundaries: 1 and 65535 pass, 0 and floats don't.
        pub = self._config_with({"form_defaults": {"port": 1}})
        self.assertEqual(pub["form_defaults"], {"port": 1})
        pub = self._config_with({"form_defaults": {"port": 65535}})
        self.assertEqual(pub["form_defaults"], {"port": 65535})
        pub = self._config_with({"form_defaults": {"port": 0}})
        self.assertNotIn("form_defaults", pub)
        pub = self._config_with({"form_defaults": {"port": 22.0}})
        self.assertNotIn("form_defaults", pub)
        # Whitespace-only host is as good as absent.
        pub = self._config_with({"form_defaults": {"host": "   "}})
        self.assertNotIn("form_defaults", pub)

    def test_form_defaults_non_dict_ignored(self):
        pub = self._config_with({"form_defaults": ["not", "a", "dict"]})
        self.assertNotIn("form_defaults", pub)
        pub = self._config_with({})
        self.assertNotIn("form_defaults", pub)


if __name__ == "__main__":
    unittest.main()
