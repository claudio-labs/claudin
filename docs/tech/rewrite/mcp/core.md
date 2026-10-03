# Spec: `mcp/core`

Files: `src/mcp/types.ts`, `src/mcp/utils.ts`, `src/mcp/mcpStringUtils.ts`,
`src/mcp/normalization.ts`, `src/mcp/mcpInstructionsDelta.ts`.

## Purpose

The vocabulary the rest of the MCP side, and the permission layer, speak in:

- **The server configuration contract.** The zod schemas that decide which server entries are valid, and the TypeScript types for configs and connection states. They apply to `.mcp.json`, settings files, plugin manifests, agent definitions, `--mcp-config` and the SDK.
- **The names.** How a raw server or tool name is folded into the API alphabet, how the qualified `mcp__<server>__<tool>` name is built, and how such a string is split back into its server and tool. Permission rules match on that split.
- **Grouping helpers.** A server's tools, prompts, skills and resources (the `/mcp` menus, and clean-up on disconnect or reload), and the config fingerprint that decides when `/reload-plugins` reconnects a server.
- **Project-server approval.** Whether a server from the project's `.mcp.json` may start without asking.
- **The `mcp add` argument checks.**
- **The instructions delta.** What to announce to the model about server instructions.

## Public contract

These keep their names and types while their callers are not yet rewritten.
`types.ts` alone has 91 production importers.

### `normalization.ts`

This file must stay a leaf with no imports, because the permission and settings layers load it.

| Export | Signature | Used by |
|---|---|---|
| `CLAUDEAI_SERVER_PREFIX` | `'claude.ai '` (a string constant) | the module itself; part of the contract through `isClaudeAIMcpServerName` |
| `isClaudeAIMcpServerName` | `(name: string) => boolean` | `mcp/config.ts` |
| `normalizeNameForMCP` | `(name: string) => string` | `mcp/utils.ts`, `mcpStringUtils.ts`, `mcp/client/toolResult.ts`, `mcp/client/fetchCapabilities.ts`, `mcp/claudeai.ts`, `agent/tools/toolExecution.ts` |

### `mcpStringUtils.ts`

This file must stay light: its only dependency is `normalization.ts`. `platform/settings/permissionValidation.ts` loads it.

| Export | Signature | Used by |
|---|---|---|
| `mcpInfoFromString` | `(toolString: string) => { serverName: string; toolName: string \| undefined } \| null` | `permissions/permissions/ruleLookup.ts`, `platform/settings/permissionValidation.ts`, `agent/tools/toolExecution.ts`, `agent/attachments/injections.ts`, `agent/ui/agents/ToolSelector.tsx` |
| `getMcpPrefix` | `(serverName: string) => string` | `tools/McpAuthTool`, `headless/print/mcpRuntime.ts`, `headless/print/mcpControlHandlers.ts`, `mcp/useManageMCPConnections.ts`, `agent/tasks/McpServerTask/reconcile.ts`, `agent/ui/tasks/McpServerDetailDialog.tsx` |
| `buildMcpToolName` | `(serverName: string, toolName: string) => string` | `mcp/client/fetchCapabilities.ts` |
| `getToolNameForPermissionCheck` | `(tool: { name: string; mcpInfo?: { serverName: string; toolName: string } }) => string` | `permissions/permissions/ruleLookup.ts` |
| `getMcpDisplayName` | `(fullName: string, serverName: string) => string` | `mcp/ui/MCPToolListView.tsx`, `mcp/ui/MCPToolDetailView.tsx`, `agent/ui/tasks/McpServerDetailDialog.tsx` |
| `extractMcpToolDisplayName` | `(userFacingName: string) => string` | `mcp/ui/MCPToolListView.tsx`, `mcp/ui/MCPToolDetailView.tsx` |

### `types.ts`

Each schema export is a zero-argument function that returns the schema, and it returns the same schema on every call.

