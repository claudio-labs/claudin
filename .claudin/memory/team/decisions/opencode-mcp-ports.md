---
name: opencode-mcp-ports
description: The 2026-11-26/27 MCP round against opencode — four ports (mcp login/logout, per-server startupTimeout/toolTimeout/cwd, resource templates, connect retry), the bugs fixed (malformed lists, mcp serve -32603, 60 s HTTP tools/call cap, SSE headers, quote-only prompt args), what stayed out (SDK v2 / 2026-07-28, Code Mode), and the review round's fixes
type: project
scope: mcp
impact: functional
paths:
  - "src/mcp/client/listValidation.ts"
  - "src/mcp/client/serverOptions.ts"
  - "src/mcp/client/connectRetry.ts"
  - "src/mcp/client/promptArguments.ts"
  - "src/mcp/auth/cliLogin.ts"
  - "src/platform/entrypoints/mcp.ts"
---

**Decision:** on branch `feat/mcp-opencode-gaps` (2026-11-26/27), from a comparison with `../opencode/packages/core/src/mcp/` (HEAD 449c128a5b):
- **Ported:**
  - `claudin mcp login|logout <name>`, for configured http/sse servers (`getMcpConfigByName`). Off a terminal the process is held until the flow settles: the OAuth callback server and timer are unref'd.
  - Per-server `startupTimeout`/`toolTimeout` in ms, over `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT` and capped at 2^31−1 (a bigger delay fires after 1 ms). Also a stdio `cwd`; a plugin's is resolved against the plugin, and it counts in the dedup signature.
  - Resource templates in ListMcpResources, fetched on the tool's first call only. Any failure is cached as "none", and the request gets 10 s.
  - Two retries (250 ms, 1 s) of a transient connect failure on http/sse/ws, inside the startup deadline. A ws socket that never opens rejects with `WebSocketOpenError`, which carries the upgrade status on Node only (Bun reports none, so a status-less failure counts as transient). An `SseError` with no code is transient too.
- **Fixed, red first:**
  - One malformed tool, prompt or resource emptied its whole list. Entries are now checked one by one, with opencode-style top-level normalization.
  - `mcp serve` tools/list failed with `-32603`: the workflow tools' `z.custom` output schemas have no JSON Schema form.
  - A Streamable HTTP tools/call answered as JSON was cut at 60 s.
  - The SSE stream dropped the SDK's headers, and WebSocket `onclose` fired twice.
  - MCP prompt arguments split on single spaces. They now split on whitespace with quote grouping only. The first pick, `parseArguments`, ran a shell parser that dropped `#123`, globs and operators and split `don't`, so the review round reopened it.
- **Identity:** clientInfo now says Claudin (description, claudiolabs.ai). `name: 'claude-code'`, the User-Agent and the claude.ai CIMD client id stay on purpose: servers may allowlist on them.

**Out, and why:**
- SDK v2 / protocol 2026-07-28 (stateless HTTP, MCP Events, pooled connections): `@modelcontextprotocol/sdk` 1.32.2 is the last 1.x and tops out at 2025-11-25; the new protocol lives only in the split v2 packages (`@modelcontextprotocol/client` 2.4.0), and opencode had to patch it. Needs its own plan — taken up 2026-11-27 in [[mcp-2026-07-28]], with a pre-connect wire filter instead of a patch.
- Code Mode, the inbound TUI WebSocket, MCP Skills: opencode product features, not gaps.
- No per-tool toggle, no `/mcp` count of skipped entries: a skip is one `logMCPError` line, as in opencode.
- `mcp serve` running tools without its own prompt is by design: the connecting client confirms each call.
- An invalid timeout in `.mcp.json` fails the whole file, like any other typed field (kept strict, 11-27).

**Deviations from the plan, recorded rather than rebuilt:** the retry tests live in `connection.remote.test.ts`; the lenient page schemas are built with claudin's zod (the SDK shares the same copy), not `PaginatedResultSchema.extend`; clientInfo is a function; `add-json` help names every transport; `loginCommand.ts` sits at ~66% lines under `bun test`, because its actions call `process.exit` and run only in `loginCommand.e2e.test.ts`, a subprocess.

**Evidence:** the scratchpad repro ran 8 red and 2 green on main ee797cd5. The review round found 6 bugs with repros and 15 red tests (`test(mcp): reproduce the review round's findings`). `scripts/migrations/probes/mcpOpencodeGaps.json` (46) and `mcpOpencodeGapsE2E.json` (2, bundle) are all red on break. Live: `/mcp` showed 1 of 2 tools for a malformed server, a 503-once http server connected, and a full login/logout ran against a local mock OAuth server.
