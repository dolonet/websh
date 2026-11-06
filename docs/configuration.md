# Configuration

Tunables for `server.py`. Each knob resolves in this order:

1. `WEBSH_<NAME>` environment variable — the unambiguous alias wins,
   so a bare generic name (`PORT`, `HOST`, `MAX_SESSIONS`, …) set by
   unrelated software in a shared environment can't hijack websh;
2. `<NAME>` environment variable (the names in the table below);
3. the optional `"server"` object in `websh.json` — the only plane a
   shared-hosting deployment can reliably write to (`api.php`'s
   auto-start guarantees only `WEBSH_CONFIG` and `PORT`; whether
   anything else survives into the environment depends on the host):

   ```json
   { "server": { "SESSION_TIMEOUT": 600, "MAX_SESSIONS": 20 } }
   ```

4. the built-in default.

The `"server"` object is read once at startup (knobs are
process-lifetime constants). Keys use the same names as the table
below — including the `WEBSH_` prefix where the table has one, e.g.
`{"server": {"WEBSH_VAULT_ENABLE": true}}`. Boolean knobs accept
`1`/`true` (env string or JSON literal).

Env-only exceptions — a writable `websh.json` must not be able to
change these, so a `"server"` key with one of these names is ignored
and logged as a `WARN` at startup (as is any name no knob reads):

- `WEBSH_CONFIG` (it locates the JSON);
- `HOST`, `TRUSTED_PROXIES` — rebinding the loopback-only server to a
  public interface, or taking over X-Forwarded-For trust;
- `WEBSH_SOCKET`: choosing the filesystem path the backend binds and
  removes during Unix-socket startup;
- `WEBSH_AUTH_HEADER` — flipping authentication semantics;
- `WEBSH_ACCESS_LOG`, `WEBSH_CREDS_PATH`, `WEBSH_RECORD_DIR`,
  `WEBSH_SEALED_KEY_FILE` — paths the server writes to (arbitrary-path
  file create/overwrite);
