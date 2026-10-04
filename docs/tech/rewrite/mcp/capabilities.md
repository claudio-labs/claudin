# Spec: `mcp/capabilities`

The unit is six files: `src/mcp/client/fetchCapabilities.ts`,
`src/mcp/client/sdkClients.ts`, `src/mcp/SdkControlTransport.ts`,
`src/mcp/vscodeSdkMcp.ts`, `src/mcp/client/ide.ts` and `src/mcp/claudeai.ts`.

It is characterized together with `mcp/connection` and `mcp/callTool`
through the barrel `src/mcp/client.ts`, which keeps every name it exports.

## Purpose

This unit decides what the rest of Claudin sees of a connected MCP server:
- **the tools** offered to the model, and what such a tool does when called;
- **the slash commands** built from the server's prompts;
- **the resources** it lists;
- **the startup sweep** over every configured server, and reconnecting one server;
- **the SDK host's own servers**, reached over the stream-json control channel, and the VS Code notification channel among them;
- **the IDE RPC** used by the diff and diagnostics features;
- **the claude.ai connector listing** for a logged-in organization.

## Public contract

Through the barrel `src/mcp/client.js` unless noted.

| Export | Signature | Used by |
|---|---|---|
| `fetchToolsForClient` | `(client: MCPServerConnection) => Promise<Tool[]>`; memoized per server name, with `.cache` (`delete`, `clear`, `has`, `get`, `size`) | `useManageMCPConnections.ts`, `runAgent.ts`, `headless/print/mcpReconcile.ts`, `sdkClients.ts`, `mcp/connection`, a bench script |
| `fetchResourcesForClient` | `(client: MCPServerConnection) => Promise<ServerResource[]>`; same memo | `useManageMCPConnections.ts`, `ListMcpResourcesTool`, `mcp/connection` |
| `fetchCommandsForClient` | `(client: MCPServerConnection) => Promise<Command[]>`; same memo | `useManageMCPConnections.ts`, `mcp/connection` |
| `reconnectMcpServerImpl` | `(name: string, config: ScopedMcpServerConfig) => Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }>` | `useManageMCPConnections.ts`, `McpAuthTool.ts`, `mcpControlHandlers.ts` |
| `getMcpToolsCommandsAndResources` | `(onConnectionAttempt: (params: { client; tools; commands; resources? }) => void, mcpConfigs?: Record<string, ScopedMcpServerConfig>) => Promise<void>` | `useManageMCPConnections.ts`, `defaultAction/headless.ts`, `entrypoints/mcp.ts` |
| `prefetchAllMcpResources` | `(mcpConfigs: Record<string, ScopedMcpServerConfig>) => Promise<{ clients; tools; commands }>` | `startupSequence.ts`, `mcpAndPerms.ts` |
| `mcpToolInputToAutoClassifierInput` | `(input: Record<string, unknown>, toolName: string) => string` | the auto-mode eval scripts |
| `setupSdkMcpClients` | `(sdkMcpConfigs: Record<string, McpSdkServerConfig>, sendMcpMessage: (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>) => Promise<{ clients: MCPServerConnection[]; tools: Tool[] }>` | `headless/print/mcpRuntime.ts`, `entrypoints/sdk/runtimeTypes.ts` |
| `callIdeRpc` | `(toolName: string, args: Record<string, unknown>, client: ConnectedMCPServer) => Promise<string \| ContentBlockParam[] \| undefined>` | `useDiffInIDE.ts`, `platform/ide/ide.ts`, `diagnosticTracking.ts` |
| `SdkControlClientTransport` (`SdkControlTransport.js`) | `class implements Transport`; `constructor(serverName: string, sendMcpMessage: SendMcpMessageCallback)` | `headless/print/mcpRuntime.ts` |
| `SendMcpMessageCallback` (`SdkControlTransport.js`, type) | `(serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>` | this unit |
| `notifyVscodeFileUpdated` (`vscodeSdkMcp.js`) | `(filePath: string, oldContent: string \| null, newContent: string \| null) => void` | `FileEditTool`, `FileWriteTool`, `applySedEdit.ts`, `stagedWrite.ts`, `fileHistory.ts` |
| `setupVscodeSdkMcp` (`vscodeSdkMcp.js`) | `(sdkClients: MCPServerConnection[]) => void` | `headless/print/mcpRuntime.ts` |
| `fetchClaudeAIMcpConfigsIfEligible` (`claudeai.js`) | `() => Promise<Record<string, ScopedMcpServerConfig>>`; memoized for the session, `.cache.clear()` | `mcp/config/merge.ts`, `useManageMCPConnections.ts`, `mcpAndPerms.ts` |
| `clearClaudeAIMcpConfigsCache` (`claudeai.js`) | `() => void` | `useManageMCPConnections.ts` |
| `markClaudeAiMcpConnected` (`claudeai.js`) | `(name: string) => void` | this unit |
| `hasClaudeAiMcpEverConnected` (`claudeai.js`) | `(name: string) => boolean` | `useMcpConnectivityStatus.tsx` |

