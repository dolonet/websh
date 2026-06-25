#!/usr/bin/env python3
"""Tests for websh server.py — vault load/write/save/delete, connect-saved, authz, crypto-gated flows.

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


class TestVaultGate(unittest.TestCase):
    """HAS_CRYPTOGRAPHY flag, _vault_disabled flag, and the combined
    vault_enabled mirror in config_public()."""

    def test_has_cryptography_is_bool(self):
        self.assertIsInstance(server.HAS_CRYPTOGRAPHY, bool)

    def test_vault_disabled_defaults_false(self):
        self.assertIsInstance(server._vault_disabled, bool)
        self.assertFalse(server._vault_disabled)

    def test_config_public_exposes_vault_enabled(self):
        cfg = server.config_public()
        self.assertIn("vault_enabled", cfg)
        self.assertEqual(cfg["vault_enabled"],
                         server.HAS_CRYPTOGRAPHY
                         and server.WEBSH_VAULT_ENABLE
                         and not server._vault_disabled)

    def test_vault_enabled_false_when_crypto_missing(self):
        original = server.HAS_CRYPTOGRAPHY
        try:
            server.HAS_CRYPTOGRAPHY = False
            self.assertFalse(server.config_public()["vault_enabled"])
        finally:
            server.HAS_CRYPTOGRAPHY = original

    def test_vault_enabled_false_when_disabled_flag_set(self):
        original = server._vault_disabled
        try:
            server._vault_disabled = True
            self.assertFalse(server.config_public()["vault_enabled"])
        finally:
            server._vault_disabled = original

    def test_vault_enabled_false_when_env_flag_unset(self):
        original = server.WEBSH_VAULT_ENABLE
        try:
            server.WEBSH_VAULT_ENABLE = False
            self.assertFalse(server.config_public()["vault_enabled"])
        finally:
            server.WEBSH_VAULT_ENABLE = original


class TestVaultLoad(unittest.TestCase):
    """websh.creds.json reads, mtime caching, version handling."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, "websh.creds.json")
        self._old_env = os.environ.get("WEBSH_CREDS_PATH")
        os.environ["WEBSH_CREDS_PATH"] = self.path
        server._creds_cache = None
        server._creds_cache_key = (0, 0)

    def tearDown(self):
        if self._old_env is None:
            os.environ.pop("WEBSH_CREDS_PATH", None)
        else:
            os.environ["WEBSH_CREDS_PATH"] = self._old_env
        shutil.rmtree(self.tmpdir)

    def _write(self, data):
        with open(self.path, "w") as f:
            json.dump(data, f)

    def test_missing_file_returns_empty_store(self):
        self.assertEqual(server._load_creds(), {"version": 1, "vaults": {}})

    def test_valid_v1_file_parsed(self):
        self._write({
            "version": 1,
            "vaults": {
                "AAAAAAAAAAAAAAAAAAAAAAAAAA": {
                    "BBBBBBBBBBBBBBBBBBBBBBBBBB": {
                        "host": "h", "port": 22, "username": "u",
                        "iv": "abc", "ct": "def",
                    }
                }
            }
        })
        result = server._load_creds()
        self.assertEqual(result["version"], 1)
        self.assertIn("AAAAAAAAAAAAAAAAAAAAAAAAAA", result["vaults"])

    def test_unknown_version_disables_vault(self):
        self._write({"version": 99, "vaults": {}})
        original = server._vault_disabled
        try:
            self.assertEqual(server._load_creds(),
                             {"version": 1, "vaults": {}})
            self.assertTrue(server._vault_disabled)
        finally:
            server._vault_disabled = original

    def test_corrupt_json_returns_empty_store(self):
        with open(self.path, "w") as f:
            f.write("{not json")
        self.assertEqual(server._load_creds(), {"version": 1, "vaults": {}})

    def test_missing_vaults_object_returns_empty_store(self):
        self._write({"version": 1})  # no 'vaults' key
        self.assertEqual(server._load_creds(), {"version": 1, "vaults": {}})

    def test_non_dict_root_returns_empty_store(self):
        # Operator typo or partial write leaves a JSON array / string at
        # the root. _load_creds must not crash; it returns empty store.
        with open(self.path, "w") as f:
            json.dump([1, 2, 3], f)
        self.assertEqual(server._load_creds(), {"version": 1, "vaults": {}})
        with open(self.path, "w") as f:
            json.dump("oops", f)
        self.assertEqual(server._load_creds(), {"version": 1, "vaults": {}})

    def test_cache_reuses_parse_when_key_unchanged(self):
        # Mutate the file to a same-size payload + restore the original
        # mtime via os.utime. Cache key (mtime,size) matches → loader
        # returns the cached parse, NOT a re-read.
        self._write({"version": 1, "vaults": {"X": {}}})
        first = server._load_creds()
        same_len_payload = '{"version": 1, "vaults": {"Y": {}}}'
        first_len = os.path.getsize(self.path)
        self.assertEqual(len(same_len_payload), first_len)
        with open(self.path, "r+") as f:
            f.seek(0)
            f.write(same_len_payload)
            f.truncate()
        cached_mtime, _ = server._creds_cache_key
        os.utime(self.path, (cached_mtime, cached_mtime))
        cached = server._load_creds()
        self.assertEqual(cached, first)

    def test_size_change_invalidates_cache(self):
        # (mtime, size) tuple guards against bare-mtime stale read on
        # FS with 1s granularity. Same mtime, different size → re-read.
        self._write({"version": 1, "vaults": {"X": {}}})
        first = server._load_creds()
        cached_mtime, _ = server._creds_cache_key
        bigger = {"version": 1, "vaults": {"X" * 50: {}}}
        with open(self.path, "w") as f:
            json.dump(bigger, f)
        os.utime(self.path, (cached_mtime, cached_mtime))
        self.assertEqual(server._load_creds(), bigger)


