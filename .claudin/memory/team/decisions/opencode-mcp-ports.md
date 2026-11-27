---
name: opencode-mcp-ports
description: The 2026-11-26 MCP round against opencode — four ports (mcp login/logout, per-server startupTimeout/toolTimeout/cwd, resource templates, connect retry), four bugs fixed (malformed lists, mcp serve -32603, 60 s HTTP tools/call cap, SSE headers), and what stayed out (SDK v2 / 2026-07-28, Code Mode)
type: project
scope: mcp
impact: functional
paths:
  - "src/mcp/client/listValidation.ts"
  - "src/mcp/client/serverOptions.ts"
  - "src/mcp/client/connectRetry.ts"
  - "src/mcp/auth/cliLogin.ts"
  - "src/platform/entrypoints/mcp.ts"
---

**Decision:** on branch `feat/mcp-opencode-gaps` (2026-11-26), from a comparison with `../opencode/packages/core/src/mcp/` (HEAD 449c128a5b):
- **Ported:** `claudin mcp login|logout <name>` (http/sse servers from `getMcpConfigByName` only); per-server `startupTimeout`/`toolTimeout` in ms (over `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT`) and stdio `cwd`; resource templates in ListMcpResources (fetched on the tool's first call only, `uriTemplate` entries); two retries (250 ms, 1 s) of a transient connect failure on http/sse/ws, inside the startup deadline.
- **Fixed, red first:** one malformed tool, prompt or resource emptied its whole list (entries are now checked one by one, opencode-style top-level normalization); `mcp serve` tools/list failed with `-32603` because the workflow tools' `z.custom` output schemas have no JSON Schema form; a Streamable HTTP tools/call answered as JSON was cut at 60 s; the SSE stream dropped the SDK's headers; WebSocket `onclose` fired twice; MCP prompt args split on single spaces.
- **Identity:** clientInfo now says Claudin (description, claudiolabs.ai). `name: 'claude-code'`, the User-Agent and the claude.ai CIMD client id stay on purpose: servers may allowlist on them.

**Out, and why:**
- SDK v2 / protocol 2026-07-28 (stateless HTTP, MCP Events, pooled connections): `@modelcontextprotocol/sdk` 1.32.2 is the last 1.x and tops out at 2025-11-25; the new protocol lives only in the split v2 packages (`@modelcontextprotocol/client` 2.4.0), and opencode had to patch it. Needs its own plan.
- Code Mode, the inbound TUI WebSocket, MCP Skills: opencode product features, not gaps.
- No per-tool toggle, no `/mcp` count of skipped entries: a skip is one `logMCPError` line, as in opencode.
- `mcp serve` running tools without its own prompt is by design: the connecting client confirms each call.

**Evidence:** the scratchpad repro ran 8 red and 2 green on main ee797cd5; the committed red suites are listed in the `test(mcp): reproduce…` commit; `scripts/migrations/probes/mcpOpencodeGaps.json` has 30 probes, all red on break. New modules are at 100% lines, and `fetch.ts` went from 42% to 99%, `types.ts` from 18% to 100%.