| Export | Kind | Used by |
|---|---|---|
| `ConfigScopeSchema` / `ConfigScope` | schema / type | `mcp/utils.ts`; the type in 13 files |
| `TransportSchema` / `Transport` | schema / type | the type in 19 files |
| `McpStdioServerConfigSchema` / `McpStdioServerConfig` | schema / type | `platform/ide/claudeDesktop.ts`; the type in 6 files |
| `McpSSEServerConfigSchema` / `McpSSEServerConfig` | schema / type | the type in 13 files |
| `McpSSEIDEServerConfigSchema`, `McpWebSocketIDEServerConfigSchema` | schema | the server union |
| `McpHTTPServerConfigSchema` / `McpHTTPServerConfig` | schema / type | the type in 12 files |
| `McpWebSocketServerConfigSchema` / `McpWebSocketServerConfig` | schema / type | the type in 3 files |
| `McpSdkServerConfigSchema` / `McpSdkServerConfig` | schema / type | the type in 11 files |
| `McpClaudeAIProxyServerConfigSchema` / `McpClaudeAIProxyServerConfig` | schema / type | the type in 4 files |
| `McpServerConfigSchema` / `McpServerConfig` | schema / type | `mcp/config.ts`, `plugins/schemas.ts`, `plugins/mcpPluginIntegration.ts`, `tools/AgentTool/loadAgentsDir.ts`, `platform/import/translate/mcpServers.ts`; the type in 13 files |
| `ScopedMcpServerConfig` | type: `McpServerConfig & { scope: ConfigScope; pluginSource?: string }` | 27 files |
| `McpJsonConfigSchema` / `McpJsonConfig` | schema / type | `mcp/config.ts` |
| `ConnectedMCPServer` | type: `{ client: Client; name: string; type: 'connected'; capabilities: ServerCapabilities; serverInfo?: { name: string; version: string }; instructions?: string; config: ScopedMcpServerConfig; cleanup: () => Promise<void> }` | 9 files |
| `FailedMCPServer` | type: `{ name; type: 'failed'; config; error?: string }` | through the union |
| `NeedsAuthMCPServer` | type: `{ name; type: 'needs-auth'; config }` | through the union |
| `PendingMCPServer` | type: `{ name; type: 'pending'; config; reconnectAttempt?: number; maxReconnectAttempts?: number }` | through the union |
| `DisabledMCPServer` | type: `{ name; type: 'disabled'; config }` | through the union |
| `MCPServerConnection` | union of the five above | 53 files |
| `ServerResource` | type: the SDK's `Resource & { server: string }` | 8 files |

### `utils.ts`

