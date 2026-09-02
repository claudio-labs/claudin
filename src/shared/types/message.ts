/**
 * The transcript message model — the union every part of the app passes around.
 *
 * This module was not carried into the fork. All ~240 importers were left
 * unresolved and auto-stubbed at bundle time, which made `Message` and its 38
 * siblings silently `any` for the whole tree: every `.map(m => …)` over a
 * message array, every renderer prop, every normalizer signature. Nothing here
 * exists at runtime (the module is types only, so it erases to nothing) — the
 * point is to restore the checking that the missing file took with it.
 *
 * Every shape below is reconstructed from a CONSTRUCTION site wherever one
 * exists — `src/agent/messages/factories.ts` builds most of the union, and
 * `normalize.ts` / `collapseReadSearch.ts` / `groupToolUses.ts` define the
 * derived views. Where only consumers were available that is called out inline.
 * Expect it to be tightened over time; prefer narrowing a field here over
 * casting at a call site.
 *
 * Three structural facts the rest of the codebase leans on:
 *
 * 1. `Message` has exactly five arms, discriminated by `type`. The exhaustive
 *    `switch` in `normalizeMessages` (`normalize.ts`) and the negative
 *    narrowing in `isSyntheticMessage` (`predicates.ts` — "not progress, not
 *    attachment, not system" then reads `.message.content`) both pin it.
 * 2. The `Normalized*` views are the same messages with a SINGLE content block.
 *    `normalizeMessages` splits multi-block messages into one message per block.
 * 3. `RenderableMessage` is the normalized union plus the two synthetic grouping
 *    wrappers (`grouped_tool_use`, `collapsed_read_search`) that only ever exist
 *    in the TUI — they are never sent to a model and never persisted.
 */
import type { APIError } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
// Sourced from the zod schema rather than `agentSdkTypes.js`: that barrel
// re-exports `coreTypes.generated.ts`, which is an empty stub in this fork, so
// the name it is nominally exported under does not actually resolve.
import type { SDKAssistantMessageErrorSchema } from 'src/platform/entrypoints/sdk/coreSchemas.js'
import type { z } from 'zod/v4'
import type { Progress } from 'src/tools/Tool.js'
import type { PermissionMode } from 'src/shared/types/permissions.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import type {
  BranchAction,
  CommitKind,
  PrAction,
} from 'src/tools/shared/gitOperationTracking.js'

/** Why an assistant turn failed, when it did. */
type SDKAssistantMessageError = z.infer<
  ReturnType<typeof SDKAssistantMessageErrorSchema>
>

/**
 * Where a user message came from. `undefined` means a human typed it — the
 * `human` arm is the explicit spelling of the same thing.
 * Source: `wrapCommandText` in `src/agent/messages/text.ts`.
 */
export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }

/**
 * Which side of the selected message a partial compaction summarizes.
 * Source: `src/agent/compact/prompt.ts` (`direction === 'up_to'`) and the
 * `= 'from'` defaults in `compact.ts` / `REPL.tsx`.
 */
export type PartialCompactDirection = 'from' | 'up_to'

/** Severity tag carried by most system messages. */
export type SystemMessageLevel = 'info' | 'warning' | 'error' | 'suggestion'

/** Metadata attached to a compact boundary. Mirrors the SDK's snake_case form
 *  via `toSDKCompactMetadata`/`fromSDKCompactMetadata` in `messages/mappers.ts`. */
export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  /**
   * Names of tools discovered (via `tool_reference` blocks) before this
   * compact ran. The summary doesn't preserve those blocks, so the
   * post-compact schema filter needs this carried set to keep sending their
   * schemas. Internal-only — not part of the SDK's `compact_metadata` shape.
   */
  preCompactDiscoveredTools?: string[]
}

/** One hook execution, as summarized in a stop-hook / collapsed group line.
 *  Built in `query/stopHooks.ts` and `services/tools/toolExecution.ts`. */
export type StopHookInfo = {
  command: string
  promptText?: string
  durationMs?: number
}

// ---------------------------------------------------------------------------
// The five arms of `Message`
// ---------------------------------------------------------------------------

/** Fields every transcript message carries. */
type MessageBase = {
  uuid: UUID
  timestamp: string
}

