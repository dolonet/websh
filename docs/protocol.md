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
`{"ok": bool, "alive": bool}`.

### GET /api/output?session_id=
Long-poll: waits up to ~10 s for PTY output. Reply:
`{"data": base64, "alive": bool, "auth_failed": bool}`. An empty
`data` with `alive: true` is a keepalive; `alive: false` is terminal.

### GET /api/stream?session_id=
SSE variant of `output` (one concurrent stream per session; a second
attach waits ~250 ms for the slot then gets `409`). Framing: a
`: ok` comment primer plus an empty *named* `event: data` event (the
client's buffering-proxy detection depends on receiving it promptly),
then named `event: data` events carrying the same JSON payload shape
as `output`, `: keepalive` comment heartbeats, and a final
`event: end` + `data: {"alive": false, ...}`. Note the events are
named — a bare `EventSource.onmessage` consumer sees nothing.

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

All side-channel endpoints (`upload*`, `ls`, `download`,
`tmux_capture`, `tmux_options`) share a per-IP rate limit →
`429 {"error": "rate_limited"}`.

### POST /api/upload?session_id=&path=
Raw request body = file bytes (`Content-Length` required, capped by
`MAX_UPLOAD_SIZE` → `413`). `path` is `$HOME`-relative, no `..`/NUL.
Streams into `$HOME/<path>` over the ControlMaster. Reply
`{"ok": true, "bytes": n, "path": "$HOME/<path>"}` / `{"error": ...}`.

### POST /api/upload_finalize
Body: `session_id`, `tmp`, `final`. Moves `$HOME/<tmp>` into the
foreground tmux pane's cwd with collision auto-increment. Reply
`{"ok": true, "path": abs}` or `{"ok": false, "non_persistent": true}`
(client falls back to a foreground `mv`).

### POST /api/upload_cancel
Body: `session_id`, `tmp`. Best-effort `rm` of the staged file.
Reply `{"ok": true}`.

### GET /api/ls?session_id=&path=
Remote directory listing. Reply: `{"path": abs, "entries":
[{"name", "type": "d|f|l|o", "size", "mtime"}, ...]}`.

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
additive fields).

### GET /api/ping
Liveness (also used by the PHP shim's auto-start probe). Reply:
`{"ok": true, "version": str, "proto": int}`.

## Static files

`GET /`, `/index.html`, `/websh.js`, `/assets/websh-logo.svg` are
served from the script directory with security headers (CSP etc.);
everything else under GET → `404 {"error": "not found"}`.
