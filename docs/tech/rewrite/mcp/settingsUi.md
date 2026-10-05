# Spec: `mcp/settingsUi`

## Purpose

The `/mcp` panel. It lists every MCP server the session knows, with its live
state, and lets the user open a server to switch it off or on, reconnect it,
sign in, or browse its tools. Four of the five files are its screens: the
server list, the tool list, the tool detail, and the config diagnostics block
above the list. The fifth, `MCPSettings`, reads the session's state, decides
which screen is on show, and hands each server to the right menu.

The menus themselves (`MCPStdioServerMenu`, `MCPRemoteServerMenu`,
`MCPAgentServerMenu`) are the `mcp/serverMenus` unit, and the actions they
call (switch, reconnect) belong to `mcp/connectionManager`. This unit owns
what the menus are given and where the panel goes when they hand control back.
The actions are still pinned here end to end (section 6), because a user
reaches them through this panel.

No text in this unit is sent to a model. Everything it says goes to the
screen or, through `onComplete`, to the transcript.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `MCPSettings` (also re-exported by `src/mcp/ui/index.ts`) | `(props: { onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void }) => ReactNode` | `src/commands/mcp/mcp.tsx`, for `/mcp` and `/mcp no-redirect` |
| `MCPListPanel` | `(props: { servers: ServerInfo[]; agentServers?: AgentMcpServerInfo[]; onSelectServer: (server: ServerInfo) => void; onSelectAgentServer?: (agentServer: AgentMcpServerInfo) => void; onComplete: same as above; defaultTab?: string }) => ReactNode` | `MCPSettings` |
| `McpParsingWarnings` | `() => ReactNode` | `MCPListPanel`; `src/platform/doctor/Doctor.tsx` (`/doctor`) |
| `MCPToolListView` | `(props: { server: ServerInfo; onSelectTool: (tool: Tool, index: number) => void; onBack: () => void }) => ReactNode` | `MCPSettings`; `src/commands/plugin/ManagePlugins.tsx` |
| `MCPToolDetailView` | `(props: { tool: Tool; server: ServerInfo; onBack: () => void }) => ReactNode` | `MCPSettings`; `src/commands/plugin/ManagePlugins.tsx` |

`ServerInfo`, `AgentMcpServerInfo` and `MCPViewState` live in
`src/mcp/ui/types.ts`, outside the unit. `ServerInfo` is one of four shapes,
told apart by `transport` (`stdio`, `sse`, `http`, `claudeai-proxy`); the
three remote ones carry `isAuthenticated: boolean | undefined`.

## Observable behaviour

### 1. Which servers the panel lists (`MCPSettings`)

- **Source.** The MCP clients in the app state (`mcp.clients`), and the
  servers the session's agents declare inline (`agentDefinitions.allAgents`,
  each agent's `mcpServers` entries that are `{ name: config }` objects; a
  bare string names a server configured elsewhere and adds nothing).
- **The IDE's client is never listed.** A client named exactly `ide` is
  left out of the list and of the count, whatever its transport.
- **The transport of each server** comes from its config `type`: `sse`,
  `http` and `claudeai-proxy` as such, and anything else (no type, `stdio`,
  `ws`, `sdk`, …) is handed on as a stdio server.
- **Sign-in, for `sse` and `http` servers** (`isAuthenticated`), is true when
  any of these holds:
  - an OAuth token is stored for that server. The store is keyed by server
    name, transport, URL and headers, so a token stored for another URL does
    not count. It counts even when the server is down;
  - a session access token is present (`CLAUDE_CODE_SESSION_ACCESS_TOKEN`,
    or the session-ingress token file) **and** the server is connected;
  - the server is connected and offers at least one tool.
  
  A claude.ai connector is always handed on as not signed in, and a stdio
  server has no sign-in at all. The list re-derives all this whenever the
  clients or the tool pool change.
- **When there is nothing to list,** that is, no client other than `ide` and
  no agent server, the panel calls `onComplete` once, with no options, and
  draws nothing. The message starts `No MCP servers configured.` and points to
  `/doctor`, to `<cli> mcp --help`, and to `https://code.claude.com/docs/en/mcp`.
- **It does not give up early.** While there are clients but their entries
  are still being prepared, the empty message is not sent. A client still
  `pending` is a client.

### 2. The server list (`MCPListPanel`)

- **The frame.** Title `Manage MCP servers`; subtitle `<n> server` or
  `<n> servers`, where `n` counts settings servers and agent servers together.
  Under it the config diagnostics (section 4), above the frame.
