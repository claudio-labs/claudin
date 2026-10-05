# Spec: `mcp/serverMenus`

Files: `src/mcp/ui/MCPRemoteServerMenu.tsx`, `src/mcp/ui/MCPStdioServerMenu.tsx`,
`src/mcp/ui/MCPAgentServerMenu.tsx`, `src/mcp/ui/CapabilitiesSection.tsx`,
`src/mcp/ui/reconnectHelpers.tsx`, `src/mcp/ui/MCPReconnect.tsx`.

## Purpose

These are the screens behind one server in `/mcp`, plus `/mcp reconnect <name>`.
When the user picks a server in the `/mcp` list (or in the MCP tab of
`/plugins`), the caller mounts one of three menus. A stdio server gets a menu
to reconnect it or switch it off and on. A remote server (SSE, HTTP, or a
claude.ai connector) gets the same, plus sign-in and sign-out. A server that
lives only in an agent's frontmatter gets a menu to sign in ahead of the
agent's run. `MCPReconnect` redials one server when it mounts and tells the
command how that went. The menus act through the connection manager's context
(reconnect, switch on/off), app state, the MCP OAuth module and the browser.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `MCPRemoteServerMenu` | component, props `{ server: SSEServerInfo \| HTTPServerInfo \| ClaudeAIServerInfo; serverToolsCount: number; onViewTools: () => void; onCancel: () => void; onComplete?: (result?: string, options?: { display?: CommandResultDisplay }) => void; borderless?: boolean }` | `mcp/ui/MCPSettings.tsx`, `commands/plugin/ManagePlugins.tsx` (with `borderless`) |
| `MCPStdioServerMenu` | component, props as above with `server: StdioServerInfo` and `onComplete` required | `mcp/ui/MCPSettings.tsx`, `commands/plugin/ManagePlugins.tsx` (with `borderless`) |
| `MCPAgentServerMenu` | component, props `{ agentServer: AgentMcpServerInfo; onCancel: () => void; onComplete?: (result?: string, options?: { display?: CommandResultDisplay }) => void }` | `mcp/ui/MCPSettings.tsx` |
| `MCPReconnect` | component, props `{ serverName: string; onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void }` | `commands/mcp/mcp.tsx` |
| `CapabilitiesSection` | component, props `{ serverToolsCount: number; serverPromptsCount: number; serverResourcesCount: number }` | the stdio and remote menus |
| `handleReconnectResult` | `(result: { client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }, serverName: string) => ReconnectResult` | the stdio and remote menus |
| `handleReconnectError` | `(error: unknown, serverName: string) => string` | the stdio and remote menus |
| `ReconnectResult` | `interface { message: string; success: boolean }` | the two above |

The `*ServerInfo` types are `mcp/ui/types.ts`'s (not part of the unit).
`CommandResultDisplay` is `commands/commands.ts`'s. Every menu must be mounted
inside `MCPConnectionManager` (its hooks throw outside it) and the app-state
provider.

## Observable behaviour

Every `onComplete` string below is exact. "Goes back" means `onCancel()` is
called once.

### `CapabilitiesSection`

- One line: `Capabilities: ` followed by the offered kinds joined by ` · `, in
  the order tools, resources, prompts. A kind is offered when its count is
  above 0. With none offered the line reads `Capabilities: none`.

### `handleReconnectResult` / `handleReconnectError`

| Client type | `message` | `success` |
|---|---|---|
| `connected` | `Reconnected to <name>.` | true |
| `needs-auth` | `<name> requires authentication. Use the 'Authenticate' option.` | false |
| `failed` | `Failed to reconnect to <name>.` | false |
| anything else | `Unknown result when reconnecting to <name>.` | false |

`<name>` is the `serverName` argument. The error text is
`Error reconnecting to <name>: <reason>`, where the reason is an `Error`'s
message, and `String(value)` for anything else.

### What the stdio and remote menus show

- **Frame.** A rounded border, dropped with `borderless`. Then the title
  `<Name> MCP Server`, where only the first character of the name is
  upper-cased.
