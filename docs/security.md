# Authentication & security

**websh does not include its own authentication layer by design.**
It is meant to be lightweight — add access control at the web server level:

- **Apache:** `.htaccess` with `AuthType Basic` + `AuthUserFile`
- **nginx:** `auth_basic` directive
- **Cloudflare Access**, **Tailscale Funnel**, or similar zero-trust tools
- IP allowlisting via firewall rules

## SSH host keys

The backend connects with `StrictHostKeyChecking=no` by default to avoid
interactive prompts. **This makes the first connection to any host vulnerable
to man-in-the-middle attacks** — the server identity is not verified.

This is acceptable when:
- You are connecting to your own servers on a trusted network
- The connection goes over an encrypted tunnel (VPN, Tailscale, etc.)

To enable host key verification for specific connections, use `ssh_options`
in `websh.json`:

```json
"ssh_options": {"StrictHostKeyChecking": "yes"}
```

## Saved connections & passwords

When the encrypted credential vault is enabled (`cryptography` installed
and `WEBSH_VAULT_ENABLE=1`), saved SSH secrets are encrypted in the browser
and stored as opaque blobs on the server. The browser keeps only metadata
in `localStorage` and the vault key in IndexedDB. See
[`encryption.md`](encryption.md) for the exact threat model.

When the vault is disabled, older saved connections may still be stored in
browser `localStorage` **in plaintext**, including passwords. Any
JavaScript running on the same origin (including XSS vulnerabilities) could
read them. Manual unsaved panes keep credentials in `sessionStorage` for
same-tab refresh restore; browsers may keep short-lived crash-recovery
copies while the tab is open.

If this is unacceptable for your use case:
- Enable the encrypted credential vault
- Use server-side connections (`websh.json`) — passwords stay on the server, never reach the browser
- Don't save connections in the browser — use SSH keys instead
- Restrict access to the websh URL to trusted networks

## Rate limiting & proxies

