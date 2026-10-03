# Spec: `sessions/remote`

The five modules of this unit are `src/sessions/hooks/useRemoteSession.ts`,
`src/sessions/hooks/useSSHSession.ts`, `src/sessions/hooks/useTeleportResume.tsx`,
`src/sessions/sessionIngressAuth.ts` and `src/sessions/sessionUrl.ts`.

## Purpose

The local side of sessions that run somewhere else:

- **A remote session.** The REPL shows a session that runs on Anthropic's
  servers (claude.ai "Claude Code on the web"). It subscribes to the session's
  event socket, turns what arrives into transcript messages, permission
  prompts and status, and posts what the user types.
- **An SSH session.** The same, for a CLI that runs on another machine over
  ssh. The ssh process and its auth proxy are made before the REPL mounts and
  handed in; this unit drives them.
- **Teleport resume.** The state behind the `--teleport` picker: fetch the
  chosen claude.ai session and its transcript, and mark the process as
  teleported.
- **Session-ingress auth.** Where a CLI running inside a remote container
  finds its session token, and how that token becomes request headers.
- **Resume identifiers.** What `-p --resume <value>` accepts: a session id, a
  transcript file, or a session-ingress URL.

The owner decided on 2026-10-02 that these stay in the product, including the
parts that need a claude.ai login or Anthropic's servers.

## Public contract

These keep their names, signatures and import paths: the modules not yet
rewritten import them.

### `hooks/useRemoteSession.ts`

| Export | Signature | Used by |
|---|---|---|
| `useRemoteSession` | `(props: { config: RemoteSessionConfig \| undefined; setMessages: Dispatch<SetStateAction<Message[]>>; setIsLoading: (loading: boolean) => void; onInit?: (slashCommands: string[]) => void; setToolUseConfirmQueue: Dispatch<SetStateAction<ToolUseConfirm[]>>; tools: Tool[]; setStreamingToolUses?: Dispatch<SetStateAction<StreamingToolUse[]>>; setStreamMode?: Dispatch<SetStateAction<SpinnerMode>>; setInProgressToolUseIDs?: (f: (prev: Set<string>) => Set<string>) => void }) => { isRemoteMode: boolean; sendMessage: (content: RemoteMessageContent, opts?: { uuid?: string }) => Promise<boolean>; cancelRequest: () => void; disconnect: () => void }` | `src/agent/repl/REPL.tsx`; its return type in `src/agent/repl/controllers/useOnSubmit.ts`; replaced in `src/agent/repl/__testutils__/replTestHarness.ts` |

`RemoteSessionConfig` (`src/platform/remote/RemoteSessionManager.ts`) is
`{ sessionId: string; getAccessToken: () => string; orgUuid: string; hasInitialPrompt?: boolean; viewerOnly?: boolean }`.
`RemoteMessageContent` (`src/platform/teleport/api.ts`) is a string or an array
of content blocks.

### `hooks/useSSHSession.ts`

| Export | Signature | Used by |
|---|---|---|
| `useSSHSession` | `(props: { session: SSHSession \| undefined; setMessages; setIsLoading; setToolUseConfirmQueue; tools: Tool[] }) => { isRemoteMode: boolean; sendMessage: (content: RemoteMessageContent) => Promise<boolean>; cancelRequest: () => void; disconnect: () => void }`, the setters typed as in `useRemoteSession` | `REPL.tsx`; its return type in `useOnSubmit.ts`; replaced in `replTestHarness.ts` |

`SSHSession` comes from `src/platform/ssh/createSSHSession`, a module this fork
does not carry (a `.d.ts` only, every export `any`). What the hook uses of it
is the contract:

- `createManager(callbacks)` returns a manager with `connect()`,
  `disconnect()`, `sendMessage(content): Promise<boolean>`, `sendInterrupt()`
  and `respondToPermissionRequest(requestId, answer)`;
- the callbacks are `onMessage(sdkMessage)`,
  `onPermissionRequest(request, requestId)`, `onConnected()`,
  `onReconnecting(attempt, max)`, `onDisconnected()` and `onError(error)`;
- `getStderrTail(): string`, `proc.exitCode`, `proc.signalCode` and
  `proxy.stop()`.

### `hooks/useTeleportResume.tsx`

