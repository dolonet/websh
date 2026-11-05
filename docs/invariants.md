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
e2e `typing`.

**I2. A failed input is resent only when the reply proves it never
reached the PTY.** An explicit websh `busy`, `restarting` or
`rate_limited` refusal is before the write and permits a retry. A
502/503/429 status by itself proves nothing: a proxy can lose the
reply after the command executed. Such a reply and a network error
must never resend the batch; later keys still flow in order. A doubled
command (`rm` then Enter, twice) is worse than a lost key.
Guard: frontend `input: a generic HTTP ... after execution never
repeats a command`, `input: an explicit before-write refusal ...`,
`input: a network error is not retried`.

**I3. Keys are never replayed into a different shell, and never stale.**
Held keys go out only when a *persistent* pane re-attaches to its tmux
session, within `INPUT_HOLD_MS` (20 s). A non-persistent reconnect is a
new shell. A pane nobody is reconnecting drops what is typed at it.
If a sealed outage expires the held prefix of a command, discard the
whole accumulated outage input, including a recent suffix still in the
normal queue for that same session. Expiry is checked before accepting
a new keypress and before waiting on channel backoff: input already
queued at expiry is discarded, then the new keypress starts fresh
input. A held batch belonging to an old session is discarded without
dropping new input for the current one.
Executing the suffix alone can turn `echo filename` into
a different command. The user sees that the input was not sent, and
new typing after recovery works. Guard: frontend `sealed I3: an expired
held prefix drops the whole outage command including its recent suffix`.
Guard: frontend `input: keys for an expired NON-persistent session…`,
`input: typing on a disconnected pane…`, `input: held keys older than…`.

**I4. What is typed on returning to an expired persistent session
arrives.** Four separate ways to lose it were found; each has a test:
the keepalive's 404 landing first, keys wiped while waiting their 10 ms,
keys typed while re-attaching, keys sent before tmux had attached (the
ssh login eats them - hence the input gate).
Guard: frontend `input: keys …` (five tests); e2e `away`, which must
pass repeatedly (`--repeat 10`), since every one of these was a race.

**I5. Measuring input latency changes nothing about input.** The
page times every `/api/input` batch (queue, rtt, echo, paint, total)
and the server its own part (`srv`, `pty`) for the `client_lat` report
and the `input_lat` log line. Measurement only stores timestamps in
bounded lists: no key is delayed, held, reordered or resent because of
it, and a report that fails, is rate-limited (429) or meets an old
server (404: reports stop for the page) is dropped silently - never
retried in a loop, never shown, never opens a sealed channel.
Guard: backend and frontend `client_lat` / `input_lat` tests
(`scripts/codemap.py lat`); I1-I4's guards unchanged.

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
the real size otherwise (409), so retries are safe.
Guard: backend `test_upload_in_pieces_appends_at_the_right_offset`,
`test_upload_piece_at_the_wrong_offset_is_refused_with_the_real_size`;
frontend `upload in pieces: …`; e2e `upload` (two connection resets
under a 12 MB upload, sha256 compared on disk).