- **Status line.** `connected` shows a tick and "connected". `disabled` shows an
  empty radio and "disabled". `pending` shows an empty radio and "connecting…".
  The remote menu shows `needs-auth` as a warning triangle and "needs
  authentication". Every other state shows a cross and "failed". The stdio menu
  also shows `needs-auth` as "failed".
- **Stdio details.** `Command: <command>`. Then `Args: <args joined by spaces>`,
  but only when there is at least one arg. Then `Config location:` with the
  file of the scope `getMcpConfigByName(name)` finds, or `Dynamically
  configured` when it finds none.
- **Remote details.** `Auth:` is a tick with "authenticated" when the server is
  *effectively signed in*: `isAuthenticated` is true, or the server is
  connected with at least one tool. Otherwise it is a cross with "not
  authenticated". There is no `Auth:` line for a claude.ai connector. Then
  `URL: <config.url>` and `Config location:` for the `scope` prop.
- **Config location labels.** user: the global config file. project:
  `<cwd>/.mcp.json`. local: `<global config file> [project: <cwd>]`. dynamic:
  `Dynamically configured`. enterprise: the managed `managed-mcp.json` path.
  claudeai: `claude.ai`.
- **What the server offers.** Only when connected: the `CapabilitiesSection`
  line, with the tool count from `serverToolsCount`. The prompt count is the
  server's MCP prompts in `mcp.commands` (MCP skills excluded). The resource
  count is `mcp.resources[name]`. Both are looked up by server name. Then
  `Tools: <n> tools` when connected with n > 0.
- **Footer.** `↑↓ to navigate · Enter to select · Esc to back`. After one
  Ctrl+C it reads `Press Ctrl-C again to exit`.

### Which actions the menus offer, in order

**Stdio:**
1. View tools, unless disabled, when `serverToolsCount > 0`. This includes a
   failed server whose count is still above 0.
2. Reconnect, unless disabled.
3. Disable, or Enable when disabled.

**Remote, SSE or HTTP:**
1. Enable, when disabled.
2. View tools, when connected with tools.
3. Re-authenticate and Clear authentication when effectively signed in;
   otherwise Authenticate. Offered in every state, disabled included.
4. Reconnect, unless disabled or `needs-auth`.
5. Disable, unless disabled.

**Remote, claude.ai connector:**
1. Enable, when disabled.
2. View tools, when connected with tools.
3. Clear authentication when connected. Authenticate when neither connected
   nor disabled.
4. Reconnect, unless disabled or `needs-auth`.
5. Disable, unless disabled.

Esc on a menu goes back.

### Shared actions (stdio and remote)

- **View tools.** Calls `onViewTools()`, nothing else.
- **Reconnect.** While the manager's `reconnectMcpServer(name)` runs, the menu
  gives way to a spinner. The stdio one reads `Reconnecting to <name>`,
  `Restarting MCP server process`, `This may take a few moments.`. The remote
  one reads `Connecting to <name>…`, `Establishing connection to MCP server`,
  `This may take a few moments.`. The result goes to `onComplete` through
  `handleReconnectResult`, and a throw through `handleReconnectError` (a
  server the manager does not list throws `MCP server <name> not found`). The
  menu comes back afterwards. A stdio reconnect restarts the child process.
- **Disable / Enable.** Calls the manager's `toggleMcpServer(name)`. That
  persists the switch in the project config (`isMcpServerDisabled`), takes the
  server offline or dials it, and then the menu goes back. On a throw:
  `Failed to <disable|enable> MCP server '<name>': <reason>`, with the
  direction taken from the state shown, and the menu stays.

### Remote sign-in (SSE, HTTP)

