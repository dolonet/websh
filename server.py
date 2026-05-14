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
import fcntl
import ipaddress
import json
import os
import pty
import re
import select
import selectors
import signal
import socket
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

# Operator opt-in until the client-side PR (PR-C) lands. Default off
# so a server upgrade does not advertise endpoints the bundled client
# does not know how to call. Will become the default once PR-C ships.
WEBSH_VAULT_ENABLE = os.environ.get("WEBSH_VAULT_ENABLE") == "1"

# Operator opt-in to the future v1.0.0 default. With this set, any
# plaintext credential in websh.json blocks startup with an actionable
# message. Without it, plaintext still works and emits a WARN once.
WEBSH_REQUIRE_VAULT = os.environ.get("WEBSH_REQUIRE_VAULT") == "1"

# Runtime trap: flipped True when the on-disk creds file is unreadable
# (unsupported schema version, etc) to refuse-to-write rather than
# silently overwrite. Cleared only by process restart.
_vault_disabled = False

__version__ = "0.2.0"

# socket.MSG_DONTWAIT is Unix-only (Linux/BSD/macOS). On platforms that
# don't define it (Windows, some embedded), Handler._client_gone() falls
# back to setblocking() around a plain MSG_PEEK. Both yield the same
# observable behaviour; the flag avoids an AttributeError at import time.
_HAVE_MSG_DONTWAIT = hasattr(socket, "MSG_DONTWAIT")

# ─── Configuration ───────────────────────────────────────────────────

