/**
 * The shape of the session state — types only, no values, no state.
 *
 * `State` and the two listener/hook aliases are internal to ./state/; the four
 * public ones (ChannelEntry, SessionCronTask, SessionWakeup, InvokedSkillInfo)
 * are re-exported by the state.ts barrel.
 */
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  HookEvent,
  ModelUsage,
} from 'src/platform/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/shared/types/hooks.js'
import type { ModelSetting } from 'src/providers/model/model.js'
import type { ModelStrings } from 'src/providers/model/modelStrings.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import type { PluginHookMatcher } from 'src/platform/settings/types.js'
import type { SessionId } from 'src/shared/types/ids.js'

// Union type for registered hooks - can be SDK callbacks or native plugin hooks
export type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

export type RuntimeStateChangeListener = () => void

// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

// dev: true on entries that came via --dangerously-load-development-channels.
// The allowlist gate checks this per-entry (not the session-wide
// hasDevChannels bit) so passing both flags doesn't let the dev dialog's
// acceptance leak allowlist-bypass to the --channels entries.
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type State = {
  originalCwd: string
  // Stable project root - set once at startup (including by --worktree flag),
  // never updated by mid-session EnterWorktreeTool.
  // Use for project identity (history, skills, sessions) not file operations.
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  /** Accumulated ACTIVE (turn) wall-clock ms — excludes idle time. Wall
   * duration is the sum of completed turns, not `now - startTime`. */
  activeDurationMs: number
  /** Timestamp (ms) of the currently-running turn, or null when idle. Lets
   * `getTotalDuration()` live-tick during a turn and freeze between turns. */
  turnActiveSince: number | null
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  // When true, ensureToolResultPairing throws on mismatch instead of
  // repairing with synthetic placeholders. HFI opts in at startup so
  // trajectories fail fast rather than conditioning the model on fake
  // tool_results.
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  // Parent session ID for tracking session lineage (e.g., plan mode -> implementation)
  parentSessionId: SessionId | undefined
  // Agent color state
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // Last API request for bug reports
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  // Messages from the last API request (internal-only; reference, not clone).
  // Captures the exact post-compaction, CLAUDE.md-injected message set sent
  // to the API so /share's serialized_conversation.json reflects reality.
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  // Last auto-mode classifier request(s) for /share transcript
  lastClassifierRequests: unknown[] | null
  // CLAUDE.md content cached by context.ts for the auto-mode classifier.
  // Breaks the yoloClassifier → claudemd → filesystem → permissions cycle.
  cachedClaudeMdContent: string | null
  // In-memory error log for recent errors
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // Session-only plugins from --plugin-dir flag
  inlinePlugins: Array<string>
  // Use cowork_plugins directory instead of plugins (--cowork flag or env var)
  useCoworkPlugins: boolean
  // Session-only bypass permissions mode flag (not persisted)
  sessionBypassPermissionsMode: boolean
  // Session-only flag gating the .claudin/scheduled_tasks.json watcher
  // (useScheduledTasks). Set by cronScheduler.start() when the JSON has
  // entries, or by CronCreateTool. Not persisted.
  scheduledTasksEnabled: boolean
  // Session-only cron tasks created via CronCreate with durable: false.
  // Fire on schedule like file-backed tasks but are never written to
  // .claudin/scheduled_tasks.json — they die with the process. Typed via
  // SessionCronTask below (not importing from cronTasks.ts keeps
  // bootstrap a leaf of the import DAG).
  sessionCronTasks: SessionCronTask[]
  // Session-only pending /loop wakeup created via ScheduleWakeup. At most
  // one alive at a time — scheduling again replaces it. Never written to
  // disk; dies with the process. Typed via SessionWakeup below (same
  // leaf-of-the-import-DAG rationale as SessionCronTask).
  pendingSessionWakeup: SessionWakeup | null
  // Teams created this session via TeamCreate. cleanupSessionTeams()
  // removes these on gracefulShutdown so subagent-created teams don't
  // persist on disk forever (gh-32730). TeamDelete removes entries to
  // avoid double-cleanup. Lives here (not teamHelpers.ts) so
  // resetStateForTests() clears it between tests.
  sessionCreatedTeams: Set<string>
  // Session-only trust flag for home directory (not persisted to disk)
  // When running from home dir, trust dialog is shown but not saved to disk.
  // This flag allows features requiring trust to work during the session.
  sessionTrustAccepted: boolean
  // Session-only flag to disable session persistence to disk
  sessionPersistenceDisabled: boolean
  // Track if user has exited plan mode in this session (for re-entry guidance)
  hasExitedPlanMode: boolean
  // Track if we need to show the plan mode exit attachment (one-time notification)
  needsPlanModeExitAttachment: boolean
  // Track if we need to show the auto mode exit attachment (one-time notification)
  needsAutoModeExitAttachment: boolean
  // SDK init event state - jsonSchema for structured output
  initJsonSchema: Record<string, unknown> | null
  // Registered hooks - SDK callbacks and plugin native hooks
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // Cache for plan slugs: sessionId -> wordSlug
  planSlugCache: Map<string, string>
  // Track teleported session for reliability logging
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  // Track invoked skills for preservation across compaction
  // Keys are composite: `${agentId ?? ''}:${skillName}` to prevent cross-agent overwrites
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // Track slow operations for dev bar display (internal-only)
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  // SDK-provided betas (e.g., context-1m-2025-08-07)
  sdkBetas: string[] | undefined
  // Main thread agent type (from --agent flag or settings)
  mainThreadAgentType: string | undefined
  // Remote mode (--remote flag)
  isRemoteMode: boolean
  // Direct connect server URL (for display in header)
  directConnectServerUrl: string | undefined
  // System prompt section cache state
  systemPromptSectionCache: Map<string, string | null>
  // Last date emitted to the model (for detecting midnight date changes)
  lastEmittedDate: string | null
  // Additional directories from --add-dir flag (for CLAUDE.md loading)
  additionalDirectoriesForClaudeMd: string[]
  // Channel server allowlist from --channels flag (servers whose channel
  // notifications should register this session). Parsed once in main.tsx —
  // the tag decides trust model: 'plugin' → marketplace verification +
  // allowlist, 'server' → allowlist always fails (schema is plugin-only).
  // Either kind needs entry.dev to bypass allowlist.
  allowedChannels: ChannelEntry[]
  // True if any entry in allowedChannels came from
  // --dangerously-load-development-channels (so ChannelsNotice can name the
  // right flag in policy-blocked messages)
  hasDevChannels: boolean
  // Dir containing the session's `.jsonl`; null = derive from originalCwd.
  sessionProjectDir: string | null
  // Sticky latch: true once the session's system prompt is detected as
  // large enough (>8k tokens, chars/4 heuristic) to justify 1h cache TTL on
  // firstParty/vertex. Latched on first request from buildSystemPromptBlocks
  // (see src/providers/shims/claude/paramBuilders.ts)
  // so mid-session prompt size jitter doesn't flip the cache_control TTL,
  // which would bust the server-side prompt cache (~20K tokens per flip).
  largeSystemPromptDetected: boolean | null
  // Sticky-on latch for AFK_MODE_BETA_HEADER. Once auto mode is first
  // activated, keep sending the header for the rest of the session so
  // Shift+Tab toggles don't bust the ~50-70K token prompt cache.
  afkModeHeaderLatched: boolean | null
  // Sticky-on latch for FAST_MODE_BETA_HEADER. Once fast mode is first
  // enabled, keep sending the header so cooldown enter/exit doesn't
  // double-bust the prompt cache. The `speed` body param stays dynamic.
  fastModeHeaderLatched: boolean | null
  // Sticky-on latch for clearing thinking from prior tool loops. Triggered
  // when >1h since last API call (confirmed cache miss — no cache-hit
  // benefit to keeping thinking). Once latched, stays on so the newly-warmed
  // thinking-cleared cache isn't busted by flipping back to keep:'all'.
  thinkingClearLatched: boolean | null
  // Sticky defer latch for LSP tools. A tool first sent with
  // defer_loading: true (LSP init still pending) keeps being sent deferred
  // for the rest of the session, even after the LSP becomes ready —
  // flipping defer_loading false would add the schema to the effective
  // tools array mid-session and bust the prompt cache. Deferred tools stay
  // reachable via ToolSearch. Null = no tool latched yet.
  lspDeferLatchedTools: Set<string> | null
  // Sticky compatibility latch for the deferred-tools announcement format.
  // True = this session was resumed with a potentially-warm server cache
  // written by a binary that used the legacy <available-deferred-tools>
  // prepend, so we keep emitting the legacy format (prepend + old
  // ToolSearchTool hint) for the rest of the session instead of switching
  // to delta attachments mid-cache. See toolSearch.ts
  // maybeLatchLegacyDeferredAnnouncement.
  deferredDeltaLegacySession: boolean
  // Reference point for "written by a previous process/conversation"
  // checks (legacy-latch warm-cache scan). Starts at process start and
  // advances to Date.now() on every session switch, so in-process /resume
  // gets the same "everything before this moment is the resume point"
  // semantics as a fresh launch. See toolSearch.ts
  // maybeLatchLegacyDeferredAnnouncement.
  sessionEpochMs: number
  // Current prompt ID (UUID) correlating a user prompt with subsequent OTel events
  promptId: string | null
  // Last API requestId for the main conversation chain (not subagents).
  // Updated after each successful API response for main-session queries.
  // Read at shutdown to send cache eviction hints to inference.
  lastMainRequestId: string | undefined
  // Timestamp (Date.now()) of the last successful API call completion.
  // Used to compute timeSinceLastApiCallMs in tengu_api_success for
  // correlating cache misses with idle time (cache TTL is ~5min).
  lastApiCompletionTimestamp: number | null
  // Set to true after compaction (auto or manual /compact). Consumed by
  // logAPISuccess to tag the first post-compaction API call so we can
  // distinguish compaction-induced cache misses from TTL expiry.
  pendingPostCompaction: boolean
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * When set, the task was created by an in-process teammate (not the team lead).
   * The scheduler routes fires to that teammate's pendingUserMessages queue
   * instead of the main REPL command queue. Session-only — never written to disk.
   */
  agentId?: string
}

/**
 * Session-only one-shot wakeup scheduled by the ScheduleWakeup tool
 * (/loop dynamic mode). Unlike SessionCronTask there is no cron string —
 * just an absolute fire time with second granularity — and at most one
 * can be pending per session.
 */
export type SessionWakeup = {
  /** Epoch ms when the wakeup fires. */
  fireAtMs: number
  /** Prompt enqueued into the session when the wakeup fires. */
  prompt: string
  /** One short sentence shown to the user explaining the chosen delay. */
  reason: string
}

// Invoked skills tracking for preservation across compaction
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}
