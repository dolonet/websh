# Invariants

Behaviour that was broken once, hurt a user, and must not break again.
Each entry says what must hold, why (what happened when it did not),
and what guards it. Before changing code in one of these areas, read
the entry; if a change needs to break one, that is a design decision to
raise, not a refactor.

Find a guard: `scripts/codemap.py <word>` prints matching tests with
their current line numbers. Browser scenarios are in `tests/e2e/`.

## Input

**I1. One `/api/input` per pane is in flight at a time.**
Requests fired without waiting overtake each other (HTTP/2 multiplexes
them, the backend runs one thread per request): typed text arrived
scrambled - "ecoh" for "echo". Keys typed meanwhile form the next batch.
Guard: frontend `input: keystrokes reach the PTY in the order typed`;
e2e `typing`, which holds the first real input POST while additional
chunks are typed, then checks that none overtook it and the shell
received the command exactly once in order.

**I2. A failed input is resent only when the reply proves it never
reached the PTY** (503, 429, 502). A network error is not retried: the
write may have landed and only the reply was lost, and a doubled key
(`rm` then Enter, twice) is worse than a lost one.
Guard: frontend `input: a busy (503) reply…`, `input: a network error is
not retried`.

**I3. Keys are never replayed into a different shell, and never stale.**
Held keys go out only when a *persistent* pane re-attaches to its tmux
session, within `INPUT_HOLD_MS` (20 s). A non-persistent reconnect is a
new shell. A pane nobody is reconnecting drops what is typed at it.
Guard: frontend `input: keys for an expired NON-persistent session…`,
`input: typing on a disconnected pane…`, `input: held keys older than…`.

**I4. What is typed on returning to an expired persistent session
arrives.** Four separate ways to lose it were found; each has a test:
the keepalive's 404 landing first, keys wiped while waiting their 10 ms,
keys typed while re-attaching, keys sent before tmux had attached (the
ssh login eats them - hence the input gate).
Guard: frontend `input: keys …` (five tests); e2e `away`, which must
pass repeatedly (`--repeat 10`), since every one of these was a race.

## Output

**O1. Output is read by cursor and never consumed by a reader.** Any
channel may be restarted at any moment from `p.outCursor`; the client
trims what it already has. This is what makes every recovery below
safe. Guard: backend `TestOutputCursor`, `TestLosslessReconnectHTTP`;
frontend `lossless reconnect: …`.

**O2. One output loop per pane.** Starting any channel takes a new
ticket (`p.outGen`); a loop holding an old one stops. Two poll loops
once ran side by side and doubled every request.
Guard: frontend `only one poll loop per pane`.

**O3. A silently dead connection is noticed and the channel restarted.**
No FIN, no error in the browser (Wi-Fi switch, sleep): the pane sent
keys and showed nothing until a reload. Detectors: server `ping` event
(40 s of silence), the output offset in every `/api/input` reply (2 s),
`online` / return from absence / Page Lifecycle `resume` / a jump of the
page clock. Guard: frontend `stalled stream: …`, `input reply ahead of
the pane's cursor…`, `network back (online event)…`; backend
`TestStreamEdges`, `TestInputReplyCarriesCursor`; e2e `silent`.

**O4. SSE is given up only for a reason that lasts.** One failed
stream, or the first-message timer firing late after a sleep, used to
put a pane on long-polling until reload (20 000 requests a day per
client). Long-polling panes probe the stream *next to* the poll loop.
Guard: frontend `SSE refused before its first event…`, `a long-polling
pane tries the stream NEXT TO the poll loop…`, `first-message timer
firing late…`.

**O5. The newest `/api/stream` for a session wins.** The old holder may
be writing into a dead connection for minutes; it steps aside.
Guard: backend `test_stream_takeover_replaces_a_stale_holder`.

