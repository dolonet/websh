# SSE transport and fallback — design notes

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
to print yet — flushes it instantly.

### Fallback: long-poll (`GET /api/output`)

The pre-existing 10-second long-poll. Same JSON payload; no
multi-message framing. The frontend uses this when SSE doesn't reach
it. While long-polling it tries the stream again from time to time
(2 min, doubling up to 30 min) - NEXT TO the poll loop, so output never
pauses for the attempt - and switches back once an event has actually
arrived. One poll loop per pane: starting any output channel
invalidates the previous loop's ticket (`p.outGen`).

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
   fall back. Exception: a timer that fired late (the page was frozen
   or the machine asleep) or while the browser is offline proves
   nothing - the stream is simply started over.
5. If `onerror` fires *before* any body event, check the session over
   plain HTTP and open the stream again; three such failures in a row
   fall back to long-poll. Once SSE has delivered at least one body
   event, transient errors are left to EventSource's own auto-retry
   plus our wall-clock budget (below).

### Silent connection death

A connection that dies without a FIN - Wi-Fi switched, laptop slept, a
NAT dropped the mapping - raises no error in the browser: the
EventSource stays `OPEN` and silent, a long-poll never answers. Keys
still go out (each `/api/input` is a new request), nothing comes back.
Three independent detectors restart the output channel from the pane's
cursor (`kickOutput`), so nothing is lost or printed twice:

- **Heartbeat.** The server sends `event: ping` every 15 s of silence;
  a stream with no event for 40 s is restarted. Armed only after the
  first ping, so older servers are unaffected.
- **Input cursor.** Every `/api/input` reply (keystrokes and the 30 s
  keepalive) carries the session's output offset; a pane still behind
  it 2 s later restarts its channel. This is the fast path: about 2 s
  after the first keypress.
- **Environment.** The browser's `online` event, a return from a long
  absence (`visibilitychange`, bfcache), or a jump of the page's own
  clock (sleep/freeze) restart every pane's channel.

Long-poll requests are aborted after 25 s (the server answers within
10), an unanswered `/api/input` after 10 s.

### Input

One `/api/input` per pane is in flight at a time; keys typed meanwhile
form the next batch. Requests fired without waiting overtook each
other (HTTP/2 multiplexing, then one backend thread per request) and
text arrived scrambled. A reply that proves the bytes never reached
the PTY (503, 429, 502) resends the same batch first; a network error
is not retried - the write may have landed, and a doubled key is worse
than a lost one. `404` means the session is gone: the pane reconnects,
and for a persistent pane the batch is held for the re-attach (see
`docs/persistent-sessions.md`, "Coming back after an absence").

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

## At most one `/api/stream` per session

`SSHSession.read()` is destructive. Two concurrent SSE consumers for
the same session would race for bytes — each wakeup drains a fragment
into one consumer's local variable, the other gets the next fragment,
neither sees the full byte stream. A second `/api/stream` for an
already-streaming session is the client reconnecting, so the newest
wins: it bumps the session's stream generation, the holder steps aside
before its next read and the slot changes hands in milliseconds. Only
a holder that cannot step aside within ~2 s leaves the newcomer with
`409 Conflict` ("stream already active for this session"). The consumer holds
a per-session flag (`_stream_active`) under `sessions_lock` from the
moment the request validates until the handler returns through any
exit path — clean end, BrokenPipe, or unexpected exception.

`/api/output` (long-poll) does not enforce a similar guard. Two
long-poll clients overlapping is unlikely in practice (the browser
opens at most one per pane, and the poll window is short) and the
protocol stays backwards-compatible with anyone hand-crafting
requests against it.

## Known limitations

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

The current shape: each `Session` owns a `threading.Event`
(`_data_event`). The PTY reader calls `_signal()` (which is
`_data_event.set()`) after every `output_buf` update. Consumers
(`_stream`, `_output`) park in `Session.wait_for_data()`, which
interleaves short `Event.wait` slices (20 ms) with non-blocking
`selector.select(0)` polls of the client socket. Wakeups happen
exactly when something interesting does: new bytes from the PTY
(Event set, instant wake), client closed the connection (socket
readable + FIN, ≤20 ms wake), or the keepalive cadence fires.

The 20 ms FIN-detection bound is what falls out of the slice length.
Empirical review measured that 50 Hz polling of the client socket
adds ~20 ms latency in the worst case and is UX-imperceptible — we
keep that property without the busy-poll cost. Wake-on-data is still
microsecond-scale because it doesn't go through the slice loop:
`Event.wait` returns immediately when set.

`Handler` builds the selector once per request via
`_build_session_selector` and reuses it across every loop iteration —
that avoids paying `epoll_create1` + `epoll_ctl` + `close` on each
wakeup.

The previous shape used `os.pipe()` plus `weakref.finalize` to bind
fd lifetime to GC and defeat an fd-reuse race during teardown. The
Event-based form has no fd, no kernel resource, and no teardown
ordering hazard, so that whole machinery (and the Windows-specific
`_HAVE_SELECTABLE_PIPES` fallback) is gone.

Sessions that the SSE branch interacts with go through the same
`SSHSession.read()` as long-poll does — there's no separate buffer,
no separate reaping path. From the session's point of view, SSE is
"a slightly hungrier reader".