**O7b. A proxy that truncates uploads by size/duration must not freeze
the bar or lose the file.** On a corporate network every upload POST
over a size/duration was cut while a couple-of-KB file passed; nginx
logged the first 4 MB piece as 400 "client sent fewer bytes than
Content-Length" (sometimes 499, or a dropped connection), retried ~6×
over minutes, then gave up - the progress bar sat at 0% with no message
for many minutes and the file never arrived (download of the same size
worked) (2026-10). What must hold: a truncation signal - that 400/499,
our own short-body 502, a dropped connection (status 0), or a mid-body
stall - is treated as transient, and the piece size HALVES from the
FIRST cut down to `UPLOAD_CHUNK_MIN`, so a small-enough piece gets
through and the file still lands whole and byte-identical. Forward
progress (a landed piece) resets the try/wall-clock budget but KEEPS the
shrunk size. When it truly cannot get through, the upload fails FAST -
within `UPLOAD_WALLCLOCK_MS` of no forward progress, and ~2 attempts
once shrunk to the floor, not `UPLOAD_CHUNK_TRIES` × the 120 s per-piece
timeout - with a visible banner that names the probable cause ("Upload
blocked or cut short — a proxy or firewall on this network is likely
limiting uploads; a smaller file may still go through"). A genuinely
final reply (413, invalid path) still stops at once with its own
message, never the proxy text; a slow-but-progressing upload is never
killed by the wall-clock cap (onprogress re-arms it).
Where binary itself is blocked (an HTTPS-intercepting security product
on the user's machine answers application/octet-stream POSTs itself),
the upload does not give up: a non-websh reply, or cuts at the floor,
switch it to `{"b64": ...}` pieces that continue from the server's size
(the 409 resume), and the browser keeps that for 30 days. A stall (no
reply at all) never switches, and the switch never restarts the
upload's one wall-clock budget: a proxy that holds pieces still ends in
the visible failure within `UPLOAD_WALLCLOCK_MS` (e2e `proxytrunc`). Off that
path every request is what it was.
Guard (text fallback): backend `test_upload_text.py`; frontend
`test_upload_text.js` (`upload text: …`); e2e `uploadblocked` (an
interceptor that answers octet-stream POSTs 503: on the code before the
fallback both uploads failed "server error (HTTP 503)", as the owner's
did 26 times in 12-21 Oct).
Guard: frontend `upload in pieces: a truncated piece shrinks on the next
try`, `a 400 "fewer bytes" truncation … completes whole`, `forward
progress resets the try budget and keeps the shrunk size`, `an
unpassable truncation fails with a proxy/size cause named`, `no forward
progress is stopped fast`, `repeated timeouts give up fast with the
proxy-named banner`, `a stalled body fails fast on the wall-clock
budget`, `a slow but progressing upload is not killed`, `a final 400
(invalid path) stops at once`, `cancel during a shrink stops cleanly`;
e2e `proxytrunc` (a size-limiting middlebox: the upload completes by
shrinking; a stall surfaces a failure within the wall-clock bound).

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

**O9. Output that reached the page is on screen.** Users came back to
a hidden tab, typed, saw nothing; a reload showed it. A beacon caught
one: visible page, output written 5 ms before the reload, no render
for 18 s, and the first guard (timer only, off whenever the page said
hidden) never fired. xterm 5.5 stops drawing for good if anything
throws while it parses (no try/catch in its write loop or event
emitter: the queue is never resumed), or if its renderer stays paused /
its frame never runs. What must hold: the check runs on every write and
from a timer, counts from the first unrendered write (a trickle of
output cannot postpone it; a cursor-blink render while chunks wait
unparsed does not count), treats a focused page as on screen; recovery
resumes a stuck parse (skipping a throwing chunk), refreshes, then
resets the renderer, each with a `console.warn`. A pane coming back on
screen is repainted, refitted only if its box changed (no
`/api/resize` otherwise). Hidden tabs are not watched (U1, U2). A page
leaving with a stuck-looking pane sends one `client_diag` beacon (no
content), logged as one line - except in sealed mode (X7), where it is
not sent at all.
Guard: e2e `wedge` (a parser hook throws once while a plain pane
prints: typed text back on screen in ~0.2 s, output keeps flowing to
its last line, 3 rounds; on the code before the fix the pane froze at
the throw and nothing typed appeared in 15 s; and a 15 s spinner
triggers no `paint:` recovery).

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

**U11. A symlink to a folder is a folder in the file browser.** The
owner (2026-10-23): "I don't see mounted folders" - ~/job/БЮ_ОптРеш, a
symlink into an rclone FUSE mount, was listed as type "l", sorted among
the 128 files of ~/job with a link icon, and a click started a download.
What must hold: an entry `{"type": "l", "dir": true}` (the server marks a
link whose target is a directory) is sorted with the folders, has the
folder icon, is marked as a link, and opens on click at the LINK's path
(".." goes back to the folder holding it); a link to a file and a
dangling link behave as before; Delete and Rename act on the link only,
never on its target. Guard: backend `test_fb_links.py`; frontend
`test_fb_links.js`; e2e `fblinks` (sealed mode off and on).

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

**X7. Sealed mode never downgrades, and what crosses the network says
nothing.** The owner (2026-10): a work laptop behind a TLS-inspecting
proxy, DPI at the ISP - "nobody may read, or even partly understand,
what I type or upload". Written before release (not yet a bug that
reached a user): what must hold once the Options checkbox
"Encrypt traffic inside websh" is on. Every API call but `config` /
`ping` goes as `seal_open` / `sealed&c=<channel>`; no URL, header or
body carries an action, a session id, credentials, keys typed, output,
paths, file names or contents. If the channel cannot be opened, or the
server's identity differs from the pinned one, nothing is sent - not
in clear, not through the unverified key - and the user sees why.
A lost channel (410, a restart) is reopened and the request resent
once: no key lost or doubled. Keys typed while the channel is unusable
(key-changed modal open, channel cannot be opened, 410 backoff) follow
I3: a short blockage delivers them once, in order; older than
`INPUT_HOLD_MS` they are dropped, never delivered late. Through
`api.php` the sealed bytes pass unchanged and unbuffered.
Frames travel as text - requests `application/json` `{"f": base64}`,
replies `text/event-stream`, one `data: <base64>` event per frame -
never as `application/octet-stream`: on the owner's Mac an
endpoint-security product that intercepts HTTPS answered every
octet-stream POST with its own `503 text/html` (nginx: 400/499, 0
bytes), so the first, binary format failed for its only user on the
day it shipped (2026-10-21). A replayed, tampered or unknown-channel
frame executes nothing. Inside, a request means exactly what the plain
URL means (rate limits, access log with the inner action). Upload
pieces of one upload are one size on the wire, the total rounded up
to a size bucket, the file byte-identical. Off means today's requests,
byte for byte. The `client_diag` beacon (O9) is not sent while on.
Guard: backend `test_sealed.py` (a reference client, a wire tap that
looks at the raw bytes, a real PTY shell behind a fake `ssh`); frontend
`test_sealed.js` (a fake server speaking the wire contract, every
request recorded raw and decrypted; `sealed I3: …`); backend
`TestSealedThroughPhpProxy` (php -S or the websh-php-smoke image);
backend `TestSealedThroughNginx` (production's proxy directives);
e2e `sealed`, `sealedtoggle`, `sealedrestart`, `sealedblocked` (a
middlebox that answers octet-stream POSTs 503, as measured),
`sealedprod` (a production-like front: nginx stream + PROXY protocol,
HTTP/2), `sealedurl` (safe against a deployment), and any scenario with
`E2E_SEALED=1` (requests are still counted by their inner action;
`tabstress` there caught the lock badge squeezing the tab strip below
one tab's width at 560 px).

How the code holds X7: every API call goes through one of three
boundaries - `apiFetch` (fetch), `openEventSource` (the output stream),
`newApiXhr` (upload pieces) - which decide plain or sealed per call
from `settings.sealed`; the call sites are unchanged. A call that
cannot be sealed gets a local `503 {"code":"sealed_unavailable"}` that
was never sent (the output loops retry inside their budget; the input
queue holds the batch in `p.sealHeld`, ahead of later keys, and sends it
when the channel can be tried again), plus a toast and no badge. A second `410`
right after a fresh channel fails the call and backs off (2 s doubling
to 8 s, under `INPUT_HOLD_MS`) instead of looping. Keys are never delivered late (I3): a sealed
call whose caller gave up while it waited for the channel (the input
stall timer) is not sent, and an `input` that waited for the channel
longer than `INPUT_HOLD_MS` (the "key changed" dialog left open) is
dropped with a toast, never sent; held batches whose oldest key is older
than `INPUT_HOLD_MS` are dropped together with the normal input queue
for the same session, with that toast (never the end of a command
without its start). A held batch for an old session is discarded
without dropping new typing for the current session. Closing a sealed stream cancels its
body quietly - no unhandled rejection in the page. The server runs the inner request through
the same `_dispatch` with only path, headers, body and `wfile` swapped
(`Handler._sealed`), so I1-I4 and O1-O9 hold through it unchanged.

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
`calm`), it does not race it.

**T3. A fix comes with a test that fails without it.** Check it: put
the old code back and watch the test go red.

**T4. What depends on timing is proven in a real browser, repeatedly.**
Unit tests passed while four input races were live; `tests/e2e/run.mjs
--repeat 10 away` found them.

**T5. CI is part of "green".** The backend failed on every push for
days - one test needed the developer's `TERM` - and nobody looked,
because the local run passed. `scripts/check.sh` now runs the backend
without a terminal, as a runner does; after a push, read the result.
