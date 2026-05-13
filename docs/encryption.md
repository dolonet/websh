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

1. Open websh, fill in host/user/password, **tick "Save this
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
  vault_id 128-bit base32                        connection metadata,
                                                 deny lists, etc.
localStorage[websh_connections]:
  [{name, vault_id, conn_id, host,             websh.creds.json (new)
    port, user, auth, persistent}]               server-managed, mode 0600
                                                 vaults[vault_id][conn_id]
                                                  = {host, port, user,
                                                     ssh_options?, iv, ct}
sessionStorage[websh_panes_session]:
  manual-mode panes' plaintext
  (RAM only, not on browser disk)
```

**Save flow** — browser encrypts `{password, key, key_pass}` as a single
JSON object with AES-GCM-256, sends `{vault_id, conn_id, host, port,
user, ssh_options?, iv, ct}` to `POST /api/save`. The server stores it,
never seeing the plaintext key.

**Connect flow** — browser sends `{vault_id, conn_id, key, cols, rows,
…}` to `POST /api/connect`. The server reads the blob, decrypts in RAM
with the supplied key, types the plaintext into the SSH PTY, scrubs
both the key bytes and plaintext from memory.

**Refresh (F5) for a saved entry** — pane manifest stores `vault_id`
and `conn_id` only, no plaintext. The browser invokes the same connect
flow as a click.

**Refresh for a manual entry (no Save)** — pane plaintext lives in
`sessionStorage`, which the browser keeps in RAM and never writes to
disk. F5 restores. Closing the tab, opening a new tab, or restarting
the browser loses it — re-enter on demand.

## IDs and isolation

- `vault_id` is a 128-bit random base32 string per browser profile per
  origin. Two browsers using the same websh have different `vault_id`s
  and are completely isolated: A cannot read, overwrite, or DoS B's
  entries. `vault_id` is not a secret — it just namespaces the
  server-side store.
- `conn_id` is a 128-bit random base32 string per saved entry, generated
  fresh on each save. **Not derived from the user-visible name**:
  renaming a saved card does not break decryption.
- Encryption uses `AAD = vault_id:conn_id`, so a blob copied to a
  different conn_id (or different vault) fails decryption with an
  auth-tag mismatch — the server returns 401, the UI prompts the user
  to re-enter and re-save.

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
- Multi-browser collision on the same connection name (`vault_id`
  namespace prevents).
- Blob swap within or between vaults (AAD prevents).
- Plaintext SSH passwords on disk in the browser profile for
  unsaved/manual connections (moved to `sessionStorage`, RAM-only).

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
| `POST /api/save` | `{vault_id, conn_id, host, port, user, ssh_options?, iv, ct}` | Upsert blob into `vaults[vault_id][conn_id]`. |
| `DELETE /api/save?vault_id=…&conn_id=…` | (query string) | Remove blob; reap empty vault. |
| `POST /api/connect` *(saved variant)* | `{vault_id, conn_id, key, cols, rows, persistent?, slot_id?, …}` | Decrypt in RAM, spawn ssh, scrub buffers. Host/port/user/ssh_options come from the stored record, not the body. |

The existing manual `POST /api/connect` (with `host`, `password`, etc.)
is unchanged. The existing `GET /api/config` adds one boolean field —
`vault_enabled` — mirroring `HAS_CRYPTOGRAPHY` so the client can hide
the Save UI when the gate is closed.

Access-log hygiene: `iv`, `ct`, `key` are never logged in full —
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
        "user": "deploy",
        "ssh_options": { "StrictHostKeyChecking": "yes" },
        "iv": "<base64-12-bytes>",
        "ct": "<base64-ciphertext-with-gcm-tag>"
      }
    }
  }
}
```

Server-managed: do not hand-edit. Mode `0600`, atomic-rename writes,
mtime-cached reads. A whole-file JSON parse failure logs a warn and
treats the store as empty — server stays up, pre-configured
`websh.json` connections are unaffected. A `version` other than `1`
disables the vault for the rest of the process lifetime.

## Hardened deployment

For deployments where the websh host is multi-tenant or otherwise
untrusted, see the upcoming **Hardened deployment** section of
[`security.md`](security.md): augmented `websh.service` with
`MemoryDenyWriteExecute`, `SystemCallFilter`, kernel-protect, and
`sysctl kernel.yama.ptrace_scope=2` to close the brief decrypt-window
exposure.

The base encryption design (this document) requires no root and no
systemd changes. The hardening section is additive and root-only.
