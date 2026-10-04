# Spec: `mcp/connection`

The unit is five files: `src/mcp/client/connection.ts`,
`src/mcp/client/transport.ts`, `src/mcp/client/fetch.ts`,
`src/mcp/client/authCache.ts` and `src/mcp/mcpWebSocketTransport.ts`.

It is characterized together with `mcp/capabilities` and `mcp/callTool`,
because the three import each other. All three are reached through the barrel
`src/mcp/client.ts`, which is this project's own and keeps every name it exports.

## Purpose

This unit turns one configured MCP server into a live connection, or into a
record saying why there is none. It covers:
- **the choice of transport** for each config type;
- **the credentials and headers** that go out on it;
- **the handshake**: how the client introduces itself, and what it answers when the server asks it something;
- **the connection cache**: one connection per server name and config;
- **what happens when a server goes away**, and how a stdio server's process is stopped;
- **the needs-auth cache file**, which stops the client from probing a server that asked for a login, for 15 minutes.

Its callers are the startup and reconnect paths (`mcp/capabilities`,
`useManageMCPConnections.ts`, the headless print runtime, `doctor.ts`), the
tool call (`mcp/callTool`), and the resource tools.

## Public contract

Through the barrel `src/mcp/client.js` unless noted.

| Export | Signature | Used by |
|---|---|---|
| `connectToServer` | `(name: string, serverRef: ScopedMcpServerConfig, serverStats?: { totalServers, stdioCount, sseCount, httpCount, sseIdeCount, wsIdeCount: number }) => Promise<MCPServerConnection>`; memoized, with a `.cache` (`delete(key)`) | `mcp/capabilities`, `useManageMCPConnections.ts`, `doctor.ts`, `runAgent.ts`, `startupSequence.ts`, `headless/print/mcpReconcile.ts`, `headless/handlers/mcp.tsx`, three bench scripts |
| `clearServerCache` | `(name: string, serverRef: ScopedMcpServerConfig) => Promise<void>` | `mcp/callTool`, `mcp/capabilities`, `useManageMCPConnections.ts`, `MCPRemoteServerMenu.tsx`, `doctor.ts`, `commands/ide/ide.tsx`, `defaultAction/headless.ts`, `headless/print/mcpReconcile.ts`, `mcpControlHandlers.ts` |
| `ensureConnectedClient` | `(client: ConnectedMCPServer) => Promise<ConnectedMCPServer>` | `mcp/capabilities`, `ListMcpResourcesTool`, `ReadMcpResourceTool` |
| `getServerCacheKey` | `(name: string, serverRef: ScopedMcpServerConfig) => string` | this unit |
| `areMcpConfigsEqual` | `(a: ScopedMcpServerConfig, b: ScopedMcpServerConfig) => boolean` | `headless/print/mcpReconcile.ts` |
| `cleanupFailedConnection` | `(transport: Pick<Transport, 'close'>, inProcessServer?: Pick<InProcessMcpServer, 'close'>) => Promise<void>` | the barrel only |
| `isLocalMcpServer` (`client/connection.js`) | `(config: ScopedMcpServerConfig) => boolean` | `mcp/capabilities` |
| `isIncludedMcpTool` (`client/connection.js`) | `(tool: Tool) => boolean` | `mcp/capabilities` |
| `MAX_MCP_DESCRIPTION_LENGTH` (`client/connection.js`) | `2048` | `mcp/capabilities` |
| `createTransport` (`client/transport.js`) | `(name: string, serverRef: ScopedMcpServerConfig) => Promise<{ transport: Transport; inProcessServer?: InProcessMcpServer }>` | this unit |
| `InProcessMcpServer` (`client/transport.js`, type) | `{ connect(t: Transport): Promise<void>; close(): Promise<void> }` | this unit |
| `createClaudeAiProxyFetch` | `(innerFetch: FetchLike) => FetchLike` | this unit |
| `wrapFetchWithTimeout` | `(baseFetch: FetchLike) => FetchLike` | this unit |
| `getMcpServerConnectionBatchSize` | `() => number` | `mcp/capabilities`, `headless/handlers/mcp.tsx` |
| `getRemoteMcpServerConnectionBatchSize`, `getConnectionTimeoutMs` (`client/fetch.js`) | `() => number` | `mcp/capabilities`, this unit |
| `MCP_REQUEST_TIMEOUT_MS` (`client/fetch.js`) | `60000` | this unit |
| `clearMcpAuthCache` | `() => void` | `McpAuthTool.ts`, `claudeai.ts` |
| `isMcpAuthCached` (`client/authCache.js`) | `(serverId: string) => Promise<boolean>` | `mcp/capabilities` |
| `setMcpAuthCacheEntry` (`client/authCache.js`) | `(serverId: string) => void` | this unit |
| `WebSocketTransport` (`mcpWebSocketTransport.js`) | `class implements Transport`; `constructor(ws: { readyState: number; close(): void; send(data: string): void })` | this unit |

