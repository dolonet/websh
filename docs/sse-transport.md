# SSE transport, fallback, and local echo — design notes

How terminal output gets from the server to the browser, why it's
shaped that way, and the parts that aren't obvious from reading the
code.

## What we do today

Output from the SSH PTY reaches the browser through two transports
that share one wire format. Input always goes up as short POSTs to
`/api/input`.

### Primary: Server-Sent Events (`GET /api/stream`)

`server.py:_stream` opens a long-lived response with
`Content-Type: text/event-stream`. Each chunk of PTY output is wrapped
in a named SSE event:

```
event: data
data: {"data": "<base64>", "alive": true, "auth_failed": false}

```

— same JSON shape as a single `/api/output` long-poll response. When
the session ends we send one final `event: end` carrying `alive:false`
and the auth flag, then close. Comment heartbeats (`: keepalive\n\n`)
go out every 15 s if no real data has flowed, so middleboxes don't
idle the connection.

After the headers we emit two priming writes. First a comment line
(`: ok\n\n`) — purely human-readable, useful when inspecting the
stream with curl or in DevTools. Second, a real (empty) `event: data`
frame. The frame is what actually disarms the frontend's first-message
timer: EventSource doesn't fire any event for SSE comments, so the
comment alone proves nothing client-side. Buffering proxies hold the
body and never let the frame through (timer fires, fallback to
long-poll). A healthy channel — including a session that has nothing
to print yet — flushes it instantly. The primer carries the same
shape as every other data frame, including the current `echo_off`
hint, so the local-echo gate is correct from frame 1.

### Fallback: long-poll (`GET /api/output`)

The pre-existing 10-second long-poll. Same JSON payload; no
multi-message framing. The frontend uses this when SSE doesn't reach
it, and never re-tries SSE for that pane (no flapping).

### How the frontend chooses

`websh.js:startOutput` does the dispatch:

1. If `EventSource` isn't a thing (very old browser), go straight to
   long-poll.
2. Open `EventSource('/api/stream?...')`. Start a 5-second timer.
3. The server's primer `event: data` arrives almost immediately on a
   healthy channel, fires the `'data'` listener, and disarms the timer.
   `'open'` (HTTP headers) deliberately does **not** disarm it —
   buffering proxies pass headers through but hold the body, which is
   exactly the case we're guarding against.
4. If the timer fires with no `'data'` / `'end'` event, an upstream is
   buffering us. Close the EventSource, set `p.sseDisabled = true`,
   fall back.
5. If `onerror` fires *before* any body event, treat as "this transport
   doesn't work here" and fall back. Once SSE has delivered at least
   one body event, transient errors are left to EventSource's own
   auto-retry plus our wall-clock budget (below).

The `'open'` event (HTTP headers received) is deliberately **not**
listened to. Headers traverse a buffering proxy fine while the body
sits in the buffer — disarming the timer or resetting the retry
budget on `'open'` would mask exactly the failure mode the rest of
this machinery is designed to detect. Only body events
(`event: data` / `event: end`) prove the channel actually flushes.

### Wall-clock reconnect budget

Both transports share `nextRetryDelay(p)`. The first time a request
fails, we stamp `p.firstFailureAt = Date.now()`. While
`Date.now() - p.firstFailureAt < RECONNECT_BUDGET_MS` (60 s), retries
are silent on backoff `[1, 2, 5, 10, 15]` seconds. After 60 s of
unbroken failure we surface the red "connection lost" banner and stop.

This replaces the old "5 retries cap" — a 30-second Wi-Fi blip on a
phone now lands in the silent-retry window instead of producing a
banner the user has to dismiss.

### Local echo prediction (Mosh-style lite)

`websh.js:predictKey` is wired into `term.onData`. For a single
printable **ASCII** character (codes 32-126) typed in the **normal**
xterm buffer (not alt-screen), we:

1. Append the char to `p.echoQueue`.
2. Render it immediately at the cursor with dim SGR
   (`\x1b[2m` … `\x1b[22m`).
3. Schedule a 1-second TTL timer that wipes any unconfirmed
   predictions.

When server output lands, `consumeEcho(p, chunk)` reconciles. Three
cases:

- **No common prefix.** Server didn't echo what we predicted (vim,
  autocomplete, command running). Backspace over the dim chars,
  overwrite with spaces, then write the server bytes on a clean slate.