/**
 * A model turn. `message` is the Anthropic SDK's beta message payload —
 * `baseCreateAssistantMessage` fills every field of it.
 */
export type AssistantMessage = MessageBase & {
  type: 'assistant'
  message: {
    id: string
    role: 'assistant'
    type: 'message'
    model: string
    content: BetaContentBlock[]
    stop_reason: string | null
    stop_sequence: string | null
    usage: BetaUsage
    container?: unknown | null
    context_management?: unknown | null
  }
  requestId?: string | undefined
  /** Set when the turn is a synthesized API-error placeholder rather than a real
   *  model response — see `createAssistantAPIErrorMessage`. */
  isApiErrorMessage?: boolean
  apiError?: APIError | undefined
  error?: SDKAssistantMessageError | undefined
  errorDetails?: string | undefined
  isMeta?: boolean
  /** Synthesized locally; never came back over the wire. */
  isVirtual?: true
  /** Model that produced an advisor block, when the turn came from /advisor. */
  advisorModel?: string | undefined
}

/** A user turn, a tool result, or a synthetic caveat. Built by `createUserMessage`. */
export type UserMessage = MessageBase & {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  /** Hidden from the transcript but still sent to the model. */
  isMeta?: true
  /** Shown in the transcript but never sent to the model. */
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  /** The tool's own `Output` value, kept for renderers. Never sent to the model. */
  toolUseResult?: unknown
  /** MCP protocol metadata passed through to SDK consumers (never sent to the model). */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  /** For tool_result messages: the assistant message holding the matching tool_use. */
  sourceToolAssistantUUID?: UUID
  /** Permission mode in force when the message was sent (for rewind restoration). */
  permissionMode?: PermissionMode
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  origin?: MessageOrigin
}

/** An auto-injected context block (file read, hook output, reminder, …). */
export type AttachmentMessage = MessageBase & {
  type: 'attachment'
  attachment: Attachment
}

/**
 * A tool's in-flight progress update. `P` defaults to the full `Progress` union
 * so `ProgressMessage` can be written bare (e.g. `Exclude<NormalizedMessage,
 * ProgressMessage>` in `groupToolUses.ts`).
 */
export type ProgressMessage<P extends Progress = Progress> = MessageBase & {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
}

// ---------------------------------------------------------------------------
// The system-message family (all `type: 'system'`, discriminated by `subtype`)
// ---------------------------------------------------------------------------

type SystemMessageBase = MessageBase & {
  type: 'system'
  isMeta?: boolean
  level?: SystemMessageLevel
  content?: string
  toolUseID?: string
}

export type SystemInformationalMessage = SystemMessageBase & {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  /** Stops the agent loop from continuing after this message. */
  preventContinuation?: boolean
}

export type SystemLocalCommandMessage = SystemMessageBase & {
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
}

export type SystemPermissionRetryMessage = SystemMessageBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: SystemMessageLevel
}

export type SystemBridgeStatusMessage = SystemMessageBase & {
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
}

export type SystemScheduledTaskFireMessage = SystemMessageBase & {
  subtype: 'scheduled_task_fire'
  content: string
}

export type SystemStopHookSummaryMessage = SystemMessageBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason: string | undefined
  hasOutput: boolean
  level: SystemMessageLevel
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemTurnDurationMessage = SystemMessageBase & {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export type SystemAwaySummaryMessage = SystemMessageBase & {
  subtype: 'away_summary'
  content: string
}

export type SystemMemorySavedMessage = SystemMessageBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
}

export type SystemAgentsKilledMessage = SystemMessageBase & {
  subtype: 'agents_killed'
}

