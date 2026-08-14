export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ---------------------------------------------------------------------------
// Reconstructed SDK runtime types
//
// Everything below this line was reconstructed from its use sites: the original
// module was not carried into this fork, and `agentSdkTypes.ts` imports these
// names for its own public signatures.
//
// This module holds the NON-SERIALIZABLE half of the SDK surface — callbacks
// and interfaces with methods. Anything that has a Zod schema in
// `coreSchemas.ts` belongs in `coreTypes.generated.ts` instead and is imported
// from `./coreTypes.js` here rather than redeclared.
//
// Provenance is noted per group. Two sources carry most of the weight:
//   - `controlSchemas.ts`, the wire contract between an SDK client and this
//     CLI, which pins down what an SDK client can ask for.
//   - `agentSdkTypes.ts`'s own function signatures, which constrain the shapes
//     these names must have.
// Fields with no evidence anywhere in this repo were deliberately left out
// rather than guessed, so this is a floor on the real SDK surface, not a
// complete mirror of it.
// ---------------------------------------------------------------------------

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod/v4'
import type {
  SDKControlGetContextUsageResponseSchema,
  SDKControlGetSettingsResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlReloadPluginsResponseSchema,
} from './controlSchemas.js'
import type {
  AgentDefinition,
  HookEvent,
  HookInput,
  HookJSONOutput,
  McpSdkServerConfig,
  McpServerConfigForProcessTransport,
  McpServerStatus,
  OutputFormat,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  RewindFilesResult,
  SDKMessage,
  SDKResultMessage,
  SdkPluginConfig,
  SettingSource,
  ThinkingConfig,
} from './coreTypes.js'

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/**
 * Maps a record of Zod schemas to the record of values they parse to.
 *
 * Shape is pinned by `tool()` in `agentSdkTypes.ts`: it takes
 * `Schema extends Record<string, z.ZodType>` and hands the handler
 * `args: InferShape<Schema>`.
 */
export type InferShape<Schema extends Record<string, z.ZodType>> = {
  [K in keyof Schema]: z.infer<Schema[K]>
}

// ---------------------------------------------------------------------------
// In-process MCP servers
// ---------------------------------------------------------------------------

/**
 * A tool defined in the SDK consumer's own process, as returned by `tool()`.
 *
 * Every field comes from the `tool()` signature in `agentSdkTypes.ts`; the
 * `extras` argument there is spread flat onto the definition.
 */
export type SdkMcpToolDefinition<
  Schema extends Record<string, z.ZodType> = Record<string, z.ZodType>,
> = {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  searchHint?: string
  alwaysLoad?: boolean
}

/**
 * The serializable `{ type: 'sdk', name }` config plus the live server object
 * it names. The instance is what makes this non-serializable, and therefore why
 * it lives here rather than in `coreTypes.generated.ts` alongside
 * `McpSdkServerConfig`.
 *
 * The CLI side never reads `instance` — it addresses SDK servers by name over
 * the control channel (`setupSdkMcpClients` in
 * `services/mcp/client/sdkClients.ts`) — so this type exists purely for the
 * consumer-side handle returned by `createSdkMcpServer()`.
 */
export type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: McpServer
}

// ---------------------------------------------------------------------------
// Hooks
//
// The SDK's hook config is callback-based, which is exactly why it cannot live
// in `coreTypes.generated.ts`: `SDKControlInitializeRequestSchema` carries only
// `hookCallbackIds` on the wire, and the CLI calls back with a `hook_callback`
// control request. Deliberately NOT reusing `HookCallback`/`HookCallbackMatcher`
// from `src/types/hooks.ts` — those are the CLI's internal representation, carry
// CLI-only concerns (`hookIndex`, `context`, `internal`), and importing them
// here would create a runtimeTypes → hooks → agentSdkTypes → runtimeTypes cycle.
// ---------------------------------------------------------------------------