| Export | Signature | Used by |
|---|---|---|
| `filterToolsByServer` | `(tools: Tool[], serverName: string) => Tool[]` | `headless/print/mcpRuntime.ts`, `mcp/ui/MCPToolListView.tsx`, `mcp/ui/MCPSettings.tsx`, `commands/plugin/ManagePlugins.tsx` |
| `excludeToolsByServer` | `(tools: Tool[], serverName: string) => Tool[]` | `mcp/ui/MCPRemoteServerMenu.tsx` |
| `commandBelongsToServer` | `(command: Command, serverName: string) => boolean` | `headless/print/mcpControlHandlers.ts`, `mcp/useManageMCPConnections.ts` |
| `filterMcpPromptsByServer` | `(commands: Command[], serverName: string) => Command[]` | `mcp/ui/MCPStdioServerMenu.tsx`, `mcp/ui/MCPRemoteServerMenu.tsx` |
| `excludeCommandsByServer` | `(commands: Command[], serverName: string) => Command[]` | `main/defaultAction/headless.ts`, `mcp/ui/MCPRemoteServerMenu.tsx` |
| `excludeResourcesByServer` | `(resources: Record<string, ServerResource[]>, serverName: string) => Record<string, ServerResource[]>` | `main/defaultAction/headless.ts`, `mcp/ui/MCPRemoteServerMenu.tsx` |
| `hashMcpConfig` | `(config: ScopedMcpServerConfig) => string` | the stale check below |
| `excludeStalePluginClients` | `(mcp: { clients; tools; commands; resources }, configs: Record<string, ScopedMcpServerConfig>) => { clients; tools; commands; resources; stale: MCPServerConnection[] }` | `mcp/useManageMCPConnections.ts` |
| `isMcpTool` | `(tool: Tool) => boolean` | `agent/tools/toolPool.ts`, `toolHooks.ts`, `toolExecution.ts`, `agent/ui/agents/ToolSelector.tsx` |
| `describeMcpConfigFilePath` | `(scope: ConfigScope) => string` | `headless/handlers/mcp.tsx`, `commands/mcp/addCommand.ts`, `mcp/doctor.ts`, `mcp/ui/*` (4 files) |
| `getScopeLabel` | `(scope: ConfigScope) => string` | `headless/handlers/mcp.tsx`, `mcp/ui/McpParsingWarnings.tsx` |
| `ensureConfigScope` | `(scope?: string) => ConfigScope` | `headless/handlers/mcp.tsx`, `commands/mcp/addCommand.ts` |
| `ensureTransport` | `(type?: string) => 'stdio' \| 'sse' \| 'http'` | `commands/mcp/addCommand.ts` |
| `parseHeaders` | `(headerArray: string[]) => Record<string, string>` | `commands/mcp/addCommand.ts` |
| `getProjectMcpServerStatus` | `(serverName: string) => 'approved' \| 'rejected' \| 'pending'` | `mcp/config.ts`, `mcp/mcpServerApproval.tsx`, `mcp/doctor.ts` |
| `extractAgentMcpServers` | `(agents: AgentDefinition[]) => AgentMcpServerInfo[]` | `mcp/ui/MCPSettings.tsx` |
| `getLoggingSafeMcpBaseUrl` | `(config: McpServerConfig) => string \| undefined` | `agent/tools/toolExecution.ts` |

### `mcpInstructionsDelta.ts`

| Export | Signature | Used by |
|---|---|---|
| `McpInstructionsDelta` | type: `{ addedNames: string[]; addedBlocks: string[]; removedNames: string[] }` | the attachment type |
| `ClientSideInstruction` | type: `{ serverName: string; block: string }` | the signature below |
| `getMcpInstructionsDelta` | `(mcpClients: MCPServerConnection[], messages: Message[], clientSideInstructions: ClientSideInstruction[]) => McpInstructionsDelta \| null` | `agent/attachments/injections.ts`, which always passes `[]` as the third argument |

## Observable behaviour

### Folding a name (`normalizeNameForMCP`)

1. Every character outside `A–Z a–z 0–9 _ -` becomes `_`. The replacement is per UTF-16 code unit, so an astral character such as an emoji becomes `__`. Case is kept.
2. A **connector name** gets two extra steps: runs of `_` shrink to one, and a `_` at either end is removed. A connector name starts with `claude.ai ` (lower case, with the space).
3. Any other name keeps its runs and its ends: `' .x. '` becomes `'__x__'`.
4. There is no length cap, although the API allows 64 characters. An empty name stays empty.
5. Folding is idempotent.
6. Distinct names can fold to the same result. `my.server`, `my server`, `my/server` and `my_server` all become `my_server`.

### Qualified names

7. `getMcpPrefix(s)` is `mcp__` + fold(s) + `__`.
8. `buildMcpToolName(s, t)` is the prefix followed by fold(t). The tool is folded by the ordinary rule even when the server is a connector.
9. **`mcpInfoFromString(x)`** splits `x` on every `__`:
   - The first piece must be exactly `mcp` (case-sensitive), and the second must be non-empty. Otherwise the result is `null`.
   - The server is the second piece.
   - The tool is the remaining pieces joined back with `__`. It is `undefined` when there are no remaining pieces, and `''` when the string ends right after the server's `__`.
   - The pinned cases include: `mcp__s` → (s, undefined); `mcp__s__*` → (s, `*`); `mcp__s__` → (s, `''`); `mcp__a__b__c` → (a, `b__c`); `mcp___a` → (`_a`, undefined); `mcp__a___b` → (a, `_b`); `mcp__` → null; `mcp____t` → null; `MCP__s__t` → null.
