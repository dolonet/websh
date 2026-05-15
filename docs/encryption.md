# Encrypted credential vault

> **Status:** design accepted, implementation in progress (issue #64).
> This document specifies the contract; PRs land the server, client, and
> hardening pieces in sequence (B → C → D). Until B and C land, websh
> behaves as today and saved credentials remain in plaintext as
> documented in [`security.md`](security.md).

Saved SSH credentials are stored as **opaque encrypted blobs** on the
server. The decryption key lives in the browser's IndexedDB, generated
locally at first save and never sent anywhere except as part of the
connect handshake itself.

Stealing `websh.json`, the server's `websh.creds.json`, the browser
profile, or any combination yields metadata and ciphertext — not
plaintext SSH passwords. The plaintext lives in server RAM only during
the ~50 ms it takes to type it into the SSH PTY.

## Quick start (operators)

1. Install the optional dependency (minimum supported version is
   `3.4.8`, the floor most current distros ship; modern wheels
   `>=42` are recommended):
   ```bash
   pip install 'cryptography>=3.4.8'
   ```
   Without it, websh keeps working — the saved-credential UI is just
   hidden. With it, the browser's "Save" checkbox enables encrypted
   storage end-to-end.
2. Until the client side ships (PR-C), opt the vault on explicitly:
   ```bash
   WEBSH_VAULT_ENABLE=1 python3 server.py
   ```
   Without `WEBSH_VAULT_ENABLE`, the server reports
   `vault_enabled: false` in `/api/config` and the new endpoints
   return `501`, even when `cryptography` is present. This stops a
   server upgrade from advertising endpoints the bundled client
   does not yet know how to call. The flag becomes the default
   once the client lands; operators who left it set will see no
   change.
3. Confirm at startup. The log line:
   ```
   credential vault: enabled (cryptography 42.0.5, WEBSH_VAULT_ENABLE=1)
   ```
   means the gate is open. Without `cryptography`:
   ```
   credential vault: disabled (install cryptography to enable)
   ```
   Without `WEBSH_VAULT_ENABLE`:
   ```
   credential vault: disabled (set WEBSH_VAULT_ENABLE=1 to opt in)
   ```
4. Optional: set `WEBSH_CREDS_PATH=/path/to/websh.creds.json`. Default
   is the same directory as `websh.json` (or the cwd if `WEBSH_CONFIG`
   is unset).

The credential file is created lazily on the first user save, with mode
`0600`. Atomic-rename writes — no partial-write corruption window. Back
it up alongside `websh.json` (FDE-encrypted host snapshots are fine);
the blobs are useless without each user's browser-side key.

## Quick start (users)

1. Open websh, fill in host/username/password, **tick "Save this
   connection"**, click Connect.
2. The browser silently generates a 256-bit AES-GCM key in IndexedDB
   the first time and asks the browser to keep storage permanently
   (one prompt in Firefox; silent in Chromium; **silent no-op on
   Safari outside of an installed PWA — see "Safari / iOS caveat"
   below**).
3. From then on, the saved card connects in one click. No master
   passphrase, no prompt.

A different browser, profile, or device sees an empty saved-list — the
key is local. Re-enter on each browser you use.

### Safari / iOS caveat

Safari's Intelligent Tracking Prevention evicts unpartitioned IndexedDB
after **7 days of no first-party interaction with the site**, and
`navigator.storage.persist()` is silently ignored on Safari outside of
an installed PWA. So on Safari (desktop and iOS in browser), saved
cards transparently disappear after a quiet week. The UI surfaces this
at save-time on Safari with a one-line note ("on Safari this entry
will be cleared after 7 days of inactivity unless you add the site to
your home screen"). For long-lived saves on iOS, install websh as a
PWA (Share → Add to Home Screen) — the IDB then survives indefinitely.

## How it works

```
Browser (per profile per origin)              Server
─────────────────────────────────             ──────────────────────
IndexedDB:                                     websh.json
  K        AES-256-GCM CryptoKey                 operator-managed
           (extractable: true — required        connection metadata,
           because the connect handshake        deny lists, etc.
           ships raw bytes; see "On the
           extractable flag" below)            websh.creds.json (new)
  vault_id 128-bit base32                        server-managed, mode 0600
                                                 vaults[vault_id][conn_id]
localStorage[websh_connections]:                  = {host, port, username,
  [{name, vault_id, conn_id, host,                   ssh_options?, iv, ct}
    port, username, auth, persistent}]
sessionStorage[websh_panes_session]:
  manual-mode panes' plaintext (kept
  in process RAM in normal use; see
  "On sessionStorage durability" below)
```

**Save flow** — browser encrypts `{password, key, key_pass}` as a single
JSON object with AES-GCM-256, **freshly drawing a 12-byte IV via
`crypto.getRandomValues()` on every save** (GCM IV reuse under the
same key is catastrophic — leaks plaintext XORs and forges auth-tags
permanently), and sends `{vault_id, conn_id, host, port, username,
ssh_options?, iv, ct}` to `POST /api/save`. The server stores it,
never seeing the SSH credential plaintext.

> **Field-name note.** The new endpoints use a separate field name
> `vault_key` for the AES key on the wire, **not** `key`. The existing
> `/api/connect` already uses `key` for an SSH private-key PEM in manual
> mode; reusing `key` for the 32-byte AES material would make a
> mis-routed body silently dangerous. So the saved-variant body is
> `{vault_id, conn_id, vault_key, …}` — distinct names, no overload.

**Connect flow** — browser sends `{vault_id, conn_id, vault_key, cols,
rows, …}` to `POST /api/connect`. The server reads the blob, decrypts
in RAM with the supplied `vault_key`, types the plaintext into the SSH
PTY, then makes a best-effort scrub (`bytearray` overwrite + `del`).
Python's value semantics mean residual copies may linger in interpreter
memory until GC; the [hardened deployment](security.md) recipe is what
closes that window in practice via `ptrace_scope` and
`MemoryDenyWriteExecute`.

**Refresh (F5) for a saved entry** — pane manifest stores `vault_id`
and `conn_id` only, no plaintext. The browser invokes the same connect
flow as a click.

**Refresh for a manual entry (no Save)** — pane plaintext lives in
`sessionStorage`, which the browser keeps in process memory in normal
use (Chromium and Firefox may persist a brief copy for crash recovery,
wiped on graceful tab close; nothing lands in long-term profile
backups). F5 restores. Closing the tab, opening a new tab, or
restarting the browser loses it — re-enter on demand.

### On the `extractable` flag

The `CryptoKey` in IndexedDB is created with `extractable: true`
because the connect-flow ships the raw 32 bytes to the server. Any JS
running on the websh origin (including XSS, malicious browser
extensions with host permission, or a devtools console) can call
`crypto.subtle.exportKey('raw', K)` and exfiltrate it. The IDB layer is
therefore **not** the confidentiality boundary — the absence of
ciphertext blobs from the client is what closes the threat. An
exfiltrated `vault_key` lets an attacker call `/api/connect` and tunnel
SSH (logged, rate-limited, killable by deleting the entry); it does
not let them recover plaintext SSH passwords for use on other services.

### On `sessionStorage` durability

`sessionStorage` is per-tab, RAM-resident in normal use, and cleared on
graceful tab close. Chromium maintains a Session Storage LevelDB on
disk while tabs are open (used by "Continue where you left off" / crash
recovery), and Firefox writes `sessionstore-backups/recovery.jsonlz4`
periodically. Both are wiped on graceful close and neither appears in
long-term profile backups. The win vs `localStorage` is real but
narrower than "never on disk" — call it "never in long-term profile
storage; brief crash-recovery shadow during a live session."

### Saving a Prompt-style server-side connection

When the user opens a Prompt-style entry from `websh.json` (no
operator-stored credentials; user types their own at connect time) and
ticks "Save", the typed credential routes through the same vault flow.
Only `{password, key, key_pass}` are encrypted; `host`, `port`, and
`username` come from `websh.json` and are not duplicated into the
blob. The card behaves as one-click from then on, exactly like a
free-form save.

## IDs and isolation

- `vault_id` is a 128-bit random base32 string per browser profile per
  origin (or per `isolate_storage` path scope when that operator option
  is set; see "Interaction with `isolate_storage`" below). Two browsers
  on the same websh write to disjoint server-side vaults — their
  saved-card lists and stored blobs do not collide. `vault_id` is **not
  a secret** and **not an authentication principal**: anyone who
  learns one (extension, browser-history sync of `localStorage`, log
  scrape, devtools shoulder-surf) can call `DELETE /api/save` against
  any `conn_id` in that vault. Without `vault_key` they still cannot
  read the blobs — this is denial-of-service, not data exfil. websh
  has no caller-auth model on the wire; isolation is namespace-level,
  not enforceable.
- `conn_id` is a 128-bit random base32 string generated **once on
  first save** of an entry; the value is stable for the entry's
  lifetime. Renaming or editing metadata reuses the same `conn_id` so
  decryption keeps working.
- Encryption uses `AAD = vault_id:conn_id` (UTF-8 bytes), so a blob
  copied to a different `conn_id` (or different vault) fails
  decryption with an auth-tag mismatch — the server returns
  `400 Bad Request` with `{"error":"vault_decrypt_failed"}`, the UI
  prompts the user to re-enter and re-save. Input-shape failures
  (malformed base64, IV not 12 bytes, ct shorter than the GCM tag,
  vault_id/conn_id format mismatch) also return `400` but with
  `{"error":"vault_input_invalid"}` so implementers and operators
  can tell the two failure classes apart from the body without
  splitting on the HTTP status code (both stay `400` so upstream
  `auth_basic` / Cloudflare Access never sees a `401` and never
  triggers a re-prompt loop).

### Interaction with `isolate_storage`

When `isolate_storage: true` is set in `websh.json`, the existing
`localStorage` keys are scoped by URL path so multiple websh
deployments on the same origin (e.g. `/team-a/`, `/team-b/`) do not
share saved-connection lists. IndexedDB has no path scope of its own,
so the vault layer keeps the same boundary explicit: the IDB record
keys for `K` and `vault_id` are namespaced by the same path prefix,
and a fresh `vault_id` is generated per scope. Operator-visible
effect: each path-scoped deployment writes to its own
`vaults[vault_id_for_that_scope]` and cannot reach into another's
entries even though the origin is shared.

## What's closed, what's open

**Closed:**
- `websh.json` filesystem leak (no creds in there post-migration; only
  metadata).
- `websh.creds.json` filesystem leak (blobs without the browser-side key
  are unrecoverable AES-256-GCM).
- Browser profile or IndexedDB exfil (extension, file-stealer malware,
  profile sync to a compromised cloud, forensics on a stolen unlocked
  device): attacker has `vault_key` but no blobs (they're on the
  server). See the "On the `extractable` flag" section above for why
  `extractable: true` is correct here — the IDB layer is not the
  confidentiality boundary; the absence of ciphertext blobs from the
  client is what closes the threat. The most an attacker with
  `vault_key` can do is call `/api/connect` to tunnel SSH — logged in
  `WEBSH_ACCESS_LOG`, rate-limited, killable by deleting the saved
  entry. **The plaintext SSH password cannot be exfiltrated to other
  services** (banking, email, GitLab, etc.) — `/api/connect` returns a
  PTY stream, never the password value.
- Server-side collision between two browsers' saved entries
  (`vault_id` namespace prevents — each browser writes to a disjoint
  slot, even with identical card names).
- Blob swap within or between vaults (AAD prevents).
- Plaintext SSH passwords in long-term browser profile storage for
  unsaved/manual connections (moved to `sessionStorage`; see "On
  `sessionStorage` durability" above for the precise property).

**Honestly open** (out of scope by design):
- Server compromise during an active connect: plaintext briefly in RAM
  (~50 ms). For that window only, the running websh process holds the
  key and the password. See the [hardened deployment](security.md)
  notes for ptrace and `MemoryDenyWriteExecute` mitigations.
- TLS broken in transit: in-flight key + connect bodies exposed. The
  key rotates per browser profile, not per save, so a one-time MITM
  exposes everything saved by that browser to date.
- Compromised target SSH server: sees the plaintext at PTY-type time —
  nothing websh can do.
- Stolen unlocked device: an attacker with the open browser tab has
  both the key (in the live JS context) and access to the saved-card
  list. Mitigated only by OS lock-screen / FDE.
- Forgotten/wiped browser data: no recovery, no sync. Re-enter on each
  browser. (See "Recovery" below.)
- Vault-targeted DoS by an attacker who learns a `vault_id` (extension,
  shoulder-surfing devtools, browser-history sync of `localStorage`,
  careless screenshot): the attacker can `DELETE /api/save` against
  any `conn_id` in that vault, or `POST /api/save` to spray entries.
  The legitimate user sees missing or unexpected cards but cannot lose
  plaintext from this — `vault_key` is still required for actual
  reads. Mitigation deferred to a future minor: `HMAC(vault_key,
  "delete:" + conn_id)` proof-of-key on `DELETE`, or per-`vault_id`
  rate limits on `/api/save`. Acceptable for v1 because operator-side
  `WEBSH_ACCESS_LOG` records every save/delete and the gateway-level
  `auth_basic` / `MAX_SESSIONS_PER_IP` already cap the abuse window.
- Orphan vaults (browsers that never come back). `websh.creds.json`
  grows unboundedly across staff turnover. v1 does not ship an
  operator GC surface; sizes are small (~200 B per blob, kilobytes
  even for a heavy team), so this is a months-or-years-out concern.
  A future minor lands `GET /api/vault/stats` (operator-auth) and a
  `python3 server.py --vault-gc --older-than 90d` CLI when that
  becomes load-bearing.

## Recovery and the panic button

There is no recovery flow by design. Clearing browser data, switching
browsers, or losing the device wipes the local key — the server's
blobs remain but become permanently unreadable.

If your IndexedDB is wiped but the saved-card list survives in
`localStorage`, those entries display grayed-out with a "no key —
delete" affordance. Clicking it sends `DELETE /api/save` for each
entry (the `vault_id` is still in `localStorage`), the server reaps the
empty vault, and the next save generates a fresh key.

The settings panel exposes a **"Sign out of this browser"** action
(typed-`DELETE` confirmation required, since the action is permanent
and crosses every saved host at once): deletes every blob in the
current vault from the server, wipes IndexedDB and the saved-card
list locally, and clears `sessionStorage`. After this, the next
save creates a new vault from scratch. The copy is intentionally
"sign out" rather than "clear settings" so the irreversible nature
of the action matches the user's password-manager mental model.

## Migrating from legacy plaintext

If `websh.json` has connections with `password`, `key`, or `key_pass`
fields, websh continues to honor them and emits a one-line deprecation
warning at startup:

```
WARN websh.json contains plaintext credentials on N entries — see docs/encryption.md to migrate
```

Migration is operator-driven: capture the values, remove the fields
from `websh.json`, restart. The corresponding cards turn into
Prompt-style entries; users click them, enter the captured password
once, tick "Save", and they become one-click again — encrypted under
the user's browser-side key.

A future minor will turn this warning into a refuse-to-start error.
**Operators can opt in early** by setting `WEBSH_REQUIRE_VAULT=1`
(refuses to start if any plaintext is found, prints the same
multi-line migration message as the eventual default). Targeting
**v1.0.0** for the default flip, announced in `CHANGELOG.md` when
it ships. Until then, leaving `WEBSH_REQUIRE_VAULT` unset preserves
today's behavior (warn-and-continue).

If your browser already has plaintext entries in
`localStorage[websh_connections]` (saved before encryption shipped), a
one-time UI banner asks you to acknowledge — old plaintext entries are
deleted from `localStorage` on click; you re-enter and re-save under
the new flow. We do not silently re-encrypt them: the original
plaintext may live in browser-history sync or backups, and "encrypted
now" would create a false sense of security.

## API surface

Three endpoints touch the vault. All are gated on
`HAS_CRYPTOGRAPHY` — without `cryptography` installed they return
`501 Not Implemented` with an actionable error.

| Endpoint | Body / Query | Effect |
|---|---|---|
| `POST /api/save` | `{vault_id, conn_id, host, port, username, ssh_options?, iv, ct}` | Upsert blob into `vaults[vault_id][conn_id]`. |
| `DELETE /api/save?vault_id=…&conn_id=…` | (query string) | Remove blob; reap empty vault. |
| `POST /api/connect` *(saved variant)* | `{vault_id, conn_id, vault_key, cols, rows, persistent?, slot_id?, …}` | Decrypt in RAM, spawn ssh, best-effort scrub buffers. Host / port / username / ssh_options come from the stored record, **not** the body. |

`vault_key` is base64(32 bytes). The name is intentionally distinct
from the existing `key` field on manual-mode `/api/connect` (which
carries an SSH private-key PEM) — see the field-name note in **How it
works**.

The existing manual `POST /api/connect` (with `host`, `password`, etc.)
is unchanged. The existing `GET /api/config` adds one boolean field —
`vault_enabled` — true iff **all three** of: `HAS_CRYPTOGRAPHY`
imported successfully, `WEBSH_VAULT_ENABLE=1` is in the environment
(until the client lands; default-on after that), and the
`websh.creds.json` schema version on disk is supported. The client
hides the Save UI when this is `false`.

Access-log hygiene: `iv`, `ct`, `vault_key` are never logged in full —
lengths only. `vault_id` and `conn_id` are loggable as-is for
correlation (they are not secrets).

## File schema (`websh.creds.json`)

```json
{
  "version": 1,
  "vaults": {
    "<vault_id>": {
      "<conn_id>": {
        "host": "server.example.com",
        "port": 22,
        "username": "deploy",
        "ssh_options": { "StrictHostKeyChecking": "yes" },
        "iv": "<standard-base64-12-bytes>",
        "ct": "<standard-base64-ciphertext-with-gcm-tag>"
      }
    }
  }
}
```

Connection metadata (`host`, `port`, `username`, `ssh_options?`) is
**always stored alongside the blob**, not pulled from `websh.json` by
some link key. Self-contained records are simpler and survive the
operator deleting or renaming a `websh.json` connection without
orphaning their users' saved entries (a deleted reference would
otherwise leave a blob pointing at no host). Cost: ~50 extra bytes
per record.

Standard base64 (RFC 4648, `+/=` alphabet) for both `iv` and `ct`.
Server-managed: do not hand-edit. Mode `0600`, **atomic-rename writes
under an in-process `threading.Lock` around the read-modify-write
cycle** (atomic-rename alone prevents torn writes, not lost updates;
two browsers POSTing simultaneously would otherwise both read-modify
the same vaults dict and the second would silently clobber the first).
The writer flow is: write to tmp, `fsync(tmp_fd)`, `os.replace(tmp,
final)`, `fsync(parent_dir_fd)`. The cache key for re-parse is
`(mtime, size)`, not bare mtime — bare mtime is 1 s granularity on
some filesystems and a fast write-read-write within 1 s would return
stale. A whole-file JSON parse failure logs a warn and treats the
store as empty — server stays up, pre-configured `websh.json`
connections are unaffected.

A `version` other than `1` is a **loud failure**: the server logs a
single `WARN websh.creds.json schema version=N unsupported (this
build expects 1) — vault disabled` line, refuses to start the writer
for the rest of the process lifetime (so an existing v2 file is not
silently overwritten with a v1 payload), and `vault_enabled` in
`/api/config` flips to `false`. The client hides the Save UI; saves
that race in before the config refresh return `501`. Operator action
required to recover (downgrade the file to v1 or upgrade websh).

## Hardened deployment

For deployments where the websh host is multi-tenant or otherwise
untrusted, the additive recipe below is intended for a future
hardening pass (no tracking issue yet — feel free to apply now; it
needs no client or server changes). The gist is:

```ini
# /etc/systemd/system/websh.service (additions)
MemoryDenyWriteExecute=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
```

```bash
# /etc/sysctl.d/99-websh.conf
kernel.yama.ptrace_scope=2
```

These narrow the brief decrypt-window exposure (the ~50 ms during
which the running websh process holds the `vault_key` and decrypted
plaintext): `ptrace_scope=2` blocks non-root processes from attaching
to read RAM; `MemoryDenyWriteExecute` blocks write-then-execute heap
pages used by some shellcode chains.

The base encryption design (this document) requires no root and no
systemd changes. The hardening section is additive and root-only.