| Export | Signature | Used by |
|---|---|---|
| `useTeleportResume` | `(source: TeleportSource) => { resumeSession: (session: CodeSession) => Promise<TeleportRemoteResponse \| null>; isResuming: boolean; error: { message: string; formattedMessage: string \| undefined; isOperationError: boolean } \| null; selectedSession: CodeSession \| null; clearError: () => void }` | `src/platform/teleport/TeleportResumeWrapper.tsx` |
| `TeleportSource` (type) | `'cliArg' \| 'localCommand'` | `TeleportResumeWrapper.tsx` |

### `sessionIngressAuth.ts`

| Export | Signature | Used by |
|---|---|---|
| `getSessionIngressAuthToken` | `() => string \| null` | `src/mcp/client/transport.ts`, `src/mcp/ui/MCPSettings.tsx`, `src/platform/main/action/parseOptions.ts`, `src/platform/headless/remoteIO.ts`, `src/platform/headless/transports/HybridTransport.ts`, `src/platform/headless/transports/ccrClient.ts`, `src/providers/transport/sessionIngress.ts` |
| `getSessionIngressAuthHeaders` | `() => Record<string, string>` | `src/platform/headless/transports/SSETransport.ts`, `ccrClient.ts` |
| `updateSessionIngressAuthToken` | `(token: string) => void` | `src/platform/bridge/replBridge.ts`, `src/platform/bridge/replBridgeTransport.ts` |

### `sessionUrl.ts`

| Export | Signature | Used by |
|---|---|---|
| `parseSessionIdentifier` | `(resumeIdentifier: string) => ParsedSessionUrl \| null` | `src/platform/headless/print/sessionLoad.ts` |
| `ParsedSessionUrl` (type) | `{ sessionId: UUID; ingressUrl: string \| null; isUrl: boolean; jsonlFile: string \| null; isJsonlFile: boolean }` | (through `parseSessionIdentifier`) |

## Observable behaviour

### 1. The remote session: connection

- **Outside remote mode** (`config` undefined): `isRemoteMode` is false,
  nothing connects, `sendMessage` resolves `false` without a request,
  `cancelRequest` only calls `setIsLoading(false)`, and `disconnect` does
  nothing.
- **In remote mode** `isRemoteMode` is true and the hook opens the session's
  event socket at mount. The handshake is pinned byte for byte in
  `src/sessions/__fixtures__/rewrite/remote/subscribe.json`:
  - `GET <API base>/v1/sessions/ws/<sessionId>/subscribe?organization_uuid=<orgUuid>`,
    the API base being the claude.ai OAuth `BASE_API_URL` with `https://`
    turned into `wss://`;
  - `Authorization: Bearer <config.getAccessToken()>`, called for each
    connection attempt;
  - `anthropic-version: 2023-06-01`.
- **Connection status** goes to app state as `remoteConnectionStatus`:
  `'connected'` when the socket opens, `'reconnecting'` on a transient drop,
  `'disconnected'` when the server ends the session (close code 4003) or the
  retries run out. A drop is retried after about two seconds.
- **On a drop or an end** the remote background task count goes to 0, and the
  in-flight tool use ids are emptied (the same `Set` is kept when it was
  already empty). An end also calls `setIsLoading(false)`.
- **A new `config` object** closes the old subscription and opens one for the
  new config. **Unmounting** and **`disconnect()`** close the socket; after
  `disconnect()`, `sendMessage` resolves `false` and `cancelRequest` sends
  nothing.
- **The result object keeps its identity** across renders with the same
  props. The REPL's submit callback depends on it.

### 2. The remote session: frames from the session

Every frame is JSON with a string `type`. A frame that is not JSON is dropped.

| Frame | What the REPL sees |
|---|---|
| `assistant` | Appended to the transcript. Its `tool_use` ids are added to the in-flight set, and the streaming tool uses are emptied (left alone when already empty). Loading is not touched. |
| `user` with a `tool_result` block | Each result's `tool_use_id` leaves the in-flight set (the same `Set` comes back when none was in it). Not shown, except to a viewer. |
| `user`, typed text | Not shown (the REPL added it locally), except to a viewer. |
| `result` | `setIsLoading(false)`, and the compaction state ends. Shown only when not `success`: a warning-level system message whose text is the `errors` joined by `, `. |
| `system`/`init` | `onInit(slash_commands)` when given. Shown as an info message naming the model. |
| `system`/`task_started`, `task_notification` | Add or remove the `task_id` in the set of tasks running remotely; app state `remoteBackgroundTaskCount` is its size. Not shown. |
| `system`/`task_progress` | Ignored. |
| `system`/`status` | `status: 'compacting'` starts a compaction and is shown once; repeated `compacting` ticks are not shown again. A `null` status ends it and is not shown. |
| `system`/`compact_boundary` | Ends the compaction; shown as a `compact_boundary` system message carrying `{ trigger, preTokens }`. |
| `tool_progress` | Shown as an info message carrying the `toolUseID`. |
| `stream_event` | Drives `setStreamMode` and `setStreamingToolUses` the way a local stream does (a tool-use block start adds a streaming tool use, input deltas extend it, `message_stop` empties the list). Dropped when either setter is missing. |
| `control_request` / `can_use_tool` | A permission prompt, section 3. |
| `control_cancel_request` | Section 3. |
| other types, other `system` subtypes, `control_response` | Ignored. |