10. **Round trip.** Parsing a built name gives back the folded parts, provided neither folded part contains `__`.
11. **`getToolNameForPermissionCheck`.**
    - For a tool that carries `mcpInfo`, the result is `buildMcpToolName(mcpInfo.serverName, mcpInfo.toolName)`, whatever the tool's own `name` is.
    - Otherwise the result is `tool.name`.
    - So an MCP tool shown as `Write` is matched as `mcp__<server>__Write`, never as the builtin.
12. **`getMcpDisplayName(full, s)`** removes the first occurrence of `mcp__` + fold(s) + `__` anywhere in `full`, not only at the start. A string without it comes back unchanged.
13. **`extractMcpToolDisplayName(label)`**:
    - It removes a trailing `(MCP)`, with any spaces around it. The match is case-sensitive.
    - It trims the result.
    - If the result contains ` - `, it returns the trimmed text after the first occurrence. Otherwise it returns the trimmed text.

### Connector names

14. `isClaudeAIMcpServerName` is true exactly when the name starts with `claude.ai ` (with the space, case-sensitive).

### Configuration schemas

All object schemas drop unknown keys, and each accepted value is the parsed output.

15. **Scopes**, in order: `local, user, project, dynamic, enterprise, claudeai, managed`. **Transports**, in order: `stdio, sse, sse-ide, http, ws, sdk`. `ws-ide` and `claudeai-proxy` are not transports here.
16. **stdio.**
    - Fields: `type` (`'stdio'`, optional), `command` (a string with at least one character, so a single space passes), `args` (a list of strings, which defaults to `[]`), and `env` (a map of strings to strings, optional).
    - An empty command fails with exactly `Command cannot be empty`.
17. **sse and http.**
    - Fields: `type`, `url` (any string, not checked to be a URL), `headers` (strings to strings), `headersHelper` (a string), and `oauth`. All but `type` and `url` are optional.
    - **The oauth block.** `clientId` is a string. `callbackPort` is a positive integer. `authServerMetadataUrl` must be a URL that starts with `https://`, and the https rule fails with exactly `authServerMetadataUrl must use https://`.
18. **ws** has the fields of sse and http, without `oauth`. An `oauth` block given to it is dropped, not refused.
19. **The internal types.**
    - `sse-ide`: `url`, `ideName`, and an optional `ideRunningInWindows`.
    - `ws-ide`: `url`, `ideName`, and optional `authToken` and `ideRunningInWindows`.
    - `sdk`: `name`.
    - `claudeai-proxy`: `url` and `id`.
20. **A server entry** is any of the eight above.
    - An entry without `type` is valid only as stdio, so it needs `command`. An untyped entry with both `command` and `url` is stdio, and the url is dropped.
    - `streamable-http`, and any other type name not listed, is refused.
21. **A `.mcp.json`** is `{ mcpServers: { <name>: <server entry> } }`. One invalid entry makes the whole file invalid. An empty map is valid. The exact parse of a file covering every user-facing transport is pinned in `src/mcp/__fixtures__/rewrite/project.mcp.json` and `project.mcp.parsed.json`.

### Grouping a server's tools, commands and resources

22. **Tools.**
    - A tool belongs to server `s` when its name starts with `getMcpPrefix(s)`. `git` does not own `mcp__github__x`.
    - A tool without a name belongs to no server.
    - Filter and exclude are exact complements, and both keep the input order.
23. **Commands.**
    - A command belongs to `s` when its name starts with `mcp__` + fold(s) + `__` (an MCP prompt), or with fold(s) + `:` (an MCP skill, or any command named that way).
    - An empty name belongs to no server.