- **Authenticate.** Starts the MCP OAuth flow (`performMCPOAuthFlow`) for the
  server's config. The browser is opened on the authorization URL. The screen
  shows:
  - `Authenticating with <name>…` and a spinner with `A browser window will
    open for authentication`;
  - once the URL is known, `If your browser doesn't open automatically, copy
    this URL manually (c to copy)` and the URL;
  - while the flow waits for its callback, `If the redirect page shows a
    connection error, paste the URL from your browser's address bar:` and a
    `URL >` field. Enter submits the trimmed text to the flow;
  - `Return here after authenticating in your browser. Press Esc to go back.`
- **After the browser returns,** the tokens are stored under
  `getServerKey(name, config)`, and the manager redials the server. The
  outcome:
  - `connected`: `Authentication successful. Connected to <name>.`, or
    `… Reconnected to <name>.` when the server was effectively signed in
    before;
  - `needs-auth`: `Authentication successful, but server still requires
    authentication. You may need to manually restart Claudin.`;
  - otherwise: `Authentication successful, but server reconnection failed.
    You may need to manually restart Claudin for the changes to take effect.`
- **Errors.** If the flow or the redial throws, the menu comes back with
  `Error: <message>` under the details, and nothing is reported. A cancelled
  flow shows no error.
- **Re-authenticate.** Same as Authenticate, but the stored tokens are revoked
  first (see Security requirements). The step-up scope and the discovery state
  are kept, so the new authorization request asks for the same scope.
- **Clear authentication.** Revokes and forgets the server's tokens, then
  closes its cached connection. In app state, it removes the server's tools,
  prompts and resources and takes its client out of `connected`. Reports
  `Authentication cleared for <name>.`.
- **Copy.** While a URL is shown, `c` copies it and shows `(Copied!)` for 2 s.
  The copy is an OSC 52 sequence written to stdout, plus the native clipboard
  outside SSH. Another `c` while `(Copied!)` shows does nothing. With no URL on
  screen, `c` does nothing.

### claude.ai connector sign-in and sign-out

- **Authenticate.** Opens the browser and shows the URL with the copy hint,
  `Press Enter after authenticating in your browser.` and an Esc hint. The URL
  is
  `<CLAUDE_AI_ORIGIN>/api/organizations/<org>/mcp/start-auth/<id>?product_surface=<surface>`
  when the logged-in account has an organization UUID and the config has an
  `id`. Otherwise it is `<CLAUDE_AI_ORIGIN>/settings/connectors`.
  - A leading `mcprs` in the id becomes `mcpsrv`.
  - `<surface>` is `CLAUDE_CODE_ENTRYPOINT` URL-encoded, or `cli`.
- **Enter** redials the connector through the manager, with the remote
  connecting spinner. It reports the same three messages as the remote
  sign-in, and a throw through `handleReconnectError`. **Esc** goes back to the
  menu with no redial and no report.
- **Clear authentication** takes two Enters:
  1. The first screen reads `Clear authentication for <name>`, `This will open
     claude.ai in the browser. Find the MCP server in the list and click
     "Disconnect".` and `Press Enter to open the browser.`.
  2. Enter opens `<CLAUDE_AI_ORIGIN>/settings/connectors` and shows `Find the
     MCP server in the browser and click "Disconnect".`, the URL with
     `If your browser didn't open automatically, copy this URL manually (c to
     copy)`, and `Press Enter when done.`.
  3. The second Enter closes the cached connection and sets the client to
     `needs-auth`. It removes the connector's tools, prompts and resources and
     reports `Disconnected from <name>.`.
  - Esc at either step goes back to the menu, and the next time starts at
    step 1.
- No local credential is read or written by either action.

### Agent-only servers (`MCPAgentServerMenu`)

- **Dialog.** Titled `<Name> MCP Server` with the subtitle `agent-only`. It
  shows:
  - `Type: <transport>`, `URL:` when there is a url, `Command:` when there is a
    command, and `Used by: <agents joined by ", ">`;
  - `Status: ` with an empty radio and `not connected (agent-only)`;
  - when `needsAuth`, `Auth:` as a tick with "authenticated", or as a triangle
    with "may need authentication";
  - `This server connects only when running the agent.`;
  - the footer `↑↓ to navigate · Enter to confirm · Esc to go back`.
