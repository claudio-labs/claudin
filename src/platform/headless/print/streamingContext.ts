// The explicit dependency surface for the headless streaming host, extracted
// from `src/platform/headless/print/runHeadless.ts` as the deferred half of ROADMAP 11b.
//
// WHY THIS EXISTS
// ---------------
// `runHeadlessStreaming` used to be one ~3.2k-line closure: the turn loop, the
// MCP runtime and the stdin control-request dispatcher all read and WROTE the
// same lexical `let` bindings (`sdkClients`, `dynamicMcpState`,
// `abortController`, `readFileState`, …). Splitting those units into modules
// means the shared bindings can no longer be lexical, so they live here.
//
// THE MECHANISM — one mutable object, plain properties
// ----------------------------------------------------
// `HeadlessStreamingContext` is a SINGLE object created once per streaming
// session and passed by reference to every extracted unit. Reassignable state
// is a plain mutable property (`ctx.sdkClients = …`), not a value parameter and
// not a getter/setter pair. That is deliberate:
//
//   * A plain property preserves the original aliasing EXACTLY. Every holder
//     dereferences the same object, so a write in `applyMcpServerChanges` is
//     visible to `buildAllTools` on its next read — which is precisely what the
//     lexical `let` did. Passing `sdkClients` as a value parameter would have
//     frozen a snapshot and silently broken late-connecting MCP servers.
//   * Getters/setters would buy nothing here (no validation, no notification)
//     while hiding that these are ordinary reads and writes.
//
// INVARIANT: never destructure mutable fields off this object.
// `const { sdkClients } = ctx` re-introduces exactly the snapshot bug the
// object was created to avoid. Read `ctx.sdkClients` at the point of use.
// Destructuring the readonly deps (`const { output, setAppState } = ctx`) is
// fine — those are never reassigned.
//
// INVARIANT: the function fields are wired AFTER construction.
// The units are mutually recursive (`run` → `updateSdkMcp`; `applyPluginMcpDiff`
// → `applyMcpServerChanges`; the control loop → nearly everything), so they are
// attached as thunks that dereference `ctx` lazily. See `runHeadlessStreaming.ts`.

import type { StructuredIO } from 'src/platform/headless/structuredIO.js'
import type { Stream } from 'src/shared/stream.js'
import type { Command } from 'src/commands.js'
import type { Tools } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import type { ReplBridgeHandle } from 'src/platform/bridge/replBridge.js'
import type { OAuthService } from 'src/services/oauth/index.js'
import type { PromptVariant } from 'src/terminal/prompt-suggestion/promptSuggestion.js'
import type { UUID } from 'crypto'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
} from 'src/services/mcp/types.js'
import type {
  SDKStatus,
  ModelInfo,
  McpServerConfigForProcessTransport,
  McpServerStatus,
} from 'src/platform/entrypoints/agentSdkTypes.js'
import type {
  StdoutMessage,
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlMcpSetServersResponse,
} from 'src/platform/entrypoints/sdk/controlTypes.js'
import type { DynamicMcpState } from 'src/platform/headless/print/mcpReconcile.js'
import type { createIdleTimeoutManager } from 'src/platform/idleTimeout.js'

/**
 * The `options` bag `runHeadlessStreaming` receives. Note that two fields are
 * MUTATED in place by control requests — `thinkingConfig` by
 * `set_max_thinking_tokens` and by the bridge's `onSetMaxThinkingTokens` — so
 * the object identity must be shared, never spread into a copy.
 */
export type HeadlessStreamingOptions = {
  verbose: boolean | undefined
  jsonSchema: Record<string, unknown> | undefined
  permissionPromptToolName: string | undefined
  allowedTools: string[] | undefined
  thinkingConfig: ThinkingConfig | undefined
  maxTurns: number | undefined
  maxBudgetUsd: number | undefined
  taskBudget: { total: number } | undefined
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  userSpecifiedModel: string | undefined
  fallbackModel: string | undefined
  replayUserMessages?: boolean | undefined
  includePartialMessages?: boolean | undefined
  enableAuthStatus?: boolean | undefined
  agent?: string | undefined
  setSDKStatus?: (status: SDKStatus) => void
  promptSuggestions?: boolean | undefined
}

