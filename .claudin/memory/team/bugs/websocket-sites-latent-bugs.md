---
name: websocket-sites-latent-bugs
description: Latent bugs the 2026-10-17 coverage suites pinned as-is (not fixed) in the five WebSocket sites — sessions retry limits never apply, reconnect race, relay 502 gaps, headless double backoff, MCP double onclose, direct connect frame loss; plus Codex models calling Agent with no args
type: project
paths:
  - "src/platform/remote/SessionsWebSocket.ts"
  - "src/platform/upstreamproxy/relay.ts"
  - "src/platform/headless/transports/WebSocketTransport.ts"
  - "src/mcp/mcpWebSocketTransport.ts"
  - "src/mcp/client/transport.ts"
  - "src/platform/server/directConnectManager.ts"
---

Found while covering each file to ≥70% before moving its socket to `openWebSocket`
(#308, merged 2026-10-17). The suites pin today's behavior, so
fixing one means changing its test on purpose, in its own `fix(…)` commit.

- **SessionsWebSocket**: the retry limits (4001 ×3, others ×5) never apply to a real
  server — a close only arrives after an open, and the open resets both counters, so an
  accept-then-drop server is redialed every 2 s forever. `reconnect()` races: `close()`
  does not detach the old socket, and a late close from it nulls the new one. A throwing
  constructor leaves the state `connecting` and every later `connect()` is ignored.
- **FIXED 2026-10-22 (#314): the CI-only `close and reconnect` timeouts.** Four tests hit the
  5 s timeout in CI's full suite on some runs from 10-19 on (#309, #310, 10-21, #314 ×4).
  - **Cause: Bun 1.3.11.** Its fake timers stall the event loop once a test advances fake time
    past the machine's uptime.
  - **Why CI only.** A freshly booted runner has ~2 min of uptime when this file runs, and the
    file's 120 s jumps crossed it. Locally the uptime is hours.
  - **Signature.** The test before them, `stops pinging after the connection closes`, takes
    ~105 ms instead of ~7 ms. Then every wait for a socket event hangs, and the runner kills
    the 4 s watchdog child as "dangling".
  - **Local reproduction.** Advance fake time past `/proc/uptime`. Just past it, a WebSocket close
    takes 100 ms; further past it, the test hangs.
  - **Fix.** The test file advances only as far as each assertion needs (`PAST_RECONNECT_MS`,
    `PAST_PING_MS`). Its `advance()` helper fails a test that goes past `FAKE_TIME_BUDGET_MS`
    (60 s). Probes are in `sessionsWebSocketFakeTime.json`. Upgrading Bun is the root fix.
  - **Ruled out on the way:** CI's file order (replayed locally), the Bun version (1.3.11 in both
    places), the runner image, and parallel local load.
  - **Gotcha.** Bun's fake timers also move `Date`, `performance.now`, `process.hrtime` and
    `Bun.nanoseconds`. Read `/proc/uptime` for real time.
- **relay**: an upstream that closes cleanly before any data gives the client a bare
  disconnect, no 502; `decodeChunk` reads a truncated varint (`0a 80`) as a keepalive;
  after a 400 the header buffer is not reset, so more data sends 400 again.
- **headless WebSocketTransport**: a failed resend reconnects twice (in `sendLine` and
  the replay loop), skipping a backoff step; `close()` leaves the state `closing`, never
  `closed`; Bun has no upgrade headers, so it never evicts confirmed messages and every
  reconnect resends up to 1000.
- **MCP WebSocketTransport**: `onclose` fires twice on Bun when `close()` closes an open
  socket; the `sse` transport spreads `init.headers` (a `Headers`) and loses the SDK's.
- **direct connect**: `{"type":"control_request"}` with no `request` throws inside the
  handler and the rest of that frame's lines are lost; a second `connect()` leaks the
  first socket.
- **Codex models** (gpt-5.6-terra) sometimes call `Agent` with neither `description` nor
  `prompt` (InputValidationError) — over HTTP as often as over the socket; not transport.

Fixed in the same branch, so not here: the headless replay on Node (`ws.upgradeReq`, gone
in ws 8), MCP `start()` hanging on a socket that closes before opening, and the MCP Node
constructor listeners that were never removed.