24. **A server's prompts** are its commands, minus those with `type: 'prompt'` and `loadedFrom: 'mcp'` (its skills).
25. **Resources.** Excluding removes the entry under the exact, unfolded server name. It returns a new object and leaves the input unchanged.
26. **`isMcpTool`** is true when the name starts with `mcp__` (case-sensitive), or when `isMcp === true`.

### Reload: fingerprint and stale servers

27. **`hashMcpConfig`** returns 16 lowercase hex digits. It is not persisted anywhere, so only these properties are contract:
    - It ignores `scope`, the order of object keys at every depth, and fields set to `undefined`.
    - It changes with any other field, `pluginSource` included, and with the order of an array.
28. **`excludeStalePluginClients`.**
    - **Which clients are stale.** A client absent from `configs` is stale only if its own scope is `dynamic`. A client present in `configs` is stale when the fingerprints differ. Connection state does not matter.
    - **What leaves with them.** Stale clients are removed, with their tools, commands (prompts and skills) and resources, using the rules above. They are returned in `stale`.
    - **When nothing is stale,** the same `clients`, `tools`, `commands` and `resources` objects come back, with `stale: []`.

### `mcp add` arguments

29. **`ensureConfigScope`.**
    - An absent or empty value gives `local`. Any listed scope passes as is.
    - Anything else throws `Invalid scope: <value>. Must be one of: local, user, project, dynamic, enterprise, claudeai, managed`.
30. **`ensureTransport`.**
    - An absent or empty value gives `stdio`. Only `stdio`, `sse` and `http` pass, case-sensitive.
    - Anything else throws `Invalid transport type: <value>. Must be one of: stdio, sse, http`.
31. **`parseHeaders`.**
    - **Splitting.** Each entry splits at its first `:`. The name and the value are trimmed, an empty value is allowed, and a later entry with the same name (same case) wins.
    - **No colon** throws `Invalid header format: "<entry>". Expected format: "Header-Name: value"`.
    - **A blank name** throws `Invalid header: "<entry>". Header name cannot be empty.`

### Labels and paths

32. **`getScopeLabel`.** `local` → `Local config (private to you in this project)`, `project` → `Project config (shared via .mcp.json)`, `user` → `User config (available in all your projects)`, `dynamic` → `Dynamic config (from command line)`, `enterprise` → `Enterprise config (managed by your organization)`, `claudeai` → `claude.ai config`, and `managed` → `managed`.
33. **`describeMcpConfigFilePath`.**
    - `user` → the global config file (`<config dir>/config.json`, as `getGlobalClaudeFile()` resolves it).
    - `project` → `<current working directory>/.mcp.json`. The current directory, not the session's original one.
    - `local` → `<global config file> [project: <current working directory>]`.
    - `dynamic` → `Dynamically configured`.
    - `enterprise` → `<managed settings directory>/managed-mcp.json`.
    - `claudeai` → `claude.ai`.
    - `managed` → `managed`.

### Project-server approval (`getProjectMcpServerStatus`)

The merged settings are those of every enabled source. The first rule that applies decides:

34. **Rejected.** The name, folded, equals a folded entry of `disabledMcpjsonServers` in the merged settings. This beats every rule below.
35. **Approved, by the settings.** The name, folded, equals a folded entry of `enabledMcpjsonServers`, or `enableAllProjectMcpServers` is true. Both are read from the merged settings. The comparison is case-sensitive.
36. **Approved, by bypass mode.** `skipDangerousModePermissionPrompt` is true in the user, local, `--settings` or managed settings, and the project settings source is enabled. The project's own settings file never counts for this rule.
37. **Approved, without a session to ask in.** The session is non-interactive, and the project settings source is enabled.
38. **Pending** otherwise. A settings file that fails to parse counts as absent.

### The instructions delta (`getMcpInstructionsDelta`)

39. **What has been announced.** It walks the history in order. Each `mcp_instructions_delta` attachment adds its `addedNames` to the announced set and takes its `removedNames` out of it. Every other message and attachment is ignored.
40. **Which servers count.** Only servers in the `connected` state count.
    - A connected server has a block when its `instructions` are non-empty, when a client-side instruction names it, or both.
    - A client-side instruction for a server that is not connected is dropped.
