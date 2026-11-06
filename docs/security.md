# Authentication & security

**websh does not include its own authentication layer by design.**
It is meant to be lightweight — add access control at the web server level:

- **Apache:** `.htaccess` with `AuthType Basic` + `AuthUserFile`
- **nginx:** `auth_basic` directive
- **Cloudflare Access**, **Tailscale Funnel**, or similar zero-trust tools
- IP allowlisting via firewall rules

That only holds if nothing reaches the backend around the web server.
On shared hosting `127.0.0.1` is common to every account on the server,
so the PHP proxy runs the backend on an owner-only Unix socket
(`WEBSH_SOCKET`) instead of a loopback port. With the default TCP bind,
run websh on a machine you don't share.

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
(`access log: <abs-path>`), and the server **refuses to start** if
the file cannot be opened for append — a security log that silently
is not written is worse than a server that does not come up. Under
the bundled systemd units (`ProtectSystem=strict`) the writable homes
are `/var/log/websh*` (`LogsDirectory=`) and `/var/lib/websh*`
(`StateDirectory=`); the same applies to `WEBSH_RECORD_DIR`.

```json
{"ts":"2026-05-07T12:34:56.789012Z","event":"connect","ip":"203.0.113.7","result":"deny_blocked","target_host":"10.5.6.7","target_user":"root"}
{"ts":"2026-05-07T12:35:01.123456Z","event":"connect","ip":"203.0.113.7","result":"rate_limited"}
{"ts":"2026-05-07T12:35:42.999999Z","event":"connect","ip":"198.51.100.4","result":"ok","sid":"…","target_host":"prod.example","target_user":"deploy","persistent":false,"latency_ms":612}
{"ts":"2026-05-07T12:40:11.000000Z","event":"disconnect","ip":"198.51.100.4","sid":"…","terminate":false,"target_host":"prod.example","result":"closed"}
```

Common `result` values on `connect` events:

| `result` | Meaning |
|---|---|
| `ok` | ssh was spawned (not: authenticated — see the `auth_failed` event). Record includes `sid`, `target_host`, `target_user`, `persistent`, `latency_ms`. |
| `rate_limited` | Caller exceeded `RATE_LIMIT_MAX` for the window. |
| `deny_blocked` | Target host (or its resolved IP) is on `denied_hosts`. |
| `session_cap_per_ip` | The per-source-IP active session cap (`MAX_SESSIONS_PER_IP`) was at the limit. |
| `session_cap_global` | Global cap (`MAX_SESSIONS` for `foreground`, `MAX_BG_SESSIONS` for `background`) was at the limit. The `classification` field tells which. |
| `scan_pattern` | The IP has reached `SCAN_PATTERN_THRESHOLD` distinct deny-listed targets inside the window. Emitted in addition to the original `deny_blocked` record, starting on the Nth probe and on every probe after. The first real keystroke into a session whose authentication did not fail clears the IP's state (a spawn alone does not — a scanner that also connects to a non-denied host and fails auth there must not reset its own counter), so a power user touching many real servers never accumulates here. |
| `error` | Internal failure during session creation. The `error` field carries up to 200 Unicode characters of the exception (~800 UTF-8 bytes for non-ASCII text). |

Other events:

| `event` | When |
|---|---|
| `auth_failed` | The read loop saw ssh reject the credentials (or re-prompt) after the auto-typed password. Fields: `sid`, `target_host`, `target_user`. This — not `connect result=ok` — is the brute-force signal: every password attempt relayed through websh produces one. |
| `upload`, `download` | One record per transfer with `path` and `bytes`; download `result` is `ok`, `partial` (known size not reached), `over_cap`, `timeout` or `client_gone`. |
| `rm`, `mkdir`, `mv` | Every file-browser mutation, on both outcomes (`result` `ok`/`error`, plus `error`). These are keystroke-free, so they appear in neither the session recording nor the scrollback — the access log is their only audit surface. `mv` carries `name`. |
| `client_lat` | A page's latency report (see [Latency reports](#latency-reports)): `result` `ok` or `rate_limited`; nothing else. |
| `save` | Vault write, with `target_host` / `target_user` / `target_port` of the entry (so a re-bound or mass-created entry is visible). |

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
            ^.*"event":\s*"auth_failed".*"ip":\s*"<HOST>".*$
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

