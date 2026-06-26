"""Shared fixture for the websh backend test suite.

Split out of the original monolithic test_server.py: stdlib imports,
the repo-root sys.path bootstrap (so every test module gets the SAME
`server` module object), and the shared LiveServerCase fixture plus
the _FakeNotifyMixin fake-session surface.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

# Make `import server` resolve to the repo root (two levels up from this
# file) no matter how the suite is launched — discover from the repo
# root, the thin test_server.py runner, or a direct module run.
REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import server


class _FakeNotifyMixin(object):
    """Mixin for in-test fake sessions: provides the surface that the
    real Session.wait_for_data + _signal contract expects, but as a
    cheap no-op. Tests that need to exercise the real signal-then-wake
    path use Session itself (see TestSessionNotify); fakes here are
    for higher-level protocol tests where the wait helper just needs
    to not blow up and let the loop tick forward."""
    _data_event = None
    # The /api/stream handler now enforces "at most one stream per
    # session" by reading-then-setting this attribute under sessions_lock.
    # Tests that plant fake sessions inherit this default and the guard
    # works the same way it does for real Sessions.
    _stream_active = False

    def _signal(self):
        pass

    def wait_for_data(self, client_socket, timeout, selector=None):
        # Mirror Session.wait_for_data's _data_event=None fallback so
        # the protocol-level loop progresses without busy-spinning.
        time.sleep(min(timeout, 0.01))


class LiveServerCase(unittest.TestCase):
    """Shared fixture for integration tests that hit a live HTTP server.

    Subclasses declare what they need instead of hand-rolling
    setUpClass/tearDownClass:

      CONFIG       dict written to <tmpdir>/websh.json and exported via
                   WEBSH_CONFIG (config caches reset around the class).
                   None = the config machinery is left untouched, which
                   matches the old bare-server fixtures: with WEBSH_CONFIG
                   unset, load_config() returns _CONFIG_EMPTY regardless
                   of any cache state.
      ENV          extra os.environ entries for the class duration.
      GLOBALS      server-module globals to set for the class duration;
                   snapshotted in setUpClass, restored in tearDownClass.
      CREDS        optional dict written to <tmpdir>/websh.creds.json
                   (implies CREDS_PATH).
      CREDS_PATH   True = allocate cls.creds_path inside the tempdir,
                   export it via WEBSH_CREDS_PATH and reset the creds
                   caches (no file written unless CREDS is set).
      START_SERVER False = fixture only (tempdir/env/globals), no server.

    The server listens on an ephemeral port; readiness is confirmed by
    polling /api/ping (up to ~5 s in 10 ms steps) instead of the flat
    0.2 s sleep the old per-class fixtures used.
    """

    CONFIG = None
    ENV = {}
    GLOBALS = {}
    CREDS = None
    CREDS_PATH = False
    START_SERVER = True

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp()
        cls._env_keys = []
        cls._globals_snapshot = {}
        cls.httpd = None

        if cls.CONFIG is not None:
            cfg_path = os.path.join(cls.tmpdir, "websh.json")
            with open(cfg_path, "w") as f:
                json.dump(cls.CONFIG, f)
            cls._setenv("WEBSH_CONFIG", cfg_path)
            server._config_cache = None
            server._config_mtime = 0

        for key, value in cls.ENV.items():
            cls._setenv(key, value)

        if cls.CREDS is not None or cls.CREDS_PATH:
            cls.creds_path = os.path.join(cls.tmpdir, "websh.creds.json")
            cls._setenv("WEBSH_CREDS_PATH", cls.creds_path)
            if cls.CREDS is not None:
                with open(cls.creds_path, "w") as f:
                    json.dump(cls.CREDS, f)
            server._creds_cache = None
            server._creds_cache_key = (0, 0)

        for name, value in cls.GLOBALS.items():
            cls._globals_snapshot[name] = getattr(server, name)
            setattr(server, name, value)

        if cls.START_SERVER:
            server.HOST = "127.0.0.1"
            cls.httpd = server.Server(("127.0.0.1", 0), server.Handler)
            cls.port = cls.httpd.server_address[1]
            server.PORT = cls.port
            cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                          daemon=True)
            cls.thread.start()
            cls._wait_ready()

    @classmethod
    def tearDownClass(cls):
        if cls.httpd is not None:
            cls.httpd.shutdown()
            cls.httpd.server_close()
        for name, value in cls._globals_snapshot.items():
            setattr(server, name, value)
        for key in cls._env_keys:
            os.environ.pop(key, None)
        shutil.rmtree(cls.tmpdir, ignore_errors=True)
        if cls.CONFIG is not None:
            server._config_cache = None
            server._config_mtime = 0
        if cls.CREDS is not None or cls.CREDS_PATH:
            server._creds_cache = None
            server._creds_cache_key = (0, 0)

    @classmethod
    def _setenv(cls, key, value):
        os.environ[key] = value
        cls._env_keys.append(key)

    @classmethod
    def _wait_ready(cls):
        from urllib.request import urlopen
        url = "http://127.0.0.1:{}/api/ping".format(cls.port)
        deadline = time.time() + 5
        while True:
            try:
                with urlopen(url, timeout=1) as resp:
                    resp.read()
                return
            except Exception as e:
                if hasattr(e, "code"):
                    return  # any HTTP response means the server is up
                if time.time() >= deadline:
                    raise
                time.sleep(0.01)

    # ── shared HTTP helpers ───────────────────────────────────────────

    def _server_url(self, path):
        return "http://127.0.0.1:{}{}".format(self.port, path)

    def _request_raw(self, path, data=None, method=None, headers=None,
                     timeout=5):
        """Raw request → (status, body bytes). HTTP error responses are
        returned, not raised; transport errors propagate."""
        from urllib.request import urlopen, Request
        req = Request(self._server_url(path), data=data, method=method,
                      headers=headers or {})
        try:
            resp = urlopen(req, timeout=timeout)
            return resp.getcode(), resp.read()
        except Exception as e:
            if hasattr(e, "code"):
                payload = e.read() if hasattr(e, "read") else b""
                return e.code, payload
            raise

    # Classes that historically tolerated non-JSON bodies (the vault API
    # tests asserted on a {"_raw": ...} shape) opt in; everyone else
    # keeps the strict implicit contract that every API response —
    # including errors — is JSON, so a stdlib HTML send_error leaking
    # out fails the test instead of slipping through.
    TOLERANT_JSON = False

    def _request_json(self, path, data=None, method=None, headers=None,
                      timeout=5):
        """JSON request → (parsed body, status). Non-JSON payloads
        raise (TOLERANT_JSON=False) or come back as {"_raw": <text>}."""
        code, payload = self._request_raw(path, data=data, method=method,
                                          headers=headers, timeout=timeout)
        try:
            return json.loads(payload.decode("utf-8")), code
        except ValueError:
            if self.TOLERANT_JSON:
                return {"_raw": payload.decode("utf-8", "replace")}, code
            raise

    def _get(self, path):
        return self._request_json(path)

    def _post(self, path, body, timeout=5):
        return self._request_json(
            path, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"}, timeout=timeout)

    def _delete(self, path):
        return self._request_raw(path, method="DELETE")
