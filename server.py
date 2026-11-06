#!/usr/bin/env python3
"""
websh — lightweight SSH terminal backend.

REST API server that manages SSH sessions via PTY.
Designed to run on shared hosting with Python 3.5+, zero dependencies.
Listens on 127.0.0.1 only — meant to be proxied through Apache/nginx via PHP.

Environment variables:
    PORT                  — listen port (default: 8765)
    HOST                  — bind address (default: 127.0.0.1)
    WEBSH_SOCKET          — listen on this Unix socket path instead of
                            HOST:PORT (the PHP proxy always sets it)
    SESSION_TIMEOUT       — seconds of inactivity before cleanup (default: 300)
    MAX_SESSIONS          — max concurrent SSH sessions (default: 50)
    WEBSH_CONFIG          — path to websh.json config file (optional)
    TRUSTED_PROXIES       — comma-separated IPs to trust X-Forwarded-For from (default: 127.0.0.1)
    MAX_BG_SESSIONS       — max background SSH sessions for file transfer (default: 50)
    WEBSH_MAX_THREADS     — max concurrent HTTP worker threads; new requests
                            past this get 503 immediately (default:
                            4*(MAX_SESSIONS+MAX_BG_SESSIONS)+64 = 464)
    RATE_LIMIT_MAX        — max /api/connect attempts per IP per window (default: 50)
    RATE_LIMIT_WINDOW     — rate-limit window in seconds (default: 60)
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
    GET  /api/stream      — Server-Sent Events stream of terminal output
                            (low-latency alternative to /api/output; falls
                            back to long-poll if the proxy buffers it)
    POST /api/resize      — resize terminal
    POST /api/disconnect  — close session
    POST /api/upload      — stream a file body to $HOME/<path> on remote
    POST /api/upload_finalize — mv an uploaded tmp into pane cwd (persistent)
    POST /api/upload_cancel — remove a partial/staged upload tmp
    POST /api/tmux_options — push tmux options live into a persistent session
    GET  /api/tmux_capture — capture full tmux pane buffer (persistent only)
    GET  /api/config      — return server-side config (without secrets)
    GET  /api/ping        — health check
"""

import base64
import binascii
import datetime
import errno
import fcntl
import gzip
import hashlib
import ipaddress
import json
import os
import pty
import re
import select
import selectors
import shlex
import signal
import socket
import socketserver
import stat
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
from threading import Thread, Lock, RLock, Event, BoundedSemaphore

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
    HAS_CRYPTOGRAPHY = True
except ImportError:  # pragma: no cover - exercised by the no-deps CI job
    AESGCM = None
    InvalidTag = Exception
    HAS_CRYPTOGRAPHY = False

# ─── Knob resolution ─────────────────────────────────────────────────
#
# Every tunable resolves through _knob():
#   1. env WEBSH_<NAME>  — the unambiguous alias wins: bare generic
#      names (PORT, HOST, MAX_SESSIONS, ...) can be set by unrelated
#      software in a shared environment, which is exactly the collision
#      the prefix defends against;
#   2. env <NAME>        — the historically documented name;
#   3. websh.json "server" object — the only plane a shared-hosting
#      deployment can reliably write to (api.php's auto-start
#      guarantees only WEBSH_CONFIG and PORT in the environment);
#      HOST and TRUSTED_PROXIES are env-only (_ENV_ONLY_KNOBS);
#   4. the built-in default.
#
# The JSON plane is read ONCE at import: knobs are process-lifetime
# constants and mid-flight changes to most of them would be unsound.
# WEBSH_CONFIG itself is env-only — it locates the JSON.
# Full table: docs/configuration.md.

def _server_knobs():
    """The websh.json "server" object, or {} when absent/broken."""
    path = os.environ.get("WEBSH_CONFIG", "")
    if not path:
        return {}
    try:
        with open(path, "r") as f:
            section = json.load(f).get("server")
        return section if isinstance(section, dict) else {}
    except Exception:
        # load_config() re-reads the file later and WARNs properly;
        # knob resolution just falls back to env/defaults.
        return {}


_SERVER_KNOBS = _server_knobs()


# Knobs that must NOT be settable from websh.json: a config-file write
# primitive should not be able to rebind the loopback-only server to a
# public interface or take over X-Forwarded-For trust (rate-limit /
# per-IP-cap spoofing), nor redirect the filesystem paths the server
# writes to — WEBSH_ACCESS_LOG (arbitrary-path O_APPEND|O_CREAT) and
# WEBSH_CREDS_PATH (where the vault's _save_creds_atomic os.replace()
# lands, i.e. arbitrary-path file overwrite). All env only.
# WEBSH_AUTH_HEADER flips authentication semantics and WEBSH_RECORD_DIR
# is another filesystem write path, so both are env-only as well.
_ENV_ONLY_KNOBS = frozenset({
    "HOST", "TRUSTED_PROXIES", "WEBSH_ACCESS_LOG", "WEBSH_CREDS_PATH",
    "WEBSH_AUTH_HEADER", "WEBSH_RECORD_DIR", "WEBSH_RECORD_INPUT", "WEBSH_SOCKET"})

# Every name that went through _knob() at import: lets main() warn about
# "server" keys that can never take effect (env-only, or a typo) instead
# of ignoring them silently - an operator who put WEBSH_AUTH_HEADER in
# websh.json would otherwise run unauthenticated without a hint.
_KNOWN_KNOBS = set()


def _knob(name, default):
    """Resolve one tunable (raw value; callers cast). See the
    precedence comment above."""
    _KNOWN_KNOBS.add(name)
    if not name.startswith("WEBSH_"):
        v = os.environ.get("WEBSH_" + name)
        if v is not None:
            return v
    v = os.environ.get(name)
    if v is not None:
        return v
    if name in _SERVER_KNOBS and name not in _ENV_ONLY_KNOBS:
        return _SERVER_KNOBS[name]
    return default


def _bool_knob(name):
    """True for 1/true (any case, str or JSON literal)."""
    return str(_knob(name, "")).lower() in ("1", "true")


# Operator opt-in until the client-side PR (PR-C) lands. Default off
# so a server upgrade does not advertise endpoints the bundled client
# does not know how to call. Will become the default once PR-C ships.
WEBSH_VAULT_ENABLE = _bool_knob("WEBSH_VAULT_ENABLE")

# Operator opt-in to the future v1.0.0 default. With this set, any
# plaintext credential in websh.json blocks startup with an actionable
# message. Without it, plaintext still works and emits a WARN once.
WEBSH_REQUIRE_VAULT = _bool_knob("WEBSH_REQUIRE_VAULT")

# Runtime trap: flipped True when the on-disk creds file is unreadable
# (unsupported schema version, etc) to refuse-to-write rather than
# silently overwrite. Cleared only by process restart.
_vault_disabled = False
# Why the creds file on disk cannot be used right now, or None. Unlike
# _vault_disabled (an unsupported schema: latched until restart) this is
# re-evaluated on every load, so fixing the file needs no restart. While
# it is set every WRITE is refused: rewriting "the store" from an empty
# stand-in would permanently delete every other user's vault.
_creds_unreadable = None

__version__ = "0.2.0"
# Wire-protocol version, shipped in /api/config and /api/ping and
# checked by the bundled client at page load. Bump it on any breaking
# change to an endpoint's request/response shape, semantics or status
# codes (see docs/protocol.md) so a browser that boots with a STALE
# CACHED websh.js after a server upgrade gets a "reload the page"
# prompt instead of failing obscurely. Additive fields do NOT bump it.
PROTO_VERSION = 1

# ─── Configuration ───────────────────────────────────────────────────

def _int_env(name, default):
    try:
        return int(_knob(name, default))
    except (TypeError, ValueError):
        return int(default)

PORT = _int_env("PORT", "8765")
HOST = str(_knob("HOST", "127.0.0.1"))
# Listen on a Unix socket at this path instead of HOST:PORT. The PHP
# proxy always sets it: on shared hosting 127.0.0.1 is common to every
# account, so a TCP port is reachable by any co-tenant. Env-only (read
# directly, not via _knob): a websh.json write must not pick a path the
# server unlinks and binds.
WEBSH_SOCKET = os.environ.get("WEBSH_SOCKET", "").strip()
# Optional header-trust authentication. When set to a header name (e.g.
# "Remote-User" from oauth2-proxy / Authelia / authentik), every request
# except /api/ping requires that header, its value becomes the request's
# identity, sessions are stamped with their creator's identity at
# connect, and every session endpoint enforces ownership (403 across
# users). The header is only read when the TCP peer is in
# TRUSTED_PROXIES — exactly the X-Forwarded-For trust rule — so a
# client talking to the backend directly cannot mint identities; with
# the feature on, an untrusted peer is simply unauthenticated (401).
WEBSH_AUTH_HEADER = str(_knob("WEBSH_AUTH_HEADER", "")).strip()
# Opt-in session recording (asciicast v2, one .cast file per session,
# created 0600). OFF unless WEBSH_RECORD_DIR names a directory the
# server user can write. Recording is OUTPUT-ONLY; keystroke/input
# recording is hard-disabled (see WEBSH_RECORD_INPUT below). Recording is
# best-effort: a write failure disables it for that session, never the PTY.
WEBSH_RECORD_DIR = str(_knob("WEBSH_RECORD_DIR", "")).strip()
# Input recording (keystrokes — which include any password typed at a
# sudo/login prompt INSIDE the session) is HARD-DISABLED. Capturing
# keystrokes to disk on a public-facing deployment is a liability we do
# not accept, so recording is always output-only regardless of the
# environment. The env var is read ONLY to warn an operator who sets it
# (see main()). The browser-form ssh password was never recorded either
# way (it is auto-typed below the input tee).
_WEBSH_RECORD_INPUT_REQUESTED = _bool_knob("WEBSH_RECORD_INPUT")
WEBSH_RECORD_INPUT = False
# Per-file ceiling. A `cat /dev/urandom` session would otherwise write
# unbounded (and invalid UTF-8 inflates ~3-5x through replacement +
# JSON escaping). Hitting the cap stops the recording with one WARN;
# the session itself is never touched. 0 disables the cap.
WEBSH_RECORD_MAX_BYTES = max(0, _int_env("WEBSH_RECORD_MAX_BYTES",
                                         str(64 * 1024 * 1024)))
SESSION_TIMEOUT = _int_env("SESSION_TIMEOUT", "300")
MAX_SESSIONS = _int_env("MAX_SESSIONS", "50")
# Per-source-IP active session cap. 0 disables the check (preserve legacy
# behaviour). Counts foreground and background sessions together, since
# an abuser holding N sessions does not care about the classification.
MAX_SESSIONS_PER_IP = _int_env("MAX_SESSIONS_PER_IP", "0")
MAX_BG_SESSIONS = _int_env("MAX_BG_SESSIONS", "50")
# Bound on concurrent HTTP worker threads. ThreadingMixIn would spawn a
# thread per request without limit — a glitchy client that reconnects
# /api/stream in a tight loop could explode the thread count before any
# session-cap triggers. Default leaves room for every active session's
# SSE worker (and a long-poll fallback worker on each) plus headroom
# for short requests. When the bound is hit the new request gets a
# 503 immediately instead of queuing.
def _clamp_max_threads(value):
    """Clamp WEBSH_MAX_THREADS to >=1 with a startup WARN on out-of-range
    input. Factored out so tests can drive the same clamp logic the
    module uses at import time, instead of re-implementing the
    arithmetic inside the test body.

    BoundedSemaphore(0) raises ValueError at startup, and an operator
    who sets WEBSH_MAX_THREADS=0 thinking "unlimited" (the way some
    other knobs work) would kill the process before serving anything.
    Clamp loudly so the misconfiguration surfaces instead of crashing.
    There is no "unlimited" mode by design — use a large explicit value.
    """
    if value < 1:
        sys.stderr.write(
            "WARN: WEBSH_MAX_THREADS={} is below the minimum of 1; "
            "clamping. There is no 'unlimited' mode — set a large "
            "value if you want effectively no cap.\n".format(value))
        return 1
    return value


MAX_THREADS = _clamp_max_threads(_int_env(
    "WEBSH_MAX_THREADS", str(4 * (MAX_SESSIONS + MAX_BG_SESSIONS) + 64)))
# Hard cap on a single binary upload via /api/upload (bytes).
MAX_UPLOAD_SIZE = _int_env("MAX_UPLOAD_SIZE", str(2 * 1024 * 1024 * 1024))
# Hard cap on a single binary download via /api/download (bytes). The
# browser accumulates the whole stream into a Blob before saving, so a
# multi-GB file would OOM the tab. The old base64 download path had a
# 37 MB cap; 2 GB matches the upload limit and modern browsers' Blob
# ceilings without eating the tab on typical hardware.
MAX_DOWNLOAD_SIZE = _int_env("MAX_DOWNLOAD_SIZE", str(2 * 1024 * 1024 * 1024))
# How long a single upload may take before we kill the side-channel ssh.
UPLOAD_TIMEOUT = _int_env("UPLOAD_TIMEOUT", "1800")
# Idle bound on the side-channel pipe during a transfer: how long we
# wait for the remote to produce the download header / the next chunk,
# or to accept the next upload chunk, before killing the helper ssh.
# The side channel returns a raw Popen, so nothing else bounds these
# reads - a wedged ControlMaster pinned a worker thread (and a
# MAX_THREADS permit) until the master session itself died.
TRANSFER_IDLE_TIMEOUT = _int_env("TRANSFER_IDLE_TIMEOUT", "60")


def _wait_fd(fd, timeout, write=False):
    """Block until `fd` is readable (or writable), at most `timeout`
    seconds. Returns False on timeout."""
    r, w, _ = select.select([] if write else [fd], [fd] if write else [],
                            [], max(0.0, timeout))
    return bool(r or w)
# Cap on the in-memory request body for control/JSON endpoints (connect,
# input, resize, save, tmux_options, upload_finalize/cancel, ...). Stops a
# bogus/huge Content-Length from making the single-process server buffer
# gigabytes into RAM (OOM DoS). 8 MB covers a large terminal paste on
# /api/input (the client refuses anything bigger and surfaces an error)
# while staying ~1000x a real connect body. The binary upload path streams
# separately and is bounded by MAX_UPLOAD_SIZE instead.
MAX_BODY_SIZE = _int_env("MAX_BODY_SIZE", str(8 * 1024 * 1024))

# Ceilings for /api/tmux_capture. A persistent session's tmux scrollback
# can be enormous — history-limit is clamped only at 10M lines — and the
# capture is buffered whole into server RAM before it is written out, so
# an unbounded capture is a memory-exhaustion lever (the endpoint is also
# unauthenticated beyond the session id). The line cap bounds what tmux
# emits at the source (capture-pane -S -<N> keeps the most recent N lines
# of history); the byte cap is the absolute ceiling against pathological
# long lines. Output past either limit is truncated to the most recent
# content with a marker line prepended so the export isn't silently
# misleading.
# max(1, …): a 0/negative override would otherwise break the tmux command
# (`-S -0` / `-S --5`) or, for the byte cap, silently keep the whole buffer
# (Python's data[-0:] is data[0:], i.e. everything) — defeating the cap.
MAX_TMUX_CAPTURE_LINES = max(1, _int_env("WEBSH_TMUX_CAPTURE_LINES", "100000"))
MAX_TMUX_CAPTURE_BYTES = max(1, _int_env("WEBSH_TMUX_CAPTURE_BYTES",
                                         str(16 * 1024 * 1024)))

# Trusted proxies (comma-separated IPs) whose X-Forwarded-For header is trusted.
# Only requests from these IPs will have their X-Forwarded-For used for rate limiting.
_TRUSTED_PROXIES = set(
    p.strip() for p in str(_knob("TRUSTED_PROXIES", "127.0.0.1")).split(",")
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
STREAM_TAKEOVER_MIN_GAP = 15  # seconds between takeovers of one session's stream
POLL_INTERVAL = 0.01          # seconds between buffer checks
PTY_DRAIN_ROUNDS = 50         # max iterations to drain PTY on exit
PTY_DRAIN_INTERVAL = 0.01    # seconds per drain round
PTY_READ_SIZE = 65536         # bytes per read
OUTPUT_BUF_MAX = 1048576      # 1 MB — truncate if exceeded
OUTPUT_BUF_KEEP = 524288      # keep last 512 KB on truncation
# Replay window for cursor readers (lossless reconnect). Every byte the
# PTY produced gets an absolute offset; the last OUTPUT_REPLAY_BYTES are
# retained, so a client that reconnects with ?since=<its cursor> (or the
# SSE Last-Event-ID) gets exactly what it missed - including bytes the
# server had already "written" into a socket that never delivered them.
OUTPUT_REPLAY_BYTES = max(4096, _int_env("OUTPUT_REPLAY_BYTES", str(512 * 1024)))

# Terminal reset sequence: exit alt screen, show cursor, reset attrs, full reset
TERM_RESET = b"\x1b[?1049l\x1b[?25h\x1b[0m\x1bc"

# Password prompt patterns (lowercase, checked against lowered PTY output)
PASSWORD_PROMPTS = ("password:", "password for", "passcode:", "passphrase")
# The auto-typer stays armed only while ssh can plausibly still be
# authenticating: this much PTY output or this many seconds without a
# prompt, or ANY real keystroke from the user, disarms it and drops the
# password. Without a bound the password stayed armed for the whole
# session whenever auth completed without prompting (agent/default key
# on the websh host, key + stray passphrase) - and the first later
# "password:" on screen (sudo, `ssh other`, `cat` of a file containing
# the word) got the stored password typed into the shell: echoed, in
# history, in the recording.
PASSWORD_ARM_MAX_BYTES = 16 * 1024
PASSWORD_ARM_MAX_SECONDS = 60.0
# How long after the auto-typed password a "permission denied" or a
# second prompt still means "ssh rejected it". Past this - or as soon as
# the user types anything - output belongs to the logged-in shell, where
# `sudo -i` or `ls /root` saying the same words is ordinary life.
AUTH_FAIL_WINDOW_SECONDS = 10.0
# A real login prompt is the LAST thing on the terminal and then nothing
# comes: ssh is waiting for input. This long a silence after a prompt-
# shaped line is what makes it one (a banner line keeps printing).
PASSWORD_PROMPT_QUIET_SECONDS = 0.15


def _is_login_prompt(text):
    """True when `text` (lowercased recent PTY output) ENDS in a
    password prompt: its last non-blank line contains a prompt word and
    ends with a colon. A match anywhere in the output is not enough - an
    sshd banner saying "Forgot your password: call IT" used to get the
    password typed into it, echoed on screen, before the real prompt."""
    tail = text.rstrip(" \t\r\n")
    if not tail.endswith(":"):
        return False
    last = tail.rsplit("\n", 1)[-1].rsplit("\r", 1)[-1]
    return any(p.rstrip(":") in last for p in PASSWORD_PROMPTS)

# Auth-failure patterns — if we see any of these AFTER we auto-typed the
# password, ssh rejected our attempt and we should not keep the session
# limping in an endless retry loop.
AUTH_FAIL_PATTERNS = ("permission denied", "authentication failed",
                      "access denied", "too many authentication failures")

# Rate limiting for /api/connect
RATE_LIMIT_WINDOW = _int_env("RATE_LIMIT_WINDOW", "60")    # seconds
RATE_LIMIT_MAX = _int_env("RATE_LIMIT_MAX", "50")          # max connect attempts per IP per window

# Rate limiting for the side-channel endpoints (ls / download / upload /
# tmux_capture). Each of these spawns a fresh ssh subprocess and pins a
# worker thread, but unlike /api/connect they were unthrottled — so one
# session could fire them in an unbounded loop as a thread/process
# amplification lever against the hard-capped worker pool. The limit is
# far more generous than the connect limit because interactive file
# browsing legitimately makes many ls calls in quick succession.
SIDE_CHANNEL_RATE_WINDOW = _int_env("SIDE_CHANNEL_RATE_WINDOW", "60")   # seconds
SIDE_CHANNEL_RATE_MAX = _int_env("SIDE_CHANNEL_RATE_MAX", "240")        # max side-channel calls per IP per window

# Scan-pattern detection: an IP that has hit the deny-list on at least
# SCAN_PATTERN_THRESHOLD distinct target hosts inside SCAN_PATTERN_WINDOW
# seconds is plainly probing — log result=scan_pattern so fail2ban can
# ban. Default 0 disables the check (preserve legacy behaviour); operators
# opt in by setting a positive threshold. ANY successful connect from the
# same IP clears the IP's accumulated state — a power user with 50
# legitimate servers never accumulates anything because their connects
# succeed; only a credential-less prober keeps tripping deny_blocked.
SCAN_PATTERN_THRESHOLD = _int_env("SCAN_PATTERN_THRESHOLD", "0")
SCAN_PATTERN_WINDOW = _int_env("SCAN_PATTERN_WINDOW", "300")

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

# Vault and connection IDs are 26-character base32 strings (e.g. ulid-style).
# Named separately so the format can diverge independently in the future.
_VAULT_ID_RE = re.compile(r"^[A-Z2-7]{26}$")
_CONN_ID_RE  = re.compile(r"^[A-Z2-7]{26}$")

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
                          tmux_options=None,
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
    # Two baseline tmux options are baked in (no user-facing toggle):
    #   - `set -g mouse on`  — wheel-scroll-history + click-in-vim/htop
    #     work out of the box.
    #   - `set -g status off` — hides tmux's bottom status bar. websh
    #     handles multi-pane on the frontend (split panes are independent
    #     SSH connections, not tmux windows), so the default bar —
    #     slot-id session name + empty window list + clock — is visual
    #     noise that just steals a row of terminal real estate.
    # `\;` chains the options in the same tmux invocation, applying
    # them regardless of whether the session was newly created or
    # re-attached via -A.
    # Per-connect tmux options go BEFORE new-session. Tuples are
    # pre-validated against an allow-list (see _validate_tmux_options) so
    # direct interpolation is shell- and tmux-injection-safe. The order
    # matters for history-limit: tmux reads it only when a pane is
    # CREATED, so `new-session ... \; set -g history-limit N` left the new
    # pane with the old limit and the Scrollback setting did nothing
    # (verified on tmux 3.4). `start-server` first, because `set -g`
    # needs a server and on first use there is none yet.
    pre = ""
    for opt, val in (tmux_options or ()):
        pre += " \\; set -g " + opt + " " + val
    attach = (tmux_cmd + " start-server" + pre + " \\; new-session -A -D -s " + tname
              + ' -- "$SHELL" -l \\; set -g mouse on'
              + ' \\; set -g status off')
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


# tmux options the client may request per session. Strict allow-list:
# any value not listed here is rejected, so the strings end up
# interpolated into the tmux command line without escaping risk.
_TMUX_BOOL_OPTS = ("set-clipboard",)
_TMUX_INT_OPTS = (("history-limit", 100, 10_000_000),)


def _validate_tmux_options(body):
    """Build a list of (opt, val) tuples from a /api/connect body, dropping
    anything that doesn't match the allow-list. Each value comes back as a
    pre-formatted string ready for `tmux set -g <opt> <val>`."""
    out = []
    for opt in _TMUX_BOOL_OPTS:
        key = "tmux_" + opt.replace("-", "_")
        if key not in body:
            continue
        v = body.get(key)
        if v is True or v == "on" or v == 1:
            out.append((opt, "on"))
        elif v is False or v == "off" or v == 0:
            out.append((opt, "off"))
    for opt, lo, hi in _TMUX_INT_OPTS:
        key = "tmux_" + opt.replace("-", "_")
        if key not in body:
            continue
        try:
            iv = int(body.get(key))
        except (TypeError, ValueError, OverflowError):
            continue
        if lo <= iv <= hi:
            out.append((opt, str(iv)))
    return out


# ─── ssh_options allow-list ─────────────────────────────────────────
#
# Default-deny for `ssh -o KEY=VALUE` pairs sourced from websh.json.
# Anything not on this list is dropped at session construction time
# with an operator-visible WARN.
#
# Why this is restrictive: websh.json is a broader trust surface than
# it looks — on shared hosting it lives next to the site files (FTP'able,
# sometimes restored from backups, occasionally edited by CI bots) — and
# a few ssh-config directives turn that surface directly into RCE on the
# websh host:
#
#   ProxyCommand / KnownHostsCommand — exec at connect time
#   LocalCommand + PermitLocalCommand — exec after auth
#   Include / Match exec — pull in / dispatch on arbitrary commands
#   IdentityAgent — point ssh at an attacker-controlled agent socket
#
# The allow-list covers the connection-shape options people actually
# put in websh.json (host-key policy, jump host, timeouts, algorithm
# preferences). Anything more exotic should go in the system ssh_config
# on the websh host, which has tighter access controls than websh.json.
# Matching is case-insensitive to mirror ssh_config(5).
_SSH_OPTIONS_ALLOWED = frozenset({
    # Host-key policy (TOFU / strict / known-hosts paths).
    "stricthostkeychecking",
    "userknownhostsfile",
    "globalknownhostsfile",
    "checkhostip",
    "verifyhostkeydns",
    # Jump host / connection routing.
    "proxyjump",
    # Connection timeouts and keepalive.
    "connecttimeout",
    "connectionattempts",
    "serveraliveinterval",
    "serveralivecountmax",
    "tcpkeepalive",
    "compression",
    # Algorithm preferences — bytes-in / bytes-out only, ssh parses
    # them and rejects unknowns; no command-eval surface.
    "preferredauthentications",
    "pubkeyacceptedalgorithms",
    "pubkeyacceptedkeytypes",
    "hostkeyalgorithms",
    "kexalgorithms",
    "ciphers",
    "macs",
    # Port and bind address (alt-port targets, source-IP pinning).
    "port",
    "bindaddress",
    "addressfamily",
    # Auth-method toggles. Pure booleans / integer caps — operator may
    # want to force key-only auth on prod, password-only on legacy
    # boxes, etc. None of these have an exec surface.
    "batchmode",
    "passwordauthentication",
    "pubkeyauthentication",
    "kbdinteractiveauthentication",
    "numberofpasswordprompts",
    # Identity (private-key path). ssh opens the file and parses it
    # as a key; an attacker-controlled path can at worst point at a
    # non-key file (read fails → auth fails). Not RCE.
    "identitiesonly",
    "identityfile",
    # Misc.
    "exitonforwardfailure",
    "loglevel",
    "requesttty",
})


def _filter_ssh_options(opts):
    """Apply the ssh_options allow-list. Returns (filtered_dict, dropped_keys).

    Keys are matched case-insensitively. Non-string keys are also dropped
    (they would crash the f"{}={}" interpolation anyway and have no
    legitimate source — only a malformed JSON config could produce them).
    """
    if not opts:
        return {}, []
    filtered = {}
    dropped = []
    for k, v in opts.items():
        if not isinstance(k, str) or k.lower() not in _SSH_OPTIONS_ALLOWED:
            dropped.append(k if isinstance(k, str) else repr(k))
            continue
        filtered[k] = v
    return filtered, dropped


# Static file serving (Python-only mode, without PHP proxy)
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/websh.js": ("websh.js", "application/javascript; charset=utf-8"),
    "/assets/websh-logo.svg": ("assets/websh-logo.svg", "image/svg+xml"),
}


# Static bytes, their gzip and a content ETag, recomputed only when the
# file's (mtime, size) changes - so a deploy that replaces websh.js is
# served (and re-tagged) on the next request without a restart.
_static_cache = {}
_static_cache_lock = Lock()


def _static_blob(filepath):
    st = os.stat(filepath)
    key = (st.st_mtime_ns, st.st_size)
    with _static_cache_lock:
        hit = _static_cache.get(filepath)
        if hit and hit[0] == key:
            return hit[1]
    with open(filepath, "rb") as f:
        data = f.read()
    gz = gzip.compress(data, 6) if len(data) > 1024 else None
    etag = '"' + hashlib.sha256(data).hexdigest()[:20] + '"'
    blob = (data, gz, etag)
    with _static_cache_lock:
        _static_cache[filepath] = (key, blob)
    return blob