41. **What is added.** Every server that has a block and has not been announced. Matching is by name: new text for an announced server is not re-sent.
42. **What is removed.** Every announced name that is not connected now. A connected server that now has no instructions is not retracted. A server that goes to `pending` (a reconnect) or `failed` is retracted, and re-announced once it connects again.
43. **The result** is `null` when nothing is added or removed. Otherwise:
    - `addedNames` is sorted by `localeCompare`, and `addedBlocks` is in the same order;
    - `removedNames` is sorted by code unit (so `Alpha` comes before `alpha` there, but after it in `addedNames`).

### Model-facing text: the blocks

The blocks are sent to the model. The attachment renderer outside this unit puts them under its own heading. Each block must:
- start with a level-2 Markdown heading whose text is the server's name exactly as configured, not folded (`## <name>`), followed by a newline;
- follow with the server's own instructions verbatim, if it has any;
- follow with each client-side instruction for that server, in the order given. Each is separated from the text before it by one blank line (`\n\n`). When the server has no instructions of its own, the first client-side block comes straight after the heading line.

No test, snapshot or generated file outside the unit pins this text byte for byte. `src/agent/attachments/__testutils__/attachmentFixtures.ts` holds a hand-written block in the same shape (`'## docs\nAsk before writing.'`) as renderer input. It does not come from this unit.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `mcpInfoFromString('')`, `'mcp'`, `'mcp_x'`, `'mcp__'` | `null` |
| a server name that folds to something containing `__` | it parses back as a shorter server (see the findings) |
| `buildMcpToolName('', t)` | `mcp____<t>`, which does not parse |
| an emoji in a name | each half of the surrogate pair becomes `_` |
| a schema given `null` or a bare string | refused |
| `excludeStalePluginClients` with no stale clients | the input objects, unchanged, and `stale: []` |
| a malformed settings file during approval | that layer is ignored |
| `getLoggingSafeMcpBaseUrl` for stdio, sdk or an unparseable URL | `undefined` |
| an agent entry with zero keys, or more than one | skipped |

**`extractAgentMcpServers`.**
- Inline `{ name: config }` entries are grouped by name. The first definition seen wins, `sourceAgents` lists each agent once, in order, and name references (plain strings) are skipped.
- Only four transports are listed:
  - stdio, with `command` and `needsAuth: false`;
  - sse, with `url` and `needsAuth: true`;
  - http, with `url` and `needsAuth: true`;
  - ws, with `url` and `needsAuth: false`.
- The result is sorted by `localeCompare` on the name.

**`getLoggingSafeMcpBaseUrl`.**
- It drops the query string and one trailing `/`, and keeps the fragment.
- A bare origin comes back without its slash.

## Security requirements

- **Folding and splitting decide what a permission rule reaches.**
  - Folding must stay inside `[A-Za-z0-9_-]`.
  - A connector name must never fold to anything that contains `__`.
  - The parse must stay case-sensitive on `mcp`, and must refuse an empty server.
  - The pinned splits, double-underscore cases included, must not change: a different split moves rules onto other tools.
- **Permission names.** An MCP tool is always matched by its qualified name, never by a display name it shares with a builtin.
- **Bypass mode.** Approval from bypass-mode acceptance must never read the project's own settings file, and both automatic approvals require the project settings source to be enabled.
- **Precedence.** `disabledMcpjsonServers` beats every way of approving.
- **OAuth metadata** URLs must be https.

## Tests that pin it

- Five suites, 267 tests. Line coverage is 100% on all five files.
  - `src/mcp/core.names.characterization.test.ts`: folding, connector names, building, parsing, permission names, display names.
  - `src/mcp/core.schemas.characterization.test.ts`: every schema, accept and refuse, plus the `.mcp.json` fixture.
  - `src/mcp/core.utils.characterization.test.ts`: grouping, the fingerprint, stale servers, the `mcp add` checks, labels, agent servers, the logging-safe URL.
  - `src/mcp/core.projectApproval.characterization.test.ts`: approval, through real settings files for every layer in temp directories, and the config file descriptions.
  - `src/mcp/core.instructionsDelta.characterization.test.ts`: the delta, with history built from real attachment and user messages.
