---
name: mcp-latent-bugs-pinned-2026-11-27
description: Defects the 2026-11-27 cover suites pinned as current behavior and did NOT fix — mcp serve field leak and -32603; OAuth cleanup/abort; stdio cleanup early return and untyped configs; remote connect leaks its transport; v1 abort is McpError -32001 so the esc branch never runs; callback hooks can't answer elicitation; MCP skill allowed-tools granted; the connections hook never drops a server's resources and wipes tools after 5 failed reconnects; dead Bash-mode Tab completion and double fetches in useTypeahead; MCP resource tools' truncation hint never fires; -p task elicitation loses its form schema
type: project
paths:
  - "src/platform/entrypoints/mcp.ts"
  - "src/mcp/auth/oauthFlow.ts"
  - "src/mcp/client/connection.ts"
  - "src/mcp/client/callTool.ts"
  - "src/mcp/client/taskCall.ts"
  - "src/mcp/elicitationHandler.ts"
  - "src/mcp/useManageMCPConnections.ts"
  - "src/agent/tasks/pillLabel.ts"
  - "src/skills/loadSkillsDir.ts"
  - "src/tools/SkillTool/SkillTool.ts"
  - "src/terminal/hooks/useTypeahead.tsx"
  - "src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts"
  - "src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts"
---

Found while covering files to ≥70% before the SDK v2 migration (branch `feat/mcp-2026-07-28`). Every
symptom is pinned as current behavior by a cover suite on that branch, so fixing one means changing its
test on purpose.

**mcp serve** (`src/platform/entrypoints/mcp.ts`, `startMCPServer`; pinned in `mcp.test.ts`):
1. `tools/list` spreads the whole internal tool object (`...tool`), so `isMcp`, `searchHint` and other
   internal fields reach every client.
2. A call to an unknown tool gets JSON-RPC `-32603`, not an `isError` result or `-32602`.

**OAuth** (`src/mcp/auth/oauthFlow.ts`, `performMCPOAuthFlow`; pinned in `oauthFlow.cover.test.ts`):
3. The "Client not found" cleanup (~372-385) never runs for a client registered on the fly on SDK 1.x:
   the SDK's `auth()` catches `invalid_client`, wipes the entry, retries, then fails with "Existing OAuth
   client information is required…". Only a config-set client id reaches it. May change shape on SDK v2.
4. A login whose signal is already aborted still deletes the stored credentials (cleared before the
   abort check).

**Connection** (`src/mcp/client/connection.ts`; pinned in `connection.cover.test.ts`):
5. If `process.kill(pid, 'SIGINT')` throws during stdio cleanup, cleanup returns early: the client is
   never closed and the child keeps running.
6. A stdio config with no `type` gets no signals at cleanup (the check ~610 is `=== 'stdio'`), only
   `client.close()`.
7. An http/sse/claudeai-proxy connect that fails for a non-auth reason never closes its transport; only
   the retry path and local servers clean up. Seen as a flake: `connection.remote.test.ts` ("sse: a refused
   port") leaves an `EventSource` retrying every 3 s, which a later file's `setTimeout` spy catches —
   `WebSocketTransport.test.ts` failed in some focused runs but not in the full one. Reproduced on v1 too.

**Tool calls and elicitation** (pinned in `callTool.cover.test.ts`, `elicitationHandler.cover.test.ts`):
8. On SDK v1 aborting a real call rejects with `McpError -32001` ("AbortError: …"), not an `AbortError`,
   so `callMCPTool`'s "user pressed esc → `{content: undefined}`" branch never runs; the error is
   rethrown. Unchanged on SDK v2: the abort rejects with `SdkError` `REQUEST_TIMEOUT`, so the branch
   still never runs (the pinned test now checks that class).
9. SDK callback hooks cannot answer an elicitation outside the REPL: the hook runner keeps only
   `json.systemMessage`, dropping `hookSpecificOutput.action`. Command hooks work.
10. SDK v1 ignores a cancel for request id 0 (`if (!requestId)`), so the first server→client request
    cannot be cancelled; the suite sends a ping first to burn id 0.
11. When a tool returns `structuredContent`, the model sees only its JSON and the text blocks are
    dropped.

**Tasks and skills:**
12. `getPillLabel([])` throws (`every` on an empty list, then `tasks[0]!.type`); both callers check
    for empty first. A shell monitor plus a `monitor_mcp` task read "2 background tasks", not
    "2 monitors". Pinned in `pillLabel.cover.test.ts`.
13. FIXED 2026-11-27 in 83650e4b (the MCP skills commit): an MCP skill (`loadedFrom: 'mcp'`) that
    declared `allowed-tools` got an ask prompt and its tools granted on invocation. `createSkillCommand`
    now drops them, and the skill's frontmatter `hooks` too. The pins in `SkillTool.cover.test.ts` /
    `loadSkillsDir.cover.test.ts` were flipped on purpose, as was `getMcpSkillCommands` returning `[]`.

**Connections hook** (`src/mcp/useManageMCPConnections.ts`; pinned in `useManageMCPConnections.cover.test.tsx`):
14. A server's resources are never removed from the pool (~266-274): the update builds
    `{ ...mcp.resources, ...omit(mcp.resources, name) }`, spreading the old map first, so a failed or
    disabled server — or a refresh that returns `[]` — keeps its resources. Marked "CURRENT BEHAVIOR (bug)"
    in the suite; the branch's resource-subscription work builds on this map.
15. `void loadAndConnectMcpConfigs()` (~783) has no `.catch`: a rejected config load or claude.ai fetch
    in that effect is an unhandled rejection. The other effect catches.
16. After five failed reconnects the last failed result carries `tools: []` and empties the server's
    tools, against the "keep tools on failed" rule a plain close follows.

**Typeahead** (`src/terminal/hooks/useTypeahead.tsx`; pinned in `useTypeahead.cover.test.tsx`):
17. Bash-mode Tab shell completion is dead code: Tab with no menu only runs through `autocomplete:accept`,
    which is active only when suggestions or ghost text exist, and every ghost-text path returns before
    that branch — the `'shell'` suggestion type is never set (~1158-1200).
18. Any change of suggestion type re-runs the update for the same input: the Slack fetch fires twice,
    and Enter on `/add-dir` closes the menu only for it to come back with the same directories.
19. `usehooks-ts` 3.1.1's `useDebounceCallback` cancels a different debounce instance on unmount, so a
    pending fetch still runs after unmount (the suite waits 170 ms before restoring spies).
20. A new `agents` array on every render loops ("Maximum update depth"); PromptInput just forwards the
    prop, so it holds only while its caller keeps the array stable.

**MCP resource tools:**
21. `isResultTruncated` in ReadMcpResourceTool and ListMcpResourcesTool runs `isOutputLineTruncated` on
    compact JSON, where newlines are escaped, so it always returns false and the truncation hint never
    shows. Pinned in `ReadMcpResourceTool.cover.test.ts`.

**Found building the features (not pinned):**
22. In print mode (`-p`), an MCP task's input goes through `handleElicitation`, which drops the form's
    `requestedSchema`. A form request inside a task therefore reaches the SDK caller with only its message.
    Seen while building task-augmented calls (fb7e9a7a; the code is `src/mcp/client/taskCall.ts` since 11-28).

**Status:** open as of 2026-11-27.

**Why not fixed:** out of the migration plan's scope; 1 and 2 were to be offered to the user as a
decision at the end of the round.
