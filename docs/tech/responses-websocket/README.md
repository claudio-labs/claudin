# WebSockets: one opener, and the Responses API over a socket

**Status:** branch `feat/responses-websocket` (2026-10-17). On by default for
the ChatGPT Codex backend; `CLAUDIN_CODEX_WEBSOCKET=0` turns it off.
**Scope:** `src/providers/transport/webSocket.ts` (every WebSocket in the repo),
`src/providers/transport/responsesSocket/` (`frame.ts`, `pool.ts`,
`transport.ts`), `src/providers/shims/codex/websocket.ts` and the hook in
`performCodexRequest` (`codexShim.ts`).

Codex CLI talks to `chatgpt.com/backend-api/codex/responses` over a WebSocket;
Claudin used to POST and read SSE. That was the last transport difference in
the team memory `codex-0.162-wire-diff`. The work has two layers, so the next
provider that speaks the same protocol (OpenAI API, Azure document it) is one
small file.

## Layer 1 — `openWebSocket`, the only place that knows the runtime

Bun's client and Node's `ws` take proxies, TLS and headers in different shapes
and report events differently. Five places repeated that split (headless
transport, remote sessions, the upstream proxy relay, both MCP WebSocket
variants), and direct connect had no Node branch or proxy at all. All of them
now hand one set of handlers to:

```ts
openWebSocket(url, { headers?, protocols?, perMessageDeflate?, handlers? }, deps?)
  → { url, readyState, listen(handlers), send(data), ping(), close(code?, reason?), detach() }
```

- **Handlers**: `onOpen`, `onMessage(text, isBinary)` (binary frames decoded
  as UTF-8, flagged), `onBinary(bytes)` (when set, every frame arrives as bytes
  instead), `onError(Error)`, `onClose(code, reason)`, `onPong`, and two that
  only Node can report: `onUpgrade(headers)` (the 101 response) and
  `onRefused(status, body)` (an upgrade answered with anything but 101 — on Bun
  that is just `onError` then `onClose`).