export type SystemApiMetricsMessage = SystemMessageBase & {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemCompactBoundaryMessage = SystemMessageBase & {
  subtype: 'compact_boundary'
  content: string
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  /** Points back at the last pre-compact message, so rewind can cross the seam. */
  logicalParentUuid?: UUID
}

export type SystemMicrocompactBoundaryMessage = SystemMessageBase & {
  subtype: 'microcompact_boundary'
  content: string
  level: SystemMessageLevel
  microcompactMetadata: {
    trigger: 'auto'
    preTokens: number
    tokensSaved: number
    compactedToolIds: string[]
    clearedAttachmentUUIDs: string[]
  }
}

export type SystemAPIErrorMessage = SystemMessageBase & {
  subtype: 'api_error'
  level: 'error'
  error: APIError
  cause?: Error | undefined
  retryInMs: number
  retryAttempt: number
  maxRetries: number
}

/** Written to the transcript by `src/agent/plans/plans.ts` so a rewind can restore
 *  files the plan touched. Never rendered. */
export type SystemFileSnapshotMessage = SystemMessageBase & {
  subtype: 'file_snapshot'
  content: string
  level: SystemMessageLevel
  snapshotFiles: { key: string; path: string; content: string }[]
}

/**
 * Reconstructed from a consumer only: `SystemTextMessage.tsx` handles
 * `subtype === 'thinking'` by returning `null`, and nothing in this fork
 * constructs one. Kept so the renderer's branch stays reachable.
 */
export type SystemThinkingMessage = SystemMessageBase & {
  subtype: 'thinking'
  content: string
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemLocalCommandMessage
  | SystemPermissionRetryMessage
  | SystemBridgeStatusMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemTurnDurationMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemAPIErrorMessage
  | SystemFileSnapshotMessage
  | SystemThinkingMessage

// ---------------------------------------------------------------------------
// The union itself
// ---------------------------------------------------------------------------

export type Message =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage

// ---------------------------------------------------------------------------
// Normalized views — one content block per message
// ---------------------------------------------------------------------------

export type NormalizedAssistantMessage = AssistantMessage & {
  message: { content: [BetaContentBlock] }
}

export type NormalizedUserMessage = UserMessage & {
  message: { content: [ContentBlockParam] }
}

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage

// ---------------------------------------------------------------------------
// TUI-only grouping wrappers
// ---------------------------------------------------------------------------

/**
 * Consecutive calls to the same tool, folded into one row.
 * Built in `src/agent/tools/groupToolUses.ts`.
 */
export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage
  uuid: string
  timestamp: string
  messageId: string
}

/**
 * How a collapsed write touched a file, in the same vocabulary
 * `summarizeApplyPatch` uses: Added, Modified, Deleted, Renamed — plus 'S' for
 * a symbol renamed in place, which reads as a rename in the summary but is a
 * plain modification on disk.
 */
export type WriteKind = 'A' | 'M' | 'D' | 'R' | 'S'

/** One file touched by a write inside a collapsed group. */
export type WriteFileStat = {
  path: string
  kind: WriteKind
  additions: number
  deletions: number
}

/**
 * A run of read/search/write operations folded into a single summary row.
 * Built by `createCollapsedGroup` in `src/agent/tools/collapseReadSearch.ts`; the
 * optional fields are the ones that function only sets conditionally.
 */
export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint: string | undefined
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  uuid: UUID
  timestamp: string
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
  /**
   * Files written by Write/Edit/apply_patch/Rename absorbed into this group,
   * in the order they were first touched. Only set when the group has writes.
   */
  writeFileStats?: WriteFileStat[]
}

/** What a collapsed read/search group may absorb. */
export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

/** Everything the transcript can draw. */
export type RenderableMessage = NormalizedMessage | GroupedToolUseMessage | CollapsedReadSearchGroup

// ---------------------------------------------------------------------------
// Stream-only envelopes — yielded by `query()`, never stored in the transcript
// ---------------------------------------------------------------------------

/** Wraps one raw SDK stream event. `ttftMs` rides the `message_start` event. */
export type StreamEvent = {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  ttftMs?: number
}

/** Emitted once before the request goes out, so the spinner can switch modes. */
export type RequestStartEvent = {
  type: 'stream_request_start'
}

/** Instructs the consumer to REMOVE an already-emitted message. */
export type TombstoneMessage = {
  type: 'tombstone'
  message: Message
}

/** SDK-only: a human-readable recap emitted after a batch of tool calls. */
export type ToolUseSummaryMessage = MessageBase & {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
}

/**
 * What a hook may contribute back to the conversation. Narrowed on `.type` at
 * every consumer: `query/stopHooks.ts` reads the `progress` and `attachment`
 * arms, `services/tools/toolExecution.ts` the `attachment` arm, and
 * `utils/sessionStart.ts` pushes `createAttachmentMessage` results.
 */
export type HookResultMessage =
  | UserMessage
  | AttachmentMessage
  | ProgressMessage