**A viewer** (`config.viewerOnly`) also shows typed user messages and tool
results, since no local REPL added them.

### 3. Permission prompts (remote and SSH alike)

- **A `can_use_tool` request** appends one `ToolUseConfirm` to the queue and
  calls `setIsLoading(false)`:
  - `tool`: the local tool of that name from the latest `tools` prop, or a
    stand-in whose `name` and `userFacingName()` are the requested name;
  - `description` and `permissionResult.message`: the request's
    `description`, or `<tool_name> requires permission`;
  - `permissionResult`: `{ behavior: 'ask', message, suggestions: permission_suggestions, blockedPath: blocked_path }`;
  - `input`, and `toolUseID` = `tool_use_id`;
  - `assistantMessage`: an assistant message whose only content block is
    `{ type: 'tool_use', id: tool_use_id, name: tool_name, input }`;
  - `permissionPromptStartTimeMs`: the time the prompt was queued.
- **The answers** remove that prompt (by tool use id) from the queue and send
  one reply for its request id:

  | Answer | Reply | Loading after |
  |---|---|---|
  | `onAllow(updatedInput)` | `allow`, `updatedInput` | `true` |
  | `onReject(feedback)` | `deny`, message = the feedback | unchanged |
  | `onReject()` | `deny`, `User denied permission` | unchanged |
  | `onAbort()` | `deny`, `User aborted` | unchanged |

  On the remote socket the reply is a `control_response` with
  `subtype: 'success'`; the four forms are pinned byte for byte in
  `__fixtures__/rewrite/remote/permission-*.json`. Over SSH it is handed to
  the manager's `respondToPermissionRequest(requestId, answer)`.
- `onUserInteraction()` and `recheckPermission()` do nothing.
- **A cancel from the session** (remote only) removes the prompt whose tool
  use id is the cancelled request's, or, for a request it never saw, the
  prompt whose tool use id equals the request id; then
  `setIsLoading(true)`.
- **Another control request subtype** is not queued.

### 4. The remote session: sending

- **`sendMessage(content, { uuid })`** calls `setIsLoading(true)`, then posts
  one user event (pinned in `send-event.json`, headers in
  `send-event.headers.json`):
  - `POST <API base>/v1/sessions/<sessionId>/events`, body
    `{ events: [{ uuid, session_id, type: 'user', parent_tool_use_id: null, message: { role: 'user', content } }] }`,
    with a fresh UUID when none is given and the content posted as it is;
  - headers `Authorization: Bearer <access token of the stored claude.ai login>`,
    `Content-Type: application/json`, `anthropic-version: 2023-06-01`,
    `anthropic-beta: ccr-byoc-2025-07-29`, and `x-organization-uuid` from the
    login's organization in the global config.
- **The answer**: 200 and 201 resolve `true`. Anything else, a network error,
  or no claude.ai login resolves `false` and calls `setIsLoading(false)`.
- **The title.** After the first send that gets through, in a session with
  neither `hasInitialPrompt` nor `viewerOnly`, the session is renamed once:
  - the small fast model is asked for a title, from the text of the message
    (a string as it is; for blocks, the text blocks joined by one space);
  - its title is sent as `PATCH <API base>/v1/sessions/<sessionId>` with body
    `{ title }` (pinned in `title.json`) and the headers of a send;
  - when the reply holds no title, the title is the message text cut to 75
    columns, an ellipsis included.
  - A failed send does not use up the rename: the next one that gets through
    does it.