## Observable behaviour

### 1. Tools: `fetchToolsForClient(record)`

- **When nothing is asked.** A record that is not connected, or a server without the tools capability, gives `[]`, and the server is not asked.
- **Retries.** `tools/list` is tried up to three times, about one second and then two seconds apart. If all three fail, the result is `[]`. Nothing is thrown.
- **Sanitizing.** Everything the server sent is first stripped of invisible, format and private-use characters, then normalized (NFKC). That includes names, descriptions, schemas and `_meta`.
- **The memo.** Results are kept per server name (20 names at most) until that name's entry is dropped. `mcp/connection` drops it when the connection closes or is cleared.

Each listed tool becomes a `Tool` with:
- **`name`:** `mcp__<server>__<tool>`, both parts normalized for the API (anything outside `[a-zA-Z0-9_-]` becomes `_`). An `sdk` server with `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` truthy keeps the bare tool name. Other types are always prefixed.
- **`mcpInfo`:** `{ serverName, toolName }` with the original names. **`isMcp`:** true.
- **`description()`:** the server's description, or `''`.
- **`prompt()`:** the same text, cut at 2048 characters with `… [truncated]` appended when longer. Exactly 2048 is kept whole.
- **`searchHint`:** `_meta['anthropic/searchHint']` when it is a string, with whitespace runs collapsed to one space and trimmed. Blank becomes `undefined`.
- **`alwaysLoad`:** true only when `_meta['anthropic/alwaysLoad']` is exactly `true`.
- **Annotations, each false when absent:**
  - `isReadOnly()` and `isConcurrencySafe()` follow `readOnlyHint`;
  - `isDestructive()` follows `destructiveHint`;
  - `isOpenWorld()` follows `openWorldHint`.
- **`userFacingName()`:** `<server> - <annotations.title or tool name> (MCP)`.
- **`inputJSONSchema`:** the server's input schema. **`isSearchOrReadCommand()`:** delegated to the MCP collapse classifier.
- **`toAutoClassifierInput(input)`:** `key=value` pairs joined by single spaces, each value through `String()`, or the tool's own name when there are no keys. `mcpToolInputToAutoClassifierInput` is the same function.
- **`checkPermissions()`:** `passthrough`, with the message `MCPTool requires permission.` and one suggestion: add an allow rule for the qualified name (always prefixed) to `localSettings`.
- **The `ide` server** keeps only `executeCode` and `getDiagnostics`.

### 2. Calling a fetched tool: `tool.call(args, context, _, parentMessage, onProgress?)`

- **What is sent.** When the parent message starts with a `tool_use` block, its id is sent in the request `_meta` as `claudecode/toolUseId`.
- **Progress.** With an id and an `onProgress`, the caller gets `mcp_progress` events, each `{ toolUseID, data }`:
  - `started`;
  - the server's own `progress` events, as `mcp/callTool` shapes them;
  - then `completed` with `elapsedTimeMs`, or `failed` with `elapsedTimeMs`.
- **The connection.** The call goes over `ensureConnectedClient`, and through `mcp/callTool`, which also handles URL elicitation with `context.handleElicitation` and `context.setAppState`.
- **The result** is `{ data }`, where `data` is what `mcp/callTool` made of it. `mcpMeta` is added only when the server sent `_meta` or `structuredContent`, and holds just the ones present.
- **An expired session** (`mcp/callTool` throws its session-expired error) is retried once with a fresh connection.
- **Other errors.** A plain `Error` or an SDK `McpError` is rethrown as a telemetry-safe error with the same message. Errors that are already telemetry-safe pass unchanged.