Connection attempts are rate-limited to **50 per IP per minute** by default
(configurable via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW`). The client IP is
determined from `X-Forwarded-For` **only** when the request comes from an IP
listed in `TRUSTED_PROXIES` (default: `127.0.0.1`). Direct connections always
use the TCP peer address.

**Requirement when running behind a reverse proxy:** the proxy MUST overwrite
(not append) the client-IP header before forwarding. websh reads the *first*
`X-Forwarded-For` token, so a proxy that appends (the default
`$proxy_add_x_forwarded_for` recipe in many tutorials) lets a client supply
their own first token and bypass both per-IP rate limiting and the
`MAX_SESSIONS_PER_IP` cap. Use one of:

```nginx
# nginx — overwrite (good)
proxy_set_header X-Forwarded-For $remote_addr;
# OR use X-Real-IP, also overwrite by default:
proxy_set_header X-Real-IP $remote_addr;
```

websh validates the token via `ipaddress.ip_address()` and silently falls
back to the TCP peer if it doesn't parse, so non-IP garbage cannot end up as
the rate-limit / session-cap key — but a *valid* IP forged by an appending
proxy will still be honored. The only defense there is correct proxy config.

If your reverse proxy runs on a different host, add its IP:

```bash
TRUSTED_PROXIES=127.0.0.1,10.0.0.5 python3 server.py
```

## Access log

Set `WEBSH_ACCESS_LOG=/path/to/access.log` to emit one JSON record per
abuse-relevant event. Records are stable single-line JSON suitable for
`fail2ban` filters and ad-hoc `jq` pipelines. The value is normalised
at startup: `~` expands and a relative path resolves against the
server's cwd. The resolved path is logged once at startup
(`access log: <abs-path>`).

```json
{"ts":"2026-05-07T12:34:56.789012Z","event":"connect","ip":"203.0.113.7","result":"deny_blocked","target_host":"10.5.6.7","target_user":"root"}
{"ts":"2026-05-07T12:35:01.123456Z","event":"connect","ip":"203.0.113.7","result":"rate_limited"}
{"ts":"2026-05-07T12:35:42.999999Z","event":"connect","ip":"198.51.100.4","result":"ok","sid":"…","target_host":"prod.example","target_user":"deploy","persistent":false,"latency_ms":612}
{"ts":"2026-05-07T12:40:11.000000Z","event":"disconnect","ip":"198.51.100.4","sid":"…","terminate":false,"target_host":"prod.example","result":"closed"}
```

Common `result` values on `connect` events:

| `result` | Meaning |
|---|---|
| `ok` | Session created. Record includes `sid`, `target_host`, `target_user`, `persistent`, `latency_ms`. |
| `rate_limited` | Caller exceeded `RATE_LIMIT_MAX` for the window. |
| `deny_blocked` | Target host (or its resolved IP) is on `denied_hosts`. |
| `session_cap_per_ip` | The per-source-IP active session cap (`MAX_SESSIONS_PER_IP`) was at the limit. |
| `session_cap_global` | Global cap (`MAX_SESSIONS` for `foreground`, `MAX_BG_SESSIONS` for `background`) was at the limit. The `classification` field tells which. |
| `scan_pattern` | The IP has reached `SCAN_PATTERN_THRESHOLD` distinct deny-listed targets inside the window. Emitted in addition to the original `deny_blocked` record, starting on the Nth probe and on every probe after. ANY successful connect from the same IP clears state, so a power user touching many real servers never accumulates here. |
| `error` | Internal failure during session creation. The `error` field carries up to 200 Unicode characters of the exception (~800 UTF-8 bytes for non-ASCII text). |

Common `result` values on `disconnect` events:

| `result` | Meaning |
|---|---|
| `closed` | Disconnect with `terminate=false`; the persistent session (if any) is left alive on the target. |
| `terminated` | Disconnect with `terminate=true`; the persistent tmux session was killed on the target before close. |
| `close_error` | `session.close()` (or `terminate_remote_tmux()`) raised. The record still appears, with `error` set to the exception text. |

`fail2ban` filter sketch — drop into `/etc/fail2ban/filter.d/websh-abuse.conf`:

```ini
[Definition]
failregex = ^.*"ip":\s*"<HOST>".*"result":\s*"(rate_limited|session_cap_per_ip|scan_pattern)".*$
ignoreregex =
```

Note that `deny_blocked` is deliberately **not** in the recommended
filter. A one-off `deny_blocked` is just as likely a fat-fingered
hostname or a stale UI link as it is an attacker — banning on a single
event would burn legitimate users. The `scan_pattern` event is the
curated signal for "this IP is probing the deny-list": it only fires
once `SCAN_PATTERN_THRESHOLD` distinct deny-listed targets are reached
inside the window, and any successful connect from the same IP
forgives the accumulation. So `deny_blocked` records stay in the log
for operator visibility (you want to see misconfigured clients) but
fail2ban acts only on the `scan_pattern` aggregate.

If `SCAN_PATTERN_THRESHOLD=0` (the default — disabled), `deny_blocked`
events are still recorded but no `scan_pattern` events are ever
emitted — the operator hasn't opted in to automatic banning, so
nothing in this filter triggers on a typo. Set a positive
`SCAN_PATTERN_THRESHOLD` to enable the curated signal.

The file is opened-and-closed per write, so `logrotate(8)` works without
any signal-based reopen plumbing — `copytruncate` is fine. Each record
is committed with a single `write(2)` on an `O_APPEND` fd: on Linux the
kernel adjusts the file offset and commits the buffer atomically against
other `O_APPEND` writers, so concurrent threads do not interleave bytes
within one record. To keep that guarantee real, every attacker-
controlled string field is hard-capped before serialisation
(`target_host` 253, `target_user` 64, `sid` 36, `error` 200, server-
controlled status fields 32) and ASCII C0/C1 + Unicode bidi/format
control codepoints are scrubbed to `?`, so a single record always fits
in one `write(2)` call and stays safe to view in a terminal.

## Input validation

- Host and username values starting with `-` are rejected (prevents SSH flag injection)
- Session IDs are validated as UUID format
- Terminal dimensions are clamped to safe ranges
- `MAX_SESSIONS` limits concurrent user sessions; `MAX_BG_SESSIONS` limits file transfer sessions separately
- `MAX_SESSIONS_PER_IP` (off by default) caps how many sessions a single source IP can hold at once — useful when running a public-facing instance where one abuser shouldn't be able to fill all the global slots

## Header-trust authentication

websh itself has no user accounts — possession of a session id is the
only key, and the documented model is "bind to loopback, put a reverse
proxy in front". When that proxy authenticates users (oauth2-proxy,
Authelia, authentik, Cloudflare Access), set:

```
WEBSH_AUTH_HEADER=Remote-User
```

and websh enforces what the proxy established:

- every request **except `/api/ping`** (docker healthchecks, the PHP
  shim's auto-start probe) requires the header → `401` otherwise —
  including the static files;
- the header is read **only from `TRUSTED_PROXIES` peers** — the same
  trust rule as `X-Forwarded-For` — so a client that reaches the
  backend directly cannot mint identities and is simply
  unauthenticated;
- sessions are stamped with their creator's identity at connect, and
  every session endpoint (input/output/stream/resize/disconnect, tmux,
  file transfer) enforces ownership → `403` across users;
- `result=ok` connect records and disconnect records in the access log
  carry the identity as `auth_user`.

The proxy MUST strip/overwrite the configured header on incoming
requests. Real auth proxies (oauth2-proxy, Authelia) do; a **bare
nginx `proxy_pass` forwards client headers untouched** — if any
non-auth hop sits in front, neutralize the header explicitly:

```nginx
proxy_set_header Remote-User "";
```

websh additionally refuses a request carrying the header **more than
once** (an appending proxy would otherwise let a client-smuggled first
value win), and reads it only from `TRUSTED_PROXIES` peers. Two
operational notes: with the defaults (`HOST=127.0.0.1`,
`TRUSTED_PROXIES=127.0.0.1`) any local process on a shared box can
mint identities — inherent to loopback trust; and enable
`WEBSH_AUTH_HEADER` at startup only — sessions are stamped at creation,
so flipping it on over a live registry orphans existing sessions
(deny-by-default, by design). Cross-user probes are recorded in the
access log as `event=authz_denied` with `auth_user` and the probed
`sid`. Note the vault endpoints are gated but not per-user scoped —
header-trust auth gives per-session isolation, not per-user credential
isolation.

Known limitation: persistent tmux **slots** live on the target host
keyed by slot id; ownership is enforced on websh sessions, while
`resume_slot_id` re-attachment authenticates through ssh itself (the
user must still hold valid credentials for the target).
