# Spec: `mcp/connectionManager`

Files: `src/mcp/useManageMCPConnections.ts`, `src/mcp/MCPConnectionManager.tsx`,
`src/mcp/hooks/useMergedClients.ts`.

## Purpose

This is the React layer that keeps the session's MCP servers in app state. When
the interactive session (the REPL) or the headless doctor screen mounts it, it
works out which configured servers to start, lists them in app state, dials
them, and keeps app state current as they connect, fail, drop, come back,
change their tool lists, or are switched off and on by the user. It hands its
children three actions (reconnect, switch on/off, disconnect for this session)
through a React context. A small helper merges the clients the REPL was
started with into the clients it keeps.

Reading the config, judging policy and approval, dialling a single server and
fetching its tools are other units (`mcp/config`, `mcp/core`, `mcp/client`).
This unit decides when to call them and what reaches app state.

## Public contract

These keep their names, paths and types while their callers are not rewritten.

| Export | Signature | Used by |
|---|---|---|
| `MCPConnectionManager` | component, props `{ children: ReactNode; dynamicMcpConfig: Record<string, ScopedMcpServerConfig> \| undefined; isStrictMcpConfig: boolean }` | `agent/repl/REPL.tsx`, `platform/headless/handlers/util.tsx` |
| `useMcpReconnect` | `() => (serverName: string) => Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }>` | `mcp/ui/MCPReconnect.tsx`, `mcp/ui/MCPRemoteServerMenu.tsx`, `mcp/ui/MCPStdioServerMenu.tsx` |
| `useMcpToggleEnabled` | `() => (serverName: string) => Promise<void>` | `commands/mcp/mcp.tsx`, `commands/plugin/ManagePlugins.tsx`, `mcp/ui/MCPRemoteServerMenu.tsx`, `mcp/ui/MCPStdioServerMenu.tsx` |
| `useMcpDisconnect` | `() => (serverName: string) => Promise<void>` | `agent/ui/tasks/McpDisconnectDialog.tsx` |
| `useManageMCPConnections` | `(dynamicMcpConfig: Record<string, ScopedMcpServerConfig> \| undefined, isStrictMcpConfig?: boolean) => { reconnectMcpServer; toggleMcpServer; disconnectMcpServer }` (the three action types above; `isStrictMcpConfig` defaults to `false`) | `mcp/MCPConnectionManager.tsx` |
| `resolveUpdatedTools` | `(current: Tool[], clientType: MCPServerConnection['type'], prefix: string, rawTools: Tool[] \| undefined) => Tool[]` | `mcp/resolveUpdatedTools.test.ts`, `agent/compact/requestDeterminism.invariant.test.ts` |
| `mergeClients` | `(initialClients: MCPServerConnection[] \| undefined, mcpClients: readonly MCPServerConnection[] \| undefined) => MCPServerConnection[]` | `agent/repl/controllers/useToolUseContext.ts`, `agent/repl/controllers/useOnQuery.ts` |
| `useMergedClients` | `(initialClients: MCPServerConnection[] \| undefined, mcpClients: MCPServerConnection[] \| undefined) => MCPServerConnection[]` | `agent/repl/REPL.tsx` |

`MCPServerConnection`, `ScopedMcpServerConfig` and `ServerResource` are
`mcp/types.ts`'s; `Tool` is `tools/Tool.ts`'s; `Command` is
`commands/commands.ts`'s.

**App state it owns.** `mcp.clients`, `mcp.tools`, `mcp.commands` and
`mcp.resources` (a record keyed by server name). It reads
`mcp.pluginReconnectKey` (bumped by `/reload-plugins` in `plugins/refresh.ts`)
and writes to `plugins.errors` and `elicitation.queue`.

**Inputs outside props.** The session id (`platform/bootstrap/state.ts`), and
the login version (`providers/auth/authChanged.ts`, bumped by
`emitAuthChanged`). A change of either re-runs start-up.

## Observable behaviour

### The context

- `MCPConnectionManager` renders its children inside the context.
- Each of the three action hooks returns its action inside the manager.
- Outside the manager, each one throws an `Error` whose message names the hook
  and says it must be used within `MCPConnectionManager`.

### Which servers start

Start-up runs on mount, and again when the session id, `dynamicMcpConfig`,
`isStrictMcpConfig` or `mcp.pluginReconnectKey` changes. The connect part also
re-runs when the login version changes.

