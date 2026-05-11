# Persistent sessions (tmux)

Tick **Persistent session** on the connect form and the remote shell is
wrapped in a tmux session on the target host
(`tmux new-session -A -D -s websh-<slot>`). Close the tab, refresh the
page, or restart `server.py` — the pane re-attaches to the same session
with scrollback and running processes intact.

**Requirements.** `tmux` must be installed on the target (any recent
version). If it isn't, the connect flow surfaces a popup offering to
fall back to a short-lived (non-persistent) session instead.

## How reattach works

Each persistent pane stores its slot id in browser `localStorage`
alongside the connection record. On refresh, the frontend re-opens the
pane with the same slot id and tmux re-attaches you to the existing
session. Slot ids are per pane instance — closing a pane with `[x]`
does not free the slot for reuse.

## Terminating a session

Clicking `[x]` on a persistent pane pops a confirm modal (Cancel /
Terminate session / Terminate and never ask again). "Terminate" sends
`tmux kill-session` on the target before the pane closes. If you just
close the browser tab without terminating, the session stays alive on
the target and you can re-attach later.

## Idle-TTL watchdog

At session creation, a detached POSIX-sh watchdog is spawned alongside
the shell. It polls tmux and kills the session once it has been
unattached for `WEBSH_TMUX_IDLE_TTL` seconds (default 72 h; `0`
disables). The watchdog reparents to init via `nohup` and survives
`server.py` restarts. Active (attached) sessions refresh the clock
each poll, so long-running work doesn't get reaped just because you
had a brief disconnect.

## Per-connect tmux options

Every persistent connect runs `tmux new-session … \; set -g …` so a
small set of tmux options is applied uniformly regardless of what's on
the target host. Mouse mode is baked in unconditionally; two toggles in
the Options panel are user-configurable and also pushed into running
panes the moment you change them, so the new behaviour takes effect
without a reconnect:

- **Mouse** (always on, no toggle) — `set -g mouse on`. Wheel scrolls
  tmux scrollback in shell; alt-screen apps (vim, less, htop) get raw
  mouse events. Hold Shift to bypass tmux selection and use the
  browser's native text selection instead.
- **Auto-copy** (toggle) — `set-clipboard on`. tmux copy-mode
  selections are pushed to the system clipboard via OSC52 (xterm.js
  ships them on).
- **Scrollback** (number) — `history-limit` (default 100 000). How
  many lines per pane tmux retains.

The server accepts user-configurable options only via a fixed
allow-list (`set-clipboard`, `history-limit` clamped to 100..10 M);
anything else — including a legacy `tmux_mouse` field from older
clients — is silently dropped, so an out-of-date or hostile client
can't inject extra `set -g` lines. Mouse stays on regardless.

The `set -g` lines run after the target's own `~/.tmux.conf` and
therefore override matching options there.

## Hidden tmux status bar

websh runs `set -g status off` on every persistent attach. Multi-pane
is handled by websh's own splits (each pane is a separate SSH
connection), not by tmux windows, so the default status bar — slot-id
session name, empty window list, and a clock — is visual noise that
just steals a row of terminal real estate. To re-enable for a single
session: `Ctrl+B :set -g status on` (resets on next reconnect).