`MCPServerConnection` and `ScopedMcpServerConfig` are the types of `mcp/core`.

## Observable behaviour

### 1. The record `connectToServer` resolves to

It never rejects. It resolves to one of:
- **connected:** `{ name, client, type: 'connected', capabilities, serverInfo, instructions, config, cleanup }`. `capabilities` is the server's (or `{}`), `serverInfo` its name and version, and `config` the very object passed in.
- **needs-auth:** exactly `{ name, type: 'needs-auth', config }`.
- **failed:** exactly `{ name, type: 'failed', config, error }`, with `error` the failure's message.

The server's instructions are kept up to 2048 characters. Longer ones are cut
to 2048 characters followed by `… [truncated]`.

### 2. The handshake

The client introduces itself the same way to every server
(`src/mcp/client/__fixtures__/rewrite/initialize-hello.json`):
- name `claude-code`, title `Claudin`, description `Anthropic's agentic coding tool`, website `https://claude.com/claude-code`, and the build version;
- capabilities `{ roots: {}, elicitation: {} }`. The elicitation capability is an empty object on purpose: some server SDKs reject unknown fields inside it.

While connected:
- **roots/list** is answered with one root, `file://` followed by the session's original working directory.
- **elicitation/create** is answered `{ action: 'cancel' }` until the connection manager installs its own handler.
- **IDE servers** (`sse-ide` and `ws-ide`) receive an `ide_connected` notification with `{ pid }`, the CLI's process id, right after connecting.

### 3. Transports and credentials, per config type

| Type | Transport | What goes out |
|---|---|---|
| `stdio`, or no type | a child process | the config's `command` and `args`; its `env` laid over the parent's environment; stderr captured, not shown |
| `stdio` with `CLAUDIN_SHELL_PREFIX` set | the prefix as the command | one argument: the command and the args joined by single spaces |
| `http` | Streamable HTTP | on every request: `User-Agent` (the MCP user agent of `src/shared/http.ts`) and the config's headers, `headersHelper` included. On every POST: an `Accept` with both `application/json` and `text/event-stream`. Authorization as below |
| `sse` | legacy SSE | the event-stream GET asks for `text/event-stream`, carries the user agent and the config's headers, and a `Bearer` of the server's stored OAuth token when there is one. The POSTs carry the same headers |
| `ws` | WebSocket, subprotocol `mcp` | the upgrade carries the user agent, `Authorization: Bearer <session ingress token>` when one is set, and the config's headers |
| `ws-ide` | WebSocket, subprotocol `mcp` | the user agent, and the IDE lockfile token in `X-Claude-Code-Ide-Authorization` (no header when there is none). Never `Authorization` |
| `sse-ide` | legacy SSE | no credentials |
| `claudeai-proxy` | Streamable HTTP to the claude.ai MCP proxy, at `/v1/mcp/<config id>` on the proxy host | `Authorization: Bearer <claude.ai login token>`, `X-Mcp-Client-Session-Id: <session id>`, the user agent |
| `sdk` | none here | fails with `SDK servers should be handled in print.ts` |
| anything else | none | fails with `Unsupported server type: <type>` |

Authorization on `http`, in order of precedence:
1. a configured `Authorization` header;
2. the server's stored OAuth token;
3. the session ingress token, which is sent only when no OAuth token is stored for the server;
4. otherwise, none.

