# Server-side connections

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
> the directory diagram in [`deployment.md`](deployment.md#shared-hosting-php--python),
> set the `WEBSH_CONFIG` environment variable.

## Per-connection SSH options

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

Only the connection-shape options (host-key policy, jump host, timeouts,
algorithm preferences) are accepted. Directives that turn `ssh -o` into
local command execution — `ProxyCommand`, `LocalCommand`,
`PermitLocalCommand`, `KnownHostsCommand`, `Include`, `Match`,
`IdentityAgent` — are dropped at session creation with a WARN in the
server log. If you need those, put them in the system `ssh_config` on
the websh host instead of in `websh.json` (which has a broader trust
profile — FTP'able on shared hosting, sometimes restored from backups).

## Connection kinds: Ready vs Prompt

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

## Restrict mode

Set `"restrict_hosts": true` to hide the free-form manual connection form
entirely. Users can only go through a configured connection card. Raw
manual-path POSTs to `/api/connect` (bypassing the UI) are also rejected.
With a single connection, the UI auto-selects it on load — Ready connects
immediately, Prompt surfaces the locked form ready for a password.

## Security note on user lists

`allowed_users` / `denied_users` apply only inside the **named** connection
flow (`{connection: "<name>"}` on `/api/connect`). When `restrict_hosts`
is off, the free manual form and raw manual-path POSTs are not bound by
those lists — they're a UX-guided allowlist for your team, not a hardening
boundary against a determined caller. Combine with `restrict_hosts: true`
if you need the rules to be enforced against direct API access too.

## Deny-list for free-form connect

When `restrict_hosts` is off (the default), visitors can target any host
they like. To stop the proxy from reaching internal infrastructure or
your own boxes, add a `denied_hosts` array:

```json
{
  "restrict_hosts": false,
  "denied_hosts": [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "fe80::/10",
    "evil.example",
    "your-internal-jumpbox.example.com"
  ]
}
```

Each entry is parsed as an IP address or CIDR network when possible
(IPv4 and IPv6 both supported); otherwise it's matched as an exact
hostname (case-insensitive). At connect time websh resolves the target
hostname via the system resolver and rejects the request if any of the
returned addresses fall inside a denied range — so a public-looking
domain whose A record points into RFC1918 is also blocked.

DNS resolution failures fail open (the request goes through; ssh's own
resolver will then fail with a clear error). Hosts you've put in
`connections` bypass the deny-list — explicit configuration wins.

## URL anchors

Link directly to a server-side connection:

```
https://your-host/console/#connect=Production
```

This auto-connects on page load — useful for bookmarks and support links.
