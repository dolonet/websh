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
| `tabsolo` | one pane in a tab: no pane bar, the terminal has the whole pane and the PTY that size (`stty size`); a split from the top-bar button brings both bars back, closing back to one hides it with exactly one resize; upload through the real file picker from the top-bar button shows progress + cancel; a reload keeps it bar-less |
| `tabstress` | five tabs in a narrow window: the strip scrolls, the page does not; rapid switching while two tabs flood; zoom while a tab is hidden; a tab dragged to the front keeps its place across a reload |
| `tabmove` | panes moved between tabs with a real mouse: "Move to new tab" while the pane prints, a tab dropped on a pane's edge (zone shown before release), a pane bar dropped on the strip and on another tab: same sessions (tmux shell keeps its variable), output whole and in order, scrollback kept, PTY = terminal size; a reload restores the moved layout |
| `scrollpos` | a terminal keeps its scroll position when its element is re-parented (split, close, tab hidden and shown, window resized while hidden, moved or merged between tabs): scrollbar at the bottom where the terminal is, one wheel notch scrolls a few lines. The failure it guards was intermittent (1 run in 3 to 1 in 30): run it with `--repeat 10` |
| `tabkeys` | tab shortcuts with real key events (CDP, code + modifiers) into xterm's textarea: Alt+1..8 / Alt+9 / Alt+Shift+[ ] switch (wrap), Alt+T opens the form, Alt+W closes the tab (tmux confirm); bash never gets them (a leaked ESC+digit would repeat the next key; the wire is checked), Alt+B still moves bash's cursor, Ctrl+Alt+1 switches nothing, nothing under the login form; a Cyrillic layout (key "е"/"Ъ") and macOS Option (platform MacIntel, "¡"/"™"/"’"/"”") by e.code |
| `tabkeysbreak` | tab keys under stress: Alt+Shift+] held (autorepeat) while two tabs flood 4000 lines - all arrive in order, one layout shown, every PTY = its terminal, nothing on the wire; Alt+2 / Alt+W pressed during a real tab drag do nothing and reach no shell, the drag goes on and merges where its zone was shown; Ctrl+Shift+F still opens search from a terminal |
| `links` | OSC 8 hyperlinks (what Claude Code, `ls --hyperlink`, gcc print) in a plain and a tmux pane, clicked with a real mouse: OSC 8 reaches xterm through tmux, hover shows a link and its real target, plain/Ctrl/Cmd click opens exactly one tab at the target (Chromium's own target list) with no dialog, ST and BEL forms, link text that looks like another URL opens the target; javascript:/data:/file: open nothing; plain URLs still open; after a reload the re-attached tmux pane still passes links |
| `tabback` | putting a pane or a tab back into another tab: a tab renamed by a real double-click and typed text (survives a reload), the split marker drawn as a miniature of the layout (a real split-handle drag: the boxes follow the real proportion within ~300 ms of release, few DOM changes during the drag, none on a window resize; splitting the dragged pane keeps the other divider, closing it puts both back), a dragged tab and a dragged pane label held over another tab bring it forward (the strip reorders under the pointer meanwhile) and drop on a pane edge there; a quick pass switches nothing; released outside, the first tab is back; the tab menu by a real right-click merges a tab into another by name; same sessions, PTY = terminal |
| `linkstyle` | how links look, measured in pixels and computed style: OSC 8 link text (Claude Code's exact form: BEL, SGR 94) and plain URLs carry no underline at rest and keep the program's colour; hover draws the hover underline, pointer and target box, leaving takes them away; a program's own SGR 4 / 4:3 / 4:4 / 4:5 keeps its style, on plain text and on link text; a click still opens one tab |
| `linkbreak` | the link hover box under attack: a target whose real host hides behind a long userinfo (`https://github.com:xxx…@evil/`) shows that host; a 3000-character target stays inside the window; markup in a target is text; the box goes when the tab is switched by a key, when output scrolls the link away, when the pane is closed under the pointer |
| `tabbreak` | the tab features under attack: a rename left open while its tab is dragged into another tab (the half-typed name lands nowhere); rename by the menu + merge by the menu + reload; a tab's menu (and its tab list) while that tab is closed by Alt+W or another path; a drag held over "+"; the only tab dragged onto its own pane; a pane moved by "Move to tab" while 300 words are still being typed into it (all arrive, in order) |
| `reconnectbar` | the Reconnect control in the pane's bar row, measured in the browser: a split pane's sits inside its .pane-bar, centred (window 1200 / 900 / 700 px; bare, with the message, with the password input), overlapping no badge, label text, tag or button, clickable (hit-test) also in a ~260 px pane - centred when the centred control clears badge/tag and buttons, else right next to the buttons; a lone pane's sits in a bar-high, full-width strip at its top, centred; the strip never changes the terminal (cols/rows, screen box, `stty size`, no /api/resize); split -> lone while disconnected keeps the typed password and focus, Enter with the real password and a real click both reconnect; a lone pane's transfer card and the strip do not overlap |
| `reconnectbreak` | the Reconnect control under attack while a pane stays disconnected: auth_failed straight from a plain drop and the message changing in place, the window resized 1200 / 640 / 1000 / 560 px, terminal font zoom (split and lone), device pixel ratio 1.5, its tab hidden + window resized + shown again, three reconnect/drop cycles split and lone (one control, no stale strip, no /api/resize from the strip), the lone strip with the search bar, the tmux banner and the retry banner (no overlap). Placement: centred when there is room, else right next to the buttons, never over them |
| `tabhide` | a control whose action is impossible is not shown: with one tab no "Move to tab" (top bar of a lone pane, every pane bar; hit-tested) and no "Move into tab" in the tab menu; a second tab brings both back at once; closing it by its x or Alt+W, or emptying it by a move, hides them at once; a reload with one tab keeps them hidden; at 560 px the tab in front stays inside the strip as the button comes and goes; the only tab dragged with a real mouse shows no drag look and the next click is not swallowed, with two tabs the same gesture reorders |
| `tabnarrow` | narrow windows (560 / 600 / 640 / 660 / 900 px), five tabs, a lone pane in front (pane actions in the top bar): the strip has room for a whole tab, and every tab, shown, is fully inside the strip |

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