### 3. Resources and prompt commands

- **`fetchResourcesForClient`** lists the server's resources, each with `server: <server name>` added. It gives `[]` without the resources capability, or on failure.
- **`fetchCommandsForClient`** turns each prompt into a command with:
  - `type: 'prompt'`;
  - `name`: `mcp__<normalized server>__<prompt name>`;
  - `description` (or `''`), and `hasUserSpecifiedDescription`;
  - `contentLength: 0`, `isEnabled() === true`, `isHidden: false`, `isMcp: true`, `progressMessage: 'running'`, `source: 'mcp'`;
  - `userFacingName()`: `<server>:<prompt name> (MCP)`;
  - `argNames`: the prompt's argument names, in order.
- **`getPromptForCommand(args)`** splits `args` on single spaces and pairs the words with `argNames` in order. Extra words are dropped, and missing ones are sent as nothing. It asks `prompts/get` and returns every message's content through `mcp/callTool`'s content transform, flattened. Errors are rethrown.
- **No prompts capability**, or a failed list, gives `[]`.

### 4. Reconnecting and sweeping

`reconnectMcpServerImpl(name, config)`:
1. It drops the keychain cache and the server's cached connection, then connects.
2. If the result is not connected, it returns it with empty tools and commands.
3. A claude.ai connector that connects is recorded as having connected (6).
4. It fetches tools, commands and, when supported, resources. The resource tools `ListMcpResourcesTool` and `ReadMcpResourceTool` are appended unless the server's own tools already match their names.
5. `resources` is left out when empty. Any thrown error turns into a `failed` client with no tools.

`getMcpToolsCommandsAndResources(onConnectionAttempt, configs?)` reports every
configured server exactly once (from `getAllMcpConfigs()` when no configs are given):
- **disabled** servers as `disabled`, without contacting them;
- `http`, `sse` and `claudeai-proxy` servers **in the needs-auth cache** as `needs-auth`, with one tool, `mcp__<server>__authenticate`, without contacting them;
- `http` and `sse` servers **probed before but holding no token** (discovery state stored, no access or refresh token) the same way;
- **otherwise**, the result of `connectToServer`:
  - `needs-auth` gets the authenticate tool;
  - `failed` gets nothing;
  - `connected` gets its tools, commands and resources.

The resource tools go to the first connected server that supports resources,
once per sweep. A connector that connects is recorded (6). Local servers
(`stdio`, `sdk`) and remote ones are connected with separate concurrency
limits (`mcp/connection`, 8).

`prefetchAllMcpResources(configs)` resolves at once to empty lists for no
configs. Otherwise it resolves once every server has been reported, with all
clients, tools and commands gathered. It resolves to empty lists if the sweep
itself throws.

### 5. SDK servers and the VS Code channel

- **`setupSdkMcpClients(configs, send)`** connects one client per config over `SdkControlClientTransport`, in parallel.
  - The client introduces itself like `mcp/connection` does, with no capabilities.
  - A server that connects is `connected`, with `config: { ...config, scope: 'dynamic' }` and its tools when it has the tools capability.
  - A server whose channel fails is `{ type: 'failed', name, config: { ...config, scope: 'user' } }` with no tools.
- **`SdkControlClientTransport`** hands each outgoing message to `send(serverName, message)`, and passes whatever `send` resolves to back as an incoming message. `start()` does nothing. `close()` fires `onclose` once, however often it is called. `send()` after close throws `Transport is closed`.
- **`setupVscodeSdkMcp(clients)`** remembers the connected client named `claude-vscode`, if there is one.
- **`notifyVscodeFileUpdated(path, old, new)`** then sends it a `file_updated` notification with `{ filePath, oldContent, newContent }`, where null means absent. Before that it does nothing. A failed send is logged, never thrown.

### 6. claude.ai connectors

