---
name: mcp-sdk-v2-verified-behaviors
description: What the MCP TypeScript SDK v2 (@modelcontextprotocol/client/server/core 2.4.0) actually does, established 2026-11-27 by running probes against real v2 and v1 servers — probe fallback vs reject, stdio double spawn, connect({prior}), modern results need resultType/ttlMs/cacheScope, the pre-connect onmessage seam, -32021 on bare elicitation, listen() never reconnects, no Tasks/Events runtime, Mcp-Name gaps, callTool output validation, offline_access consent; plus what changed silently in the migration (provider Authorization beats static header, abort → REQUEST_TIMEOUT, issuer check on discovery, moved AS not detected)
type: project
paths:
  - "src/mcp/client/**"
---

Verified 2026-11-27 for the `feat/mcp-2026-07-28` migration by running probe scripts (scratchpad, since
lost) against v2 2.4.0 and v1 1.32.2 servers, plus reading the dist. None of it is in the v2 docs.

**Negotiation**
- `versionNegotiation: { mode: 'legacy' | 'auto' | { pin }, probe: { timeoutMs, maxRetries } }`, default
  `legacy`. The probe timeout defaults to the request timeout (60 s).
- HTTP probe against a v1 legacy server: it answers `server/discover` with HTTP 400 and the SDK falls back
  to `initialize` by itself (46 ms). A 5xx, timeout or network error makes `connect` REJECT
  (`SdkHttpError` `ERA_NEGOTIATION_FAILED`, or `REQUEST_TIMEOUT`) with no fallback — the host has to
  reconnect on a fresh transport in `legacy`. Spring AI answers the probe with 500 (opencode's finding).
- stdio `auto` with the exact base `StdioClientTransport` spawns the server command twice (a sibling for
  the probe); a subclass probes in place, which kills servers on SDKs that exit on any pre-`initialize`
  request. `connect(t, { prior: { kind: 'modern', discover } | { kind: 'legacy' } })` skips the probe
  (0 requests / 1 spawn); the `DiscoverResult` survives a JSON round trip. The v2 server's discover
  `ttlMs` is 0 by default.
- `getProtocolEra()` / `getNegotiatedProtocolVersion()` return `undefined` after `close()`.

**Modern wire (2026-07-28)**
- Every result must carry `resultType`, `ttlMs` and `cacheScope`, or the whole result is rejected
  (`SdkError` `INVALID_RESULT`) — raw `client.request` with a custom schema included. List pages are
  validated whole before any caller schema, so one malformed tool drops the page.
- A `transport.onmessage` set BEFORE `connect` is chained first with the same message object
  (`src-CeKsbNLO.mjs:5856-5858`): in-place edits land before the decode. It is swapped out during the
  discover probe and restored after. Wrap the instance's `send` for an id→method map (the probe's id is
  a string, `server-discover-probe-1`).
- URL-mode elicitation with a bare `elicitation: {}` is refused by a v2 server up front (-32021);
  `{ form: {}, url: {} }` works. Handlers get the abort signal at `ctx.mcpReq.signal`. MRTR auto-fulfils
  elicitation/roots through the registered handlers.
- `listen()` works only on modern connections (`METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` otherwise),
  never reconnects (`closed` resolves `'local' | 'graceful' | 'remote'`), and silently drops
  `resourceSubscriptions` from `honoredFilter` when the server lacks `resources.subscribe`.