- **Groups, in this order, each with a bold heading, and only when not empty:**

  | Group | Heading | Shown after the heading |
  |---|---|---|
  | `project` scope | `Project MCPs` | `(<cwd>/.mcp.json)` |
  | `local` scope | `Local MCPs` | `(<global config file> [project: <cwd>])` |
  | `user` scope | `User MCPs` | `(<global config file>)` |
  | `enterprise` scope | `Enterprise MCPs` | nothing |
  | claude.ai connectors | `claude.ai` | nothing |
  | agent servers | `Agent MCPs`, then one dim `@<agent>` sub-heading per agent | nothing |
  | `dynamic` scope (plugins, `--mcp-config`) | `Built-in MCPs` | `(always available)` |

  A server whose config type is `claudeai-proxy` goes to the claude.ai group
  whatever its scope says, and nowhere else.
- **Order inside a group:** by name (`localeCompare`). Agent sub-groups come
  in the order the agents first appear; a server several agents declare is
  drawn under each of them.
- **A row** is `<name> · <glyph> <words>`:

  | State | Glyph | Words | Glyph colour |
  |---|---|---|---|
  | `connected` | `✔` | `connected` | success |
  | `failed` | `✘` | `failed` | error |
  | `needs-auth` | `△` | `needs authentication` | warning |
  | `disabled` | `◯` | `disabled` | inactive |
  | `pending` | `◯` | `connecting…`, or `reconnecting (<attempt>/<max>)…` while redialling | inactive, the same as `disabled` |
  | agent server, remote (`sse`/`http`) | `△` | `may need auth` | warning |
  | agent server, otherwise | `◯` | `agent-only` | inactive |

  The words are shared with the footer's MCP rows (`src/mcp/serverStatus.ts`).
  The selected row starts with `❯ ` and its name is in the suggestion colour;
  the others are indented two spaces and dim after the name.
- **The foot.** When some server is `failed`: `※ Run <cli> --debug to see
  error logs`, or, with debug on, `※ Error logs shown inline with --debug`.
  Always: `https://code.claude.com/docs/en/mcp for help`, then the hints
  `↑↓ to navigate · Enter to confirm · Esc to cancel`.
- **Keys** (the `Confirmation` key context):
  - the first row starts selected;
  - Down and Up move one row and wrap at both ends. The rows are walked in
    group order: project, local, user, enterprise, claude.ai, agent servers
    (in the order given), built-in;
  - Enter or `y` opens the selected row: `onSelectServer(server)`, or
    `onSelectAgentServer(agentServer)` for an agent server. Without an
    agent handler, an agent row does nothing;
  - Esc or `n` calls `onComplete('MCP dialog dismissed', { display: 'system' })`, once.
- **Nothing to draw.** With no servers and no agent servers the panel
  renders nothing at all and calls nothing.
- `defaultTab` is accepted and ignored (Findings, 2).

### 3. Where each screen leads (`MCPSettings`)