- **Full prediction confirmed.** Backspace over the dim chars, write
  the same chars at normal intensity, then the rest of the chunk. The
  user sees the dim chars promote to solid the moment the server
  catches up.
- **Partial match.** Confirm the matched prefix at normal intensity,
  erase the unconfirmed tail, then continue with the remaining server
  bytes.

Predictions are wiped on:

- Resize (cursor coordinates may shift).
- Any non-printable / control / multi-byte input (Enter, Backspace,
  arrows, paste, IME composition).
- Pane close.
- The 1-second TTL.

Non-ASCII printable input (Cyrillic, CJK, fullwidth, emoji) is **not**
predicted at all. Two reasons: (a) wide-cell glyphs (CJK, fullwidth,
many emoji) occupy 2 terminal columns, but `rewindEcho`'s `\b ` `\b`
sequence is column-only — it would leave half a glyph and a stray space
behind on rewind; (b) Cyrillic/Greek/Latin-extended is single-cell but
encoded as multi-byte UTF-8 on the wire, and `consumeEcho` matches the
prediction queue against base64-decoded server bytes byte-for-byte, so
a 2-byte Cyrillic char never lines up with a 1-character JS string.
Drop them at entry instead of producing visual artefacts.

## Lost-byte handling on disconnect

`SSHSession.read()` is destructive: it returns the contents of
`output_buf` and clears it under `buf_lock`. That means once a reader
has drained the buffer, the bytes only exist in that reader's local
variable. If the reader can't deliver them — the client closed the
socket, the PHP proxy aborted, the network blipped — those bytes are
gone unless we put them back.

Two protections, either of which is sufficient on its own:

1. **Peek for FIN before `read()`.** `Handler._client_gone()` does a
   non-blocking `recv(1, MSG_PEEK)` on the request socket each loop
   iteration. If the peer has half-closed (`recv == b""`), we bail
   *without* draining the buffer. The next reader (long-poll fallback
   or a fresh `/api/stream`) sees the unchanged buffer and delivers
   normally. Linux/macOS uses `MSG_DONTWAIT`; platforms without it
   fall back to `setblocking(False)` around the peek.

2. **`Session.unread()` after a write failure.** If `read()` already
   drained the buffer and the subsequent `wfile.write` / `wfile.flush`
   raises `BrokenPipeError`, we push the bytes back to the front of
   `output_buf`. Order is preserved (the unread bytes are older than
   anything `_reader_loop` has appended in the meantime). The next
   reader picks them up. `unread()` also fires `_signal()` so a
   consumer that's already parked in `wait_for_data` wakes up
   immediately rather than at the next keepalive deadline; in
   practice the next reader is a fresh request that read()s on
   entry, but the signal makes the contract symmetric with
   `_read_loop` and removes the latency dependency.