- Host must be a plain hostname/alias (`[A-Za-z0-9._-]`) or an IP literal, username a plain login (`[A-Za-z0-9._@-]`); neither may start with `-`. This rejects SSH flags and the `user@host` / `ssh://` destination forms that `getaddrinfo()` cannot resolve — those used to slip past `denied_hosts`, which falls open on resolution failure by design
- Session IDs are validated as UUID format

## Cross-site request forgery

State-changing methods (`POST`, `DELETE`) are gated twice:

- **Origin.** A browser sends `Origin` on every cross-site request. If its host is not the `Host` this request was addressed to (or the first `X-Forwarded-Host` from a `TRUSTED_PROXIES` peer), the reply is `403 {"error":"cross-site request refused"}`; so is `Origin: null` and `Sec-Fetch-Site: cross-site`/`same-site`. A request with neither header comes from a non-browser client (curl, monitoring) and passes — those are not CSRF victims. The PHP shim enforces the same rule itself, because it forwards no browser headers to the backend.
- **Media type.** JSON endpoints require `Content-Type: application/json` (`415` otherwise). A cross-site `<form>` can only produce `text/plain`, urlencoded or multipart bodies, so a forged form post never reaches a handler even without the Origin check.
- Terminal dimensions are clamped to safe ranges
- `MAX_SESSIONS` limits concurrent user sessions; `MAX_BG_SESSIONS` limits file transfer sessions separately
- `MAX_SESSIONS_PER_IP` (off by default) caps how many sessions a single source IP can hold at once — useful when running a public-facing instance where one abuser shouldn't be able to fill all the global slots

## Sealed traffic