| From | Action | To |
|---|---|---|
| list | open a stdio server | `MCPStdioServerMenu` with the server, its tool count, and `onComplete` |
| list | open any other server | `MCPRemoteServerMenu`, same props |
| list | open an agent server | `MCPAgentServerMenu` with the agent server and `onComplete` |
| list | Esc / `n` | out: `MCP dialog dismissed` (system) |
| server menu | Esc, Back, or a finished switch (the menu's `onCancel`) | the list |
| server menu | View tools | the tool list for that server |
| server menu | Reconnect, or anything else that ends with `onComplete` | out, with the menu's message |
| tool list | Enter on a tool | the tool detail, for the tool at that position of the server's tools |
| tool list | Esc | the server menu |
| tool detail | Esc | the tool list |
| tool detail | the tool leaves the pool while on show | the tool list, at once |
| agent menu | Esc or Back | the list |

The tool count a menu receives is the number of tools in the pool whose name
starts with the server's `mcp__<normalised name>__` prefix.

### 4. Config diagnostics (`McpParsingWarnings`)

- **Read once, when it mounts,** from the user, project, local and enterprise
  scopes, in that order. Fixing a file while the panel is open changes
  nothing until it is opened again.
- **Nothing is drawn** when no scope has an error or a warning, including when
  no scope has a config at all.
- **Otherwise:** a bold `MCP Config Diagnostics`, then
  `For help configuring MCP servers, see: https://code.claude.com/docs/en/mcp`,
  then one section per scope that has something, in scope order:
  - `[Failed to parse] <label>` (error colour) when the scope has at least one
    fatal error, else `[Contains warnings] <label>` (warning colour);
  - `Location: <path>`, the scope's file as in the list headings, the
    enterprise one being `<managed dir>/managed-mcp.json`;
  - one line per fatal error, then one per warning:
    ` └ [Error] ` or ` └ [Warning] ` (in the error or warning colour), then
    `[<server>] ` when the problem names a server, `<path>: ` when it has a
    non-empty path, and the message.
- **Labels:** `User config (available in all your projects)`,
  `Project config (shared via .mcp.json)`,
  `Local config (private to you in this project)`,
  `Enterprise config (managed by your organization)`.
- A problem with no severity is not shown. The config reader always sets one.

### 5. Tools (`MCPToolListView`, `MCPToolDetailView`)

**The tool list.**
- Title `Tools for <server>`, subtitle `<n> tool` or `<n> tools`.
- The tools are the pool's tools of that server, in pool order, and only
  when the server is `connected`. Otherwise, or with none, it shows
  `No tools available` and counts 0.
- **Each option** is the tool's display name: the part of its user-facing
  name after `<server> - `, without the ` (MCP)` tag (that is the server's
  title annotation when it gave one, else the tool name). A tool with no
  user-facing name shows its full name without the server prefix.
- **Its hint column** lists `read-only`, `destructive`, `open-world`, in that
  order, joined by `, `, for the hints the server set. No hint, no column.
- Enter calls `onSelectTool(tool, position)`. Esc calls `onBack` once.
- Hints: `↑↓ to navigate · Enter to select · Esc to back`; after one Ctrl+C,
  `Press Ctrl-C again to exit` in their place.

**The tool detail.**
- **Header:** the display name, then ` [read-only]` (success colour),
  ` [destructive]` (error colour), ` [open-world]` (dim), for the hints set,
  in that order. Subtitle: the server name as configured.
- `Tool name: <name without the server prefix>`, then
  `Full name: <qualified name>`, e.g. `mcp__My_Server_v2__do-it` for server
  `My Server.v2`.
- **Description:** loaded from the tool when the screen opens. Shown under a
  bold `Description:` when not empty. If loading fails:
  `Failed to load description`.
- **Parameters:** when the input schema has at least one property, a bold
  `Parameters:` and one line per property in schema order:
  `• <key>` + ` (required)` when listed in `required` + `: ` + the property's
  `type`, or `unknown` when it has none + ` - <description>` when it has one.
- Esc calls `onBack` once. Hint: `Esc to go back`; after one Ctrl+C,
  `Press Ctrl-C again to exit`.

### 6. What the actions do, seen through the panel

Pinned end to end with real servers; implemented in `mcp/serverMenus` and
`mcp/connectionManager`.
- **Disable** (stdio or remote): the server's name is added to this
  project's `disabledMcpServers` in the global config, the client becomes
  `disabled`, and the panel is back on the list showing `◯ disabled`. Nothing
  is sent to `onComplete`.
- **Enable:** the name leaves `disabledMcpServers`, the server connects
  again, and the panel is back on the list showing `✔ connected`.
- **Reconnect:** the panel closes through `onComplete('Reconnected to <name>.')`.
- **The remote menu's `Auth:` line** shows `✔ authenticated` or
  `✘ not authenticated` from the sign-in decided in section 1.

## Edge cases and errors

- **Only the IDE's client, or agents that only name servers by reference:**
  the empty message, as for no servers at all.
- **Only agent servers:** the panel opens and lists them.
- **A tool removed from the pool** while its detail is open: back to the
  tool list, which recounts.
- **A server whose scope has no group** (`managed`, or a non-connector with
  the `claudeai` scope): no producer exists today (Findings, 5).
- **A description that throws:** `Failed to load description`, never an
  error on screen.
- **A property schema that is not an object** (`true`): typed `unknown`.

## Security requirements

- **The panel writes nothing.** Opening it, moving around and leaving it
  changes no settings and no credentials. Only the server menus' actions
  write, and only `disabledMcpServers` (or `enabledMcpServers` for claude.ai
  connectors) of this project's entry in the global config.
- **Credentials are only read,** through the secure store (the OS keyring,
  else the plaintext credential file under the config directory). No token
  appears on screen. The suites stand in a refusing `secret-tool`, so the
  user's own keyring is never asked.
- **Sign-in is display only.** `isAuthenticated` decides which options the
  remote menu offers and what its `Auth:` line says; it grants nothing. See
  Findings, 9 and 10.

## Tests that pin it

- `src/mcp/ui/MCPListPanel.characterization.test.tsx`: groups, headings,
  order, rows, colours, foot, keys, the empty case, the diagnostics above.
- `src/mcp/ui/McpParsingWarnings.characterization.test.tsx`: the block from
  real broken configs in the four scopes.
- `src/mcp/ui/MCPToolListView.characterization.test.tsx` and
  `MCPToolDetailView.characterization.test.tsx`: tools built by the MCP
  client's own `toolFromListing`.
- `src/mcp/ui/MCPSettings.characterization.test.tsx`: the list from seeded
  app state (the IDE filter, agent servers, the empty message), the agent
  menu round trip.
- `src/mcp/ui/MCPSettings.actions.characterization.test.tsx`: the panel
  inside `<MCPConnectionManager>` with real stdio, Streamable HTTP and SSE
  servers: Disable, Enable, Reconnect, the screen walk, and the sign-in cases.
- Shared inputs: `src/mcp/ui/__testutils__/settingsUiRig.tsx`, with
  `promptFrameRig.tsx`, `mcpConfigWorld.ts`, `connectionRig.tsx` and
  `mcpServerBed.ts`.
- `scripts/migrations/probes/rewrite-mcp-settingsUi.json`: 40 probes over the
  five files, the sign-in, IDE and not-connected checks also mutated to fail
  open.
- No test or snapshot outside the unit pins its text.

## Out of scope

- The menus' own options, statuses and OAuth flows (`mcp/serverMenus`).
- How switching and reconnecting work (`mcp/connectionManager`), and how
  configs are read (`mcp/config`).
- `/mcp enable|disable|reconnect <name>` without the panel
  (`src/commands/mcp/mcp.tsx`).

## Findings

1. **The text names another product's CLI:** `claude mcp --help` in the
   empty message, `claude --debug` in the failure hint.
   - **Decision: fix.** Say `claudin`. Nothing parses these strings.
   - Not pinned: the suites check the advice, not the binary name.
2. **`defaultTab` is ignored.** After leaving a server menu, the list starts
   again on its first row instead of the server the user came from.
   - **Decision: fix.** Come back with that server selected. Nothing depends on the reset.
   - Not pinned.
3. **An agent server declared by several agents** is drawn once per agent,
   but is one row for the keys: both copies light up together, and the rows
   are walked in server-name order while they are drawn by agent, so the
   highlight can jump.
   - **Decision: keep the per-agent drawing for parity** (it tells which
     agents use a server; pinned). **Fix** the walk and the highlight to
     follow what is drawn (not pinned).
4. **The hint colours in the tool list are never drawn.** Destructive and
   read-only are meant to be coloured, but the option list ignores the colour.
   - **Decision: fix.** Draw them as the detail header does.
   - Not pinned.
5. **A server in a scope with no group** is counted in the subtitle and can
   be neither seen nor selected.
   - **Decision: fix.** Unreachable today; list such servers under their scope word.
   - Not pinned.
6. **The diagnostics `Location:` for the project scope** is always
   `<cwd>/.mcp.json`, even when the problem is in a parent directory's file.
   - **Decision: fix.** Show the file each problem came from. The same defect is finding 5 of `mcp/doctor`.
   - Not pinned.
7. **The diagnostics are read once** per opening of the panel.
   - **Decision: keep for parity.** The panel is short-lived. Pinned.
8. **Agent servers never learn their sign-in.** The agent menu always says
   `may need authentication` and offers `Authenticate`, even after a
   successful sign-in.
   - **Decision: fix.** Check the store for agent servers as for settings servers.
   - Not pinned.
9. **Security: a session access token makes every connected remote server
   read as signed in,** whether or not that server ever saw the token. The
   menu then offers Re-authenticate and Clear authentication where
   Authenticate would be right.
   - **Decision: keep for parity.** Display only; nothing is granted. Pinned.
10. **Security: deciding sign-in can refresh tokens.** Reading a stored token
    whose access token is stale makes a refresh request, so opening `/mcp`
    can rotate a server's refresh token and reach the network.
    - **Decision: fix.** Use a read that never refreshes. Pure hardening: the
      display is the same.
    - Not pinned.
11. **The docs link points at another product's documentation.**
    - **Decision: keep for parity** until Claudin has its own MCP page. Pinned.

## Target design

- **One folder,** `mcp/ui/settings/`: the list, the tool list, the tool
  detail, the diagnostics, and a thin `McpSettingsPanel` that routes.
- **Split derivation from drawing.**
  - `describeServers(clients, toolPool, credentials)`: a pure function that
    returns the `ServerInfo[]` (transport, sign-in) with credentials passed
    in, so it can be tested without a store and never refreshes (Findings, 10).
  - `listGroups(servers, agentServers)`: returns the groups, headings and
    one flat row order, which both the drawing and the keys use (Findings, 3, 5).
  - `diagnosticsFor(scopeReads)`: returns sections as data.
- **Make the screen state explicit:** keep `MCPViewState`, with the list
  state carrying the server to reselect instead of `defaultTab` (Findings, 2).
- **Menus are chosen by transport** in one table (`stdio` → stdio menu, the
  rest → remote menu), not by branches repeated per screen.
- **The tool screens take their tools as a prop.** The tool list then no
  longer reads the app state itself, and the plugin manager and `/mcp`
  pass the same list.