- **The echo filter.** The uuid given to `sendMessage` is remembered before
  the post, even when the post then fails. Every later `user` frame with a
  remembered uuid is dropped, however many times it comes. The last 50 uuids
  are remembered.

### 5. The remote session: the watchdog

- After a send that gets through, outside viewer mode, the hook waits for any
  frame from the session: one minute, or three minutes while the session is
  compacting.
- **Any `onMessage` frame** stands it down, the echo of our own message
  included. A permission request does not.
- **When it runs out**, a warning-level system message saying the session may
  be unresponsive and that it is reconnecting is appended, and the socket is
  closed and opened again about half a second later.
- **A new send** restarts the wait. **`cancelRequest`**, **`disconnect`** and
  **unmounting** stop it. A failed send does not start it.

### 6. The remote session: interrupting

`cancelRequest()` calls `setIsLoading(false)` and sends
`{ type: 'control_request', request_id: <fresh UUID>, request: { subtype: 'interrupt' } }`
on the socket (`interrupt.json`). A viewer never sends it.

### 7. The SSH session

- **Without a session** the hook behaves as the remote one outside remote
  mode.
- **With one**, it makes one manager at mount and connects it. Unmounting
  disconnects the manager and stops the auth proxy; a new session object does
  the same to the old one and starts the new one. `disconnect()` disconnects
  the manager only.
- **Frames** go through the same conversion as a remote viewer's tool results:
  assistant messages and `tool_result` user messages are shown, typed user
  messages are not, a `result` ends loading and only a failing one is shown.
  The first `init` of a session is shown and later ones (one per turn) are
  not.
- `sendMessage(content)` calls `setIsLoading(true)` and resolves what the
  manager's `sendMessage` resolves. `cancelRequest()` calls the manager's
  `sendInterrupt()` and `setIsLoading(false)`. After `disconnect()` neither
  reaches the manager, and `sendMessage` resolves `false`.
- **`onReconnecting(attempt, max)`** calls `setIsLoading(false)` and appends an
  `informational` system message at `warning` level, with a fresh uuid and
  timestamp, saying the SSH connection dropped and naming `<attempt>/<max>`.
- **`onDisconnected()`** calls `setIsLoading(false)` and ends the CLI through
  `gracefulShutdown(1, 'other', { finalMessage })`:
  - after `onConnected`, the message says the remote session ended; before it,
    that the SSH session failed before connecting;
  - the remote stderr tail, trimmed, follows on its own lines with
    `exit <code>` (or `signal <name>` when there is no exit code), whenever it
    is not blank and the session never connected or exited non-zero.
- `onError` shows nothing.

### 8. Teleport resume