- **Options.** `Authenticate`, or `Re-authenticate` when `isAuthenticated`.
  Only when `needsAuth`. Then `Back`.
- **Back and Esc** go back.
- **Authenticate** runs the OAuth flow for `{ type: transport, url }`. The
  tokens are stored under that key. The screen is like the remote one, except:
  - there is no paste field;
  - the URL note ends with `manually:`;
  - the hint reads `Return here after authenticating in your browser. Esc to go back`.
- **The outcome.** Success reports `Authentication successful for <name>. The
  server will connect when the agent runs.`. A failure shows `Error: <message>`
  under the menu, and a cancel shows nothing. Nothing is revoked first.

### `MCPReconnect`

- **On mount,** it looks the server up in `mcp.clients`.
  - If it is absent, it shows the error view and reports `MCP server "<name>"
    not found`, without dialling.
  - Otherwise it calls `reconnectMcpServer(name)` once, showing `Reconnecting
    to <name>` and a spinner with `Establishing connection to MCP server`.
- **Outcomes:**

| Result | Reported | On screen afterwards |
|---|---|---|
| `connected` | `Successfully reconnected to <name>` | nothing |
| `needs-auth` | `<name> requires authentication. Use /mcp to authenticate.` | cross, `Failed to reconnect to <name>`, `Error: <name> requires authentication` |
| `failed` / `pending` / `disabled` | `Failed to reconnect to <name>` | cross, `Failed to reconnect to <name>`, `Error: Failed to reconnect to <name>` |
| thrown | `Error: <message>` | cross, `Failed to reconnect to <name>`, `Error: <message>` |

## Edge cases and errors

- **A server name** is shown as given in messages. Only the title capitalizes it.
- **A stdio config with no `args`** (or `[]`) has no Args line.
- **A server the manager does not list.**
  - Reconnect reports `Error reconnecting to <name>: MCP server <name> not found`.
  - Disable or Enable reports `Failed to … : MCP server <name> not found`.
  - After a remote sign-in, the error shows under the menu, though the tokens
    were stored.
- **The authorization server refuses the revocation** (Clear authentication):
  the local tokens are removed anyway and the success message is reported.
- **The authorization server denies the sign-in.** The error shows under the
  menu. The store keeps the client registration and discovery record the flow
  wrote, with no token.
- **Unmounting mid sign-in** (remote or agent menu) aborts the flow. Unmounting
  also stops a pending copy note from updating.

## Security requirements

- **Abort.** A sign-in in progress is aborted on Esc and on unmount. The
  loopback callback listener is then closed (nothing answers on the redirect
  URI), so it cannot outlive the screen.
- **Cancel.** A cancelled or refused sign-in stores no token and shows no
  cancellation error.
- **Re-authenticate (remote menu).** Before the new flow starts, the stored
  refresh token and then the access token are revoked at the authorization
  server's RFC 7009 endpoint. Locally, only the step-up scope and the
  discovery state remain. If the new sign-in is cancelled, the old tokens stay
  revoked.
- **Clear authentication (remote).** Revokes the refresh token, then the access
  token. It removes this server's token entry (tokens, step-up scope, client id)
  even when the revocation fails.
  - It keeps the configured client secret (`mcpOAuthClientConfig`) and every
    other server's entry.
  - It drops the server's tools, prompts and resources from the session.
- **claude.ai connectors.** The menu never touches local credentials. It only
  opens claude.ai pages through `openBrowser`, which accepts only http(s).
- **Agent servers.** Re-authenticate does not revoke (Findings, 9).

## Tests that pin it

Mounted on `terminal/__testutils__/fakeTerminal.ts`, inside a real
`MCPConnectionManager`, app state and key bindings. The rig is
`src/mcp/ui/__testutils__/serverMenuRig.tsx`, which builds on the prompt-frame
rig and the MCP auth and client test beds. Everything a menu talks to is real:
- stdio children and WebSocket and Streamable HTTP servers on loopback;
- the auth bed's authorization server, with an HTTP MCP server behind a gate
  that wants its tokens;