/**
 * Push-model prompt-suggestion bookkeeping. Mutated by the turn loop (generates
 * and emits) and by the control loop (`interrupt`/`end_session` abort it), so
 * the object identity is shared rather than copied.
 */
export type SuggestionState = {
  abortController: AbortController | null
  inflightPromise: Promise<void> | null
  lastEmitted: {
    text: string
    emittedAt: number
    promptId: PromptVariant
    generationRequestId: string | null
  } | null
  pendingSuggestion: {
    type: 'prompt_suggestion'
    suggestion: string
    uuid: UUID
    session_id: string
  } | null
  pendingLastEmittedEntry: {
    text: string
    promptId: PromptVariant
    generationRequestId: string | null
  } | null
}

/** Coarse phase label dumped by the SIGTERM cleanup hook for healthsweeps. */
export type RunPhase =
  | 'draining_commands'
  | 'waiting_for_agents'
  | 'finally_flush'
  | 'finally_post_flush'
  | undefined

export type McpSetServersOutcome = {
  response: SDKControlMcpSetServersResponse
  sdkServersChanged: boolean
}

/**
 * A control-request envelope carrying an explicitly described `request` body.
 *
 * Deliberately NOT `Extract<SDKControlRequestInner, {subtype: S}>`: several
 * subtypes this driver handles at runtime — `mcp_authenticate`,
 * `mcp_oauth_callback_url`, `mcp_clear_auth`, `claude_authenticate`,
 * `claude_oauth_callback`, `generate_session_title`, `side_question`,
 * `remote_control`, `end_session`, `channel_enable` — are absent from the zod
 * schema behind `SDKControlRequestInner`. Deriving handler parameters from that
 * union resolves them to `never` and every field access becomes an error. That
 * schema gap is pre-existing and out of scope here, so each handler states the
 * fields it reads and the dispatcher widens through `unknown` at the call site.
 */
export type ControlRequestWith<R extends { subtype: string }> = Omit<
  SDKControlRequest,
  'request'
> & { request: R }

