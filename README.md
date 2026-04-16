# websh

Lightweight but powerful web-based SSH terminal. No build step, no server dependencies.

![websh split panes](screenshot.png)

```
Browser (xterm.js) ──── server.py ──── ssh
```

## How it works

The browser runs a full terminal emulator (xterm.js) and communicates with the Python backend via HTTP long-polling. The backend manages SSH sessions as PTY subprocesses and serves the frontend directly.

On shared hosting where you can't run a long-lived process, an optional PHP proxy (`api.php`) auto-starts the backend and forwards requests to it.

**Why not WebSocket?** Most shared hosting PHP environments don't support WebSocket. HTTP long-polling works everywhere — no open ports, no special server configuration. The trade-off is slightly higher latency compared to a native SSH client, but it's negligible for interactive use.

## Requirements

- **Backend:** Python 3.5+ with `ssh` command available
- **Proxy:** PHP 5.3+ with curl extension (shared hosting) — or any reverse proxy (nginx, Apache)
- **Browser:** Any modern browser (Chrome, Firefox, Safari, Edge)
- **Frontend:** Loads [xterm.js](https://xtermjs.org/) from CDN (no npm, no build step)

## Use cases

- **Shared hosting** — no SSH client on the server? Upload 3 files via FTP, open in browser, done.
- **Corporate networks** — SSH port blocked, but HTTPS is open? websh tunnels SSH through standard HTTPS.
- **Chromebooks & tablets** — any device with a browser becomes a terminal.
- **Customer support / managed servers** — give clients browser-based access to their servers without teaching them PuTTY or terminal. Use URL anchors (`#connect=ServerName`) for direct links.
- **Jump host UI** — put websh on a bastion host, access internal servers through it from any browser.
- **Emergency access** — any browser, any computer, just open a URL.
- **Teaching & workshops** — provide students with browser-based terminal access, no local setup required.

## Features

- Full terminal emulator in the browser ([xterm.js](https://xtermjs.org/))
- **Split panes** — divide the screen horizontally or vertically, each pane is an independent SSH session
- Draggable resize handles between panes (mouse and touch)
- **Reconnect on disconnect** — one-click reconnect when a session closes, red "Authentication failed" banner when SSH rejects credentials
- **Persistent sessions (tmux)** — optional per-pane. The remote shell is wrapped in a tmux session on the target, so browser refresh or `server.py` restart resume the pane with scrollback and running processes intact. See [Persistent sessions](#persistent-sessions-tmux) below
- **Auto keep-alive** — sessions stay alive as long as any browser tab is open; they expire naturally once the tab closes (server-side default: 5 min idle after tab close)
- **Keyboard pane switching** — Ctrl+Tab / Ctrl+Shift+Tab to cycle between panes
- Password and SSH key authentication
- Server-side connection config — users click to connect, no passwords on the client
- Per-connection SSH options (ProxyJump, StrictHostKeyChecking, etc.)
- Restrict mode — limit connections to pre-configured hosts only
- Auto-start — PHP launches the backend automatically, no SSH needed for setup
- Saved connections (browser localStorage)
- **File upload** — click the upload button, pick files, they upload via background SSH session (atomic writes, auto-increment on name conflict)
- **File download** — select filename in terminal, click download, file saves to your browser
- **Export terminal** — save scrollback buffer as text file
- **URL anchors** — `#connect=ServerName` for direct links to server-side connections
- Copy on select, right-click paste
- Search terminal buffer (Ctrl+Shift+F)
- Zoom (Ctrl+/-)
- Dark / light theme toggle (persisted)
- Fullscreen mode (F11)
- Rate limiting on connection attempts
- Session timeout, auto-cleanup, terminal resize

## Quick start (your machine)

```bash
git clone https://github.com/dolonet/websh.git
cd websh
HOST=0.0.0.0 python3 server.py
```

Open http://localhost:8765 — that's it. No pip install, no npm, no build step.

Requires Python 3.5+ and `ssh` in your PATH.

## Quick start (shared hosting)

**No SSH access required.** Upload files via FTP, open in browser.

A typical shared hosting directory structure:

```
/home/user/
  example.com/              <- site root
    websh.json              <- config (OUTSIDE www — not accessible via HTTP)
    www/                    <- web root (public)
      console/
        index.html          <- frontend
        websh.js            <- frontend logic
        api.php             <- PHP proxy
        server.py           <- backend (auto-started by api.php)
```

**Steps:**

1. Create a folder in your web root (e.g. `www/console/`)
2. Upload `index.html`, `websh.js`, `api.php`, and `server.py` there
3. Open `https://your-host/console/` in a browser

That's it. `api.php` starts `server.py` automatically on the first request.

> **Path details:** `api.php` looks for `websh.json` two directories up from itself
> (i.e. the site root, above `www/`). This works for most hosting providers.
> If your layout is different, set the `WEBSH_CONFIG` environment variable
> or edit the path in `api.php` line 34.

### Troubleshooting

**"Backend unavailable" or blank page:**
- Check that Python 3 is installed: `python3 --version`
- Check that `ssh` is available: `which ssh`
- Some shared hosts disable `exec()` in PHP — ask your hosting provider or check `phpinfo()`

**Config not loading:**
- Verify `websh.json` path — `api.php` looks two directories up by default
- Set `WEBSH_CONFIG=/full/path/to/websh.json` environment variable if your layout differs
- Check JSON syntax: `python3 -c "import json; json.load(open('websh.json'))"`

**Port already in use:**
- Another instance of `server.py` may be running: `ps aux | grep server.py`
- Change the port: `PORT=8766 python3 server.py`

## Server-side connections (optional)

Pre-configure connections so users just click to connect — no passwords
on the client. Create `websh.json` in your **site root** (not in `www/`):

```json
{
  "restrict_hosts": false,
  "connections": [
    {
      "name": "Production",
      "host": "server.example.com",
      "port": 22,
      "username": "deploy",
      "password": "secret"
    }
  ]
}
```

See `websh.json.example` for a full example including SSH key auth and custom SSH options.

> **This file contains passwords — keep it outside the web root.**
> It must not be accessible via HTTP. If your hosting layout doesn't match
> the diagram above, set the `WEBSH_CONFIG` environment variable.

### Per-connection SSH options

Override default SSH behavior for specific connections:

```json
{
  "name": "Strict server",
  "host": "secure.example.com",
  "username": "admin",
  "password": "secret",
  "ssh_options": {
    "StrictHostKeyChecking": "yes",
    "ProxyJump": "bastion.example.com"
  }
}
```

### Connection kinds: Ready vs Prompt

Each `connections[]` entry is one of two kinds, auto-detected by whether
a `password` or `key` is present:

- **Ready** — credentials (`password` or `key`) are stored server-side.
  The user clicks the card and connects. The browser never sees the
  credentials.
- **Prompt** — no `password` and no `key`. The entry acts as an
  allowlisted target: the user clicks the card, the manual form appears
  pre-filled (host/port locked, username locked if fixed) and the user
  types their own password or key.

Prompt entries may carry optional `allowed_users` (whitelist) or
`denied_users` (blacklist) to restrict which usernames may connect.
`allowed_users` wins if both are set. These rules are ignored when the
entry has a fixed `username` (there's no choice to police). Saving the
typed credentials locally via the "Save this connection" checkbox works
the same as with the free manual form.

```json
{
  "name": "Shared DB",
  "host": "db.example.com",
  "port": 2222,
  "allowed_users": ["alice", "bob"]
}
```

### Restrict mode

Set `"restrict_hosts": true` to hide the free-form manual connection form
entirely. Users can only go through a configured connection card. Raw
manual-path POSTs to `/api/connect` (bypassing the UI) are also rejected.
With a single connection, the UI auto-selects it on load — Ready connects
immediately, Prompt surfaces the locked form ready for a password.

### Security note on user lists

`allowed_users` / `denied_users` apply only inside the **named** connection
flow (`{connection: "<name>"}` on `/api/connect`). When `restrict_hosts`
is off, the free manual form and raw manual-path POSTs are not bound by
those lists — they're a UX-guided allowlist for your team, not a hardening
boundary against a determined caller. Combine with `restrict_hosts: true`
if you need the rules to be enforced against direct API access too.

### URL anchors

Link directly to a server-side connection:

```
https://your-host/console/#connect=Production
```

This auto-connects on page load — useful for bookmarks and support links.

## Configuration

Environment variables for `server.py`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8765` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `SESSION_TIMEOUT` | `300` | Idle timeout in seconds |
| `MAX_SESSIONS` | `10` | Max concurrent SSH sessions |
| `WEBSH_CONFIG` | *(auto-detected)* | Path to `websh.json` config file |
| `TRUSTED_PROXIES` | `127.0.0.1` | Comma-separated IPs to trust `X-Forwarded-For` from |
| `MAX_BG_SESSIONS` | `10` | Max background SSH sessions (file upload/download) |

The PHP proxy reads `WEBSH_PORT` (default `8765`) to find the backend.

## Deployment

### Shared hosting (PHP + Python)

Upload the four files (`index.html`, `websh.js`, `api.php`, `server.py`) to your web
directory. The backend starts automatically.

For manual control (e.g. custom config path):

```bash
WEBSH_CONFIG=/path/to/websh.json nohup python3 server.py &
```

### Python only (no PHP)

The backend can serve the frontend directly — no PHP or separate web server needed:

```bash
HOST=0.0.0.0 python3 server.py
```

Open `http://your-host:8765/` in a browser. The backend serves `index.html` and
`websh.js` from the same directory as `server.py`, and handles API requests on
the same port.

Put nginx or Caddy in front for HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name ssh.example.com;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_read_timeout 60s;
    }
}
```

### Docker

```bash
docker build -t websh .
docker run -d -p 8765:8765 -e HOST=0.0.0.0 websh
```

Open `http://localhost:8765/` — the backend serves the frontend directly.

For HTTPS, put a reverse proxy in front:

```nginx
server {
    listen 443 ssl;
    server_name ssh.example.com;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_read_timeout 60s;
    }
}
```

### systemd

```bash
# Create a dedicated user
useradd -r -s /bin/false websh

mkdir -p /opt/websh
cp server.py index.html websh.js /opt/websh/
cp websh.service /etc/systemd/system/
systemctl enable --now websh
```

## Authentication & security

**websh does not include its own authentication layer by design.**
It is meant to be lightweight — add access control at the web server level:

- **Apache:** `.htaccess` with `AuthType Basic` + `AuthUserFile`
- **nginx:** `auth_basic` directive
- **Cloudflare Access**, **Tailscale Funnel**, or similar zero-trust tools
- IP allowlisting via firewall rules

### SSH host keys

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

### Saved connections & passwords

Saved connections in the browser are stored in `localStorage` **in plaintext**,
including passwords. Any JavaScript running on the same origin (including XSS
vulnerabilities) could read them.

If this is unacceptable for your use case:
- Use server-side connections (`websh.json`) — passwords stay on the server, never reach the browser
- Don't save connections in the browser — use SSH keys instead
- Restrict access to the websh URL to trusted networks

### Rate limiting & proxies

Connection attempts are rate-limited to 10 per IP per minute. The client IP is
determined from `X-Forwarded-For` **only** when the request comes from an IP
listed in `TRUSTED_PROXIES` (default: `127.0.0.1`). Direct connections always
use the TCP peer address — `X-Forwarded-For` cannot be spoofed.

If your reverse proxy runs on a different host, add its IP:

```bash
TRUSTED_PROXIES=127.0.0.1,10.0.0.5 python3 server.py
```

### Input validation

- Host and username values starting with `-` are rejected (prevents SSH flag injection)
- Session IDs are validated as UUID format
- Terminal dimensions are clamped to safe ranges
- `MAX_SESSIONS` limits concurrent user sessions; `MAX_BG_SESSIONS` limits file transfer sessions separately

## Project structure

```
index.html          Frontend — xterm.js terminal + connection UI
websh.js            Frontend logic — pane management, file transfer, themes
api.php             PHP proxy — forwards browser requests to backend (optional)
server.py           Python backend — manages SSH sessions via PTY, serves frontend
websh.json.example  Example server-side config
test_server.py      Tests (40 unit + integration tests)
Dockerfile          Container deployment
websh.service       systemd unit file
```

## License

MIT
