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
Fixed sleeps made one run in six fail.

**T3. A fix comes with a test that fails without it.** Check it: put
the old code back and watch the test go red.

**T4. What depends on timing is proven in a real browser, repeatedly.**
Unit tests passed while four input races were live; `tests/e2e/run.mjs
--repeat 10 away` found them.

**T5. CI is part of "green".** The backend failed on every push for
days - one test needed the developer's `TERM` - and nobody looked,
because the local run passed. `scripts/check.sh` now runs the backend
without a terminal, as a runner does; after a push, read the result.
