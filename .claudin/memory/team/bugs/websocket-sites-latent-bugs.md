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
  Its `close and reconnect` tests (3–4, 5 s timeouts) went red in CI's full suite on the
  #309 and #310 runs (2026-10-19), then on 2026-10-21 (run 39519766259) and 2026-10-22 (#314,
  run 39782823727). They pass alone on Node 22.12 and 24. Still undiagnosed, but narrowed:
  - **The signature.** In every red run the test before them, `ping > stops pinging after the
    connection closes`, took ~105 ms instead of ~7 ms. Then all four time out at 5 s with "killed
    N dangling processes", meaning the 4 s watchdog child lost to the runner's timeout. Only
    `close() before connect`, which awaits nothing, passes in between.
  - **Not the file order.** Replaying CI's exact 189-file order with `CI=1` locally passed.
  - **Not the Bun version.** CI and local both run 1.3.11 from `.bun-version`.
  - **No local repro.** 96 runs of the file, 16 in parallel, never failed.
  - **Not the runner image.** Green and red runs both had `ubuntu-24.04 20261015.610`.
  - **Not a foreign real timer.** Bun's fake timers do not fire a 1 ms interval leaked by an
    earlier file.
  - On #314 it failed 3 of 3 attempts, a rerun included. Main went green twice with the same
    file order. The ~105 ms is too steady (103–106 in every red run) to be load noise.
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