- `WEBSH_RECORD_INPUT` — ignored everywhere, see below.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8765` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `WEBSH_SOCKET` | *(unset)* | Listen on this Unix socket path instead of `HOST`:`PORT`. The socket is created `0600`, so only the websh user can connect; clients on it are trusted like `TRUSTED_PROXIES`. The resolved parent must belong to that user and have no group or other-user write permission. Every resolved ancestor must belong to that user or root and have no such write permission, except root-owned sticky ancestors such as `/tmp`. The PHP proxy always uses a socket (default `websh.sock` next to `websh.json`); see [`deployment.md`](deployment.md#shared-hosting-php--python). |
| `SESSION_TIMEOUT` | `300` | Idle timeout in seconds |
| `MAX_SESSIONS` | `50` | Max concurrent SSH sessions |
| `MAX_SESSIONS_PER_IP` | `0` | Max concurrent sessions per source IP (`0` disables; counts foreground + background together) |
| `WEBSH_CONFIG` | *(unset)* | Path to `websh.json`. `server.py` loads a config only when this is set; the PHP proxy computes a default (`../../websh.json`). A path that does not exist means "no config". A file that exists but cannot be read or parsed stops the server from starting; if it breaks while the server runs, the last version that loaded stays in force (logged at ERROR) until it is fixed - it never falls back to the permissive empty config. |
| `WEBSH_VAULT_ENABLE` | `0` | Set to `1` to enable the encrypted credential vault endpoints and saved-credential UI (requires `cryptography`). The bundled `websh.service` and Docker image ship the dependency and a writable creds path, so enabling the vault there is a one-line opt-in. See [`encryption.md`](encryption.md). |
| `WEBSH_CREDS_PATH` | *(sibling of `WEBSH_CONFIG`)* | **Env-only.** Path to the encrypted credential store `websh.creds.json`. See [`encryption.md`](encryption.md). Created lazily on first user save with mode `0600`. |
| `WEBSH_SEALED_KEY_FILE` | `websh.sealed.key` next to the credential store (`WEBSH_CREDS_PATH`'s directory) | **Env-only.** The sealed channel's identity key (ECDSA P-256, PEM). Created with mode `0600` on first start when missing; its fingerprint is logged at start (`sealed channel: identity …`) and pinned by browsers on first use, so keep it across reinstalls - a new key makes every browser that pinned the old one ask whether to trust it. An existing file that cannot be read or is not a P-256 key is never overwritten: sealed mode stays unavailable (logged at `ERROR`). Needs `cryptography`; independent of `WEBSH_VAULT_ENABLE`. See [`security.md`](security.md#sealed-traffic). |
| `WEBSH_REQUIRE_VAULT` | `0` | Set to `1` to make legacy plaintext credentials in `websh.json` a fatal startup error (forces migration to the vault) instead of a warning. If the file is edited into that state while the server runs, the config is served as empty and one `ERROR` is logged per file version. See [`encryption.md`](encryption.md). |
| `TRUSTED_PROXIES` | `127.0.0.1` | Comma-separated IPs to trust `X-Forwarded-For` (and `WEBSH_AUTH_HEADER`) from |
| `WEBSH_AUTH_HEADER` | *(unset)* | **Env-only.** Header-trust authentication: set to a header name (e.g. `Remote-User` from oauth2-proxy/Authelia) and every request except `/api/ping` requires it; sessions are stamped with their creator's identity and cross-user access is `403`. The header is only read from `TRUSTED_PROXIES` peers. Mutually exclusive with `WEBSH_VAULT_ENABLE` — the server refuses to start with both set (the vault is keyed by a client-supplied id, not by identity). See [`security.md`](security.md#header-trust-authentication). |
| `MAX_BG_SESSIONS` | `50` | Max background SSH sessions (file upload/download) |
| `MAX_UPLOAD_SIZE` | `2147483648` (2 GiB) | Hard cap on a single `/api/upload` (bytes) |
| `MAX_DOWNLOAD_SIZE` | `2147483648` (2 GiB) | Hard cap on a single `/api/download` (bytes); the browser accumulates the stream into a Blob, so this also protects the tab |
| `UPLOAD_TIMEOUT` | `1800` | Seconds before the side-channel ssh for an in-flight upload is killed |
| `OUTPUT_REPLAY_BYTES` | `524288` (512 KiB) | Per-session replay window for lossless reconnect: a client that reconnects with its output cursor gets everything produced since, as long as it is still within this window (older bytes are reported to it as lost). Min 4096. |
| `TRANSFER_IDLE_TIMEOUT` | `60` | Seconds to wait for the side-channel ssh to produce the download header / next chunk, or to accept the next upload chunk, before the helper is killed (download → `504`, upload → error). Bounds a wedged ControlMaster, which otherwise pinned a worker thread for the life of the session. |
| `MAX_BODY_SIZE` | `8388608` (8 MiB) | Cap on the in-memory request body for control/JSON endpoints (connect, input, resize, save, …); stops a bogus Content-Length from buffering gigabytes into RAM |
| `WEBSH_MAX_THREADS` | `4 × (MAX_SESSIONS + MAX_BG_SESSIONS) + 64` (`464` at defaults) | Hard cap on concurrent HTTP worker threads. New requests past the cap get an immediate `503 {"error":"busy"}`. Values below `1` are clamped to `1` with a startup WARN; there is no "unlimited" mode by design. |
| `RATE_LIMIT_MAX` | `50` | Max `/api/connect` attempts per IP per window |
| `RATE_LIMIT_WINDOW` | `60` | Rate-limit window in seconds |
| `SIDE_CHANNEL_RATE_MAX` | `240` | Max side-channel calls (`ls`/`download`/`upload`/`tmux_capture`) per IP per window; far higher than the connect limit because file browsing makes many `ls` calls. |
| `SIDE_CHANNEL_RATE_WINDOW` | `60` | Side-channel rate-limit window in seconds. |
| `SCAN_PATTERN_THRESHOLD` | `0` | One IP that probes at least N distinct deny-listed targets in `SCAN_PATTERN_WINDOW` seconds gets `result=scan_pattern` events emitted starting on the Nth probe; `0` disables. ANY successful connect from the same IP clears state, so legitimate users never accumulate. |
| `SCAN_PATTERN_WINDOW` | `300` | Sliding window for scan-pattern detection, in seconds |
| `WEBSH_TMUX_IDLE_TTL` | `259200` | Seconds a detached persistent tmux session may idle on the target before it's reaped (default 72h, `0` disables) |
| `WEBSH_TMUX_WATCHDOG_POLL` | `300` | Seconds between idle-TTL watchdog checks on the target (clamped to a minimum of `5`) |
| `WEBSH_TMUX_CAPTURE_LINES` | `100000` | Max lines `/api/tmux_capture` reads from the tmux scrollback (`-S -N`); bounds capture RAM. |
| `WEBSH_TMUX_CAPTURE_BYTES` | `16777216` (16 MiB) | Absolute byte ceiling on a tmux capture; output past it is truncated to the freshest tail with a marker. |
| `WEBSH_INPUT_LAT_INTERVAL` | `300` | Length of a window of the server's `input_lat` log lines (one line per session that received input in it, written by the 30 s cleanup tick after the window ends; see [`protocol.md`](protocol.md#post-apiclient_lat)). Meant to be shortened by tests. |
| `WEBSH_ACCESS_LOG` | *(unset)* | **Env-only.** Path to a JSON-line access log; when unset, no access log is written. See [`security.md`](security.md#access-log) for the record format. |
| `WEBSH_RECORD_DIR` | *(unset)* | **Env-only.** Opt-in session recording: directory for one [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) `.cast` file per session (created `0600`, named `<timestamp>-<sid>.cast`; replayable with `asciinema play`). Output-only — keystrokes are never recorded. Best-effort: a write failure disables recording for that session, never the session itself. Mind retention/privacy — see [`security.md`](security.md#session-recording). |
| `WEBSH_RECORD_INPUT` | *(ignored)* | Keystroke recording is hard-disabled: the `"i"` event is never written, whatever this is set to. Setting it only produces a startup `WARN`. See [`security.md`](security.md#session-recording). |
| `WEBSH_RECORD_MAX_BYTES` | `67108864` (64 MiB) | Per-recording ceiling; hitting it stops that recording with one `WARN` and never touches the session. `0` disables the cap. |

The PHP proxy talks to the backend over `WEBSH_SOCKET` (default
`websh.sock` next to `websh.json`) and starts `server.py` with that
same value, so `PORT` and `HOST` play no part in the shared-hosting
flow. Under systemd the unit's `PORT=` still pins the backend.