def _accepts_gzip(header):
    """True when Accept-Encoding lists gzip (or *) without q=0."""
    for part in header.lower().split(","):
        bits = [b.strip() for b in part.split(";")]
        if bits[0] not in ("gzip", "*"):
            continue
        q = [b for b in bits[1:] if b.startswith("q=")]
        try:
            if q and float(q[0][2:]) == 0:
                continue
        except ValueError:
            continue
        return True
    return False


def _log(level, msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    sys.stderr.write("{} [{}] {}\n".format(ts, level, msg))


# ─── Access log ─────────────────────────────────────────────────────
#
# When WEBSH_ACCESS_LOG points at a file, every abuse-relevant connect/
# disconnect event is appended as a single JSON line. The format is
# stable so fail2ban filters and ad-hoc jq pipelines can rely on it.
# When unset (default), the helper is a no-op and the request flow is
# unaffected.
#
# Each record is emitted with a single os.write(2) on an O_APPEND fd
# opened-and-closed per call. logrotate(8) survives without any signal-
# based reopen plumbing — `copytruncate` is fine. On Linux, O_APPEND
# adjusts the file offset and writes the buffer atomically with respect
# to other O_APPEND writers, so concurrent threads cannot interleave
# bytes. To keep that guarantee real (rather than depending on PIPE_BUF
# or per-syscall partial-write quirks), every attacker-controlled string
# field is hard-capped before serialisation, which keeps the final JSON
# line safely under any reasonable single-write limit.

def _resolve_log_path(raw):
    """Normalise the WEBSH_ACCESS_LOG value at module load.

    Empty/whitespace → "" (logging disabled). Otherwise expand ~ and
    resolve to an absolute path. Relative paths therefore land under
    the server's cwd at startup time, not against whatever cwd a
    request handler may briefly inherit.
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    return os.path.abspath(os.path.expanduser(raw))


_v = _knob("WEBSH_ACCESS_LOG", None)
ACCESS_LOG_PATH = _resolve_log_path(None if _v is None else str(_v))
del _v

# Per-field caps (in Unicode codepoints) for known fields. Anything not
# listed here gets _DEFAULT_FIELD_CAP. Values are server- or attacker-
# controlled strings; we cap aggressively so that ① a single record
# always fits in one os.write(2), and ② operators who `cat` the log
# don't get hosed by a megabyte of attacker payload.
_LOG_FIELD_CAPS = {
    "target_host": 253,    # DNS hostname max
    "target_user": 64,     # POSIX login name typical
    "sid": 36,             # UUID4
    "error": 200,
    "result": 32,
    "event": 32,
    "classification": 32,
    "auth_user": 64,       # header-trust identity (matches target_user)
}
_DEFAULT_FIELD_CAP = 256

# Codepoints we replace with "?" before serialisation. ASCII C0 control,
# DEL + C1 control (0x7F–0x9F), and Unicode bidi/format mischief
# (LRE/RLE/PDF/LRO/RLO + LRI/RLI/FSI/PDI). JSON's ensure_ascii=False
# does not escape any of these, so without this filter a hostile host=
# value could land raw escape sequences into a log an operator may
# later view in a terminal.
_LOG_BAD_CODEPOINTS = (
    set(range(0x00, 0x20)) |
    set(range(0x7F, 0xA0)) |
    {0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
     0x2066, 0x2067, 0x2068, 0x2069}
)


def _sanitize_for_log(value, max_len):
    """Coerce to str, truncate to max_len codepoints, scrub control chars.

    Used for any string field that may carry attacker-supplied bytes
    (target_host, target_user, error, …). The output is safe to emit
    inside a JSON line and to view in a terminal.
    """
    if not isinstance(value, str):
        value = str(value)
    if len(value) > max_len:
        value = value[:max_len]
    if not any(ord(ch) in _LOG_BAD_CODEPOINTS for ch in value):
        return value
    return "".join("?" if ord(ch) in _LOG_BAD_CODEPOINTS else ch
                   for ch in value)


def _access_log_emit(event, ip, **fields):
    """Append one JSON record to the access log if WEBSH_ACCESS_LOG is set.

    Failures are reported via _log and swallowed — access logging must
    never break a live request.
    """
    if not ACCESS_LOG_PATH:
        return
    record = {
        "ts": datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"),
        "event": _sanitize_for_log(event, _LOG_FIELD_CAPS["event"]),
        "ip": _sanitize_for_log(ip or "", _DEFAULT_FIELD_CAP),
    }
    for k, v in fields.items():
        if isinstance(v, str):
            cap = _LOG_FIELD_CAPS.get(k, _DEFAULT_FIELD_CAP)
            record[k] = _sanitize_for_log(v, cap)
        else:
            record[k] = v
    try:
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        # Single os.write on an O_APPEND fd: the kernel adjusts the
        # offset and commits the buffer atomically against other
        # O_APPEND writers on Linux, so concurrent emits cannot
        # interleave bytes within one record.
        fd = os.open(ACCESS_LOG_PATH,
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (line + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except OSError as e:
        _log("WARN", "access log write failed: {}".format(e))


# ─── Rate limiting ──────────────────────────────────────────────────

_rate_limits = {}  # IP -> list of timestamps
_rate_lock = Lock()

_side_channel_rate_limits = {}  # IP -> list of timestamps
_side_channel_rate_lock = Lock()


def _rate_limit_take(store, lock, ip, max_n, window):
    """Sliding-window token check. Returns True if the request is allowed
    (and records it), False if the IP has hit max_n within the window."""
    now = time.time()
    cutoff = now - window
    with lock:
        times = [t for t in store.get(ip, []) if t > cutoff]
        if len(times) >= max_n:
            store[ip] = times
            return False
        times.append(now)
        store[ip] = times
        return True


def _check_rate_limit(ip):
    """Return True if a /api/connect request is allowed, False if rate-limited."""
    return _rate_limit_take(_rate_limits, _rate_lock, ip,
                            RATE_LIMIT_MAX, RATE_LIMIT_WINDOW)


def _check_side_channel_rate_limit(ip):
    """Return True if a side-channel (ls/download/upload/tmux_capture)
    request is allowed, False if the IP has exceeded the higher
    side-channel limit."""
    return _rate_limit_take(_side_channel_rate_limits, _side_channel_rate_lock,
                            ip, SIDE_CHANNEL_RATE_MAX, SIDE_CHANNEL_RATE_WINDOW)


def _prune_stale(store, lock, cutoff, ts_of=lambda e: e):
    """Drop every IP from a per-IP event store whose newest event is older
    than `cutoff`. `ts_of` extracts the timestamp from one stored entry
    (the scan-pattern store keeps (ts, host) tuples). Shared by cleanup()
    for the two rate-limit stores and the scan-pattern store."""
    with lock:
        stale = [ip for ip, entries in store.items()
                 if not any(ts_of(e) > cutoff for e in entries)]
        for ip in stale:
            del store[ip]


# ─── Scan-pattern detection ─────────────────────────────────────────
#
# Per-IP record of recent connects so we can spot one IP probing many
# distinct deny-listed target hosts. Two design choices keep this from
# burning a legitimate user:
#
#   1. The signal is *deny-list hits*, not all failed connects. A
#      legitimate user typing the wrong password just has auth fail
#      against ONE target — no scan pattern. A power user pinging 50
#      real servers gets through the deny-list (those hosts are
#      public) so nothing accumulates. Only an attacker probing
#      RFC1918 / loopback / our own infra keeps tripping deny_blocked.
#   2. *Any* successful connect from the same IP clears the IP's
#      accumulated state. So even if a power user's session crashes
#      and they retry against a typoed-into-RFC1918 hostname once or
#      twice, their next successful login forgives them. A scanner
#      never has any successful connects to forgive itself with.

_scan_pattern = {}  # ip -> list of (ts, target_host)
_scan_pattern_lock = Lock()


def _record_deny_for_scan(ip, target_host):
    """Record a deny_blocked event for scan-pattern detection.

    Returns True iff this attempt brings the IP to at least
    SCAN_PATTERN_THRESHOLD distinct target hosts inside
    SCAN_PATTERN_WINDOW seconds. The caller emits an extra
    `result=scan_pattern` access-log record so fail2ban can pick the
    pattern up; the original deny_blocked record is still emitted.

    Convention matches `_check_rate_limit`: `>=` means
    `SCAN_PATTERN_THRESHOLD=10` fires on the 10th distinct host (not
    the 11th) — the operator-set value IS the ban threshold, not one
    below it.
    """
    if SCAN_PATTERN_THRESHOLD <= 0 or not ip:
        return False
    # Normalise the host so the same target written different ways
    # (case differences, trailing dot from a FQDN) collapses to one
    # bucket — otherwise an attacker could probe one host with 10
    # case variants and stay under the distinct-host threshold.
    # Cap the stored string before it lands in the per-IP buffer so a
    # 100KB payload from the request body cannot inflate memory: the
    # access-log layer already caps target_host to _DEFAULT_FIELD_CAP
    # (256) on emit, mirror that bound here on the in-memory state.
    normalised = (target_host or "").strip().rstrip(".").lower()
    if len(normalised) > _DEFAULT_FIELD_CAP:
        normalised = normalised[:_DEFAULT_FIELD_CAP]
    now = time.time()
    cutoff = now - SCAN_PATTERN_WINDOW
    with _scan_pattern_lock:
        events = _scan_pattern.get(ip, [])
        events = [(t, h) for t, h in events if t > cutoff]
        events.append((now, normalised))
        _scan_pattern[ip] = events
        unique_hosts = set(h for _, h in events)
        return len(unique_hosts) >= SCAN_PATTERN_THRESHOLD


def _forgive_scan_for_ip(ip):
    """A session from `ip` that is being USED clears its scan-pattern
    state. Called from /api/input on the first keystroke into a session
    whose auth did not fail. The asymmetry — only deny_blocked
    accumulates, only real use forgives — is what makes the heuristic
    safe: real users always type; pure scanners never get a shell.
    (It used to fire on spawn, before auth even ran.)
    """
    if not ip:
        return
    with _scan_pattern_lock:
        _scan_pattern.pop(ip, None)


def _per_ip_session_count(ip):
    """Count active sessions opened from `ip`. Caller MUST hold sessions_lock.

    Counts both foreground and background sessions together — for the
    purposes of the MAX_SESSIONS_PER_IP gate, an abuser holding N total
    sessions is the threat we're guarding against, regardless of how
    they're tagged internally. Placeholders (slots reserved for an
    in-flight `_connect` whose ssh has not yet been spawned) are counted
    too — the whole point of the placeholder is to make the gate
    race-free against concurrent connects from the same IP.
    """
    if not ip:
        return 0
    return sum(1 for s in sessions.values()
               if getattr(s, "client_ip", None) == ip)


class _SessionPlaceholder(object):
    """Reserved slot in the `sessions` registry while `_connect` spawns ssh.

    `_connect` runs the per-IP / global session-count gates inside
    sessions_lock, then releases the lock to spawn ssh (pty.fork is
    wall-clock-slow), then re-acquires the lock to insert the real
    Session. Without a placeholder, N concurrent connects from the same
    IP all see `count == cap-1`, all pass the gate, and all spawn ssh —
    blowing past the cap by N-1. Inserting a placeholder under the gate
    lock gives later connects a count that includes the in-flight ones.

    Stubs `is_expired()` / `close()` so the cleanup loop and shutdown
    handler can iterate `sessions.values()` without special-casing
    placeholders. They live for at most a connect's worth of time —
    longer-lived consumers will only ever see real Sessions.
    """

    __slots__ = ("client_ip", "is_background", "persistent")

    def __init__(self, client_ip, is_background):
        self.client_ip = client_ip
        self.is_background = is_background
        # cleanup() and other paths may inspect `.persistent`; placeholders
        # are never persistent regardless of the caller's intent — the
        # real Session takes over before the user sees the slot_id.
        self.persistent = False

    def is_expired(self):
        # A placeholder never expires on its own — _connect's swap-or-pop
        # is what removes it. SESSION_TIMEOUT is in the minute range
        # while a connect lasts at most a few seconds, so this is moot in
        # practice but lets cleanup() iterate without an isinstance check.
        return False

    def close(self):
        # Shutdown handler iterates and calls close() on every session.
        # A placeholder owns no fds or subprocesses — nothing to release.
        pass


# ─── Config file ────────────────────────────────────────────────────

_config_cache = None
_config_mtime = 0
# Set by load_config() when WEBSH_REQUIRE_VAULT rejects a websh.json that
# still carries plaintext credentials. main() turns it into a refusal to
# start; a rejection that happens LATER (the file was edited while the
# server runs) is logged once per file version and the config is served
# as empty until the operator fixes it - never a dead handler thread.
_config_rejected = None


class _PlaintextCredsRejected(Exception):
    pass


_proxy_host_warned = False


def _warn_proxy_host_once(host_hdr, origin_host):
    """The one misconfiguration that looks exactly like CSRF: a reverse
    proxy that does not forward Host, so every browser request arrives as
    "Host: 127.0.0.1:8765" with the public Origin. Say so once, with the
    fix, instead of leaving the operator with a wall of 403s."""
    global _proxy_host_warned
    h = host_hdr.strip().lower().split(":")[0].strip("[]")
    if _proxy_host_warned or h not in ("127.0.0.1", "localhost", "::1"):
        return
    _proxy_host_warned = True
    _log("WARN", "browser requests from {} arrive with Host: {} - the "
         "reverse proxy is not forwarding the Host header, so they are "
         "refused as cross-site. nginx: add `proxy_set_header Host $host;` "
         "(see docs/deployment.md).".format(origin_host, host_hdr))


_CONFIG_EMPTY = {"connections": [], "restrict_hosts": False,
                 "isolate_storage": False,
                 "denied_host_set": frozenset(),
                 "denied_net_list": ()}
# What an unusable websh.json means when there is no earlier good version
# to keep: nothing may be reached. restrict_hosts with no connections
# refuses every connect. The file the operator named carries their
# policy (restrict_hosts, denied_hosts); losing it must not quietly mean
# "anyone may go anywhere".
_CONFIG_LOCKED = dict(_CONFIG_EMPTY, restrict_hosts=True)
# Why the named websh.json can't be used right now, or None.
_config_unusable = None


def _normalize_user_list(value):
    """Accept a list of usernames; return a clean list or None if absent."""
    if not isinstance(value, list):
        return None
    clean = [str(u).strip() for u in value if str(u).strip()]
    return clean or None


def _parse_denied_hosts(entries):
    """Parse denied_hosts list into (hostname set, ip_network list).

    Each entry is treated as IP/CIDR when it parses cleanly via
    ipaddress.ip_network (so "127.0.0.1" becomes /32, "10.0.0.0/8"
    stays /8); otherwise it is stored as a lowercase hostname for
    exact-match comparison. Empty/invalid entries are skipped silently.
    """
    host_set = set()
    net_list = []
    if not isinstance(entries, list):
        return frozenset(host_set), tuple(net_list)
    for entry in entries:
        if not isinstance(entry, str):
            continue
        s = entry.strip()
        if not s:
            continue
        try:
            net_list.append(ipaddress.ip_network(s, strict=False))
        except ValueError:
            host_set.add(_host_key(s))
    return frozenset(host_set), tuple(net_list)


def _host_key(host):
    """The form a hostname is compared in: lowercase, without the
    trailing root dot. "bastion.corp." is the same host as "bastion.corp"
    to ssh and to DNS; compared raw, it walked past a deny-list entry."""
    return host.strip().lower().rstrip(".")


# What a client may name as an ssh destination / login. The deny-list
# resolves the host with getaddrinfo() and FALLS OPEN when resolution
# fails, so any syntax getaddrinfo rejects but ssh accepts - `user@host`,
# `ssh://user@host:port` - used to slip straight past `denied_hosts`.
# Hostnames: letters, digits, dot, dash, underscore (ssh_config aliases
# included); IP literals (bare or [bracketed]) via the ipaddress module,
# which also covers the IPv6 forms with a %scope. No `@ : / \` or
# whitespace anywhere - those are exactly the characters that turn a
# hostname into something ssh parses differently than we validated.
_HOSTNAME_RE = re.compile(r'^[A-Za-z0-9._-]{1,253}$')
_SCOPE_ID_RE = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')
_USERNAME_RE = re.compile(r'^[A-Za-z0-9._@-]{1,64}$')


def _valid_host(host):
    """True when `host` is a plain hostname/alias or an IP literal."""
    if not isinstance(host, str) or not host or host.startswith("-"):
        return False
    h = host[1:-1] if (host.startswith("[") and host.endswith("]")
                       and len(host) > 2) else host
    try:
        ipaddress.ip_address(h)
    except ValueError:
        return bool(_HOSTNAME_RE.match(host))
    # Python accepts nearly anything as an IPv6 %scope-id - "@", spaces,
    # newlines. "::%@10.1.2.3" parsed as an address, failed resolution
    # (so the deny-list fell open), and ssh read it as user "::%" at
    # host 10.1.2.3. A scope id is an interface name or index; allow
    # exactly that.
    if "%" in h:
        return bool(_SCOPE_ID_RE.match(h.split("%", 1)[1]))
    return True


def _valid_username(username):
    """True when `username` is a plain login name (no whitespace, no
    shell/ssh-significant punctuation). `-l` takes it verbatim."""
    return (isinstance(username, str) and not username.startswith("-")
            and bool(_USERNAME_RE.match(username)))


def _normalize_host(host):
    """Return host without RFC 3986 [...] wrapping.

    The bracket-strip must happen on every path that compares a target
    host against the deny-list, not just the IP-resolution one —
    otherwise a deny-list that lists hostnames only (no CIDR) can be
    bypassed with `[name]` (the hostname-exact-match step misses,
    `net_list` is empty, and the function falls open without ever
    resolving).

    Predicate is `len(h) > 2`, not `>= 2`, so the literal input `"[]"`
    is left unmodified. Otherwise it would strip to the empty string
    and `getaddrinfo("")` (gaierror) makes the deny-list fall open.
    """
    h = host
    if h.startswith("[") and h.endswith("]") and len(h) > 2:
        h = h[1:-1]
    return h


def _resolve_host_ips(host):
    """Resolve hostname to a list of ipaddress.ip_address objects.

    Returns [] when resolution fails — caller treats that as "no IPs to
    check" and falls open. ssh will then run its own resolution and fail
    naturally if the host doesn't exist.

    Strips the RFC 3986 IPv6 `[address]` wrapping before resolution
    because `getaddrinfo("[::1]")` raises gaierror on glibc — without
    the strip, an attacker could write `[::1]` and slip past the
    deny-list (resolution fails → no IPs to check → fall-open).

    For each IPv6 address that is an IPv4-mapped form (`::ffff:a.b.c.d`),
    also returns the equivalent IPv4 address. RFC 4291 section 2.5.5.2
    says the lower 32 bits of these addresses ARE the corresponding
    IPv4 address — without this, an operator's `denied_hosts: ["10.0.0.0/8"]`
    would not block `::ffff:10.5.6.7`.
    """
    h = _normalize_host(host)
    try:
        infos = socket.getaddrinfo(h, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, socket.herror, UnicodeError):
        return []
    ips = []
    seen = set()
    for info in infos:
        addr = info[4][0]
        if "%" in addr:           # strip scope id from link-local IPv6
            addr = addr.split("%", 1)[0]
        if addr in seen:
            continue
        seen.add(addr)
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        ips.append(ip)
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None and str(mapped) not in seen:
            seen.add(str(mapped))
            ips.append(mapped)
    return ips


def _is_denied_host(host):
    """Check `host` against the deny-list. Returns (denied, reason).

    `host` may be a hostname or an IP literal. We do an exact hostname
    match first, then resolve to IPs and test each against configured
    CIDR ranges (covers both "1.2.3.4" /32 entries and "10.0.0.0/8"
    block ranges). Defends against attempts to reach RFC1918 / our own
    infra by passing a hostname whose A record resolves into a denied
    range.
    """
    cfg = load_config()
    host_set = cfg.get("denied_host_set") or frozenset()
    net_list = cfg.get("denied_net_list") or ()
    if not host_set and not net_list:
        return False, None
    h = _normalize_host(host)
    if _host_key(h) in host_set:
        return True, "hostname on deny-list"
    if not net_list:
        return False, None
    # h already stripped of [...]; _resolve_host_ips re-normalises but is
    # idempotent so this is fine.
    for ip in _resolve_host_ips(h):
        for probe in _deny_probes(ip):
            for net in net_list:
                if probe in net:
                    return True, "{} resolves to {} which is in denied range {}".format(
                        host, ip, net)
    return False, None


_LOOPBACKS = (ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1"))


def _deny_probes(ip):
    """The addresses to test `ip` as. A connect to 0.0.0.0 / :: lands
    on the local host, as does ::1 - but a deny-list that names only
    127.0.0.0/8 (as the documented example does) matched none of them,
    so "0", "0.0.0.0" or "::" reached loopback-only services on the
    websh host. Unspecified and loopback addresses are therefore also
    tested as the loopback of either family."""
    if ip.is_unspecified or ip.is_loopback:
        return (ip,) + _LOOPBACKS
    return (ip,)


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
    global _config_cache, _config_mtime, _config_rejected, _config_unusable
    path = os.environ.get("WEBSH_CONFIG", "")
    if not path:
        return _CONFIG_EMPTY
    if not os.path.isfile(path):
        return _config_fallback(path, "file not found")
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

        flagged = []
        for c in conns:
            if c.get("password") or c.get("key") or c.get("key_pass"):
                flagged.append(c.get("name") or c.get("host") or "?")
        if flagged:
            msg = ("websh.json contains plaintext credentials on "
                   "{} entr{}: {} — see docs/encryption.md to "
                   "migrate").format(
                       len(flagged),
                       "ies" if len(flagged) > 1 else "y",
                       ", ".join(flagged))
            if WEBSH_REQUIRE_VAULT:
                raise _PlaintextCredsRejected(msg)
            _log("WARN", msg)

        denied_host_set, denied_net_list = _parse_denied_hosts(
            cfg.get("denied_hosts"))
        result = {
            "connections": conns,
            "restrict_hosts": bool(cfg.get("restrict_hosts", False)),
            "isolate_storage": bool(cfg.get("isolate_storage", False)),
            "denied_host_set": denied_host_set,
            "denied_net_list": denied_net_list,
            # Raw passthrough; validated field-by-field in config_public.
            "form_defaults": cfg.get("form_defaults"),
        }
        if _config_unusable is not None:
            _log("INFO", "websh.json at {} loaded again".format(path))
        _config_unusable = None
        _config_cache = result
        _config_mtime = mtime
        _config_rejected = None
        return result
    except _PlaintextCredsRejected as e:
        # Logged once per edit, not once per request (the fallback only
        # logs when the reason changes).
        _config_rejected = str(e)
        return _config_fallback(path, "rejected (WEBSH_REQUIRE_VAULT=1): " + str(e))
    except Exception as e:
        # Not cached under this mtime: a half-written file (non-atomic
        # save) is re-read on the next request and recovers by itself.
        return _config_fallback(path, str(e) or type(e).__name__)


def _config_fallback(path, reason):
    """websh.json is named but unusable (missing, unreadable, malformed,
    rejected). Keep enforcing the last version that loaded - the policy
    in force a moment ago is the operator's actual intent - or, with none
    to keep, lock everything. Returning the empty config instead silently
    turned restrict_hosts off and emptied denied_hosts: a trailing comma
    in an edit opened the proxy to every host."""
    global _config_unusable
    kept = _config_cache if (_config_cache is not None
                             and _config_cache is not _CONFIG_LOCKED) else None
    if kept is None and reason == "file not found":
        # Never loaded and not there: an install without a config (the
        # PHP shim always passes a default WEBSH_CONFIG path, whether or
        # not the operator created the file). That is "no config", as it
        # always was - not a broken one. Only a file that was loaded and
        # then vanished keeps its last version, below.
        if _config_unusable != reason:
            _log("INFO", "WEBSH_CONFIG={} does not exist - running without "
                 "a websh.json".format(path))
        _config_unusable = reason
        return _CONFIG_EMPTY
    if _config_unusable != reason:
        _log("ERROR", "websh.json at {} unusable ({}) - {}".format(
            path, reason,
            "keeping the last good configuration" if kept is not None else
            "refusing all connections until it is fixed"))
    _config_unusable = reason
    return kept if kept is not None else _CONFIG_LOCKED


# ── Credential vault (websh.creds.json) ─────────────────────────────

_creds_cache = None
_creds_cache_key = (0, 0)   # (mtime, size); bare mtime is 1s on some FS
_CREDS_EMPTY = {"version": 1, "vaults": {}}
_CREDS_SCHEMA_VERSION = 1

# Cap incoming bodies for vault endpoints. Legitimate payloads are well
# under 4 KB (small JSON + 12-byte iv + ~200-byte ct, base64'd). 16 KB
# leaves headroom for ssh_options/host strings and stops a misuser from
# filling the on-disk store via repeated multi-MB ct fields.
_MAX_VAULT_REQUEST_BYTES = 16 * 1024
# Keys that are ALLOW-listed for connections from websh.json but
# REJECTED inside vault-stored ssh_options. websh.json is operator-owned
# and trusted; vault entries are written by the browser and are NOT, so
# the connection-shape options that are safe in operator config become
# attack surface when they come from a saved card:
#
#   identityfile                          — point ssh at an arbitrary file
#       path and use ssh's parse-error timing as a read-oracle for files
#       readable by the websh uid.
#   userknownhostsfile / globalknownhostsfile — with the default
#       StrictHostKeyChecking=no, ssh APPENDS the target's host key to
#       this path, so a browser-chosen path is an arbitrary file
#       create/append primitive on the websh host.
#   proxyjump                             — the host deny-list only
#       resolves and checks the final target; a jump host named here is
#       never checked, so a saved card can reach (or pivot through) a
#       deny-listed bastion. Operator-config jump hosts still work.
#
# Operator-managed websh.json remains the trusted source for all of these.
_VAULT_DENY_SSH_OPTIONS = frozenset({
    "identityfile",
    "userknownhostsfile",
    "globalknownhostsfile",
    "proxyjump",
})


def _creds_path():
    """Path to websh.creds.json.

    Honors WEBSH_CREDS_PATH explicitly; otherwise sits next to
    WEBSH_CONFIG when set, else cwd.
    """
    env = str(_knob("WEBSH_CREDS_PATH", "")).strip()
    if env:
        return env
    cfg = os.environ.get("WEBSH_CONFIG", "").strip()
    if cfg:
        return os.path.join(os.path.dirname(os.path.abspath(cfg)),
                            "websh.creds.json")
    return os.path.abspath("websh.creds.json")


def _load_creds():
    """Load websh.creds.json with (mtime, size) caching.

    Returns a fresh empty store dict when the file is missing,
    unparseable, malformed, or carries an unsupported schema version.
    Unsupported version also sets `_vault_disabled` so the writer can
    refuse-to-write and config_public flips vault_enabled off until
    process restart.
    """
    global _creds_cache, _creds_cache_key, _vault_disabled, _creds_unreadable
    path = _creds_path()
    if not os.path.lexists(path):
        # Genuinely absent: a fresh install. Writing creates it.
        _creds_unreadable = None
        return dict(_CREDS_EMPTY, vaults={})

    def unusable(reason):
        # Present but not usable (bad JSON, wrong shape, EACCES, EIO, a
        # dangling symlink...). Readers get an empty store; writers are
        # refused until the file is readable again - see _save_creds_atomic.
        global _creds_unreadable
        if _creds_unreadable != reason:
            _log("ERROR", "creds file {} unusable ({}) - saving and deleting "
                 "credentials is refused until it is fixed; nothing on "
                 "disk was changed".format(path, reason))
        _creds_unreadable = reason
        return dict(_CREDS_EMPTY, vaults={})

    try:
        st = os.stat(path)
        key = (st.st_mtime, st.st_size)
        if _creds_cache is not None and key == _creds_cache_key:
            return _creds_cache
        with open(path, "r") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return unusable(str(e) or type(e).__name__)
    if not isinstance(data, dict):
        # Operator typo or partial write from an external tool produced
        # a JSON array/string/number at the root.
        return unusable("root is not an object")
    if data.get("version") != _CREDS_SCHEMA_VERSION:
        if not _vault_disabled:
            _log("WARN",
                 "websh.creds.json schema version={} unsupported "
                 "(this build expects {}) — vault disabled until "
                 "operator action".format(
                     data.get("version"), _CREDS_SCHEMA_VERSION))
        _vault_disabled = True
        return dict(_CREDS_EMPTY, vaults={})
    if not isinstance(data.get("vaults"), dict):
        return unusable("missing or non-object 'vaults'")
    if _creds_unreadable is not None:
        _log("INFO", "creds file {} is readable again".format(path))
    _creds_unreadable = None
    _creds_cache = data
    _creds_cache_key = key
    return _creds_cache


def _save_creds_atomic(data):
    """Persist `data` to websh.creds.json via tmp + fsync + rename.

    Acquires _creds_lock around the whole RMW so concurrent writes
    serialize. Mode 0600. Updates the in-process cache so the next
    _load_creds() returns the just-written value without re-reading.

    Refuses to write when _vault_disabled is set (an unsupported schema
    version file is on disk and we must not overwrite it). Callers
    should also check the flag and respond 501 before computing the
    payload — the RuntimeError raised here is a backstop.
    """
    if _vault_disabled:
        raise RuntimeError("vault disabled — refusing to write")
    if _creds_unreadable is not None:
        # Backstop: the handlers answer 503 before getting here.
        raise RuntimeError("creds file unusable — refusing to write")
    global _creds_cache, _creds_cache_key
    path = _creds_path()
    parent = os.path.dirname(path) or "."
    with _creds_lock:
        fd, tmp = tempfile.mkstemp(prefix=".websh.creds.", suffix=".tmp",
                                   dir=parent)
        # If anything between mkstemp and the successful replace raises
        # (chmod EACCES, replace cross-device, OOM serialising) we must
        # unlink the tmp file ourselves — mkstemp doesn't autoclean and
        # repeated failures would otherwise accumulate hidden files in
        # the operator's config dir.
        ok = False
        try:
            try:
                os.write(fd, json.dumps(data, separators=(",", ":")).encode())
                os.fsync(fd)
            finally:
                os.close(fd)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
            ok = True
        finally:
            if not ok:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        # fsync the parent dir so the rename is durable across crash.
        try:
            dir_fd = os.open(parent, os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            # Some filesystems (tmpfs in CI) don't support O_DIRECTORY
            # or fsync on dirs. Best-effort.
            pass
        _creds_cache = data
        try:
            st = os.stat(path)
            _creds_cache_key = (st.st_mtime, st.st_size)
        except OSError:
            _creds_cache_key = (0, 0)


# Vault record AAD versions. v1 bound a blob to its slot only
# (vault_id:conn_id). A record's host/port/username are plaintext
# metadata next to the blob and /api/save needs no proof of key
# possession, so anyone who could READ websh.creds.json could re-POST a
# victim's iv/ct under the same ids with host=attacker.example - and on
# the victim's next click the server decrypted with the victim's key and
# auto-typed the password into the attacker's host. v2 binds the
# destination into the AAD, so a rebound record fails its GCM tag.
# Records without aad_v are v1: still readable (nothing to migrate them
# with server-side), but /api/save refuses to WRITE anything but v2, so
# a v1 record cannot be modified or re-created in a rebound form.
_AAD_VERSION = 2


def _credential_aad(vault_id, conn_id, aad_v, host=None, port=None,
                    username=None):
    if aad_v == 2:
        return "{}:{}:{}:{}:{}".format(
            vault_id, conn_id, host, int(port), username).encode("utf-8")
    return "{}:{}".format(vault_id, conn_id).encode("utf-8")


def _decrypt_credential(key_bytes, iv_b64, ct_b64, vault_id, conn_id,
                        aad=None):
    """Decrypt one stored blob. `aad` is the exact bytes from
    _credential_aad(); None means the v1 slot-only binding.

    Raises ValueError on malformed inputs (wrong key length, bad
    base64, wrong IV length, ct too short, non-string iv/ct). Raises
    InvalidTag when authentication fails — callers map that to 400
    vault_decrypt_failed.

    AAD = utf8(vault_id + ":" + conn_id) so blobs cannot be moved
    between slots even by an operator with shell access to the file.
    """
    if not HAS_CRYPTOGRAPHY:
        raise RuntimeError("cryptography not installed")
    if not isinstance(key_bytes, (bytes, bytearray)) or len(key_bytes) != 32:
        raise ValueError("key must be 32 bytes")
    if not isinstance(iv_b64, str) or not isinstance(ct_b64, str):
        raise ValueError("iv/ct must be base64 strings")
    try:
        iv = base64.b64decode(iv_b64, validate=True)
        ct = base64.b64decode(ct_b64, validate=True)
    except (binascii.Error, ValueError, TypeError) as e:
        raise ValueError("invalid base64: {}".format(e))
    if len(iv) != 12:
        raise ValueError("iv must be 12 bytes")
    if len(ct) < 17:
        raise ValueError("ct too short for GCM tag")
    if aad is None:
        aad = _credential_aad(vault_id, conn_id, 1)
    return AESGCM(bytes(key_bytes)).decrypt(iv, ct, aad)


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
    out = {
        "connections": safe,
        "restrict_hosts": cfg["restrict_hosts"],
        "isolate_storage": cfg.get("isolate_storage", False),
        "session_timeout": SESSION_TIMEOUT,
        "version": __version__,
        "proto": PROTO_VERSION,
        "vault_enabled": _vault_available(),
        # The client sends files in pieces (?offset=) only to a server
        # that appends them; an older one would overwrite the file with
        # each piece.
        "upload_chunks": True,
    }
    # Optional connect-form prefill (websh.json "form_defaults"): lets a
    # deployment seed host/port/username in the manual form without
    # resorting to HTML rewriting in the front proxy (the nginx
    # sub_filter hack this replaces). Validated field-by-field — a bad
    # type or range drops that field, never the response. The client
    # ignores the section when restrict_hosts is on and connections are
    # configured (the manual form is locked to those connections).
    fd = cfg.get("form_defaults")
    if isinstance(fd, dict):
        clean = {}
        host = fd.get("host")
        if isinstance(host, str) and 0 < len(host.strip()) <= 255:
            clean["host"] = host.strip()
        username = fd.get("username")
        if isinstance(username, str) and 0 < len(username.strip()) <= 64:
            clean["username"] = username.strip()
        port = fd.get("port")
        if isinstance(port, int) and not isinstance(port, bool) \
                and MIN_PORT <= port <= MAX_PORT:
            clean["port"] = port
        if clean:
            out["form_defaults"] = clean
    return out


def find_config_connection(name):
    """Find a connection by name in config. Returns full entry with secrets."""
    cfg = load_config()
    for c in cfg["connections"]:
        if c.get("name", "") == name:
            return c
    return None


def _prompt_conn_matches(c, host, port):
    """True if config entry `c` is a prompt connection targeting (host, port).

    Host comparison uses .lower() on both sides — the same as the denied_hosts
    convention (_parse_denied_hosts lowercases), so a card whose host casing
    differs from websh.json is not falsely rejected. (.lower(), not
    .casefold(): casefold over-collapses distinct IDN labels — e.g. German
    'straße' → 'strasse' — which would let a card match a different host.)
    Port is clamped the same way the connect path resolves it.
    """
    return (c.get("kind") == "prompt"
            and c.get("host", "").lower() == (host or "").lower()
            and clamp(c.get("port"), MIN_PORT, MAX_PORT, 22) == port)


def find_prompt_connection_by_host(host, port):
    """First named `prompt` connection whose (host, port) matches.

    A saved vault card carries no `connection` name; under restrict_hosts
    it is authorized by matching its target to a configured prompt
    connection. `ready` (fixed-credential) connections are intentionally
    not matched — they connect with operator-stored credentials, not a
    user's saved card. Returns the entry dict, or None.
    """
    cfg = load_config()
    for c in cfg["connections"]:
        if _prompt_conn_matches(c, host, port):
            return c
    return None


def _resolve_saved_card_connection(host, port, conn_hint):
    """Pick the prompt connection that governs a saved card's (host, port).

    `conn_hint` is the connection name the client stamped on the card at save
    time. It reaches us in the connect body, so it is attacker-controllable —
    used ONLY to disambiguate among connections that already match the card's
    server-resolved host:port (e.g. two prompt connections on one bastion with
    different allowed_users). A hint naming a connection on a *different*
    host:port is ignored: it can never select a policy for a target the card
    does not actually address, so it cannot escalate past restrict_hosts or a
    connection's denied_users. Falls back to the first host:port match for
    legacy cards (saved before name tagging) and for stale/deleted hints.
    """
    if conn_hint:
        entry = find_config_connection(conn_hint)
        if entry is not None and _prompt_conn_matches(entry, host, port):
            return entry
    return find_prompt_connection_by_host(host, port)


def is_host_allowed(host, port, username):
    """Manual-connect gate.

    Two layers:

      1. When restrict_hosts is on, raw manual (host, port, username)
         POSTs are always rejected — callers must go through a named
         connection.
      2. When restrict_hosts is off, the host is checked against the
         denied_hosts deny-list (hostname exact match + DNS-resolved
         IP / CIDR match). Entries in the operator's `connections`
         array bypass this gate by going through the named-connection
         path, so a deny-list does not affect explicitly configured
         destinations.

    The (port, username) arguments are kept for forward compatibility —
    the enforcement site passes them in unchanged.
    """
    cfg = load_config()
    if cfg["restrict_hosts"]:
        return False
    denied, reason = _is_denied_host(host)
    if denied:
        _log("INFO", "deny-list block: host={} reason={}".format(host, reason))
        return False
    return True


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


def authorize_target(host, port, username, is_saved, conn_hint=None):
    """Authorize a connect that is not a fully-vetted named connection.

    Connects made through a named connection are vetted separately
    (find_config_connection + check_prompt_user). This gate covers the
    other two shapes:

      * Saved vault card (is_saved): under restrict_hosts it is as
        legitimate as the named connection whose host:port it targets.
        Authorize it that way — a fixed-username connection pins the user;
        an open one runs check_prompt_user. `conn_hint` (the connection
        name the card was saved from) only disambiguates among connections
        matching the card's host:port; see _resolve_saved_card_connection
        for why it cannot escalate. With restrict_hosts off the card is
        gated by the deny-list, like a manual connect.
      * Free-form manual POST: allowed only when is_host_allowed() says
        so (restrict_hosts off and the host is not deny-listed).

    Returns (True, None) when allowed, else (False, error_message).
    """
    if is_saved and load_config()["restrict_hosts"]:
        named = _resolve_saved_card_connection(host, port, conn_hint)
        if named is None:
            return False, "connections to this host are not allowed"
        fixed_user = named.get("username", "")
        if fixed_user:
            if username == fixed_user:
                return True, None
            return False, "username is not allowed on this connection"
        return check_prompt_user(named, username)
    if not is_host_allowed(host, port, username):
        return False, "connections to this host are not allowed"
    return True, None


# ─── Validation ──────────────────────────────────────────────────────

def clamp(value, lo, hi, default):
    """Parse int and clamp to range. Returns default on failure.
    OverflowError: JSON `1e400` parses to float('inf'), and int(inf)
    raises that rather than ValueError - it was an unhandled traceback
    (dropped connection) on /api/connect and /api/save."""
    try:
        v = int(value)
        return max(lo, min(hi, v))
    except (TypeError, ValueError, OverflowError):
        return default


def _bad_rel_path(p):
    """True when `p` is unusable as a $HOME-relative remote path: empty,
    oversized, absolute, NUL-bearing, or traversing (a `..` segment).
    Shared by the upload family — keep the rules in one place so the
    staging path and its cleanup path can never drift apart."""
    return (not p or len(p) > 4096 or p.startswith("/")
            or "\x00" in p or ".." in p.split("/"))


def _kill_reap(proc):
    """Best-effort kill + reap of a side-channel subprocess so it can't
    linger as a zombie. Both steps are individually guarded: the process
    may already be gone (kill) or stuck in the kernel (wait timeout)."""
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def _vault_available():
    """True when the encrypted credential vault can serve requests."""
    return HAS_CRYPTOGRAPHY and WEBSH_VAULT_ENABLE and not _vault_disabled


# ─── Session management ─────────────────────────────────────────────

sessions = OrderedDict()
sessions_lock = Lock()
# Reentrant so handlers can do `with _creds_lock: ... _save_creds_atomic(...)`.
# _save_creds_atomic reacquires the same lock internally; without RLock that
# self-acquisition would deadlock.
_creds_lock = RLock()


def _remote_errno_text(stderr, fallback):
    """The reason part of a coreutils/BusyBox error line, e.g.
    "rm: cannot remove '/x': Device or resource busy" -> "Device or
    resource busy". The snippets used to discard stderr and map exit
    codes to guesses, so EBUSY/EROFS/ENOTDIR/ENAMETOOLONG all surfaced
    as "permission denied" and a chmod-000 parent as "no such file"."""
    lines = [l.strip() for l in (stderr or b"").decode("utf-8", "replace")
             .splitlines() if l.strip()]
    if not lines:
        return fallback
    last = lines[-1]
    m = re.search(r"['\u2019\"]\s*:\s*([^:'\u2019\"]+)$", last)
    reason = (m.group(1) if m else last.rsplit(": ", 1)[-1]).strip()
    return reason[:200] or fallback


def _side_channel_status(msg):
    """HTTP status for a failed rm/mkdir/mv. These used to be 502 across
    the board - wrong semantically, and an intermediary may replace a
    5xx body with its own HTML page, which the client then failed to
    parse ("Unexpected token <")."""
    m = (msg or "").lower()
    if "no such file" in m:
        return 404
    if "too long" in m:
        return 400
    if ("exists" in m or "not empty" in m or "busy" in m
            or "not a directory" in m or "is a directory" in m):
        return 409
    if ("permission" in m or "not permitted" in m or "read-only" in m):
        return 403
    return 502


def _sh_b64(var, b64):
    """Shell fragment assigning the base64-decoded value to $var, exactly.
    A bare `var=$(... | base64 -d)` would let command substitution strip
    every trailing newline, so a remote entry named "foo\n" resolved to
    "foo" - and rm/mv/mkdir then acted on the wrong file while reporting
    success. Appending a sentinel byte inside the substitution and
    stripping it afterwards preserves the decoded bytes verbatim; the
    `&&` between the two keeps base64's exit status meaningful."""
    return ('{v}=$(printf %s {b} | base64 -d && printf x) && '
            '{v}=${{{v}%x}}'.format(v=var, b=b64))