Options → "Encrypt traffic inside websh" (off by default) adds a second
encryption layer under TLS, for networks that read HTTPS: a work
computer whose TLS-inspecting proxy has its own root CA installed, an
ISP or state DPI box. Wire format: [`protocol.md`](protocol.md#sealed-channel).
It needs `cryptography` on the server (`/api/config` says whether it is
available) and Web Crypto in the browser (an HTTPS page).

**What an observer of the HTTPS connection sees, with it on.** After
the page has loaded: `POST ?action=seal_open` (two ephemeral public
keys, a channel id, the server's identity key and a signature) and
`POST ?action=sealed&c=<channel id>` requests whose JSON bodies and
event-stream replies carry only base64 of encrypted frames. Not in clear anywhere - URL, headers, body - are
action names, session ids, host / username / password / key /
`vault_key`, keystrokes, terminal output, file names, paths, file
contents, directory listings, tmux slot ids. `/api/config`,
`/api/ping`, the page and its static files stay plain (they carry no
session data); the `client_diag` beacon is not sent at all. The
`client_lat` report travels sealed like any other call (and only over
a channel already open); its `pagehide` copy is not sent.

What it still sees: that a websh page was loaded (its files are
plain), the timing and sizes of requests and replies (a keystroke is
a small request; output is a stream), and how long a download is.
Uploads are padded: every piece of one file has the same size on the
wire, and the total is rounded up to a bucket (64 KiB x 2^k x {1,
1.25, 1.5, 1.75}, plus a random extra piece), so a file's size shows
only as its bucket. Nothing else is padded.

**Trust on first use.** The server's identity key (ECDSA P-256,
`WEBSH_SEALED_KEY_FILE`, created at first start; its fingerprint is in
the startup log) signs every handshake. A browser pins the fingerprint
the first time it opens a channel (shown under the option, to compare
with the log). If the server later presents another key, nothing is
sent through the channel: a dialog shows both fingerprints, "Trust
the new key" or "Cancel"; Cancel leaves the option on and the panes
failing visibly. A replaced key file (reinstall, a new container
without the volume) looks exactly like an interception - keep the key.

**What it does not protect against.**

- A proxy that **rewrites** pages can serve its own `websh.js`, which
  can do anything: the layer protects only as long as the page itself
  is genuine. Against passive reading it works from the first use;
  against an active man in the middle only after the key was pinned
  from a clean network, and only if the page is still the real one.
- **Software on your own machine that injects script into the page**
  - antivirus, DLP or "web protection" products that intercept HTTPS
  and add their own script (seen in the wild: a `main.js?attr=...`
  that wraps `fetch`) - sees everything the page sees: what you type,
  what the terminal shows, the files you upload. Sealed mode hides
  traffic from the network and from proxies that only read it, not
  from such software.
- Anything on the browser's machine or the websh server itself: the
  layer ends in the page and in `server.py`. The server still sees and
  logs what it always did (the access log records the inner action).
- It is not a replacement for TLS: it runs inside it.

**No silent downgrade.** While the option is on, a call that cannot be
sealed - the server cannot seal, the channel cannot be opened, the key
changed and was not trusted - fails visibly (a local error the call
sites treat like a busy server, a toast, no lock badge); it is never
sent in plain form instead (`docs/invariants.md` X7).

Sealed wire version 2 binds every encrypted response frame to its
request seq and its position in the response, including the header and
end. A proxy cannot substitute a different connection's response or
replay/reorder output frames within the same channel. The negotiated
version is included in the signed handshake. Cached wire-1 clients
receive reload guidance before sending protected requests; plain API
version 1 and existing server identity pins stay unchanged.

A server restart forgets every channel. An outer 410 can also be forged
after a request already executed, so it is never evidence that resending
a command is safe. Read-only GET calls and POST `output_many` can reopen
and retry; every other POST with an unverified outcome is not resent by
the sealed boundary. The user is told that the request may have completed and to check before
trying again. Queued input behind an uncertain batch for the same
session is dropped, while later fresh typing can open a new channel.
Only authenticated inner API replies can supply refusal codes such as
`busy` or `restarting`; raw proxy JSON cannot trigger input replay.
Upload pieces remain safe to retry because their immutable bytes are
written at fixed positions, without append or truncation.

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
mint identities — inherent to loopback trust, which `WEBSH_SOCKET`
avoids; and enable
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

## Session recording

`WEBSH_RECORD_DIR` writes one asciicast v2 file per session. Recording is
**output-only**: keystroke/input recording is hard-disabled (the input tee
is compiled out), so passwords typed at a prompt *inside* the session are
never written. `WEBSH_RECORD_INPUT` is ignored — if set, the server logs a
warning at startup and records output only. Treat the directory as
sensitive:

- terminal output routinely contains secrets (cat'ed configs, env dumps),
  so the recordings are sensitive even without keystrokes;
- files are created `0600` under the server user, but there is no built-in
  rotation or retention — pair it with a tmpwatch/logrotate policy and tell
  your users they are being recorded where the law requires it;
- the browser-form ssh password is never recorded as input (the auto-type
  happened below the input tee, which is now removed). One caveat on the
  output side: a malicious/non-OpenSSH target that prints a password-looking
  prompt WITHOUT disabling terminal echo would cause the auto-typed password
  to echo back into the output stream — and therefore into the recording. A
  genuine OpenSSH prompt disables echo first, so the standard flow never
  records it; the hostile-server case already hands the password to the
  attacker, the recording merely adds local persistence. Also add
  `WEBSH_RECORD_MAX_BYTES` (default 64 MiB) to your sizing math — the cap
  stops a runaway recording, not the session.

Replay with `asciinema play <file>` or any asciicast v2 player.

## Latency reports

To find where typing gets slow, the page sends `POST ?action=client_lat`
every 5 minutes (only if input was sent in that window) and the server
logs `input_lat` per session (`docs/protocol.md`, "POST /api/client_lat").
What they contain: per pane an 8-character session id prefix, the
transport name, whether sealed mode is on, counts, and latency
percentiles / maxima in milliseconds; for the page the window length and
`visibilityState`. Never keystrokes, their number of characters, output,
host names or user names. The server clamps numbers, accepts words only
from `A-Za-z0-9_.-` (16 characters), at most 16 panes and 16 KB, and 30
reports per IP per 10 minutes (`429` beyond). Through the sealed channel
the report is encrypted like any call; its `pagehide` copy is not sent
in sealed mode.
