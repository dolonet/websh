# Browser scenarios

Real Chromium, a real ssh session, real network faults. They exist
because the bugs that hurt users most - keys out of order, output that
stops after a Wi-Fi switch, keys lost on coming back - depend on timing
and on the network, and unit tests passed while they were live.

    scripts/e2e.sh                     every scenario, against a private instance
    scripts/e2e.sh silent away         some of them
    scripts/e2e.sh --repeat 10 away    a race shows up in repetition
    scripts/e2e.sh --url https://h/    only what is safe against a deployment
    scripts/e2e.sh --list

| Scenario | What it proves |
|---|---|
| `smoke` | the page boots, no script errors |
| `typing` | keys arrive in the order typed; echo costs one round trip |
| `offline` | 8 s without network during output: nothing lost or doubled |
| `drop` | the stream's connection is reset three times |
| `silent` | the connection dies without FIN/RST (Wi-Fi switch): output returns by itself |
| `restart` | websh restarts: a persistent pane re-attaches to the same tmux shell |
| `away` | two panes, tab frozen 75 s, server session expired: both back, first keys delivered |
| `upload` | 12 MB upload with the connection reset twice under it: arrives whole and identical |
| `tabs` | two tabs: output streams into the hidden one, its PTY keeps its size, shown again it is refitted; a reload restores tabs, order and the active tab |
| `tabstress` | five tabs in a narrow window: the strip scrolls, the page does not; rapid switching while two tabs flood; zoom while a tab is hidden; a tab dragged to the front keeps its place across a reload |

## Needs

- Node 22+, and a headless Chromium: `E2E_CHROME=/path/to/chrome-headless-shell`
  (found automatically under `~/.cache/ms-playwright`).
- An ssh account to log into, by password: `E2E_SSH_HOST`, `E2E_SSH_USER`,
  `E2E_SSH_PASSWORD`. Loopback addresses are on websh's deny-list; use
  the machine's real address. `tmux` on that host for the persistent
  scenarios.
- `sudo` for `drop`, `silent`, `away` (they cut connections with `ss -K`
  and an iptables chain of their own): passwordless, or
  `E2E_SUDO_PASSWORD`. Without it those scenarios are skipped, and the
  summary says so.

Put the exports in `tests/e2e/local.env.sh` (ignored by git);
`scripts/e2e.sh` sources it. Do not store the password itself - read it
from wherever it lives (`"$(pass show …)"`).

## What they touch

A private websh on port `E2E_PORT` (default 18765), started from the
working tree and stopped afterwards; its log is
`/tmp/websh-e2e-<port>.log`. Firewall rules live in their own chain
(`WEBSH_E2E`) and are removed after every scenario, pass or fail.
Persistent scenarios create tmux sessions named `websh-<user>_<host>_…`
on the target and terminate them at the end. Nothing else is restarted,
killed or reconfigured - in particular, never a deployment, and never a
tmux server.

`--url` runs only `smoke`, `typing` and `offline`: no faults, no
restarts, one short-lived session each.

## Adding one

A file in `scenarios/` exporting `meta` (`about`, `ssh`, `local`,
`sudo`, optional `env` for the private instance) and
`run({ b, t, server, port })`. `b` is the browser (`lib.mjs`: `connect`,
`split`, `type`, `lines`, `state`, `network`, `freeze`…), `t.ok(cond,
what)` records a check. Wait with `until(...)`, not with a fixed sleep,
wherever the thing waited for can be observed.