class SSHSession(object):
    """Manages a single SSH connection via PTY subprocess."""

    # ── Init / spawn ────────────────────────────────────────────────

    # Class-level defaults so `SSHSession.__new__(SSHSession)` (used by
    # tests that bypass __init__) still has these attributes — _signal()
    # reads them and would AttributeError on a stripped instance.
    _data_event = None
    _stream_active = False
    # Bumped by a new /api/stream that finds the slot held: the holder
    # sees its generation is stale and steps aside (see _stream).
    _stream_gen = 0
    _stream_taken_at = 0.0
    # Invariant: master_fd ∈ {a valid open fd, -1}. The sentinel -1 (rather
    # than None) means "closed / never opened" and lets master_fd-touching
    # methods early-return via `if self.master_fd < 0: return` instead of
    # swallowing OSError/ValueError from a stale fd via broad try/except.
    master_fd = -1

    def __init__(self, session_id, host, port, username, password, cols, rows,
                 key=None, ssh_options=None, is_background=False,
                 persistent=False, slot_id=None, tmux_cmd="tmux",
                 tmux_options=None, client_ip=None):
        self.id = session_id
        # Source IP that opened this session — kept here only so the
        # MAX_SESSIONS_PER_IP gate can iterate the registry and count.
        # Not used for any auth or routing decision.
        self.client_ip = client_ip
        self.master_fd = -1
        self.pid = None
        self.output_buf = b""
        # Replay log: the retained tail of ALL output (never drained by
        # reads) and the absolute offset one past its last byte.
        self._replay = b""
        self._replay_end = 0
        self.buf_lock = Lock()
        # Session recording (asciicast v2); None when disabled.
        self._rec = None
        self._rec_t0 = 0.0
        self._rec_lock = Lock()
        # Cross-thread wake signal: the PTY read-loop calls _signal() (which
        # is _data_event.set()) after every output_buf update; consumers
        # (_stream / _output) park in wait_for_data() which waits on the
        # event. threading.Event has identical kernel-multiplexed wake
        # latency to the previous os.pipe()-with-selectors setup (~15µs)
        # but isn't an fd, so there's nothing to leak across teardown and
        # no fd-reuse race to mitigate. Client-socket FIN detection still
        # uses a selector — see _build_session_selector and the
        # interleaved-short-waits loop in wait_for_data.
        self._data_event = Event()
        # Write ends of per-WAIT wake socketpairs (see wait_for_data):
        # _signal() pokes one byte into each so a parked waiter wakes
        # from a single blocking select instead of polling in slices.
        self._waiters = set()
        self._waiters_lock = Lock()
        self.alive = True
        self.last_activity = time.time()
        # At most one /api/stream consumer per session. SSHSession.read()
        # is destructive: a second concurrent stream would race for bytes
        # and each would only see fragments. The flag is owned by the
        # _stream handler under sessions_lock; long-poll (/api/output)
        # has the same destructive read but its short-window nature
        # makes overlap a non-issue in practice and we keep it
        # unrestricted for backwards compatibility.
        self._stream_active = False
        self.is_background = is_background
        self._password = password
        self._password_sent = False
        self._pw_buf = b""
        self._pw_armed_at = time.time()
        self._pw_bytes_seen = 0
        self.auth_failed = False
        self._auth_buf = b""
        # Number of PTY bytes already scanned for auth-fail patterns.
        # Once we pass a small post-password window without hitting a
        # rejection, assume auth succeeded so later shell output can't
        # accidentally trip the detector.
        self._auth_bytes_seen = 0
        # Deadline for reading "permission denied" as ssh rejecting the
        # auto-typed password; 0 = not watching. See AUTH_FAIL_WINDOW_SECONDS.
        self._auth_watch_until = 0
        # Raw waitpid() status of the ssh child — used after exit to
        # classify auth vs network failure via the 255 exit code.
        self._exit_status = None
        # Serialize child teardown: _read_loop's finally and close() can run
        # in different threads, so exactly one of them may issue the
        # SIGKILL+waitpid (a second one risks signalling a recycled pid).
        self._reap_lock = Lock()
        self._child_reaped = False
        self._key_file = None
        # Strip any -o option that isn't on the safe allow-list (see
        # _SSH_OPTIONS_ALLOWED). Filter here so SSHSession is also
        # defended when constructed from places other than _connect
        # (e.g. tests, future code paths).
        self._ssh_options, _ssh_opts_dropped = _filter_ssh_options(ssh_options)
        if _ssh_opts_dropped:
            _log("WARN", ("session {}: dropped ssh_options not in allow-list: "
                          "{} — edit websh.json to remove or use the system "
                          "ssh_config on the websh host").format(
                session_id, ", ".join(sorted(_ssh_opts_dropped))))
        self.persistent = bool(persistent and slot_id)
        self.slot_id = slot_id if self.persistent else None
        self.tmux_cmd = tmux_cmd if _TMUX_CMD_RE.match(tmux_cmd or "") else "tmux"
        self._tmux_options = list(tmux_options or ())

        # Connection coordinates kept for the ControlMaster side-channel
        # (re-used by upload_file, finalize_upload, remove_remote_tmp,
        # push_tmux_options, tmux_capture, terminate_remote_tmux).
        self._host = host
        self._port = port
        self._username = username

        # Per-session ssh ControlPath. Opened by the master ssh process
        # (see _spawn). A second `ssh -S <path> ...` invocation
        # piggybacks on the same authenticated channel — used for
        # tmux kill-session in persistent sessions and for binary
        # file uploads (cat > $HOME/...) without PTY overhead.
        self._control_path = os.path.join(
            tempfile.gettempdir(),
            "websh-mux-{}.sock".format(self.id.replace("-", "")[:16]))

        if key:
            self._key_file = self._write_key(key)

        try:
            self._spawn(host, port, username, cols, rows)
        except BaseException:
            # Half-built session: the caller never gets a handle to close,
            # so release what is already on disk - the 0600 key file and
            # the recording opened before the fork - here. If the fork
            # itself failed there is no child to reap; if it succeeded and
            # a later step raised, close() reaps it as usual.
            if self.pid is None:
                self._child_reaped = True
            self.close()
            raise

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

    def _build_ssh_cmd(self, host, port, username):
        """Build the ssh argv for this session.

        OpenSSH uses the first value for many repeated options. Build
        defaults only for options the profile did not explicitly set so
        documented per-profile ssh_options can actually override them.
        """
        opt_lc = {
            k.lower(): str(v)
            for k, v in self._ssh_options.items()
            if isinstance(k, str)
        }
        strict = opt_lc.get("stricthostkeychecking")
        strict_disabled = (
            strict is None
            or strict.strip().lower() in ("no", "false", "off")
        )
        ssh_cmd = [
            "ssh",
            "-p", str(port),
            "-l", username,
        ]

        defaults = [
            ("StrictHostKeyChecking", "no"),
            ("ConnectTimeout", "10"),
            ("ServerAliveInterval", "15"),
            ("ServerAliveCountMax", "3"),
            # Cap password retries at one — on rejection ssh exits 255
            # cleanly instead of looping on the PTY, giving us a
            # locale-proof primary auth-failure signal.
            ("NumberOfPasswordPrompts", "1"),
            # The session authenticates with what the web user supplied
            # and nothing else. Without these, ssh also offered whatever
            # the websh host has - the service account's ssh-agent
            # (SSH_AUTH_SOCK was inherited) and its default ~/.ssh/id_*
            # keys - so an anonymous visitor who typed only a host and a
            # username got a shell wherever the OPERATOR's keys are
            # authorized. A profile may still set these explicitly.
            ("IdentityAgent", "none"),
            ("IdentitiesOnly", "yes"),
        ]
        if not self._key_file:
            # Password (or keyboard-interactive) session: no key was
            # given, so no key may be tried - not even the default ones
            # ssh loads when no -i is passed.
            defaults.append(("PubkeyAuthentication", "no"))
        if strict_disabled:
            # With StrictHostKeyChecking=no, also keep host keys out of
            # the websh user's known_hosts by default. If a profile
            # opts into strict/TOFU verification, omit this default so
            # OpenSSH can use its normal known_hosts files unless the
            # profile provides an explicit UserKnownHostsFile.
            defaults.insert(1, ("UserKnownHostsFile", "/dev/null"))
        for k, v in defaults:
            if k.lower() not in opt_lc:
                ssh_cmd.extend(["-o", "{}={}".format(k, v)])

        # ControlMaster on every session: the master ssh owns this socket,
        # later `ssh -S <sock> <host> ...` invocations piggyback on the
        # same authenticated channel (tmux kill-session for persistent;
        # binary file uploads for any session). ControlPersist=no ties the
        # socket lifetime to the master so no orphaned masters survive.
        ssh_cmd.extend([
            "-o", "ControlMaster=auto",
            "-o", "ControlPath=" + self._control_path,
            "-o", "ControlPersist=no",
        ])
        if self.persistent:
            # Force remote TTY allocation — required when ssh has a trailing
            # remote command (default is no TTY, but tmux needs one).
            ssh_cmd.insert(1, "-tt")

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
                self.slot_id, self.tmux_cmd, TMUX_IDLE_TTL,
                tmux_options=self._tmux_options))
        return ssh_cmd

    def _spawn(self, host, port, username, cols, rows):
        """Fork a PTY and exec ssh."""
        env = os.environ.copy()
        # SSH_AUTH_SOCK stays: a ProxyJump bastion (operator-configured)
        # may authenticate with the service account's agent. The
        # DESTINATION never does - IdentityAgent=none in _build_ssh_cmd
        # applies to it alone, not to the jump hop.
        env["TERM"] = "xterm-256color"
        env["LANG"] = "en_US.UTF-8"
        env["LC_ALL"] = "en_US.UTF-8"

        ssh_cmd = self._build_ssh_cmd(host, port, username)

        # Open the recording before the fork so even the earliest PTY
        # bytes (banner, password prompt) land in the file.
        self._rec_open(cols, rows)

        pid, fd = pty.fork()
        if pid == 0:
            # In the forked child: only call os._exit on execvpe failure.
            # sys.exit raises SystemExit which runs atexit handlers and
            # flushes Python buffers — both inherited from the parent.
            # In the child those handlers may delete files, release locks,
            # or write garbage to the user's terminal (stdio is the PTY
            # slave). os._exit skips all that and exits immediately.
            os.execvpe("ssh", ssh_cmd, env)
            os._exit(127)

        self.pid = pid
        self.master_fd = fd
        self._set_winsize(cols, rows)

    def _set_winsize(self, cols, rows):
        # Entry-guard: master_fd may be -1 if the session never spawned
        # ssh (e.g. test instance via __new__) or has been torn down.
        if self.master_fd < 0:
            return
        try:
            fcntl.ioctl(
                self.master_fd, termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0),
            )
        except (OSError, ValueError):
            # OSError: EBADF / EINVAL on a stale fd. ValueError: Python's
            # own check for negative fd. Either way the session is being
            # torn down; ioctl is best-effort.
            pass

    # ── Read loop / output buffer ───────────────────────────────────

    # ── Session recording (asciicast v2) ────────────────────────────

    def _rec_open(self, cols, rows):
        """Start recording when WEBSH_RECORD_DIR is set. Best-effort."""
        if not WEBSH_RECORD_DIR:
            return
        try:
            # 0700 + explicit chmod (makedirs mode is ignored for an
            # existing dir): the FILENAME carries the live session id —
            # the API's only bearer credential — so a world-listable
            # directory would let any local user hijack sessions.
            os.makedirs(WEBSH_RECORD_DIR, mode=0o700, exist_ok=True)
            os.chmod(WEBSH_RECORD_DIR, 0o700)
            name = "%s-%s.cast" % (time.strftime("%Y%m%d-%H%M%S"), self.id)
            path = os.path.join(WEBSH_RECORD_DIR, name)
            # O_EXCL: the sid is unique, so a collision means something
            # is impersonating the path — refuse rather than truncate.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            # Line-buffered so a crash loses at most one event and the
            # file can be live-tailed, matching asciinema's behavior.
            self._rec = os.fdopen(fd, "w", encoding="utf-8", buffering=1)
            self._rec_t0 = time.monotonic()
            self._rec_bytes = 0
            # Incremental decoders (one per direction): a multibyte
            # UTF-8 sequence split across PTY reads must not become
            # U+FFFD at every chunk boundary.
            import codecs as _codecs
            self._rec_dec = {}
            self._rec_mkdec = lambda: _codecs.getincrementaldecoder(
                "utf-8")("replace")
            self._rec.write(json.dumps({
                "version": 2,
                "width": cols,
                "height": rows,
                "timestamp": int(time.time()),
                "env": {"TERM": "xterm-256color"},
            }) + "\n")
        except Exception as e:
            _log("WARN", "session {} recording disabled: {}".format(
                self.id, e))
            self._rec = None

    def _record(self, kind, text):
        """Append one event ([t, kind, text] JSONL). Never raises: a
        broken recording must not kill the session — it logs once and
        disables itself. getattr: tests (and the cleanup loop) touch
        sessions built via __new__ that never ran __init__."""
        if getattr(self, "_rec", None) is None:
            return
        try:
            if isinstance(text, bytes):
                dec = self._rec_dec.get(kind)
                if dec is None:
                    dec = self._rec_dec[kind] = self._rec_mkdec()
                text = dec.decode(text)
                if not text:
                    return     # mid-sequence; flushed with the next chunk
            with self._rec_lock:
                f = self._rec
                if f is None:
                    return
                # Timestamp under the lock so concurrent writers (the
                # PTY reader vs input/resize handlers) cannot produce
                # out-of-order events.
                line = json.dumps(
                    [round(time.monotonic() - self._rec_t0, 6), kind, text])
                f.write(line + "\n")
                self._rec_bytes += len(line) + 1
                if (WEBSH_RECORD_MAX_BYTES
                        and self._rec_bytes >= WEBSH_RECORD_MAX_BYTES):
                    self._rec = None
                    f.close()
                    _log("WARN", "session {} recording capped at {} bytes"
                         .format(self.id, WEBSH_RECORD_MAX_BYTES))
        except Exception as e:
            _log("WARN", "session {} recording stopped: {}".format(
                self.id, e))
            self._rec = None

    def _rec_close(self):
        if getattr(self, "_rec", None) is None:
            self._rec = None
            return
        with self._rec_lock:
            f = self._rec
            self._rec = None
        if f is not None:
            try:
                f.close()
            except Exception:
                pass

    def _read_loop(self):
        """Background thread: reads PTY output into buffer."""
        # Entry-guard: pty.fork() may have failed in __init__ (or a test
        # constructed the session via __new__ without spawning ssh).
        if self.master_fd < 0:
            self.alive = False
            self._signal()
            return
        try:
            while self.alive:
                # The timeout only bounds how fast we notice alive=False
                # when the fd was NOT closed (close() resets master_fd to
                # -1 first, so the next select raises ValueError and we
                # break instantly; data / child-exit EOF-EIO wake select
                # immediately). 0.25s cuts idle wakeups 5x vs the old
                # 0.05s — 50 idle sessions burn 200 wakeups/s instead of
                # 1000 — at the cost of ≤250ms extra on the rare
                # alive-flag-only exits (e.g. write() hitting OSError).
                # Output latency is unaffected.
                try:
                    r, _, _ = select.select([self.master_fd], [], [], 0.25)
                except (ValueError, OSError):
                    break

                if r:
                    # Linux PTYs surface EOF as OSError(EIO) rather than an
                    # empty read — this is the canonical pexpect/ptyprocess
                    # pattern, NOT a paranoid catch. Don't tighten further.
                    try:
                        data = os.read(self.master_fd, PTY_READ_SIZE)
                    except OSError:
                        break
                    if not data:
                        break
                    self._record("o", data)

                    # Auto-type password on prompt (accumulate to handle split reads)
                    if self._password and not self._password_sent:
                        self._pw_buf += data
                        if len(self._pw_buf) > 256:
                            self._pw_buf = self._pw_buf[-256:]
                        self._pw_bytes_seen += len(data)
                        text = self._pw_buf.decode("latin-1", errors="replace").lower()
                        # The window is checked BEFORE the prompt: an armed
                        # session that sat idle past it must not answer a
                        # later "[sudo] password for u:".
                        if (self._pw_bytes_seen > PASSWORD_ARM_MAX_BYTES or
                                time.time() - self._pw_armed_at
                                > PASSWORD_ARM_MAX_SECONDS):
                            self._disarm_password("no prompt within the auth window")
                        elif _is_login_prompt(text) and not self._more_output_soon():
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
                            self._auth_watch_until = (
                                time.time() + AUTH_FAIL_WINDOW_SECONDS)

                    # After we sent the password, watch for ssh's
                    # "Permission denied" so we don't loop on bad creds.
                    # Scope the scan to the first 4 KB post-password so
                    # later shell output (e.g. `sudo: permission denied`
                    # from a user's command) can't kill the session.
                    # We also treat a *second* "password:" prompt as a
                    # rejection signal — some targets phrase the failure
                    # differently and the second prompt is unambiguous.
                    elif (self._password_sent and not self.auth_failed
                          and self._auth_bytes_seen < 4096
                          and time.time() < getattr(self, "_auth_watch_until", 0)):
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
                            # The connect record said result=ok (ssh
                            # spawned); this is the event fail2ban and an
                            # auditor actually need to see brute force
                            # relayed through websh.
                            _access_log_emit(
                                "auth_failed", getattr(self, "client_ip", ""),
                                sid=self.id,
                                target_host=getattr(self, "_host", ""),
                                target_user=getattr(self, "_username", ""))
                            # Append this final chunk so the client sees
                            # *why* (the rejection message + the re-prompt)
                            # before we tear down.
                            with self.buf_lock:
                                self._append_output_locked(data)
                            self._signal()
                            self._auth_buf = b""
                            try:
                                os.kill(self.pid, signal.SIGTERM)
                            except Exception:
                                pass
                            break

                    with self.buf_lock:
                        self._append_output_locked(data)
                    self._signal()

                # Check if child exited. Done under _reap_lock (see
                # _poll_child_exit) so the waitpid + status/flag writes are
                # atomic w.r.t. a concurrent close()->_reap_child: otherwise
                # the pid could be reaped here and recycled by the OS before
                # we record it, and the other thread would SIGTERM a stranger.
                if self._poll_child_exit():
                    break
        finally:
            # Drain remaining PTY data (exit escape sequences, etc.)
            # Narrow catch: select/os.read on a torn-down fd raises OSError
            # or ValueError; anything else is a real bug we shouldn't hide.
            try:
                for _ in range(PTY_DRAIN_ROUNDS):
                    r, _, _ = select.select(
                        [self.master_fd], [], [], PTY_DRAIN_INTERVAL)
                    if r:
                        leftover = os.read(self.master_fd, PTY_READ_SIZE)
                        if leftover:
                            self._record("o", leftover)
                            with self.buf_lock:
                                self._append_output_locked(leftover)
                            self._signal()
                        else:
                            break
                    else:
                        break
            except (OSError, ValueError):
                pass

            # Reap the child if we broke out before the inline WNOHANG reap
            # (the auth-fail branch SIGTERMs and breaks, and a fast exit
            # often surfaces as EIO before the inline reap sees it).
            # Otherwise the ssh child lingers as a zombie holding a counted
            # session slot until /api/disconnect or SESSION_TIMEOUT calls
            # close(). It must run BEFORE the exit-255 check below: that
            # check needs the exit status, and when the reap came after
            # it, a rejected key (ssh exits 255 at once, no prompt ever)
            # was reported as "SSH process exited immediately" instead of
            # an authentication failure the user can act on.
            self._reap_child()

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
                    # The replay log, not output_buf: a reader may already
                    # have drained the latter, taking the tail with it.
                    tail = (getattr(self, "_replay", b"") or self.output_buf)[
                        -2048:].decode("latin-1", errors="replace").lower()
                if any(p in tail for p in AUTH_FAIL_PATTERNS):
                    self.auth_failed = True
                    _log("INFO", "session {} auth failed (exit 255){}".format(
                        self.id,
                        " [bg]" if self.is_background else ""))

            # Append terminal reset so the frontend restores normal screen
            with self.buf_lock:
                self._append_output_locked(TERM_RESET)

            self.alive = False
            # Wake any consumer parked in wait_for_data so it observes
            # alive=False without waiting up to KEEPALIVE_INTERVAL.
            self._signal()
            # The reader owns the recording tail: closing here (after
            # the drain above) captures the session's final output.
            # close()'s _rec_close stays as a backstop for sessions
            # whose reader never ran.
            self._rec_close()

    def _poll_child_exit(self):
        """Non-blocking WNOHANG check for the ssh child's self-exit, run from
        the read loop. The waitpid AND the resulting _exit_status/_child_reaped
        writes happen under _reap_lock so they are atomic with respect to a
        concurrent close()->_reap_child(): once waitpid() reaps the child its
        pid is free for OS recycling, so if the status write happened outside
        the lock _reap_child could observe _exit_status is None / _child_reaped
        False and SIGTERM a recycled (innocent) pid in the gap. Setting
        _child_reaped here also makes the finally's _reap_child() a clean
        no-op. Returns True when the loop should break."""
        with self._reap_lock:
            if self._exit_status is not None or self._child_reaped:
                return True
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                # No such child — already reaped elsewhere, or never ours.
                # Mark reaped so _reap_child() won't kill a recycled pid.
                self._child_reaped = True
                return True
            if pid != 0:
                self._exit_status = status
                self._child_reaped = True
                return True
        return False

    def _reap_child(self):
        """Bounded reap of the ssh child: SIGTERM, poll WNOHANG, then
        SIGKILL. Serialized via _reap_lock and a one-shot _child_reaped flag
        so that, across the read-loop thread (this method runs in its finally)
        and the disconnect/cleanup thread (close() calls this too), exactly
        one caller ever issues the kill sequence — a second one could SIGKILL
        a recycled pid. Also skips entirely if the inline WNOHANG reap in
        _read_loop already captured the exit status (normal self-exit)."""
        with self._reap_lock:
            if self._child_reaped or self._exit_status is not None:
                return
            self._child_reaped = True
            try:
                os.kill(self.pid, signal.SIGTERM)
            except Exception:
                pass
            for _ in range(10):
                try:
                    pid, status = os.waitpid(self.pid, os.WNOHANG)
                    if pid != 0:
                        self._exit_status = status
                        return
                except ChildProcessError:
                    return
                time.sleep(0.05)
            try:
                os.kill(self.pid, signal.SIGKILL)
                _, status = os.waitpid(self.pid, 0)
                self._exit_status = status
            except Exception:
                pass

    def _append_output_locked(self, data):
        """Append PTY output to both the legacy drain buffer and the replay
        log. Caller holds buf_lock. Both are bounded; the replay log trims
        with 50% slack so it isn't re-sliced on every chunk."""
        self.output_buf += data
        if len(self.output_buf) > OUTPUT_BUF_MAX:
            self.output_buf = self.output_buf[-OUTPUT_BUF_KEEP:]
        if getattr(self, "_replay", None) is None:
            return                         # bare test fixtures
        self._replay += data
        self._replay_end += len(data)
        if len(self._replay) > OUTPUT_REPLAY_BYTES + OUTPUT_REPLAY_BYTES // 2:
            self._replay = self._replay[-OUTPUT_REPLAY_BYTES:]

    def read_since(self, cursor):
        """Cursor read for lossless reconnect: the output from absolute
        offset `cursor` on, WITHOUT consuming it. Returns (data, end,
        lost, reset): `end` is the next cursor; `lost` counts bytes that
        fell out of the replay window before this reader asked for them;
        `reset` means the cursor was not one this session ever issued
        (ahead of its output) and the reader must start over from the
        retained window.

        Cursor readers also clear the legacy drain buffer: it only exists
        for readers without a cursor (older clients), and would otherwise
        sit at its cap for the life of the session."""
        with self.buf_lock:
            end = self._replay_end
            start = end - len(self._replay)
            reset = cursor > end
            if reset:
                cursor = start
            lost = max(0, start - cursor)
            data = self._replay[max(cursor, start) - start:]
            self.output_buf = b""
        if data:
            self.last_activity = time.time()
        return data, end, lost, reset

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

    # ── Cross-thread signalling / wait ──────────────────────────────

    def _signal(self):
        """Wake any consumer thread blocked in wait_for_data(). Setting
        an already-set Event is a no-op, so wakeups coalesce naturally.
        Event.set() does not raise. Parked waiters additionally get one
        byte on their per-wait wake socket so they return from a single
        blocking select; a full pipe / closed peer is irrelevant (any
        readable byte means wake, and the waiter is tearing down)."""
        ev = self._data_event
        if ev is None:
            return
        ev.set()
        waiters = getattr(self, "_waiters", None)
        if not waiters:
            return
        # Send UNDER the lock: the waiter's finally discards its socket
        # under the same lock before closing it, so a send can never
        # overlap a close — without this, a send racing the close could
        # in principle hit a recycled fd number (send is non-blocking,
        # so the hold time is bounded).
        with self._waiters_lock:
            for w in list(waiters):
                try:
                    w.send(b"x")
                except (OSError, ValueError):
                    pass

    # Slice length for the interleaved short-wait loop in wait_for_data.
    # The Event itself wakes within microseconds of _signal(); the slice
    # only bounds the *FIN-detection* latency, since the client socket
    # isn't selectable through Event.wait. 20 ms keeps disconnect
    # detection well below human perception while remaining far cheaper
    # than the previous 50 Hz busy-poll baseline (which empirical
    # measurement showed was acceptable for the FIN path).
    _WAIT_SLICE = 0.02

    def wait_for_data(self, client_socket, timeout, selector=None):
        """Block up to `timeout` seconds. Returns when:
          - new PTY data has been signaled (Event set), OR
          - the client socket is readable (FIN, or peer-side bytes —
            caller distinguishes via Handler._client_gone()), OR
          - the timeout elapses (caller decides keepalive vs deadline).
        Returns nothing; caller re-checks state via session.read() and
        Handler._client_gone().

        Implementation: threading.Event isn't selectable, so we can't
        kernel-multiplex the data-event with the client socket the way
        the previous os.pipe()-backed version did. Instead we interleave
        short Event.wait slices (20 ms) with non-blocking selector polls
        for the socket. Wake-on-data is still instant (Event.wait
        returns from set() in microseconds); FIN detection is bounded by
        one slice (~20 ms), which is dramatically faster than the old
        50 Hz POLL_INTERVAL busy-poll and matches what empirical review
        deemed UX-imperceptible.

        `selector` is optional. If provided, the caller owns it and is
        expected to have client_socket registered (see
        Handler._build_session_selector); we use selector.select(0) for
        a non-blocking readiness peek between Event waits. When None,
        we run pure Event-only waits (no FIN fast-path)."""
        if timeout <= 0:
            return
        ev = self._data_event
        if ev is None:
            # Tests bypassing __init__ may strip this — preserve a
            # graceful fallback that lets the caller's loop tick.
            time.sleep(min(timeout, POLL_INTERVAL))
            return
        # Drain any pre-existing signal first: matches the old contract
        # where a signal that arrived before the wait still wakes it.
        if ev.is_set():
            ev.clear()
            return
        waiters = getattr(self, "_waiters", None)
        if waiters is not None:
            # Parked path: one blocking select on (wake socket, client
            # socket) for the whole timeout — zero wakeups while idle,
            # vs 50/second in the slice loop below. The socketpair is
            # PER WAIT: registered under the lock, discarded under
            # the same lock before closing (and _signal sends under it
            # too), so nothing outlives the wait and a signal can never
            # touch a closed/recycled fd. The Event stays as the state
            # carrier.
            try:
                wake_r, wake_w = socket.socketpair()
            except OSError:
                wake_r = wake_w = None   # fd exhaustion: slice fallback
            if wake_r is not None:
                sel = None
                try:
                    wake_r.setblocking(False)
                    wake_w.setblocking(False)
                    with self._waiters_lock:
                        waiters.add(wake_w)
                    # A signal may have landed between the is_set()
                    # check above and our registration — it would have
                    # missed our wake socket. Re-check.
                    if ev.is_set():
                        ev.clear()
                        return
                    try:
                        sel = selectors.DefaultSelector()
                    except OSError:
                        # epoll-fd exhaustion: fall through to the slice
                        # loop below (the finally cleans the pair up).
                        sel = None
                    if sel is None:
                        wake_r_failed = True
                    else:
                        wake_r_failed = False
                        sel.register(wake_r, selectors.EVENT_READ)
                    if not wake_r_failed:
                        if client_socket is not None:
                            try:
                                sel.register(client_socket,
                                             selectors.EVENT_READ)
                            except (KeyError, ValueError, OSError):
                                pass
                        sel.select(timeout)
                        if ev.is_set():
                            ev.clear()
                        return
                finally:
                    with self._waiters_lock:
                        waiters.discard(wake_w)
                    if sel is not None:
                        try:
                            sel.close()
                        except Exception:
                            pass
                    for sock in (wake_r, wake_w):
                        try:
                            sock.close()
                        except Exception:
                            pass

        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return
            # Non-blocking peek at the client socket so a peer FIN
            # doesn't have to wait for the next slice boundary if it
            # arrived while we were running.
            if selector is not None:
                try:
                    events = selector.select(0)
                except (OSError, ValueError, RuntimeError):
                    # Selector died mid-flight (session teardown).
                    # Keep ticking via a short sleep instead of
                    # spinning at selector-error rate.
                    time.sleep(min(remaining, 0.05))
                    return
                if events:
                    return
            slice_timeout = min(self._WAIT_SLICE, remaining)
            if ev.wait(slice_timeout):
                ev.clear()
                return

    # ── Output helpers (unread / write / resize) ────────────────────

    def unread(self, data):
        """Push bytes back to the front of the output buffer.

        Used when a reader (SSE _stream / long-poll) drained the buffer
        but couldn't deliver the bytes to the client (BrokenPipe). The
        next reader picks them up instead of losing them. Keeping order:
        prepend, since unread bytes are older than anything that arrived
        in the meantime.

        Same OUTPUT_BUF_MAX truncation as the PTY-reader path: if a
        large unread combined with fresh PTY output would push us over
        the cap, drop the oldest bytes. This matches the existing
        'keep the recent terminal state' policy."""
        if not data:
            return
        with self.buf_lock:
            self.output_buf = data + self.output_buf
            if len(self.output_buf) > OUTPUT_BUF_MAX:
                self.output_buf = self.output_buf[-OUTPUT_BUF_KEEP:]
        # Wake any consumer parked in wait_for_data so unread bytes get
        # delivered immediately instead of waiting for the next PTY
        # signal or the keepalive deadline. In the current code paths
        # the next consumer always reads on entry so this is defensive
        # consistency with _read_loop, but it makes the contract simpler
        # to reason about: any output_buf mutation that produces bytes
        # to deliver also signals.
        self._signal()

    def _more_output_soon(self):
        """True if the PTY produces more output within
        PASSWORD_PROMPT_QUIET_SECONDS. Used only while a prompt-shaped
        line is on screen: a real prompt is followed by silence, a banner
        by more banner. Nothing is read here - the loop picks it up."""
        try:
            r, _, _ = select.select([self.master_fd], [], [],
                                    PASSWORD_PROMPT_QUIET_SECONDS)
        except (ValueError, OSError):
            return True
        return bool(r)

    def _disarm_password(self, why):
        """Forget the stored password without ever typing it. See
        PASSWORD_ARM_MAX_BYTES."""
        if self._password is None:
            return
        self._password = None
        self._pw_buf = b""
        _log("INFO", "session {} password auto-type disarmed: {}".format(
            self.id, why))

    def write(self, data):
        """Send input to SSH process."""
        if not self.alive:
            return False
        # A real keystroke means the user is at a shell (or answering the
        # prompt themselves): whatever ssh prints from now on is not its
        # own login prompt, so the auto-typer must not fire on it.
        if (getattr(self, "_password", None) and not self._password_sent
                and data.strip(b"\r\n\t ")):
            self._disarm_password("user input")
        # ...and once they type, what the remote prints is the answer to
        # THEIR command: "Permission denied" from `ls /root` is not ssh
        # rejecting the password we typed.
        if getattr(self, "_auth_watch_until", 0) and data.strip(b"\r\n\t "):
            self._auth_watch_until = 0
        if self.master_fd < 0:
            # No PTY ever attached (or already closed) — treat as dead.
            self.alive = False
            return False
        self.last_activity = time.time()
        # Input recording (keystrokes — which include passwords typed at
        # prompts inside the session) is hard-disabled; see WEBSH_RECORD_INPUT.
        # The 'i' event is never written — recording is output-only.
        try:
            os.write(self.master_fd, data)
            return True
        except OSError:
            self.alive = False
            return False

    def resize(self, cols, rows):
        self.last_activity = time.time()
        self._record("r", "%dx%d" % (cols, rows))
        self._set_winsize(cols, rows)

    # ── Persistent tmux (terminate / capture / push options) ────────

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
                     "--", self._host,
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
        if not self.alive or self.master_fd < 0:
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
            # The fd may close between alive=True and our write (PTY
            # died, peer FIN, etc.) — best-effort, fall through.
            pass

    # ── ControlMaster side-channel plumbing ─────────────────────────
    #
    # Every side-channel operation (tmux capture/options, file transfer,
    # ls) runs a one-shot command over the existing ControlMaster socket
    # with the same ssh argv. Build it in exactly one place so a future
    # option change can't silently miss one of the seven call sites.
    # terminate_remote_tmux is deliberately NOT on this helper: it
    # re-dials with -p/-l/ConnectTimeout because its socket may belong
    # to a master that is still authenticating.

    def _mux_ready(self):
        """True when the ControlMaster socket exists and can be dialed."""
        return bool(self._control_path) and os.path.exists(self._control_path)

    def _mux_argv(self, remote_cmd):
        """argv for a one-shot remote command over the ControlMaster.

        sshd hands the command string to the remote user's LOGIN shell,
        which may be zsh, fish or csh. Every snippet here is POSIX sh, and
        under zsh's default NOMATCH the listing's `for f in * .[!.]* ..?*`
        aborted with "no matches found: ..?*" whenever one pattern matched
        nothing - i.e. almost always - so the file browser could not list
        any directory for a zsh user (the macOS default). Running it as
        `exec sh -c '<snippet>'` makes the login shell parse one quoted
        word and nothing else; the snippet itself always runs in sh."""
        return [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, "exec sh -c " + shlex.quote(remote_cmd),
        ]

    def _mux_run(self, remote_cmd, timeout, timeout_msg,
                 err_prefix="ssh error: "):
        """subprocess.run a remote command over the ControlMaster with
        the shared timeout/exception handling. Returns (CompletedProcess,
        None) on spawn success — the caller still interprets returncode/
        stdout/stderr, which genuinely differ per operation — or
        (None, error_string)."""
        try:
            proc = subprocess.run(self._mux_argv(remote_cmd),
                                  capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, timeout_msg
        except Exception as e:
            # `or repr(e)` keeps the error truthy even for the rare
            # exception with an empty str() — callers branch on `if err:`.
            return None, err_prefix + (str(e) or repr(e))
        return proc, None

    def tmux_capture(self):
        """Capture the full tmux pane buffer (scrollback + visible) over
        the ControlMaster channel. Only meaningful for persistent
        sessions — xterm.js can't see tmux's own scrollback. Returns
        (bytes, error)."""
        if not self.persistent or not self.slot_id:
            return None, "not a persistent session"
        if not self._mux_ready():
            return None, "control socket not ready"
        # `-S -<N>` reads the most recent N lines of history (was `-S -`,
        # the whole history, which on a 10M-line scrollback buffers
        # hundreds of MB into server RAM); `-J` joins lines that tmux had
        # wrapped to fit the pane width, `-p` prints to stdout. tmux_cmd
        # and slot_id are pre-validated regex-restricted strings, safe to
        # inline.
        tname = "websh-" + self.slot_id
        remote_cmd = (self.tmux_cmd + " capture-pane -p -J -S -" +
                      str(MAX_TMUX_CAPTURE_LINES) + " -t " + tname)
        proc, err = self._mux_run(remote_cmd, 30, "tmux capture timeout")
        if err:
            return None, err
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()[:300]
            return None, "tmux exit %d: %s" % (proc.returncode, err)
        data = proc.stdout
        if len(data) > MAX_TMUX_CAPTURE_BYTES:
            # Absolute byte ceiling regardless of line count (pathological
            # very long lines). Keep the tail — the freshest scrollback —
            # and flag the truncation so the export isn't misleading.
            marker = ("[websh: capture truncated to the last %d bytes]\n"
                      % MAX_TMUX_CAPTURE_BYTES).encode("utf-8")
            data = marker + data[-MAX_TMUX_CAPTURE_BYTES:]
        return data, None

    def push_tmux_options(self, options):
        """Apply per-session tmux options live, without typing into the
        foreground PTY. Runs `tmux set -g …` over the ControlMaster
        side-channel so the change can't bleed into a running editor /
        pager occupying the user's shell. `options` is a list of
        (opt, val) tuples already validated against the same allow-list
        used at connect time. Returns (ok, error)."""
        if not self.persistent or not self.slot_id:
            return False, "not a persistent session"
        if not self._mux_ready():
            return False, "control socket not ready"
        if not options:
            return True, ""
        # Each opt/val pair has been pre-validated, so direct
        # interpolation is safe. Chained via tmux's own `\;` separator
        # so the whole batch hits a *single* tmux invocation on the
        # target — same shape as `_build_remote_command` uses at
        # connect time.
        parts = ["set -g " + opt + " " + val for opt, val in options]
        remote_cmd = self.tmux_cmd + " " + " \\; ".join(parts)
        proc, err = self._mux_run(remote_cmd, 10, "tmux set timeout")
        if err:
            return False, err
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()[:300]
            return False, "tmux exit %d: %s" % (proc.returncode, err)
        return True, ""

    # ── File transfer (ControlMaster side-channel) ──────────────────

    # Chunked upload: a piece that does not start where the file on the
    # remote host ends is refused with this exit status, and the actual
    # size is printed, so the client resumes from there. Concurrent
    # retries can both pass that size check: positional writes keep their
    # identical bytes at the same offset instead of appending them twice.
    UPLOAD_EXIT_OFFSET = 7

    def upload_file(self, rel_path, body_stream, length,
                    timeout=UPLOAD_TIMEOUT, offset=None):
        """Stream `length` bytes from body_stream into $HOME/<rel_path> on the
        remote host, riding on the existing ControlMaster channel — so no
        re-auth and no PTY overhead. Returns (ok, error).

        offset=None writes the whole file in one go (older clients).
        A chunk writes at `offset` only if the file is exactly that long
        (an absent file counts as empty), otherwise (False, "offset
        mismatch size=<n>"). Chunked uploads use a unique path per file;
        a repeated first piece must never truncate later pieces."""
        if not self.alive:
            return False, "session is dead"
        if not self._mux_ready():
            return False, "control socket not ready"

        # rel_path is base64-encoded and decoded inside the remote shell so
        # it can never be parsed as shell metacharacters even if we got it
        # wrong upstream.
        b64name = base64.b64encode(
            rel_path.encode("utf-8")).decode("ascii")
        if offset is None:
            body = 'cat > "$HOME/$n"'
        else:
            # $(( )) strips the leading blanks some `wc` print, which
            # `test -eq` would reject.
            # Use portable dd rather than append: two requests may both
            # pass the size check before either writes. Retries carry
            # bytes from the same immutable file, so overlapping writes
            # at fixed positions are safe, including a delayed offset 0.
            # An unaligned seek consumes at most 4095 bytes with bs=1
            # before switching to 4 KiB blocks. The first dd cannot read
            # ahead into the second one's input; && preserves failures.
            block = 4096
            prefix = (-offset) % block
            write = ('dd of="$HOME/$n" bs=%d seek=%d conv=notrunc'
                     % (block, (offset + prefix) // block))
            if prefix:
                write = ('dd of="$HOME/$n" bs=1 count=%d seek=%d '
                         'conv=notrunc && ' % (prefix, offset)) + write
            body = ('sz=0; [ -e "$HOME/$n" ] && sz=$(( $(wc -c < "$HOME/$n") )); '
                    '[ "$sz" -eq %d ] || { echo "$sz"; exit %d; }; '
                    % (offset, self.UPLOAD_EXIT_OFFSET)) + write
        remote_cmd = _sh_b64('n', b64name) + ' && ' + body

        proc = subprocess.Popen(
            self._mux_argv(remote_cmd),
            stdin=subprocess.PIPE,
            # `cat >` produces no stdout except the size a refused chunk
            # reports; the pipe is tiny and read after exit. stderr is
            # kept (for the "ssh exit N: <msg>" error below) but MUST be
            # drained while we write stdin — see _drain below.
            stdout=subprocess.PIPE if offset is not None else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        # Drain ssh's stderr concurrently. Otherwise a >~64 KB stderr burst
        # (host-key/banner/MOTD warnings, or a remote `cat` error such as
        # "No space left on device") fills the pipe, ssh blocks on the write,
        # stops reading our stdin, and proc.stdin.write() below deadlocks.
        # We keep at most 64 KB of the text for the error message but keep
        # reading to EOF so the pipe never backs up.
        def _drain_pipe(pipe, buf, cap):
            # Read to EOF, keeping at most `cap` bytes.
            kept = 0
            try:
                while True:
                    chunk = pipe.read(4096)
                    if not chunk:
                        break
                    if kept < cap:
                        buf.append(chunk)
                        kept += len(chunk)
            except Exception:
                pass
            finally:
                try:
                    pipe.close()
                except Exception:
                    pass

        _err_buf = []
        _drain = Thread(target=_drain_pipe, args=(proc.stderr, _err_buf, 65536),
                        daemon=True)
        _drain.start()
        _out_buf = []
        _drain_out = None
        if proc.stdout is not None:
            _drain_out = Thread(target=_drain_pipe, args=(proc.stdout, _out_buf, 4096),
                                daemon=True)
            _drain_out.start()

        def _refused():
            # The size the remote printed before refusing the piece.
            _drain.join(timeout=5)
            if _drain_out is not None:
                _drain_out.join(timeout=5)
            out = b"".join(_out_buf).decode("ascii", "replace").strip()
            try:
                size = int(out.split()[0])
            except (ValueError, IndexError):
                size = -1
            return False, "offset mismatch size=%d" % size

        BUF = 256 * 1024
        remaining = length
        chunk = b""
        deadline = time.time() + max(60, timeout)
        in_fd = proc.stdin.fileno()
        # Non-blocking so a write never sleeps past the select() below:
        # a blocking pipe write of a 256 KB chunk only returns once ALL
        # of it fits, whatever select() said about the first 4 KB.
        os.set_blocking(in_fd, False)
        try:
            while remaining > 0:
                if time.time() > deadline:
                    raise IOError("upload timeout")
                chunk = body_stream.read(min(BUF, remaining))
                if not chunk:
                    break
                # Raw writes gated by select(): the buffered
                # proc.stdin.write() blocked without bound once the remote
                # stopped reading, so the deadline above (checked only at
                # the top of the loop) never fired.
                view = memoryview(chunk)
                while view:
                    if not _wait_fd(in_fd, min(TRANSFER_IDLE_TIMEOUT,
                                               max(0.0, deadline - time.time())),
                                    write=True):
                        raise IOError("upload stalled: remote stopped reading")
                    try:
                        n = os.write(in_fd, view)
                    except BlockingIOError:
                        continue
                    view = view[n:]
                remaining -= len(chunk)
                # Multi-GB uploads can outlast SESSION_TIMEOUT; without
                # this stamp the cleanup loop would close the master
                # mid-stream and the side-channel ssh would die with it.
                self.last_activity = time.time()
            try:
                proc.stdin.close()
            except Exception:
                pass
        except Exception as e:
            # Close our write end too (the success path does; the error
            # path must as well, or the BufferedWriter fd lingers until GC).
            try:
                proc.stdin.close()
            except Exception:
                pass
            if offset is not None and isinstance(e, (BrokenPipeError, ConnectionResetError)):
                # A refused piece: the remote exited before reading stdin.
                # Swallow the rest of the body first, so the reply goes
                # out on a request that was received whole (a proxy that
                # is still sending the body may otherwise drop the 409).
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                if proc.returncode == self.UPLOAD_EXIT_OFFSET:
                    left = remaining - len(chunk)   # the chunk itself was read already
                    end = time.time() + 30
                    while left > 0 and time.time() < end:
                        piece = body_stream.read(min(BUF, left))
                        if not piece:
                            break
                        left -= len(piece)
                    return _refused()
            _kill_reap(proc)
            _drain.join(timeout=5)
            # A torn-down stdin pipe (BrokenPipe/ConnectionReset) means the
            # remote `cat >` already died (e.g. "No space left on device")
            # and ssh tore the pipe down before we finished writing — so the
            # *useful* cause is in the drained stderr, not "[Errno 32] Broken
            # pipe". Surface its tail in that case only. A purely-local
            # failure (upload timeout, body read error) keeps the generic
            # message even if ssh happened to print a banner to stderr, so we
            # never misattribute a local cause to the remote.
            remote = b"".join(_err_buf).decode("utf-8", "replace").strip()
            if remote and isinstance(e, (BrokenPipeError, ConnectionResetError)):
                return False, "stream error: %s (remote: %s)" % (
                    str(e), remote[:300])
            return False, "stream error: " + str(e)

        try:
            proc.wait(timeout=max(60, timeout))
        except subprocess.TimeoutExpired:
            _kill_reap(proc)
            _drain.join(timeout=5)
            return False, "ssh side-channel timeout"

        # proc has exited, so stderr is at EOF and the drain thread is
        # finishing; join it to collect the captured text.
        _drain.join(timeout=5)
        if _drain_out is not None:
            _drain_out.join(timeout=5)
        if proc.returncode == self.UPLOAD_EXIT_OFFSET and offset is not None:
            return _refused()
        if proc.returncode != 0:
            msg = b"".join(_err_buf).decode("utf-8", "replace").strip()[:300]
            return False, "ssh exit %d: %s" % (proc.returncode, msg)
        if remaining > 0:
            return False, "client sent fewer bytes than Content-Length"
        return True, ""

    def finalize_upload(self, tmp_name, final_name, dest_dir=None):
        """Move $HOME/<tmp_name> into a directory on the remote host
        with auto-increment-on-conflict — without typing into the
        foreground PTY.

        dest_dir is an absolute remote path (the directory the file
        browser is showing) — validated by the caller. Without one the
        destination is the foreground tmux pane's cwd, read from tmux's
        own `#{pane_current_path}`, which is the cross-platform way to
        learn it without /proc introspection; that path is
        persistent-only and returns (False, 'non-persistent') for other
        sessions so the caller can fall back to a client-side foreground
        mv (which has its own alt-screen guard for vim/less/htop).

        An explicit dest_dir needs no tmux — only the ControlMaster
        side-channel every session has — so uploads aimed at a chosen
        directory are keystroke-free for non-persistent panes too.

        Returns (ok, final_path_or_error)."""
        if dest_dir is None and (not self.persistent or not self.slot_id):
            return False, "non-persistent"
        if not self._mux_ready():
            return False, "control socket not ready"

        # Both names are base64-encoded in case the user picked a file
        # name with shell metacharacters / newlines / unicode. The
        # decoded values land in shell vars and never touch the parser.
        b_tmp = base64.b64encode(tmp_name.encode("utf-8")).decode("ascii")
        b_final = base64.b64encode(final_name.encode("utf-8")).decode("ascii")
        target = "websh-" + (self.slot_id or "")

        if dest_dir is not None:
            # The caller named the directory: decode it into $cwd the same
            # way as every other name, so a directory with spaces, quotes
            # or a newline in it is never parsed as shell syntax.
            b_dir = base64.b64encode(dest_dir.encode("utf-8")).decode("ascii")
            cwd_expr = _sh_b64('c', b_dir) + '; cwd="$c"; '
        else:
            cwd_expr = ('cwd=$(' + self.tmux_cmd + ' display -p -t ' + target +
                        ' "#{pane_current_path}" 2>/dev/null); '
                        '[ -n "$cwd" ] || cwd="$HOME"; ')

        # One ssh roundtrip via ControlMaster:
        #   1. resolve the destination directory (named, or the pane's)
        #   2. fall back to $HOME if tmux didn't tell us
        #   3. cd there
        #   4. find a non-colliding final name with the same ext-aware
        #      auto-increment logic the client used to ship inline
        #   5. mv -- "$HOME/$t" "./$f" (—— and ./ keep the destination
        #      from being parsed as an option even if $f starts with -)
        #   6. echo the resolved absolute path so the API caller can
        #      surface it to the user
        remote_cmd = (
            _sh_b64('t', b_tmp) + '; ' +
            _sh_b64('f', b_final) + '; ' +
            cwd_expr +
            # Distinct exit codes, because the shells disagree about the
            # wording: dash's cd says "can't cd to /x" with no errno at
            # all, where bash says "No such file or directory". Deciding
            # here keeps the reason (and its HTTP status) the same on
            # every remote.
            '[ -d "$cwd" ] || exit 3; '
            'cd -- "$cwd" || exit 4; '
            'b="${f%.*}"; e="${f##*.}"; '
            'if [ "$b.$e" = "$f" ]; then '
                'n=1; while [ -e "$f" ]; do f="$b($n).$e"; n=$((n+1)); done; '
            'else '
                # Build name(1), name(2), ... from the ORIGINAL name each
                # iteration. The old `${f%(*)}` stripped the shortest "(...)"
                # suffix, which mangled real names containing parentheses
                # (e.g. "report(final)" -> "report(1)" instead of
                # "report(final)(1)"). Keeping the base in $o avoids both the
                # mangling and the name(1)(2)(3) accumulation.
                'o="$f"; n=1; while [ -e "$f" ]; do f="$o($n)"; n=$((n+1)); done; '
            'fi; '
            'mv -- "$HOME/$t" "./$f" || exit 5; printf %s "$cwd/$f"'
        )
        proc, err = self._mux_run(remote_cmd, 15, "finalize timeout")
        if err:
            return False, err
        if proc.returncode == 3:
            return False, "no such file or directory"
        if proc.returncode == 4:
            return False, _remote_errno_text(proc.stderr, "permission denied")
        if proc.returncode == 5:
            # mv's own message carries the errno (busybox and coreutils
            # both), so the user sees "Permission denied" / "Read-only
            # file system" rather than an exit code.
            return False, _remote_errno_text(proc.stderr, "move failed")
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()[:300]
            return False, "finalize exit %d: %s" % (proc.returncode, err)
        return True, proc.stdout.decode("utf-8", "replace").strip()

    def remove_remote_tmp(self, rel_path):
        """Best-effort delete $HOME/<rel_path> over the ControlMaster
        side-channel. Used to clean up a partial / staged upload that
        the user cancelled — keystroke-free, so no risk of poking a
        running editor in the foreground PTY. Idempotent. rel_path
        must come from the caller's path validator."""
        if not self._mux_ready():
            return False, "control socket not ready"
        b = base64.b64encode(rel_path.encode("utf-8")).decode("ascii")
        # The `--` after rm protects against an attacker-supplied path
        # that starts with `-` even though the upstream validator
        # already rejected absolute paths and `..`.
        remote_cmd = (
            _sh_b64('n', b) + ' && '
            'rm -f -- "$HOME/$n"'
        )
        proc, err = self._mux_run(remote_cmd, 10, "rm timeout")
        if err:
            return False, err
        if proc.returncode != 0:
            return False, "rm exit %d" % proc.returncode
        return True, ""

    def pane_cwd_expr(self):
        """Shell snippet that assigns the pane's current working
        directory to $D, or the empty string when this session has no
        way to know it.

        Only tmux-backed (persistent) sessions can answer: the
        interactive shell runs on the remote host as a child of sshd,
        so the local side has no view of its cwd, but tmux tracks it
        for us in `#{pane_current_path}`. Non-persistent panes fall
        back to $HOME here — the frontend has a second source (OSC 7)
        that covers them when the remote shell emits it."""
        if not self.persistent or not self.slot_id:
            return ""
        return ('D=$(' + self.tmux_cmd + ' display -p -t websh-' +
                self.slot_id + ' "#{pane_current_path}" 2>/dev/null); ')

    def list_dir(self, remote_path, pane_cwd=False):
        """List a directory via the ControlMaster side-channel.
        remote_path may be absolute, ~, ~/sub, or relative-to-$HOME.

        With pane_cwd=True the listing starts from the pane's current
        working directory instead of remote_path, falling back to $HOME
        when this session can't resolve one. The resolution happens
        inside the same remote command as the listing, so "where am I"
        and "what's there" stay a single ssh roundtrip.

        Returns (entries, abs_path, error_string)."""
        if not self._mux_ready():
            return None, None, "control socket not ready"

        b64 = base64.b64encode(remote_path.encode("utf-8")).decode("ascii")
        # Entry rows are NUL-terminated (not \n) so filenames containing
        # an embedded newline don't split a row in half. The PWD: line
        # before the entries is NUL-terminated too: a directory whose
        # own name ends in a newline or a space must round-trip exactly,
        # because every rm/mv/mkdir the browser issues is based on it.
        # Pure POSIX shell loop (no GNU `find -printf`) so this works on
        # BusyBox / Alpine / dash targets in addition to glibc Linux.
        # `stat -c` covers GNU + BusyBox; `stat -f` is the BSD/macOS
        # fallback; final fallback yields "0 0" so a host without stat
        # at all still returns a usable listing (size/mtime degraded).
        if pane_cwd:
            # $D comes from tmux (empty for a session that can't tell us);
            # the [ -n ] guard turns "no answer" into the historical $HOME
            # start point rather than a cd to "". The leading `D=` clears
            # any inherited value first — without it, a remote profile
            # that happens to export D would silently become the start
            # directory for every session that can't ask tmux.
            resolve = 'D=; ' + self.pane_cwd_expr() + '[ -n "$D" ] || D="$HOME"; '
        else:
            resolve = (
                _sh_b64('P', b64) + '; '
                'case "$P" in '
                  '/*) D="$P";; '
                  '"~") D="$HOME";; '
                  '"~/"*) D="$HOME/${P#~/}";; '
                  '*) D="$HOME/$P";; '
                'esac; '
            )
        # In pane-cwd mode the start point is only a hint: tmux reports
        # a directory that was deleted under the shell as "path
        # (deleted)", and a chmod 000 cwd can't be entered. Both used to
        # fail the whole listing ("directory not found", no breadcrumbs,
        # Up disabled). Fall back to $HOME - the reply's PWD tells the
        # client where it actually landed. An explicit path still fails.
        enter = ('cd "$D" 2>/dev/null || cd "$HOME" 2>/dev/null || exit 1; '
                 if pane_cwd else 'cd "$D" 2>/dev/null || exit 1; ')
        remote_cmd = (
            resolve +
            enter +
            'printf "PWD:%s\\0" "$PWD"; '
            'for f in * .[!.]* ..?*; do '
              '[ -e "$f" ] || [ -L "$f" ] || continue; '
              'if [ -L "$f" ]; then t=l; '
              'elif [ -d "$f" ]; then t=d; '
              'elif [ -f "$f" ]; then t=f; '
              'else t=o; fi; '
              'sm=$(stat -c "%s %Y" -- "$f" 2>/dev/null '
                    '|| stat -f "%z %m" -- "$f" 2>/dev/null '
                    '|| echo "0 0"); '
              's=${sm% *}; m=${sm#* }; '
              'printf "%s\\t%s\\t%s\\t%s\\0" "$t" "$s" "$m" "$f"; '
            'done'
        )
        # err_prefix="" keeps this method's historical bare str(e) message.
        result, err = self._mux_run(remote_cmd, 10, "timeout", err_prefix="")
        if err:
            return None, None, err
        if result.returncode != 0:
            return None, None, "directory not found"

        # Peel the PWD:<path>\0 preamble off the front, then split the
        # rest on NUL — each `printf ... \0` row from the loop ends
        # with \0 so embedded newlines in filenames stay intact. The
        # path is taken verbatim (no strip): see the comment above.
        raw = result.stdout
        abs_path = remote_path
        nul = raw.find(b"\0")
        if nul >= 0 and raw[:4] == b"PWD:":
            abs_path = raw[4:nul].decode("utf-8", "replace")
            raw = raw[nul + 1:]

        entries = []
        for row in raw.split(b"\0"):
            if not row:
                continue
            parts = row.decode("utf-8", "replace").split("\t", 3)
            if len(parts) != 4 or not parts[3]:
                continue
            ftype, size_s, mtime_s, name = parts
            entries.append({
                "name": name,
                "type": ftype,
                "size": int(size_s) if size_s.isdigit() else 0,
                "mtime": int(mtime_s) if mtime_s.isdigit() else 0,
            })
        entries.sort(key=lambda e: (e["type"] != "d", e["name"].lower()))
        return entries, abs_path, None

    def remove_path(self, abs_path):
        """Delete one absolute path via the ControlMaster side-channel.
        Returns (ok, error_string).

        Grants no privilege the session doesn't already have — the user
        is sitting at an interactive shell on the same host as the same
        account and could type `rm` themselves. What this does buy is
        that the delete is keystroke-free, so it can't disturb a vim /
        less / htop running in the foreground PTY.

        Deliberately NOT recursive. A directory is removed with rmdir,
        so a mis-click on a populated tree fails loudly instead of
        destroying it; the user can still `rm -rf` in the terminal when
        they mean it. Symlinks are unlinked, never followed — hence the
        `! -L` guard, without which a link to a directory would send
        rmdir at the link's target."""
        if not self._mux_ready():
            return False, "control socket not ready"

        b64 = base64.b64encode(abs_path.encode("utf-8")).decode("ascii")
        # Distinct exit codes so the caller can explain the failure
        # instead of surfacing a bare "exit 1". Every `--` guards a
        # filename that begins with a dash.
        remote_cmd = (
            _sh_b64('P', b64) + '; '
            # Exit 3 ("already gone") only when the entry's directory is
            # there and searchable: `[ -e ]` and `[ -L ]` are also both
            # false when stat fails with EACCES/ESTALE, and reporting that
            # as a successful delete left the file in place under an
            # "Already deleted" toast. Anything else is exit 6.
            'if ! [ -e "$P" ] && ! [ -L "$P" ]; then '
              'D="${P%/*}"; [ -n "$D" ] || D=/; '
              '[ -d "$D" ] && [ -x "$D" ] && exit 3; exit 6; '
            'fi; '
            'if [ -d "$P" ] && [ ! -L "$P" ]; then '
              'rmdir -- "$P" || exit 5; '
            'else '
              'rm -f -- "$P" || exit 5; '
            'fi'
        )
        proc, err = self._mux_run(remote_cmd, 10, "rm timeout")
        if err:
            return False, err
        if proc.returncode == 0:
            return True, ""
        if proc.returncode == 3:
            # Already gone: the goal state holds. Reporting a failure made
            # a retry after a lost response say "Delete failed" about a
            # delete that had succeeded.
            return True, "already gone"
        if proc.returncode == 6:
            return False, "permission denied"
        return False, _remote_errno_text(
            proc.stderr, "delete failed (exit %d)" % proc.returncode)

    def make_dir(self, abs_path):
        """Create one directory via the ControlMaster side-channel.
        Non-recursive `mkdir` — the parent (the directory the browser is
        showing) already exists, and refusing to create intermediate
        levels keeps a fat-fingered path from quietly making a tree.
        Returns (ok, error_string)."""
        if not self._mux_ready():
            return False, "control socket not ready"

        b64 = base64.b64encode(abs_path.encode("utf-8")).decode("ascii")
        remote_cmd = (
            _sh_b64('P', b64) + '; '
            'if [ -e "$P" ] || [ -L "$P" ]; then exit 4; fi; '
            'mkdir -- "$P" || exit 5'
        )
        proc, err = self._mux_run(remote_cmd, 10, "mkdir timeout")
        if err:
            return False, err
        if proc.returncode == 0:
            return True, ""
        if proc.returncode == 4:
            return False, "name already exists"
        return False, _remote_errno_text(
            proc.stderr, "mkdir failed (exit %d)" % proc.returncode)

    def rename_entry(self, abs_path, new_name):
        """Rename one entry within its own directory. new_name is a bare
        filename — the destination is always dirname(abs_path)/new_name,
        so this can't move an entry elsewhere or be tricked into writing
        an attacker-chosen absolute path (the HTTP layer also rejects a
        new_name containing '/'). Refuses to clobber an existing target.
        Returns (ok, error_string)."""
        if not self._mux_ready():
            return False, "control socket not ready"

        b_src = base64.b64encode(abs_path.encode("utf-8")).decode("ascii")
        b_name = base64.b64encode(new_name.encode("utf-8")).decode("ascii")
        remote_cmd = (
            _sh_b64('S', b_src) + '; ' +
            _sh_b64('N', b_name) + '; '
            # ${S%/*} instead of $(dirname): same trailing-newline hazard.
            'D=${S%/*}; [ -n "$D" ] || D=/; '
            'if [ ! -e "$S" ] && [ ! -L "$S" ]; then exit 3; fi; '
            'if [ -e "$D/$N" ] || [ -L "$D/$N" ]; then exit 4; fi; '
            'mv -- "$S" "$D/$N" || exit 5'
        )
        proc, err = self._mux_run(remote_cmd, 10, "rename timeout")
        if err:
            return False, err
        if proc.returncode == 0:
            return True, ""
        if proc.returncode == 3:
            return False, "no such file or directory"
        if proc.returncode == 4:
            return False, "a file with that name already exists"
        return False, _remote_errno_text(
            proc.stderr, "rename failed (exit %d)" % proc.returncode)

    def download_file(self, remote_path):
        """Stream a file via ControlMaster. Returns (Popen, error).
        Subprocess stdout starts with a header "OK\\t<size>\\n" or
        "ERR\\t<msg>\\n" so the caller can detect failure before
        sending HTTP response headers."""
        if not self._mux_ready():
            return None, "control socket not ready"

        b64 = base64.b64encode(remote_path.encode("utf-8")).decode("ascii")
        remote_cmd = (
            _sh_b64('P', b64) + '; '
            'case "$P" in '
              '/*) F="$P";; '
              '"~") F="$HOME";; '
              '"~/"*) F="$HOME/${P#~/}";; '
              '*) F="$HOME/$P";; '
            'esac; '
            'if [ -f "$F" ]; then '
              # -L: measure what cat will stream. `[ -f ]` follows a
              # symlink but plain stat reports the LINK's size, so a 12-byte
              # link to a 100 KB file sent Content-Length: 12 and the
              # browser saved 12 bytes as "Download complete".
              'SZ=$(stat -L -c%s "$F" 2>/dev/null || stat -L -f%z "$F" 2>/dev/null || printf -- -1); '
              # procfs/sysfs files report size 0 but have content
              # (/proc/cpuinfo): a declared length of 0 made the browser
              # save an empty file. Stream those with no declared length;
              # a truly empty file then simply ends at once.
              '[ "$SZ" = 0 ] && SZ=-1; '
              'printf "OK\\t%s\\n" "$SZ"; '
              'cat -- "$F"; '
            'else printf "ERR\\tFile not found\\n"; fi'
        )
        try:
            # stderr→DEVNULL: the protocol header (OK/ERR on stdout) already
            # signals failure to the caller, and a PIPE that nobody drains
            # would deadlock the child once ssh writes >~64 KB of warnings
            # (host-key prompts, banners, debug). Same pattern as
            # terminate_remote_tmux.
            proc = subprocess.Popen(
                self._mux_argv(remote_cmd),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            return proc, None
        except Exception as e:
            return None, str(e)

    # ── Lifecycle (close / expiry) ──────────────────────────────────

    def close(self):
        self.alive = False
        self._rec_close()
        # Wake any consumer parked in wait_for_data so it observes
        # alive=False and exits via the normal
        # `if not session.alive: break` path. Setting an Event whose
        # listener has already exited is a harmless no-op.
        self._signal()
        if self.master_fd >= 0:
            fd = self.master_fd
            # Reset the sentinel BEFORE the syscall so any concurrent
            # method that reads master_fd under the gap (close racing
            # with read/write) early-returns instead of touching a fd
            # number that's about to be reused by the kernel.
            self.master_fd = -1
            try:
                os.close(fd)
            except OSError:
                # Double-close is possible under disconnect/cleanup
                # races; the fd is gone either way.
                pass
        # SIGTERM, wait briefly, SIGKILL if still alive, then reap — shared
        # with _read_loop's finally via _reap_child so only one thread ever
        # issues the kill sequence (avoids a SIGKILL landing on a recycled
        # pid if both ran concurrently).
        self._reap_child()
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
        # No pipe fds to clean up — the cross-thread wake signal is a
        # threading.Event, which has no fd, no kernel resource, and no
        # teardown ordering hazard. The previous implementation needed
        # weakref.finalize here to defeat an fd-reuse race; switching to
        # Event removed both the race and the cleanup.

    def is_expired(self):
        return time.time() - self.last_activity > SESSION_TIMEOUT


def cleanup():
    """Remove timed-out sessions and stale rate limit entries."""
    # Pop expired sessions OUT of the registry under the lock, then close
    # them OUTSIDE it. close() does SIGTERM -> up to ~0.5s of WNOHANG polls
    # -> SIGKILL -> a blocking waitpid; holding sessions_lock across that
    # stalls every endpoint that takes the lock (input/output/connect/
    # disconnect/stream). close() only touches per-session state, never the
    # registry, so running it unlocked is safe.
    expired = []
    with sessions_lock:
        for sid in [sid for sid, s in sessions.items() if s.is_expired()]:
            expired.append((sid, sessions.pop(sid)))
    for sid, s in expired:
        _log("INFO", "session {} expired, cleaning up".format(sid))
        # Isolate each close so one wedged teardown can't skip the rest of
        # the batch (the session is already out of the registry regardless).
        try:
            s.close()
        except Exception as e:
            _log("WARN", "session {} close failed: {}".format(sid, e))
    # Prune stale per-IP entries to prevent unbounded memory growth.
    # Without this the dicts grow proportionally to attacker activity and
    # never shrink — the worst possible scaling profile for a long-running
    # deploy. An IP whose newest event has aged out of the window
    # disappears from RAM entirely.
    now = time.time()
    _prune_stale(_rate_limits, _rate_lock, now - RATE_LIMIT_WINDOW)
    _prune_stale(_side_channel_rate_limits, _side_channel_rate_lock,
                 now - SIDE_CHANNEL_RATE_WINDOW)
    # Scan-pattern values are (ts, host) tuples, not bare timestamps.
    _prune_stale(_scan_pattern, _scan_pattern_lock,
                 now - SCAN_PATTERN_WINDOW, ts_of=lambda e: e[0])


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

    # Per-connection socket timeout (seconds). StreamRequestHandler.setup()
    # applies this to the client socket, so it bounds every blocking recv
    # and send. Without it (BaseHTTPRequestHandler's default is None) a
    # slowloris client that dribbles its request line/headers — or one that
    # stops reading mid-response so a send blocks on a full TCP window —
    # pins a worker thread forever; since the worker pool is hard-capped
    # (MAX_THREADS), a handful of stuck connections make the server return
    # 503 to everyone. 30 s comfortably exceeds the 15 s SSE keepalive and
    # the 10 s long-poll window (both write/park on far shorter cadences),
    # and a write timeout on a streaming response is an OSError that
    # _stream_session/_output already treat as "client gone". It is a
    # per-operation timeout, not a whole-request deadline, so it does not
    # abort a slow-but-steady large upload (recv resets on any byte) — it
    # only reclaims connections that go fully silent.
    timeout = 30

    # ── HTTP plumbing ───────────────────────────────────────────────

    def log_message(self, fmt, *args):
        pass

    def _build_session_selector(self, session):
        """Build a selectors.DefaultSelector with the client socket
        pre-registered for FIN detection, so a long-running endpoint
        (_stream/_output) can call sel.select(0) many times without
        paying epoll_create1+ctl+close on each iteration. The caller
        owns the returned selector — close it (try/finally or
        with-style). The session arg is unused now (the cross-thread
        data signal is a threading.Event handled inside
        Session.wait_for_data) but kept for call-site stability and
        future use. Register failure on a torn-down client socket is
        swallowed: wait_for_data still ticks forward via Event.wait."""
        sel = selectors.DefaultSelector()
        try:
            sel.register(self.connection.fileno(),
                         selectors.EVENT_READ)
        except (ValueError, OSError):
            pass
        return sel

    def _output_cursor(self, params):
        """The reader's output cursor, or None for a legacy (cursor-less)
        reader. SSE's Last-Event-ID wins over ?since: EventSource re-sends
        its ORIGINAL URL on an automatic reconnect, but carries the id of
        the last event it actually received in that header."""
        raw = self.headers.get("Last-Event-ID")
        if raw is None or not raw.strip():
            raw = params.get("since", [None])[0]
        if raw is None:
            return None
        try:
            v = int(str(raw).strip())
        except ValueError:
            return None
        return v if v >= 0 else None

    def _client_gone(self):
        """Return True if the peer has half-closed (sent FIN) or the
        socket has otherwise died. Non-blocking peek; if there's nothing
        readable yet, the OS raises EAGAIN/EWOULDBLOCK and we treat it
        as 'still connected'. Used by long-running endpoints to bail
        out before draining destructive state into a dead socket.

        The peek is made non-blocking by forcing a zero timeout for the
        recv and restoring the connection's previous timeout afterwards.
        We deliberately do NOT rely on MSG_DONTWAIT: when the socket
        carries a timeout (Handler.timeout is set), CPython wraps even a
        MSG_DONTWAIT recv in a select() that waits up to that timeout, so
        the "non-blocking" peek would block for the whole Handler.timeout
        window. settimeout(0.0) makes the recv truly non-blocking on every
        platform regardless of the socket's mode."""
        sock = self.connection
        prev = sock.gettimeout()
        try:
            sock.settimeout(0.0)
            try:
                peek = sock.recv(1, socket.MSG_PEEK)
                if peek == b"":
                    return True
                return self._consume_unsolicited(sock)
            finally:
                try:
                    sock.settimeout(prev)
                except OSError:
                    pass
        except (BlockingIOError, InterruptedError):
            return False
        except OSError:
            return True

    # Unsolicited bytes tolerated per request before the peer is treated
    # as broken. Nothing legitimate sends anything after the request on
    # this HTTP/1.0 close-after-response server.
    _UNSOLICITED_MAX = 1024 * 1024

    def _consume_unsolicited(self, sock):
        """Called when the peer sent bytes we will never read. The socket
        must not stay readable: both wake paths in wait_for_data treat a
        readable client socket as a wake reason, and _client_gone() only
        reports EOF, so one stray byte turned /api/stream into a 100%-CPU
        loop for the life of the session. Read the bytes away (socket is
        already non-blocking here); past a generous total budget, report
        the peer as gone. Returns True when the request should end."""
        total = getattr(self, "_unsolicited_seen", 0)
        while True:
            try:
                chunk = sock.recv(65536)
            except (BlockingIOError, InterruptedError):
                break
            if not chunk:
                return True
            total += len(chunk)
            if total > self._UNSOLICITED_MAX:
                _log("WARN", "closing {}: {} unsolicited bytes on the "
                     "request socket".format(self._client_ip(), total))
                return True
        self._unsolicited_seen = total
        return False

    # Set once the status line is on the wire, so the _dispatch backstop
    # knows whether a 500 can still be sent.
    _headers_sent = False

    def send_response(self, code, message=None):
        self._headers_sent = True
        BaseHTTPRequestHandler.send_response(self, code, message)

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        # Cap the body BEFORE reading so a huge/bogus Content-Length can't
        # buffer gigabytes into RAM (memory-exhaustion DoS). Every caller
        # wraps this in try/except and turns a raised error into a 400.
        try:
            n = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            raise ValueError("invalid Content-Length")
        if n < 0:
            raise ValueError("invalid Content-Length")
        if n > MAX_BODY_SIZE:
            raise ValueError("request body too large")
        return self.rfile.read(n) if n else b""

    def _json_body(self):
        """Parse the request body as a JSON object. Returns the dict, or
        None after replying 400. Non-dict JSON (a bare list / string /
        number) is rejected too: every caller immediately does
        body.get(), which previously blew up with AttributeError — a
        dropped connection — instead of the 400 the malformed-JSON case
        gets."""
        # CSRF layer 2: a cross-site <form> can only send text/plain,
        # urlencoded or multipart. Requiring the JSON media type means a
        # forged form post never reaches a handler even if the Origin
        # check in _csrf_gate() is somehow bypassed. The bundled client
        # and the PHP shim both send application/json.
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0]
        if ctype.strip().lower() != "application/json":
            self._json({"error": "content-type must be application/json"},
                       415)
            return None
        try:
            body = json.loads(self._body().decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, 400)
            return None
        if not isinstance(body, dict):
            self._json({"error": "invalid json"}, 400)
            return None
        return body

    def _csrf_gate(self):
        """CSRF layer 1 for every state-changing method. A browser sends
        `Origin` on every cross-site POST/DELETE (and on same-origin ones
        too, in current engines), so an Origin whose host is not the
        host this request was addressed to is a forged request: 403.
        `Sec-Fetch-Site: cross-site` is the same signal from a browser
        that omitted Origin. No Origin and no Sec-Fetch-Site means a
        non-browser client (curl, the PHP shim, monitoring) - those are
        not CSRF victims and pass. `Origin: null` (sandboxed iframe,
        data: URL, some redirects) is rejected: nothing legitimate posts
        to websh from there. Returns True when the reply was sent."""
        origin = self.headers.get("Origin")
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if origin is None:
            if site in ("cross-site", "same-site"):
                self._json({"error": "cross-site request refused"}, 403)
                return True
            return False
        origin = origin.strip()
        o_host = urllib.parse.urlsplit(origin).netloc.lower() \
            if "://" in origin else ""
        if not o_host:
            self._json({"error": "cross-site request refused"}, 403)
            return True
        allowed = {(self.headers.get("Host") or "").strip().lower()}
        # Behind a trusted reverse proxy the browser-facing host may only
        # be visible in X-Forwarded-Host.
        if self._peer()[1]:
            fwd = (self.headers.get("X-Forwarded-Host") or "").split(",")[0]
            if fwd.strip():
                allowed.add(fwd.strip().lower())
        allowed.discard("")
        if o_host in allowed:
            return False
        _warn_proxy_host_once(self.headers.get("Host") or "", o_host)
        self._json({"error": "cross-site request refused"}, 403)
        return True

    def _path(self):
        p = self.path.split("?")[0].rstrip("/")
        return p or "/"

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
        data, gz, etag = _static_blob(filepath)
        # Negotiate gzip. websh.js is ~230 KB raw / ~75 KB gzipped and was
        # re-sent in full on every page load: no compression, no
        # validator, Cache-Control: no-cache. no-cache stays (a deploy
        # must be picked up immediately) but now revalidates cheaply:
        # a matching If-None-Match gets a body-less 304.
        use_gz = gz is not None and _accepts_gzip(
            self.headers.get("Accept-Encoding", ""))
        tag = etag[:-1] + '-gz"' if use_gz else etag
        inm = self.headers.get("If-None-Match", "")
        if inm and (inm.strip() == "*" or tag in
                    [t.strip().replace("W/", "", 1) for t in inm.split(",")]):
            self.send_response(304)
            self.send_header("ETag", tag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            return
        body = gz if use_gz else data
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("ETag", tag)
        self.send_header("Cache-Control", "no-cache")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    # Content-Security-Policy + companions for the credential-handling page.
    # The policy permits exactly what the app already loads (self, the
    # xterm CDN, Google Fonts, data: URIs) so it does not break anything,
    # while hardening clickjacking (frame-ancestors), plugins (object-src),
    # base-tag hijacking (base-uri) and exfiltration (connect-src 'self').
    # script-src keeps 'unsafe-inline' because the no-build UI relies on
    # inline event handlers — operators who vendor the assets can tighten it.
    _CSP = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net "
        "https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'"
    )

    def _send_security_headers(self):
        self.send_header("Content-Security-Policy", self._CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    # ── Dispatch ────────────────────────────────────────────────────
    #
    # One table per HTTP method, action → handler-method name. Adding an
    # endpoint is one table row (plus a row in the PHP proxy's switch for
    # shared-hosting mode). Values are attribute names rather than bound
    # methods so the tables can live on the class.

    _POST_ROUTES = {
        "connect":         "_connect",
        "input":           "_input",
        "resize":          "_resize",
        "disconnect":      "_disconnect",
        "upload":          "_upload",
        "upload_finalize": "_upload_finalize",
        "upload_cancel":   "_upload_cancel",
        "tmux_options":    "_tmux_options",
        "rm":              "_rm",
        "mkdir":           "_mkdir",
        "mv":              "_mv",
        "save":            "_save_credential",
        # Compatibility with the bundled frontend in Python-only mode.
        # The PHP shim translates POST ?action=save_delete into
        # DELETE /api/save; when server.py serves api.php-style URLs
        # directly, do the same dispatch here.
        "save_delete":     "_delete_credential",
    }

    _GET_ROUTES = {
        "output":       "_output",
        "stream":       "_stream",
        "config":       "_config",
        "ping":         "_ping",
        "tmux_capture": "_tmux_capture",
        "ls":           "_ls",
        "download":     "_download",
    }

    _DELETE_ROUTES = {
        "save": "_delete_credential",
    }

    def _dispatch(self, routes):
        name = routes.get(self._resolve_action())
        if name is None:
            self._json({"error": "not found"}, 404)
            return
        try:
            getattr(self, name)()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as e:
            # The client went away mid-request: a closed tab, a cancelled
            # upload, a long-poll the browser dropped (_output re-raises
            # after unread() on purpose). Routine, not a server fault -
            # it was logged as "[ERROR] unhandled error", and a 500 was
            # then written into the dead socket.
            _log("INFO", "client went away during {} for {}: {}".format(
                name, self._client_ip(), type(e).__name__))
        except Exception as e:
            # Last line of defence. An exception escaping a handler used
            # to reach the worker's handle_error: traceback on stderr,
            # socket closed, and the client saw an aborted connection
            # with no status at all (e.g. PermissionError from
            # _save_creds_atomic when the creds dir is unwritable). Reply
            # 500 if the headers have not gone out yet; either way, log.
            _log("ERROR", "unhandled error in {} for {}: {}: {}".format(
                name, self._client_ip(), type(e).__name__, e))
            if not getattr(self, "_headers_sent", False):
                try:
                    self._json({"error": "internal error"}, 500)
                except Exception:
                    pass

    def do_POST(self):
        if self._csrf_gate() or self._auth_gate():
            return
        self._dispatch(self._POST_ROUTES)

    def do_GET(self):
        # /api/ping stays open: docker healthchecks and the PHP shim's
        # auto-start probe must work before any auth proxy is involved.
        # It reveals only liveness + version, which the proxy-protected
        # deployment model already exposes to the proxy itself.
        if self._resolve_action() != "ping" and self._auth_gate():
            return
        static = _STATIC_FILES.get(self._path())
        if static:
            self._serve_static(*static)
            return
        self._dispatch(self._GET_ROUTES)

    def do_DELETE(self):
        if self._csrf_gate() or self._auth_gate():
            return
        self._dispatch(self._DELETE_ROUTES)

    def _config(self):
        self._json(config_public())

    def _ping(self):
        self._json({"ok": True, "version": __version__, "proto": PROTO_VERSION})

    # ── Source-IP / session-ID validation ───────────────────────────

    def _peer(self):
        """(address, trusted) for the connection's peer. A Unix-socket
        peer has no IP (client_address is a path, usually ''); only
        processes of the websh account can open the 0600 socket — in
        practice api.php — so it is trusted and reported as loopback."""
        if not isinstance(self.client_address, tuple):
            return "127.0.0.1", True
        peer = self.client_address[0]
        return peer, peer in _TRUSTED_PROXIES

    def _client_ip(self):
        """Return the IP we treat as the request's source for rate-limit
        and per-IP-cap purposes.

        Uses the TCP peer by default. When the peer is in TRUSTED_PROXIES
        (or on the Unix socket) we read the FIRST X-Forwarded-For token —
        but only if it parses as a valid IP literal. Anything else (typo,
        intentional garbage, an injected oversized blob) falls back to
        the peer.

        Important: when running behind a reverse proxy, the proxy MUST
        OVERWRITE this header (`proxy_set_header X-Forwarded-For $remote_addr;`
        on nginx, or use X-Real-IP), not append to it. A proxy that
        appends lets a client put any IP they like in the first token,
        bypassing per-IP rate-limiting and the per-IP session cap. The
        ip_address() validation here only stops obvious garbage and
        attacker-controlled non-IP bytes from ending up as the registry
        comparison key — it does NOT compensate for an appending proxy.
        """
        peer, trusted = self._peer()
        if trusted:
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                token = xff.split(",", 1)[0].strip()
                if token:
                    try:
                        ipaddress.ip_address(token)
                    except ValueError:
                        return peer
                    return token
        return peer

    def _client_identity(self):
        """The authenticated identity, or "" when unauthenticated.
        Only meaningful when WEBSH_AUTH_HEADER is configured; the header
        is read exclusively from trusted proxies (same rule as
        X-Forwarded-For) so a direct client cannot mint identities."""
        if not WEBSH_AUTH_HEADER:
            return ""
        if not self._peer()[1]:
            return ""
        values = self.headers.get_all(WEBSH_AUTH_HEADER) or []
        if len(values) > 1:
            # A proxy that APPENDS its trusted header after a
            # client-smuggled one would otherwise let the client's
            # first value win (headers.get returns the first).
            # Duplicates mean the proxy is not overwriting — refuse.
            return ""
        return (values[0] if values else "").strip()[:256]

    def _auth_gate(self):
        """401 unless the request carries an identity. True = blocked
        (response already written). No-op when the feature is off."""
        if not WEBSH_AUTH_HEADER:
            return False
        if self._client_identity():
            return False
        self._json({"error": "unauthorized"}, 401)
        return True

    def _valid_sid(self, sid):
        # A JSON body can carry any type here. re.match raises TypeError
        # on a list/dict/int, which the dispatch backstop turned into a
        # 500 (and an ERROR log line) for every session endpoint - a
        # request that should simply be told "no such session".
        return isinstance(sid, str) and bool(sid) and bool(_UUID_RE.match(sid))

    def _require_session(self, sid):
        """Validate `sid`, look it up, and reply 404 when it does not name
        a live session. Returns the SSHSession, or None when a response
        has already been written.

        Rejects `_SessionPlaceholder` slots too: a placeholder only exists
        for the duration of `_connect`'s ssh spawn, and no endpoint can do
        anything useful with one — before this helper, hitting a non-stream
        endpoint inside that window raised AttributeError (a 500 from
        /api/input, whose write sits in a try/except; a dropped connection
        with no response everywhere else) instead of the 404 the registry
        miss gets a moment later."""
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return None
        with sessions_lock:
            session = sessions.get(sid)
        if not session or isinstance(session, _SessionPlaceholder):
            self._json({"error": "session not found"}, 404)
            return None
        if WEBSH_AUTH_HEADER and \
                getattr(session, "owner", "") != self._client_identity():
            # Another user's session: deny without confirming existence
            # beyond the 403 (the sid itself was a 128-bit secret only
            # its owner should hold; a cross-user probe is noteworthy —
            # hence the audit record).
            _access_log_emit("authz_denied", self._client_ip(),
                             sid=sid, auth_user=self._client_identity())
            self._json({"error": "forbidden"}, 403)
            return None
        return session

    def _side_channel_throttled(self):
        """Apply the per-IP side-channel rate limit. Returns True (and has
        already written a 429) when the caller should stop. Each
        side-channel endpoint spawns an ssh subprocess and pins a worker,
        so this caps the amplification an unbounded loop could cause."""
        if not _check_side_channel_rate_limit(self._client_ip()):
            self._json({"error": "rate_limited", "code": "rate_limited"}, 429)
            return True
        return False

    # ── Vault save / delete ─────────────────────────────────────────

    def _reply_creds_unreadable(self, event):
        _access_log_emit(event, self._client_ip(), result="error",
                         error="creds_unreadable")
        self._json({"error": "credential store temporarily unavailable",
                    "code": "creds_unreadable"}, 503)

    def _reply_vault_unavailable(self):
        """The shared 501 for every vault-gated path; pairs with
        _vault_available()."""
        self._json({"error": "credential vault unavailable "
                    "(cryptography missing / WEBSH_VAULT_ENABLE not "
                    "set / websh.creds.json schema unsupported — "
                    "see server log)"}, 501)

    def _save_credential(self):
        ip = self._client_ip()
        if not _check_rate_limit(ip):
            _access_log_emit("save", ip, result="rate_limited")
            self._json({"error": "too many requests", "code": "rate_limited"}, 429)
            return
        if not _vault_available():
            self._reply_vault_unavailable()
            return
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            content_length = 0
        if content_length > _MAX_VAULT_REQUEST_BYTES:
            self._json({"error": "request body too large"}, 413)
            return
        body = self._json_body()
        if body is None:
            return
        vault_id = (body.get("vault_id") or "").strip()
        conn_id  = (body.get("conn_id") or "").strip()
        host     = (body.get("host") or "").strip()
        port     = clamp(body.get("port"), MIN_PORT, MAX_PORT, 22)
        username = (body.get("username") or "").strip()
        iv_b64   = body.get("iv") or ""
        ct_b64   = body.get("ct") or ""

        def _bad(detail):
            self._json({"error": "vault_input_invalid",
                        "detail": detail}, 400)

        if not _VAULT_ID_RE.match(vault_id):
            return _bad("invalid vault_id")
        if not _CONN_ID_RE.match(conn_id):
            return _bad("invalid conn_id")
        if not host or not username:
            return _bad("host and username are required")
        if not _valid_host(host) or not _valid_username(username):
            return _bad("invalid host or username")
        try:
            iv = base64.b64decode(iv_b64, validate=True)
            ct = base64.b64decode(ct_b64, validate=True)
        except (binascii.Error, ValueError):
            return _bad("iv/ct must be base64")
        if len(iv) != 12:
            return _bad("iv must be 12 bytes")
        if len(ct) < 17:
            return _bad("ct too short for GCM tag")
        raw_opts = body.get("ssh_options", {})
        if raw_opts is not None and not isinstance(raw_opts, dict):
            return _bad("ssh_options must be an object")
        ssh_options, dropped = _filter_ssh_options(raw_opts or {})
        # Reject vault-side file-path and routing options (read-oracle,
        # arbitrary file write via known-hosts, deny-list bypass via
        # ProxyJump). See _VAULT_DENY_SSH_OPTIONS.
        for k in list(ssh_options.keys()):
            if isinstance(k, str) and k.lower() in _VAULT_DENY_SSH_OPTIONS:
                dropped.append(k)
                del ssh_options[k]
        if dropped:
            _log("WARN", "save dropped ssh_options keys: {}".format(dropped))

        if body.get("aad_v") != _AAD_VERSION:
            return _bad("aad_v {} required: the blob must bind its "
                        "destination".format(_AAD_VERSION))
        rec = {"host": host, "port": port, "username": username,
               "iv": iv_b64, "ct": ct_b64, "aad_v": _AAD_VERSION}
        if ssh_options:
            rec["ssh_options"] = ssh_options

        with _creds_lock:
            # RMW must be atomic — without the outer lock, a concurrent save
            # to a different (vault_id, conn_id) slot could read the same
            # pre-state and clobber our update on its own save.
            data = _load_creds()
            if _creds_unreadable is not None:
                self._reply_creds_unreadable("save")
                return
            new_vaults = dict(data.get("vaults", {}))
            slot = dict(new_vaults.get(vault_id, {}))
            slot[conn_id] = rec
            new_vaults[vault_id] = slot
            new_data = {"version": _CREDS_SCHEMA_VERSION, "vaults": new_vaults}
            _save_creds_atomic(new_data)

        _access_log_emit("save", self._client_ip(),
                         result="ok", vault_id=vault_id, conn_id=conn_id,
                         target_host=host, target_user=username,
                         target_port=port, iv_len=len(iv), ct_len=len(ct))
        self._json({})

    def _delete_credential(self):
        ip = self._client_ip()
        if not _check_rate_limit(ip):
            _access_log_emit("save_delete", ip, result="rate_limited")
            self._json({"error": "too many requests", "code": "rate_limited"}, 429)
            return
        if not _vault_available():
            self._reply_vault_unavailable()
            return
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        vault_id = (params.get("vault_id", [""])[0] or "").strip()
        conn_id  = (params.get("conn_id",  [""])[0] or "").strip()
        if not _VAULT_ID_RE.match(vault_id) or not _CONN_ID_RE.match(conn_id):
            self._json({"error": "vault_input_invalid",
                        "detail": "invalid vault_id or conn_id"}, 400)
            return
        with _creds_lock:
            data = _load_creds()
            if _creds_unreadable is not None:
                # Not "not found": the entry may well be in the file we
                # cannot read, and a client would drop its card on a 404.
                self._reply_creds_unreadable("save_delete")
                return
            slot = dict(data.get("vaults", {}).get(vault_id, {}))
            if conn_id not in slot:
                self._json({"error": "not found"}, 404)
                return
            slot.pop(conn_id)
            new_vaults = dict(data.get("vaults", {}))
            if slot:
                new_vaults[vault_id] = slot
            else:
                # Reap empty vault entry so iteration stays cheap.
                new_vaults.pop(vault_id, None)
            new_data = {"version": _CREDS_SCHEMA_VERSION,
                        "vaults": new_vaults}
            _save_creds_atomic(new_data)
        _access_log_emit("save_delete", self._client_ip(),
                         result="ok", vault_id=vault_id, conn_id=conn_id)
        # 204 No Content
        self.send_response(204)
        self.end_headers()

    # ── Connect ─────────────────────────────────────────────────────

    def _connect(self):
        # Rate limit by IP
        ip = self._client_ip()
        t0 = time.time()
        if not _check_rate_limit(ip):
            _log("WARN", "rate limited: {}".format(ip))
            _access_log_emit("connect", ip, result="rate_limited")
            self._json({"error": "too many connection attempts", "code": "rate_limited"}, 429)
            return

        body = self._json_body()
        if body is None:
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
        tmux_options = _validate_tmux_options(body) if persistent else []

        # Resolve credentials: saved vault card, named connection, or manual body.
        conn_name = body.get("connection", "").strip()
        sv_vault = (body.get("vault_id") or "").strip()
        sv_conn  = (body.get("conn_id")  or "").strip()
        sv_vkey  = body.get("vault_key") or ""
        is_saved = bool(sv_vault or sv_conn or sv_vkey)
        ssh_options = {}
        if is_saved:
            # ── Saved-variant: resolve host/username/password from vault ──
            if not _vault_available():
                self._reply_vault_unavailable()
                return
            if not _VAULT_ID_RE.match(sv_vault) or not _CONN_ID_RE.match(sv_conn):
                self._json({"error": "vault_input_invalid",
                            "detail": "invalid vault_id or conn_id"}, 400)
                return
            try:
                vault_key_bytes = base64.b64decode(sv_vkey, validate=True)
            except (binascii.Error, ValueError):
                self._json({"error": "vault_input_invalid",
                            "detail": "vault_key must be base64"}, 400)
                return
            if len(vault_key_bytes) != 32:
                self._json({"error": "vault_input_invalid",
                            "detail": "vault_key must be 32 bytes"}, 400)
                return
            data = _load_creds()
            if _creds_unreadable is not None:
                # The entry may exist in the file we cannot read; "not
                # found" would send the client down its vault_not_found
                # path (a stale card) for what is an operator problem.
                self._reply_creds_unreadable("connect")
                return
            rec = data.get("vaults", {}).get(sv_vault, {}).get(sv_conn)
            if rec is None:
                _access_log_emit("connect", ip, result="cred_not_found",
                                 vault_id=sv_vault, conn_id=sv_conn)
                self._json({"error": "saved entry not found"}, 404)
                return
            try:
                rec_aad_v = 2 if rec.get("aad_v") == 2 else 1
                plaintext = _decrypt_credential(
                    vault_key_bytes, rec.get("iv", ""), rec.get("ct", ""),
                    sv_vault, sv_conn,
                    aad=_credential_aad(
                        sv_vault, sv_conn, rec_aad_v,
                        rec.get("host"), rec.get("port", 22),
                        rec.get("username")))
            except InvalidTag:
                _access_log_emit("connect", ip,
                                 result="cred_decrypt_failed",
                                 vault_id=sv_vault, conn_id=sv_conn)
                # 400 not 401 — avoid upstream auth re-prompt loops.
                self._json({"error": "vault_decrypt_failed"}, 400)
                return
            except (ValueError, RuntimeError) as e:
                self._json({"error": "vault_input_invalid",
                            "detail": str(e)}, 400)
                return
            try:
                creds = json.loads(plaintext.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                self._json({"error": "vault_decrypt_failed",
                            "detail": "blob plaintext is not JSON"}, 400)
                return
            if not isinstance(creds, dict):
                # AAD-bound blob decrypted cleanly but plaintext isn't a
                # JSON object — hand-edited file, or a vault payload from
                # a future schema. Cannot extract password/key safely.
                self._json({"error": "vault_decrypt_failed",
                            "detail": "blob plaintext is not a JSON object"}, 400)
                return
            host = (rec.get("host") or "").strip()
            port = clamp(rec.get("port"), MIN_PORT, MAX_PORT, 22)
            username = (rec.get("username") or "").strip()
            ssh_options = rec.get("ssh_options") or {}
            if isinstance(ssh_options, dict):
                # Drop vault-side file-path/routing entries even if a prior
                # version stored them; the operator config (websh.json) is the
                # trusted source for these. See _VAULT_DENY_SSH_OPTIONS.
                ssh_options = {k: v for k, v in ssh_options.items()
                               if isinstance(k, str)
                               and k.lower() not in _VAULT_DENY_SSH_OPTIONS}
            else:
                ssh_options = {}
            password = creds.get("password") or ""
            key = creds.get("key") or ""
            key_pass = creds.get("key_pass") or ""
            if not isinstance(password, str) or not isinstance(key, str) \
                    or not isinstance(key_pass, str):
                self._json({"error": "vault_decrypt_failed",
                            "detail": "non-string credential field"}, 400)
                return
            # Mirror manual-mode client routing (websh.js:816): for a
            # passphrase-protected key, the passphrase rides into the
            # password field so the PTY auth-detector answers the
            # "Enter passphrase for key" prompt with it. SSHSession
            # doesn't have a separate key_pass arg by design — it
            # pipes whatever's in `password` to whatever ssh prompts.
            if key and key_pass and not password:
                password = key_pass
            # Best-effort scrub of bytearrays. Python str copies in
            # `password`/`key` linger until GC; hardened deploy recipe
            # is what actually closes the read window.
            try:
                pa = bytearray(plaintext)
                for i in range(len(pa)):
                    pa[i] = 0
            except TypeError:
                pass
            try:
                ka = bytearray(vault_key_bytes)
                for i in range(len(ka)):
                    ka[i] = 0
            except TypeError:
                pass
        elif conn_name:
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

        # Reject anything that isn't a plain hostname/IP + login name:
        # ssh flags (`-o...`), and the `user@host` / `ssh://` destination
        # forms that getaddrinfo() cannot resolve - which is how they
        # used to bypass the deny-list (resolution failure = fall-open).
        if not _valid_host(host) or not _valid_username(username):
            self._json({"error": "invalid host or username"}, 400)
            return

        # A saved vault card or a free-form manual POST must pass
        # authorize_target() (named connections were vetted above). A saved
        # card may carry the `connection` name it was saved from — passed as
        # a disambiguation hint only; is_saved still routes it here, so a
        # card cannot skip the gate by also setting `connection`.
        if is_saved or not conn_name:
            conn_hint = conn_name if is_saved else None
            ok, deny_err = authorize_target(host, port, username, is_saved,
                                            conn_hint=conn_hint)
            if not ok:
                _access_log_emit("connect", ip, result="deny_blocked",
                                 target_host=host, target_user=username)
                # Feed the scan-pattern detector for deny-list rejections
                # (real scans, restrict_hosts off) and for saved-card
                # rejections under restrict_hosts — a saved card is a real
                # accept/reject surface, so host/slot probing through it
                # should accumulate. A stale-UI manual POST under
                # restrict_hosts still does NOT (the deny_blocked record
                # still surfaces it); the detector keys on distinct hosts,
                # so one honest broken card never trips it, only a sweep does.
                cfg = load_config()
                if ((not cfg["restrict_hosts"] or is_saved)
                        and _record_deny_for_scan(ip, host)):
                    # Separate scan_pattern record so fail2ban can ban on
                    # this signal without also banning deny_blocked typos.
                    _access_log_emit("connect", ip, result="scan_pattern",
                                     target_host=host, target_user=username)
                self._json({"error": deny_err}, 403)
                return

        # Check session limits and reserve a counted slot atomically.
        # Per-IP cap (if enabled) runs first so a single abuser cannot
        # starve everyone else by holding all the global slots. fg/bg
        # are counted separately for the global caps (a file-transfer
        # side channel should not push a user out of an interactive
        # session and vice versa) but they share the per-IP bucket —
        # abuse is abuse regardless of classification.
        #
        # We insert a _SessionPlaceholder under the gate lock and only
        # then drop it to spawn ssh (which is wall-clock-slow). The next
        # connect from the same IP / class observes a count that
        # includes this in-flight slot, closing the TOCTOU window where
        # N concurrent connects all observed `count == cap-1` and all
        # passed the gate. Either we swap the placeholder for the real
        # Session on success, or pop it on failure.
        sid = str(uuid.uuid4())
        with sessions_lock:
            if MAX_SESSIONS_PER_IP > 0:
                per_ip = _per_ip_session_count(ip)
                if per_ip >= MAX_SESSIONS_PER_IP:
                    _log("WARN", "per-IP session cap hit: ip={} count={}".format(
                        ip, per_ip))
                    _access_log_emit("connect", ip,
                                     result="session_cap_per_ip",
                                     target_host=host, target_user=username)
                    self._json({"error": "too many active sessions from your IP",
                                "code": "session_cap_per_ip"},
                               429)
                    return
            if is_bg:
                count = sum(1 for s in sessions.values() if s.is_background)
                if count >= MAX_BG_SESSIONS:
                    _access_log_emit("connect", ip,
                                     result="session_cap_global",
                                     target_host=host, target_user=username,
                                     classification="background")
                    self._json({"error": "too many background sessions",
                                "code": "session_cap_background"}, 429)
                    return
            else:
                count = sum(1 for s in sessions.values()
                            if not s.is_background)
                if count >= MAX_SESSIONS:
                    _access_log_emit("connect", ip,
                                     result="session_cap_global",
                                     target_host=host, target_user=username,
                                     classification="foreground")
                    self._json({"error": "too many active sessions",
                                "code": "session_cap_global"}, 429)
                    return
            sessions[sid] = _SessionPlaceholder(client_ip=ip,
                                                is_background=is_bg)

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
                tmux_options=tmux_options,
                client_ip=ip,
            )
            # Identity stamp for header-trust auth: every session
            # endpoint compares this against the request's identity.
            # Empty when the feature is off (and never compared then).
            session.owner = self._client_identity()
            with sessions_lock:
                # Swap placeholder for the real Session. The slot was
                # already counted under the gate lock, so this never
                # bumps any cap.
                sessions[sid] = session

            time.sleep(CONNECT_SETTLE_TIME)
            _log("INFO", "new session {} for {}@{}:{}{}".format(
                sid, username, host, port,
                " [persistent slot=" + slot_id + "]" if persistent else ""))
            # NOT forgiven here: "ssh spawned" is not "authenticated". A
            # scanner interleaving one connect to any non-denied host
            # (auth failing is fine) used to reset its own counter. The
            # forgiveness happens in _input, on the first real keystroke
            # of a session that did not fail auth - see _forgive_scan_for_ip.
            _access_log_emit("connect", ip, result="ok", sid=sid,
                             auth_user=self._client_identity(),
                             target_host=host, target_user=username,
                             persistent=persistent,
                             latency_ms=int((time.time() - t0) * 1000))
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
            # Spawn failed before the swap. Pop the placeholder so it
            # does not occupy a counted slot forever, and (if the real
            # Session was constructed but registry insert raised) close
            # it. The pop is best-effort: if the swap above already ran
            # and a later step raised, we'd be popping the real Session
            # — that's fine, close() below releases its resources.
            with sessions_lock:
                stale = sessions.pop(sid, None)
            if session is not None:
                session.close()
            elif stale is not None and hasattr(stale, "close"):
                # Placeholder pop — no-op close() but keep the call
                # symmetric with the real-session branch.
                stale.close()
            _access_log_emit("connect", ip, result="error",
                             target_host=host, target_user=username,
                             error=str(e)[:200])
            self._json({"error": str(e)}, 500)

    # ── I/O endpoints (input / output / stream / resize) ────────────

    def _input(self):
        # The one JSON handler that used to parse its own body: a valid-
        # JSON non-object ([1,2], "str") reached body.get() outside the
        # try and the AttributeError dropped the connection with no
        # response. _json_body() covers that and the media-type gate.
        body = self._json_body()
        if body is None:
            return

        sid = body.get("session_id", "")
        session = self._require_session(sid)
        if session is None:
            return

        try:
            data = body.get("data", "")
            if not isinstance(data, str):
                self._json({"error": "data must be a string"}, 400)
                return
            ok = session.write(data.encode("utf-8"))
            if ok and session.alive and not session.auth_failed \
                    and data.strip():
                # A real keystroke into a session that did not fail auth
                # is the "this IP is a person" signal the scan-pattern
                # detector forgives on (see _forgive_scan_for_ip).
                _forgive_scan_for_ip(self._client_ip())
            reply = {"ok": ok, "alive": session.alive}
            # Where the session's output stands. A client whose output
            # channel died quietly (Wi-Fi switched, laptop slept: no FIN,
            # no error) sees its own cursor fall behind this and restarts
            # the channel, instead of showing nothing until a reload.
            end = getattr(session, "_replay_end", None)
            if isinstance(end, int):
                reply["cursor"] = end
            self._json(reply)
        except Exception as e:
            self._json({"error": "input error: " + str(e)}, 500)

    def _output(self):
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]

        session = self._require_session(sid)
        if session is None:
            return
        cursor = self._output_cursor(params)

        # Long-poll: wait up to POLL_TIMEOUT seconds for data. Bail
        # early if the client hung up so we don't drain bytes into a
        # closed socket (read() is destructive — those bytes would
        # be lost) and don't spin a worker for the full timeout.
        # Wait machinery: the PTY reader calls session._signal()
        # (a threading.Event) on every output_buf update; we park in
        # session.wait_for_data() which interleaves Event waits with
        # non-blocking selector polls of the client socket for FIN
        # detection. The selector is built once and reused across
        # iterations to avoid epoll_create1+close churn.
        deadline = time.time() + POLL_TIMEOUT
        sel = self._build_session_selector(session)
        try:
            while True:
                if self._client_gone():
                    return
                if _shutting_down:
                    # Transient for the client (it retries the SAME
                    # session); the restarted server then says 404 and
                    # the pane re-attaches. Not {"alive": false}, which
                    # means the remote shell itself ended.
                    self._json({"error": "server restarting",
                                "code": "restarting"}, 503)
                    return
                extra = {}
                if cursor is None:
                    data = session.read()
                else:
                    data, nxt, lost, reset = session.read_since(cursor)
                    extra = {"cursor": nxt}
                    if lost or reset:
                        extra.update({"lost": lost, "reset": reset})
                if data or len(extra) > 1:
                    # If the client hung up between read() and write(), we
                    # would still lose these bytes — push them back on
                    # failure so the next /api/output picks them up
                    # (legacy readers; a cursor reader asks again).
                    body = {
                        "data": base64.b64encode(data).decode("ascii"),
                        "alive": session.alive,
                        "auth_failed": session.auth_failed,
                    }
                    body.update(extra)
                    try:
                        self._json(body)
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        if cursor is None:
                            session.unread(data)
                        raise
                    return
                if not session.alive:
                    if _shutting_down:
                        continue    # answered as 503 at the loop top
                    body = {"data": "", "alive": False,
                            "auth_failed": session.auth_failed}
                    body.update(extra)
                    self._json(body)
                    return
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                session.wait_for_data(self.connection, remaining,
                                      selector=sel)
        finally:
            try:
                sel.close()
            except Exception:
                pass

        body = {"data": "", "alive": session.alive,
                "auth_failed": session.auth_failed}
        if cursor is not None:
            body["cursor"] = cursor
        self._json(body)

    def _stream(self):
        """SSE: stream output as 'data' events until session dies or client
        disconnects. Each 'data' event carries the same JSON payload as
        /api/output ({data, alive, auth_failed}). On clean termination an
        'end' event is sent. Comment heartbeats keep proxies from idling
        the connection out."""
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]

        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        if WEBSH_AUTH_HEADER:
            # Ownership BEFORE the slot-acquisition loop: a non-owner
            # must not be able to (a) momentarily steal the stream slot
            # or (b) learn streaming-vs-idle from a 409-vs-403 split.
            with sessions_lock:
                probe = sessions.get(sid)
            if (probe is not None
                    and not isinstance(probe, _SessionPlaceholder)
                    and getattr(probe, "owner", "")
                        != self._client_identity()):
                _access_log_emit("authz_denied", self._client_ip(),
                                 sid=sid, auth_user=self._client_identity())
                self._json({"error": "forbidden"}, 403)
                return
        # Acquire the per-session stream slot under sessions_lock. A second
        # /api/stream for the same session is the client reconnecting
        # (visibility resume, network blip, EventSource auto-retry), and
        # the NEWEST stream wins: the previous holder may be writing into
        # a connection that died without a FIN (laptop asleep, network
        # switched), which TCP only notices minutes later. It used to keep
        # the slot all that time and every reconnect got a 409 - and the
        # client then gave up on SSE for good. Bump the generation and wake
        # the holder; it steps aside before its next read (output is read
        # by cursor, so nothing is lost) and releases the slot in ms. A
        # holder blocked inside a write can't look; after the deadline a
        # 409 still keeps a truly stuck one from deadlocking the client.
        deadline = time.time() + 2.0
        session = None
        duplicate = False
        bumped_to = None
        bumped_at = 0.0
        my_gen = 0
        while True:
            with sessions_lock:
                session = sessions.get(sid)
                if session is None:
                    break
                # During the connect window the registry entry is a
                # _SessionPlaceholder, whose __slots__ omit _stream_active —
                # dereferencing it would raise AttributeError out of do_GET
                # (500 / crashed worker). Treat a not-yet-real session as
                # not-found so the client (EventSource) simply retries.
                if isinstance(session, _SessionPlaceholder):
                    session = None
                    break
                if not session._stream_active:
                    session._stream_active = True
                    my_gen = getattr(session, "_stream_gen", 0)
                    if bumped_to is not None:
                        session._stream_taken_at = time.time()
                    break
                gen = getattr(session, "_stream_gen", 0)
                # A takeover only once in a while per session: two live
                # tabs on the same session (both restored it from
                # localStorage) would otherwise evict each other every
                # few seconds for ever. The second one gets the 409 and
                # settles on long-poll, as before; a holder that is
                # really dead is taken over on the first try.
                may_take = (time.time() - getattr(session, "_stream_taken_at", 0.0)
                            >= STREAM_TAKEOVER_MIN_GAP)
                if may_take and (bumped_to is None or
                                 # The slot changed hands to someone who
                                 # acquired with our generation (an entrant
                                 # racing us) - ask again, once they have
                                 # had time to step aside.
                                 (gen == bumped_to and
                                  time.time() - bumped_at > 0.3)):
                    session._stream_gen = gen + 1
                    bumped_to = gen + 1
                    bumped_at = time.time()
                    session._signal()
            if time.time() >= deadline:
                duplicate = True
                break
            time.sleep(0.01)
        if duplicate:
            self._json({"error": "stream already active for this session"}, 409)
            return
        if session is None:
            self._json({"error": "session not found"}, 404)
            return

        try:
            self._stream_session(session, self._output_cursor(params),
                                 gen=my_gen)
        finally:
            # Release the per-session stream slot regardless of how the
            # body exited (clean end, BrokenPipe, exception). Done under
            # sessions_lock to keep the acquire/release symmetric and
            # ordered with concurrent _stream entrants.
            with sessions_lock:
                session._stream_active = False

    def _stream_session(self, session, cursor=None, gen=None):
        """Body of /api/stream once the per-session slot is held.

        With a cursor (current clients) output is read with read_since():
        nothing is consumed, every data event carries `cursor` and an SSE
        `id:` of the offset after it, and a write that silently went
        nowhere costs nothing - the next connection asks again from the
        client's own cursor. Without one (older cached clients) the
        original destructive read()/unread() path is used unchanged."""
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache, no-store")
            # We deliberately don't send "Connection: keep-alive": this is
            # HTTP/1.0 and we have no Content-Length. The client signals
            # end-of-stream by seeing the connection close, which the
            # server does naturally once the session dies.
            self.send_header("Connection", "close")
            # Tell nginx and similar proxies not to buffer the response.
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.wfile.flush()
            # Two-part priming. First, a comment line — purely human-
            # readable, useful when inspecting the stream with curl or
            # in DevTools' network tab; EventSource itself doesn't fire
            # any event for SSE comments, so this can't disarm the
            # client's first-message timer on its own.
            self.wfile.write(b": ok\n\n")
            # Second, a real (empty) 'data' event. THIS is the actual
            # body-side proof of flushability the client's first-message
            # timer waits for. Buffering proxies hold the body and never
            # let it through (timer fires, fallback to long-poll); a
            # healthy channel delivers it instantly even on a session
            # that has nothing to print yet (idle reconnect, quiet tmux
            # pane, long-running command with no output).
            primer = {
                "data": "",
                "alive": session.alive,
                "auth_failed": session.auth_failed,
            }
            if cursor is not None:
                primer["cursor"] = cursor
            self.wfile.write(
                ("event: data\ndata: " + json.dumps(primer) + "\n\n")
                .encode("utf-8"))
            self.wfile.flush()
            # Connecting to /api/stream is itself proof of user interest in
            # the session. Without this bump, a quiet pane (idle vim, idle
            # tmux) reconnected from a freshly-foregrounded tab can still
            # be reaped by the SESSION_TIMEOUT idle watchdog 5 minutes
            # later, because last_activity hasn't moved since before the
            # browser froze the tab.
            session.last_activity = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

        last_send = time.time()
        KEEPALIVE = 15  # seconds between heartbeats when no real data

        # If wfile.write fails after we've already drained bytes, push
        # them back so the next reader (long-poll fallback or a fresh
        # /api/stream) can deliver them. Without this, every transport
        # switch silently loses whatever was in flight. Detection of a
        # half-closed connection (browser closed EventSource, or the
        # PHP proxy aborted) goes via _client_gone() before each read,
        # which catches the case where the write side hasn't yet
        # noticed the peer's FIN.
        data = b""
        sel = self._build_session_selector(session)
        try:
            while True:
                if self._client_gone():
                    if data and cursor is None:
                        session.unread(data)
                    return
                if _shutting_down:
                    # Drop the connection without 'end': the client sees
                    # a broken stream, the restarted server answers 404,
                    # and the pane re-attaches (tmux) or reconnects. Also
                    # before any read - the PTY teardown's terminal reset
                    # must not reach a screen that is about to resume.
                    return
                if gen is not None and getattr(session, "_stream_gen", 0) != gen:
                    # A newer stream for this session asked for the slot:
                    # this connection is the stale one. Nothing was read
                    # this round, so nothing is lost.
                    return
                extra = {}
                if cursor is None:
                    data = session.read()
                else:
                    data, nxt, lost, reset = session.read_since(cursor)
                    if lost or reset:
                        extra = {"lost": lost, "reset": reset}
                    if not data and not extra:
                        nxt = cursor
                if data or extra:
                    body = {
                        "data": base64.b64encode(data).decode("ascii"),
                        "alive": session.alive,
                        "auth_failed": session.auth_failed,
                    }
                    head = "event: data\n"
                    if cursor is not None:
                        body["cursor"] = nxt
                        body.update(extra)
                        # EventSource sends this back as Last-Event-ID on
                        # its automatic reconnect.
                        head = "id: {}\n".format(nxt) + head
                        cursor = nxt
                    self.wfile.write(
                        (head + "data: " + json.dumps(body) + "\n\n")
                        .encode("utf-8"))
                    self.wfile.flush()
                    last_send = time.time()
                    data = b""  # delivered — no need to push back on error
                    # Loop back to drain any further bytes the PTY
                    # produced while we were writing.
                    continue
                if not session.alive:
                    break
                # No data and session still alive: send keepalive if
                # we've been silent for too long, then park on the
                # cached client-socket selector and the data Event
                # until either the PTY produces more bytes (Event
                # signalled by _read_loop), the peer closes (FIN ->
                # client socket readable), or the keepalive deadline
                # arrives. This replaces the previous 100 Hz
                # time.sleep(POLL_INTERVAL) busy-poll.
                now = time.time()
                if now - last_send > KEEPALIVE:
                    # The comment keeps proxies from idling the stream
                    # out; the named event is what the CLIENT can see
                    # (EventSource hides comments) - its watchdog restarts
                    # a stream that has gone silent. Older clients have
                    # no listener for it and ignore it.
                    self.wfile.write(
                        b": keepalive\n\nevent: ping\ndata: {}\n\n")
                    self.wfile.flush()
                    last_send = now
                next_keepalive = last_send + KEEPALIVE
                timeout = max(0.0, next_keepalive - time.time())
                session.wait_for_data(self.connection, timeout,
                                      selector=sel)

            if _shutting_down:
                return      # see the check at the top of the loop
            # Drain any remaining buffered output before sending 'end'.
            head = "event: data\n"
            tbody = {"alive": False, "auth_failed": session.auth_failed}
            if cursor is None:
                tail = session.read()
            else:
                tail, nxt, lost, reset = session.read_since(cursor)
                tbody["cursor"] = nxt
                if lost or reset:
                    tbody.update({"lost": lost, "reset": reset})
                head = "id: {}\n".format(nxt) + head
            if tail:
                tbody["data"] = base64.b64encode(tail).decode("ascii")
                payload = json.dumps(tbody)
                try:
                    self.wfile.write(
                        (head + "data: " + payload + "\n\n")
                        .encode("utf-8"))
                    # Flush before the closing 'end' so a write failure
                    # on a buffered wfile (Python's default makefile in
                    # some setups) is attributable to *this* payload —
                    # we can unread() the right bytes.
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    if cursor is None:
                        session.unread(tail)
                    return
            end_payload = json.dumps({
                "alive": False,
                "auth_failed": session.auth_failed,
            })
            self.wfile.write(
                ("event: end\ndata: " + end_payload + "\n\n")
                .encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            # Client went away — give back any bytes we drained but
            # didn't manage to deliver (legacy readers only: a cursor
            # reader simply asks again from its own cursor).
            if data and cursor is None:
                session.unread(data)
            return
        finally:
            try:
                sel.close()
            except Exception:
                pass

    def _resize(self):
        body = self._json_body()
        if body is None:
            return

        sid = body.get("session_id", "")
        session = self._require_session(sid)
        if session is None:
            return

        cols = clamp(body.get("cols"), MIN_COLS, MAX_COLS, 80)
        rows = clamp(body.get("rows"), MIN_ROWS, MAX_ROWS, 24)
        session.resize(cols, rows)
        self._json({"ok": True})

    # ── Tmux endpoints (capture / options) ──────────────────────────

    def _tmux_capture(self):
        """GET /api/tmux_capture?session_id=...
        Returns the full tmux pane buffer as text/plain; only valid for
        persistent sessions."""
        if self._side_channel_throttled():
            return
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]
        session = self._require_session(sid)
        if session is None:
            return
        data, err = session.tmux_capture()
        if err:
            self._json({"error": err}, 502)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _tmux_options(self):
        """POST /api/tmux_options — push tmux options live into a
        running persistent session via the ControlMaster side-channel.
        Body shape mirrors /api/connect: tmux_set_clipboard /
        tmux_history_limit. Anything else is silently ignored by the
        same allow-list used at connect time."""
        if self._side_channel_throttled():
            return
        body = self._json_body()
        if body is None:
            return
        sid = body.get("session_id", "")
        session = self._require_session(sid)
        if session is None:
            return
        opts = _validate_tmux_options(body)
        ok, err = session.push_tmux_options(opts)
        if not ok:
            self._json({"error": err}, 502)
            return
        self._json({"ok": True, "applied": [k for k, _ in opts]})

    # ── File transfer endpoints (upload / ls / download) ────────────

    def _upload(self):
        """POST /api/upload?session_id=...&path=<rel_name>
        Body = raw file bytes. The file lands at $HOME/<rel_name> on the
        remote host through the ControlMaster side-channel (binary, no
        PTY, no base64). Path is interpreted relative to $HOME so the
        client can't escape the user's account; we still reject `..`."""
        if self._side_channel_throttled():
            return
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]
        rel_path = params.get("path", [""])[0]

        # Order matters (and is pinned by the dispatch tests): sid shape,
        # then path/size validation, then registry existence — so a bad
        # request is called out as bad even when the session is long gone.
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        if _bad_rel_path(rel_path):
            # NUL would survive base64 encoding but bash strips it from
            # variable values, so the file would silently land at a
            # different name than the client asked for. Fail loud instead.
            self._json({"error": "invalid path"}, 400)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._json({"error": "empty body"}, 400)
            return
        # `offset`: this body is one piece of the file, to be appended at
        # that position (see SSHSession.upload_file). Pieces are how an
        # upload survives a network that cuts long or large requests - a
        # corporate proxy, a VPN - and how a dropped piece is retried
        # without resending the file.
        offset = None
        raw_off = params.get("offset", [None])[0]
        if raw_off is not None:
            try:
                offset = int(raw_off)
            except ValueError:
                offset = -1
            if offset < 0 or offset > MAX_UPLOAD_SIZE:
                self._json({"error": "invalid offset"}, 400)
                return
        if length + (offset or 0) > MAX_UPLOAD_SIZE:
            self._json({"error": "file too large"}, 413)
            return

        session = self._require_session(sid)
        if session is None:
            return

        ok, err = session.upload_file(rel_path, self.rfile, length,
                                      offset=offset)
        host_for_log = getattr(session, "_host", "")
        if not ok and err.startswith("offset mismatch size="):
            # Not a failure of this request: the client resumes from the
            # size the remote file really has.
            self._json({"error": "offset mismatch",
                        "size": int(err.rsplit("=", 1)[1])}, 409)
            return
        if not ok:
            _log("WARN", "upload failed sid={} path={} err={}".format(
                sid, rel_path, err))
            _access_log_emit("upload", self._client_ip(), sid=sid,
                             target_host=host_for_log, path=rel_path,
                             bytes=length, result="error", error=err)
            self._json({"error": err}, 502)
            return
        session.last_activity = time.time()
        # Audit the transfer (see the matching download emit) so files
        # pushed in through a logged-in session are visible to the access
        # log. The path is sanitized + capped by the access-log layer.
        _access_log_emit("upload", self._client_ip(), sid=sid,
                         target_host=host_for_log, path=rel_path,
                         bytes=length, result="ok")
        reply = {"ok": True, "bytes": length, "path": "$HOME/" + rel_path}
        if offset is not None:
            reply["size"] = offset + length
        self._json(reply)

    def _upload_finalize(self):
        """POST /api/upload_finalize — for persistent sessions, move
        an already-uploaded $HOME/<tmp> file into the foreground tmux
        pane's cwd via the ControlMaster side-channel. Side-channel
        only, no foreground keystrokes — safe regardless of what app
        is in front (vim/less/htop/TUI). Returns the final absolute
        path on success, or `non-persistent` so the client knows to
        fall back to its own foreground-mv path.

        With an explicit `dir` (an absolute remote path — the directory
        the file browser is showing) the file lands there instead, and
        the move works for non-persistent sessions too: naming the
        destination removes the only thing tmux was needed for. It grants
        no new access — the same user could `mv` there from the shell.

        Body: { session_id, tmp, final, dir? }."""
        if self._side_channel_throttled():
            return
        body = self._json_body()
        if body is None:
            return
        sid = body.get("session_id", "")
        tmp = body.get("tmp", "")
        final = body.get("final", "")
        dest_dir = body.get("dir", None)
        # Order pinned by the dispatch tests: sid shape, then tmp/final
        # validation, then registry existence.
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        # tmp uses the same rules as the upload path. final is a basename
        # — no slashes, no traversal, no NUL — because finalize_upload
        # cd's into the pane cwd and does `mv -- "$HOME/$t" "./$f"`.
        if _bad_rel_path(tmp):
            self._json({"error": "invalid tmp"}, 400)
            return
        if (not final or len(final) > 4096
                or "/" in final or "\x00" in final or final in ("..", ".")):
            self._json({"error": "invalid final"}, 400)
            return
        # Same rules as rm/mkdir/mv: absolute, no NUL, not bare "/"-padding.
        # A non-string (or a relative path) is a client bug, not a request
        # to fall back to the pane's cwd - reject it rather than guess.
        if dest_dir is not None and self._bad_dest_dir(dest_dir):
            self._json({"error": "invalid dir"}, 400)
            return
        session = self._require_session(sid)
        if session is None:
            return
        ok, msg = session.finalize_upload(tmp, final, dest_dir)
        if not ok:
            # `non-persistent` is an expected, non-error outcome —
            # surface it with 200 so the client can branch cleanly
            # without inspecting an error string.
            if msg == "non-persistent":
                self._json({"ok": False, "non_persistent": True})
                return
            _access_log_emit("upload_place", self._client_ip(), sid=sid,
                             target_host=getattr(session, "_host", ""),
                             path=dest_dir or "", result="error", error=msg)
            self._json({"error": msg}, _side_channel_status(msg))
            return
        session.last_activity = time.time()
        # Where the bytes ended up. /api/upload logs the staging name in
        # $HOME; without this the audit trail stopped short of the file's
        # real resting place, which the client now gets to choose.
        _access_log_emit("upload_place", self._client_ip(), sid=sid,
                         target_host=getattr(session, "_host", ""),
                         path=msg, result="ok")
        self._json({"ok": True, "path": msg})

    def _upload_cancel(self):
        """POST /api/upload_cancel — best-effort cleanup of a partial
        / staged upload. Removes $HOME/<tmp> via the ControlMaster
        side-channel (keystroke-free, so no risk of poking a running
        editor). Idempotent.

        Body: { session_id, tmp }."""
        if self._side_channel_throttled():
            return
        body = self._json_body()
        if body is None:
            return
        sid = body.get("session_id", "")
        tmp = body.get("tmp", "")
        # Order pinned by the dispatch tests: sid shape, then tmp
        # validation, then registry existence.
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        if _bad_rel_path(tmp):
            self._json({"error": "invalid tmp"}, 400)
            return
        session = self._require_session(sid)
        if session is None:
            return
        ok, err = session.remove_remote_tmp(tmp)
        if not ok:
            self._json({"error": err}, 502)
            return
        self._json({"ok": True})

    def _ls(self):
        """GET /api/ls?session_id=<sid>&path=<path>[&cwd=1]
        List a remote directory via ControlMaster. path defaults to ~.
        cwd=1 ignores path and starts from the pane's working directory
        (tmux-backed sessions; $HOME elsewhere)."""
        if self._side_channel_throttled():
            return
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]
        path = params.get("path", ["~"])[0] or "~"
        pane_cwd = params.get("cwd", [""])[0] == "1"

        if "\x00" in path:
            self._json({"error": "invalid path"}, 400)
            return
        session = self._require_session(sid)
        if session is None:
            return

        entries, abs_path, err = session.list_dir(path, pane_cwd=pane_cwd)
        if err:
            self._json({"error": err}, 502)
            return
        session.last_activity = time.time()
        self._json({"path": abs_path, "entries": entries})

    def _rm(self):
        """POST /api/rm {session_id, path}
        Delete one remote file, symlink, or empty directory via
        ControlMaster. Non-recursive — see SSHSession.remove_path."""
        if self._side_channel_throttled():
            return
        body = self._json_body()
        if body is None:
            return
        sid = body.get("session_id", "")
        path = body.get("path", "")

        # Absolute-only: the file browser always has a resolved path, and
        # refusing everything else keeps this endpoint from quietly
        # deleting a $HOME-relative name the caller didn't mean.
        if self._bad_abs_path(path):
            self._json({"error": "invalid path"}, 400)
            return
        if self._refuse_undecodable(path):
            return
        session = self._require_session(sid)
        if session is None:
            return

        ok, err = session.remove_path(path)
        gone = ok and err == "already gone"
        # Audited like upload/download: a keystroke-free delete appears in
        # neither the session recording nor the scrollback, so the access
        # log is the only place it can ever be seen.
        _access_log_emit("rm", self._client_ip(), sid=sid,
                         target_host=getattr(session, "_host", ""),
                         path=path,
                         result=("already_gone" if gone else
                                 "ok" if ok else "error"),
                         **({} if ok else {"error": err}))
        if not ok:
            self._json({"error": err}, _side_channel_status(err))
            return
        session.last_activity = time.time()
        self._json({"ok": True, "already_gone": True} if gone else {"ok": True})

    def _refuse_undecodable(self, path):
        """list_dir decodes remote names that are not valid UTF-8 with
        U+FFFD replacements, so such a row can never name its file again:
        a delete used to find nothing and report "already deleted" with
        the file still there, rename said 404, download "not found". Say
        what is actually wrong instead. Returns True when refused."""
        if isinstance(path, str) and "\ufffd" in path:
            self._json({"error": "this name is not valid UTF-8 and cannot "
                        "be handled here - use the terminal",
                        "code": "undecodable_name"}, 400)
            return True
        return False

    @staticmethod
    def _bad_abs_path(path):
        """True when `path` is not usable as an absolute remote path.
        Shared by the mutating side-channel endpoints (rm/mkdir/mv). The
        bare-root rule stops an rm/mv of "/" that could only be a bug."""
        return (not isinstance(path, str) or not path.startswith("/")
                or "\x00" in path or path.rstrip("/") == "")

    @staticmethod
    def _bad_dest_dir(path):
        """True when `path` cannot be an upload destination. Unlike
        _bad_abs_path this accepts "/": root's home is a legitimate place
        to put a file, and the browser can show it."""
        return (not isinstance(path, str) or not path.startswith("/")
                or "\x00" in path or len(path) > 4096)

    @staticmethod
    def _bad_name(name):
        """True when `name` is not a usable bare filename. Rejects the
        path separator (so a rename/mkdir can't escape its directory),
        the . / .. specials, NUL, empty, and anything over 255 bytes
        (the ext4/xfs limit — a longer name can only fail remotely)."""
        return (not isinstance(name, str) or name == "" or "/" in name
                or "\x00" in name or name in (".", "..")
                or len(name.encode("utf-8")) > 255)

    def _mkdir(self):
        """POST /api/mkdir {session_id, path}
        Create one directory (non-recursive) via ControlMaster."""
        if self._side_channel_throttled():
            return
        body = self._json_body()
        if body is None:
            return
        sid = body.get("session_id", "")
        path = body.get("path", "")
        # The new directory's own name must be a real name, not . / ..
        if self._bad_abs_path(path) or self._bad_name(path.rstrip("/").rsplit("/", 1)[-1]):
            self._json({"error": "invalid path"}, 400)
            return
        session = self._require_session(sid)
        if session is None:
            return

        ok, err = session.make_dir(path)
        _access_log_emit("mkdir", self._client_ip(), sid=sid,
                         target_host=getattr(session, "_host", ""),
                         path=path, result="ok" if ok else "error",
                         **({} if ok else {"error": err}))
        if not ok:
            self._json({"error": err}, _side_channel_status(err))
            return
        session.last_activity = time.time()
        self._json({"ok": True})

    def _mv(self):
        """POST /api/mv {session_id, path, name}
        Rename `path` to a sibling `name` (same directory) via
        ControlMaster. See SSHSession.rename_entry."""
        if self._side_channel_throttled():
            return
        body = self._json_body()
        if body is None:
            return
        sid = body.get("session_id", "")
        path = body.get("path", "")
        name = body.get("name", "")
        if self._bad_abs_path(path):
            self._json({"error": "invalid path"}, 400)
            return
        if self._refuse_undecodable(path):
            return
        if self._bad_name(name):
            self._json({"error": "invalid name"}, 400)
            return
        session = self._require_session(sid)
        if session is None:
            return

        ok, err = session.rename_entry(path, name)
        _access_log_emit("mv", self._client_ip(), sid=sid,
                         target_host=getattr(session, "_host", ""),
                         path=path, name=name, result="ok" if ok else "error",
                         **({} if ok else {"error": err}))
        if not ok:
            self._json({"error": err}, _side_channel_status(err))
            return
        session.last_activity = time.time()
        self._json({"ok": True})

    def _download(self):
        """GET /api/download?session_id=<sid>&path=<path>
        Stream a file via ControlMaster (binary, no base64)."""
        if self._side_channel_throttled():
            return
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]
        path = params.get("path", [""])[0]

        if not path or "\x00" in path:
            self._json({"error": "invalid path"}, 400)
            return
        if self._refuse_undecodable(path):
            return
        session = self._require_session(sid)
        if session is None:
            return

        proc, err = session.download_file(path)
        if err:
            self._json({"error": err}, 502)
            return

        # Read the protocol header ("OK\t<size>\n" or "ERR\t<msg>\n").
        # Byte-at-a-time on the raw fd, each byte gated by select():
        # Popen's file object would block without bound on a remote
        # that connected but never answers.
        header_line = b""
        try:
            out_fd = proc.stdout.fileno()
            while True:
                if not _wait_fd(out_fd, TRANSFER_IDLE_TIMEOUT):
                    raise TimeoutError("download header timeout")
                c = os.read(out_fd, 1)
                if not c or c == b"\n":
                    break
                header_line += c
                if len(header_line) > 4096:
                    raise ValueError("download header too long")
        except TimeoutError:
            _kill_reap(proc)
            _log("WARN", "download header timeout sid={} path={}".format(
                sid, path))
            self._json({"error": "download timeout"}, 504)
            return
        except Exception:
            _kill_reap(proc)
            self._json({"error": "download failed"}, 502)
            return

        parts = header_line.decode("utf-8", "replace").split("\t", 1)
        if not parts or parts[0] != "OK":
            _kill_reap(proc)
            msg = parts[1].strip() if len(parts) > 1 else "download failed"
            self._json({"error": msg}, 404)
            return

        filename = path.rsplit("/", 1)[-1] or "download"
        safe_name = urllib.parse.quote(filename, safe="")
        content_length = None
        if len(parts) > 1:
            sz_str = parts[1].strip().lstrip("-")
            if sz_str.isdigit():
                sz = int(parts[1].strip())
                if sz >= 0:
                    content_length = sz

        # Hard cap: refuse files above MAX_DOWNLOAD_SIZE before sending
        # any HTTP response headers, so the browser doesn't try to
        # accumulate a multi-GB Blob into memory.
        if content_length is not None and content_length > MAX_DOWNLOAD_SIZE:
            _kill_reap(proc)
            self._json({"error": "file too large"}, 413)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header(
            "Content-Disposition",
            "attachment; filename*=UTF-8''" + safe_name,
        )
        if content_length is not None:
            self.send_header("Content-Length", str(content_length))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        result = "ok"
        try:
            BUF = 256 * 1024
            sent = 0
            while True:
                if not _wait_fd(out_fd, TRANSFER_IDLE_TIMEOUT):
                    _log("WARN", "download stalled {}s, aborting sid={} "
                         "path={}".format(TRANSFER_IDLE_TIMEOUT, sid, path))
                    result = "timeout"
                    proc.kill()
                    break
                chunk = os.read(out_fd, BUF)
                if not chunk:
                    break
                if content_length is not None and sent + len(chunk) > content_length:
                    # The file grew after stat. Bytes past the declared
                    # Content-Length would corrupt the HTTP stream (the
                    # client reads them as the next response); send what
                    # was announced and stop.
                    chunk = chunk[:content_length - sent]
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    sent += len(chunk)
                    proc.kill()
                    break
                sent += len(chunk)
                # Hard ceiling on bytes actually streamed. The upfront 413
                # only fires when stat reported a size; when stat failed
                # (header was "OK\t-1") content_length is None and that
                # check is skipped, and a file that grows after stat (a log
                # being appended, /dev/zero, a fifo) can stream forever and
                # pin this worker. Abort once we cross the cap regardless of
                # whether the size was known — the client gets a truncated
                # download, which is the right outcome for an over-cap file.
                if sent > MAX_DOWNLOAD_SIZE:
                    _log("WARN", "download exceeded MAX_DOWNLOAD_SIZE, "
                         "aborting sid={} path={}".format(sid, path))
                    result = "over_cap"
                    proc.kill()
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                # Multi-GB downloads can outlast SESSION_TIMEOUT; without
                # this stamp the cleanup loop would close the master
                # mid-stream and the side-channel ssh would die with it.
                session.last_activity = time.time()
            # A known size that we did not reach means the remote cut the
            # stream short (or the client left mid-way): not an "ok".
            if result == "ok" and content_length is not None \
                    and sent < content_length:
                result = "partial"
        except Exception:
            # Client went away mid-stream (BrokenPipe) or the pipe died.
            result = "client_gone" if result == "ok" else result
        finally:
            proc.stdout.close()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _kill_reap(proc)
        session.last_activity = time.time()
        # Audit the transfer so bulk exfiltration through a logged-in
        # session is visible to WEBSH_ACCESS_LOG / fail2ban. `bytes` is the
        # count actually streamed (so an over-cap abort is recorded as a
        # partial). The path is sanitized + capped by the access-log layer.
        _access_log_emit("download", self._client_ip(), sid=sid,
                         target_host=getattr(session, "_host", ""),
                         path=path, bytes=sent, result=result)

    # ── Disconnect ──────────────────────────────────────────────────

    def _disconnect(self):
        body = self._json_body()
        if body is None:
            return

        sid = body.get("session_id", "")
        terminate = bool(body.get("terminate", False))
        # Type check first: a list is unhashable and sessions.get() would
        # raise before the lookup even happens. Disconnect is idempotent -
        # an id that names nothing gets the same {"ok": true} as one that
        # was already gone - so something that isn't a string is answered
        # the same way, not as a 500. (Only the type, not the UUID shape:
        # this endpoint looks the key up as-is, and must keep doing so.)
        if not isinstance(sid, str):
            self._json({"ok": True})
            return
        with sessions_lock:
            session = sessions.get(sid)
            if (session is not None and WEBSH_AUTH_HEADER
                    and getattr(session, "owner", "")
                        != self._client_identity()):
                session = None
                forbidden = True
            else:
                forbidden = False
                sessions.pop(sid, None)
        if forbidden:
            _access_log_emit("authz_denied", self._client_ip(),
                             sid=sid, auth_user=self._client_identity())
            self._json({"error": "forbidden"}, 403)
            return
        if session:
            # Snapshot attacker-relevant state up front: if cleanup
            # raises we still want the access-log entry, with `error`
            # set so the failure is observable.
            # SSHSession stores it as `_host`; the prior `"host"` lookup
            # silently fell through to "" so every disconnect record had
            # empty target_host, breaking fail2ban correlation.
            host_for_log = getattr(session, "_host", "")
            err = None
            try:
                if terminate:
                    session.terminate_remote_tmux()
                session.close()
            except Exception as e:
                err = str(e)
            finally:
                fields = {"sid": sid, "terminate": terminate,
                          "target_host": host_for_log,
                          "auth_user": self._client_identity(),
                          "result": "terminated" if terminate else "closed"}
                if err is not None:
                    fields["error"] = err
                    fields["result"] = "close_error"
                _access_log_emit("disconnect", self._client_ip(), **fields)
        self._json({"ok": True})


