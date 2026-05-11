# Deployment

## Shared hosting (PHP + Python)

**No SSH access required.** Upload files via FTP, open in browser.

A typical shared-hosting directory layout:

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
        assets/             <- brand SVG (logo)
```

**Steps:**

1. Create a folder in your web root (e.g. `www/console/`).
2. Upload `index.html`, `websh.js`, `api.php`, `server.py`, and the `assets/` folder there.
3. Open `https://your-host/console/` in a browser.

That's it. `api.php` starts `server.py` automatically on the first request.

> **Path details:** `api.php` looks for `websh.json` two directories up from itself
> (i.e. the site root, above `www/`). This works for most hosting providers.
> If your layout is different, set the `WEBSH_CONFIG` environment variable
> or edit the path in `api.php` line 34.

For manual control (e.g. custom config path):

```bash
WEBSH_CONFIG=/path/to/websh.json nohup python3 server.py &
```

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

## Python only (no PHP)

The backend can serve the frontend directly — no PHP or separate web server needed:

```bash
HOST=0.0.0.0 python3 server.py
```

Open `http://your-host:8765/` in a browser. The backend serves the static
files (`index.html`, `websh.js`, `assets/*.svg`) from the same directory as
`server.py`, and handles API requests on the same port. See
[HTTPS via reverse proxy](#https-via-reverse-proxy) below.

## Docker

```bash
docker build -t websh .
docker run -d -p 8765:8765 -e HOST=0.0.0.0 websh
```

Open `http://localhost:8765/` — the backend serves the frontend directly. See
[HTTPS via reverse proxy](#https-via-reverse-proxy) below.

## systemd

```bash
# Create a dedicated user
useradd -r -s /bin/false websh

mkdir -p /opt/websh
cp server.py index.html websh.js /opt/websh/
cp websh.service /etc/systemd/system/
systemctl enable --now websh
```

## HTTPS via reverse proxy

Put nginx or Caddy in front for TLS termination:

```nginx
server {
    listen 443 ssl;
    server_name ssh.example.com;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_read_timeout 60s;

        # OVERWRITE the client-IP header with the real peer. Do not
        # append — a client can pre-populate X-Forwarded-For and bypass
        # per-IP rate limiting and the per-IP session cap if you
        # `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
        # (which appends). websh trusts only the first token.
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

`proxy_read_timeout` must comfortably exceed both the long-poll window
(10 s) and the SSE keep-alive interval (15 s) — 60 s leaves plenty of
headroom. The backend sets `X-Accel-Buffering: no` on the SSE response,
so nginx flushes each event immediately without further configuration.
If the proxy runs on a different host, add its IP to `TRUSTED_PROXIES`
so rate limiting uses the real client IP — see
[Rate limiting & proxies](security.md#rate-limiting--proxies).