`fetchClaudeAIMcpConfigsIfEligible()` returns `{}`, without a request, when:
- the provider is not first-party;
- traffic is essential-only. That is Claudin's default, and `CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC=0` lifts it;
- `ENABLE_CLAUDEAI_MCP_SERVERS` is set to a false value;
- there is no claude.ai login, or the login lacks the `user:mcp_servers` scope. A token from `CLAUDE_CODE_OAUTH_TOKEN` carries only `user:inference`.

Otherwise:
- **The request.** It GETs `/v1/mcp_servers?limit=1000` on the API base with:
  - `Authorization: Bearer <token>`;
  - `anthropic-beta: mcp-servers-2025-12-04`;
  - `anthropic-version: 2023-06-01`;
  - `Content-Type: application/json`;
  - a 5-second timeout.
- **The result.** Each listed server becomes `claude.ai <display name>` → `{ type: 'claudeai-proxy', url, id, scope: 'claudeai' }`. When a name normalizes like one already taken, ` (2)`, ` (3)` and so on are appended, until the normalized form is unused.
- **The memo.** The result is kept for the session. A failed request gives `{}`, which is kept too.
- **`clearClaudeAIMcpConfigsCache()`** forgets it, and clears the needs-auth cache (`mcp/connection`, 7).
- **`markClaudeAiMcpConnected(name)`** adds the name to `claudeAiMcpEverConnected` in the global config, once. **`hasClaudeAiMcpEverConnected(name)`** reads it.

### 7. IDE RPC

`callIdeRpc(tool, args, client)` calls the tool through `mcp/callTool` with a
fresh abort signal and returns its content. For the `ide` server the content
is never size-limited (`mcp/callTool`). Errors are rethrown.

## Edge cases and errors

- **A closed connection.** Every fetch gives `[]` and logs. Nothing is thrown.
- **A tool list that fails at first** delays startup by up to 3 seconds per server.
- **Prompt arguments** cannot hold spaces (Findings, 3).
- **`prefetchAllMcpResources`** relies on the sweep reporting every server once. It does, on every path.

## Security requirements

**Pinned by the tests:**
- **What the server sends is sanitized** before it becomes a tool name, description or command.
- **Model-facing descriptions are capped** at 2048 characters.
- **A server that asked for a login is not contacted again by the sweep** while cached, and neither is one probed before with no token.
- **The `ide` server's tools are limited** to two.
- **The suggested permission rule** is for the qualified tool name, in `localSettings`, even when the tool runs under its bare name.
- **The claude.ai listing is never fetched** in essential-traffic mode or without the scope.

**Described, kept for parity:** Findings 1 and 2.

## Tests that pin it

- **`src/mcp/client.capabilities.characterization.test.ts` (new, 33 tests).** Servers are real SDK servers over the in-memory transport, over a loopback Streamable HTTP port, or spawned over stdio (`src/mcp/client/__testutils__/mcpServerBed.ts`).
  - The SDK host is played by a `send` callback in front of an SDK server.
  - The claude.ai listing is answered by a loopback server: an axios request interceptor rewrites the fixed API origin to it, and the request still goes out over a socket. For the connector connection, `fetch` is rerouted the same way.
  - Credentials live in a temp `CLAUDIN_CONFIG_DIR` (`oauthTestBed`).
- **Coverage, from a run of the suite:** `fetchCapabilities.ts` 93%, `sdkClients.ts` 100%, `SdkControlTransport.ts` 100%, `vscodeSdkMcp.ts` 100%, `ide.ts` 100%, `claudeai.ts` 98%.
- **`scripts/migrations/probes/rewrite-mcp-capabilities.json`:** 40 probes over the six files. Every one turns the suite red.
- **Prompt text.** This unit sends text to the model: tool descriptions with the `… [truncated]` marker, and display and command names. The facts are pinned by targeted matches. No file outside the unit pins them byte for byte.
- **Not pinned, and why:**
  - **The non-first-party gate of the claude.ai listing.** It needs an active provider profile from settings, which this suite does not build.
  - **The split between local and remote concurrency,** which is only scheduling.
  - **The debug log lines.**

## Out of scope