_BUSY_RESPONSE = (
    b"HTTP/1.1 503 Service Unavailable\r\n"
    b"Content-Type: application/json\r\n"
    b"Content-Length: 17\r\n"
    b"Connection: close\r\n"
    b"\r\n"
    b'{"error":"busy"}\n'
)


class Server(HTTPServer):
    """Threaded HTTP server with a hard cap on concurrent workers.

    Drop-in replacement for socketserver.ThreadingMixIn+HTTPServer. The
    plain mixin spawns a thread per request without limit; under a
    glitchy client that reconnects /api/stream in a tight loop, or a
    coordinated DoS, the thread count would explode before any of the
    session/IP caps trigger.

    We hold a BoundedSemaphore sized to WEBSH_MAX_THREADS (env). The
    semaphore is acquired non-blocking in process_request; if it's
    exhausted the request gets an immediate 503 and the socket is shut
    down — better than queuing, which would create the same back-pressure
    failure mode with a longer fuse. Worker slot is released in a finally
    so a handler exception can't leak it.

    Permit-leak defences:
      - process_request wraps Thread()+start() in try/except so a spawn
        failure (RuntimeError "can't start new thread", MemoryError under
        the OS thread cap) releases the just-acquired permit before
        propagating the error. Without this, repeated spawn failures
        would silently drain capacity to zero — every subsequent request
        would get 503 forever, requiring a restart.
      - _run_under_semaphore makes release() the *last* operation in
        the worker (ordered after shutdown_request) and wraps every
        prior step in its own try/except. Even a misbehaving handler
        or a shutdown_request that throws cannot prevent the permit
        from being returned.
    """

    allow_reuse_address = True
    # listen(2) backlog. socketserver's default is 5, and this server
    # speaks HTTP/1.0 with Connection: close, so every keystroke POST is
    # a fresh TCP connection: with a handful of typists the accept queue
    # overflowed and clients ate 1-3 s SYN-retransmit stalls (measured
    # p99 1.0 s at 32 concurrent connections). The kernel caps this at
    # net.core.somaxconn (4096 on modern Linux, 128 on older ones).
    request_queue_size = 128

    def __init__(self, *args, **kwargs):
        HTTPServer.__init__(self, *args, **kwargs)
        # BoundedSemaphore (not plain Semaphore) so an over-release would
        # raise instead of silently inflating capacity — defends against
        # a refactor accidentally double-releasing on the error path.
        self._req_sem = BoundedSemaphore(MAX_THREADS)

    def process_request(self, request, client_address):
        if not self._req_sem.acquire(blocking=False):
            # The 503 is written here on the accept thread (no worker
            # was spawned). A misbehaving peer that holds its TCP recv
            # window at zero would otherwise pin the accept thread on
            # sendall — single-client slowloris on the busy path.
            # 2 s is short enough that one stuck peer doesn't starve
            # accept and long enough that any healthy client's kernel
            # buffer absorbs the 80 B body well before timeout.
            try:
                request.settimeout(2.0)
            except OSError:
                pass
            try:
                request.sendall(_BUSY_RESPONSE)
            except OSError:
                # Client already gone, or settimeout fired — nothing
                # to report. Both branches end with shutdown_request
                # below; the permit was never taken on this path.
                pass
            self.shutdown_request(request)
            return
        try:
            t = Thread(target=self._run_under_semaphore,
                       args=(request, client_address),
                       daemon=True)
            t.start()
        except BaseException:
            # Thread() construction or .start() failed (OS thread cap,
            # MemoryError, …). Return the permit, close the socket,
            # then re-raise so BaseServer.handle_error can log via the
            # normal path. Without this, the permit would leak and
            # repeated failures would drain capacity to permanent 503.
            self._req_sem.release()
            try:
                self.shutdown_request(request)
            except Exception:
                pass
            raise

    def _run_under_semaphore(self, request, client_address):
        # release() must always run, even if every other step throws.
        # That means: each prior step is in its own try/except, and the
        # release sits in an outer finally so it executes last and
        # unconditionally. handle_error is wrapped too in case stderr
        # itself is unhappy (full disk, closed fd).
        try:
            try:
                self.finish_request(request, client_address)
            except Exception:
                try:
                    self.handle_error(request, client_address)
                except Exception:
                    pass
            try:
                self.shutdown_request(request)
            except Exception:
                pass
        finally:
            self._req_sem.release()


