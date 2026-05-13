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

1. Install the optional dependency:
   ```bash
   pip install cryptography
   ```
   Without it, websh keeps working — the saved-credential UI is just
   hidden. With it, the browser's "Save" checkbox enables encrypted
   storage end-to-end.
2. Confirm at startup. The log line:
   ```
   credential vault: enabled (cryptography 42.0.5)
   ```
   means the gate is open. Without `cryptography`:
   ```
   credential vault: disabled (install cryptography to enable)
   ```
3. Optional: set `WEBSH_CREDS_PATH=/path/to/websh.creds.json`. Default
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
   (one prompt in Firefox; silent in Chromium).
3. From then on, the saved card connects in one click. No master
   passphrase, no prompt.

A different browser, profile, or device sees an empty saved-list — the
key is local. Re-enter on each browser you use.

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
JSON object with AES-GCM-256, sends `{vault_id, conn_id, host, port,
username, ssh_options?, iv, ct}` to `POST /api/save`. The server stores
it, never seeing the SSH credential plaintext.

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
  on the same websh write to disjoint server-side vaults; their
  saved-card lists and stored blobs never see each other. `vault_id`
  is not a secret — it just namespaces the server-side store.
- `conn_id` is a 128-bit random base32 string generated **once on
  first save** of an entry; the value is stable for the entry's
  lifetime. Renaming or editing metadata reuses the same `conn_id` so
  decryption keeps working.
- Encryption uses `AAD = vault_id:conn_id` (UTF-8 bytes), so a blob
  copied to a different `conn_id` (or different vault) fails
  decryption with an auth-tag mismatch — the server returns
  `400 Bad Request` with `{"error":"vault_decrypt_failed"}`, the UI
  prompts the user to re-enter and re-save.

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
  device): attacker has the key but no blobs (they're on the server).
  The most they can do is call `/api/connect` to tunnel SSH — logged in
  `WEBSH_ACCESS_LOG`, rate-limited, killable by deleting the saved
  entry. **Plaintext SSH passwords are not extractable**, so
  password-reuse on banking, email, GitLab, etc. is closed.
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

## Recovery and the panic button

There is no recovery flow by design. Clearing browser data, switching
browsers, or losing the device wipes the local key — the server's
blobs remain but become permanently unreadable.

If your IndexedDB is wiped but the saved-card list survives in
`localStorage`, those entries display grayed-out with a "no key —
delete" affordance. Clicking it sends `DELETE /api/save` for each
entry (the `vault_id` is still in `localStorage`), the server reaps the
empty vault, and the next save generates a fresh key.

The settings panel exposes a **"Clear all saved (server + browser)"**
panic button: deletes every blob in the current vault from the server,
wipes IndexedDB and the saved-card list locally, and clears
`sessionStorage`. After this, the next save creates a new vault from
scratch.

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
The exact version is announced in `CHANGELOG.md` when it ships.

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
`vault_enabled` — mirroring `HAS_CRYPTOGRAPHY` **and** a successful
load of `websh.creds.json` so the client can hide the Save UI when the
gate is closed for any reason.

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

Standard base64 (RFC 4648, `+/=` alphabet) for both `iv` and `ct`.
Server-managed: do not hand-edit. Mode `0600`, atomic-rename writes,
mtime-cached reads. A whole-file JSON parse failure logs a warn and
treats the store as empty — server stays up, pre-configured
`websh.json` connections are unaffected.

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
untrusted, the recipe below ships in PR-D as a new section of
[`security.md`](security.md). Until that PR lands, the gist is:

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