Trade-off: when the unread bytes plus fresh PTY output exceed
`OUTPUT_BUF_MAX`, the truncation rule (keep the last
`OUTPUT_BUF_KEEP` bytes) drops the oldest data — possibly the
unread part. We chose this over the alternative ("keep the unread,
drop the new") because the user-visible value of the buffer is
the *current* terminal state, not historical context. Buffer
overflow at the moment of disconnect is rare in practice.

There is still a thin race window: peek says "alive" → `read()`
takes the bytes → client sends FIN → `wfile.write` succeeds into
the TCP send buffer (kernel doesn't reject it) → bytes never
reach the application on the other side because the socket is
closed. Fully closing this window requires an application-level
ACK from the client, which is overkill — the practical result is
~1 µs of exposure on each pass through the loop.

## Disconnect idempotency

SSE delivers the session-end signal as up to three frames:
`{data, alive:false}` (last shell output), `{data:"tail", alive:false}`
(any bytes added between the previous read and the close), and
`event:end{alive:false}`. The browser's `EventSource` may dispatch
all three before our `close()` takes effect — the spec lets the
implementation queue events that arrive over the wire ahead of
close. Each frame would otherwise re-run the disconnect path:
banner, `showReconnectBar`, `saveSessions`, all duplicated.

`handleOutputPayload` enforces idempotency by structure:

```js
if (r.error) { if (!p.sid) return true; ...handle... }
p.connecting = false;
if (r.data) { ...always render... }
if (!p.sid) return true;       // guard for terminal-state branches
if (r.auth_failed) { ...handle..., p.sid = null }
if (r.alive === false) { ...handle..., p.sid = null }
```

The guard sits **after** the `r.data` handler, not before — a
tail-drain frame still has bytes that need to land in the terminal,
even if we already wrote the closed-banner. The terminal-state
branches all null `p.sid` on the first call, so subsequent frames
hit the guard and exit cleanly.

Predictions (`echoQueue`/`echoTimer`) are wiped on every disconnect
path *before* the banner is written, so a pending TTL timer can't
fire `\b`/space/`\b` on top of the freshly-rendered banner. Resize
also wipes them silently — `\b`/space/`\b` after `xterm.js` reflow
isn't actually silent (column-only backspace doesn't cross line
wraps) and would clobber legitimate content on narrowing.

## At most one `/api/stream` per session

`SSHSession.read()` is destructive. Two concurrent SSE consumers for
the same session would race for bytes — each wakeup drains a fragment
into one consumer's local variable, the other gets the next fragment,
neither sees the full byte stream. The handler refuses a second
`/api/stream` for an already-streaming session with `409 Conflict`
("stream already active for this session"). The first consumer holds
a per-session flag (`_stream_active`) under `sessions_lock` from the
moment the request validates until the handler returns through any
exit path — clean end, BrokenPipe, or unexpected exception.

`/api/output` (long-poll) does not enforce a similar guard. Two
long-poll clients overlapping is unlikely in practice (the browser
opens at most one per pane, and the poll window is short) and the
protocol stays backwards-compatible with anyone hand-crafting
requests against it.

## Known limitations

- **Local echo can desync after exotic escape sequences** that move
  the cursor in ways we don't track. The TTL and "any control char
  wipes" rules cover this in practice — desync clears in ≤1 s and
  doesn't propagate.
- **Long-poll fallback is per-pane, sticky for the session.** Once a
  pane decides SSE doesn't work, it doesn't try again. A user who
  changes networks (e.g. moves off a buffering corp proxy onto LTE)
  has to reload the tab to get SSE back. Acceptable; the alternative
  is flapping detection that can't really tell signal from noise.
- **`api.php` SSE passthrough is best-effort.** Some shared hosts
  force `output_buffering` on at the SAPI level so PHP can't flush.
  In that case the frontend's first-message timer fires, fallback
  kicks in, and the user gets long-poll. They never see this happen.
  The tradeoff is "every host works, some hosts get the lower-latency
  path" rather than "only some hosts work".

## Why these choices

### Why not WebSocket

WebSocket would also give low latency. It loses on:

- Many shared-hosting PHP environments don't support WebSocket — the
  whole reason `api.php` exists is to fit those hosts.
- WebSocket needs a protocol upgrade. Some corporate proxies allow
  HTTPS but block the upgrade; SSE is plain HTTP all the way.
- Adding it means two transports anyway (with the long-poll fallback
  for hosts that don't speak it), and we'd still need the fallback
  detection logic.

SSE wins on "same latency, simpler shape, plain HTTP".

### Why local echo on by default, no opt-out toggle

A toggle implies a meaningful tradeoff. The actual impact on the user:

- On a 0-ms loopback, the dim glyph is overwritten faster than the eye
  can perceive — invisible.
- On any real link, it's a perceptible reduction in input latency.
- On a desynced session (rare, ≤1 s window), the user sees a
  brief duplicate or stale character that self-corrects.

There's no scenario where someone wants to permanently disable it,
so a toggle would be UI noise. If it ever does need to be killed,
`p.echoEnabled = false` in DevTools is the escape hatch.

The one place we can't predict is at prompts that disable remote echo
(`sudo`, `mysql -p`, `passwd`, `gpg`, `read -s`, ssh passphrase). If
we predicted there, every typed char would render as a dim glyph at
the cursor for up to `PREDICT_TTL_MS` (1 s) before the server's real
(echo-suppressed) bytes arrived and the prediction was rewound — the
typed chars would be visible on a screen share or recording. The
local PTY between `server.py` and the ssh client is in raw mode
regardless of remote ECHO state, so we can't read the bit through
`tcgetattr()`. Instead the server runs a tail-of-output regex
(`ECHO_OFF_PROMPT_RE` in `server.py`) over the last ~256 bytes the
user saw, and forwards an `echo_off` boolean on each output payload.
The client toggles `p.echoEnabled` from it; `predictionsEnabled()`
short-circuits when it's `false`. Heuristic only — it matches the
common English `password|passcode|passphrase` prompt shape; exotic
prompts that ask for a secret without that word still leak the
keystroke, which is a known limitation.

The regex is intentionally narrow: it matches the keyword followed
by either an immediate `:` or the canonical PAM-style ` for X:`
shape (sudo, ssh-add, doas, polkit). Free-running prose like
`I forgot my password yesterday: ` is rejected because it doesn't
fit the label shape. ANSI control sequences — CSI (colors), OSC
(title-bar updates) and DCS — are stripped before applying the
regex so a prompt wrapped by terminal-control bytes still hits the
match. The `event: end` SSE frame also carries `echo_off` so the
client's prediction gate stays consistent through disconnect.

### Why a 60-second budget instead of N retries

A retry count is a proxy for "how long should I wait before
panicking". With variable backoff, the same retry count can mean
anything from 5 s to 5 minutes of elapsed time. A wall-clock budget
maps directly to "how long do I expect this network blip to last",
which is the actual question.

### How `_stream` and `_output` wait for new bytes

Both endpoints are long-running, blocking calls that must wake up the
moment the PTY produces output. They used to do this with a
`time.sleep(POLL_INTERVAL=0.01)` busy-poll inside the loop, which is
simple but wastes CPU on idle sessions and adds a fixed ~5 ms median
latency to every byte (half of `POLL_INTERVAL`).

The current shape: each `Session` owns a non-blocking `os.pipe()`. The
PTY reader writes one byte to the write end after every `output_buf`
update. Consumers (`_stream`, `_output`) park in
`Session.wait_for_data()`, which drives a `selectors.DefaultSelector`
on `(notify_pipe, client_socket)` with a timeout = next-keepalive
deadline. Wakeups happen exactly when something interesting does:
new bytes from the PTY (signal arrived), client closed the connection
(socket readable + FIN), or the keepalive cadence fires.

`Handler` builds the selector once per request via
`_build_session_selector` and reuses it across every loop iteration —
that avoids paying `epoll_create1` + `epoll_ctl` + `close` on each
wakeup.

Two pieces stay subtle. (a) Pipe fds are released by
`weakref.finalize`, NOT in `Session.close()`. Closing them on
teardown opens a real fd-reuse race where a reader thread's signal
between snapshot of `self._notify_w` and the `os.write()` syscall
could land a stray byte in a freshly-allocated unrelated fd. Tying
fd lifetime to garbage collection means the pipe stays valid as long
as anyone holds a Session reference, and is closed only after the
last consumer and the reader thread have released it. (b) Windows
`DefaultSelector` won't accept non-socket fds, so on POSIX-only the
machinery is active; on Windows `_HAVE_SELECTABLE_PIPES` is False
and `wait_for_data` falls back to the legacy `time.sleep` cadence
verbatim.

## What this means for the PR

Net new code paths:

- `server.py:_stream` (~80 lines)
- `websh.js`: `startOutput`, `streamOutput`, `handleOutputPayload`,
  `consumeEcho`, `predictKey`, `nextRetryDelay`, etc.
- `api.php`: `proxy_stream` (CURLOPT_WRITEFUNCTION-based passthrough)

Net unchanged surface:

- Existing `/api/output` continues to behave exactly as before.
- `/api/input`, `/api/connect`, `/api/disconnect`, `/api/resize`,
  `/api/upload*`, `/api/tmux_*`, `/api/ls`, `/api/download`, `/api/ping`,
  `/api/config` — untouched.
- All existing tests still pass. New tests cover `/api/stream`
  validation paths, the peek-FIN semantics
  (`test_client_gone_detects_fin` /
  `_false_with_pending_data`), the unread push-back contract
  (`test_session_unread_prepends`), an integration check that
  bytes survive a mid-stream client close
  (`test_stream_returns_undelivered_bytes_to_buffer`), and a
  frontend regression that drives `handleOutputPayload` directly
  with a three-frame disconnect sequence to confirm both
  tail-byte rendering and single banner emission.

Sessions that the SSE branch interacts with go through the same
`SSHSession.read()` as long-poll does — there's no separate buffer,
no separate reaping path. From the session's point of view, SSE is
"a slightly hungrier reader".