export type HeadlessStreamingContext = {
  // ---------------------------------------------------------------- deps ---
  // Stable for the life of the session. Safe to destructure.
  readonly structuredIO: StructuredIO
  /** Same queue `sendRequest()` enqueues to — one FIFO for everything. */
  readonly output: Stream<StdoutMessage>
  /** The MCP clients passed in at construction (NOT the live appState list). */
  readonly initialMcpClients: MCPServerConnection[]
  /** The base tool pool, before SDK/dynamic MCP tools are merged in. */
  readonly baseTools: Tools
  /** The commands passed in at construction; hot-reload writes `currentCommands`. */
  readonly initialCommands: Command[]
  /** The agents passed in at construction; hot-reload writes `currentAgents`. */
  readonly initialAgents: AgentDefinition[]
  readonly canUseTool: CanUseToolFn
  readonly getAppState: () => AppState
  readonly setAppState: (f: (prev: AppState) => AppState) => void
  readonly options: HeadlessStreamingOptions
  /**
   * SDK MCP server configs. Mutated IN PLACE (`delete` + `Object.assign`) by
   * `applyMcpServerChanges` and by the `initialize` control request, because
   * the reference is shared with the caller in `runHeadless`.
   */
  readonly sdkMcpConfigs: Record<string, McpSdkServerConfig>
  /**
   * Messages for internal tracking, directly mutated by `ask()`. Includes
   * Assistant, User, Attachment and Progress messages.
   */
  readonly mutableMessages: Message[]
  /**
   * Client-supplied readFileState seeds (via the `seed_read_state` control
   * request). See the comment on `readFileState` below for why seeds land here
   * instead of being written straight into the live cache.
   */
  readonly pendingSeeds: FileStateCache
  readonly suggestionState: SuggestionState
  /** MCP clients that already have elicitation handlers registered. */
  readonly elicitationRegistered: Set<string>
  readonly modelInfos: ModelInfo[]
  readonly idleTimeout: ReturnType<typeof createIdleTimeoutManager>
  /** Per-server in-flight MCP OAuth flows, so a new request aborts the old. */
  readonly activeOAuthFlows: Map<string, AbortController>
  /** Manual callback-URL submitters, for hosts where localhost is unreachable. */
  readonly oauthCallbackSubmitters: Map<string, (callbackUrl: string) => void>
  /** Servers whose manual callback fired (the automatic reconnect must skip). */
  readonly oauthManualCallbackUsed: Set<string>
  /** Auth-only promises so `mcp_oauth_callback_url` can await token exchange. */
  readonly oauthAuthPromises: Map<string, Promise<void>>

  // --------------------------------------------------------------- state ---
  // Reassignable. Read through `ctx.` at the point of use — never destructure.
  running: boolean
  runPhase: RunPhase
  inputClosed: boolean
  shutdownPromptInjected: boolean
  heldBackResult: StdoutMessage | null
  abortController: AbortController | undefined
  /**
   * The live readFileState cache, seeded from the transcript. Reassigned by
   * `ask()`'s `setReadFileCache` on every clone-then-replace cycle, so it must
   * be read fresh; `installLiveReadFileCache` owns the pin-transfer invariant.
   */
  readFileState: FileStateCache
  activeUserSpecifiedModel: string | undefined
  /** Cached SDK MCP clients, to avoid reconnecting on each run. */
  sdkClients: MCPServerConnection[]
  sdkTools: Tools
  /**
   * Servers added dynamically via `mcp_set_servers`. Separate from SDK MCP
   * servers and supports all transport types.
   */
  dynamicMcpState: DynamicMcpState
  /** Remote-control bridge handle; created/torn down by `remote_control`. */
  bridgeHandle: ReplBridgeHandle | null
  /** Cursor into `mutableMessages` — how far we have forwarded to the bridge. */
  bridgeLastForwardedIndex: number
  /** Serializes concurrent `applyMcpServerChanges` callers. */
  mcpChangesPromise: Promise<McpSetServersOutcome>
  /** Set only under CLAUDE_CODE_SYNC_PLUGIN_INSTALL; awaited once by `run()`. */
  pluginInstallPromise: Promise<void> | null
  /** Hot-reloadable command list (the REPL uses AppState for this instead). */
  currentCommands: Command[]
  /** Hot-reloadable agent list (the REPL uses AppState for this instead). */
  currentAgents: AgentDefinition[]
  cronScheduler: import('src/tasks/cronScheduler.js').CronScheduler | null
  /**
   * In-flight Anthropic OAuth flow (`claude_authenticate`). Single-slot: a
   * second authenticate request cleans up the first.
   */
  claudeOAuth: { service: OAuthService; flow: Promise<void> } | null

  // --------------------------------------------------------------- wiring ---
  // Attached after construction; see the invariant note in the header.
  run: () => Promise<void>
  updateSdkMcp: () => Promise<void>
  applyMcpServerChanges: (
    servers: Record<string, McpServerConfigForProcessTransport>,
  ) => Promise<McpSetServersOutcome>
  refreshPluginState: () => Promise<void>
  applyPluginMcpDiff: () => Promise<void>
  buildAllTools: (appState: AppState) => Tools
  registerElicitationHandlers: (clients: MCPServerConnection[]) => void
  buildMcpServerStatuses: () => McpServerStatus[]
  forwardMessagesToBridge: () => void
  injectModelSwitchBreadcrumbs: (
    modelArg: string,
    resolvedModel: string,
  ) => void
  // Both only read `request_id`, so they take the narrowest shape that
  // supplies it. That keeps them callable from handlers whose request body is
  // described structurally (see `ControlRequestWith`) as well as from the
  // dispatcher's fully-narrowed union members.
  sendControlResponseSuccess: (
    message: { request_id: string },
    response?: Record<string, unknown>,
  ) => void
  sendControlResponseError: (
    message: { request_id: string },
    errorMessage: string,
  ) => void
  /** Only defined under PROACTIVE/KAIROS; the call sites assert with `!`. */
  scheduleProactiveTick: (() => void) | undefined
  /** Teardown shared by the two "input closed and idle" exits. */
  closeOutput: () => Promise<void>
}