- a credential store in a temp config dir, behind a refusing vault stand-in;
- the bed's browser stand-in, which logs the URL.

Two seams are not the real thing:
- The OSC 52 write to stdout is captured.
- For claude.ai connectors, the manager dials a loopback server configured
  under the connector's name, since the claude.ai proxy cannot be reached.

- `src/mcp/ui/reconnectHelpers.characterization.test.ts`: both helpers (12).
- `src/mcp/ui/CapabilitiesSection.characterization.test.tsx`: the line, and an update on the same mount (10).
- `src/mcp/ui/MCPReconnect.characterization.test.tsx`: every outcome, the spinner, one dial per mount (6).
- `src/mcp/ui/MCPStdioServerMenu.characterization.test.tsx`: lines, states and options, config locations, frame, footer, every action (19).
- `src/mcp/ui/MCPRemoteServerMenu.characterization.test.tsx`: the option and status matrix (13 rows), lines, config locations, frame, reconnect, switch (27).
- `src/mcp/ui/MCPRemoteServerMenu.oauth.characterization.test.tsx`: sign-in, paste, outcomes, errors, cancel, unmount, copy, re-authenticate, clear authentication (13).
- `src/mcp/ui/MCPRemoteServerMenu.claudeai.characterization.test.tsx`: start-auth URLs (6 rows), redial outcomes, spinner, Esc, copy, the two-step sign-out (16).
- `src/mcp/ui/MCPAgentServerMenu.characterization.test.tsx`: dialog, options, back, sign-in, SSE key, no revocation, errors, cancel, unmount (14).

117 tests, 3 runs green in a row. Line coverage, measured on these suites
alone:
- `CapabilitiesSection` 100%, `reconnectHelpers` 100%, `MCPAgentServerMenu`
  99.3%.
- `MCPRemoteServerMenu` 98.9%. Uncovered: the unreachable `Back` option.
- `MCPStdioServerMenu` 95.8%. Uncovered: the unreachable `Back` option.
- `MCPReconnect` 89.5%. Uncovered:
  - the unreachable catch (Findings, 5);
  - the `pending` case label, which no reconnect returns;
  - the compiler's memo-cache branches.

Break-probe spec: `scripts/migrations/probes/rewrite-mcp-serverMenus.json`.
It has 40 probes over the six files. 12 of them make a safety path fail open:
- an abort skipped on Esc or unmount;
- a cancellation shown as an error;
- revocation skipped or the step-up state dropped;
- local tokens kept;
- the claude.ai sign-out clearing on the first Enter;
- a server's tools, prompts or resources kept after sign-out.

The unit sends no text to a model. No test outside the unit pins its text.

## Out of scope

- **Other units.** The OAuth flow, token storage and revocation are
  `mcp/auth`. Dialling, toggling and redialling are `mcp/connectionManager`.
  The config scopes and the toggle store are `mcp/config`.
- **The callers.** The `/mcp` list and navigation are `mcp/settingsUi`.
- **The `Back` option** of the stdio and remote menus. No state reaches it
  (Findings, 4), and the rewrite drops it.

## Findings

1. **Clear authentication leads to an automatic redial.** The menu closes the
   connection and marks the client `failed`. The manager reads the close as an
   unexpected drop and redials. The entry goes `pending`, then `needs-auth`. On
   the way it files a new dynamic client registration with the authorization
   server, with no action from the user (seen in the suite).
   - **Decision: fix.** Security-relevant: the server is contacted right after
     a sign-out. The rewrite takes the server offline for the session and
     shows it as `needs-auth`, with no redial.
   - **Not pinned.** The suite pins only "not connected" and "no token left".
2. **Re-authenticate revokes before it signs in.** A cancelled or failed
   re-authentication leaves the user signed out.
   - **Decision: keep for parity**, pinned. Security: re-authenticating
     explicitly gives up the old grant.