- **Connecting itself**, and the connection cache (`mcp/connection`). The call, the result transform and URL elicitation (`mcp/callTool`).
- **The tool classes the tools are built from** (`MCPTool`, `McpAuthTool`, the resource tools), the collapse classifier, and name normalization (`mcp/core`).
- **The config merge** that feeds the sweep, and the enable/disable toggles (`mcp/config`).
- **The headless runtime** that calls `setupSdkMcpClients` and routes control messages.

## Findings

1. **Security: an `sdk` server may take built-in tool names.** With the no-prefix switch on, an SDK server's tool named `Read` is offered to the model as `Read`.
   - **Decision: keep for parity.** It is the switch's purpose, and only the SDK host can define such servers. Permission checks still use the qualified name.
   - Pinned.
2. **When a server sends `structuredContent`, the model gets it as JSON text,** and the `content` the server also sent is dropped.
   - **Decision: keep for parity.** The SDK consumers read `mcpMeta.structuredContent`.
   - Pinned.
3. **Prompt arguments are split on single spaces.** A value with a space cannot be passed, extra words are dropped silently, and the prompt name in the command is not normalized.
   - **Decision: keep for parity, and track.** Users type these commands.
   - Pinned (the split).
4. **The claude.ai listing reads one page of up to 1000 servers,** and ignores `has_more`.
   - **Decision: keep for parity, and track.**
   - Pinned (`limit=1000`).
5. **The sweep checks "disabled" twice.** The second check can never be true.
   - **Decision: fix.** Drop it. Nothing changes. Not pinned.
6. **The VS Code channel is process-wide state with no reset.** A channel that closed stays chosen, and every later notification fails quietly.
   - **Decision: keep for parity.** The headless runtime sets it again on each SDK update.
   - Pinned (failures are swallowed).
7. **`tools/list` failures are silent to the user.** After three tries the server simply has no tools, and the reason is only logged.
   - **Decision: keep for parity.**
   - Pinned.

## Target design

- **Pure mappers, separated from fetching:**
  - `toolFromListing(server, listed, options) => Tool`;
  - `commandFromPrompt(server, prompt) => Command`;
  - `resourceFromListing(server, resource) => ServerResource`.

  Each takes sanitized input, and the fetchers stay thin.
- **One retry helper** for `tools/list`, with its attempts and delays as named constants.
- **The sweep as a function of a per-server outcome:**
  - `classify(name, config) => 'disabled' | 'needs-auth' | 'connect'`, a pure function over the toggles, the needs-auth cache and the token store;
  - then one place that turns a connection into `{ client, tools, commands, resources }`, used by both the sweep and reconnect.
- **The SDK client identity** shared with `mcp/connection` as one constant.
- **`claudeai`:** gates as a pure `eligibility()` returning the reason, then the request, then the naming as a pure function with its own table tests.
- **The VS Code channel** as a small object the headless runtime owns, instead of process-wide state (Findings, 6).

## Outcome

Rewritten per method on 2026-10-04.

**The rewrite.**
- All bodies were written anew.
- `fetchCapabilities.ts` now sits on `client/capabilities/`: `toolFromListing`, `toolCall`,
  `promptCommand`, `sweep` (a pure `classifyServer`) and `retry`.
- `clientIdentity.ts` holds the client name and version. `connection.ts` adopts it in its own
  rewrite.
- `vscodeChannel.ts` makes the VS Code channel an object, still one per process.
- The claude.ai connectors split into `claudeaiConnectors/eligibility` and `naming`.
- The characterization suite passes unchanged.

**Fix, with a test.** Finding 5: "disabled" is decided once, first, in `classifyServer`.

**Kept as pinned.** Findings 1–4, 6 and 7:
- SDK servers can take built-in names.
- `structuredContent` is sent as JSON text.
- Prompt arguments split on spaces.
- The claude.ai listing reads one page.
- The VS Code channel is process-wide.
- `tools/list` failures stay silent.

**Probes.** 102, in `rewrite-mcp-capabilities.json`.

**Residue, reviewed.** 79 lines of Claude Code remain, all contract:
- the exported fetch and reconnect signatures (memoized per server name);
- `SdkControlClientTransport`'s method signatures;
- the three short claude.ai exports, whose shape the `claudeAiMcpEverConnected` config field fixes.