1. **The servers considered.** `getClaudeCodeMcpConfigs(dynamicMcpConfig, …)`
   (`mcp/config`), merged with `dynamicMcpConfig` (the `--mcp-config` servers).
   On a name collision the `dynamicMcpConfig` entry wins.
   - **Strict mode** (`isStrictMcpConfig`) skips the config scopes: only
     `dynamicMcpConfig` is considered.
   - **What `mcp/config` already removed never appears in app state and is
     never spawned:** a project server that is pending approval or rejected, a
     server the policy denies or the allowlist leaves out, and every non-managed
     server when a `managed-mcp.json` exists.
   - **`dynamicMcpConfig` is taken as given:** it is not re-checked against the
     policy here (Findings, 2).
2. **Listing.** Each considered server not yet in `mcp.clients` is added:
   - as `disabled` when `isMcpServerDisabled(name)` holds; it is never dialled,
     and never shown as `pending`;
   - otherwise as `pending`, before it is dialled.
3. **Dialling.** Every listed server that is not disabled is dialled
   concurrently. Each result replaces the server's entry as it arrives
   (`connected`, `failed` with an `error` string, or `needs-auth`). One server
   that cannot start does not hold back another.
4. **Config errors.** The errors `getClaudeCodeMcpConfigs` returns are appended
   to `plugins.errors`, skipping any whose `(type, source, plugin)` is already
   on the list. A plugin's MCP error has `source: 'plugin:<plugin>'`. Loading
   configs twice (listing and connecting both load them) reports an error once.
   Other errors already on the list are kept.
5. **claude.ai connectors** (second phase).
   - **The listing is requested** once per run of the connect part, so again
     after a login change. It is not requested in strict mode or when a
     `managed-mcp.json` exists. Under Claudin's default privacy level
     (nonessential traffic off) the listing is empty without a request.
   - **Connectors the policy denies** (by URL) never appear.
   - **A connector whose URL matches an enabled manual server** is dropped in
     favour of the manual one.
   - **The rest are added** to `mcp.clients` if their name is not there yet:
     `disabled` unless the user opted into it (connectors are opt-in), else
     `pending`. A name already listed is not listed twice.
   - **Opted-in connectors are dialled** like any other server.

### What a connected server brings

- **Tools** go into `mcp.tools`, named `mcp__<server>__<tool>`. A server that
  declares resources also brings `ListMcpResourcesTool` and
  `ReadMcpResourceTool`.
- **Prompts** go into `mcp.commands`, named `mcp__<server>__<prompt>`.
- **Resources** go into `mcp.resources[<server>]`, each entry carrying
  `server: <server>`.
- **Elicitation.** A server's elicitation request is queued in
  `elicitation.queue` with `serverName` and the request `params`; the queued
  `respond` sends the answer back to the server.
- **List changes.** When the server declared `listChanged` for tools, prompts
  or resources, its `list_changed` notification refetches that list (never from
  a cache) and replaces the server's part of app state. Without the
  declaration, the notification is ignored.

### How an update changes app state

Updates for one server replace its `mcp.clients` entry (or append it), and:

- **Tools.** The pool is updated in place, for prompt-cache stability. Tools
  the server already had keep their position, with the new tool object; tools
  it no longer has are dropped; new ones are appended at the end; other
  servers' tools do not move. An update without a tool list keeps the pool as
  it is. `disabled` with no list clears the server's tools; `failed` with no
  list keeps them. `resolveUpdatedTools` is this rule as a pure function.
- **Prompts.** A list replaces the server's prompts. `disabled` or `failed`
  with no list clears them. An update without a list keeps them.
- **Resources.** A non-empty list replaces the server's entry.
- **Batching.** Updates that arrive within a 16 ms window reach app state in a
  single state change. So an attempt's `pending` and its quick result may never
  be seen separately.

### A connected server that closes

- **Disabled on disk, or disconnected for this session**, when it closes: it
  is not dialled again, and app state is not changed (Findings, 4).
- **A local server** (`stdio`, or no type; also `sdk`) becomes `failed`
  immediately and is not respawned. It keeps its tools and loses its prompts.
- **A remote server** (any other type) is redialled automatically:
  - up to **5 attempts**. The first is immediate; then it waits **1 s, 2 s, 4 s
    and 8 s** before attempts 2 to 5;
  - before each attempt its entry is `pending` with `reconnectAttempt: <n>` and
    `maxReconnectAttempts: 5`, keeping its tools and prompts;
  - the first attempt that connects ends the loop, and the server is
    `connected` with its fresh lists;
  - after the fifth failed attempt the result is applied: `failed`, and its
    tools and prompts are cleared;
  - at the start of each attempt, if the server is now disabled on disk or
    disconnected for the session, the loop stops without dialling;
  - a pending wait is cancelled by `reconnectMcpServer`, `toggleMcpServer`,
    `disconnectMcpServer` on that server, and by unmounting.

