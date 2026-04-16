# Auth-failure detection — research notes

These are notes, not a proposal. The current detector works in practice;
this is about what a cleaner rewrite would look like if we wanted to
close the known blind spots.

## What we do today (`server.py`)

Two signals, intentionally overlapping:

1. **Inline PTY scan.** After we auto-type a password, the read loop
   scans up to 4 KB of further PTY output for any of:

   ```
   "permission denied", "authentication failed",
   "access denied", "too many authentication failures",
   "password:", "password for", "passcode:", "passphrase"
   ```

   Match → `auth_failed = True`, SIGTERM the child. Restricted to
   the first 4 KB post-password so a later `sudo: Permission denied`
   in the user's shell can't trip it.

2. **Exit-code fallback.** On `waitpid`, if ssh exited with status
   255 AND the output tail contains one of the `AUTH_FAIL_PATTERNS`,
   flag as auth failure. 255 is ssh's "I rejected this" code — catches
   key-only auth rejection (no password prompt ever reached),
   locale-independent at the exit-code level, and can't be missed
   due to slow/chatty output.

We also set `NumberOfPasswordPrompts=1` so the ssh client gives up
after one rejection (clean 255 exit instead of looping on the PTY).

## Known blind spots

- **Locale.** Inline scan is English-only. The exit-code path is
  locale-proof, but it still relies on the tail containing an
  English phrase for the *reason*. A German locale with a non-255
  exit code would pass silently. We mitigate by forcing
  `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` in the child's environment,
  so ssh's own output is in English even when the remote user's
  profile would switch it — this handles most real cases.
- **Ambiguous English strings in legitimate output.** A remote MOTD
  saying "access denied at your last login" would false-positive if
  it hit within the 4 KB post-password window. Low probability in
  practice; never observed, but it's the shape of the concern.
- **Non-standard ssh builds.** OpenSSH's wire strings are stable;
  vendored or forked clients could phrase things differently.
  Irrelevant for almost everyone.
- **Timing on slow auth.** The 4 KB scan window is a rough proxy for
  "we're still in auth". A very chatty motd could exhaust the 4 KB
  before an auth failure emits, but the exit-code path catches it.

## What "elegant" would look like

The root cause of the blind spots is that we can't tell ssh's own
output apart from the remote shell's output — both arrive on the same
PTY. ssh writes auth errors to **stderr** and remote output to
**stdout**. A PTY fuses them.

### Option A — separate stderr on a pipe (the actual fix)

Replace `pty.fork()` with a manual fork:

```python
master_fd, slave_fd = pty.openpty()
stderr_r, stderr_w = os.pipe()
pid = os.fork()
if pid == 0:                       # child
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(stderr_w, 2)           # stderr → pipe, NOT the PTY
    for fd in (slave_fd, stderr_r, stderr_w):
        os.close(fd)
    os.execvpe("ssh", ssh_cmd, env)
    os._exit(1)
os.close(slave_fd)
os.close(stderr_w)
```

Now the read loop drains **two** fds with `select()`: `master_fd`
(remote output, never contaminated by ssh) and `stderr_r` (pure ssh
diagnostics). Auth-failure parsing runs exclusively against the
stderr stream — no size window needed, no "is this still auth?"
heuristic, no MOTD-vs-error ambiguity. The current tail scan
disappears entirely.

Caveats:

- ssh prints the initial password prompt to the controlling TTY
  (`/dev/tty`), not stderr — the prompt still comes out of `master_fd`
  so our auto-type logic doesn't change.
- Some messages ("Warning: Permanently added ... to the list of
  known hosts") arrive on stderr but aren't errors. A strict English
  match on `"permission denied"` / `"authentication failed"` is still
  needed; what changes is we stop seeing the user's shell output
  mixed in.
- `TIOCSCTTY` after `setsid()` is the right order; don't reverse it.
- Works identically on Linux and macOS. Windows isn't in scope for
  websh anyway (no PTY).

This is the "do it properly" option. Maybe ~40 lines of churn in
`_spawn` + `_read_loop`; no user-visible behavior change beyond
fewer false negatives on chatty targets and safer scope.

### Option B — ssh's `-v` debug stream

`ssh -v` emits machine-stable `debug1: Authentications that can
continue: …` and `debug1: Authentication succeeded (publickey).`
lines. Parse those. Pros: definitive, locale-proof. Cons: debug
output is chatty and undocumented as a stable interface —
Upstream OpenSSH does not promise format stability of debug1 lines.
Feels fragile. Skip.

### Option C — status via `ssh -o ControlMaster=yes` + `-o ExitOnForwardFailure=yes` tricks

Clever, but relies on side-effects not intended as signals. Skip.

### Option D — Write a small wrapper that does libssh auth itself, then exec a shell

Brings a C dependency (libssh / libssh2). Contradicts the project's
"Python stdlib only, zero deps" design goal. Absolutely skip.

## Recommendation

If we ever clean this up, go with **Option A** (stderr on a separate
pipe). It removes guesswork — the detector operates on ssh's own
diagnostics, not on a fragment of PTY output that might contain shell
echo, MOTD, or prompts.

For now, the existing inline+exit-code combo is load-bearing and
passing its tests. The blind spots are hypothetical for our target
audience (English-facing ssh, OpenSSH client, localhost/VPN
deployments). File this as "nice refactor when we touch `_spawn`
next", not a shipping blocker.

## What this means for the current PR

Nothing. Leave the detector as-is. If we want to revisit:

- The stderr-pipe rewrite is isolated to `SSHSession._spawn` /
  `_read_loop`. No API change, no frontend change.
- Auth-fail signalling to the client (`session.auth_failed` flag
  surfaced via `/api/output`) stays identical, so the tests and the
  frontend don't move.
