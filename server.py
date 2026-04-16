#!/usr/bin/env python3
"""
websh — lightweight SSH terminal backend.

REST API server that manages SSH sessions via PTY.
Designed to run on shared hosting with Python 3.5+, zero dependencies.
Listens on 127.0.0.1 only — meant to be proxied through Apache/nginx via PHP.

Environment variables:
    PORT                  — listen port (default: 8765)
    HOST                  — bind address (default: 127.0.0.1)
    SESSION_TIMEOUT       — seconds of inactivity before cleanup (default: 300)
    MAX_SESSIONS          — max concurrent SSH sessions (default: 10)
    WEBSH_CONFIG          — path to websh.json config file (optional)
    TRUSTED_PROXIES       — comma-separated IPs to trust X-Forwarded-For from (default: 127.0.0.1)
    MAX_BG_SESSIONS       — max background SSH sessions for file transfer (default: 10)
    WEBSH_TMUX_IDLE_TTL   — seconds a detached persistent tmux session may idle
                            on the target before a watchdog kills it
                            (default: 259200 = 72h, 0 disables)
    WEBSH_TMUX_WATCHDOG_POLL
                          — seconds between watchdog checks on the target
                            (default: 300; the effective kill window is
                            TTL + POLL in the worst case, so lower this
                            when testing with a short TTL)

API endpoints:
    POST /api/connect     — start SSH session
    POST /api/input       — send keystrokes
    GET  /api/output      — long-poll for terminal output
    POST /api/resize      — resize terminal
    POST /api/disconnect  — close session
    GET  /api/config      — return server-side config (without secrets)
    GET  /api/ping        — health check
"""

import base64
import datetime
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import urllib.parse
import uuid
from collections import OrderedDict
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from threading import Thread, Lock

__version__ = "0.2.0"

# ─── Configuration ───────────────────────────────────────────────────