3. **Clear authentication keeps the client secret.**
   - **Decision: keep for parity**, pinned. The secret is configuration (set
     with `--client-secret`), not a session credential. A later sign-in needs
     it.
4. **The `Back` option of the stdio and remote menus is unreachable.** Every
   state offers Enable or Disable.
   - **Decision: fix** (drop it). Not pinned; those lines are uncovered.
5. **`MCPReconnect` handles a thrown reconnect, but none can happen.** The
   server is looked up in the same store the manager reads, and the manager
   returns `failed` instead of throwing.
   - **Decision: keep for parity.** Not reachable, so not pinned. Those lines
     are uncovered.
6. **`MCPReconnect` titles every non-success "Failed to reconnect to
   `<name>`".** That includes `needs-auth` and "not found".
   - **Decision: keep for parity**, pinned.
7. **The stdio menu shows `needs-auth` as "failed"**, and offers View tools on
   a failed server that still has a tool count.
   - **Decision: keep for parity**, pinned. The count is the caller's.
8. **The claude.ai start-auth URL puts the organization UUID and the connector
   id into the path unencoded.** Only the surface is encoded. Both values come
   from the claude.ai login and listing.
   - **Decision: fix** (encode each path segment). This is pure hardening,
     since real ids and UUIDs have no reserved characters. Not pinned: the
     suite uses plain ids.
9. **The agent menu's Re-authenticate revokes nothing,** unlike the remote
   menu, and offers no paste fallback.
   - **Decision: keep for parity**, pinned. Security: the old agent tokens
     stay valid at the server until they expire.
10. **`c` copies even while the paste field has text,** and the `c` also lands
    in the field. A paste arrives as one chunk and is not affected.
    - **Decision: keep for parity**, pinned. It is harmless.
11. **The claude.ai sign-out clears the session on the second Enter,** whether
    or not the user disconnected in the browser.
    - **Decision: keep for parity**, pinned.
12. **After a remote sign-in whose redial throws,** the menu shows the error
    as if the sign-in had failed, though the tokens are stored.
    - **Decision: keep for parity**, pinned.
13. **The remote menu offers sign-in actions on a disabled server.**
    - **Decision: keep for parity**, pinned.

**Not pinned:**
- That the claude.ai sign-out closes the connector's cached connection. The
  connection is keyed by the connector's proxy config, which needs the
  claude.ai proxy to exist.
- The `MCPReconnect` catch (5).
- The `Back` option (4).

## Target design

Under `src/mcp/ui/serverMenu/`, keeping the six public paths as re-exports
during the transition:

- **`menuOptions.ts`** (pure): `(server, toolsCount) => MenuAction[]`, with
  `MenuAction` a union (`'view-tools' | 'authenticate' | 'reauthenticate' |
  'clear-auth' | 'connector-auth' | 'connector-clear-auth' | 'reconnect' |
  'toggle'`). It holds the "effectively signed in" rule and the option tables
  above, with no `Back` (Findings, 4).
- **`messages.ts`** (pure): the reconnect verdicts (today's
  `reconnectHelpers`) and the sign-in outcome messages, in one table.
- **`useRemoteSignIn.ts`:** the OAuth flow as a state machine (`idle →
  waiting(url, submitPaste?) → reconnecting → done | error`). It owns the abort
  controller, aborts on Esc and on unmount, and exposes revoke-first
  re-authentication.
- **`useConnectorSignIn.ts`:** the claude.ai start-auth URL (with encoded path
  segments, Findings 8) and the two-step sign-out.
- **`dropServerFromSession.ts`:** removes one server's tools, prompts and
  resources from `mcp` and sets its client type. Both sign-out paths share it,
  and it marks the server session-disconnected so the manager does not redial
  (Findings, 1).
- **`useCopyUrl.ts`:** OSC 52 plus the native clipboard, and the 2 s note.
- **Components.** The menus become plain TSX over a shared
  `ServerMenuFrame`: the title, the optional border, the details slot, and a
  footer with the Ctrl+C state. `CapabilitiesSection` and `MCPReconnect` become
  plain TSX.