class UnixServer(Server):
    """Server on a Unix socket (WEBSH_SOCKET) instead of loopback TCP.

    On shared hosting every account shares 127.0.0.1: any co-tenant
    could reach a TCP backend directly, past the web server's auth, and
    use the server-side connections in websh.json — or take the port
    while the backend is down and receive the credentials api.php
    forwards. The socket file is created 0600, so only the websh
    account can connect to it; living in that account's directory, only
    that account can create it.
    """

    address_family = socket.AF_UNIX
    # SO_REUSE* mean nothing for a path; stale files are handled below.
    allow_reuse_address = False
    allow_reuse_port = False
    # Set once bind() succeeds; socketserver calls server_close() on a
    # failed bind too, and that must not unlink someone else's file.
    _sock_ino = None

    def server_bind(self):
        self.server_address = _check_socket_dir(self.server_address)
        _clear_stale_socket(self.server_address)
        # umask instead of a chmod after bind(): no window where the
        # socket exists with looser permissions.
        old = os.umask(0o177)
        try:
            # HTTPServer.server_bind would getfqdn() a (host, port) pair.
            socketserver.TCPServer.server_bind(self)
        finally:
            os.umask(old)
        self._sock_ino = os.lstat(self.server_address).st_ino
        self.server_name = "localhost"
        self.server_port = 0

    def server_close(self):
        Server.server_close(self)
        try:
            # Only our own file — never a socket a newer backend bound.
            if os.lstat(self.server_address).st_ino == self._sock_ino:
                os.unlink(self.server_address)
        except OSError:
            pass