- No runtime for the Tasks or Events extensions: a `tools/call` answered `resultType: 'task'` rejects
  (`UNSUPPORTED_RESULT_TYPE`); `tasks/get` over raw `client.request` is allowed. `Mcp-Name` is added
  automatically for tools/call, prompts/get, resources/read and tasks/*, not for `events/*`, and
  `RequestOptions.headers` cannot set any `mcp-*` header (silently skipped) — a fetch wrapper can.
- Skills: `SkillsClient` (`client/ext/skills`) works on both eras; the server side is
  `SkillCatalog` / `SkillsExtension.attach(mcpServer)` — there is no "SkillsServer".

**Client behaviour that changes UX**
- `callTool` with a tool definition (passed, or cached by `listTools()`) that has an `outputSchema`
  throws when `structuredContent` is missing; there is no off switch.
- v2 appends `offline_access` when the server lists it and `grant_types` includes refresh_token, and then
  forces `prompt=consent` — a consent screen on every login (kept on purpose 11-27, as CC does).

**Found while migrating (11-27), each one a 1.x behavior that changed silently**
- v2 merges `requestInit` headers BEFORE the auth provider's `Authorization`, so stored OAuth tokens beat a
  static `Authorization` header from `.mcp.json` (1.x: the static header won). Claudin puts it back with
  `wrapFetchWithConfiguredAuthorization` (`transport.ts` `remoteFetch`), pinned by `transport.authHeader.test.ts`.
- `ToolSchema` in core accepts any JSON for nested `inputSchema.properties`, so per-entry list validation
  has to check them itself (`normalizeTool`).
- Authorization-server metadata discovery checks the document's `issuer`; the path-aware fallback for
  servers that host their own metadata passes `skipIssuerValidation: true` on that one call, as 1.x behaved.
- An aborted call rejects with `SdkError` `REQUEST_TIMEOUT` (1.x: `McpError -32001`), so callMCPTool's
  "esc → content undefined" branch still never runs.
- auth() resuming from a `discoveryState` that has `authorizationServerUrl` never compares the fresh
  PRM's `authorization_servers`; a moved resource must be detected by the provider. On the callback leg
  (code present), a provider that implements `saveDiscoveryState` but returns no state throws
  `AuthorizationServerMismatchError` — keep returning the recorded state there. Claudin's
  `discoveryState()` fetches the PRM itself, returns nothing when it lists other servers, and hands
  the PRM over (`resourceMetadata`) so the SDK does not fetch it twice; token refresh reads the
  stored server directly, since a refresh token belongs to its issuer (c01be879).

**Found building the features (11-27)**
- Adopting a cached `{ kind: 'modern' }` prior sends nothing, so a stale verdict (the server went back to
  2025) never fails the connect. Detect it later: over HTTP a 400/404 on the first request; on stdio one
  `server/discover` on the session's own pipe, since the first list requests go out before the hook
  attaches its close handler and the hook never redials stdio.
- A modern stdio connect resolves before the session child has run: count spawns only after a request.
- `listTools()` and friends page up to `listMaxPages` (a Client option, default 64) and then throw
  `ListPaginationExceeded` (`public-CvV4ZHkX.mjs:3431`); only an identical repeated page stops early, so a
  cursor cycle (a→b→a) fails the whole list — Claudin cuts it, and cuts at 100 pages (`cursorCycleGuard.ts`).
  They also write the SDK's own cache, so a server sending `ttlMs > 0` can be answered from it.
- An elicitation the SDK fulfils for an `input_required` result gets an abort signal even when the
  originating call passed none (a break-probe on the `?? new AbortController().signal` fallback stayed green).
- With `elicitation: { form: {}, url: {} }` declared, a 2025 server that sends a URL request anyway now
  reaches the handler instead of being refused by the SDK.
- On 2026-07-28 the SDK drops tools with invalid `x-mcp-header` declarations through a bare `console.warn`
  (absorbed by Ink's patchConsole in the TUI; `-p` prints it to stderr).
- On 2026-07-28 Streamable HTTP, aborting a request closes its per-request stream, and that is the
  cancel. A fetch wrapper must keep the caller's signal attached until the response body ends.
  Claudin's `wrapFetchWithTimeout` dropped it once the headers arrived, so TaskStop and `listen()` never
  closed their streams on the server (fixed in 2ce36223).
- If a server cuts a stream without answering, the SDK leaves the request pending forever. The events
  client gives `events/stream` 30 s to open, then hands over to the heartbeat watchdog.
- The SDK never says which JSON-RPC id a request went out as (opencode patched in `onRequestId`).
  Claudin tags each `events/stream` with a `_meta` token, which `transport.send` reads and strips before
  the request is sent. The `subscriptionId` survives in a notification's `params._meta`.
- With `versionNegotiation: { mode: 'legacy' }` and capabilities `{ roots: {}, elicitation: {} }` the wire
  recorded against 1.x was identical except the key order inside `notifications/initialized`.

**Found in the review round (11-28)**
- Every modern result without `resultType` is rejected, whatever the method (`client/dist/src-CeKsbNLO.mjs:3957`).
  Lists, `resources/read` (`ReadResourceResultSchema`, `:2886`) and `skills/list` (`ext/skills/index.mjs:755-776`)
  also need `ttlMs` and `cacheScope`; `tools/call`, `prompts/get` and `completion/complete` need only
  `resultType`; `server/discover` tolerates both missing.
- `TransportSendOptions.onRequestStreamEnd` reports that a Streamable HTTP request's stream ended, answered or
  not (the SDK's own `listen()` uses it); stdio ignores it. When a result arrives and then the stream closes,
  the request has settled before the hook fires.

**Why:** about ten agent runs went into establishing these; the branch's wire filter, era cache and
fallback rest on them.

**How to apply:** check the relevant line before changing MCP negotiation/wire code, and re-verify each
when bumping `@modelcontextprotocol/*` past 2.4.0.
