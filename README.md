# <img src="assets/websh-logo.svg" alt="" width="56" height="56" align="absmiddle"> websh

**English** | [Русский](README.ru.md)

Browser-based SSH terminal. Plain HTTP, no build, no extra services.

- 📦 No npm, no pip — drop the files in and run
- 🌐 Corporate networks with only HTTPS open: works without WebSocket
- ⭐ Sessions survive tab close, reboot, and backend restart for up to 72 h (via tmux on the target host)

![websh split panes](screenshot.png)

```
┌─ Your browser ─┐    HTTPS     ┌── websh host ──┐     SSH      ┌──── Remote ────┐
│                │              │                │              │                │
│    xterm.js    │─── POST ────►│   server.py    │◄────────────►│      bash      │
│                │◄─── SSE ─────│    (Python)    │              │     + tmux     │
│                │              │                │              │                │
└────────────────┘              └────────────────┘              └────────────────┘
```

## How it works

Three pieces:

- **Browser.** xterm.js renders the terminal. Each keystroke goes up as a POST to `/api/input`.
- **websh host.** `server.py` runs each SSH connection as a PTY subprocess and streams output back over Server-Sent Events on `/api/stream`. The same process serves the frontend, so you don't need a separate web server.
- **Remote.** The host you SSH into. Optionally wrapped in tmux so the session survives reconnects.

If a proxy buffers SSE (some shared hosts do), the client falls back to long-polling on `/api/output` for that session. Slower, but works.

Shared hosting that doesn't allow long-lived processes? Ship `api.php` next to `server.py`. The PHP shim starts the backend on the first request and proxies the API to it.

**Why not WebSocket?** Many shared-hosting PHP setups don't proxy it — websh has to drop in there too. SSE gives the same low latency on plain HTTP and tunnels through any HTTPS proxy without a protocol upgrade.

For deeper internals — buffer-detection probe, lost-byte handling on disconnect, selectors-based wait — see [`docs/sse-transport.md`](docs/sse-transport.md).

## Requirements

- **Backend.** Python 3.9+ with `ssh` in PATH. Stdlib only — no pip dependencies.
- **Browser.** Any modern browser. xterm.js is loaded from a CDN.
- **Optional persistent sessions.** `tmux` on the target host — any
  reasonably recent version. See
  [`docs/persistent-sessions.md`](docs/persistent-sessions.md).