**O6. A file goes up in pieces, and a piece can never land twice or
skip bytes.** One long POST was cut mid-body by corporate proxies and
VPNs every time; the owner switched networks to upload anything. The
server appends a piece only at the exact size the file has and reports
the real size otherwise (409), so retries are safe. Overlapping retries
for the same immutable offset must not append the bytes twice. A late
first-piece retry must preserve bytes from later pieces; only legacy
whole-file uploads (`offset=None`) may truncate an existing file. If the
reported size exceeds the selected file, the client must stop or use a
fresh staging name instead of restarting against the occupied path.
Guard: backend `test_upload_in_pieces_appends_at_the_right_offset`,
`test_upload_piece_at_the_wrong_offset_is_refused_with_the_real_size`,
`test_overlapping_upload_retries_never_duplicate_bytes`,
`test_repeated_first_upload_piece_preserves_later_bytes`,
`test_upload_unaligned_offsets_and_legacy_overwrite`;
frontend `upload in pieces: …`; e2e `upload` (two connection resets
under a 12 MB upload, sha256 compared on disk).

**O7. A hyperlink a program prints (OSC 8) is a link in the browser,
in a plain pane and in a tmux pane.** Claude Code, `ls --hyperlink`,
gcc print `ESC ] 8 ; ; URL ESC \ text ESC ] 8 ; ; ESC \`; the owner
clicked such words and nothing happened (2026-10). Two layers lost it:
tmux 3.4 re-draws a pane for the outer terminal and drops OSC 8 unless
that terminal has the `hyperlinks` feature, which websh's tmux command
did not set; and xterm.js without a `linkHandler` answers every click
with a confirm() "WARNING" dialog and shows no target. What must hold:
the link survives tmux (new session, re-attached session, any running
tmux server) without the server-wide option growing on every connect,
and a tmux that predates the option still attaches; hovering shows the
real target (the text may differ); a plain, Ctrl or Cmd click opens one
tab at exactly that target, no dialog, no opener; only http(s) open -
javascript:, data:, file: never do. Plain URLs open as before.
The hover box exists to show where a link really goes, so it must show
the host that would open near its start: a target like
`https://github.com:<200 x>@evil.example/` shown raw was cut by the
box's ellipsis after "https://github.com:xxx" (found before release,
2026-10-04). It goes away with its terminal: a pane closed under the
pointer gets no `leave` from xterm, and the box stayed on screen.
Guard: backend `TestTmuxForwardsHyperlinks`, `TestTmuxAttachOnAnyVersion`
(against tmux 3.1c: `scripts/check.sh --full`, leg "tmux 3.1c attach
chain"); frontend `test_links.js`; e2e `links`, `linkbreak`.

**O8. A link at rest looks the way the program printed it - no
underline websh or xterm adds.** The owner (2026-10-05): "remove the
underline under hyperlinks; their colour is enough". xterm.js 5.5 gives
every OSC 8 cell a dashed underline of its own (its `underlineStyle`
answers 5 whenever the cell carries a link id), and the same override
turns a program's own SGR 4 / 4:3 on link text into dashed. Claude Code
prints links as colour only (SGR 94, no SGR 4); tmux 3.4 re-emits them
with no underline either. What must hold: OSC 8 text and plain URLs
show no underline at rest; the hover underline, pointer cursor and
target box appear on hover and go with it; a program's own underline
(4, 4:3, 4:4, 4:5) is drawn in its own style, on a link or not - so no
blanket CSS that hides `xterm-underline-5`. Guard: e2e `linkstyle`
(pixels below the baseline against the same text unlinked, and the
computed decoration of the DOM renderer's spans).

## Layout and tabs

**U1. A pane in a hidden tab is never fitted to its hidden box.**
A hidden tab's root is `display:none`, so its panes have a 0x0 box; a
fit there makes a 2x1 terminal and, through `onResize`, a 2x1 PTY -
for tmux, every other client of that session is squashed too. Every
fit path skips such a pane and marks it (`_fitDeferred`): the
ResizeObserver callback, `fitPaneWhenStable` (also between its settle
steps), `applySettings` (zoom, font), `beginSessionIO`, the split drag
and close refits, the drift watchdog. The absence kick still restarts
the output of hidden panes (its `onSettled` runs without the fit).
`showTab()` applies the current display settings, fits every pane of
the tab once, and the PTY is resized only if cols/rows changed
(`flushPaneResize` dedups). On reload each tab is built while its root
is on screen, so panes restored into background tabs connect at a real
size. Guard: frontend `tabs: a hidden tab keeps its output and is never
fitted…`, `tabs: showing a tab fits its panes…`, `tabs: the recovery
after a long absence reaches panes in hidden tabs`, `tabs: a zoom made
while a tab is hidden…`. The e2e scenarios `tabs`/`tabstress` do NOT
guard U1: Chromium's fit addon happens to propose nothing for a
`display:none` box, so with every one of these skips removed they stay
green (checked 2026-10-01). The unit harness proposes 2x1 for a 0-size
box - what the addon does for a box that is laid out but empty - and
that is the guard.

**U2. Hidden tabs are alive.** Streams, keepalive, input queues and
held keys, reconnects and the absence kick apply to every pane, not
only to the tab on screen; nothing in the transport or input code may
filter by the active tab. A pane's state changes reach its tab's dot
whether or not it is the active pane. Guard: frontend `tabs: a hidden
tab keeps its output…`, `tabs: the dot shows the worst pane state…`;
e2e `tabs`.

**U3. A layout saved by an older version still loads.** The manifest
is versioned (`PANES_VERSION`); version 2 (one layout, no tabs) loads
as one tab holding that layout, and the panes keep their sessionStorage
secrets. Guard: frontend `tabs: a manifest saved by the previous
version loads as one tab…`.

**U4. A lone pane has no bar, and the bar coming or going resizes
the PTY once.** A tab with exactly one pane is `.tab-root.solo`: the
pane bar is hidden, its actions are in the top bar (`#paneTools`, on
the active pane), a transfer's progress moves into the pane's overlay
stack. `renderTab` recomputes this on every call, so any path that
changes a tab's pane count (split, close, dismissed split, restore, and
a move between tabs - which must render BOTH tabs) keeps it right. The
refit is the pane's ResizeObserver: one fit, one debounced, deduped
`/api/resize`; a hidden tab's pane is skipped as in U1. On reload the
solo state is set before the synchronous fit, so a restored lone pane
connects at its full height. Guard: frontend `solo: …`; e2e `tabsolo`
(`stty size` against the terminal after split and close).

**U5. Moving a pane never reconnects it.** Moving a pane to a new
tab, into another tab, or merging a whole tab beside a pane moves the
pane ELEMENT only (`movePaneToNewTab`, `movePaneToTab`, `mergeTabInto`
and the mouse drags that call them). No connect or disconnect, no
stream restart, no `term.reset`/`dispose`/`open`: the session, the
scrollback, the input queue and held keys, and an upload in progress
stay on the pane object, and a tab is only a DOM container (a pane's
tab is read from the DOM, never stored). The move is synchronous up to
`saveSessions()`, so the saved layout never shows half a move and the
ResizeObserver sees only the final boxes: one fit and at most one
`/api/resize` per pane whose size changed; a pane left behind in a tab
that is now hidden is fitted when that tab is shown (U1). Both tabs are
re-rendered, so the solo state is right on each side (U4). Re-parenting
resets the scroll position of xterm's viewport to 0 while xterm keeps
showing the bottom; `_resyncScroll` puts it back (for a hidden pane,
`showTab` does it after the fit, U6). Drags are plain mouse events, never HTML5
drag-and-drop, so a pane or tab drag cannot reach the file-drop
handlers and an OS file drag cannot start a move. A spring-loaded
switch during a drag (resting on another tab) shows that tab without
saving; a drag that drops nothing shows the tab that was in front at
the press again, so the saved layout and active tab are untouched.
The menus ("Move into tab", a pane's "Move to tab") call the same
`mergeTabInto` / `movePaneToTab`. A tab's name belongs to the tab
(`t.name`, saved as `name` in its manifest entry): moves into it keep
it, a tab merged away takes its name with it, a pane taken out gets
the automatic title. A tab's menu goes when its tab goes (closed by
Alt+W, its shell, another menu): it must not float over the strip
offering Rename / Close for nothing. Guard: frontend
`Tabs (step 3)` block, `tab name: …`, `spring: …`, `marker: …`,
`tab menu (break): …`; e2e `tabmove`, `tabback`, `tabbreak`.

**U6. A shown pane's scrollbar is at the bottom it shows.** xterm
5.5's viewport sizes its scroll area from the viewport's offsetHeight
whenever output or a resize arrives; in a hidden tab that height is 0,
so the area comes out one screen short and the scrollbar is clamped a
screen above the bottom. Shown again at a different size (a window
resize while hidden, a merge from another tab) nothing may refresh it
before the first wheel: the notch is eaten or jumps a screen. `showTab`
fits each pane with `onSettled: _resyncScrollSoon`, which re-runs the
viewport's own refresh (`_innerRefresh`) with the pane on screen and
fitted, and once more on the next frame (the renderer takes its new
canvas size on its own frame). It touches only the DOM scroll state: no
fit, no `/api/resize`. Guard: e2e `scrollpos` (intermittent before the
fix: ~1 in 30 for a resize while hidden, up to 1 in 3 for a merge, so
run it with `--repeat`).

**U7. A tab key never reaches the shell; no other Alt key is taken.**
Alt+1..9, Alt+T, Alt+W and Alt+Shift+[ / ] are matched by `e.code`
(Cyrillic layouts, macOS Option symbols) with plain Alt only - not
Ctrl+Alt (AltGr), not Meta. In a terminal they are taken in xterm's
custom key handler (a document listener never sees them: xterm sends
ESC+x and stops the event) and the keydown is prevented, or macOS types
the Option symbol into the shell. Every other Alt combo (readline's
Alt+B/F/./D, Alt+arrows, Alt+[) goes to the shell unchanged. While any
`.ov` dialog is up the keys do nothing. In a text field that is not
xterm's helper textarea (search box, a pane's reconnect password, any
contenteditable) they are not taken at all and nothing is prevented:
every Alt/Option character types there (the tab-name field stops its
keys itself: nothing in it switches, closes or opens a tab). During a tab or pane-bar drag
(from the press to the release) they are taken - prevented, never sent
to the shell - but do nothing, so the release drops exactly where it
would have. `tabKeyHandled()`. Guard:
frontend `tabs keys: …`; e2e `tabkeys` (real key events, Mac platform
included).

**U8. Reconnect is in the pane's bar row and never resizes the
terminal.** A disconnected pane has exactly one Reconnect control
(`[data-reconnect]`: message, password input, button). In a split it
is inside that pane's `.pane-bar`, centred when the centred control
clears the badge/tag and the buttons, otherwise right next to the
buttons - never over a button, the Reconnect button always in view and
clickable; the message gives way first. A lone pane has no bar (U4):
the control sits in `.reconnect-strip`, a bar-high strip drawn over
the top of the terminal (`position:absolute`), so it appearing and
going away is no refit and no `/api/resize`; the overlay stack moves
below it. It is one element moved between bar and strip
(`placeReconnect`, on every `syncTabSolo`), so a pane going split /
lone / to another tab while disconnected keeps the typed password, and
a focused password input gets its focus back (re-parenting drops it to
`<body>`). The owner asked for this place on 2026-10-05 ("in the row
where 'persistent' is written, in the middle"); a card over the
terminal is what it replaced. Guard: frontend `reconnect in the bar:
…`, `reconnect strip: …`, `reconnect strip <-> bar: …`, `status bars
float over the terminal…`; e2e `reconnectbar`, `reconnectbreak`
(geometry: measured in Chromium at several widths, DPR 1.5, font
zoom, tab switches).

**U9. A split or a close moves no other divider.** Splitting a pane
puts the new split where the pane was, with the pane's share of its
parent (`flex`), and halves it; closing a pane gives the sibling the
split's share. Before, a split made the wrapper `flex:1` and a close
cleared the sibling's `flex`: with A | B dragged to 70/30, splitting B
threw A to about 41%, and closing a pane of a nested split moved the
outer divider. The saved layout carries the ratios, so a reload shows
the same. The tab's miniature draws these proportions too (from the
flex values, not by measuring; redrawn only when a box's whole-pixel
size changes). Guard: frontend `divider share: …`, `marker ratio: …`;
e2e `tabback` (a real handle drag, then a split and a close, measured
in pixels).

**U10. An impossible action is not shown; a briefly unavailable one is
disabled.** With one tab there is nowhere to move a pane: every "Move
to tab" button (`[data-act=move-to]`, the top bar of a lone pane and
every pane bar) is hidden, the tab menu has no "Move into tab", and
the only tab cannot be dragged (no dimmed tab, no grabbing cursor; the
release is a click and the next click is not swallowed). They come
back the moment a second tab exists, and go the moment it is gone by
any path: its x, a middle click, Alt+W, its last pane closed, its pane
moved away, a merge by menu or drag; and after a reload. `+` then
Escape, or a failed connect, makes no tab and shows nothing. Upload /
download while disconnected or during a transfer stay visible and
disabled: hiding them would make the bars jump on every drop. The
owner asked on 2026-10-06 ("remove Move to tab when there are no other
tabs"); before, the button opened a menu saying "No other tabs" and
the tab menu showed a greyed item. The tab count is part of
`renderPaneTools`' memo (body `one-tab`): without it, a background
tab closing left the button up. A bar's button set changing also
changes the width the Reconnect control must leave free (U8): its
measurement must follow it. Guard: frontend `hide: …`, `hide (break):
…`; e2e `tabhide` (hit-tested, 560 px), `reconnectbreak` (a second tab
opened while a split pane is disconnected).

## Server lifecycle

**S1. A websh restart is not the end of a session.** While shutting
down, streams drop without `end`, long-polls answer 503
`{"code":"restarting"}`; never `alive: false`, which means the remote
shell exited. Otherwise every deploy leaves every pane at Disconnected.
Guard: backend `TestShutdownIsNotSessionEnd`; e2e `restart`.

**S2. A client that went away is not a server error.** BrokenPipe /
ConnectionReset in a handler is an INFO line and no reply.
Guard: backend `TestDispatchClientGone`.

**S3. The ssh child is always reaped**, including on the auth-failure
path that breaks out of the read loop early. Guard: backend
`TestReapChild`.

**S4. Output still in the PTY when a session stops is delivered** before
the session is reported ended. Guard: backend
`TestReadLoopDrainsOnStop`, `TestStreamEdges`.

## Security (see also `docs/security.md`)

**X1. A session never authenticates with the websh host's own keys or
ssh agent.** Guard: backend `TestBuildSshCommand` and the `ssh -G` tests
next to it.

**X2. A broken or unreadable `websh.json` fails closed**: the last good
policy stays, never "no restrictions". Guard: backend `test_config.py`.

**X3. An unreadable credentials file is never rewritten** from an empty
in-memory store. Guard: backend `TestVaultLoad`, `TestVaultWrite`.

**X4. The stored password is typed only at ssh's own login prompt**,
inside a short window; user input disarms it.
Guard: backend `TestPasswordAutoTypeWindow`.

**X5. Side-channel snippets run in `sh`, quoted**, never in the remote
user's login shell. Guard: backend `TestSideChannelSnippetsExecuted`.

**X6. Remote output cannot replace the clipboard by itself** (OSC 52
needs a user gesture). Guard: frontend `CURSOR_HIDE: OSC 52…` and the
clipboard tests around it.

## Tests themselves

**T1. A green run means `failed: 0`.** A frontend run that dies prints
no summary; that is a failure. `scripts/check.sh` enforces it.

**T2. Tests wait for a signal, not for time.** The frontend harness
waits on `bootReady`; hand-built windows are closed with `closeDom`.
Fixed sleeps made one run in six fail. In a browser scenario one synthetic
mouse jump straight onto a link, pressed at once, can click before
xterm has let go of the previous link (after output scrolled): `links`
opened nothing 1 run in 10-15 until its click approached in two moves,
waited for the pointer cursor, and its print waited for the prompt
(0 in 15 since). And websh
swallows a click within 400 ms of a drag's release
(`_blockClickAfterDrag`): a scenario waits that out (`tabbreak`'s
`calm`), it does not race it. Link-click scenarios target inert local
JSON (`/api/ping`), never the application root: a popup at the root
restores the saved workspace and can detach the very tmux pane whose
next link is being tested.

**T3. A fix comes with a test that fails without it.** Check it: put
the old code back and watch the test go red.

**T4. What depends on timing is proven in a real browser, repeatedly.**
Unit tests passed while four input races were live; `tests/e2e/run.mjs
--repeat 10 away` found them.

**T5. CI is part of "green".** The backend failed on every push for
days - one test needed the developer's `TERM` - and nobody looked,
because the local run passed. `scripts/check.sh` now runs the backend
without a terminal, as a runner does; after a push, read the result.