- **The handle is synchronous.** On Node, `ws` loads on first use behind it;
  nothing can fire before `onOpen`, so callers that need a synchronous
  constructor (the relay's CONNECT state machine) keep one.
- **`send`** throws synchronously when the socket is not open, as both
  runtimes always did, and returns a promise that settles when the frame is
  written and never goes unhandled.
- **`detach`** removes every listener the opener attached, on both runtimes —
  each reconnect used to leave the old socket's closures behind.
- Proxy (`HTTPS_PROXY`/`NO_PROXY`) and mTLS/CA come from `proxy.ts` and
  `mtls.ts`, applied the way each runtime takes them.

### Testing code that only runs on Node

`bin/claudin` runs on Node; `bun test` runs on Bun, and nothing inside it can
stand in for Node's WebSocket: the name `ws` resolves to Bun's own shim (no
`upgrade`, no `unexpected-response`), and the real package fails inside Bun
("Unexpected server response: 101"). So `webSocket.node.test.ts` bundles
`__testutils__/webSocketNodeDriver.ts` with the `bun build --target=node` CLI
(in-process `Bun.build` under `bun test` fails to resolve some `src/…`
aliases), runs it with `node` against a real `WebSocketServer`, and asserts on
the JSON it prints. The headless replay fix is tested the same way
(`WebSocketTransport.node.test.ts`).

## Layer 2 — the Responses API over a socket

What the protocol is (OpenAI's WebSocket mode; Codex CLI 0.163 on the wire):
upgrade with `OpenAI-Beta: responses_websockets=2026-02-06`; a client frame is
the POST body plus `type: "response.create"` (Codex keeps `stream: true` in it);
server frames are the streaming events. With `store: false` the server keeps
only the last response, per connection, so a frame may name it as
`previous_response_id` and send only the new items. A connection lives at most
60 minutes, a message at most ~16 MiB, one response at a time.

- **`frame.ts`** decides delta vs full, as Codex CLI's `get_incremental_items`:
  same body outside `input`, the previous input as a prefix, then the previous
  response's output ids in order. Anything else is a full frame, with the reason
  in `--debug` (`[codex-ws] frame incremental (n items)` / `frame full (reason, n
  items)`). The chain keeps the full input as Claudin rendered it, not the
  delta, so a later stub or clip of an old item breaks it on the next request.
- **`pool.ts`** picks a socket by what the request continues: the idle socket
  whose chain it extends, else an idle one without a chain, else a new one (up
  to 8), else at the cap the least recently used idle one, else HTTP. No thread
  key is needed: each sub-agent ends up on its own chain's socket. Idle sockets
  close after 5 minutes, none is reused past 55. A session switch closes all.
- **`transport.ts`** returns a fetch-shaped `Response` whose body is the same
  SSE a POST streams, so every reader works unchanged, and takes the POST
  itself as `http` — it always returns a Response, so there is no fallback step
  to forget.
  - `previous_response_not_found` is retried once in full;
    `websocket_connection_limit_reached` once on a new socket.
  - An `error` frame that is the first frame and carries an HTTP `status`
    becomes a Response with that status and the error as its JSON body — what
    the POST would answer. A usage limit is a 429 that way, not a 500 retried
    eleven times (seen live 2026-10-17, before the fix).
  - Abort or cancel mid-response closes the socket; cancel after completion
    keeps it. A close mid-response errors the body like a dropped POST.
  - **Fallback latch, sticky for the process** (Codex CLI's
    `force_http_fallback`): an upgrade that fails while the POST of the same
    request answers 2xx, or two responses in a row that lose their socket.
    A 401/429/5xx from the POST does not latch.

### Wiring a provider

`src/providers/shims/codex/websocket.ts` is the whole Codex side: the gate
(`isCodexBackendRequest` — Copilot and relays keep the POST — plus the
killswitch), the socket URL (the POST URL under `ws(s)`), the upgrade headers
(the POST's, minus `Content-Type`, plus the beta), and one transport instance.
`performCodexRequest` wraps its POST as `http` and picks the socket when the
gate says so. Another Responses provider needs the same three functions.

## What Codex CLI does that Claudin does not, on purpose

- **No prewarm.** Codex sends `generate: false` with tools and instructions at
  the start; on 2026-10-17 its first real turn still came back `cached 0`, and
  Claudin's first request bytes only exist at the first query.
- **No telemetry.** Codex sends `x-codex-turn-metadata` (installation id,
  sandbox, workspaces with commit hashes), `thread-id`, window ids and a
  routing hint on the upgrade, and `client_metadata` in every frame. Claudin
  sends the POST's headers plus the beta header.
- `parallel_tool_calls` stays true (see `codex/backend.ts`).

## Measured (2026-10-17, ChatGPT free plan, gpt-5.6-terra)

- **Codex CLI, read + edit a file** (`scripts/bench/ab/codex-ws-frames.py`): a
  tool turn goes out in ~2.5 KB where the POST sends the whole body (>70 KB);
  the cache holds across connections (a resume on a new socket read 13056 of
  14197 at once); the prewarm did not warm the first turn.
- **Wire capture, three turns with resumes** (`codex-wire-capture.ts
  --arm=claudin-http`): Claudin over the socket sent 3 of 6 requests as deltas
  (input items `1 1 1 9 12 1` against HTTP's `1 4 6 9 12 15`); cached / input
  131584 / 162798 against 131584 / 162816 over HTTP — the resume turns, full
  frames after a chain of deltas, lost nothing; answers equivalent; no errors.
- **A/B** (`codex-websocket-ab.ts`, one run per arm, 5 sequential reads): http
  24.1 s, http placebo 22.5 s, ws 10.0 s. One run is not a measurement — it
  shows no regression and nothing more. The planned N=3 × 22 reads was not run:
  the free plan's 30-day window ran out during the checks.

## Known limits and follow-ups

- A fork that replays an idle owner's history (agent summaries,
  `extract_memories`) can take the owner's socket; the owner then pays one full
  frame, never tokens.
- An Esc mid-stream reaches `streaming.ts` as a plain `AbortError`, takes the
  "falling back to non-streaming" branch and stops there on the aborted signal.
  Same on both transports (undici raises the same error for the POST).
- `codex.rate_limits` arrives with every socket response, in the shape
  `normalizeCodexUsagePayload` (`providers/usage/codexUsage.ts`) already reads;
  `/usage` could show it without fetching `/wham/usage`.
- The coverage suites written before the migration pinned latent bugs as they
  are, without fixing them — team memory `bugs/websocket-sites-latent-bugs`.