- `scripts/migrations/probes/rewrite-mcp-core.json`: 40 probes over all five files, every one of which turns the suites red.
- No `feature()` flag is read in this unit, so no flag-on run is needed.
- Other tests reach the unit indirectly, among them `mcp/doctor.test.ts` (which stubs approval), `permissions` rule-lookup tests and `agent/attachments` tests.

## Out of scope

Nothing is dropped.

## Findings

1. **A server whose folded name contains `__` is read back as a shorter server.**
   - Server `team__ops`, `team  ops` (two spaces), `team..ops` or `team😀ops` builds `mcp__team__ops__<tool>`, which parses as server `team`, tool `ops__<tool>`.
   - So a rule for server `team` (`mcp__team`, `mcp__team__*`) also reaches every tool of `team__ops`.
   - A server-level rule written for `team__ops` is not server-level at all: it parses as tool `ops` of `team`.
   - Only connector names are protected.
   - **Decision: keep for parity.** Fixing it changes tool names or the split, and either orphans existing permission rules and settings. Pinned. A later hardening could refuse such server names at config time; that belongs to `mcp/config`.
2. **Different names fold together.**
   - `my.server` and `my_server` share tools, rules and approval state. Approving one approves the other, and disabling one disables the other.
   - **Decision: keep for parity.** Approval lists are stored under user-typed names, and changing the match would silently flip stored decisions. Pinned.
3. **The repository's own settings file can approve its own `.mcp.json` servers.**
   - `enabledMcpjsonServers` or `enableAllProjectMcpServers` in `.claudin/settings.json` is read from the merged settings. A checkout can therefore ship both the servers and their approval.
   - Only the bypass-mode rule excludes the project layer.
   - **Decision: keep for parity.** Teams commit this setting on purpose, and the trust dialog for the folder is the gate in front of it. Pinned. It is flagged for `permissions/sessionDialogs` (what the trust dialog warns about) and `mcp/approvalDialogs`.
4. **The "logging-safe" URL keeps credentials in the authority.**
   - It drops the query string, but `https://user:pw@host/...` keeps `user:pw@`.
   - **Decision: fix**, as pure hardening: drop the username and password too. Only logs read this value. Not pinned.
5. **`getMcpDisplayName` strips the prefix anywhere in the string,** not only at the start. **Decision: keep for parity.** The `/mcp` views only pass names that start with it. Pinned.
6. **Added and removed names sort differently** (locale order against code-unit order). **Decision: keep for parity.** Both orders are deterministic, and the bytes of new attachments stay stable. Pinned.
7. **The `managed` scope has no label or path description;** both read `managed`. No MCP config path assigns that scope today. **Decision: keep for parity.** Pinned.

## Target design

- **Keep the three tiers of weight.**
  - `normalization.ts` is a leaf with no imports.
  - `mcpStringUtils.ts` depends only on it.
  - The schemas and types stay free of runtime dependencies beyond zod and the lazy-schema helper.
- **One naming module, with three pure parts:** fold, build, and parse. Every `mcp__` prefix in the tree should come from it rather than from its own template string.
- **Grouping.** A single "belongs to server" predicate per kind (tool, command, resource), with filter and exclude derived from it.
- **Approval.** A pure decision over explicit inputs (the merged lists, bypass acceptance from trusted layers only, interactivity, whether project settings are enabled), wrapped by a thin function that reads them. This makes the precedence testable without settings files, and keeps the trust boundary visible in the signature.
- **The delta.** A pure function from (announced set, connected servers with their blocks) to the delta, with block rendering separate from set arithmetic.
- **Types.** Explicit throughout, no `any`. The connection-state union stays discriminated on `type`.