### The actions

All three look the server up in `mcp.clients` and reject with
`MCP server <name> not found` when it is missing. They decide from app state
(see Edge cases).

- **`reconnectMcpServer(name)`.** It cancels a pending wait, takes back a
  session disconnect, and dials a fresh connection. Then it applies the result
  and returns it: `{ client, tools, commands, resources? }`. A server that
  cannot be reached comes back as `failed` with empty lists; it does not
  throw. A server that comes back with the same tools keeps the pool in the
  same order.
- **`toggleMcpServer(name)`.**
  - **When the entry is not `disabled`:** it cancels a pending wait, persists
    the server as disabled (`setMcpServerEnabled(name, false)`, which goes into
    the project's `disabledMcpServers`, before anything is closed), closes the
    connection if it is `connected`, and sets it `disabled`. A server that
    never connected is not dialled.
  - **When the entry is `disabled`:** it persists the server as enabled, takes
    back a session disconnect, sets it `pending`, dials it, and applies the
    result. A server that cannot start ends `failed`, without throwing.
- **`disconnectMcpServer(name)`.** It marks the server disconnected for this
  session *before* closing anything, cancels a pending wait, closes the
  connection if it is `connected` (a stdio server's process exits), and sets
  it `disabled`, which clears its tools and prompts. It writes nothing to disk.
  A later reconnect or switch-on takes the mark back, and after that the
  server is redialled again when it drops.

### Inputs that change

- **A plugin reload** (`mcp.pluginReconnectKey`) re-lists:
  - a plugin server (scope `dynamic`) whose plugin is gone is removed with its
    tools and prompts. If it was connected its connection is closed (the
    process exits) without a redial, and any pending wait is cancelled;
  - a server whose config changed (ignoring `scope`) is removed in the same
    way, re-listed as `pending`, and dialled with the new config.
- **A new `dynamicMcpConfig`** starts its new servers. A `dynamic`-scope server
  it no longer contains is removed.
- **Unmounting** cancels every pending wait, and applies the updates still
  waiting for their batch.

### `mergeClients` / `useMergedClients`

- **With initial clients and a non-empty app-state list:** the initial clients
  first, then app state, de-duplicated by name. The first occurrence wins, so
  an initial client beats a managed one of the same name.
- **With initial clients and an empty or missing app-state list:** the initial
  array itself.
- **With neither:** `[]`.
- The inputs are never changed.
- `useMergedClients` returns the same array until either input changes
  identity.

## Edge cases and errors

- **A server that cannot start:** a missing binary, a refused remote, or a
  process that exits before the handshake. Its entry is `failed` with an
  `error` string, and nothing of it is in the pool.
- **The actions read app state, which lags up to one batch window behind.** A
  `toggleMcpServer` called within 16 ms of a `disconnectMcpServer` still sees
  `connected`, and persists a disable. Callers have a dialog in between.
- **A list refetch that fails** after a `list_changed` is logged, and app
  state is unchanged.
- **Connector names** (`claude.ai <display name>`) are not valid `serverName`
  policy entries, so a policy can deny a connector only by URL (Findings, 14).
- **Concurrency.** Results arrive in any order; each replaces only its own
  server's part of app state.

## Security requirements

- A server that `mcp/config` excluded (pending or rejected project server,
  denied by policy, outside the allowlist, outside a managed-only config) is
  never spawned or dialled, not even by the redial loop.
- A server disabled on disk, or disconnected for the session, is never
  redialled automatically. The check happens when the transport closes, and
  again before each attempt.
- `disconnectMcpServer` never writes settings. `toggleMcpServer` persists
  *before* closing, so the close handler sees the new state.
- claude.ai connectors go through the policy and are opt-in. The listing is
  skipped in strict mode, under a managed MCP config, and under the default
  privacy level.
- `dynamicMcpConfig` must be policy-filtered by the caller (Findings, 2).

## Tests that pin it

The characterization suites, mounted on `terminal/__testutils__/fakeTerminal.ts`
inside a real `AppStateProvider`, with real servers: SDK `Server`s on loopback
WebSockets, and stdio child processes. Config lives in a temp world
(`mcp/__testutils__/mcpConfigWorld.ts`). The rig is
`src/mcp/__testutils__/connectionRig.tsx`. It parks every timer from 1 s to
30 s, so the backoff delays are read and released by the test. The only stub
is the claude.ai connector listing (axios), a network call behind a login.

- `src/mcp/MCPConnectionManager.characterization.test.tsx`: the context, the
  hooks outside the manager, rendering children.
- `src/mcp/useManageMCPConnections.startup.characterization.test.tsx`: which
  servers start (14 rows), precedence, `pending` before `connected`, what a
  connection brings, failures, and config errors.
- `src/mcp/useManageMCPConnections.reconnect.characterization.test.tsx`:
  redials, the backoff schedule, stopping conditions, cancelling waits, the
  session disconnect, and a stdio exit (including one disabled on disk).
- `src/mcp/useManageMCPConnections.actions.characterization.test.tsx`: the
  three actions, the in-place tool pool, list changes, elicitation, plugin
  reload, a new `dynamicMcpConfig`, and the flush at unmount.
- `src/mcp/useManageMCPConnections.connectors.characterization.test.tsx`: the
  listing, opt-in, the policy, dedup, strict mode, the managed config, the
  privacy default, and the login change.
- `src/mcp/hooks/useMergedClients.characterization.test.tsx`: the merge table
  and the hook's memo.

79 tests; all three files of the unit are above 90% line coverage.

Break-probe spec: `scripts/migrations/probes/rewrite-mcp-connectionManager.json`
(40 probes; 12 on the paths that decide not to start, or not to redial, a
server).

**Tests outside the unit that read its source.** The rewrite will break them,
and must replace or delete them. Their behaviour is pinned by the suites above.
- `src/mcp/resolveUpdatedTools.test.ts`, "wiring (source guard)": it expects
  the text `const updatedTools = resolveUpdatedTools(`.
- `src/mcp/sessionDisconnects.test.ts`, "the disconnect path in
  useManageMCPConnections": five source scans (the function name, no
  `setMcpServerEnabled` in the disconnect, mark-before-close order, the guard
  regex, exactly two `clearSessionDisconnected(serverName)`).
- `src/agent/compact/requestDeterminism.invariant.test.ts` and
  `src/mcp/resolveUpdatedTools.test.ts` import `resolveUpdatedTools` from
  `src/mcp/useManageMCPConnections.js`, so the export must stay at that path.

The unit sends no text to a model.

## Out of scope

- Dialling, tool and prompt fetching, the needs-auth cache, and the resource
  tools (`mcp/client`).
- Config merging, approval, policy and toggles on disk (`mcp/config`,
  `mcp/core`). The elicitation handler itself (`mcp/elicitation`).
- The per-scope server counts computed at the end of start-up. They are never
  used, and the rewrite drops them.
- The 30 s backoff ceiling. It is unreachable with five attempts, and the
  rewrite may drop it (Findings, 7).

## Findings

1. **Resources are never removed from `mcp.resources`.** A server that is
   switched off, disconnected, failed or stale, or that reports an empty list,
   keeps its entry. The removal is computed but overwritten.
   - **Decision: fix.** Nothing can rely on resources of a server that is gone.
     The suites do not pin either way. The rewrite removes the entry.
2. **`dynamicMcpConfig` bypasses the policy here.** The CLI filters
   `--mcp-config` in `platform/main/action/mcpAndPerms.ts` before mounting.
   - **Decision: keep for parity**, pinned. Security: any new caller must
     filter first.
3. **The resource tools are appended again on every reconnect** of a server
   with resources: the pool gains another `ListMcpResourcesTool` /
   `ReadMcpResourceTool` pair each time. `assembleToolPool` de-duplicates by
   name, so the model never sees the repeats, but the pool grows.
   - **Decision: fix.** Not pinned; the suite compares without repeats.
4. **A server disabled on disk outside the manager keeps a stale state.** This
   covers a server that closes while disabled, and a redial loop that stops
   because the server was disabled during a wait. The entry stays `connected`,
   or `pending` with an attempt number.
   - **Decision: fix.** The rewrite marks it `disabled`. The suites pin only
     that no redial happens.
5. **Plugin errors are de-duplicated by `(type, source, plugin)`**, and a
   plugin's `source` does not name the server. Two broken servers in one
   plugin are reported as one.
   - **Decision: fix.** The key includes the server name. Only the one-server
     case is pinned.
6. **`mergeClients(undefined, [..])` returns `[]`,** dropping every managed
   client. Production callers always pass an array.
   - **Decision: fix.** The result is the app-state list. Not pinned.
7. **The backoff ceiling (30 s) is unreachable.**
   - **Decision: keep for parity.** The schedule 1, 2, 4, 8 s is pinned; the
     ceiling is not.
8. **The redial loop handles a thrown reconnect, but the reconnect never
   throws** (it returns `failed`).
   - **Decision: keep for parity.** It cannot be reached, so it is not pinned.
9. **Cancelled or orphaned redial loops are left suspended.** A cancelled
   wait never resolves. An attempt in flight at unmount may schedule a wait
   that nothing cancels, and then keep dialling (seen in the suites' own
   teardown, which therefore disconnects every server before unmounting).
   - **Decision: fix.** One cancellable redial per server, cancelled on
     unmount. Not pinned.
10. **Giving up after five attempts clears the tools,** while a stdio exit
    keeps them.
    - **Decision: keep for parity**, pinned. Giving up is not a transient
      blip.
11. **Actions decide from app state that lags one batch window** (Edge cases).
    - **Decision: keep for parity.** Not pinned.
12. **Switching on, or reconnecting, a server with no cached connection opens
    a throw-away session first.** The client's cache clear dials in order to
    close.
    - **Decision: track** under `mcp/client`. The suites count sessions
      relatively.
13. **Disabled servers are filtered twice** (here and in
    `getMcpToolsCommandsAndResources`). The filter in this unit is redundant,
    and no probe can turn it red.
    - **Decision: keep for parity.** The rewrite may rely on either one.
14. **A connector cannot be denied by name.** `claude.ai Notes` is not a valid
    `serverName` entry, and the settings schema then drops the whole managed
    settings file, every other deny included.
    - **Decision: track** under `mcp/config` and settings. Security-relevant.

## Target design

- **`src/mcp/connectionManager/`**, keeping the three public paths as thin
  re-exports during the transition:
  - **`plan.ts`:** pure. Given the merged configs, the disabled predicate and
    the current clients, it gives the entries to add (`pending` or
    `disabled`), the stale entries to remove, and the servers to dial.
  - **`poolUpdate.ts`:** pure. It applies one server update to `mcp`: the
    `resolveUpdatedTools` rule, prompts, and resources with real removal
    (Findings, 1 and 3). Plugin error merging, keyed per server (5), goes here
    too.
  - **`redial.ts`:** one redial loop per server, owned by an object with
    `start(name, config)`, `cancel(name)` and `cancelAll()`, and an injectable
    clock and schedule (`[1000, 2000, 4000, 8000]`, five attempts). It re-checks
    disabled and session-disconnected before every attempt, and settles the
    entry as `disabled` when it stops for that reason (4, 9).
  - **`batcher.ts`:** a 16 ms coalescing queue with `push`, `flush` and
    `dispose`.
  - **`useManageMCPConnections.ts`:** wires these to app state and the effects.
    The three actions share one "look up or throw" helper. `toggle` and
    `disconnect` differ only by persisting.
- **Types to make explicit:** `ServerUpdate`
  (`MCPServerConnection & { tools?; commands?; resources? }`),
  `RedialSchedule`, and `StartPlan`.
- **`MCPConnectionManager.tsx`:** plain TSX, not compiler output. One context
  object memoized on the three actions.
- **`mergeClients`:** stays a pure function next to `useMergedClients`, with
  Finding 6 fixed.

## Outcome

Rewritten per method on 2026-10-04.

**Code**
- The three public files are plain hand-written code over `connectionManager/`: `types`, `poolUpdate`, `plan`, `batcher`, `redial`, `runtime`, `listRefresh`, `actions`, `startup`.
- `resolveUpdatedTools` moved unchanged into `poolUpdate.ts` and is re-exported.
- The six characterization suites pass unchanged.
- The five source-text guards in `resolveUpdatedTools.test.ts` and `sessionDisconnects.test.ts` became assertions on the mounted manager.

**Fixes, each with a test**
1. A server's resources are removed when it goes away.
2. The resource tools join the pool once.
3. A server disabled on disk shows `disabled`.
4. Plugin error keys include the server name.
5. `mergeClients(undefined, …)` keeps the app-state list.
6. Nothing starts or dials after unmount.

**Kept as pinned:** findings 2, 7, 8, 10, 11 and 13. Finding 14 (a connector cannot be denied by name) is tracked in `bugs/mcp-config-security-findings.md`.

**Probes:** 92 in `rewrite-mcp-connectionManager.json`, proved in the sandbox. One probe, "renders children", makes every test wait out a 12 s timeout, so a full run takes over an hour.

**Residue, reviewed:** 16 lines of Claude Code remain. They are the hook's options type, `mergeClients`' signature, and the context value's fields.