- Before a pick: `isResuming` false, `error` null, `selectedSession` null.
- **`resumeSession(session)`** sets `isResuming`, clears `error` and sets
  `selectedSession` in one render, then resumes the session by its id (the
  teleport module: policy check, claude.ai login, session fetch, repository
  check, transcript fetch).
  - **On success** it resolves the teleport result (`log`: the non-sidechain
    transcript messages; `branch`: the session's first outcome branch), marks
    the process teleported with that session id, and clears `isResuming`.
  - **On failure** it resolves `null`, clears `isResuming`, keeps
    `selectedSession`, and sets `error`. For a teleport operation error,
    `message` and `formattedMessage` are the error's and `isOperationError` is
    true; for any other error (the organization policy forbidding remote
    sessions, for one), `message` is the error's message, `formattedMessage`
    is undefined and `isOperationError` false. The process is not marked.
- `clearError()` sets `error` to null and leaves the rest.
- The result object keeps its identity across renders with the same source;
  `resumeSession` is a new function when `source` changes, `clearError` never
  is.

### 9. Session-ingress auth

- **`getSessionIngressAuthToken()`** returns, in this order:
  1. `CLAUDE_CODE_SESSION_ACCESS_TOKEN` when it is set and non-empty, read on
     every call;
  2. when `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` is set: the trimmed
     content of that open descriptor. A value that is not a number, or a
     descriptor that holds only whitespace, gives `null` without looking at
     the file. A descriptor that cannot be read falls back to the file;
  3. otherwise the trimmed content of the file named by
     `CLAUDE_SESSION_INGRESS_TOKEN_FILE`, or of
     `/home/claude/.claude/remote/.session_ingress_token`. Missing, blank or
     unreadable gives `null`.
- **What steps 2 and 3 gave, `null` included, is kept for the life of the
  process**: a descriptor is read once, and a file that changes or appears
  later is not read again. The variable of step 1 still wins whenever it is
  set.
- **Inside CCR** (`CLAUDE_CODE_REMOTE` truthy), a token read from the
  descriptor is also written to the well-known path above, owner-only, so
  subprocesses that cannot inherit the descriptor find it.
- **`getSessionIngressAuthHeaders()`**: no token gives `{}`. A token starting
  with `sk-ant-sid` gives `{ Cookie: 'sessionKey=<token>' }`, plus
  `X-Organization-Uuid` from `CLAUDE_CODE_ORGANIZATION_UUID` when that is set
  and non-empty. Any other token gives `{ Authorization: 'Bearer <token>' }`.
- **`updateSessionIngressAuthToken(token)`** sets
  `CLAUDE_CODE_SESSION_ACCESS_TOKEN` in this process, so the new token wins
  from then on.

### 10. Resume identifiers: `parseSessionIdentifier`

| Input | Result |
|---|---|
| ends in `.jsonl`, any case (checked first, so a Windows path or a URL ending in `.jsonl` is a file) | `isJsonlFile: true`, `jsonlFile` the input as given, a fresh random v4 `sessionId`, `isUrl: false`, `ingressUrl: null` |
| a UUID (8-4-4-4-12 hex digits, any case, nothing around it) | `sessionId` the input, every other field null or false |
| anything the WHATWG URL parser accepts | `isUrl: true`, `ingressUrl` the normalized `href`, a fresh random `sessionId` (never the id in the URL) |
| anything else, the empty string included | `null` |

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A frame that is not JSON on the remote socket | Dropped; later frames still arrive |
| A `task_notification` for a task never started | The count does not change |
| A `tool_result` for an id not in flight | The in-flight `Set` keeps its identity |
| The remote server closes with 4003 | `'disconnected'`, no retry |
| A transient close (any other code) after connecting | `'reconnecting'`, then a new subscription |
| `sendMessage` without a claude.ai login | `false`, no request, loading off |
| A title reply that is not JSON or has no title | The message text, cut to 75 columns |
| A first message with no text blocks | No rename, ever, for that session. Not pinned (Findings) |
| An SSH send the manager refuses | Resolves `false`; loading stays on. Not pinned (Findings) |
| An SSH session that connected, dropped, then gave up | Reported as having failed before connecting. Not pinned (Findings) |
| `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` not a number | `null`, the token file is not consulted |
| A descriptor number that is not open | The token file |
| The token path is a directory | `null` |
| `run.jsonl.bak`, `/tmp/run.json`, `session_01abc`, a UUID with a space before it, `https://` | `null` |
| `foo:bar`, `C:\x\file.txt` | Accepted as an ingress URL. Not pinned (Findings) |

## Security requirements

**Pinned by the tests:**
- **The socket carries the session's own token,** fetched for each attempt
  from the config, as a bearer header; never in the URL. Only the
  organization id is in the query.
- **The HTTP calls carry the claude.ai login** of the stored credentials and
  go to the claude.ai API base only.
- **A session key is sent as a cookie, any other token as a bearer token,**
  and the organization header is added only for a session key.
- **A non-numeric descriptor variable never falls back to a file.**
- **A viewer never interrupts the remote agent.**

**Kept, but not pinned:**
- **The token copy written inside CCR is owner-only** (0600, in a 0700
  directory), and only inside CCR. Outside it nothing is written: the
  descriptor exists to keep the token off disk. A test cannot create
  `/home/claude`.
- **No token reaches a log.** The debug log names the descriptor number and
  the file path, never the token.

## Tests that pin it

- **The suites.** 163 tests in six files, green in 3 runs in a row. Line
  coverage of the old modules: 99.7% for `useRemoteSession.ts`, 100% for
  `useSSHSession.ts`, `useTeleportResume.tsx`, `sessionIngressAuth.ts` and
  `sessionUrl.ts`.

  | Suite | What it pins |
  |---|---|
  | `src/sessions/hooks/useRemoteSession.characterization.test.tsx` | sections 1, 2 and 3 |
  | `src/sessions/hooks/useRemoteSession.sending.characterization.test.tsx` | sections 4, 5 and 6 |
  | `src/sessions/hooks/useSSHSession.characterization.test.tsx` | sections 3 and 7 |
  | `src/sessions/hooks/useTeleportResume.characterization.test.tsx` | section 8 |
  | `src/sessions/sessionIngressAuth.characterization.test.ts` | section 9 |
  | `src/sessions/sessionUrl.characterization.test.ts` | section 10 |

- **The harnesses** are in `src/sessions/__testutils__/`:
  - `remoteRig.tsx`: the fake sessions API (`Bun.serve` on an ephemeral port,
    speaking both the subscribe socket and HTTP), the scratch environment
    (temp `CLAUDIN_CONFIG_DIR`, proxies off, git isolated), `signIn` (a
    plaintext `.credentials.json` and the organization in the global config),
    and a hook host on `src/terminal/__testutils__/fakeTerminal.ts`;
  - `remoteSessionHost.tsx`: mounts `useRemoteSession` with every setter
    recorded under an `AppStateProvider`, and builds SDK frames.
- **The fixtures** are in `src/sessions/__fixtures__/rewrite/remote/`: the
  subscribe handshake, the posted event and its headers, the title body, the
  interrupt and the four permission replies.
- **How the tests reach the runtime inputs.** The rewrite has to respect
  these:
  - **The API base** is read through `getOauthConfig().BASE_API_URL` of
    `src/shared/constants/oauth.ts` at call time: the rig replaces that
    module with one whose base is the local server. The socket URL is the
    base with `https://` turned into `wss://`, so an `http://` base stays as
    it is.
  - **The login** is read through the claude.ai OAuth token store and the
    global config's `oauthAccount.organizationUuid`, after
    `clearOAuthTokenCache()`.
  - **The title model** is `queryHaiku` of `src/providers/shims/claude.ts`,
    replaced with `mock.module`, so the title must go through
    `generateSessionTitle`.
  - **Process exit** is `gracefulShutdown` of
    `src/shared/proc/gracefulShutdown.ts`, replaced with `mock.module`.
  - **The SSH session** is a scripted stand-in passed as the `session` prop.
  - **Time.** The one-minute and three-minute waits run on Bun's fake timers,
    so they must be scheduled with the global `setTimeout`. Bun's fake clock
    freezes every sleep, so the suite waits on it by HTTP round trips to the
    fake server. The two-second socket retry runs on the real clock.
  - **Policy** is a `policy-limits.json` cache in the config dir, with
    nonessential traffic enabled and a Team login, after
    `_resetPolicyLimitsForTesting()`.
  - **The token cache** of section 9 lives in bootstrap state and is cleared by
    `resetStateForTests()`.
- **The probes.** `scripts/migrations/probes/rewrite-sessions-remote.json`
  has 40 probes: 18 on `useRemoteSession.ts`, 8 on `useSSHSession.ts`, 6 on
  `sessionIngressAuth.ts`, 4 each on `sessionUrl.ts` and
  `useTeleportResume.tsx`. Every one turns the suites red.
- **No inherited tests** covered the unit, so none was deleted.
- **Files outside the unit that pin its prompt text byte for byte:** none.
  The unit sends no prompt of its own; the title prompt belongs to
  `sessions/lifecycle`.
- **Not pinned, and why:**
  - **The CCR token copy** (`CLAUDE_CODE_REMOTE`): it writes under
    `/home/claude`, outside any temp directory.
  - **macOS and FreeBSD** read the descriptor through `/dev/fd`: the platform
    is fixed per process.
  - **The exact wording** of the watchdog warning, the SSH messages and the
    teleport errors: the tests pin the facts in them (attempt counts, exit
    codes, stderr, the session and repository names), not the sentences.
  - **The debug log lines.**
  - **The rows marked "Not pinned" above.**

## Out of scope

- **The teleport flow itself** (policy check, repository validation,
  transcript fetch) belongs to `src/platform/teleport/`. The suite drives it
  only as far as the hook's success and error shapes need.
- **The socket's retry rules** (close codes, back-off, ping) belong to
  `src/platform/remote/SessionsWebSocket.ts`; the suite pins only what reaches
  the REPL.
- **The names of the upstream variables** `CLAUDE_CODE_SESSION_ACCESS_TOKEN`,
  `CLAUDE_SESSION_INGRESS_TOKEN_FILE`, `CLAUDE_CODE_ORGANIZATION_UUID`,
  `CLAUDE_CODE_REMOTE` (bucket D) and
  `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` (bucket C) stay as they are.
  `scripts/migrations/env-rename-map.json` classifies them.

## Findings

The old modules had each of these. None is fixed in the characterization: the
suite passes on the old code. What a "fix" would change is left unpinned.

1. **`useRemoteSession` and `useSSHSession` never run in remote mode in this
   build.** `REPL.tsx` takes `remoteSessionConfig` and `sshSession` props,
   but no launcher passes either, and the SSH session module is absent from
   the fork. Both hooks only ever take their "not remote" path.
   **Decision: keep for parity**, per the owner's 2026-10-02 decision. Track:
   either restore an entry point (`--remote` attach, `ssh`) or move both to
   the dead-code cut.
2. **An SSH session that connected and then dropped is reported as having
   failed before connecting** when it gives up, and so is one the user
   disconnected: a drop counts as never having connected. **Decision:
   fix.** Report the end against whether the session ever connected. Only the
   final message changes.
3. **An SSH send the manager refuses leaves loading on.** The remote hook turns
   it off. **Decision: fix.** No caller relies on a stuck spinner.
4. **A first remote message without text uses up the rename.** An image-only
   first message asks for no title and the session never gets one.
   **Decision: fix.** Mark the rename as done only when a title request is
   made.
5. **The remote socket and the remote HTTP calls authenticate from different
   sources:** the socket from `config.getAccessToken` and `config.orgUuid`,
   the posts and the rename from the stored claude.ai login and the global
   config's organization. A caller that builds the config from another login
   would subscribe as one account and post as another. **Decision: keep for
   parity.** No caller exists today (finding 1); track making the config the
   only source.
6. **`parseSessionIdentifier` accepts any URL scheme.** `foo:bar` or a
   Windows path not ending in `.jsonl` is taken as an ingress URL, so
   `-p --resume foo:bar` starts an empty session instead of reporting an
   invalid id. **Decision: fix.** Accept `http:` and `https:` only; nothing
   can depend on resuming `foo:bar`.
7. **The ingress token found on disk is cached for the process, `null`
   included.** A token file written or rotated after the first read is never
   seen. **Decision: keep for parity.** The descriptor can be read only once,
   and in-process rotation goes through `updateSessionIngressAuthToken`.
8. **The CCR token copy always goes to the fixed well-known path,** even when
   `CLAUDE_SESSION_INGRESS_TOKEN_FILE` points elsewhere for reading.
   **Decision: keep for parity.** CCR's environment manager owns that layout.
9. **The remote session needs modules the levers plan lists for the cut:** it
   imports from `src/platform/bridge/`, `src/platform/remote/` and
   `src/platform/teleport/`. **Decision: track.** The rewrite owns its bounded
   id set (Target design), and the cut has to keep the remote client and the
   teleport API while these hooks stay.

## Target design

- **Slice layout.** The hooks stay in `src/sessions/hooks/`, the two pure
  modules in `src/sessions/`. A `src/sessions/remote/` folder holds what the
  hooks share:
  - **the frame reducer:** a pure function from a frame and the current view
    state (in-flight ids, running tasks, compaction, seen init) to the
    effects (messages to append, loading, counts), used by both hooks;
  - **the permission prompt builder:** from a permission request, the tool
    list and a reply sink to a `ToolUseConfirm`, so the remote and SSH hooks
    stop duplicating it;
  - **a bounded recent-id set** of its own, instead of the bridge's;
  - **the watchdog:** a small timer object with `arm(ms)`, `disarm()` and an
    expiry callback, scheduled with the global `setTimeout`.
- **One transport interface** for both hooks: `connect`, `disconnect`,
  `send(content, uuid?)`, `interrupt`, `answer(requestId, reply)`, and the
  callbacks of section 3 and 7. The remote session and the SSH session each
  adapt to it; the hooks hold no transport details.
- **The rename** is a separate step after a successful send, with the
  "already named" flag set only when a title request is made (finding 4).
- **`sessionIngressAuth`** reuses the descriptor-or-file reader of
  `src/providers/auth/authFileDescriptor.ts`, which already implements steps 2
  and 3 for the OAuth token and the API key, instead of carrying its own copy.
- **`parseSessionIdentifier`** returns a discriminated union internally
  (`file`, `id`, `url`) and maps it to `ParsedSessionUrl` for the caller;
  `url` only for `http:`/`https:` (finding 6).
- **Types to make explicit:** the SSH session contract of the Public contract
  section, as a type in this slice rather than the absent module's `any`; the
  teleport error shape; the permission reply.
