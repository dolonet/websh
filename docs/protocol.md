# Wire protocol

The contract between the websh client (`websh.js`), the optional PHP
proxy (`api.php`) and the backend (`server.py`). Version: **proto 1**
(shipped as `"proto"` in [`/api/config`](#get-apiconfig) and
[`/api/ping`](#get-apiping); the bundled client compares it against its
own `CLIENT_PROTO` at page load and prompts for a reload on mismatch —
the stale-cached-client case).

Compatibility rules:

- **Additive** changes (new optional request fields, new response
  fields, new actions) do NOT bump `proto`.
- **Breaking** changes (renamed/removed fields, changed semantics or
  status codes a client depends on) bump it.

## URL dialects

Every action is reachable two ways; both hit the same handler:

| Dialect | Example | Used by |
|---|---|---|
| REST | `GET /api/output?...` | curl, tests, Docker healthcheck |
| PHP-compatible | `GET /api.php?action=output&...` | the bundled client (works with and without the PHP proxy) |

`save_delete` exists only because the PHP dialect cannot express
`DELETE /api/save`: the shim (and server.py in PHP-dialect mode)
translates `POST ?action=save_delete` into the same handler.

## Conventions

- Request bodies are JSON objects (`Content-Type: application/json`).
  Malformed JSON → `400 {"error": "invalid json"}` (`/api/input`
  appends the parse detail to the message).
- `session_id` rides in the query string for GETs and in the JSON body
  for POSTs.
- Every response is JSON unless stated otherwise (`stream`, `download`,
  `tmux_capture`, static files).
- Errors are `{"error": "<message>"}` with a meaningful status:
  `400` bad input, `403` policy deny (deny-listed host, user-list
  rejection), `404` unknown session/action/entry, `409` busy slot,
  `413` too large, `429` rate-limited, `500` spawn/input failure,
  `501` vault unavailable, `502` remote/side-channel failure,
  `503` worker pool exhausted.

## Session endpoints

### POST /api/connect
Body: `host`, `port`, `username`, and one of `password` / `key`
(+ optional `key_pass`); or `connection` (the name of a
server-configured entry); or `vault_id` + `conn_id` + `vault_key`
(saved card). Options: `cols`, `rows`, `background` (file-transfer
helper session), `persistent`, `resume_slot_id` (re-attach to a tmux
slot; implies persistent), `tmux_cmd`, `tmux_set_clipboard`,
`tmux_history_limit`.
Reply 200 (one object, all keys always present):
`{"session_id": uuid, "status": "connecting", "alive": bool,
"auth_failed": bool, "persistent": bool, "slot_id": str|null,
"tmux_cmd": str}` — `auth_failed: true` means the credentials were
rejected during the settle window; `slot_id` is null for
non-persistent sessions. Errors: `429` rate limit / session caps,
`403` deny-list or user-list rejection, `404` unknown named
connection / saved entry, `400` validation, `500` spawn failure.

### POST /api/input
Body: `session_id`, `data` (UTF-8 keystrokes). Reply:
`{"ok": bool, "alive": bool, "cursor": int}`. `cursor` is the offset of
the end of the session's output so far: a client still behind it a
couple of seconds later knows its output channel is not delivering and
restarts it (see `docs/sse-transport.md`, "Silent connection death").

### GET /api/output?session_id=
Long-poll: waits up to ~10 s for PTY output. Reply:
`{"data": base64, "alive": bool, "auth_failed": bool}`. An empty
`data` with `alive: true` is a keepalive; `alive: false` is terminal.

### GET /api/stream?session_id=
SSE variant of `output` (one concurrent stream per session; a second
attach takes the slot over from the first, which ends - `409` only if
the holder cannot step aside within ~2 s). Framing: a
`: ok` comment primer plus an empty *named* `event: data` event (the
client's buffering-proxy detection depends on receiving it promptly),
then named `event: data` events carrying the same JSON payload shape
as `output`, a heartbeat every 15 s of silence (a `: keepalive`
comment for proxies plus a named `event: ping` the client can see),
and a final
`event: end` + `data: {"alive": false, ...}`. Note the events are
named — a bare `EventSource.onmessage` consumer sees nothing.

#### Output cursor (lossless reconnect)
Both endpoints accept `&since=<n>`: the absolute byte offset of the
output this client has already rendered (0 for a new session). With
it, output is read **without being consumed**, from a replay window of
the session's last `OUTPUT_REPLAY_BYTES` (default 512 KiB), and every
reply / `data` event carries:

- `cursor` — the offset after this chunk (the client's next `since`);
- `lost` (only when non-zero) — bytes that were produced but fell out
  of the replay window before this reader asked; the client should say
  so rather than silently skip;
- `reset: true` (only when set) — the `since` was ahead of anything
  this session produced (a cursor from another session); the reply
  starts over from the retained window.

On SSE each `data` event also has `id: <cursor>`, so a browser's
automatic EventSource reconnect resends it as `Last-Event-ID`, which
takes precedence over the `since` in the (unchanged) reconnect URL. A
chunk may overlap what the client already has - it covers
`[cursor - len(data), cursor)` - and the client trims bytes below its
own cursor. The PHP shim forwards `Last-Event-ID`.

Without `since` (and without `Last-Event-ID`) the original semantics
apply: reads drain the buffer, no `cursor` field. Older cached clients
keep working.

### POST /api/resize
Body: `session_id`, `cols`, `rows`. Reply `{"ok": true}`.

### POST /api/disconnect
Body: `session_id`, `terminate` (bool — also kill the remote tmux
session for persistent panes). Reply `{"ok": true}` (idempotent —
unknown session is still `{"ok": true}`).

## Tmux endpoints (persistent sessions)

### GET /api/tmux_capture?session_id=
Full scrollback capture over the ControlMaster side-channel. Reply:
`text/plain` body (NOT JSON), possibly truncated to the freshest tail
with a marker line; `502 {"error": ...}` on failure.

### POST /api/tmux_options
Body: `session_id`, `tmux_set_clipboard`, `tmux_history_limit` (same
allow-list as connect). Reply `{"ok": true, "applied": [names]}`.

## File-transfer endpoints

All side-channel endpoints (`upload*`, `ls`, `rm`, `mkdir`, `mv`,
`download`, `tmux_capture`, `tmux_options`) share a per-IP rate limit →
`429 {"error": "rate_limited"}`.

### POST /api/upload?session_id=&path=
Raw request body = file bytes (`Content-Length` required, capped by
`MAX_UPLOAD_SIZE` → `413`). `path` is `$HOME`-relative, no `..`/NUL.
Streams into `$HOME/<path>` over the ControlMaster. Reply
`{"ok": true, "bytes": n, "path": "$HOME/<path>"}` / `{"error": ...}`.

With `&offset=N` the body is one piece of the file. Use a unique staging
path for each new file, and reuse that path only for pieces and retries
of the same immutable file. Every offset, including zero, requires the
remote file to be exactly N bytes long; an absent file counts as empty.
Otherwise the reply is `409 {"error": "offset mismatch",
"size": <actual>}` and the client resumes from `size`. `size` in the
`ok` reply is the end of the written piece. Writes use fixed positions
without truncation, so overlapping retries write identical bytes into
the same positions instead of appending them twice. A repeated first
piece cannot erase later pieces. To start over, use a fresh staging
path. The client stops with an error if the existing file is larger
than the selected file, without reusing or finalizing that path.
Without `offset`, the legacy whole-file request still overwrites its
destination. The client sends
pieces (4 MB, each retried on its own) only when `/api/config` says
`upload_chunks: true`, because an older server would overwrite the file
with every piece. Pieces are what let an upload cross a proxy or VPN
that cuts long or large requests. A cut piece (nginx `400 "client sent
fewer bytes than Content-Length"`, a dropped connection, or our own
short-body `502`) halves the piece size from the first failure down to
256 KB, so a size the proxy passes is found and the file still lands
whole. A truncation never reaches the server as a final error; the
client only gives up (fast, with a "blocked or cut short" banner) when
no piece lands within its wall-clock budget.

#### Text pieces
The same piece may come as `Content-Type: application/json` with body
`{"b64": "<base64>"}` (standard, padded): the decoded bytes are the
piece, and everything else - `offset` rules, `409` with `size`, the
reply, `MAX_UPLOAD_SIZE` (applied to the decoded size), the access-log
`bytes` - is as for a raw piece. Bad JSON or a missing / invalid `b64`
→ `400 {"error": "invalid upload body"}`, nothing written; a body
shorter than its Content-Length → `502 {"error": "client sent fewer
bytes than Content-Length"}`, as for a cut raw piece. Advertised by `"upload_text": true` in
`/api/config` (an older server would write the JSON into the file).
Raw bodies behave exactly as before.

Why: an endpoint-security product that intercepts HTTPS on a user's
machine answered every `application/octet-stream` POST itself
(`503 text/html`), while JSON passed. The client starts every upload
binary; when binary is blocked - a non-2xx reply that is not websh's
JSON, or cuts that go on at the smallest piece, where it would
otherwise give up - it continues the same upload as text pieces from
the size the server reports, and remembers that for the browser for
30 days (`localStorage` `websh_upload_text`, the time it was set).
`api.php` keeps the piece's content type.

### POST /api/upload_finalize
Body: `session_id`, `tmp`, `final`, optional `dir`. Moves `$HOME/<tmp>`
to its destination with collision auto-increment (`a.txt` → `a(1).txt`).

`dir` is an absolute remote path — the directory the client wants the
file in, normally the one its file browser is showing. Same validation
as `rm`/`mkdir`/`mv`: absolute, no NUL, ≤ 4096 bytes, not bare `/`s →
`400 {"error": "invalid dir"}`. It confers no access the session does
not already have; the same user could `mv` there from their shell. A
placement is audited as an `upload_place` access-log event carrying the
final path (the `upload` event only sees the staging name in `$HOME`).

Without `dir` the destination is the foreground tmux pane's cwd, which
only a tmux-backed session can resolve: others get
`{"ok": false, "non_persistent": true}` and the client falls back to a
foreground `mv`. With `dir` no tmux is involved, so the move is
keystroke-free for every session.

Reply `{"ok": true, "path": abs}`. Failures carry the remote's own
reason with a matching status: `404` for a missing directory, `403` for
a permission or read-only failure, `409` for a conflict, `502` otherwise.

### POST /api/upload_cancel
Body: `session_id`, `tmp`. Best-effort `rm` of the staged file.
Reply `{"ok": true}`.

### GET /api/ls?session_id=&path=[&cwd=1]
Remote directory listing. Reply: `{"path": abs, "entries":
[{"name", "type": "d|f|l|o", "size", "mtime"}, ...]}`.

`cwd=1` ignores `path` and lists the pane's current working directory
instead, so "where am I" and "what is there" stay one ssh roundtrip.
Only tmux-backed sessions can resolve one (via `#{pane_current_path}`);
everything else falls back to `$HOME`. `path` is still required as the
fallback value and must be present. The reply's `path` is always the
directory actually listed — clients should read their position back
from it rather than assuming the request was honoured.

Entries arrive sorted directories-first by name. Clients are free to
re-sort (the bundled one sorts by `mtime` descending by default).

### POST /api/rm
Body: `session_id`, `path` (absolute). Deletes exactly one entry over
the ControlMaster side channel: `rm -f` for files and symlinks,
`rmdir` for directories. **Never recursive** — deleting a populated
directory fails rather than taking the tree with it. Symlinks are
unlinked, never followed.

Reply `{"ok": true}`; `{"ok": true, "already_gone": true}` when the
entry no longer exists (the goal state holds, so a retry after a lost
response is not an error). Failures carry the remote tool's own
reason, e.g. `{"error": "Directory not empty"}`, with a status by
kind — see "Side-channel failure statuses" below. `400` for a relative
path, bare `/`, an embedded NUL, or a non-string.

Grants no privilege the session lacks — the user has an interactive
shell on that host as that account. The reason it exists is that the
delete is keystroke-free, so it cannot disturb a full-screen program
running in the foreground PTY.

### POST /api/mkdir
Body: `session_id`, `path` (absolute). Creates one directory,
**non-recursive** (`mkdir`, not `mkdir -p`) — a mistyped path fails
rather than silently building a chain. The final path segment may not
be `.` or `..`. Reply `{"ok": true}`, or an error: `409` "name
already exists", otherwise the remote's reason ("No such file or
directory" for a missing parent, "Permission denied", …); `400` for a
bad path.

### POST /api/mv
Body: `session_id`, `path` (absolute source), `name` (bare filename).
Renames the entry to a **sibling** in the same directory — the
destination is always `dirname(path)/name`, so it cannot move an entry
elsewhere; `name` is rejected if it contains `/`, is `.`/`..`, is
empty, holds a NUL, or exceeds 255 bytes. Refuses to overwrite an
existing target. Reply `{"ok": true}`, or an error: `404` "no such
file or directory", `409` "a file with that name already exists",
otherwise the remote's reason; `400` for a bad path or name.

#### Side-channel failure statuses
rm / mkdir / mv map the failure reason to a status: `404` no such
file; `409` exists / not empty / busy / not a directory / is a
directory; `403` permission denied / operation not permitted /
read-only file system; `400` name too long; `502` anything else (ssh
or side-channel failure).

### GET /api/download?session_id=&path=
Streams the file as `application/octet-stream` with
`Content-Disposition` (and `Content-Length` when the remote size is
known). Errors before the first byte are JSON (`404`-ish shapes,
`413` over `MAX_DOWNLOAD_SIZE`); an over-cap mid-stream download is
aborted (truncated body).

## Vault endpoints (encrypted saved credentials)

Gated server-side: `501` when the vault is unavailable (no
`cryptography`, `WEBSH_VAULT_ENABLE` unset, or schema problem). Both
endpoints also share the connect-class per-IP rate limit →
`429 {"error": "too many requests"}`.

### POST /api/save
Body: `vault_id`, `conn_id`, `host`, `port`, `username`, `iv`, `ct`
(AES-GCM blob, browser-held key), optional `ssh_options` (allow-listed;
identity/known-hosts/ProxyJump options are rejected). Reply 200: `{}`
(empty object — check the status, not a body flag).

### DELETE /api/save?vault_id=&conn_id= (alias: POST ?action=save_delete)
Removes one blob. Reply: `204` (no body); `404` when the entry does
not exist; `400` invalid ids.

## Meta endpoints

### GET /api/config
Public configuration for the client. Reply: `{"connections": [...],
"restrict_hosts": bool, "isolate_storage": bool, "session_timeout":
int, "version": str, "proto": int, "vault_enabled": bool}`
(connection entries carry no secrets; deployments may extend this with
additive fields). Also `"upload_chunks": true`, `"upload_text": true`
(upload pieces may be `{"b64": ...}` JSON, see `POST /api/upload`) and
`"sealed": {"available": bool, "identity": "<fingerprint>"|null}` -
whether this server can open a [sealed channel](#sealed-channel) (it
can iff `cryptography` imports and its identity key loads) and the
fingerprint of its identity key: SHA-256 of the key's
SubjectPublicKeyInfo DER, uppercase hex in 16 groups of 4.

### POST /api/client_diag
A page's diagnostics beacon (`navigator.sendBeacon` on `pagehide`, sent
only when some pane looked stuck; see `docs/sse-transport.md`, "Paint
guard"). Body: a JSON object - the beacon sends it as `text/plain`, so
this action reads JSON whatever the media type (max 16 KB). Page fields:
`vis` (visibilityState), `focus` (bool), `vis_ago` (ms since the last
visibility change), `recoveries`, `err` (the last uncaught error
message, at most 80 characters) and `err_ago`. `panes`: up to 16 of
`{"sid": first 8 chars, "got", "srv": output offsets, "write_ago",
"parse_ago", "render_ago": ms, "unrendered": ms output has waited to be
drawn, "pend": chunks xterm has not parsed, "pend_ms": ms parsing has not
moved, "paused", "frame": xterm's render pause / pending frame (1/0/-1),
"cols", "rows", "w", "h", "mode": "sse"|"sse-closed"|"long-poll"|
"recover"|"none", "tab_hidden", "recoveries", "resumes", "hidden_skips",
"unpainted", "wedged", "behind": bools}`. No terminal content.
The server writes one log line, `[WARN]` when a pane is `unpainted`,
`wedged` or `behind`, `[INFO]` otherwise; numbers are clamped, words
limited to 16 characters of `A-Za-z0-9_.-`, the error text to 80 plain
characters. Reply `{"ok": true}`; `400` not a JSON object, `413` too
large, `429` more than 10 per IP in 10 minutes. A server without the
action answers `404`, which a beacon ignores. Through `api.php` it is an
ordinary JSON action.

### POST /api/seal_open, POST /api/sealed?c= (sealed channel)
See [Sealed channel](#sealed-channel) below.

### GET /api/ping
Liveness (also used by the PHP shim's auto-start probe). Reply:
`{"ok": true, "version": str, "proto": int}`.

## Static files

`GET /`, `/index.html`, `/websh.js`, `/assets/websh-logo.svg` are
served from the script directory with security headers (CSP etc.);
everything else under GET → `404 {"error": "not found"}`.

## Sealed channel

An opt-in second encryption layer under TLS (the client's "Encrypt
traffic inside websh" option; what it protects: `docs/security.md`,
"Sealed traffic"). With it on, the client sends every call except
`config` and `ping` through these two actions; with it off, nothing
here is used and every request is what the sections above describe.
Without `cryptography` both answer `501 {"error": "sealed mode
unavailable"}`. Through `api.php` both pass unchanged: the body
verbatim, the reply verbatim and unbuffered, with the backend's status.

Sealed traffic uses wire version 2, negotiated separately from the plain
API's unchanged `proto: 1`. A cached wire-1 client must reload before
using encryption with this server. Unsupported handshakes fail visibly
before any protected API request; there is no insecure wire fallback.
The server identity key and existing browser identity pins do not change.

### POST /api/seal_open
Body `{"wire": 2, "pub": b64(client ephemeral P-256 public key, raw uncompressed,
65 bytes)}`. Reply 200:
`{"wire": 2, "channel": "<32 hex>", "pub": b64(server ephemeral raw 65 B),
"identity": b64(identity SPKI DER), "sig": b64(ECDSA-P256-SHA256, raw
r||s 64 B, over client_pub || server_pub || channel_ascii || ":sealed:2")}`.
Missing or unsupported `wire` gets HTTP 409 with
`{"code":"sealed_upgrade_required","wire":2,"error":<reload guidance>}`.
The client likewise refuses a missing or unsupported reply version
before deriving a usable channel or sending any protected request.
`400 {"error": "bad key"}` for a key that is not a P-256 point; shares
the per-IP side-channel rate limit (`429`).

Keys: `shared = ECDH(client_eph, server_eph)`;
`K_c2s = HKDF-SHA256(shared, salt = client_pub || server_pub, info =
"websh sealed c2s", 32 B)`, `K_s2c` the same with `"websh sealed s2c"`;
AES-256-GCM. The client verifies `sig` with `identity`, and the
fingerprint of `identity` against the one it pinned on first use,
before it uses the channel.

Channels live in server memory: idle ones expire after an hour, at
most 2000 exist (the least recently used is dropped). A restart
forgets them all.

### POST /api/sealed?c=<channel>
Frames: `iv (12 random bytes) || AES-GCM ciphertext+tag`. Request AAD
is `<channel> ":c2s"`. Response AAD is
`<channel> ":s2c:2:" <request_seq> ":" <frame_index>` in ASCII, with
decimal integers. Each response starts its frame index at 0 and advances
it once per header, body or empty end frame. The request seq is captured
for that request, not read from the shared channel's changing counter.
Another request's reply or a duplicated, reordered, omitted or foreign
frame fails authentication instead of supplying a session id or output
to the wrong pane.

Both legs are text, not binary: a security product on the owner's
machine that intercepts HTTPS answered every `application/octet-stream`
POST itself (`503 text/html`) and never let it through, while JSON
bodies and `text/event-stream` replies pass.

Request body (`application/json`): `{"f": "<base64(frame)>"}` (standard
base64 with padding), holding exactly one c2s frame whose plaintext is
one JSON header line, `\n`, then the raw inner body.
Header: `{"seq": int, "method": "GET"|"POST", "action": "<action>",
"query": {name: string}}`, and for upload pieces `"len": int` (the
number of real bytes at the start of the inner body; the rest is
padding and is dropped) and `"pad": true` (a padding-only piece: the
server replies `{"ok": true, "pad": true}` and runs nothing).

Checked in this order, and nothing is executed when one fails:
unknown or expired channel `410 {"error": "channel unknown"}`; body
missing `400 {"error": "bad frame"}`, larger than ~11 MiB `413`, shorter
than its Content-Length `400 {"error": "client sent fewer bytes than
Content-Length"}` (the upload code's "cut" signal); malformed JSON, a
missing or non-base64 `f`, a frame that does not decrypt or a
malformed header `400 {"error": "bad frame"}`; a
`seq` already used on this channel, or more than 4096 below the
highest seen, `400 {"error": "replay"}`; `seal_open`, `sealed`,
`config`, `ping` and `client_diag` inside `400`.

Otherwise the inner request goes to the same handler as the plain
`/api/<action>?<query>` with that method and body (same validation,
rate limits, access-log events; an unknown action is the inner `404`),
and the outer reply is `200 text/event-stream` (`Cache-Control:
no-cache`, `X-Accel-Buffering: no`): each s2c frame is one SSE event,
`data: <base64(frame)>` followed by a blank line, written as it is
produced. The first frame's plaintext is
`{"status": int, "headers": {...}}` (the inner status and headers -
Content-Type, Content-Length, Content-Disposition, ...); each following
frame is a piece of the inner body, sent as the handler writes it (the
SSE stream and downloads stream); an empty frame ends the reply. A
reply that stops without the empty frame is truncated: the client
treats it as a dropped connection. An inner reply that declared a
Content-Length and did not reach it (a cut download) gets no end frame.

An outer non-200 reply is unverified transport information. A proxy can
replace a successfully executed request's reply with a 410 or a busy 503,
so neither proves non-execution. Read-only GET calls may reopen a lost
channel and retry once. POST calls are never resent by the sealed fetch
boundary after an unverified response, a post-send network failure, or
an invalid or truncated encrypted reply. Their outcome is reported as
uncertain; future calls can open a fresh channel. Input drops that
uncertain batch and its queued suffix for the same session, preserves
typing for a newer session, and accepts later fresh typing. A local
handshake failure remains a safe, unsent `sealed_unavailable` hold.

The upload XHR boundary likewise does not resend a 410 internally. Its
caller may retry immutable positional pieces safely. Only normalized
transport cut/size signals are passed through; an unverified outer 409
size is never accepted as evidence that an upload is complete.
