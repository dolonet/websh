# Configuration

Environment variables for `server.py`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8765` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `SESSION_TIMEOUT` | `300` | Idle timeout in seconds |
| `MAX_SESSIONS` | `50` | Max concurrent SSH sessions |
| `MAX_SESSIONS_PER_IP` | `0` | Max concurrent sessions per source IP (`0` disables; counts foreground + background together) |
| `WEBSH_CONFIG` | *(auto-detected)* | Path to `websh.json` config file |
| `WEBSH_CREDS_PATH` | *(sibling of `WEBSH_CONFIG`)* | Path to the encrypted credential store `websh.creds.json`. See [`encryption.md`](encryption.md). Created lazily on first user save with mode `0600`. |
| `TRUSTED_PROXIES` | `127.0.0.1` | Comma-separated IPs to trust `X-Forwarded-For` from |
| `MAX_BG_SESSIONS` | `50` | Max background SSH sessions (file upload/download) |
| `WEBSH_MAX_THREADS` | `4 × (MAX_SESSIONS + MAX_BG_SESSIONS) + 64` (`464` at defaults) | Hard cap on concurrent HTTP worker threads. New requests past the cap get an immediate `503 {"error":"busy"}`. Values below `1` are clamped to `1` with a startup WARN; there is no "unlimited" mode by design. |
| `RATE_LIMIT_MAX` | `50` | Max `/api/connect` attempts per IP per window |
| `RATE_LIMIT_WINDOW` | `60` | Rate-limit window in seconds |
| `SCAN_PATTERN_THRESHOLD` | `0` | One IP that probes at least N distinct deny-listed targets in `SCAN_PATTERN_WINDOW` seconds gets `result=scan_pattern` events emitted starting on the Nth probe; `0` disables. ANY successful connect from the same IP clears state, so legitimate users never accumulate. |
| `SCAN_PATTERN_WINDOW` | `300` | Sliding window for scan-pattern detection, in seconds |
| `WEBSH_TMUX_IDLE_TTL` | `259200` | Seconds a detached persistent tmux session may idle on the target before it's reaped (default 72h, `0` disables) |
| `WEBSH_TMUX_WATCHDOG_POLL` | `300` | Seconds between idle-TTL watchdog checks on the target |
| `WEBSH_ACCESS_LOG` | *(unset)* | Path to a JSON-line access log; when unset, no access log is written. See [`security.md`](security.md#access-log) for the record format. |

The PHP proxy reads `WEBSH_PORT` (default `8765`) to find the backend.