def _check_socket_dir(path):
    """Validate the resolved directory chain and return the path to use.

    A private leaf in a renameable ancestor can be swapped just like a
    writable leaf. Resolve aliases once and bind the returned path, so
    an alias in an untrusted directory cannot redirect the later bind.
    """
    d = os.path.realpath(os.path.dirname(path) or os.curdir)
    resolved = os.path.join(d, os.path.basename(path))
    if len(os.fsencode(resolved)) > 107:
        raise OSError(errno.ENAMETOOLONG, "WEBSH_SOCKET path is too long")
    uid = os.geteuid()
    st = os.stat(d)
    if st.st_uid != uid or st.st_mode & 0o022:
        raise OSError(errno.EPERM, "WEBSH_SOCKET directory {} must belong to "
                      "this user and be writable only by it".format(d))
    current = d
    while True:
        st = os.stat(current)
        sticky_root = st.st_uid == 0 and st.st_mode & stat.S_ISVTX
        if st.st_uid not in (0, uid) or (st.st_mode & 0o022 and not sticky_root):
            raise OSError(errno.EPERM, "WEBSH_SOCKET ancestor directory {} "
                          "is not protected from other users".format(current))
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return resolved


def _clear_stale_socket(path):
    """Unlink a socket file left by a backend that died without cleaning
    up, so bind() does not fail with EADDRINUSE. Anything that is not a
    socket, or a socket that still accepts connections, is left alone."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISSOCK(st.st_mode):
        if st.st_uid != os.geteuid():
            raise OSError(errno.EPERM, "WEBSH_SOCKET belongs to another user")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        # A full backlog (wedged backend) blocks connect(); count it as
        # in use rather than hang every auto-start attempt.
        probe.settimeout(1)
        try:
            probe.connect(path)
        except ConnectionRefusedError:
            # Another starter may have replaced the stale file while
            # our probe ran. Never unlink its newly bound socket.
            now = os.lstat(path)
            if (now.st_dev, now.st_ino) == (st.st_dev, st.st_ino):
                os.unlink(path)
                return
            raise OSError(errno.EADDRINUSE, "WEBSH_SOCKET changed during startup")
        except OSError:
            pass
        finally:
            probe.close()
    raise OSError(errno.EADDRINUSE,
                  "WEBSH_SOCKET {} is in use or not a socket".format(path))


def _warn_ignored_server_knobs():
    """One WARN per websh.json "server" key that cannot take effect:
    env-only knobs (security: the JSON plane must not flip them) and
    names no knob reads (typos). Silence here cost an operator their
    authentication once."""
    for key in sorted(_SERVER_KNOBS):
        if key in _ENV_ONLY_KNOBS:
            _log("WARN", "websh.json \"server\".{} is IGNORED: this knob is "
                 "env-only (see docs/configuration.md)".format(key))
        elif key not in _KNOWN_KNOBS:
            _log("WARN", "websh.json \"server\".{} is IGNORED: no such "
                 "knob".format(key))


def _warn_per_ip_misconfig():
    """Emit a WARN when MAX_SESSIONS_PER_IP cannot ever trip.

    The per-IP cap only matters when it is strictly tighter than the
    global caps. If it is set to (or above) max(MAX_SESSIONS,
    MAX_BG_SESSIONS), a single IP exhausting the global pool already
    hits the global 429 first — the per-IP gate becomes dead code and
    the operator is paying the inventory cost (the iteration in
    _per_ip_session_count, the per-session client_ip attribute) for
    no benefit. Most likely they intended a smaller value and should
    lower it.

    Module-level WARN lets a one-time misconfiguration surface at
    startup; we deliberately avoid raising or refusing to start since
    the existing default (0 = disabled) and any positive value short of
    the threshold are valid configurations.
    """
    if MAX_SESSIONS_PER_IP <= 0:
        return
    threshold = max(MAX_SESSIONS, MAX_BG_SESSIONS)
    if MAX_SESSIONS_PER_IP >= threshold:
        _log("WARN", ("MAX_SESSIONS_PER_IP={} is >= max(MAX_SESSIONS={}, "
                      "MAX_BG_SESSIONS={}); the per-IP cap will never "
                      "trip — a single client hits the global cap first. "
                      "Lower MAX_SESSIONS_PER_IP to take effect.").format(
            MAX_SESSIONS_PER_IP, MAX_SESSIONS, MAX_BG_SESSIONS))


def _warn_max_threads_misconfig():
    """Emit a WARN when MAX_THREADS is so low it cannot serve the
    configured session caps.

    Each persistent SSE worker holds one permit for the lifetime of
    the stream (sessions can live for hours). If MAX_THREADS is at
    or below the total session ceiling, a real workload can drain
    every permit into long-running streams and leave nothing for
    short requests — including /api/disconnect, locking the operator
    out of cleanup without a restart.

    The threshold here (2 × (MAX_SESSIONS + MAX_BG_SESSIONS)) leaves
    one streaming slot plus one short-request slot per planned
    session, plus the +64 headroom baked into the default. Crossing
    below it is almost always a typo; raising it is harmless.
    """
    threshold = 2 * (MAX_SESSIONS + MAX_BG_SESSIONS)
    if MAX_THREADS < threshold:
        _log("WARN", ("MAX_THREADS={} is below 2 * (MAX_SESSIONS={} + "
                      "MAX_BG_SESSIONS={}) = {}. Each long-running SSE "
                      "worker pins one permit; once {} sessions are "
                      "streaming, every remaining request — including "
                      "/api/disconnect — will 503. Raise MAX_THREADS "
                      "or lower the session caps.").format(
            MAX_THREADS, MAX_SESSIONS, MAX_BG_SESSIONS, threshold,
            MAX_THREADS))


# Set when the server is going down (deploy, systemctl restart). Sessions
# then die only because websh restarts, not because the remote shell
# exited: stream and long-poll readers must not report that as the end of
# the session, or every pane - persistent ones included, whose tmux lives
# on - sits at "Disconnected" after each deploy. See _stream_session/_output.
_shutting_down = False


def _close_all_sessions():
    """Snapshot the session registry under the lock, clear it, then close
    each session OUTSIDE the lock — close() runs SIGTERM/WNOHANG/SIGKILL/
    waitpid, and holding sessions_lock across that batch would stall every
    lock-taking endpoint (same rationale as cleanup()). One wedged teardown
    is isolated so it can't skip the rest. Used by the shutdown path."""
    with sessions_lock:
        victims = list(sessions.values())
        sessions.clear()
    for s in victims:
        try:
            s.close()
        except Exception as e:
            _log("WARN", "shutdown: session {} close failed: {}".format(
                getattr(s, "id", "?"), e))


