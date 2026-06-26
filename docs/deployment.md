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
> or edit the `$WEBSH_CONFIG` default near the top of `api.php`.

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
python3 server.py
```

Open `http://127.0.0.1:8765/` in a browser. The backend serves the static
files (`index.html`, `websh.js`, `assets/*.svg`) from the same directory as
`server.py`, and handles API requests on the same port. See
[HTTPS via reverse proxy](#https-via-reverse-proxy) below.

Do not expose the Python server directly on the public Internet without
an authentication layer. If you need remote access, keep websh bound to
`127.0.0.1` and put nginx, Caddy, Cloudflare Access, Tailscale, or another
auth/TLS layer in front. Only set `HOST=0.0.0.0` on a trusted private
network or behind such a proxy.

## Docker

```bash
docker build -t websh .
docker run -d -p 127.0.0.1:8765:8765 websh
```

The image ships the vault dependency but leaves it **off** by default. To
enable it, add `-e WEBSH_VAULT_ENABLE=1`; the encrypted store lives under
the `/data` volume. Mount a named volume to persist it across container
replacement:

```bash
docker run -d -p 127.0.0.1:8765:8765 -e WEBSH_VAULT_ENABLE=1 -v websh-data:/data websh
```

Open `http://localhost:8765/` — the backend serves the frontend directly.
The container still listens on `0.0.0.0` internally so Docker port
publishing works, but the command above binds the published host port to
localhost only. Use a reverse proxy with TLS and authentication before
publishing it externally.

## systemd

```bash
# Create a dedicated user
useradd -r -s /bin/false websh

mkdir -p /opt/websh
# Copy the backend, the frontend, AND the assets/ dir (the logo lives
# there; without it index.html 404s on assets/websh-logo.svg).
cp -r server.py index.html websh.js assets/ /opt/websh/

# Install the one optional dependency so the encrypted credential vault
# can be enabled (it ships off by default). On Debian/Ubuntu the system
# Python is externally managed (PEP 668), so use the distro package rather
# than a system-wide pip; skipping this is non-fatal — the server still
# runs and the saved-credential UI just stays hidden.
apt install python3-cryptography   # or: pip install --break-system-packages -r requirements.txt

cp websh.service /etc/systemd/system/
systemctl enable --now websh
```

Unlike the PHP path — where `api.php` computes a config path and passes it
to the backend — `server.py` under systemd does **not** auto-detect
`websh.json`: it loads a config only when `WEBSH_CONFIG` is set. Without
it the server still runs, but server-side connections silently don't
load. To define connections, point the unit at a config file (kept
outside any web root):

```bash
mkdir -p /etc/websh        # then create /etc/websh/websh.json
systemctl edit websh       # add, under [Service]:
#   Environment=WEBSH_CONFIG=/etc/websh/websh.json
systemctl restart websh
```

The bundled unit also pins `PORT`/`HOST`; change them there (or via
`systemctl edit`) rather than relying on the in-code defaults.

The unit pre-provisions a writable `/var/lib/websh` via
`StateDirectory=websh`, but leaves the encrypted credential vault **off**
by default. With `cryptography` installed (the optional step above),
enabling it is one line — add `Environment=WEBSH_VAULT_ENABLE=1` in the
same `systemctl edit` override; saved credentials then persist (encrypted)
under `/var/lib/websh/websh.creds.json`. See
[`encryption.md`](encryption.md).

### Multiple instances

Run several isolated websh instances on one box (per team, per
environment) with the template unit — one env file per instance,
no unit editing:

```bash
cp websh@.service /etc/systemd/system/
install -d /etc/websh
printf 'PORT=8766\n' > /etc/websh/staging.env
printf 'PORT=8767\nWEBSH_CONFIG=/etc/websh/lab.json\n' > /etc/websh/lab.env
systemctl enable --now websh@staging websh@lab
```

`PORT` is the one knob every instance must set (they collide on the
default otherwise); anything from
[`configuration.md`](configuration.md) can go in the env file. Each
instance gets its own writable state under `/var/lib/websh-<name>`
(`StateDirectory=websh-%i`) — point `WEBSH_CREDS_PATH` there when
enabling the vault. A missing env file fails the unit loudly instead
of booting a misconfigured instance. The single-instance
`websh.service` remains the default path for one-box deployments.

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