/** A hook implemented as a function in the SDK consumer's process. */
export type SDKHookCallback = (
  input: HookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>

/**
 * Matcher plus callbacks. `matcher` and `timeout` mirror
 * `SDKHookCallbackMatcherSchema`; `hooks` is the in-process counterpart of that
 * schema's `hookCallbackIds`.
 */
export type SDKHookCallbackMatcher = {
  matcher?: string
  hooks: SDKHookCallback[]
  timeout?: number
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * The SDK consumer's permission callback. Parameters mirror
 * `SDKControlPermissionRequestSchema` (the `can_use_tool` control request),
 * which is the only place this contract is written down in this repo.
 */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal
    suggestions?: PermissionUpdate[]
    blockedPath?: string
    decisionReason?: string
    title?: string
    displayName?: string
    description?: string
    toolUseId: string
    agentId?: string
  },
) => Promise<PermissionResult>

// ---------------------------------------------------------------------------
// query() options
// ---------------------------------------------------------------------------

/**
 * Options accepted by `query()`.
 *
 * Assembled from three grounded sources, marked per field group:
 *   (init)  `SDKControlInitializeRequestSchema` — what an SDK client sends at
 *           handshake time.
 *   (head)  the `options` parameter of `runHeadless()` in
 *           `cli/print/runHeadless.ts` — what the CLI actually consumes.
 *   (flag)  CLI flags declared in `main.tsx` that an SDK client must be able to
 *           set, since the SDK drives this CLI.
 *
 * SDK-side process-spawn options (executable path, spawn args, stderr sink)
 * have no reader anywhere in this repo and were left out rather than invented.
 */
export type Options = {
  // (init) handshake configuration
  hooks?: Partial<Record<HookEvent, SDKHookCallbackMatcher[]>>
  systemPrompt?: string
  appendSystemPrompt?: string
  agents?: Record<string, AgentDefinition>
  jsonSchema?: Record<string, unknown>
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean

  // (init/flag) in-process and out-of-process MCP servers
  mcpServers?: Record<
    string,
    McpServerConfigForProcessTransport | McpSdkServerConfigWithInstance
  >
  strictMcpConfig?: boolean

  // (head) turn control and budgets
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }

  // (head/flag) model selection
  model?: string
  fallbackModel?: string
  thinking?: ThinkingConfig
  effort?: EffortLevel

  // (head/flag) permissions and tool gating
  canUseTool?: CanUseTool
  permissionMode?: PermissionMode
  permissionPromptToolName?: string
  allowedTools?: string[]
  disallowedTools?: string[]

  // (head/flag) session lifecycle
  continue?: boolean
  resume?: string
  resumeSessionAt?: string
  forkSession?: boolean
  sessionId?: string

  // (head) output shaping
  outputFormat?: OutputFormat
  includePartialMessages?: boolean
  replayUserMessages?: boolean
  verbose?: boolean

  // (flag) workspace and configuration sources
  cwd?: string
  additionalDirectories?: string[]
  settingSources?: SettingSource[]
  plugins?: SdkPluginConfig[]
  betas?: string[]
  env?: Record<string, string | undefined>

  // (head) file rewind and the agent to run as
  rewindFiles?: string
  agent?: string

  /** Aborts the whole query, including the CLI subprocess. */
  abortController?: AbortController
}

/**
 * `query()`'s `@internal` overload takes this instead of {@link Options}.
 *
 * The extra fields are the ones `runHeadless()` accepts but which are not part
 * of the documented SDK surface, plus `enableRemoteControl`, which is named
 * explicitly in the `connectRemoteControl()` docstring in `agentSdkTypes.ts`
 * ("Contrast with `query.enableRemoteControl` which puts the WS in the CHILD
 * process").
 */
export type InternalOptions = Options & {
  teleport?: string | true | null
  sdkUrl?: string
  enableAuthStatus?: boolean
  enableRemoteControl?: boolean
  setupTrigger?: 'init' | 'maintenance'
}

// ---------------------------------------------------------------------------
// query() result
//
// The method set is derived from the control-request subtypes in
// `controlSchemas.ts`, camel-cased: those are exactly the operations an SDK
// client can perform against a running CLI, and this repo contains only the
// server half (`runHeadless.ts` dispatches on `message.request.subtype`), never
// a caller. The public/internal split is a judgement call. `initialize`,
// `can_use_tool`, `hook_callback`, `mcp_message` and `elicitation` are excluded
// because they are handshake or CLI-initiated, not client-initiated.
// ---------------------------------------------------------------------------