- **Optional shared-hosting proxy.** PHP with the `curl` extension, from a
  [supported branch](https://www.php.net/supported-versions.php) or a
  vendor package that still gets security fixes — see
  [`docs/deployment.md`](docs/deployment.md#keep-php-patched).
- **Optional reverse proxy.** nginx, Caddy, or Apache.

## Highlights

### 🖥️ Terminal

Real xterm.js — copy-on-select, right-click paste, `Ctrl+V` paste (on by default; switch it off in ⚙ Options to send a literal `^V` to the shell), scrollback search (`Ctrl+Shift+F`), zoom (`Ctrl+±`), fullscreen (`F11`).

- Split panes, horizontal or vertical, with draggable dividers
- Pane switching with `Ctrl+Tab` / `Ctrl+Shift+Tab`
- Font picker (⚙) with live preview — JetBrains Mono, Fira Code, IBM Plex Mono, Roboto Mono, Source Code Pro, Inconsolata, or system default. Custom size, line-height, weight

### 🔁 Persistent sessions

Tick **Persistent session** at connect — websh wraps the shell in a tmux session on the target host. Close the tab, reboot, restart `server.py`: the pane re-attaches to the same tmux session with scrollback and running processes intact. See [`docs/persistent-sessions.md`](docs/persistent-sessions.md).

- One quiet reconnect bar on disconnect; a rejected password or key opens a dialog to re-enter credentials instead of looping
- URL anchors (`#connect=Production`) for direct links and bookmarks
- Saved connections in browser `localStorage`

### 🛡️ Resilience

- **Nothing lost on reconnect.** Output is read by cursor from a replay window, so a dropped stream, a sleeping laptop or a proxy that cut the connection resumes exactly where it stopped — no gap, no duplicate.
- **Keys arrive in the order typed.** One input request per pane is in flight at a time; what is typed meanwhile goes as the next batch.
- **Comes back by itself after a Wi-Fi switch or sleep.** A connection that died silently raises no error in the browser. websh notices within seconds — a server heartbeat, the output offset in every input reply, the browser's network and wake-up events — and restarts the output channel; no page reload.
- **A long absence costs a few seconds.** When the server-side session has expired, a persistent pane re-attaches to the same tmux shell on its own, and keys typed meanwhile are delivered once tmux is ready. Keys are never replayed into a *new* shell.
- **A websh restart or deploy does not disconnect anyone.** Panes find their sessions again on the restarted server.
- **Transport self-heals.** A closed SSE stream is reopened on its own; a proxy that buffers SSE sends that pane to long-polling, which keeps probing the stream in the background and switches back when it works; brief network errors are retried rather than ending the session.
- **Clean teardown.** The ssh child is always reaped (no zombies holding session slots), idle sessions time out, the last output of a session is delivered before it is marked ended, and a client hanging up mid-request is routine, not a server error.

### 📁 File transfer

Upload and download without `scp`.

- **Upload.** Pick files or drop them on a pane; the browser streams the bytes through a piggybacked SSH ControlMaster channel (`cat > $HOME/<tmp>`, no PTY, no base64) in 4 MB pieces, each retried on its own and resumed from where the previous one ended — so a corporate proxy or a VPN that cuts long requests no longer means switching networks to upload a file. Dropping them on the **file browser** instead — or using its **Upload** button — puts them in the folder you are looking at, keystroke-free on any pane. Otherwise the destination is where the shell is standing: `pane_current_path` on persistent (tmux) panes, or an `mv` typed into the foreground shell with an alt-screen guard. Auto-increment on name conflicts. Native xhr.upload progress, multi-file queue, cancel mid-flight.
- **Download.** Select a filename in the terminal, click Download.
- **Browse.** The file browser opens in the directory the pane is actually sitting in, not at `$HOME` — read from the shell's OSC 7 signal, or from `pane_current_path` on tmux panes. Clickable breadcrumb path, live name filter, and a dotfile toggle. Sort by name, size, or date (newest-first by default; the choice is remembered). Per-row **rename** (✎) and **delete** (✕, two-step confirm, never recursive), plus **New folder** — all keystroke-free over the SSH side channel, so a full-screen program in the foreground pane stays untouched. Tick several rows (shift-click picks a run) to **download** or **delete** them in one go: one question for the batch, then one audited request per entry, with a summary that names whatever failed.
- **Export scrollback.** Save the current buffer as a text file. Persistent panes pull the real tmux scrollback via `tmux capture-pane`.

### 🔐 Connection profiles

From free-form "type a host and go" to strictly allowlisted click-to-connect. See [`docs/server-side-connections.md`](docs/server-side-connections.md).

- Password and SSH key auth
- Server-side profiles in `websh.json` — credentials stay on the server; the browser never sees them
- **Ready** (saved creds) and **Prompt** (allowlisted target, user types own password) profile kinds
- `allowed_users` / `denied_users` per profile
- Per-profile SSH options (`ProxyJump`, `StrictHostKeyChecking`, …)
- `restrict_hosts: true` hides the free-form form entirely

### 🚀 Deployment

- **Shared hosting.** Upload 4 files + `assets/` via FTP; `api.php` starts the backend on demand. No SSH access to the host needed.
- **Python only.** The backend serves the frontend itself — zero extras.
- **Docker, systemd, reverse proxy.** Recipes in [`docs/deployment.md`](docs/deployment.md).
- Plain HTTP transport with automatic long-poll fallback for hosts that buffer SSE.

## Use cases

- **Corporate firewalls** — SSH port blocked, only HTTPS open. websh tunnels through standard HTTPS.
- **No native terminal** — Chromebooks, iPads, kiosks. Any browser becomes a terminal.
- **Customer access** — give a customer a browser link to their own server. URL anchors (`#connect=ServerName`) for direct links.
- **Bastion UI** — install websh on a jump host, reach internal servers from any browser.
- **Recovery from a foreign machine** — open a URL, you're in.
- **Workshops** — students don't install anything locally.

## Quick start (your machine)

```bash
git clone https://github.com/dolonet/websh.git
cd websh
python3 server.py
```

Open http://localhost:8765 — that's it. No pip install, no npm, no build step.

Requires Python 3.9+ and `ssh` in your PATH. The server binds to
`127.0.0.1` by default; set `HOST=0.0.0.0` to expose it on the LAN.

## Quick start (shared hosting)

**No SSH access required.** Upload `index.html`, `websh.js`, `api.php`,
`server.py`, and the `assets/` folder into a folder in your web root.
Open it in a browser. `api.php` starts `server.py` automatically on the
first request.

Run it on a PHP version that still gets security fixes — most control
panels let you pick it per site; see
[`docs/deployment.md`](docs/deployment.md#keep-php-patched).

`websh.json` (optional, for server-side connections) lives **outside**
the web root — `api.php` looks two directories up from itself by
default. Override with `WEBSH_CONFIG=/path/to/websh.json`.

Full directory layout, troubleshooting, and config-path notes:
[`docs/deployment.md`](docs/deployment.md).

## Configuration

The only things most deployments need to change:

```bash
PORT=8765           # listen port
HOST=127.0.0.1      # bind address (use 0.0.0.0 for LAN)
WEBSH_CONFIG=...    # path to websh.json (auto-detected by api.php)
```

Full table of environment variables (rate limits, session caps, tmux
idle-TTL, access log path, …): [`docs/configuration.md`](docs/configuration.md).

## Deployment

- **Shared hosting (PHP + Python)** — FTP-drop the 4 files + `assets/`. See [`docs/deployment.md`](docs/deployment.md#shared-hosting-php--python).
- **Python only** — `python3 server.py` for local use; put a TLS/auth reverse proxy in front before exposing it. See [`docs/deployment.md`](docs/deployment.md#python-only-no-php).
- **Docker** — `docker build -t websh . && docker run -d -p 127.0.0.1:8765:8765 websh`. See [`docs/deployment.md`](docs/deployment.md#docker).
- **systemd** — `websh.service` unit included. See [`docs/deployment.md`](docs/deployment.md#systemd).
- **HTTPS via reverse proxy** — nginx / Caddy in front for TLS. See [`docs/deployment.md`](docs/deployment.md#https-via-reverse-proxy).

## Security

**websh has no built-in authentication** — add it at the web-server layer
(`auth_basic`, Cloudflare Access, Tailscale Funnel, IP allowlists, etc.).
For threat-model details, rate limiting, the JSON access log, fail2ban
integration, and host-key handling see [`docs/security.md`](docs/security.md).
For the encrypted credential vault that closes the saved-password
plaintext caveat see [`docs/encryption.md`](docs/encryption.md).

## Documentation

| Topic | File |
|---|---|
| Server-side connection profiles | [`docs/server-side-connections.md`](docs/server-side-connections.md) |
| Persistent sessions (tmux) | [`docs/persistent-sessions.md`](docs/persistent-sessions.md) |
| Authentication & security | [`docs/security.md`](docs/security.md) |
| Encrypted credential vault | [`docs/encryption.md`](docs/encryption.md) |
| Configuration reference | [`docs/configuration.md`](docs/configuration.md) |
| Deployment recipes | [`docs/deployment.md`](docs/deployment.md) |
| SSE transport design | [`docs/sse-transport.md`](docs/sse-transport.md) |
| Auth-failure detection | [`docs/auth-fail-detection.md`](docs/auth-fail-detection.md) |
| HTTP API | [`docs/protocol.md`](docs/protocol.md) |
| Invariants: what must never break | [`docs/invariants.md`](docs/invariants.md) |
| Working on the code | [`AGENTS.md`](AGENTS.md) |

## Project structure

```
index.html                Frontend — xterm.js terminal + connection UI
websh.js                  Frontend logic — pane management, file transfer
api.php                   PHP proxy — forwards browser requests to backend (optional)
server.py                 Python backend — manages SSH sessions via PTY, serves frontend
assets/                   Brand SVG (logo) loaded by index.html
websh.json.example        Example server-side config
test_server.py            Back-compat runner for the backend suite
tests/backend/            Backend tests — unit + integration (unittest)
tests/frontend/           Frontend tests on jsdom
tests/php/                PHP proxy smoke test
tests/e2e/                Browser scenarios: real Chromium, real ssh, network faults
scripts/                  check.sh (all tests), e2e.sh, deploy.sh, codemap.py
AGENTS.md                 Guide for contributors and coding agents
.github/workflows/        CI: backend matrix, frontend, PHP, ruff, Docker
docs/                     Design notes & reference docs
Dockerfile                Container deployment
websh.service             systemd unit file
LICENSE                   MIT license
```

## Tests

```bash
# Backend (Python, stdlib only — unittest): ~680 tests
python3 -m unittest discover -s tests/backend -t .   # or: python3 test_server.py -v

# Frontend (Node 20 + jsdom): ~1170 assertions
cd tests/frontend && npm install && npm test

# PHP proxy (needs php-cli with curl) and lint
php -l api.php && bash tests/php/smoke.sh
ruff check .

# All of the above, with one verdict
scripts/check.sh

# Browser scenarios: Wi-Fi switch, sleep, restart, typing order (tests/e2e/README.md)
scripts/e2e.sh
```

CI runs all of it on every push and PR: the backend on Python 3.9 and 3.12, each with and without `cryptography` (the vault's optional dependency), plus the frontend suite, the PHP smoke test, ruff, and a Docker build that boots the image and checks `/api/ping`, `/api/config` and the page.

Backend line + branch coverage of `server.py` is about 88%:

```bash
pip install coverage
coverage run --branch --include=server.py -m unittest discover -s tests/backend -t .
coverage report
```

The suites are built to be deterministic: backend I/O paths are tested with scripted sessions instead of sleeps, the frontend harness waits for the app's own boot signal, and an unhandled rejection is reported as a failure of the running scenario instead of silently ending the run. A green run means `failed: 0` — treat any other result as red.

## License

MIT