class TestVaultWrite(unittest.TestCase):
    """Atomic-rename writes for websh.creds.json + lock semantics."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, "websh.creds.json")
        self._old_env = os.environ.get("WEBSH_CREDS_PATH")
        os.environ["WEBSH_CREDS_PATH"] = self.path
        server._creds_cache = None
        server._creds_cache_key = (0, 0)

    def tearDown(self):
        if self._old_env is None:
            os.environ.pop("WEBSH_CREDS_PATH", None)
        else:
            os.environ["WEBSH_CREDS_PATH"] = self._old_env
        shutil.rmtree(self.tmpdir)

    def test_writer_creates_file_with_mode_600(self):
        server._save_creds_atomic({"version": 1, "vaults": {"X": {}}})
        self.assertTrue(os.path.isfile(self.path))
        st = os.stat(self.path)
        self.assertEqual(st.st_mode & 0o777, 0o600)

    def test_writer_round_trip_via_loader(self):
        payload = {"version": 1, "vaults": {"V": {"C": {"iv": "i", "ct": "c"}}}}
        server._save_creds_atomic(payload)
        # Drop cache so the loader actually reads the disk
        server._creds_cache = None
        server._creds_cache_key = (0, 0)
        self.assertEqual(server._load_creds(), payload)

    def test_writer_no_partial_state_after_repeated_writes(self):
        # Write A then B; assert no leftover .tmp files in the dir.
        server._save_creds_atomic({"version": 1, "vaults": {"A": {}}})
        server._save_creds_atomic({"version": 1, "vaults": {"B": {}}})
        leftovers = [n for n in os.listdir(self.tmpdir)
                     if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_concurrent_writes_serialize_via_lock(self):
        # Two threads racing _save_creds_atomic should both succeed and
        # the final file should be one of the two payloads, fully formed.
        payloads = [{"version": 1, "vaults": {str(i): {}}} for i in range(2)]
        threads = [threading.Thread(target=server._save_creds_atomic,
                                     args=(p,)) for p in payloads]
        for t in threads: t.start()
        for t in threads: t.join()
        with open(self.path) as f:
            final = json.load(f)
        self.assertEqual(final["version"], 1)
        self.assertIn(list(final["vaults"].keys())[0], ("0", "1"))

    def test_writer_refuses_when_vault_disabled(self):
        # Protects against overwriting a v99 file with v1 payload
        # after _load_creds tripped the runtime flag.
        original = server._vault_disabled
        try:
            server._vault_disabled = True
            with self.assertRaises(RuntimeError):
                server._save_creds_atomic({"version": 1, "vaults": {}})
        finally:
            server._vault_disabled = original


@unittest.skipUnless(server.HAS_CRYPTOGRAPHY,
                     "cryptography not installed; gate path covered separately")
class TestVaultDecrypt(unittest.TestCase):
    """AES-GCM decrypt + AAD binding."""

    VAULT = "AAAAAAAAAAAAAAAAAAAAAAAAAA"
    CONN  = "BBBBBBBBBBBBBBBBBBBBBBBBBB"

    def _encrypt(self, plaintext, vault=None, conn=None):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = AESGCM.generate_key(bit_length=256)
        iv = os.urandom(12)
        aad = "{}:{}".format(vault or self.VAULT, conn or self.CONN).encode()
        ct = AESGCM(key).encrypt(iv, plaintext, aad)
        return key, iv, ct

    def test_round_trip_returns_plaintext(self):
        plaintext = b'{"password":"hunter2"}'
        key, iv, ct = self._encrypt(plaintext)
        out = server._decrypt_credential(key,
                                          base64.b64encode(iv).decode(),
                                          base64.b64encode(ct).decode(),
                                          self.VAULT, self.CONN)
        self.assertEqual(out, plaintext)

    def test_wrong_key_raises_invalid(self):
        _, iv, ct = self._encrypt(b"x")
        bad_key = bytes(32)
        with self.assertRaises(server.InvalidTag):
            server._decrypt_credential(bad_key,
                                        base64.b64encode(iv).decode(),
                                        base64.b64encode(ct).decode(),
                                        self.VAULT, self.CONN)

    def test_wrong_vault_id_raises_invalid(self):
        key, iv, ct = self._encrypt(b"x")
        with self.assertRaises(server.InvalidTag):
            server._decrypt_credential(key,
                                        base64.b64encode(iv).decode(),
                                        base64.b64encode(ct).decode(),
                                        "Z" * 26, self.CONN)

    def test_wrong_conn_id_raises_invalid(self):
        key, iv, ct = self._encrypt(b"x")
        with self.assertRaises(server.InvalidTag):
            server._decrypt_credential(key,
                                        base64.b64encode(iv).decode(),
                                        base64.b64encode(ct).decode(),
                                        self.VAULT, "Z" * 26)

    def test_iv_must_be_12_bytes(self):
        key = bytes(32)
        with self.assertRaises(ValueError):
            server._decrypt_credential(key,
                                        base64.b64encode(bytes(11)).decode(),
                                        base64.b64encode(b"x" * 17).decode(),
                                        self.VAULT, self.CONN)

    def test_key_must_be_32_bytes(self):
        with self.assertRaises(ValueError):
            server._decrypt_credential(bytes(31),
                                        base64.b64encode(bytes(12)).decode(),
                                        base64.b64encode(b"x" * 17).decode(),
                                        self.VAULT, self.CONN)

    def test_malformed_base64_raises_value_error(self):
        # Garbage in iv or ct that's not valid base64 → ValueError
        with self.assertRaises(ValueError):
            server._decrypt_credential(bytes(32),
                                        "!!not-base64!!",
                                        base64.b64encode(b"x" * 17).decode(),
                                        self.VAULT, self.CONN)


@unittest.skipUnless(server.HAS_CRYPTOGRAPHY,
                     "cryptography not installed; saved-card HTTP path needs AES-GCM")
class TestSavedCardConnectAuthz(LiveServerCase):
    """Integration: a saved vault card POSTed to /api/connect is gated by
    authorize_target even when it carries a `connection` hint — the hint must
    not let it skip the gate (call-site wiring). Covers the is_saved
    derivation + host/port/username-resolved-from-vault path the unit tests
    bypass (#74 item 3)."""

    VAULT = "A" * 26
    CONN = "B" * 26
    SCAN1 = "C" * 26
    SCAN2 = "D" * 26
    SCAN3 = "E" * 26
    CARD_HOST = "192.0.2.10"   # TEST-NET-1 (RFC 5737) — never routable
    SCAN_HOSTS = ("198.51.100.1", "198.51.100.2", "198.51.100.3")  # TEST-NET-2

    CONFIG = {
        "restrict_hosts": True,
        # Two prompt connections share the card's host:port — 'gate'
        # (first) denies 'root', 'alt' allows it. A connection-name
        # hint must be able to select 'alt' over the file-order first
        # match.
        "connections": [
            {"name": "gate", "host": CARD_HOST, "port": 22,
             "username": "", "denied_users": ["root"]},
            {"name": "alt", "host": CARD_HOST, "port": 22,
             "username": "", "allowed_users": ["root"]},
        ],
    }
    CREDS_PATH = True
    GLOBALS = {"WEBSH_VAULT_ENABLE": True, "_vault_disabled": False}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        # Credential blobs AAD-bound to (VAULT, conn_id), each decryptable with
        # the one vault key. host/username here are what authorize_target sees.
        cls.key = AESGCM.generate_key(bit_length=256)

        def _rec(conn, host, user):
            iv = os.urandom(12)
            aad = "{}:{}".format(cls.VAULT, conn).encode()
            ct = AESGCM(cls.key).encrypt(iv, b'{"password":"x"}', aad)
            return {"host": host, "port": 22, "username": user,
                    "iv": base64.b64encode(iv).decode(),
                    "ct": base64.b64encode(ct).decode()}

        slot = {cls.CONN: _rec(cls.CONN, cls.CARD_HOST, "root")}
        # Cards to distinct, unconfigured hosts — each rejected at the gate;
        # used to exercise scan-pattern accumulation.
        for conn, host in zip((cls.SCAN1, cls.SCAN2, cls.SCAN3),
                              cls.SCAN_HOSTS):
            slot[conn] = _rec(conn, host, "root")
        with open(cls.creds_path, "w") as f:
            json.dump({"version": server._CREDS_SCHEMA_VERSION,
                       "vaults": {cls.VAULT: slot}}, f)
        server._creds_cache = None
        server._creds_cache_key = (0, 0)

    def setUp(self):
        server._rate_limits.clear()
        with server.sessions_lock:
            server.sessions.clear()

    def _connect(self, body):
        return self._post("/api/connect", body)

    def test_saved_card_with_connection_hint_still_enforces_denied_users(self):
        """The card (server-resolved user 'root') targets a host whose only
        prompt connection denies 'root'. A `connection` hint on the body must
        NOT let it skip the gate and connect — it must 403. Without the
        call-site guard the hint makes conn_name truthy, the gate is skipped,
        and a session is spawned (200)."""
        body, code = self._connect({
            "vault_id": self.VAULT, "conn_id": self.CONN,
            "vault_key": base64.b64encode(self.key).decode(),
            "connection": "gate",          # hint — must not bypass the gate
            "cols": 80, "rows": 24,
        })
        self.assertEqual(code, 403, "expected gate 403, got {}: {}".format(
            code, body))
        self.assertEqual(body["error"],
                         "username is not allowed on this connection")

    def test_saved_card_hint_selects_allowing_connection(self):
        """Disambiguation end-to-end: 'gate' (file-order first) denies the
        card's user, 'alt' allows it, both on the card's host:port. A
        `connection: alt` hint must select 'alt' and authorize the connect —
        proving the hint string flows body → authorize_target (not just the
        first host:port match). SSH spawn is stubbed so no real connect runs.
        If the call-site dropped conn_hint, this would fall back to 'gate'
        and 403."""
        class _FakeSession(object):
            alive = True
            auth_failed = False

            def __init__(self, **kw):
                self.tmux_cmd = kw.get("tmux_cmd", "tmux")
                self.is_background = bool(kw.get("is_background"))
                self.client_ip = kw.get("client_ip")
                self.host = kw.get("host")
                self.username = kw.get("username")

            def close(self):
                pass

        orig = server.SSHSession
        server.SSHSession = _FakeSession
        try:
            body, code = self._connect({
                "vault_id": self.VAULT, "conn_id": self.CONN,
                "vault_key": base64.b64encode(self.key).decode(),
                "connection": "alt",   # selects the allowing connection
                "cols": 80, "rows": 24,
            })
        finally:
            server.SSHSession = orig
        self.assertEqual(code, 200,
                         "expected authorized connect, got {}: {}".format(
                             code, body))
        self.assertIn("session_id", body)

    def test_saved_card_rejections_feed_scan_pattern(self):
        """A saved-card rejection under restrict_hosts feeds the scan-pattern
        detector (#74 item 2) — probing distinct hosts via saved cards trips a
        `scan_pattern` record once the distinct-host threshold is reached. The
        detector keys on distinct hosts, so one honest broken card (single
        host) never would."""
        logf = tempfile.NamedTemporaryFile(mode="w", suffix=".log",
                                           delete=False)
        logf.close()
        orig_log = server.ACCESS_LOG_PATH
        orig_thr = server.SCAN_PATTERN_THRESHOLD
        server.ACCESS_LOG_PATH = logf.name
        server.SCAN_PATTERN_THRESHOLD = 3
        with server._scan_pattern_lock:
            server._scan_pattern.clear()
        try:
            vk = base64.b64encode(self.key).decode()
            for cid in (self.SCAN1, self.SCAN2, self.SCAN3):
                body, code = self._connect({
                    "vault_id": self.VAULT, "conn_id": cid, "vault_key": vk,
                    "cols": 80, "rows": 24,
                })
                self.assertEqual(code, 403,
                                 "scan card {} expected 403, got {}: {}".format(
                                     cid, code, body))
            with open(logf.name, "r", encoding="utf-8") as f:
                recs = [json.loads(line) for line in f if line.strip()]
        finally:
            server.ACCESS_LOG_PATH = orig_log
            server.SCAN_PATTERN_THRESHOLD = orig_thr
            with server._scan_pattern_lock:
                server._scan_pattern.clear()
            os.unlink(logf.name)
        deny = [r for r in recs if r.get("result") == "deny_blocked"]
        scan = [r for r in recs if r.get("result") == "scan_pattern"]
        self.assertEqual(len(deny), 3,
                         "expected 3 deny_blocked, got {}".format(recs))
        self.assertEqual(len(scan), 1,
                         "expected one scan_pattern on the 3rd distinct host, "
                         "got {}".format(recs))


class TestApiSave(LiveServerCase):
    TOLERANT_JSON = True
    """POST /api/save validation, upsert, gate."""

    VAULT = "AAAAAAAAAAAAAAAAAAAAAAAAAA"
    CONN  = "BBBBBBBBBBBBBBBBBBBBBBBBBB"

    # Empty config so /api/save doesn't conflict with anything
    CONFIG = {"connections": []}
    CREDS_PATH = True
    GLOBALS = {"WEBSH_VAULT_ENABLE": True}

    def setUp(self):
        # Reset the creds cache so each test sees a fresh file
        server._creds_cache = None
        server._creds_cache_key = (0, 0)
        server._rate_limits.clear()
        if os.path.exists(self.creds_path):
            os.unlink(self.creds_path)

    def _valid_body(self, **overrides):
        body = {
            "vault_id": self.VAULT,
            "conn_id": self.CONN,
            "host": "h.example.com",
            "port": 22,
            "username": "deploy",
            "iv": base64.b64encode(bytes(12)).decode(),
            "ct": base64.b64encode(b"x" * 32).decode(),
        }
        body.update(overrides)
        return body

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_valid_save_persists_record(self):
        body, code = self._post("/api/save", self._valid_body())
        self.assertEqual(code, 200)
        with open(self.creds_path) as f:
            data = json.load(f)
        self.assertIn(self.VAULT, data["vaults"])
        self.assertIn(self.CONN, data["vaults"][self.VAULT])
        rec = data["vaults"][self.VAULT][self.CONN]
        self.assertEqual(rec["host"], "h.example.com")
        self.assertEqual(rec["port"], 22)
        self.assertEqual(rec["username"], "deploy")
        self.assertIn("iv", rec)
        self.assertIn("ct", rec)

    def test_gate_returns_501_when_crypto_missing(self):
        original = server.HAS_CRYPTOGRAPHY
        try:
            server.HAS_CRYPTOGRAPHY = False
            body, code = self._post("/api/save", self._valid_body())
            self.assertEqual(code, 501)
            self.assertIn("cryptography", body.get("error", "").lower())
        finally:
            server.HAS_CRYPTOGRAPHY = original

    def test_gate_returns_501_when_vault_enable_unset(self):
        original = server.WEBSH_VAULT_ENABLE
        try:
            server.WEBSH_VAULT_ENABLE = False
            body, code = self._post("/api/save", self._valid_body())
            self.assertEqual(code, 501)
        finally:
            server.WEBSH_VAULT_ENABLE = original

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_bad_vault_id_format(self):
        body, code = self._post("/api/save",
                                self._valid_body(vault_id="not-base32"))
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_bad_iv_length(self):
        body, code = self._post("/api/save",
            self._valid_body(iv=base64.b64encode(bytes(11)).decode()))
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_empty_ct_rejected(self):
        body, code = self._post("/api/save",
            self._valid_body(ct=""))
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_missing_host_rejected(self):
        body, code = self._post("/api/save",
            self._valid_body(host=""))
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_host_starting_with_dash_rejected(self):
        body, code = self._post("/api/save",
            self._valid_body(host="-evil.com"))
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_ssh_options_filtered(self):
        body, code = self._post("/api/save",
            self._valid_body(ssh_options={"ProxyCommand": "evil",
                                          "StrictHostKeyChecking": "yes"}))
        self.assertEqual(code, 200)
        with open(self.creds_path) as f:
            data = json.load(f)
        rec = data["vaults"][self.VAULT][self.CONN]
        # StrictHostKeyChecking is on the allow-list; ProxyCommand is not.
        self.assertIn("StrictHostKeyChecking", rec.get("ssh_options", {}))
        self.assertNotIn("ProxyCommand", rec.get("ssh_options", {}))

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_concurrent_saves_preserve_both_slots(self):
        # RMW atomicity: two parallel saves to different (vault, conn)
        # slots must both end up in the final file. Without the outer
        # _creds_lock around load-modify-save, one would clobber the
        # other. Barrier ensures both POSTs hit the server at once.
        barrier = threading.Barrier(3)
        results = {}

        def _save_with_barrier(vault, conn):
            barrier.wait()
            _body, code = self._post("/api/save",
                self._valid_body(vault_id=vault, conn_id=conn))
            results[vault] = code

        v1, c1 = "C" * 26, "D" * 26
        v2, c2 = "E" * 26, "F" * 26
        t1 = threading.Thread(target=_save_with_barrier, args=(v1, c1))
        t2 = threading.Thread(target=_save_with_barrier, args=(v2, c2))
        t1.start(); t2.start()
        barrier.wait()
        t1.join(); t2.join()

        self.assertEqual(results[v1], 200)
        self.assertEqual(results[v2], 200)
        with open(self.creds_path) as f:
            data = json.load(f)
        # Full-record assertions catch a buggy interleave that drops or
        # swaps inner records — the key-only check would miss that.
        rec1 = data["vaults"][v1][c1]
        rec2 = data["vaults"][v2][c2]
        self.assertEqual(rec1["host"], "h.example.com")
        self.assertEqual(rec1["username"], "deploy")
        self.assertEqual(rec1["iv"], base64.b64encode(bytes(12)).decode())
        self.assertEqual(rec2["host"], "h.example.com")
        self.assertEqual(rec2["username"], "deploy")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_oversize_body_returns_413(self):
        # Synthesize a body whose Content-Length exceeds the cap. The
        # cap fires before json.loads so the payload itself can be
        # anything; pad ct to push the length past _MAX_VAULT_REQUEST_BYTES.
        big_ct = base64.b64encode(b"x" * (server._MAX_VAULT_REQUEST_BYTES * 2)).decode()
        body, code = self._post("/api/save", self._valid_body(ct=big_ct))
        self.assertEqual(code, 413)

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_non_dict_ssh_options_rejected(self):
        body, code = self._post("/api/save",
            self._valid_body(ssh_options=["not", "a", "dict"]))
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_identityfile_stripped_from_saved_ssh_options(self):
        body, code = self._post("/api/save",
            self._valid_body(ssh_options={
                "IdentityFile": "/etc/shadow",
                "StrictHostKeyChecking": "yes",
            }))
        self.assertEqual(code, 200)
        with open(self.creds_path) as f:
            data = json.load(f)
        stored = data["vaults"][self.VAULT][self.CONN].get("ssh_options", {})
        self.assertNotIn("IdentityFile", stored)
        self.assertNotIn("identityfile", stored)
        self.assertIn("StrictHostKeyChecking", stored)

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_routing_and_knownhosts_options_stripped_from_saved(self):
        # ProxyJump (deny-list bypass) and known-hosts file paths (arbitrary
        # file write under StrictHostKeyChecking=no) are operator-only —
        # never honored from a browser-saved card. See
        # _VAULT_DENY_SSH_OPTIONS.
        body, code = self._post("/api/save",
            self._valid_body(ssh_options={
                "ProxyJump": "bastion.internal",
                "UserKnownHostsFile": "/home/websh/.ssh/authorized_keys",
                "GlobalKnownHostsFile": "/tmp/evil",
                "StrictHostKeyChecking": "no",
            }))
        self.assertEqual(code, 200)
        with open(self.creds_path) as f:
            data = json.load(f)
        stored = data["vaults"][self.VAULT][self.CONN].get("ssh_options", {})
        for k in ("ProxyJump", "proxyjump", "UserKnownHostsFile",
                  "userknownhostsfile", "GlobalKnownHostsFile",
                  "globalknownhostsfile"):
            self.assertNotIn(k, stored)
        # A benign option in the same payload still round-trips.
        self.assertIn("StrictHostKeyChecking", stored)


class TestApiSaveDelete(LiveServerCase):
    """DELETE /api/save validation, reap-empty-vault, gate."""

    VAULT = "AAAAAAAAAAAAAAAAAAAAAAAAAA"
    CONN  = "BBBBBBBBBBBBBBBBBBBBBBBBBB"

    CONFIG = {"connections": []}
    CREDS_PATH = True
    GLOBALS = {"WEBSH_VAULT_ENABLE": True}

    def setUp(self):
        server._creds_cache = None
        server._creds_cache_key = (0, 0)
        server._rate_limits.clear()
        # Seed with one entry
        server._save_creds_atomic({
            "version": 1,
            "vaults": {self.VAULT: {self.CONN: {
                "host": "h", "port": 22, "username": "u",
                "iv": "ii", "ct": "cc",
            }}},
        })

    def _post_save_delete(self, vault_id, conn_id):
        qs = "vault_id={}&conn_id={}".format(vault_id, conn_id)
        return self._request_raw(
            "/api.php?action=save_delete&" + qs, data=b"{}", method="POST",
            headers={"Content-Type": "application/json"})

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_existing_entry_returns_204_and_reaps_empty_vault(self):
        code, _ = self._delete("/api/save?vault_id={}&conn_id={}".format(
            self.VAULT, self.CONN))
        self.assertEqual(code, 204)
        with open(self.creds_path) as f:
            data = json.load(f)
        # Empty vault is reaped — the last conn_id deletion removes the vault key.
        self.assertNotIn(self.VAULT, data["vaults"])

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_php_style_post_save_delete_works_in_python_only_mode(self):
        code, _ = self._post_save_delete(self.VAULT, self.CONN)
        self.assertEqual(code, 204)
        with open(self.creds_path) as f:
            data = json.load(f)
        self.assertNotIn(self.VAULT, data["vaults"])

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_missing_entry_returns_404(self):
        code, _ = self._delete("/api/save?vault_id={}&conn_id={}".format(
            self.VAULT, "C" * 26))
        self.assertEqual(code, 404)

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_invalid_vault_id_returns_400(self):
        code, _ = self._delete("/api/save?vault_id=not-base32&conn_id={}".format(
            self.CONN))
        self.assertEqual(code, 400)

    def test_gate_returns_501_when_crypto_missing(self):
        original = server.HAS_CRYPTOGRAPHY
        try:
            server.HAS_CRYPTOGRAPHY = False
            code, _ = self._delete("/api/save?vault_id={}&conn_id={}".format(
                self.VAULT, self.CONN))
            self.assertEqual(code, 501)
        finally:
            server.HAS_CRYPTOGRAPHY = original

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_partial_delete_keeps_other_conn_in_vault(self):
        # Add a second conn_id in the same vault, then delete only one.
        server._save_creds_atomic({
            "version": 1,
            "vaults": {self.VAULT: {
                self.CONN: {"host": "h", "port": 22, "username": "u",
                            "iv": "ii", "ct": "cc"},
                "X" * 26: {"host": "h2", "port": 22, "username": "u",
                           "iv": "ii", "ct": "cc"},
            }},
        })
        server._creds_cache = None
        server._creds_cache_key = (0, 0)
        code, _ = self._delete("/api/save?vault_id={}&conn_id={}".format(
            self.VAULT, self.CONN))
        self.assertEqual(code, 204)
        with open(self.creds_path) as f:
            data = json.load(f)
        # Vault stays, second slot preserved
        self.assertIn(self.VAULT, data["vaults"])
        self.assertIn("X" * 26, data["vaults"][self.VAULT])
        self.assertNotIn(self.CONN, data["vaults"][self.VAULT])


class TestApiConnectSaved(LiveServerCase):
    TOLERANT_JSON = True
    """Saved-variant POST /api/connect: decrypt → spawn ssh."""

    VAULT = "AAAAAAAAAAAAAAAAAAAAAAAAAA"
    CONN  = "BBBBBBBBBBBBBBBBBBBBBBBBBB"

    CONFIG = {"connections": []}
    CREDS_PATH = True
    GLOBALS = {"WEBSH_VAULT_ENABLE": True}

    def setUp(self):
        server._creds_cache = None
        server._creds_cache_key = (0, 0)
        server._rate_limits.clear()
        # Seed a stored entry encrypted with self.key/self.iv
        if server.HAS_CRYPTOGRAPHY:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            self.key = AESGCM.generate_key(bit_length=256)
            self.iv = os.urandom(12)
            aad = "{}:{}".format(self.VAULT, self.CONN).encode()
            self.ct = AESGCM(self.key).encrypt(
                self.iv,
                b'{"password":"hunter2","key":null,"key_pass":null}',
                aad)
            server._save_creds_atomic({
                "version": 1,
                "vaults": {self.VAULT: {self.CONN: {
                    "host": "h.example.com", "port": 22, "username": "u",
                    "iv": base64.b64encode(self.iv).decode(),
                    "ct": base64.b64encode(self.ct).decode(),
                }}},
            })

    def _post(self, body):
        return LiveServerCase._post(self, "/api/connect", body)

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_saved_variant_decrypts_and_spawns(self):
        # Patch SSHSession so we don't actually fork
        with unittest.mock.patch.object(server, "SSHSession") as MockSSH:
            instance = unittest.mock.MagicMock(alive=True, auth_failed=False,
                                                tmux_cmd="tmux")
            MockSSH.return_value = instance
            body, code = self._post({
                "vault_id": self.VAULT, "conn_id": self.CONN,
                "vault_key": base64.b64encode(self.key).decode(),
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 200)
            # Wire body did NOT include host/username; values come from store.
            kwargs = MockSSH.call_args.kwargs
            self.assertEqual(kwargs.get("host"), "h.example.com")
            self.assertEqual(kwargs.get("username"), "u")
            self.assertEqual(kwargs.get("password"), "hunter2")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_wrong_vault_key_returns_400_decrypt_failed(self):
        bad = bytes(32)
        body, code = self._post({
            "vault_id": self.VAULT, "conn_id": self.CONN,
            "vault_key": base64.b64encode(bad).decode(),
            "cols": 80, "rows": 24,
        })
        # 400 (not 401) so upstream auth_basic / Cloudflare Access never
        # sees a 401 and never triggers a re-prompt loop.
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_decrypt_failed")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_malformed_vault_key_returns_400_input_invalid(self):
        body, code = self._post({
            "vault_id": self.VAULT, "conn_id": self.CONN,
            "vault_key": base64.b64encode(bytes(31)).decode(),
            "cols": 80, "rows": 24,
        })
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_missing_entry_returns_404(self):
        body, code = self._post({
            "vault_id": self.VAULT, "conn_id": "Z" * 26,
            "vault_key": base64.b64encode(bytes(32)).decode(),
            "cols": 80, "rows": 24,
        })
        self.assertEqual(code, 404)

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_bad_vault_id_format_returns_400(self):
        body, code = self._post({
            "vault_id": "not-base32", "conn_id": self.CONN,
            "vault_key": base64.b64encode(bytes(32)).decode(),
            "cols": 80, "rows": 24,
        })
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_input_invalid")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_saved_variant_routes_key_pass_to_password(self):
        # Passphrase-protected key: vault stores {key, key_pass} but
        # SSHSession only takes `password` (the PTY auth-detector pipes
        # it as the answer to whatever ssh prompts). The decrypt path
        # must route key_pass into password, otherwise saved
        # passphrase-protected keys silently fail at connect time.
        # Mirror of manual-mode client routing at websh.js:816.
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        pem = ("-----BEGIN OPENSSH PRIVATE KEY-----\n"
               "fakekeybytes\n"
               "-----END OPENSSH PRIVATE KEY-----\n")
        self.iv = os.urandom(12)
        aad = "{}:{}".format(self.VAULT, self.CONN).encode()
        pt = json.dumps({"password": "", "key": pem,
                         "key_pass": "secret-passphrase"}).encode()
        self.ct = AESGCM(self.key).encrypt(self.iv, pt, aad)
        server._save_creds_atomic({
            "version": 1,
            "vaults": {self.VAULT: {self.CONN: {
                "host": "h.example.com", "port": 22, "username": "u",
                "iv": base64.b64encode(self.iv).decode(),
                "ct": base64.b64encode(self.ct).decode(),
            }}},
        })
        server._creds_cache = None
        with unittest.mock.patch.object(server, "SSHSession") as MockSSH:
            instance = unittest.mock.MagicMock(alive=True,
                                               auth_failed=False,
                                               tmux_cmd="tmux")
            MockSSH.return_value = instance
            body, code = self._post({
                "vault_id": self.VAULT, "conn_id": self.CONN,
                "vault_key": base64.b64encode(self.key).decode(),
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 200)
            kwargs = MockSSH.call_args.kwargs
            # key passes through unchanged
            self.assertEqual(kwargs.get("key"), pem)
            # key_pass routed into password so the PTY auth-detector
            # can answer the passphrase prompt
            self.assertEqual(kwargs.get("password"), "secret-passphrase")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_saved_variant_password_takes_precedence_over_key_pass(self):
        # Defensive: if a malformed entry has both password and
        # key_pass set, the password field wins (no overwrite). Mirror
        # of the conservative `not password` guard in the routing.
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        pem = ("-----BEGIN OPENSSH PRIVATE KEY-----\n"
               "fakekeybytes\n"
               "-----END OPENSSH PRIVATE KEY-----\n")
        self.iv = os.urandom(12)
        aad = "{}:{}".format(self.VAULT, self.CONN).encode()
        pt = json.dumps({"password": "primary-pw", "key": pem,
                         "key_pass": "passphrase"}).encode()
        self.ct = AESGCM(self.key).encrypt(self.iv, pt, aad)
        server._save_creds_atomic({
            "version": 1,
            "vaults": {self.VAULT: {self.CONN: {
                "host": "h.example.com", "port": 22, "username": "u",
                "iv": base64.b64encode(self.iv).decode(),
                "ct": base64.b64encode(self.ct).decode(),
            }}},
        })
        server._creds_cache = None
        with unittest.mock.patch.object(server, "SSHSession") as MockSSH:
            instance = unittest.mock.MagicMock(alive=True,
                                               auth_failed=False,
                                               tmux_cmd="tmux")
            MockSSH.return_value = instance
            body, code = self._post({
                "vault_id": self.VAULT, "conn_id": self.CONN,
                "vault_key": base64.b64encode(self.key).decode(),
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 200)
            kwargs = MockSSH.call_args.kwargs
            # password wins; key_pass NOT used since password was set
            self.assertEqual(kwargs.get("password"), "primary-pw")

    def test_gate_returns_501_when_crypto_missing(self):
        original = server.HAS_CRYPTOGRAPHY
        try:
            server.HAS_CRYPTOGRAPHY = False
            body, code = self._post({
                "vault_id": self.VAULT, "conn_id": self.CONN,
                "vault_key": base64.b64encode(bytes(32)).decode(),
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 501)
        finally:
            server.HAS_CRYPTOGRAPHY = original

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_existing_manual_path_still_works(self):
        # Regression: a body with host/username (no vault fields) routes
        # to the manual flow exactly as before. Asserting username +
        # password too catches a hypothetical bug where the saved-variant
        # branch fires and finds a stored record with the same host.
        with unittest.mock.patch.object(server, "SSHSession") as MockSSH:
            instance = unittest.mock.MagicMock(alive=True, auth_failed=False,
                                                tmux_cmd="tmux")
            MockSSH.return_value = instance
            body, code = self._post({
                "host": "manual.example.com", "username": "alice",
                "password": "p", "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 200)
            kwargs = MockSSH.call_args.kwargs
            self.assertEqual(kwargs.get("host"), "manual.example.com")
            self.assertEqual(kwargs.get("username"), "alice")
            self.assertEqual(kwargs.get("password"), "p")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_non_dict_plaintext_returns_decrypt_failed(self):
        # Re-seed with a blob whose plaintext decrypts to a JSON list,
        # not a dict. Server must return 400 vault_decrypt_failed, not
        # propagate an AttributeError as a 500.
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = AESGCM.generate_key(bit_length=256)
        iv = os.urandom(12)
        aad = "{}:{}".format(self.VAULT, self.CONN).encode()
        ct = AESGCM(key).encrypt(iv, b'["password","is_a_list"]', aad)
        server._save_creds_atomic({
            "version": 1,
            "vaults": {self.VAULT: {self.CONN: {
                "host": "h.example.com", "port": 22, "username": "u",
                "iv": base64.b64encode(iv).decode(),
                "ct": base64.b64encode(ct).decode(),
            }}},
        })
        body, code = self._post({
            "vault_id": self.VAULT, "conn_id": self.CONN,
            "vault_key": base64.b64encode(key).decode(),
            "cols": 80, "rows": 24,
        })
        self.assertEqual(code, 400)
        self.assertEqual(body.get("error"), "vault_decrypt_failed")

    @unittest.skipUnless(server.HAS_CRYPTOGRAPHY, "needs cryptography")
    def test_identityfile_in_stored_options_stripped_at_load(self):
        # Backward-compat: a record stored before the save-side filter
        # landed could still have identityfile. Verify load-side strips
        # it before the value reaches SSHSession.
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = AESGCM.generate_key(bit_length=256)
        iv = os.urandom(12)
        aad = "{}:{}".format(self.VAULT, self.CONN).encode()
        ct = AESGCM(key).encrypt(iv, b'{"password":"p","key":null}', aad)
        server._save_creds_atomic({
            "version": 1,
            "vaults": {self.VAULT: {self.CONN: {
                "host": "h.example.com", "port": 22, "username": "u",
                "iv": base64.b64encode(iv).decode(),
                "ct": base64.b64encode(ct).decode(),
                "ssh_options": {"IdentityFile": "/etc/shadow",
                                "ProxyJump": "bastion.internal",
                                "UserKnownHostsFile": "/tmp/evil",
                                "StrictHostKeyChecking": "yes"},
            }}},
        })
        with unittest.mock.patch.object(server, "SSHSession") as MockSSH:
            instance = unittest.mock.MagicMock(alive=True, auth_failed=False,
                                                tmux_cmd="tmux")
            MockSSH.return_value = instance
            body, code = self._post({
                "vault_id": self.VAULT, "conn_id": self.CONN,
                "vault_key": base64.b64encode(key).decode(),
                "cols": 80, "rows": 24,
            })
            self.assertEqual(code, 200)
            opts = MockSSH.call_args.kwargs.get("ssh_options", {})
            for k in ("IdentityFile", "identityfile", "ProxyJump",
                      "proxyjump", "UserKnownHostsFile",
                      "userknownhostsfile"):
                self.assertNotIn(k, opts)
            self.assertIn("StrictHostKeyChecking", opts)


if __name__ == "__main__":
    unittest.main()