def _int_env(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return int(default)

PORT = _int_env("PORT", "8765")
HOST = os.environ.get("HOST", "127.0.0.1")
SESSION_TIMEOUT = _int_env("SESSION_TIMEOUT", "300")
MAX_SESSIONS = _int_env("MAX_SESSIONS", "10")
MAX_BG_SESSIONS = _int_env("MAX_BG_SESSIONS", "10")

# Trusted proxies (comma-separated IPs) whose X-Forwarded-For header is trusted.
# Only requests from these IPs will have their X-Forwarded-For used for rate limiting.
_TRUSTED_PROXIES = set(
    p.strip() for p in os.environ.get("TRUSTED_PROXIES", "127.0.0.1").split(",")
    if p.strip()
)

# Limits
MAX_PORT = 65535
MIN_PORT = 1
MAX_COLS = 500
MAX_ROWS = 200
MIN_COLS = 10
MIN_ROWS = 2

# Timing
CONNECT_SETTLE_TIME = 0.5     # seconds to wait after spawning SSH
POLL_TIMEOUT = 10             # seconds to long-poll for output
POLL_INTERVAL = 0.01          # seconds between buffer checks
PTY_DRAIN_ROUNDS = 50         # max iterations to drain PTY on exit
PTY_DRAIN_INTERVAL = 0.01    # seconds per drain round
PTY_READ_SIZE = 65536         # bytes per read
OUTPUT_BUF_MAX = 1048576      # 1 MB — truncate if exceeded
OUTPUT_BUF_KEEP = 524288      # keep last 512 KB on truncation

# Terminal reset sequence: exit alt screen, show cursor, reset attrs, full reset
TERM_RESET = b"\x1b[?1049l\x1b[?25h\x1b[0m\x1bc"

# Password prompt patterns (lowercase, checked against lowered PTY output)
PASSWORD_PROMPTS = ("password:", "password for", "passcode:", "passphrase")

# Auth-failure patterns — if we see any of these AFTER we auto-typed the
# password, ssh rejected our attempt and we should not keep the session
# limping in an endless retry loop.
AUTH_FAIL_PATTERNS = ("permission denied", "authentication failed",
                      "access denied", "too many authentication failures")

# Rate limiting for /api/connect
RATE_LIMIT_WINDOW = 60    # seconds
RATE_LIMIT_MAX = 10       # max connect attempts per IP per window

# Session ID format
_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

# Persistent-session slot id (used as remote tmux session name `websh-<slot>`).
# Restricted to characters that are safe both as tmux session names and as
# shell tokens without quoting.
#
# Why this is not a security boundary: tmux's server socket lives in
# `/tmp/tmux-$UID` on the target, so two different OS users on the same
# host cannot see each other's sessions even if they pick the same
# slot_id. The authentication boundary is ssh (username + key/password);
# slot_id is a *label* attached to already-authenticated sessions, used
# only to let the same browser resume the same target on reload. The
# regex's job is to keep the label safe to interpolate into the remote
# command ("tmux new-session -A -D -s websh-<slot>") — not to stop an
# attacker from guessing it.
_SLOT_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')

# tmux invocation path / command. Covers "tmux", "/usr/local/bin/tmux",
# "~/.local/bin/tmux". Rejects shell metacharacters so it's safe to
# interpolate into the remote-command string without escaping.
_TMUX_CMD_RE = re.compile(r'^[A-Za-z0-9_./~-]{1,128}$')

# ─── Persistent-session TTL watchdog ─────────────────────────────────
#
# Problem: if a browser closes without clicking [x], the remote tmux
# session survives detach (that's the whole point of persistent mode)
# but nothing ever reaps it. Abandoned sessions accumulate and consume
# RAM on the target host. We don't store SSH credentials on the websh
# server, so we can't reach back to clean up autonomously.
#
# Fix: at session creation, the remote command spawns a detached
# watchdog alongside the tmux session. The watchdog polls tmux and
# calls `kill-session` once the session has been unattached for longer
# than TMUX_IDLE_TTL seconds. The TTL clock is reset in two ways:
#
#   1. On every /api/connect: the orchestration shell stamps a
#      per-slot "seen" file before spawning. So any reconnect — even
#      one that predates the watchdog's next poll — resets the clock.
#   2. On every watchdog poll where a client is currently attached:
#      the watchdog refreshes the same "seen" file. Handles the case
#      where a user stays attached for longer than TTL and then
#      detaches briefly — without this, tmux's session_last_attached
#      would be stale and the session would die seconds after detach.
#
# Idempotency across reconnects is via a pidfile (`kill -0 "$PID"`).
# Stale pidfiles (dead PID) are silently overwritten by the new
# watchdog.

# How often the watchdog polls (seconds). Resolution of the TTL kill
# is therefore TTL + WATCHDOG_POLL_SECONDS in the worst case. Clamped
# to >=5 so a misconfigured 0 can't busy-loop the target.
WATCHDOG_POLL_SECONDS = max(5, _int_env("WEBSH_TMUX_WATCHDOG_POLL", "300"))

# Idle TTL for detached tmux sessions on the target (seconds).
# 0 disables the watchdog — sessions live forever as before.
TMUX_IDLE_TTL = max(0, _int_env("WEBSH_TMUX_IDLE_TTL", "259200"))


def _build_remote_command(slot_id, tmux_cmd, ttl_seconds,
                          poll_seconds=WATCHDOG_POLL_SECONDS):
    """Shell command sent via ssh to create-or-attach the websh-<slot>
    tmux session on the target.

    When ttl_seconds > 0 the command also spawns a detached POSIX-sh
    watchdog that kills the session once it has been unattached for
    ttl_seconds. The watchdog is idempotent across reconnects via a
    pidfile in $HOME.

    slot_id and tmux_cmd MUST be pre-validated against _SLOT_ID_RE /
    _TMUX_CMD_RE — they're interpolated directly into the shell
    command without further escaping. The `tmux` format string below
    uses double quotes and references tmux's own `#{...}` syntax, so
    no user-controlled data is ever evaluated as shell.
    """
    tname = "websh-" + slot_id
    attach = (tmux_cmd + " new-session -A -D -s " + tname
              + ' -- "$SHELL" -l')
    if ttl_seconds <= 0:
        return "exec " + attach

    pidfile = "$HOME/.websh-ttl-" + slot_id + ".pid"
    seenfile = "$HOME/.websh-ttl-" + slot_id + ".seen"

    # Watchdog loop body. Wrapped in `nohup sh -c '...'` below — must
    # therefore contain NO single quotes (we use double quotes for the
    # trap and the tmux format string, both safe inside outer '...').
    body = (
        "echo $$ > " + pidfile + "; "
        'trap "rm -f ' + pidfile + " " + seenfile + '" EXIT; '
        "while sleep " + str(poll_seconds) + "; do "
          + tmux_cmd + " has-session -t " + tname + " 2>/dev/null || exit; "
          "info=$(" + tmux_cmd + " display -p -t " + tname
              + ' "#{session_attached} #{session_last_attached}" '
              "2>/dev/null) || exit; "
          "att=${info%% *}; last=${info##* }; "
          'if [ "$att" != 0 ]; then date +%s > ' + seenfile + "; continue; fi; "
          "seen=$(cat " + seenfile + " 2>/dev/null || echo 0); "
          '[ "$seen" -gt "$last" ] && last=$seen; '
          "now=$(date +%s); "
          "[ $((now - last)) -ge " + str(ttl_seconds) + " ] && { "
            + tmux_cmd + " kill-session -t " + tname + "; exit; "
          "}; "
        "done"
    )

    # Stamp the seen-file on every connect (resets the TTL clock even
    # if a watchdog is already running from an earlier connect), then
    # spawn the watchdog only if one isn't already alive for this slot.
    # Parsing note: `a || b &` is `(a || b) &` in POSIX — the whole
    # subshell is backgrounded, so the exec on the next line runs
    # immediately regardless of which branch fires.
    return (
        "date +%s > " + seenfile + "\n"
        "{ [ -f " + pidfile + " ] && "
          'kill -0 "$(cat ' + pidfile + ' 2>/dev/null)" 2>/dev/null; } || '
        "nohup sh -c '" + body + "' >/dev/null 2>&1 </dev/null &\n"
        "exec " + attach
    )

# Static file serving (Python-only mode, without PHP proxy)
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/websh.js": ("websh.js", "application/javascript; charset=utf-8"),
}