export type Query = AsyncGenerator<SDKMessage, void> & {
  /** `interrupt` — abort the in-flight turn. */
  interrupt(): Promise<void>
  /** `set_permission_mode` */
  setPermissionMode(mode: PermissionMode): Promise<void>
  /** `set_model` — omit the argument to reset to the default. */
  setModel(model?: string): Promise<void>
  /** `set_max_thinking_tokens` — `null` clears the override. */
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>
  /** `mcp_status` */
  mcpServerStatus(): Promise<McpServerStatus[]>
  /** `get_context_usage` */
  getContextUsage(): Promise<
    z.infer<ReturnType<typeof SDKControlGetContextUsageResponseSchema>>
  >
  /** `rewind_files` */
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult>
  /** `mcp_set_servers` — replaces the dynamically managed server set. */
  mcpSetServers(
    servers: Record<string, McpServerConfigForProcessTransport>,
  ): Promise<z.infer<ReturnType<typeof SDKControlMcpSetServersResponseSchema>>>
  /** `mcp_reconnect` */
  mcpReconnect(serverName: string): Promise<void>
  /** `mcp_toggle` */
  mcpToggle(serverName: string, enabled: boolean): Promise<void>
  /** `reload_plugins` */
  reloadPlugins(): Promise<
    z.infer<ReturnType<typeof SDKControlReloadPluginsResponseSchema>>
  >
  /** `stop_task` */
  stopTask(taskId: string): Promise<void>
}

/** {@link Query} plus the control requests outside the documented surface. */
export type InternalQuery = Query & {
  /** `cancel_async_message` — resolves false if the message was already dequeued. */
  cancelAsyncMessage(messageUuid: string): Promise<boolean>
  /** `seed_read_state` — pre-seed `readFileState` for a Read dropped from context. */
  seedReadState(path: string, mtime: number): Promise<void>
  /** `apply_flag_settings` */
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  /** `get_settings` */
  getSettings(): Promise<
    z.infer<ReturnType<typeof SDKControlGetSettingsResponseSchema>>
  >
}

// ---------------------------------------------------------------------------
// v2 session API (unstable)
//
// Constrained only by the three `unstable_v2_*` signatures in
// `agentSdkTypes.ts`; there is no implementation or caller in this repo, so the
// method set below is the minimum those signatures imply.
// ---------------------------------------------------------------------------

/**
 * Same options as `query()`. Kept as a distinct name because the SDK surface
 * declares it separately and may diverge once the v2 API stabilizes.
 */
export type SDKSessionOptions = Options

/** Persistent multi-turn session handle. @alpha */
export type SDKSession = {
  readonly sessionId: string
  /** Send a prompt and resolve with that turn's result. */
  prompt(message: string): Promise<SDKResultMessage>
  /** Stream every message the session emits. */
  messages(): AsyncGenerator<SDKMessage, void>
  interrupt(): Promise<void>
  end(): Promise<void>
}

// ---------------------------------------------------------------------------
// Session management helpers
// ---------------------------------------------------------------------------

/**
 * Re-exported rather than redeclared: `utils/listSessionsImpl.ts` owns the real
 * definition and `listSessionsImpl()` is typed against it.
 */
export type { ListSessionsOptions } from 'src/utils/listSessionsImpl.js'

/** Options for `getSessionInfo()`. Its docstring documents exactly `{ dir? }`. */
export type GetSessionInfoOptions = {
  /** Project path. Omit to search all project directories. */
  dir?: string
}

/** Options for `renameSession()` and `tagSession()`, documented as `{ dir? }`. */
export type SessionMutationOptions = {
  /** Project path. Omit to search all projects. */
  dir?: string
}

/** Options for `getSessionMessages()` — dir, limit, offset, includeSystemMessages. */
export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

/** Options for `forkSession()`, documented as `{ dir?, upToMessageId?, title? }`. */
export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

/** `forkSession()` returns `{ sessionId }` — the UUID of the new session. */
export type ForkSessionResult = {
  sessionId: string
}

/**
 * A transcript message as returned by `getSessionMessages()`.
 *
 * Derived rather than declared: the docstring says it returns "user/assistant
 * messages in chronological order" and that `includeSystemMessages: true` also
 * includes system messages, so it is exactly the persisted subset of
 * {@link SDKMessage}.
 */
export type SessionMessage = Extract<
  SDKMessage,
  { type: 'user' | 'assistant' | 'system' }
>