The session ingress token is `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, or the token
the session read from disk. It is never sent on `sse`, `sse-ide` or `ws-ide`.

### 4. Failures while connecting

- **A 401 that the OAuth client turns into a login request** (an OAuth-protected `http` or `sse` server with nothing stored) yields `needs-auth`. So does a 401 from the claude.ai proxy.
- **A 401 from a server with no OAuth discovery** yields `failed`.
- **Every needs-auth** also writes an entry to the needs-auth cache (7).
- **Any other failure** yields `failed` with the error's message. That includes a missing binary, a process that exits, a refused upgrade, a 5xx, and a connector with no claude.ai login (`No claude.ai OAuth token found`).
- **A server that does not finish the handshake within `MCP_TIMEOUT` milliseconds** (default 30000; unset, zero or non-numeric means the default) fails with `MCP server "<name>" connection timed out after <ms>ms`. A stdio child is stopped.

### 5. The connection cache

- **One record per name and config.** The key is the name, a dash, and the serialized config. Failed and needs-auth records are cached too.
- **`clearServerCache(name, config)`** cleans up a connected record (6) and forgets it. It also forgets the name's tools, resources and commands in `mcp/capabilities`.
- **When a connection closes** (the stdio process dies, a WebSocket server hangs up), the record and the name's tool, resource and command lists are forgotten. The next `connectToServer` connects again.
- **On `http` and `claudeai-proxy`, a 404 whose body carries JSON-RPC `-32001`** (session not found) closes the connection, so it reconnects with a new session. A plain 404 does not.
- **On `sse`, `http` and `claudeai-proxy`, the SDK reporting its reconnection attempts exhausted** closes the connection. So do three network errors in a row (connection reset, timeout, broken pipe, host unreachable, refused, body timeout, terminated, SSE stream disconnected).
- **`ensureConnectedClient(record)`** returns an `sdk` record untouched. For any other config it returns the cached connection for that name and config, reconnecting if it was forgotten, and throws `MCP server "<name>" is not connected` when the result is not connected.

### 6. Cleanup

`cleanup()` on a connected record closes the client. For `stdio` it first
stops the process:
1. SIGINT;
2. after about 100 ms, SIGTERM if the process is still alive;
3. about 400 ms later, SIGKILL if it is still alive.

It returns within about 600 ms. Every connection is also registered with the
process's exit cleanup, and `cleanup()` unregisters it.

`cleanupFailedConnection(transport, server?)` closes the in-process server
first, if one is given, then the transport. It waits for both and ignores
their errors.

### 7. The needs-auth cache

- **The file.** `mcp-needs-auth-cache.json` in the config home: one entry per server name, `{ "<name>": { "timestamp": <ms since epoch> } }` (`src/mcp/client/__fixtures__/rewrite/needs-auth-cache.json`, timestamps zeroed).
- **Reading.** An entry counts for 15 minutes. A missing or unreadable file counts as empty.
- **Writing.** Concurrent writes are serialized, so none is lost. A write that cannot land is dropped without an error, but the entry still counts for the rest of the process.
- **`clearMcpAuthCache()`** forgets every entry and deletes the file.

### 8. Fetch wrappers

`wrapFetchWithTimeout(fetch)`:
- **GETs** pass through untouched, keeping the caller's signal: they are long-lived event streams.
- **Every other method** gets a fresh 60-second timeout, which follows the caller's signal if it aborts, before or during the request, with the caller's reason. It also gets `Accept: application/json, text/event-stream` when the caller set no Accept; an Accept the caller set is kept.
- **Errors** from the inner fetch come through unchanged.

`createClaudeAiProxyFetch(fetch)`:
- **The bearer.** It sends the current claude.ai login token as `Authorization: Bearer`, replacing any the caller set, and keeps the caller's other headers.
- **No login.** It throws `No claude.ai OAuth token available` and sends nothing.
- **A 401.** It retries once, and only when the stored token changed in the meantime: a refresh, or another process rotating it. Otherwise it returns the 401. If the retry itself cannot be sent, it returns the first 401.

Batch sizes: `MCP_SERVER_CONNECTION_BATCH_SIZE` (default 3) and
`MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` (default 20). A value that is not a
positive number means the default.

### 9. Small rules

- `isLocalMcpServer`: true for `stdio`, no type, and `sdk`.
- `isIncludedMcpTool`: false only for `mcp__ide__*` tools other than `mcp__ide__executeCode` and `mcp__ide__getDiagnostics`.
- `areMcpConfigsEqual`: the types match, and everything but `scope` serializes the same.

### 10. The WebSocket transport

- **`start()`** waits for the socket to open, and rejects if it errors first. A second `start()` throws `Start can only be called once per transport.`
- **Incoming frames** that are not JSON, or not JSON-RPC, go to `onerror`, never to `onmessage`.
- **`send()`** on a socket that is not open throws `WebSocket is not open. Cannot send message.`
- **`close()`** closes the socket and fires `onclose`. A server hang-up also fires `onclose`.

## Edge cases and errors

- **No error escapes `connectToServer`.** Every failure is a `failed` record.
- **A stdio server that writes to stderr while connecting:** its output is logged to the server's MCP log. It never reaches the terminal.
- **An `http` or `sse` server that answers 401** while tokens are stored: the OAuth client tries a refresh first (`mcp/auth`).
- **`claudeai-proxy` 401s are retried once by the proxy fetch** before they count as needs-auth (8).
- **The instructions cap is in characters:** a cut can split a surrogate pair.

## Security requirements

**Pinned by the tests:**
- **Credentials go only where the table in 3 says.** No ingress token on `sse`, `sse-ide` or `ws-ide`. The IDE lockfile token never travels as `Authorization`. The claude.ai login token goes only to the proxy.
- **A stored OAuth token wins over the session ingress token** on `http`.
- **The claude.ai proxy fetch never retries with the same token**, so a 401 cannot become a loop.
- **A server that asked for a login is not probed again for 15 minutes**, and clearing the cache is the only way to undo that.
- **A stdio server's process does not outlive its cleanup**, even when it ignores SIGINT and SIGTERM.
- **A connection that times out stops its process.**

**Described, kept for parity:** Findings 1, 2 and 3.

## Tests that pin it

- **`src/mcp/client.connection.characterization.test.ts` (new, 30 tests).** It covers `connectToServer` over every transport against real servers:
  - a stdio script the client spawns, which logs what it receives and the signals it gets;
  - Streamable HTTP, SSE and WebSocket servers on loopback ports;
  - the OAuth test bed of `mcp/auth` for the protected servers.

  It covers the handshake, headers and credentials per type, needs-auth and failure, the timeout, the cache, reconnection after a close, the cleanup escalation, and `ensureConnectedClient`. For the claude.ai proxy, `fetch` is rerouted from the fixed proxy host to a loopback server by rewriting the origin only.
- **`src/mcp/client.connectionParts.characterization.test.ts` (new, 27 tests).** It covers the fetch wrappers against loopback servers, the needs-auth cache file, the WebSocket transport against a real socket, and the small rules and knobs.
- **The harness** is `src/mcp/client/__testutils__/mcpServerBed.ts` (shared with the other two units) and `src/mcp/auth/__testutils__/oauthTestBed.ts`, which gives a temp `CLAUDIN_CONFIG_DIR` with a refusing `secret-tool` first on `PATH`.
- **Fixtures:** `src/mcp/client/__fixtures__/rewrite/initialize-hello.json` (on the wire) and `needs-auth-cache.json` (on disk).
- **Coverage, from a run of the two suites:** `connection.ts` 83%, `transport.ts` 88%, `fetch.ts` 99%, `authCache.ts` 100%, `mcpWebSocketTransport.ts` 86%.
- **`scripts/migrations/probes/rewrite-mcp-connection.json`:** 40 probes over the five files. Every one turns the suites red.
- **The inherited test `src/mcp/client.test.ts`** (69% openclaude) is deleted. Its two cases, that cleanup waits for the transport and closes the in-process server too, are in `connectionParts`.
- **Prompt text.** This unit sends one text to the model: the truncation marker on server instructions. It is pinned by the instructions table. No file outside the unit pins it.
- **Not pinned, and why:**
  - **The Node `ws` package path.** The bundle runs on Node, where both WebSocket types use the `ws` package. Under `bun test` the runtime's own WebSocket is used, so the suites pin the behaviour and not that code path.
  - **Closing after the SDK gives up reconnecting, or after three network errors in a row** (5). A loopback server cannot produce those errors on demand.
  - **The 60-second request timeout,** which would take a minute. The suites pin that the caller's abort reaches the request.
  - **Closing an `sse-ide` connection under Bun.** It raises an AbortError from the SDK's default EventSource, so the suite leaves that one connection open.
  - **The debug and error log lines** of the connection.
  - **The fixes of Findings 4, 5, 6 and 9.**

## Out of scope

- **The OAuth client and the stored-token format** (`mcp/auth`), and `headersHelper` (`mcp/auth`).
- **The config types and their parsing** (`mcp/core`, `mcp/config`).
- **The connection manager** that installs the real elicitation handler and reacts to closes (`mcp/connectionManager`).
- **The MCP user agent string** (`src/shared/http.ts`) and the session ingress token source (`src/sessions`).
- **The in-process server path.** No transport in this fork creates one. The record shape and `cleanupFailedConnection` keep the parameter for callers.

## Findings

1. **Security: the session ingress token goes to any `ws` server, and to any `http` server without a stored OAuth token, whatever its host.**
   - That includes a server from a cloned repository's `.mcp.json`.
   - **Decision: keep for parity, and track.** The claude.ai session proxy URLs depend on it. Limiting it to the proxy hosts needs their list, and the variable is set only in remote sessions.
   - Pinned.
2. **Security: `CLAUDIN_SHELL_PREFIX` gets the command and args joined by spaces, unquoted.** An argument with a space or a shell character is split again, or interpreted, by the prefix.
   - **Decision: keep for parity, and track.** Existing prefixes expect one string.
   - Pinned.
3. **The client introduces itself as `claude-code`, with Anthropic's description and website,** to every server and to SDK hosts.
   - **Decision: keep for parity, and track.** Servers may key behaviour on the client name.
   - Pinned by the fixture.
4. **A failed `http`, `sse` or `claudeai-proxy` connection (other than needs-auth) does not close its transport.** Only the other types are cleaned up.
   - **Decision: fix.** Nothing can depend on a transport left open. Not pinned.
5. **A stdio cleanup whose SIGINT fails** (the process is already gone) returns without closing the client.
   - **Decision: fix.** Not pinned.
6. **`clearServerCache` on a server whose record was already forgotten connects anew only to close it.** An expired HTTP session costs two extra handshakes.
   - **Decision: fix.** Clear without connecting. Not pinned: the suite only requires at least two handshakes.
7. **Failed and needs-auth records are cached like connections,** until `clearServerCache`.
   - **Decision: keep for parity.** The reconnect paths clear first.
   - Pinned.
8. **A needs-auth entry that could not be written still counts for the rest of the process.**
   - **Decision: keep for parity.** It is harmless.
   - Pinned.
9. **The WebSocket transport fires `onclose` from `close()` itself.** On a runtime that dispatches the socket's close synchronously (Bun), it fires twice.
   - **Decision: fix.** Fire it once. Pinned as at least once.
10. **A 401 from a server with no OAuth discovery is `failed`,** sometimes with an empty error text.
    - **Decision: keep for parity, and track** the empty text.
    - The type is pinned.
11. **The per-request timeout is a fixed 60 seconds** and cannot be configured.
    - **Decision: keep for parity.** Not pinned (time).

## Target design

- **One module per concern, behind the barrel:**
  - `transportFor(config)`: a table from config type to a builder. Each builder returns the transport and the exact headers it will send, so the credential rules of 3 are one pure function, `(type, config, storedToken?, ingressToken?) => headers`.
  - `handshake`: the client identity (one constant, shared with `sdkClients`) and the two default request handlers.
  - `connectionCache`: the keyed cache with explicit `get`, `forget(name, config)` and `onClosed(name)`. Forgetting never connects (Findings, 6).
  - `processStopper`: the SIGINT, SIGTERM, SIGKILL ladder with its timings as named constants. It always closes the client (Findings, 5).
  - `needsAuthCache`: read, write, clear. The 15-minute TTL is a named constant.
- **Failure cleanup in one place,** for every type (Findings, 4).
- **Types:**
  - `ConnectionOutcome` as the discriminated union it already is;
  - a `RemoteTransportType` for the three that count terminal errors;
  - no casts between transport classes.
- **The WebSocket transport** fires `onclose` exactly once (Findings, 9).

## Outcome

Rewritten per method on 2026-10-04.

**What changed.** Every body in the five contract files was rewritten. New modules:
- `client/connection/` holds the handshake, `openConnection`, the process stopper and the
  remote-error rules.
- `client/transport/` holds the credentials table and the WebSocket opener.

The handshake uses the shared `client/clientIdentity.ts` that the capabilities rewrite
introduced. The duplicate identity it wrote was folded into that file at landing.
`connectToServer` keeps a `.cache`, a Map with `delete`. The two characterization suites pass
unchanged.

**Fixes, each with a test.**
- **4:** every failed connection closes its transport, and a timed-out stdio child is signalled.
- **5:** cleanup always closes the client.
- **6:** `clearServerCache` never connects just to close.
- **9:** `onclose` fires once.

**Kept, each with a probe.** Findings 1, 2, 3, 7, 8, 10 and 11. Three of them are tracked in
`bugs/mcp-config-security-findings.md`:
- the session ingress token sent to any `ws` server;
- the unquoted `CLAUDIN_SHELL_PREFIX`;
- the `claude-code` identity.

**Probes.** 105, in `rewrite-mcp-connection.json`.

**Residue, reviewed.** 39 lines of Claude Code and 3 of openclaude remain:
- the exported connection, fetch and WebSocket-transport signatures;
- the "is not connected" error text that callers pin.