def _log(level, msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    sys.stderr.write("{} [{}] {}\n".format(ts, level, msg))


# ─── Rate limiting ──────────────────────────────────────────────────

_rate_limits = {}  # IP -> list of timestamps
_rate_lock = Lock()


def _check_rate_limit(ip):
    """Return True if request is allowed, False if rate-limited."""
    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW
    with _rate_lock:
        times = _rate_limits.get(ip, [])
        times = [t for t in times if t > cutoff]
        if len(times) >= RATE_LIMIT_MAX:
            _rate_limits[ip] = times
            return False
        times.append(now)
        _rate_limits[ip] = times
        return True


# ─── Config file ────────────────────────────────────────────────────

_config_cache = None
_config_mtime = 0
_CONFIG_EMPTY = {"connections": [], "restrict_hosts": False,
                 "isolate_storage": False}


def _normalize_user_list(value):
    """Accept a list of usernames; return a clean list or None if absent."""
    if not isinstance(value, list):
        return None
    clean = [str(u).strip() for u in value if str(u).strip()]
    return clean or None


def load_config():
    """Load websh.json config with mtime-based caching.

    Each connection entry is classified into one of two kinds:

      - "ready":  password or key is stored server-side. Clicking the card
                  connects immediately — no user input required.
      - "prompt": no password and no key are stored. The user must supply
                  credentials at connect time. Optional allowed_users /
                  denied_users lists constrain which usernames may connect,
                  but only when no fixed username is set on the entry.
    """
    global _config_cache, _config_mtime
    path = os.environ.get("WEBSH_CONFIG", "")
    if not path or not os.path.isfile(path):
        return _CONFIG_EMPTY
    try:
        mtime = os.path.getmtime(path)
        if _config_cache is not None and mtime == _config_mtime:
            return _config_cache
        with open(path, "r") as f:
            cfg = json.load(f)
        conns = cfg.get("connections", [])
        for c in conns:
            c.setdefault("name", "")
            c.setdefault("host", "")
            c.setdefault("port", 22)
            c.setdefault("username", "")
            has_creds = bool(c.get("password")) or bool(c.get("key"))
            c["kind"] = "ready" if has_creds else "prompt"
            c["allowed_users"] = _normalize_user_list(c.get("allowed_users"))
            c["denied_users"] = _normalize_user_list(c.get("denied_users"))

        result = {
            "connections": conns,
            "restrict_hosts": bool(cfg.get("restrict_hosts", False)),
            "isolate_storage": bool(cfg.get("isolate_storage", False)),
        }
        _config_cache = result
        _config_mtime = mtime
        return result
    except Exception as e:
        _log("WARN", "failed to load config: {}".format(e))
        return _CONFIG_EMPTY


def config_public():
    """Return config safe for the client (no passwords or keys)."""
    cfg = load_config()
    safe = []
    for c in cfg["connections"]:
        item = {
            "name": c.get("name", ""),
            "host": c.get("host", ""),
            "port": c.get("port", 22),
            "username": c.get("username", ""),
            "kind": c.get("kind", "ready"),
        }
        if c.get("kind") == "prompt":
            if c.get("allowed_users") is not None:
                item["allowed_users"] = c["allowed_users"]
            if c.get("denied_users") is not None:
                item["denied_users"] = c["denied_users"]
        safe.append(item)
    return {
        "connections": safe,
        "restrict_hosts": cfg["restrict_hosts"],
        "isolate_storage": cfg.get("isolate_storage", False),
        "session_timeout": SESSION_TIMEOUT,
        "version": __version__,
    }


def find_config_connection(name):
    """Find a connection by name in config. Returns full entry with secrets."""
    cfg = load_config()
    for c in cfg["connections"]:
        if c.get("name", "") == name:
            return c
    return None


def is_host_allowed(host, port, username):
    """Manual-connect gate when restrict_hosts is on.

    Kept deliberately strict: when restrict_hosts is true, raw manual
    (host, port, username) POSTs are always rejected — callers must go
    through a named connection. The arguments are kept so the enforcement
    site can pass them in unchanged.
    """
    cfg = load_config()
    return not cfg["restrict_hosts"]


def check_prompt_user(entry, username):
    """Enforce allowed_users / denied_users on a Prompt connection.

    Returns (True, None) when the username is permitted, otherwise
    (False, error_message). The rule is ignored when the entry has a
    fixed username (the caller should not even call us in that case).
    """
    au = entry.get("allowed_users")
    du = entry.get("denied_users")
    if au:
        if username not in au:
            return False, "username is not in the allowed list for this connection"
        return True, None
    if du:
        if username in du:
            return False, "username is not allowed on this connection"
    return True, None


# ─── Validation ──────────────────────────────────────────────────────

def clamp(value, lo, hi, default):
    """Parse int and clamp to range. Returns default on failure."""
    try:
        v = int(value)
        return max(lo, min(hi, v))
    except (TypeError, ValueError):
        return default


# ─── Session management ─────────────────────────────────────────────

sessions = OrderedDict()
sessions_lock = Lock()


class SSHSession(object):
    """Manages a single SSH connection via PTY subprocess."""

    def __init__(self, session_id, host, port, username, password, cols, rows,
                 key=None, ssh_options=None, is_background=False,
                 persistent=False, slot_id=None, tmux_cmd="tmux"):
        self.id = session_id
        self.master_fd = None
        self.pid = None
        self.output_buf = b""
        self.buf_lock = Lock()
        self.alive = True
        self.last_activity = time.time()
        self.is_background = is_background
        self._password = password
        self._password_sent = False
        self._pw_buf = b""
        self.auth_failed = False
        self._auth_buf = b""
        # Number of PTY bytes already scanned for auth-fail patterns.
        # Once we pass a small post-password window without hitting a
        # rejection, assume auth succeeded so later shell output can't
        # accidentally trip the detector.
        self._auth_bytes_seen = 0
        # Raw waitpid() status of the ssh child — used after exit to
        # classify auth vs network failure via the 255 exit code.
        self._exit_status = None
        self._key_file = None
        self._ssh_options = ssh_options or {}
        self.persistent = bool(persistent and slot_id)
        self.slot_id = slot_id if self.persistent else None
        self.tmux_cmd = tmux_cmd if _TMUX_CMD_RE.match(tmux_cmd or "") else "tmux"

        # Connection coordinates kept for the ControlMaster side-channel
        # (see terminate_remote_tmux). Only used in the persistent path.
        self._host = host
        self._port = port
        self._username = username

        # Per-session ssh ControlPath. Opened by the master ssh process
        # (see _spawn) when persistent; a second `ssh -S <path> ...`
        # invocation piggybacks on the same authenticated channel to
        # run tmux kill-session without re-entering credentials and
        # without depending on the user's tmux prefix.
        self._control_path = None
        if self.persistent:
            self._control_path = os.path.join(
                tempfile.gettempdir(),
                "websh-mux-{}.sock".format(self.id.replace("-", "")[:16]))

        if key:
            self._key_file = self._write_key(key)

        self._spawn(host, port, username, cols, rows)

        self._reader = Thread(target=self._read_loop, daemon=True)
        self._reader.start()


    @staticmethod
    def _write_key(key_data):
        """Write SSH private key to a secure temp file. Returns path."""
        fd, path = tempfile.mkstemp(prefix="websh_key_", suffix=".pem")
        try:
            text = key_data.strip() + "\n"
            os.write(fd, text.encode("utf-8"))
        finally:
            os.close(fd)
        os.chmod(path, 0o600)
        return path

    def _spawn(self, host, port, username, cols, rows):
        """Fork a PTY and exec ssh."""
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["LANG"] = "en_US.UTF-8"
        env["LC_ALL"] = "en_US.UTF-8"

        ssh_cmd = [
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            # Cap password retries at one — on rejection ssh exits 255
            # cleanly instead of looping on the PTY, giving us a
            # locale-proof primary auth-failure signal.
            "-o", "NumberOfPasswordPrompts=1",
            "-p", str(port),
            "-l", username,
        ]

        if self.persistent:
            # Force remote TTY allocation — required when ssh has a trailing
            # remote command (default is no TTY, but tmux needs one).
            ssh_cmd.insert(1, "-tt")
            # ControlMaster: this ssh is the master; a later
            # `ssh -S <sock> <host> tmux kill-session ...` reuses the
            # already-authenticated channel. ControlPersist=no means the
            # socket dies with the master process (no orphaned masters).
            # Placed before user ssh_options so our values win (ssh uses
            # first-wins semantics for -o).
            ssh_cmd.extend([
                "-o", "ControlMaster=auto",
                "-o", "ControlPath=" + self._control_path,
                "-o", "ControlPersist=no",
            ])

        if self._key_file:
            ssh_cmd.extend(["-i", self._key_file])

        # Per-connection SSH options from config
        for k, v in self._ssh_options.items():
            ssh_cmd.extend(["-o", "{}={}".format(k, v)])

        ssh_cmd.append("--")
        ssh_cmd.append(host)

        if self.persistent:
            # tmux on the target: attach if exists (-A), detach any stale
            # client (-D). First-time creation starts a login shell.
            # When TMUX_IDLE_TTL > 0 the remote command also spawns a
            # watchdog that reaps the session after TTL seconds idle.
            # slot_id + tmux_cmd are validated so no escaping needed.
            ssh_cmd.append(_build_remote_command(
                self.slot_id, self.tmux_cmd, TMUX_IDLE_TTL))

        pid, fd = pty.fork()
        if pid == 0:
            os.execvpe("ssh", ssh_cmd, env)
            sys.exit(1)

        self.pid = pid
        self.master_fd = fd
        self._set_winsize(cols, rows)

    def _set_winsize(self, cols, rows):
        try:
            fcntl.ioctl(
                self.master_fd, termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0),
            )
        except Exception:
            pass

    def _read_loop(self):
        """Background thread: reads PTY output into buffer."""
        try:
            while self.alive:
                try:
                    r, _, _ = select.select([self.master_fd], [], [], 0.05)
                except (ValueError, OSError):
                    break

                if r:
                    try:
                        data = os.read(self.master_fd, PTY_READ_SIZE)
                    except OSError:
                        break
                    if not data:
                        break

                    # Auto-type password on prompt (accumulate to handle split reads)
                    if self._password and not self._password_sent:
                        self._pw_buf += data
                        if len(self._pw_buf) > 256:
                            self._pw_buf = self._pw_buf[-256:]
                        text = self._pw_buf.decode("latin-1", errors="replace").lower()
                        if any(p in text for p in PASSWORD_PROMPTS):
                            time.sleep(0.1)
                            try:
                                os.write(self.master_fd,
                                         (self._password + "\n").encode())
                            except OSError:
                                break
                            _log("INFO", "session {} auto-typed password ({} chars){}".format(
                                self.id, len(self._password),
                                " [bg]" if self.is_background else ""))
                            self._password_sent = True
                            self._password = None
                            self._pw_buf = b""

                    # After we sent the password, watch for ssh's
                    # "Permission denied" so we don't loop on bad creds.
                    # Scope the scan to the first 4 KB post-password so
                    # later shell output (e.g. `sudo: permission denied`
                    # from a user's command) can't kill the session.
                    # We also treat a *second* "password:" prompt as a
                    # rejection signal — some targets phrase the failure
                    # differently and the second prompt is unambiguous.
                    elif (self._password_sent and not self.auth_failed
                          and self._auth_bytes_seen < 4096):
                        self._auth_bytes_seen += len(data)
                        self._auth_buf += data
                        if len(self._auth_buf) > 512:
                            self._auth_buf = self._auth_buf[-512:]
                        atext = self._auth_buf.decode(
                            "latin-1", errors="replace").lower()
                        fail = (any(p in atext for p in AUTH_FAIL_PATTERNS)
                                or any(p in atext for p in PASSWORD_PROMPTS))
                        if fail:
                            self.auth_failed = True
                            _log("INFO", "session {} auth failed{}".format(
                                self.id,
                                " [bg]" if self.is_background else ""))
                            # Append this final chunk so the client sees
                            # *why* (the rejection message + the re-prompt)
                            # before we tear down.
                            with self.buf_lock:
                                self.output_buf += data
                                if len(self.output_buf) > OUTPUT_BUF_MAX:
                                    self.output_buf = (
                                        self.output_buf[-OUTPUT_BUF_KEEP:])
                            self._auth_buf = b""
                            try:
                                os.kill(self.pid, signal.SIGTERM)
                            except Exception:
                                pass
                            break

                    with self.buf_lock:
                        self.output_buf += data
                        if len(self.output_buf) > OUTPUT_BUF_MAX:
                            self.output_buf = self.output_buf[-OUTPUT_BUF_KEEP:]

                # Check if child exited
                try:
                    pid, status = os.waitpid(self.pid, os.WNOHANG)
                    if pid != 0:
                        self._exit_status = status
                        break
                except ChildProcessError:
                    break
        except Exception:
            pass
        finally:
            # Drain remaining PTY data (exit escape sequences, etc.)
            try:
                for _ in range(PTY_DRAIN_ROUNDS):
                    r, _, _ = select.select(
                        [self.master_fd], [], [], PTY_DRAIN_INTERVAL)
                    if r:
                        leftover = os.read(self.master_fd, PTY_READ_SIZE)
                        if leftover:
                            with self.buf_lock:
                                self.output_buf += leftover
                        else:
                            break
                    else:
                        break
            except Exception:
                pass

            # ssh exit status 255 = anything ssh itself rejected: auth
            # failure, connection refused, host key mismatch, etc. If the
            # output tail contains an auth-shaped phrase, classify as
            # auth_failed so the client can re-prompt for credentials.
            # This complements the inline text scan: the exit-code path
            # is locale-proof, catches key-only auth rejection (which
            # never reaches a "password:" prompt), and is impossible to
            # miss on slow or chatty targets.
            if (not self.auth_failed
                    and self._exit_status is not None
                    and os.WIFEXITED(self._exit_status)
                    and os.WEXITSTATUS(self._exit_status) == 255):
                with self.buf_lock:
                    tail = self.output_buf[-2048:].decode(
                        "latin-1", errors="replace").lower()
                if any(p in tail for p in AUTH_FAIL_PATTERNS):
                    self.auth_failed = True
                    _log("INFO", "session {} auth failed (exit 255){}".format(
                        self.id,
                        " [bg]" if self.is_background else ""))

            # Append terminal reset so the frontend restores normal screen
            with self.buf_lock:
                self.output_buf += TERM_RESET

            self.alive = False

    def read(self):
        """Return and clear buffered output."""
        with self.buf_lock:
            data = self.output_buf
            self.output_buf = b""
        # Only count non-empty reads as activity. Long-poll calls read()
        # in a tight loop, so bumping on every call would freshen
        # last_activity ~100×/s and defeat the server-side idle timeout.
        if data:
            self.last_activity = time.time()
        return data

    def write(self, data):
        """Send input to SSH process."""
        if not self.alive:
            return False
        self.last_activity = time.time()
        try:
            os.write(self.master_fd, data)
            return True
        except OSError:
            self.alive = False
            return False

    def resize(self, cols, rows):
        self.last_activity = time.time()
        self._set_winsize(cols, rows)

    def terminate_remote_tmux(self):
        """Kill the remote tmux session deterministically.

        Primary path: open a second ssh on the same ControlMaster socket
        and run `tmux kill-session` directly on the target. This is
        prefix-agnostic (doesn't care what the user's tmux prefix is or
        whether they're inside vim), reuses the existing authentication
        (no password re-prompt), and completes in one round trip.

        Fallback path: if the control socket isn't ready (master still
        authenticating) or the side-channel ssh fails, poke the PTY
        directly — first the default Ctrl-B prefix, then a Ctrl-C
        followed by a shell-level `tmux kill-session`. This is only
        best-effort (misses on non-default prefix + foreground editor),
        but retained as a safety net.

        Safe to call on non-persistent sessions: it's a no-op.
        """
        if not self.persistent or not self.slot_id:
            return
        target_name = "websh-" + self.slot_id

        # Primary: ControlMaster side-channel.
        if (self._control_path and os.path.exists(self._control_path)
                and self._host and self._username):
            try:
                result = subprocess.run(
                    ["ssh",
                     "-o", "ControlPath=" + self._control_path,
                     "-o", "BatchMode=yes",
                     "-o", "ConnectTimeout=3",
                     "-p", str(self._port),
                     "-l", self._username,
                     self._host,
                     self.tmux_cmd, "kill-session", "-t", target_name],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                )
                if result.returncode == 0:
                    _log("INFO", "session {} tmux kill-session {} via mux ok"
                         .format(self.id, target_name))
                    return
            except (OSError, subprocess.SubprocessError):
                pass

        # Fallback: poke the PTY if the master is still alive.
        if not self.alive:
            return
        target = target_name.encode()
        try:
            os.write(self.master_fd, b"\x02:kill-session -t " + target + b"\r")
            time.sleep(0.4)
            if self.alive:
                os.write(self.master_fd,
                         b"\x03tmux kill-session -t " + target + b"\r")
                time.sleep(0.4)
        except OSError:
            pass

    def close(self):
        self.alive = False
        try:
            os.close(self.master_fd)
        except Exception:
            pass
        # SIGTERM, wait briefly, SIGKILL if still alive, then reap
        try:
            os.kill(self.pid, signal.SIGTERM)
        except Exception:
            pass
        for _ in range(10):
            try:
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid != 0:
                    break
            except ChildProcessError:
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
            except Exception:
                pass
        if self._key_file:
            try:
                os.unlink(self._key_file)
            except Exception:
                pass
            self._key_file = None
        if self._control_path:
            # The master ssh owns the socket and cleans it up on exit,
            # but if it died ungracefully (SIGKILL) the stale node
            # remains. Unlink defensively.
            try:
                os.unlink(self._control_path)
            except OSError:
                pass
            self._control_path = None

    def is_expired(self):
        return time.time() - self.last_activity > SESSION_TIMEOUT


