#!/usr/bin/env python3
"""Proxy refusal happens before even a ping reaches an unsafe socket.

All fixtures belong to the current user. No account switching, credential
traffic, production listeners, or auto-started backend is needed.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

from stub_backend import Echo, UnixHTTPServer


class CountedEcho(Echo):
    def _reply(self):
        self.server.requests += 1
        super()._reply()


class TestSocketSecurity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wphp-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        shutil.copyfile(Path(__file__).resolve().parents[2] / "api.php",
                        self.root / "api.php")
        (self.root / "websh.json").write_text("{}")
        self.socket_path = self.root / "websh.sock"

    def proxy(self, disabled=()):
        backend = UnixHTTPServer(str(self.socket_path), CountedEcho)
        os.chmod(self.socket_path, 0o600)
        backend.requests = 0
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        # open_basedir prevents alternative identity discovery via /proc.
        # getmyuid/getmygid intentionally remain available: script ownership
        # is not evidence of the PHP worker's effective process identity.
        script = """
$_GET['action'] = 'ping';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
register_shutdown_function(function () {
    fwrite(STDERR, 'STATUS=' . (http_response_code() ?: 200));
});
require 'api.php';
"""
        cmd = ["php", "-d", "display_errors=1", "-d", "error_reporting=-1"]
        if disabled:
            cmd += ["-d", "disable_functions=" + ",".join(disabled),
                    "-d", "open_basedir=" + str(self.root),
                    "-d", "sys_temp_dir=" + str(self.root / "missing")]
        env = dict(os.environ, WEBSH_SOCKET=str(self.socket_path),
                   WEBSH_CONFIG=str(self.root / "websh.json"))
        try:
            result = subprocess.run(cmd + ["-r", script], cwd=self.root,
                                    env=env, capture_output=True, text=True,
                                    timeout=10)
            return result, backend.requests
        finally:
            backend.shutdown()
            backend.server_close()
            thread.join(timeout=5)
            self.socket_path.unlink()

    def assert_refused(self, disabled=()):
        result, requests = self.proxy(disabled)
        self.assertEqual(requests, 0, "proxy contacted an unsafe socket")
        self.assertIn("STATUS=500", result.stderr)
        body = json.loads(result.stdout)
        self.assertTrue(body.get("error"), body)

    def test_same_group_writable_directory_is_refused(self):
        os.chmod(self.root, 0o770)
        self.assertEqual(self.root.stat().st_gid, os.getegid())
        self.assert_refused()

    def test_private_leaf_under_writable_ancestor_is_refused(self):
        child = self.root / "private"
        child.mkdir(mode=0o700)
        self.socket_path = child / "websh.sock"
        for mode in (0o770, 0o777):
            with self.subTest(ancestor_mode=oct(mode)):
                os.chmod(self.root, mode)
                self.assert_refused()

    def test_symlink_target_with_writable_ancestor_is_refused(self):
        shared = self.root / "shared"
        child = shared / "private"
        child.mkdir(parents=True, mode=0o700)
        shared.chmod(0o777)
        alias = self.root / "alias"
        alias.symlink_to(child, target_is_directory=True)
        self.socket_path = alias / "websh.sock"
        self.assert_refused()

    def test_unknown_effective_uid_is_refused(self):
        # Neither POSIX nor a kernel-owned temp file can identify this
        # worker. Script-owner functions remain enabled to expose the bug.
        self.assert_refused(("posix_geteuid", "posix_getegid"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