def _int_env(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return int(default)

PORT = _int_env("PORT", "8765")
HOST = os.environ.get("HOST", "127.0.0.1")
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
RATE_LIMIT_WINDOW = _int_env("RATE_LIMIT_WINDOW", "60")    # seconds
RATE_LIMIT_MAX = _int_env("RATE_LIMIT_MAX", "50")          # max connect attempts per IP per window

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
    attach = (tmux_cmd + " new-session -A -D -s " + tname
              + ' -- "$SHELL" -l \\; set -g mouse on'
              + ' \\; set -g status off')
    # Per-connect tmux options. Tuples are pre-validated against an
    # allow-list (see _validate_tmux_options) so direct interpolation
    # below is shell- and tmux-injection-safe. `\;` chains commands in
    # the same tmux invocation so options apply to the global server
    # state regardless of whether the session was newly created or
    # re-attached via -A.
    for opt, val in (tmux_options or ()):
        attach += " \\; set -g " + opt + " " + val
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
        except (TypeError, ValueError):
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


ACCESS_LOG_PATH = _resolve_log_path(os.environ.get("WEBSH_ACCESS_LOG"))

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
    """Successful connect from `ip` clears its scan-pattern state.

    Called from the success path. The asymmetry — only deny_blocked
    accumulates, only ok forgives — is what makes the heuristic safe:
    real users always have ok events; pure scanners never do.
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
_CONFIG_EMPTY = {"connections": [], "restrict_hosts": False,
                 "isolate_storage": False,
                 "denied_host_set": frozenset(),
                 "denied_net_list": ()}


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
            host_set.add(s.lower())
    return frozenset(host_set), tuple(net_list)


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
    hl = h.strip().lower()
    if hl in host_set:
        return True, "hostname on deny-list"
    if not net_list:
        return False, None
    # h already stripped of [...]; _resolve_host_ips re-normalises but is
    # idempotent so this is fine.
    for ip in _resolve_host_ips(h):
        for net in net_list:
            if ip in net:
                return True, "{} resolves to {} which is in denied range {}".format(
                    host, ip, net)
    return False, None


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
                _log("ERROR", msg)
                raise SystemExit(1)
            _log("WARN", msg)

        denied_host_set, denied_net_list = _parse_denied_hosts(
            cfg.get("denied_hosts"))
        result = {
            "connections": conns,
            "restrict_hosts": bool(cfg.get("restrict_hosts", False)),
            "isolate_storage": bool(cfg.get("isolate_storage", False)),
            "denied_host_set": denied_host_set,
            "denied_net_list": denied_net_list,
        }
        _config_cache = result
        _config_mtime = mtime
        return result
    except Exception as e:
        _log("WARN", "failed to load config: {}".format(e))
        return _CONFIG_EMPTY


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
# REJECTED inside vault-stored ssh_options: a browser-side write to the
# vault could otherwise point ssh at an arbitrary file path and use the
# ssh parse-error timing as a read-oracle for files readable by the
# websh uid. Operator-managed websh.json is the trusted source for
# file-path options.
_VAULT_DENY_SSH_OPTIONS = frozenset({"identityfile"})


def _creds_path():
    """Path to websh.creds.json.

    Honors WEBSH_CREDS_PATH explicitly; otherwise sits next to
    WEBSH_CONFIG when set, else cwd.
    """
    env = os.environ.get("WEBSH_CREDS_PATH", "").strip()
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
    global _creds_cache, _creds_cache_key, _vault_disabled
    path = _creds_path()
    if not os.path.isfile(path):
        return dict(_CREDS_EMPTY, vaults={})
    try:
        st = os.stat(path)
        key = (st.st_mtime, st.st_size)
        if _creds_cache is not None and key == _creds_cache_key:
            return _creds_cache
        with open(path, "r") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        _log("WARN", "failed to load creds: {}".format(e))
        return dict(_CREDS_EMPTY, vaults={})
    if not isinstance(data, dict):
        # Operator typo or partial write from an external tool produced
        # a JSON array/string/number at the root. Treat as empty store.
        _log("WARN", "creds file {}: root is not an object; "
             "treating as empty".format(path))
        return dict(_CREDS_EMPTY, vaults={})
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
        _log("WARN", "creds file {}: missing or non-object 'vaults'; "
             "treating as empty".format(path))
        return dict(_CREDS_EMPTY, vaults={})
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


def _decrypt_credential(key_bytes, iv_b64, ct_b64, vault_id, conn_id):
    """Decrypt one stored blob.

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
    aad = ("{}:{}".format(vault_id, conn_id)).encode("utf-8")
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
    return {
        "connections": safe,
        "restrict_hosts": cfg["restrict_hosts"],
        "isolate_storage": cfg.get("isolate_storage", False),
        "session_timeout": SESSION_TIMEOUT,
        "version": __version__,
        "vault_enabled": HAS_CRYPTOGRAPHY and WEBSH_VAULT_ENABLE and not _vault_disabled,
    }


def find_config_connection(name):
    """Find a connection by name in config. Returns full entry with secrets."""
    cfg = load_config()
    for c in cfg["connections"]:
        if c.get("name", "") == name:
            return c
    return None


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
# Reentrant so handlers can do `with _creds_lock: ... _save_creds_atomic(...)`.
# _save_creds_atomic reacquires the same lock internally; without RLock that
# self-acquisition would deadlock.
_creds_lock = RLock()


class SSHSession(object):
    """Manages a single SSH connection via PTY subprocess."""

    # ── Init / spawn ────────────────────────────────────────────────

    # Class-level defaults so `SSHSession.__new__(SSHSession)` (used by
    # tests that bypass __init__) still has these attributes — _signal()
    # reads them and would AttributeError on a stripped instance.
    _data_event = None
    _stream_active = False
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
        self.buf_lock = Lock()
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

        # ControlMaster on every session: the master ssh owns this socket,
        # later `ssh -S <sock> <host> ...` invocations piggyback on the
        # same authenticated channel (tmux kill-session for persistent;
        # binary file uploads for any session). ControlPersist=no ties the
        # socket lifetime to the master so no orphaned masters survive.
        # Placed before user ssh_options so our values win (ssh uses
        # first-wins semantics for -o).
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
                try:
                    r, _, _ = select.select([self.master_fd], [], [], 0.05)
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
                            self._signal()
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
                    self._signal()

                # Check if child exited
                try:
                    pid, status = os.waitpid(self.pid, os.WNOHANG)
                    if pid != 0:
                        self._exit_status = status
                        break
                except ChildProcessError:
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
                            with self.buf_lock:
                                self.output_buf += leftover
                            self._signal()
                        else:
                            break
                    else:
                        break
            except (OSError, ValueError):
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
            # Wake any consumer parked in wait_for_data so it observes
            # alive=False without waiting up to KEEPALIVE_INTERVAL.
            self._signal()

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
        Event.set() does not raise."""
        ev = self._data_event
        if ev is None:
            return
        ev.set()

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

    def write(self, data):
        """Send input to SSH process."""
        if not self.alive:
            return False
        if self.master_fd < 0:
            # No PTY ever attached (or already closed) — treat as dead.
            self.alive = False
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

    def tmux_capture(self):
        """Capture the full tmux pane buffer (scrollback + visible) over
        the ControlMaster channel. Only meaningful for persistent
        sessions — xterm.js can't see tmux's own scrollback. Returns
        (bytes, error)."""
        if not self.persistent or not self.slot_id:
            return None, "not a persistent session"
        if not self._control_path or not os.path.exists(self._control_path):
            return None, "control socket not ready"
        # `-S -` reads from the very start of history, `-J` joins lines that
        # tmux had wrapped to fit the pane width, `-p` prints to stdout.
        # tmux_cmd and slot_id are pre-validated regex-restricted strings,
        # safe to inline.
        tname = "websh-" + self.slot_id
        remote_cmd = (self.tmux_cmd + " capture-pane -p -J -S - -t " + tname)
        ssh_cmd = [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, remote_cmd,
        ]
        try:
            proc = subprocess.run(
                ssh_cmd, capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            return None, "tmux capture timeout"
        except Exception as e:
            return None, "ssh error: " + str(e)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()[:300]
            return None, "tmux exit %d: %s" % (proc.returncode, err)
        return proc.stdout, None

    def push_tmux_options(self, options):
        """Apply per-session tmux options live, without typing into the
        foreground PTY. Runs `tmux set -g …` over the ControlMaster
        side-channel so the change can't bleed into a running editor /
        pager occupying the user's shell. `options` is a list of
        (opt, val) tuples already validated against the same allow-list
        used at connect time. Returns (ok, error)."""
        if not self.persistent or not self.slot_id:
            return False, "not a persistent session"
        if not self._control_path or not os.path.exists(self._control_path):
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
        ssh_cmd = [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, remote_cmd,
        ]
        try:
            proc = subprocess.run(
                ssh_cmd, capture_output=True, timeout=10)
        except subprocess.TimeoutExpired:
            return False, "tmux set timeout"
        except Exception as e:
            return False, "ssh error: " + str(e)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()[:300]
            return False, "tmux exit %d: %s" % (proc.returncode, err)
        return True, ""

    # ── File transfer (ControlMaster side-channel) ──────────────────

    def upload_file(self, rel_path, body_stream, length,
                    timeout=UPLOAD_TIMEOUT):
        """Stream `length` bytes from body_stream into $HOME/<rel_path> on the
        remote host, riding on the existing ControlMaster channel — so no
        re-auth and no PTY overhead. Returns (ok, error)."""
        if not self.alive:
            return False, "session is dead"
        if not self._control_path or not os.path.exists(self._control_path):
            return False, "control socket not ready"

        # rel_path is base64-encoded and decoded inside the remote shell so
        # it can never be parsed as shell metacharacters even if we got it
        # wrong upstream.
        b64name = base64.b64encode(
            rel_path.encode("utf-8")).decode("ascii")
        remote_cmd = (
            'n="$(printf %s ' + b64name + ' | base64 -d)" && '
            'cat > "$HOME/$n"'
        )

        ssh_cmd = [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, remote_cmd,
        ]
        proc = subprocess.Popen(
            ssh_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        BUF = 256 * 1024
        remaining = length
        deadline = time.time() + max(60, timeout)
        try:
            while remaining > 0:
                if time.time() > deadline:
                    raise IOError("upload timeout")
                chunk = body_stream.read(min(BUF, remaining))
                if not chunk:
                    break
                proc.stdin.write(chunk)
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
            try:
                proc.kill()
            except Exception:
                pass
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
            return False, "stream error: " + str(e)

        try:
            proc.wait(timeout=max(60, timeout))
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
            return False, "ssh side-channel timeout"

        if proc.returncode != 0:
            err = b""
            try:
                err = proc.stderr.read() or b""
            except Exception:
                pass
            msg = err.decode("utf-8", "replace").strip()[:300]
            return False, "ssh exit %d: %s" % (proc.returncode, msg)
        if remaining > 0:
            return False, "client sent fewer bytes than Content-Length"
        return True, ""

    def finalize_upload(self, tmp_name, final_name):
        """Move $HOME/<tmp_name> into the foreground tmux pane's cwd
        with auto-increment-on-conflict — without typing into the
        foreground PTY. Persistent-only: tmux's own `#{pane_current_path}`
        format variable is the cross-platform way to know the pane's
        current working directory, so we don't need /proc introspection.

        Returns (ok, final_path_or_error). For non-persistent sessions
        returns (False, 'non-persistent') so the caller can fall back
        to a client-side foreground mv (which has its own alt-screen
        guard for vim/less/htop)."""
        if not self.persistent or not self.slot_id:
            return False, "non-persistent"
        if not self._control_path or not os.path.exists(self._control_path):
            return False, "control socket not ready"

        # Both names are base64-encoded in case the user picked a file
        # name with shell metacharacters / newlines / unicode. The
        # decoded values land in shell vars and never touch the parser.
        b_tmp = base64.b64encode(tmp_name.encode("utf-8")).decode("ascii")
        b_final = base64.b64encode(final_name.encode("utf-8")).decode("ascii")
        target = "websh-" + self.slot_id

        # One ssh roundtrip via ControlMaster:
        #   1. ask tmux for the pane's cwd (cross-platform)
        #   2. fall back to $HOME if tmux didn't tell us
        #   3. cd there
        #   4. find a non-colliding final name with the same ext-aware
        #      auto-increment logic the client used to ship inline
        #   5. mv -- "$HOME/$t" "./$f" (—— and ./ keep the destination
        #      from being parsed as an option even if $f starts with -)
        #   6. echo the resolved absolute path so the API caller can
        #      surface it to the user
        remote_cmd = (
            't=$(printf %s ' + b_tmp + ' | base64 -d); '
            'f=$(printf %s ' + b_final + ' | base64 -d); '
            'cwd=$(' + self.tmux_cmd + ' display -p -t ' + target +
                ' "#{pane_current_path}" 2>/dev/null); '
            '[ -n "$cwd" ] || cwd="$HOME"; '
            'cd -- "$cwd" || exit 1; '
            'b="${f%.*}"; e="${f##*.}"; '
            'if [ "$b.$e" = "$f" ]; then '
                'n=1; while [ -e "$f" ]; do f="$b($n).$e"; n=$((n+1)); done; '
            'else '
                # Strip any prior "(n)" before appending the next one so
                # repeated collisions on an extension-less name produce
                # name(1), name(2), name(3) — not name(1)(2)(3).
                'n=1; while [ -e "$f" ]; do f="${f%(*)}($n)"; n=$((n+1)); done; '
            'fi; '
            'mv -- "$HOME/$t" "./$f" && printf %s "$cwd/$f"'
        )
        ssh_cmd = [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, remote_cmd,
        ]
        try:
            proc = subprocess.run(ssh_cmd, capture_output=True, timeout=15)
        except subprocess.TimeoutExpired:
            return False, "finalize timeout"
        except Exception as e:
            return False, "ssh error: " + str(e)
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
        if not self._control_path or not os.path.exists(self._control_path):
            return False, "control socket not ready"
        b = base64.b64encode(rel_path.encode("utf-8")).decode("ascii")
        # The `--` after rm protects against an attacker-supplied path
        # that starts with `-` even though the upstream validator
        # already rejected absolute paths and `..`.
        remote_cmd = (
            'n=$(printf %s ' + b + ' | base64 -d) && '
            'rm -f -- "$HOME/$n"'
        )
        ssh_cmd = [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, remote_cmd,
        ]
        try:
            proc = subprocess.run(ssh_cmd, capture_output=True, timeout=10)
        except subprocess.TimeoutExpired:
            return False, "rm timeout"
        except Exception as e:
            return False, "ssh error: " + str(e)
        if proc.returncode != 0:
            return False, "rm exit %d" % proc.returncode
        return True, ""

    def list_dir(self, remote_path):
        """List a directory via the ControlMaster side-channel.
        remote_path may be absolute, ~, ~/sub, or relative-to-$HOME.
        Returns (entries, abs_path, error_string)."""
        if not self._control_path or not os.path.exists(self._control_path):
            return None, None, "control socket not ready"

        b64 = base64.b64encode(remote_path.encode("utf-8")).decode("ascii")
        # Entry rows are NUL-terminated (not \n) so filenames containing
        # an embedded newline don't split a row in half. The PWD: line
        # before the entries still uses \n — easy to peel off first.
        # Pure POSIX shell loop (no GNU `find -printf`) so this works on
        # BusyBox / Alpine / dash targets in addition to glibc Linux.
        # `stat -c` covers GNU + BusyBox; `stat -f` is the BSD/macOS
        # fallback; final fallback yields "0 0" so a host without stat
        # at all still returns a usable listing (size/mtime degraded).
        remote_cmd = (
            'P=$(printf %s ' + b64 + ' | base64 -d); '
            'case "$P" in '
              '/*) D="$P";; '
              '"~") D="$HOME";; '
              '"~/"*) D="$HOME/${P#~/}";; '
              '*) D="$HOME/$P";; '
            'esac; '
            'cd "$D" 2>/dev/null || exit 1; '
            'printf "PWD:%s\\n" "$(pwd)"; '
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
        ssh_cmd = [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, remote_cmd,
        ]
        try:
            result = subprocess.run(ssh_cmd, capture_output=True, timeout=10)
        except subprocess.TimeoutExpired:
            return None, None, "timeout"
        except Exception as e:
            return None, None, str(e)
        if result.returncode != 0:
            return None, None, "directory not found"

        # Peel the PWD:<path>\n preamble off the front, then split the
        # rest on NUL — each `printf ... \0` row from the loop ends
        # with \0 so embedded newlines in filenames stay intact.
        raw = result.stdout
        abs_path = remote_path
        nl = raw.find(b"\n")
        if nl >= 0 and raw[:4] == b"PWD:":
            abs_path = raw[4:nl].decode("utf-8", "replace").strip()
            raw = raw[nl + 1:]

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

    def download_file(self, remote_path):
        """Stream a file via ControlMaster. Returns (Popen, error).
        Subprocess stdout starts with a header "OK\\t<size>\\n" or
        "ERR\\t<msg>\\n" so the caller can detect failure before
        sending HTTP response headers."""
        if not self._control_path or not os.path.exists(self._control_path):
            return None, "control socket not ready"

        b64 = base64.b64encode(remote_path.encode("utf-8")).decode("ascii")
        remote_cmd = (
            'P=$(printf %s ' + b64 + ' | base64 -d); '
            'case "$P" in '
              '/*) F="$P";; '
              '"~") F="$HOME";; '
              '"~/"*) F="$HOME/${P#~/}";; '
              '*) F="$HOME/$P";; '
            'esac; '
            'if [ -f "$F" ]; then '
              'SZ=$(stat -c%s "$F" 2>/dev/null || stat -f%z "$F" 2>/dev/null || printf -- -1); '
              'printf "OK\\t%s\\n" "$SZ"; '
              'cat -- "$F"; '
            'else printf "ERR\\tFile not found\\n"; fi'
        )
        ssh_cmd = [
            "ssh", "-T",
            "-o", "BatchMode=yes",
            "-o", "ControlPath=" + self._control_path,
            "--", self._host, remote_cmd,
        ]
        try:
            # stderr→DEVNULL: the protocol header (OK/ERR on stdout) already
            # signals failure to the caller, and a PIPE that nobody drains
            # would deadlock the child once ssh writes >~64 KB of warnings
            # (host-key prompts, banners, debug). Same pattern as
            # terminate_remote_tmux.
            proc = subprocess.Popen(
                ssh_cmd,
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
        # No pipe fds to clean up — the cross-thread wake signal is a
        # threading.Event, which has no fd, no kernel resource, and no
        # teardown ordering hazard. The previous implementation needed
        # weakref.finalize here to defeat an fd-reuse race; switching to
        # Event removed both the race and the cleanup.

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
    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW
    with _rate_lock:
        stale = [ip for ip, times in _rate_limits.items()
                 if not any(t > cutoff for t in times)]
        for ip in stale:
            del _rate_limits[ip]
    # Prune stale scan-pattern entries the same way. Without this the
    # dict grows proportionally to attacker activity and never shrinks
    # — the worst possible scaling profile for a long-running deploy.
    # Drop any IP whose newest event has aged out of the window (so an
    # attacker that stops probing eventually disappears from RAM).
    scan_cutoff = now - SCAN_PATTERN_WINDOW
    with _scan_pattern_lock:
        stale = [ip for ip, events in _scan_pattern.items()
                 if not any(t > scan_cutoff for t, _ in events)]
        for ip in stale:
            del _scan_pattern[ip]


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

    def _client_gone(self):
        """Return True if the peer has half-closed (sent FIN) or the
        socket has otherwise died. Non-blocking peek; if there's nothing
        readable yet, the OS raises EAGAIN/EWOULDBLOCK and we treat it
        as 'still connected'. Used by long-running endpoints to bail
        out before draining destructive state into a dead socket.

        Portable form: MSG_DONTWAIT is Unix-only (Linux/BSD/macOS), so
        on platforms that don't define it (Windows, some embedded) we
        fall back to flipping the socket to non-blocking around a plain
        MSG_PEEK. Both paths behave identically on the success/EAGAIN
        edge."""
        sock = self.connection
        try:
            if _HAVE_MSG_DONTWAIT:
                peek = sock.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
            else:
                old = sock.getblocking()
                sock.setblocking(False)
                try:
                    peek = sock.recv(1, socket.MSG_PEEK)
                finally:
                    try:
                        sock.setblocking(old)
                    except OSError:
                        pass
            return peek == b""
        except (BlockingIOError, InterruptedError):
            return False
        except OSError:
            return True

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

    # ── Dispatch ────────────────────────────────────────────────────

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
        elif action == "upload":
            self._upload()
        elif action == "upload_finalize":
            self._upload_finalize()
        elif action == "upload_cancel":
            self._upload_cancel()
        elif action == "tmux_options":
            self._tmux_options()
        elif action == "save":
            self._save_credential()
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
        elif action == "stream":
            self._stream()
        elif action == "config":
            self._json(config_public())
        elif action == "ping":
            self._json({"ok": True, "version": __version__})
        elif action == "tmux_capture":
            self._tmux_capture()
        elif action == "ls":
            self._ls()
        elif action == "download":
            self._download()
        else:
            self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        action = self._resolve_action()
        if action == "save":
            self._delete_credential()
        else:
            self._json({"error": "not found"}, 404)

    # ── Source-IP / session-ID validation ───────────────────────────

    def _client_ip(self):
        """Return the IP we treat as the request's source for rate-limit
        and per-IP-cap purposes.

        Uses the TCP peer by default. When the peer is in TRUSTED_PROXIES
        we read the FIRST X-Forwarded-For token — but only if it parses
        as a valid IP literal. Anything else (typo, intentional garbage,
        an injected oversized blob) falls back to the peer.

        Important: when running behind a reverse proxy, the proxy MUST
        OVERWRITE this header (`proxy_set_header X-Forwarded-For $remote_addr;`
        on nginx, or use X-Real-IP), not append to it. A proxy that
        appends lets a client put any IP they like in the first token,
        bypassing per-IP rate-limiting and the per-IP session cap. The
        ip_address() validation here only stops obvious garbage and
        attacker-controlled non-IP bytes from ending up as the registry
        comparison key — it does NOT compensate for an appending proxy.
        """
        peer = self.client_address[0]
        if peer in _TRUSTED_PROXIES:
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

    def _valid_sid(self, sid):
        return bool(sid and _UUID_RE.match(sid))

    # ── Vault save / delete ─────────────────────────────────────────

    def _save_credential(self):
        ip = self._client_ip()
        if not _check_rate_limit(ip):
            _access_log_emit("save", ip, result="rate_limited")
            self._json({"error": "too many requests"}, 429)
            return
        if not (HAS_CRYPTOGRAPHY and WEBSH_VAULT_ENABLE
                and not _vault_disabled):
            self._json({"error": "credential vault unavailable "
                        "(cryptography missing / WEBSH_VAULT_ENABLE not "
                        "set / websh.creds.json schema unsupported — "
                        "see server log)"}, 501)
            return
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            content_length = 0
        if content_length > _MAX_VAULT_REQUEST_BYTES:
            self._json({"error": "request body too large"}, 413)
            return
        try:
            body = json.loads(self._body().decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, 400)
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
        if host.startswith("-") or username.startswith("-"):
            return _bad("host and username must not start with '-'")
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
        # Reject vault-side identityfile (read-oracle via ssh parse timing).
        for k in list(ssh_options.keys()):
            if isinstance(k, str) and k.lower() in _VAULT_DENY_SSH_OPTIONS:
                dropped.append(k)
                del ssh_options[k]
        if dropped:
            _log("WARN", "save dropped ssh_options keys: {}".format(dropped))

        rec = {"host": host, "port": port, "username": username,
               "iv": iv_b64, "ct": ct_b64}
        if ssh_options:
            rec["ssh_options"] = ssh_options

        with _creds_lock:
            # RMW must be atomic — without the outer lock, a concurrent save
            # to a different (vault_id, conn_id) slot could read the same
            # pre-state and clobber our update on its own save.
            data = _load_creds()
            new_vaults = dict(data.get("vaults", {}))
            slot = dict(new_vaults.get(vault_id, {}))
            slot[conn_id] = rec
            new_vaults[vault_id] = slot
            new_data = {"version": _CREDS_SCHEMA_VERSION, "vaults": new_vaults}
            _save_creds_atomic(new_data)

        _access_log_emit("save", self._client_ip(),
                         result="ok", vault_id=vault_id, conn_id=conn_id,
                         iv_len=len(iv), ct_len=len(ct))
        self._json({})

    def _delete_credential(self):
        ip = self._client_ip()
        if not _check_rate_limit(ip):
            _access_log_emit("save_delete", ip, result="rate_limited")
            self._json({"error": "too many requests"}, 429)
            return
        if not (HAS_CRYPTOGRAPHY and WEBSH_VAULT_ENABLE
                and not _vault_disabled):
            self._json({"error": "credential vault unavailable "
                        "(cryptography missing / WEBSH_VAULT_ENABLE not "
                        "set / websh.creds.json schema unsupported — "
                        "see server log)"}, 501)
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
            if not (HAS_CRYPTOGRAPHY and WEBSH_VAULT_ENABLE
                    and not _vault_disabled):
                self._json({"error": "credential vault unavailable "
                            "(cryptography missing / WEBSH_VAULT_ENABLE not "
                            "set / websh.creds.json schema unsupported — "
                            "see server log)"}, 501)
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
            rec = data.get("vaults", {}).get(sv_vault, {}).get(sv_conn)
            if rec is None:
                _access_log_emit("connect", ip, result="cred_not_found",
                                 vault_id=sv_vault, conn_id=sv_conn)
                self._json({"error": "saved entry not found"}, 404)
                return
            try:
                plaintext = _decrypt_credential(
                    vault_key_bytes, rec.get("iv", ""), rec.get("ct", ""),
                    sv_vault, sv_conn)
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
                # Drop vault-side identityfile entries even if a prior version
                # stored them; the operator config (websh.json) is the trusted
                # source for file-path options.
                ssh_options = {k: v for k, v in ssh_options.items()
                               if isinstance(k, str)
                               and k.lower() not in _VAULT_DENY_SSH_OPTIONS}
            else:
                ssh_options = {}
            password = creds.get("password") or ""
            key = creds.get("key") or ""
            if not isinstance(password, str) or not isinstance(key, str):
                self._json({"error": "vault_decrypt_failed",
                            "detail": "non-string credential field"}, 400)
                return
            # key_pass is in the plaintext for forward-compat but the
            # current SSHSession ctor doesn't accept it — drop silently.
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

        # Reject values that could be interpreted as SSH flags
        if host.startswith("-") or username.startswith("-"):
            self._json({"error": "invalid host or username"}, 400)
            return

        # Free-form manual connect is unrestricted unless restrict_hosts
        # pins the user to a ready server-side connection.
        if not conn_name and not is_host_allowed(host, port, username):
            _access_log_emit("connect", ip, result="deny_blocked",
                             target_host=host, target_user=username)
            # Only feed the scan-pattern detector when the rejection
            # actually came from the deny-list. Under restrict_hosts:
            # true, is_host_allowed() returns False unconditionally —
            # that's a different policy ("manual connects disabled,
            # use named connections") and a buggy or stale UI POSTing
            # `host` instead of `connection` could rapidly accumulate
            # against an honest user. The deny_blocked record is still
            # emitted so operators see the misconfigured client; the
            # scanner heuristic just doesn't count it.
            cfg = load_config()
            if not cfg["restrict_hosts"] and _record_deny_for_scan(ip, host):
                # Emit a separate scan_pattern record so fail2ban can
                # ban specifically on this signal without also banning
                # one-off deny_blocked typos.
                _access_log_emit("connect", ip, result="scan_pattern",
                                 target_host=host, target_user=username)
            self._json({"error": "connections to this host are not allowed"}, 403)
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
                    self._json({"error": "too many active sessions from your IP"},
                               429)
                    return
            if is_bg:
                count = sum(1 for s in sessions.values() if s.is_background)
                if count >= MAX_BG_SESSIONS:
                    _access_log_emit("connect", ip,
                                     result="session_cap_global",
                                     target_host=host, target_user=username,
                                     classification="background")
                    self._json({"error": "too many background sessions"}, 429)
                    return
            else:
                count = sum(1 for s in sessions.values()
                            if not s.is_background)
                if count >= MAX_SESSIONS:
                    _access_log_emit("connect", ip,
                                     result="session_cap_global",
                                     target_host=host, target_user=username,
                                     classification="foreground")
                    self._json({"error": "too many active sessions"}, 429)
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
            with sessions_lock:
                # Swap placeholder for the real Session. The slot was
                # already counted under the gate lock, so this never
                # bumps any cap.
                sessions[sid] = session

            time.sleep(CONNECT_SETTLE_TIME)
            _log("INFO", "new session {} for {}@{}:{}{}".format(
                sid, username, host, port,
                " [persistent slot=" + slot_id + "]" if persistent else ""))
            # Successful connect forgives the IP — see _forgive_scan_for_ip.
            _forgive_scan_for_ip(ip)
            _access_log_emit("connect", ip, result="ok", sid=sid,
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
                data = session.read()
                if data:
                    # If the client hung up between read() and write(), we
                    # would still lose these bytes — push them back on
                    # failure so the next /api/output picks them up.
                    try:
                        self._json({
                            "data": base64.b64encode(data).decode("ascii"),
                            "alive": session.alive,
                            "auth_failed": session.auth_failed,
                        })
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        session.unread(data)
                        raise
                    return
                if not session.alive:
                    self._json({"data": "", "alive": False,
                                "auth_failed": session.auth_failed})
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

        self._json({"data": "", "alive": session.alive,
                    "auth_failed": session.auth_failed})

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
        # Acquire the per-session stream slot under sessions_lock. A second
        # /api/stream for the same session is mostly the *legitimate*
        # client reconnecting (visibility resume, network blip, EventSource
        # auto-retry); the previous holder may not have observed the FIN
        # yet, especially through nginx. Wait briefly (~250 ms) for the
        # previous holder's `finally` to release the slot — most races
        # resolve in single-digit ms. After the deadline, fall back to a
        # 409 so a truly stuck holder doesn't deadlock the client.
        deadline = time.time() + 0.25
        session = None
        duplicate = False
        while True:
            with sessions_lock:
                session = sessions.get(sid)
                if session is None:
                    break
                if not session._stream_active:
                    session._stream_active = True
                    break
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
            self._stream_session(session)
        finally:
            # Release the per-session stream slot regardless of how the
            # body exited (clean end, BrokenPipe, exception). Done under
            # sessions_lock to keep the acquire/release symmetric and
            # ordered with concurrent _stream entrants.
            with sessions_lock:
                session._stream_active = False

    def _stream_session(self, session):
        """Body of /api/stream once the per-session slot is held."""
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
            primer = json.dumps({
                "data": "",
                "alive": session.alive,
                "auth_failed": session.auth_failed,
            })
            self.wfile.write(
                ("event: data\ndata: " + primer + "\n\n").encode("utf-8"))
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
                    if data:
                        session.unread(data)
                    return
                data = session.read()
                if data:
                    payload = json.dumps({
                        "data": base64.b64encode(data).decode("ascii"),
                        "alive": session.alive,
                        "auth_failed": session.auth_failed,
                    })
                    self.wfile.write(
                        ("event: data\ndata: " + payload + "\n\n")
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
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    last_send = now
                next_keepalive = last_send + KEEPALIVE
                timeout = max(0.0, next_keepalive - time.time())
                session.wait_for_data(self.connection, timeout,
                                      selector=sel)

            # Drain any remaining buffered output before sending 'end'.
            tail = session.read()
            if tail:
                payload = json.dumps({
                    "data": base64.b64encode(tail).decode("ascii"),
                    "alive": False,
                    "auth_failed": session.auth_failed,
                })
                try:
                    self.wfile.write(
                        ("event: data\ndata: " + payload + "\n\n")
                        .encode("utf-8"))
                    # Flush before the closing 'end' so a write failure
                    # on a buffered wfile (Python's default makefile in
                    # some setups) is attributable to *this* payload —
                    # we can unread() the right bytes.
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
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
            # didn't manage to deliver.
            if data:
                session.unread(data)
            return
        finally:
            try:
                sel.close()
            except Exception:
                pass

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

    # ── Tmux endpoints (capture / options) ──────────────────────────

    def _tmux_capture(self):
        """GET /api/tmux_capture?session_id=...
        Returns the full tmux pane buffer as text/plain; only valid for
        persistent sessions."""
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
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]
        rel_path = params.get("path", [""])[0]

        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        if (not rel_path or len(rel_path) > 4096
                or rel_path.startswith("/")
                or "\x00" in rel_path
                or ".." in rel_path.split("/")):
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
        if length > MAX_UPLOAD_SIZE:
            self._json({"error": "file too large"}, 413)
            return

        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return

        ok, err = session.upload_file(rel_path, self.rfile, length)
        if not ok:
            _log("WARN", "upload failed sid={} path={} err={}".format(
                sid, rel_path, err))
            self._json({"error": err}, 502)
            return
        session.last_activity = time.time()
        self._json({"ok": True, "bytes": length, "path": "$HOME/" + rel_path})

    def _upload_finalize(self):
        """POST /api/upload_finalize — for persistent sessions, move
        an already-uploaded $HOME/<tmp> file into the foreground tmux
        pane's cwd via the ControlMaster side-channel. Side-channel
        only, no foreground keystrokes — safe regardless of what app
        is in front (vim/less/htop/TUI). Returns the final absolute
        path on success, or `non-persistent` so the client knows to
        fall back to its own foreground-mv path.

        Body: { session_id, tmp, final }."""
        try:
            body = json.loads(self._body().decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, 400)
            return
        sid = body.get("session_id", "")
        tmp = body.get("tmp", "")
        final = body.get("final", "")
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        # tmp uses the same rules as the upload path. final is a basename
        # — no slashes, no traversal, no NUL — because finalize_upload
        # cd's into the pane cwd and does `mv -- "$HOME/$t" "./$f"`.
        if (not tmp or len(tmp) > 4096
                or tmp.startswith("/") or "\x00" in tmp
                or ".." in tmp.split("/")):
            self._json({"error": "invalid tmp"}, 400)
            return
        if (not final or len(final) > 4096
                or "/" in final or "\x00" in final or final in ("..", ".")):
            self._json({"error": "invalid final"}, 400)
            return
        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return
        ok, msg = session.finalize_upload(tmp, final)
        if not ok:
            # `non-persistent` is an expected, non-error outcome —
            # surface it with 200 so the client can branch cleanly
            # without inspecting an error string.
            if msg == "non-persistent":
                self._json({"ok": False, "non_persistent": True})
                return
            self._json({"error": msg}, 502)
            return
        session.last_activity = time.time()
        self._json({"ok": True, "path": msg})

    def _upload_cancel(self):
        """POST /api/upload_cancel — best-effort cleanup of a partial
        / staged upload. Removes $HOME/<tmp> via the ControlMaster
        side-channel (keystroke-free, so no risk of poking a running
        editor). Idempotent.

        Body: { session_id, tmp }."""
        try:
            body = json.loads(self._body().decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, 400)
            return
        sid = body.get("session_id", "")
        tmp = body.get("tmp", "")
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        if (not tmp or len(tmp) > 4096
                or tmp.startswith("/") or "\x00" in tmp
                or ".." in tmp.split("/")):
            self._json({"error": "invalid tmp"}, 400)
            return
        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return
        ok, err = session.remove_remote_tmp(tmp)
        if not ok:
            self._json({"error": err}, 502)
            return
        self._json({"ok": True})

    def _ls(self):
        """GET /api/ls?session_id=<sid>&path=<path>
        List a remote directory via ControlMaster. path defaults to ~."""
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]
        path = params.get("path", ["~"])[0] or "~"

        if "\x00" in path:
            self._json({"error": "invalid path"}, 400)
            return
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return

        entries, abs_path, err = session.list_dir(path)
        if err:
            self._json({"error": err}, 502)
            return
        session.last_activity = time.time()
        self._json({"path": abs_path, "entries": entries})

    def _download(self):
        """GET /api/download?session_id=<sid>&path=<path>
        Stream a file via ControlMaster (binary, no base64)."""
        params = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        sid = params.get("session_id", [""])[0]
        path = params.get("path", [""])[0]

        if not path or "\x00" in path:
            self._json({"error": "invalid path"}, 400)
            return
        if not self._valid_sid(sid):
            self._json({"error": "session not found"}, 404)
            return
        with sessions_lock:
            session = sessions.get(sid)
        if not session:
            self._json({"error": "session not found"}, 404)
            return

        proc, err = session.download_file(path)
        if err:
            self._json({"error": err}, 502)
            return

        def _reap():
            # Reap the side-channel ssh after kill so it doesn't linger as
            # a zombie. Mirrors the upload_file TimeoutExpired branch.
            try:
                proc.wait(timeout=5)
            except Exception:
                pass

        # Read the protocol header ("OK\t<size>\n" or "ERR\t<msg>\n")
        header_line = b""
        try:
            while True:
                c = proc.stdout.read(1)
                if not c or c == b"\n":
                    break
                header_line += c
        except Exception:
            proc.kill()
            _reap()
            self._json({"error": "download failed"}, 502)
            return

        parts = header_line.decode("utf-8", "replace").split("\t", 1)
        if not parts or parts[0] != "OK":
            proc.kill()
            _reap()
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
            proc.kill()
            _reap()
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

        try:
            BUF = 256 * 1024
            while True:
                chunk = proc.stdout.read(BUF)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                # Multi-GB downloads can outlast SESSION_TIMEOUT; without
                # this stamp the cleanup loop would close the master
                # mid-stream and the side-channel ssh would die with it.
                session.last_activity = time.time()
        except Exception:
            pass
        finally:
            proc.stdout.close()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                _reap()
        session.last_activity = time.time()

    # ── Disconnect ──────────────────────────────────────────────────

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


def main():
    _warn_per_ip_misconfig()
    _warn_max_threads_misconfig()
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
    if ACCESS_LOG_PATH:
        _log("INFO", "access log: {}".format(ACCESS_LOG_PATH))
    if not HAS_CRYPTOGRAPHY:
        _log("INFO", "credential vault: disabled (install cryptography to enable)")
    elif not WEBSH_VAULT_ENABLE:
        _log("INFO", "credential vault: disabled (set WEBSH_VAULT_ENABLE=1 to opt in)")
    else:
        _log("INFO", "credential vault: enabled")
    server.serve_forever()


if __name__ == "__main__":
    main()
