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

    # nginx caps request bodies at 1m by default, which 413s any file
    # upload larger than that before it ever reaches websh. Raise it to
    # the largest upload you want to allow — up to the backend's
    # MAX_UPLOAD_SIZE (2 GiB default); the server still enforces its own
    # limit, so this is just the proxy ceiling. On a public / multi-user
    # relay prefer a bounded value (e.g. 200m) over 2g, so one client
    # can't push multi-gigabyte requests through you.
    client_max_body_size 2g;

    location / {
        proxy_pass http://127.0.0.1:8765;
        # Covers the SSE/long-poll idle gaps AND large uploads: with
        # request buffering on (nginx default) the proxy waits on this
        # timeout while websh streams a buffered upload to the remote and
        # replies. 60s is enough for SSE but cuts off large/slow uploads
        # with a 504; 300s leaves headroom.
        proxy_read_timeout 300s;

        # OVERWRITE the client-IP header with the real peer. Do not
        # append — a client can pre-populate X-Forwarded-For and bypass
        # per-IP rate limiting and the per-IP session cap if you
        # `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
        # (which appends). websh trusts only the first token.
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

`proxy_read_timeout` must comfortably exceed the long-poll window (10 s),
the SSE keep-alive interval (15 s), and — usually the binding constraint —
the time websh needs to stream a large upload to the remote host before
it replies. With request buffering on (nginx's default) the proxy holds
the connection on this timeout for the whole upload-and-respond phase, so
a value sized only for SSE (e.g. 60 s) silently cuts large or slow uploads
off with a `504`. 300 s covers both; raise it further if you allow very
large files over slow links. The backend sets `X-Accel-Buffering: no` on
the SSE response, so nginx flushes each event immediately without further
configuration.

`client_max_body_size` must be at least as large as the files you intend
to upload. nginx defaults to `1m` and rejects anything bigger with
`413 Request Entity Too Large` before the request reaches websh, so a
proxy that omits this directive silently breaks uploads of ordinary files
(PDFs, images, archives). The backend independently caps uploads at
`MAX_UPLOAD_SIZE` (2 GiB default, specified in bytes — not nginx-style
size suffixes), so the proxy value only needs to not be the bottleneck.
On a single-user deployment `2g` (matching the backend cap) is the
simplest choice; on a public or multi-user relay set a bounded ceiling
(e.g. `200m`) instead, so one client can't tie up bandwidth and a
request-body temp file with a multi-gigabyte push. Caddy v2 has no default
body-size limit, so no equivalent setting is required there.

If the proxy runs on a different host, add its IP to `TRUSTED_PROXIES`
so rate limiting uses the real client IP — see
[Rate limiting & proxies](security.md#rate-limiting--proxies).
