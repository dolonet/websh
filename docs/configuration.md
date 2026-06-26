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

Env-only exceptions: `WEBSH_CONFIG` (it locates the JSON), and
`HOST` / `TRUSTED_PROXIES` — a writable `websh.json` must not be able
to rebind the loopback-only server to a public interface or take over
X-Forwarded-For trust.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8765` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `SESSION_TIMEOUT` | `300` | Idle timeout in seconds |
| `MAX_SESSIONS` | `50` | Max concurrent SSH sessions |
| `MAX_SESSIONS_PER_IP` | `0` | Max concurrent sessions per source IP (`0` disables; counts foreground + background together) |
| `WEBSH_CONFIG` | *(unset)* | Path to `websh.json`. `server.py` loads a config only when this is set; the PHP proxy computes a default (`../../websh.json`). |
| `WEBSH_VAULT_ENABLE` | `0` | Set to `1` to enable the encrypted credential vault endpoints and saved-credential UI (requires `cryptography`). The bundled `websh.service` and Docker image ship the dependency and a writable creds path, so enabling the vault there is a one-line opt-in. See [`encryption.md`](encryption.md). |
| `WEBSH_CREDS_PATH` | *(sibling of `WEBSH_CONFIG`)* | Path to the encrypted credential store `websh.creds.json`. See [`encryption.md`](encryption.md). Created lazily on first user save with mode `0600`. |
| `WEBSH_REQUIRE_VAULT` | `0` | Set to `1` to make legacy plaintext credentials in `websh.json` a fatal startup error (forces migration to the vault) instead of a warning. See [`encryption.md`](encryption.md). |
| `TRUSTED_PROXIES` | `127.0.0.1` | Comma-separated IPs to trust `X-Forwarded-For` from |
| `MAX_BG_SESSIONS` | `50` | Max background SSH sessions (file upload/download) |
| `MAX_UPLOAD_SIZE` | `2147483648` (2 GiB) | Hard cap on a single `/api/upload` (bytes) |
| `MAX_DOWNLOAD_SIZE` | `2147483648` (2 GiB) | Hard cap on a single `/api/download` (bytes); the browser accumulates the stream into a Blob, so this also protects the tab |
| `UPLOAD_TIMEOUT` | `1800` | Seconds before the side-channel ssh for an in-flight upload is killed |
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
| `WEBSH_ACCESS_LOG` | *(unset)* | Path to a JSON-line access log; when unset, no access log is written. See [`security.md`](security.md#access-log) for the record format. |

The PHP proxy reads `WEBSH_PORT` (default `8765`) to find the backend —
and since the alias rule above makes `server.py` honor `WEBSH_PORT`
too, in the shared-hosting flow (where the auto-started backend
inherits PHP's environment) that one variable points both sides at the
same port. Under systemd the unit's `PORT=` still pins the backend.