def cleanup():
    """Remove timed-out sessions and stale rate limit entries."""
    with sessions_lock:
        expired = [sid for sid, s in sessions.items() if s.is_expired()]
        for sid in expired:
            _log("INFO", "session {} expired, cleaning up".format(sid))
            sessions[sid].close()
            del sessions[sid]
    # Prune stale rate limit entries to prevent unbounded memory growth
    cutoff = time.time() - RATE_LIMIT_WINDOW
    with _rate_lock:
        stale = [ip for ip, times in _rate_limits.items()
                 if not any(t > cutoff for t in times)]
        for ip in stale:
            del _rate_limits[ip]


def _cleanup_loop():
    """Background thread: periodically removes expired sessions."""
    while True:
        time.sleep(30)
        try:
            cleanup()
        except Exception:
            pass


# ─── HTTP handler ────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def _path(self):
        p = self.path.split("?")[0].rstrip("/")
        return p or "/"

    # ── Routes ──

    def _resolve_action(self):
        """Extract API action from /api/<action> or api.php?action=<action>."""
        p = self._path()
        if p.startswith("/api/"):
            return p[5:]
        if p == "/api.php" or p.endswith("/api.php"):
            params = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query)
            return params.get("action", [""])[0]
        return ""

    def _serve_static(self, filename, content_type):
        """Serve a static file from the script directory."""
        filepath = os.path.join(_SCRIPT_DIR, filename)
        if not os.path.isfile(filepath):
            self.send_response(404)
            self.end_headers()
            return
        with open(filepath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        action = self._resolve_action()
        if action == "connect":
            self._connect()
        elif action == "input":
            self._input()
        elif action == "resize":
            self._resize()
        elif action == "disconnect":
            self._disconnect()
        else:
            self._json({"error": "not found"}, 404)

    def do_GET(self):
        p = self._path()
        static = _STATIC_FILES.get(p)
        if static:
            self._serve_static(*static)
            return
        action = self._resolve_action()
        if action == "output":
            self._output()
        elif action == "config":
            self._json(config_public())
        elif action == "ping":
            self._json({"ok": True, "version": __version__})
        else:
            self._json({"error": "not found"}, 404)

    # ── Handlers ──

    def _client_ip(self):
        peer = self.client_address[0]
        if peer in _TRUSTED_PROXIES:
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[0].strip()
        return peer

    def _valid_sid(self, sid):
        return bool(sid and _UUID_RE.match(sid))

    def _connect(self):
        # Rate limit by IP
        ip = self._client_ip()
        if not _check_rate_limit(ip):
            _log("WARN", "rate limited: {}".format(ip))
            self._json({"error": "too many connection attempts"}, 429)
            return

        try:
            body = json.loads(self._body().decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, 400)
            return

        cols = clamp(body.get("cols"), MIN_COLS, MAX_COLS, 80)
        rows = clamp(body.get("rows"), MIN_ROWS, MAX_ROWS, 24)
        is_bg = bool(body.get("background", False))

        # Persistent session flags. `resume_slot_id` implies persistent=true and
        # reuses the existing tmux session on the target. `slot_id` + persistent
        # starts a new session that later refreshes can resume.
        resume_slot_id = (body.get("resume_slot_id") or "").strip()
        slot_id_in = (body.get("slot_id") or "").strip()
        persistent = bool(body.get("persistent", False)) or bool(resume_slot_id)
        if persistent:
            slot_id = resume_slot_id or slot_id_in
            if not _SLOT_ID_RE.match(slot_id):
                self._json({"error": "invalid slot_id"}, 400)
                return
        else:
            slot_id = None

        tmux_cmd = (body.get("tmux_cmd") or "tmux").strip()
        if not _TMUX_CMD_RE.match(tmux_cmd):
            self._json({"error": "invalid tmux_cmd"}, 400)
            return

        # Resolve credentials: by config connection name, or from request body
        conn_name = body.get("connection", "").strip()
        ssh_options = {}
        if conn_name:
            entry = find_config_connection(conn_name)
            if not entry:
                self._json({"error": "connection not found"}, 404)
                return
            host = entry.get("host", "")
            port = clamp(entry.get("port"), MIN_PORT, MAX_PORT, 22)
            ssh_options = entry.get("ssh_options", {})
            if entry.get("kind") == "prompt":
                # User supplies credentials at connect time.
                fixed_user = entry.get("username", "")
                username = fixed_user or body.get("username", "").strip()
                password = body.get("password", "")
                key = body.get("key", "")
                if not username:
                    self._json({"error": "username is required"}, 400)
                    return
                if not password and not key:
                    self._json({"error": "password or key is required"}, 400)
                    return
                if not fixed_user:
                    ok, err = check_prompt_user(entry, username)
                    if not ok:
                        self._json({"error": err}, 403)
                        return
            else:
                username = entry.get("username", "")
                password = entry.get("password", "")
                key = entry.get("key", "")
        else:
            host = body.get("host", "").strip()
            username = body.get("username", "").strip()
            port = clamp(body.get("port"), MIN_PORT, MAX_PORT, 22)
            password = body.get("password", "")
            key = body.get("key", "")

        if not host or not username:
            self._json({"error": "host and username are required"}, 400)
            return

        # Reject values that could be interpreted as SSH flags
        if host.startswith("-") or username.startswith("-"):
            self._json({"error": "invalid host or username"}, 400)
            return

        # Free-form manual connect is unrestricted unless restrict_hosts
        # pins the user to a ready server-side connection.
        if not conn_name and not is_host_allowed(host, port, username):
            self._json({"error": "connections to this host are not allowed"}, 403)
            return

        # Check session limit (foreground and background counted separately)
        with sessions_lock:
            if is_bg:
                count = sum(1 for s in sessions.values() if s.is_background)
                if count >= MAX_BG_SESSIONS:
                    self._json({"error": "too many background sessions"}, 429)
                    return
            else:
                count = sum(1 for s in sessions.values()
                            if not s.is_background)
                if count >= MAX_SESSIONS:
                    self._json({"error": "too many active sessions"}, 429)
                    return

        sid = str(uuid.uuid4())
        session = None
        try:
            session = SSHSession(
                session_id=sid,
                host=host,
                port=port,
                username=username,
                password=password,
                cols=cols,
                rows=rows,
                key=key,
                ssh_options=ssh_options,
                is_background=is_bg,
                persistent=persistent,
                slot_id=slot_id,
                tmux_cmd=tmux_cmd,
            )
            with sessions_lock:
                sessions[sid] = session

            time.sleep(CONNECT_SETTLE_TIME)
            _log("INFO", "new session {} for {}@{}:{}{}".format(
                sid, username, host, port,
                " [persistent slot=" + slot_id + "]" if persistent else ""))
            self._json({
                "session_id": sid,
                "status": "connecting",
                "alive": session.alive,
                "auth_failed": session.auth_failed,
                "persistent": persistent,
                "slot_id": slot_id,
                "tmux_cmd": session.tmux_cmd,
            })
        except Exception as e:
            if session:
                session.close()
            self._json({"error": str(e)}, 500)

    def _input(self):
        try:
            raw = self._body()
            body = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._json({"error": "invalid json: " + str(e)}, 400)
            return

        sid = body.get("session_id", "")
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return

        try:
            data = body.get("data", "").encode("utf-8")
            ok = session.write(data)
            self._json({"ok": ok, "alive": session.alive})
        except Exception as e:
            self._json({"error": "input error: " + str(e)}, 500)

    def _output(self):
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]

        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return

        # Long-poll: wait up to POLL_TIMEOUT seconds for data
        deadline = time.time() + POLL_TIMEOUT
        while time.time() < deadline:
            data = session.read()
            if data:
                self._json({
                    "data": base64.b64encode(data).decode("ascii"),
                    "alive": session.alive,
                    "auth_failed": session.auth_failed,
                })
                return
            if not session.alive:
                self._json({"data": "", "alive": False,
                            "auth_failed": session.auth_failed})
                return
            time.sleep(POLL_INTERVAL)

        self._json({"data": "", "alive": session.alive,
                    "auth_failed": session.auth_failed})

    def _resize(self):
        try:
            body = json.loads(self._body().decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, 400)
            return

        sid = body.get("session_id", "")
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return

        cols = clamp(body.get("cols"), MIN_COLS, MAX_COLS, 80)
        rows = clamp(body.get("rows"), MIN_ROWS, MAX_ROWS, 24)
        session.resize(cols, rows)
        self._json({"ok": True})

    def _disconnect(self):
        try:
            body = json.loads(self._body().decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, 400)
            return

        sid = body.get("session_id", "")
        terminate = bool(body.get("terminate", False))
        with sessions_lock:
            session = sessions.pop(sid, None)
        if session:
            if terminate:
                session.terminate_remote_tmux()
            session.close()
        self._json({"ok": True})


class Server(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    # Start background cleanup thread
    t = Thread(target=_cleanup_loop, daemon=True)
    t.start()

    server = Server((HOST, PORT), Handler)

    def shutdown(signum, frame):
        with sessions_lock:
            for s in sessions.values():
                s.close()
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    _log("INFO", "websh v{} listening on http://{}:{}".format(
        __version__, HOST, PORT))
    server.serve_forever()


if __name__ == "__main__":
    main()