def main():
    # Header-trust auth and the credential vault are mutually exclusive for
    # now. The vault is keyed by a client-supplied vault_id, NOT by the
    # authenticated identity (see _save_credential / _delete_credential), so
    # with WEBSH_AUTH_HEADER on any authenticated user could enumerate or
    # delete another user's vault entries (host/user/port metadata; the
    # secret itself stays passphrase-protected client-side). Until the vault
    # is scoped per identity, refuse to start the unsafe combination loudly
    # rather than ship a silent cross-user data path.
    if WEBSH_AUTH_HEADER and WEBSH_VAULT_ENABLE:
        _log("ERROR",
             "refusing to start: WEBSH_AUTH_HEADER and WEBSH_VAULT_ENABLE are "
             "both set, but the vault is keyed by client-supplied vault_id, "
             "not by identity — an authenticated user could reach another "
             "user's vault entries. Disable one until the vault is per-user.")
        raise SystemExit(1)
    # Load websh.json once BEFORE binding so a WEBSH_REQUIRE_VAULT
    # rejection is a startup failure the operator sees in `systemctl
    # status`, not a per-request failure behind a green /api/ping.
    load_config()
    if _config_rejected:
        _log("ERROR", "refusing to start: " + _config_rejected)
        raise SystemExit(1)
    if _config_unusable and _config_unusable != "file not found":
        # A config that is named but can't be loaded at startup has no
        # earlier good version to fall back on: say so loudly instead of
        # serving a locked (or, before, a wide-open) proxy.
        _log("ERROR", "refusing to start: WEBSH_CONFIG={} is unusable: {}".format(
            os.environ.get("WEBSH_CONFIG", ""), _config_unusable))
        raise SystemExit(1)
    _warn_ignored_server_knobs()
    _warn_per_ip_misconfig()
    _warn_max_threads_misconfig()
    # Start background cleanup thread
    t = Thread(target=_cleanup_loop, daemon=True)
    t.start()

    where = "unix:" + WEBSH_SOCKET if WEBSH_SOCKET else "{}:{}".format(HOST, PORT)
    try:
        if WEBSH_SOCKET:
            server = UnixServer(WEBSH_SOCKET, Handler)
            where = "unix:" + server.server_address
        else:
            server = Server((HOST, PORT), Handler)
            where = "http://{}:{}".format(HOST, PORT)
    except OSError as e:
        # Preserve a useful startup failure for TCP and Unix sockets.
        _log("ERROR", "cannot bind {}: {}".format(where, e))
        raise SystemExit(1)
    # WEBSH_ACCESS_LOG is a security control: a log that silently is not
    # written is worse than a server that refuses to start. Prove the
    # path is writable now rather than WARN on every event later.
    if ACCESS_LOG_PATH:
        try:
            fd = os.open(ACCESS_LOG_PATH,
                         os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
            os.close(fd)
        except OSError as e:
            _log("ERROR", "refusing to start: WEBSH_ACCESS_LOG={} is not "
                 "writable: {} (under the bundled systemd unit, put it "
                 "under /var/log/websh*)".format(ACCESS_LOG_PATH, e))
            raise SystemExit(1)

    stop_event = Event()

    def _request_stop(signum, frame):
        # Signal handlers run on the main thread. Do the MINIMUM that is
        # safe here — just wake main(). The real teardown (session close(),
        # which runs kill/waitpid/sleep, and server.shutdown(), which MUST
        # run on a thread other than serve_forever() or it self-deadlocks)
        # happens back on the main thread below. The previous version called
        # server.shutdown() directly from here, i.e. from inside the
        # serve_forever() thread, which blocked forever waiting for that same
        # loop to acknowledge the stop — the process only died at the systemd
        # stop-timeout via SIGKILL.
        stop_event.set()

    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    # serve_forever() on a daemon thread so the signal handler can return
    # immediately and main() can call server.shutdown() from here — a
    # DIFFERENT thread than the serve loop, which is what BaseServer.shutdown()
    # requires. daemon=True so a wedged accept loop can never block interpreter
    # exit.
    serve_thread = Thread(target=server.serve_forever, daemon=True)
    serve_thread.start()

    _log("INFO", "websh v{} listening on {}".format(__version__, where))
    if ACCESS_LOG_PATH:
        _log("INFO", "access log: {}".format(ACCESS_LOG_PATH))
    if not HAS_CRYPTOGRAPHY:
        _log("INFO", "credential vault: disabled (install cryptography to enable)")
    elif not WEBSH_VAULT_ENABLE:
        _log("INFO", "credential vault: disabled (set WEBSH_VAULT_ENABLE=1 to opt in)")
    else:
        _log("INFO", "credential vault: enabled")
    if _WEBSH_RECORD_INPUT_REQUESTED:
        _log("WARN", "WEBSH_RECORD_INPUT is set but IGNORED: keystroke/input "
                     "recording is hard-disabled (recording is output-only). "
                     "Unset it to silence this warning.")

    stop_event.wait()
    _log("INFO", "shutting down")
    global _shutting_down
    _shutting_down = True
    _close_all_sessions()
    server.shutdown()
    server.server_close()


if __name__ == "__main__":
    main()
