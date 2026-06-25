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

A profile option takes precedence over websh's built-in default for the
same key (OpenSSH keeps the first value, and websh emits its default only
when the profile leaves the key unset). A few of those defaults back
websh's own behavior, so override them deliberately: `NumberOfPasswordPrompts`
defaults to `1` so a rejected password makes `ssh` exit cleanly instead of
re-prompting on the PTY (the primary auth-failure signal), and
`ServerAliveInterval`/`ServerAliveCountMax` drive idle keep-alives. Setting
`StrictHostKeyChecking` to anything other than `no` also drops websh's
default `UserKnownHostsFile=/dev/null`, so host keys are read from (and
written to) the websh user's normal `known_hosts` unless the profile sets
its own `UserKnownHostsFile`.

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
entirely. A connect is then allowed only when it goes through a configured
connection — either by name, or as a saved credential card, which is
authorized against the prompt connection whose host:port it targets (and
that connection's `allowed_users` / `denied_users`). Free-form manual-path
POSTs to `/api/connect` (raw `host`/`username`, no connection name or saved
card) are rejected. With a single connection, the UI auto-selects it on
load — Ready connects immediately, Prompt surfaces the locked form ready
for a password.

## Security note on user lists

`allowed_users` / `denied_users` are enforced on the **named** connection
flow (`{connection: "<name>"}` on `/api/connect`) and, under
`restrict_hosts`, on saved credential cards too — via the prompt connection
their host:port matches. When `restrict_hosts` is off, the free manual form
and raw manual-path POSTs are not bound by those lists — they're a
UX-guided allowlist for your team, not a hardening boundary against a
determined caller. Combine with `restrict_hosts: true` if you need the
rules enforced against direct API access too.

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

## Form defaults

Prefill the manual connect form (host, port, username) without
configuring a full connection entry:

```json
{
  "form_defaults": {
    "host": "192.0.2.10",
    "port": 22,
    "username": "deploy"
  }
}
```

All three fields are optional and validated server-side (bad types or
ranges are dropped silently). The client only fills fields the user
hasn't typed into (the port only while it still shows the markup
default `22`), so a half-completed form is not overwritten. The section
is ignored when `restrict_hosts` is on and connections are configured —
the manual form is locked to those connections there.

This replaces front-proxy HTML rewriting (e.g. an nginx `sub_filter` on
the host input), which breaks whenever the form markup changes.
