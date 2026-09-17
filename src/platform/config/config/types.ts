/**
 * Config types — every type and interface declaration of the config module,
 * including the 496-line GlobalConfig.
 *
 * The two key-list types (GlobalConfigKey, ProjectConfigKey) read their arrays
 * back from the module that declares them; that import is type-only in both
 * directions, so the cycle is erased before it reaches the bundler.
 */
import type { McpServerConfig } from 'src/mcp/types.js'
import type { BillingType } from 'src/providers/oauth/types.js'
import type { ImageDimensions } from 'src/terminal/image/imageResizer.js'
import type { ModelOption } from 'src/providers/model/modelOptions.js'
import type { ThemeSetting } from 'src/terminal/theme/theme.js'
import type {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  PROVIDERS,
} from 'src/platform/config/configConstants.js'
import type {
  GLOBAL_CONFIG_KEYS,
  PROJECT_CONFIG_KEYS,
} from 'src/platform/config/config/defaults.js'

// Image dimension info for coordinate mapping (only set when image was resized)
export type PastedContent = {
  id: number // Sequential numeric ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // e.g., 'image/png', 'image/jpeg'
  filename?: string // Display name for images in attachment slot
  dimensions?: ImageDimensions
  sourcePath?: string // Original file path for images dragged onto the terminal
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  // Cumulative project totals across all completed sessions in this project.
  // Excludes the in-progress session — that lives in `last*` until the next
  // session boundary, at which point it is folded into these counters.
  cumulativeCost?: number
  cumulativeAPIDuration?: number
  cumulativeDuration?: number
  cumulativeLinesAdded?: number
  cumulativeLinesRemoved?: number
  cumulativeModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // Trust dialog settings
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP server approval fields - migrated to settings but kept for backward compatibility
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // List of disabled MCP servers (all scopes) - used for enable/disable toggle
  disabledMcpServers?: string[]
  // Opt-in list for built-in MCP servers that default to disabled
  enabledMcpServers?: string[]
  // Worktree session management. NOTE: this is a narrowed, write-only snapshot —
  // --resume restores the session from the transcript (PersistedWorktreeSession),
  // not from here, so fields like `attached`/`worktreeBranch` are intentionally
  // omitted. If a reader is ever added, reconcile this shape with WorktreeSession.
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** Spawn mode for `claude remote-control` multi-session. Set by first-run dialog or `w` toggle. */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
  /** Override of the active provider profile for this project. Falls back to the global `activeProviderProfileId` when unset. */
  activeProviderProfileId?: string
  /**
   * Last `mainLoopModel` chosen via `/model` for this project. Scoped to the
   * project so `/model` in one project doesn't leak into the global
   * `settings.model` and bleed across projects. Only honored when
   * `activeModelForProjectProfileId` matches the project's effective provider
   * profile (see `getUserSpecifiedModelSetting`).
   */
  activeModelForProject?: string
  /**
   * The provider profile id that was active when `activeModelForProject` was
   * chosen. Guards against cross-provider leaks: a per-project model saved for
   * one provider must not be served against a different-shape transport if the
   * project's effective provider later changes. `undefined` matches an
   * environment with no provider profiles.
   */
  activeModelForProjectProfileId?: string
  /**
   * Effort level pinned via `/effort` for this project. Scoped like
   * `activeModelForProject` so an effort choice in one repo doesn't leak into
   * the global `settings.effortLevel` and bleed across projects (see
   * `getInitialEffortSetting`).
   *
   * `'auto'` is an explicit pin meaning "no effort for this project" — it
   * resolves to the model default AND overrides a globally pinned
   * `settings.effortLevel`. Absent means "inherit the global value".
   *
   * Unlike `activeModelForProject`, this is NOT bound to a provider profile and
   * is NOT cleared when the project's provider override changes:
   * `resolveAppliedEffort` already normalizes an effort value per model (Kimi
   * buckets, `max`/`xhigh` downgrades), so a pin chosen for one provider can
   * never produce an invalid request against another.
   */
  activeEffortForProject?:
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
    | 'adaptive'
    | 'auto'
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null // added 4/23/2025, not populated for existing users
  organizationRole?: string | null
  workspaceRole?: string | null
  // Populated by /api/oauth/profile
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// TODO: 'emacs' is kept for backward compatibility - remove after a few releases
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type ShowCacheStatsMode = 'off' | 'compact' | 'full'
export const SHOW_CACHE_STATS_MODES = ['off', 'compact', 'full'] as const satisfies readonly ShowCacheStatsMode[]

export type OutputStyle = string

export type Providers = typeof PROVIDERS[number]

export type ProviderProfileExtras = {
  codexAuthPath?: string
  codexAccountId?: string
  githubToken?: string
  awsRegion?: string
  gcpProject?: string
  gcpRegion?: string
  azureResource?: string
  customHeaders?: Record<string, string>
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
}

export type ProviderProfile = {
  id: string
  name: string
  provider: Providers
  baseUrl: string
  model: string
  apiKey?: string
  extras?: ProviderProfileExtras
}

export type GlobalConfig = {
  /**
   * @deprecated Use settings.apiKeyHelper instead.
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // Flag to distinguish protection-based disabling from user preference
  autoUpdatesProtectedForNative?: boolean
  // Session count when Doctor was last shown
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // Tracks the last version that reset onboarding, used with MIN_VERSION_REQUIRING_ONBOARDING_RESET
  lastOnboardingVersion?: string
  // Tracks the last version for which release notes were seen, used for managing release notes
  lastReleaseNotesSeen?: string
  // Timestamp when changelog was last fetched (content stored in ~/.claude/cache/changelog.md)
  changelogLastFetched?: number
  // @deprecated - Migrated to ~/.claude/cache/changelog.md. Keep for migration support.
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // claude.ai MCP connectors that have successfully connected at least once.
  // Used to gate "connector unavailable" / "needs auth" startup notifications:
  // a connector the user has actually used is worth flagging when it breaks,
  // but an org-configured connector that's been needs-auth since day one is
  // something the user has demonstrably ignored and shouldn't nag about.
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated. Use the Notification hook instead (docs/hooks.md).
   */
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // Primary API key for the user when no environment variable is set, set via oauth (TODO: rename)
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean // internal-only: whether the one-time auto-undercover explainer has been shown
  hasResetAutoModeOptInForDefaultOffer?: boolean // internal-only: one-shot migration guard, re-prompts churned auto-mode users
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // Legacy - keeping for backward compatibility
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // Controls whether auto-compact is enabled
  collapseSubagentProgress: boolean // Collapse foreground subagent progress to a single line on the main thread
  summarizeSubagentResult: boolean // Summarize a foreground subagent's final result before returning it to the parent (opt-in, lossy)
  thinkingHistoryRedactionEnabled: boolean // Strip old thinking blocks before API call
  narrationHistoryRedactionEnabled: boolean // Strip old inter-tool-call narration text before API call
  toolResultSummarizerEnabled: boolean // Summarize oversized Bash/Grep/WebFetch outputs as they enter history
  showTurnDuration: boolean // Controls whether to show turn duration message (e.g., "Cooked for 1m 6s")
  // Controls whether to show per-query cache hit/miss stats at the end of each turn.
  // 'off'     — no display
  // 'compact' — one-line summary (e.g. "[Cache: 1.2k read • hit 12%]")
  // 'full'    — breakdown (read / created / hit-rate) per query
  showCacheStats: ShowCacheStatsMode
  /**
   * @deprecated Use settings.env instead.
   */
  env: { [key: string]: string } // Environment variables to set for the CLI
  hasSeenTasksHint?: boolean // Whether the user has seen the tasks hint
  hasUsedStash?: boolean // Whether the user has used the stash feature (Ctrl+S)
  hasUsedBackgroundTask?: boolean // Whether the user has backgrounded a task (Ctrl+B)
  queuedCommandUpHintCount?: number // Counter for how many times the user has seen the queued command up hint
  diffTool?: DiffTool // Which tool to use for displaying diffs (terminal or vscode)

  // Terminal setup state tracking
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // Path to the backup file for iTerm2 preferences
  appleTerminalBackupPath?: string // Path to the backup file for Terminal.app preferences
  appleTerminalSetupInProgress?: boolean // Whether Terminal.app setup is currently in progress

  // Key binding setup tracking
  shiftEnterKeyBindingInstalled?: boolean // Whether Shift+Enter key binding is installed (for iTerm2 or VSCode)
  optionAsMetaKeyInstalled?: boolean // Whether Option as Meta key is installed (for Terminal.app)

  // IDE configurations
  autoConnectIde?: boolean // Whether to automatically connect to IDE on startup if exactly one valid IDE is available
  autoInstallIdeExtension?: boolean // Whether to automatically install IDE extensions when running from within an IDE

  // IDE dialogs
  hasIdeOnboardingBeenShown?: Record<string, boolean> // Map of terminal name to whether IDE onboarding has been shown
  ideHintShownCount?: number // Number of times the /ide command hint has been shown
  hasIdeAutoConnectDialogBeenShown?: boolean // Whether the auto-connect IDE dialog has been shown

  tipsHistory: {
    [tipId: string]: number // Key is tipId, value is the numStartups when tip was last shown
  }

  // /buddy companion soul — bones regenerated from userId on read. See src/terminal/buddy/.
  companion?: import('src/terminal/buddy/types.js').StoredCompanion
  companionMuted?: boolean

  // Feedback survey tracking
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // Transcript share prompt tracking ("Don't ask again")
  transcriptShareDismissed?: boolean

  // Memory usage tracking
  memoryUsageCount: number // Number of times user has added to memory

  // Sonnet-1M configs
  hasShownS1MWelcomeV2?: Record<string, boolean> // Whether the Sonnet-1M v2 welcome message has been shown per org
  // Cache of Sonnet-1M subscriber access per org - key is org ID
  // hasAccess means "hasAccessAsDefault" but the old name is kept for backward
  // compatibility.
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  // Cache of Sonnet-1M PayG access per org - key is org ID
  // hasAccess means "hasAccessAsDefault" but the old name is kept for backward
  // compatibility.
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // Opus 1M merge notice tracking
  opus1mMergeNoticeSeenCount?: number // Number of times the opus-1m-merge notice has been shown

  // Experiment enrollment notice tracking (keyed by experiment id)
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan experiment config
  hasShownOpusPlanWelcome?: Record<string, boolean> // Whether the OpusPlan welcome message has been shown per org

  // Queue usage tracking
  promptQueueUseCount: number // Number of times use has used the prompt queue

  // Btw usage tracking
  btwUseCount: number // Number of times user has used /btw

  // Plan mode usage tracking
  lastPlanModeUse?: number // Timestamp of last plan mode usage

  // Subscription notice tracking
  subscriptionNoticeCount?: number // Number of times the subscription notice has been shown
  hasAvailableSubscription?: boolean // Cached result of whether user has a subscription available
  subscriptionUpsellShownCount?: number // Number of times the subscription upsell has been shown (deprecated)
  recommendedSubscription?: string // Cached config value from Statsig (deprecated)

  // Todo feature configuration
  todoFeatureEnabled: boolean // Whether the todo feature is enabled
  showExpandedTodos?: boolean // Whether to show todos expanded, even when empty
  showSpinnerTree?: boolean // Whether to show the teammate spinner tree instead of pills

  // First start time tracking
  firstStartTime?: string // ISO timestamp when Claude Code was first started on this machine

  messageIdleNotifThresholdMs: number // How long the user has to have been idle to get a notification that Claude is done generating

  githubActionSetupCount?: number // Number of times the user has set up the GitHub Action
  slackAppInstallCount?: number // Number of times the user has clicked to install the Slack app

  // File checkpointing configuration
  fileCheckpointingEnabled: boolean

  // Terminal progress bar configuration (OSC 9;4)
  terminalProgressBarEnabled: boolean

  // Terminal tab status indicator (OSC 21337). When on, emits a colored
  // dot + status text to the tab sidebar and drops the spinner prefix
  // from the title (the dot makes it redundant).
  showStatusInTerminalTab?: boolean

  // Push-notification toggles (set via /config). Default off — explicit opt-in required.
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // Claude Code usage tracking
  claudeCodeFirstTokenDate?: string // ISO timestamp of the user's first Claude Code OAuth token

  // Model switch callout tracking (internal-only)
  modelSwitchCalloutDismissed?: boolean // Whether user chose "Don't show again"
  modelSwitchCalloutLastShown?: number // Timestamp of last shown (don't show for 24h)
  modelSwitchCalloutVersion?: string

  // Effort callout tracking - shown once for Opus 4.6 users
  effortCalloutDismissed?: boolean // v1 - legacy, read to suppress v2 for Pro users who already saw it
  effortCalloutV2Dismissed?: boolean

  // Remote callout tracking - shown once before first bridge enable
  remoteDialogSeen?: boolean

  // Cross-process backoff for initReplBridge's oauth_expired_unrefreshable skip.
  // `expiresAt` is the dedup key — content-addressed, self-clears when /login
  // replaces the token. `failCount` caps false positives: transient refresh
  // failures (auth server 5xx, lock errors) get 3 retries before backoff kicks
  // in, mirroring useReplBridge's MAX_CONSECUTIVE_INIT_FAILURES. Dead-token
  // accounts cap at 3 config writes; healthy+transient-blip self-heals in ~210s.
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // Desktop upsell startup dialog tracking
  desktopUpsellSeenCount?: number // Total showings (max 3)
  desktopUpsellDismissed?: boolean // "Don't ask again" picked

  // Idle-return dialog tracking
  idleReturnDismissed?: boolean // "Don't ask again" picked

  // Opus 4.5 Pro migration tracking
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number

  // Sonnet 4.5 1m migration tracking
  sonnet1m45MigrationComplete?: boolean

  // Opus 4.0/4.1 → current Opus migration (shows one-time notif)
  legacyOpusMigrationTimestamp?: number

  // Sonnet 4.5 → 4.6 migration (pro/max/team premium)
  sonnet45To46MigrationTimestamp?: number

  // Cached statsig gate values
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // Cached statsig dynamic configs
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // Cached GrowthBook feature values
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // Local GrowthBook overrides (internal-only, set via /config Gates tab).
  // Checked after env-var overrides but before the real resolved value.
  growthBookOverrides?: { [featureName: string]: unknown }

  // Emergency tip tracking - stores the last shown tip to prevent re-showing
  lastShownEmergencyTip?: string

  // File picker gitignore behavior
  respectGitignore: boolean // Whether file picker should respect .gitignore files (default: true). Note: .ignore files are always respected

  // Copy command behavior
  copyFullResponse: boolean // Whether /copy always copies the full response instead of showing the picker

  // Fullscreen in-app text selection behavior
  copyOnSelect?: boolean // Auto-copy to clipboard on mouse-up (undefined → true; lets cmd+c "work" via no-op)

  // Whether the auto-memory extractor surfaces a "Saved N memory" system
  // notice in the chat after each save. undefined/false → silent (default in
  // Claudin because the message fired on nearly every turn). Set to true to
  // restore upstream's behaviour.
  notifyMemorySaved?: boolean

  // Flicker-free fullscreen mode (equivalent to CLAUDIN_NO_FLICKER=1 env var).
  // When true, enables alt-screen + virtualized scroll for all users.
  // Env var still takes precedence: =0 always off, =1 always on.
  flickerFreeMode?: boolean

  // TUI frame rate: 'auto' (120fps on GPU terminals, 60fps otherwise) or an
  // explicit nominal rate. Drives both the animation clock and the paint
  // throttle, identically in inline and fullscreen. Resolved once at boot by
  // utils/renderCadence.ts, so a change applies on the next launch. Env var
  // CLAUDIN_FPS still takes precedence.
  renderFrameRate?: 'auto' | '120' | '240' | '360'

  // GitHub repo path mapping for teleport directory switching
  // Key: "owner/repo" (lowercase), Value: array of absolute paths where repo is cloned
  githubRepoPaths?: Record<string, string[]>

  // Terminal emulator to launch for claude-cli:// deep links. Captured from
  // TERM_PROGRAM during interactive sessions since the deep link handler runs
  // headless (LaunchServices/xdg) with no TERM_PROGRAM set.
  deepLinkTerminal?: string

  // iTerm2 it2 CLI setup
  iterm2It2SetupComplete?: boolean // Whether it2 setup has been verified
  preferTmuxOverIterm2?: boolean // User preference to always use tmux over iTerm2 split panes

  // Skill usage tracking for autocomplete ranking
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // Official marketplace auto-install tracking
  officialMarketplaceAutoInstallAttempted?: boolean // Whether auto-install was attempted
  officialMarketplaceAutoInstalled?: boolean // Whether auto-install succeeded
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // Reason for failure if applicable
  officialMarketplaceAutoInstallRetryCount?: number // Number of retry attempts
  officialMarketplaceAutoInstallLastAttemptTime?: number // Timestamp of last attempt
  officialMarketplaceAutoInstallNextRetryTime?: number // Earliest time to retry again

  // Claude Code hint protocol state (<claude-code-hint /> tags from CLIs/SDKs).
  // Nested by hint type so future types (docs, mcp, ...) slot in without new
  // top-level keys.
  claudeCodeHints?: {
    // Plugin IDs the user has already been prompted for. Show-once semantics:
    // recorded regardless of yes/no response, never re-prompted. Capped at
    // 100 entries to bound config growth — past that, hints stop entirely.
    plugin?: string[]
    // User chose "don't show plugin installation hints again" from the dialog.
    disabled?: boolean
  }

  // Permission explainer configuration
  permissionExplainerEnabled?: boolean // Enable Haiku-generated explanations for permission requests (default: true)

  // Teammate spawn mode: 'auto' | 'tmux' | 'in-process'
  teammateMode?: 'auto' | 'tmux' | 'in-process' // How to spawn teammates (default: 'auto')
  // Model for new teammates when the tool call doesn't pass one.
  // undefined = hardcoded Opus (backward-compat); null = leader's model; string = model alias/ID.
  teammateDefaultModel?: string | null

  // PR status footer configuration (feature-flagged via GrowthBook)
  prStatusFooterEnabled?: boolean // Show PR review status in footer (default: true)
  // Maps a git remote host to the platform whose CLI resolves its PR/MR status.
  // Overrides the built-in auto-detection (gitlab.com→gitlab, codeberg.org→gitea,
  // everything else→github). Use 'none' to silence the pill for a host.
  // Example: { "git.corp.com": "gitlab", "code.corp.com": "gitea" }
  prStatusHosts?: Record<string, 'github' | 'gitlab' | 'gitea' | 'none'>

  // Cached org-level fast mode status from the API.
  // Used to detect cross-session changes and notify users.
  penguinModeOrgEnabled?: boolean

  // Epoch ms when background refreshes last ran (fast mode, quota, passes, client data).
  // Used with tengu_cicada_nap_ms to throttle API calls
  startupPrefetchedAt?: number

  // Run Remote Control at startup (requires BRIDGE_MODE)
  // undefined = use default (see getRemoteControlAtStartup() for precedence)
  remoteControlAtStartup?: boolean

  // Cached extra usage disabled reason from the last API response
  // undefined = no cache, null = extra usage enabled, string = disabled reason.
  cachedExtraUsageDisabledReason?: string | null

  // Auto permissions notification tracking (internal-only)
  autoPermissionsNotificationCount?: number // Number of times the auto permissions notification has been shown

  // Speculation configuration (internal-only)
  speculationEnabled?: boolean // Whether speculation is enabled (default: true)


  // Client data for server-side experiments (fetched during bootstrap).
  clientDataCache?: Record<string, unknown> | null

  // Additional model options for the model picker (fetched during bootstrap).
  additionalModelOptionsCache?: ModelOption[]
  additionalModelOptionsCacheScope?: string

  // Additional model options discovered from OpenAI-compatible endpoints.
  openaiAdditionalModelOptionsCache?: ModelOption[]

  // Provider profiles managed inside the TUI. The active profile determines
  // which API provider env vars are applied for the current session.
  providerProfiles?: ProviderProfile[]
  activeProviderProfileId?: string

  // Per-agent model overrides keyed by agentType. Lets users pick a custom
  // model for built-in agents (e.g. Plan, Code) without producing a
  // shadow .md file. Value 'inherit' is allowed and means "use the parent
  // conversation model" — same semantics as a missing entry, but stored
  // explicitly so the UI can show that the user has chosen inherit.
  agentModelOverrides?: Record<string, string>

  // Per-profile cache for models discovered from OpenAI-compatible endpoints.
  // Keyed by provider profile id.
  openaiAdditionalModelOptionsCacheByProfile?: Record<string, ModelOption[]>

  // Disk cache for /api/claude_code/organizations/metrics_enabled.
  // Org-level settings change rarely; persisting across processes avoids a
  // cold API call on every `claude -p` invocation.
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // Version of the last-applied migration set. When equal to
  // CURRENT_MIGRATION_VERSION, runMigrations() skips all sync migrations
  // (avoiding 11× saveGlobalConfig lock+re-read on every startup).
  migrationVersion?: number

  // ~/.claude/ -> ~/.claudin/ migration tracking. Set when the user
  // accepts the banner in /provider (or runs `/provider migrate`); the
  // banner won't show again afterwards. Independent from migrationVersion
  // because it's a one-shot user action, not a schema migration.
  claudeToClaudinMigratedAt?: string
  // Set when the user explicitly skips the legacy /provider migration banner
  // ("Skip — start fresh"). Suppresses the banner for future sessions.
  legacyMigrationSkipped?: boolean

  // Knowledge Graph configuration
  knowledgeGraphEnabled: boolean

  // Bash output filter (roadmap 6.1) — Phase 3+ reads these; undefined → true (default on since Phase 7)
  bashOutputFilterEnabled?: boolean
  bashOutputFilterRewriteEnabled?: boolean
  bashOutputFilterUserEnabled?: boolean
  // The floor's head/tail line cap, separately switchable because it is the one
  // stage that can delete the line that mattered — everything else the filter
  // does is either lossless or fenced to output it recognises. undefined → true.
  // Env CLAUDIN_DISABLE_BASH_FILTER_CAP turns it off regardless.
  bashOutputFilterCapEnabled?: boolean

  // Auto-background agents — when on, subagents launch directly in the
  // background (task-notification on completion) instead of running inline.
  // undefined → false (opt-in): a backgrounded spawn's report only reaches the
  // parent in a LATER turn, so the parent has to be written for it. Env
  // CLAUDIN_AUTO_BACKGROUND_TASKS overrides to on. Even when on, one-shot
  // built-ins and an explicit run_in_background:false stay inline — see
  // AgentTool/autoBackground.ts. Independent of whether fork exists.
  autoBackgroundAgentsEnabled?: boolean

  // Repeated-failure hint — appends a <system-reminder> to an errored
  // tool_result once the same (tool, canonical input) has failed 3× in a row.
  // Applies to EVERY tool, so it gets a toggle like every other default-on
  // behavior. undefined → true (default on).
  repeatedFailureHintEnabled?: boolean

  // Collapse file writes — folds Write/Edit/apply_patch/Rename into the same
  // collapsed row as reads/searches ("edited 3 files  +42 −7"), with the diffs
  // behind Ctrl+O. Off restores a full diff block per write.
  // undefined → true (default on).
  collapseFileWritesEnabled?: boolean

  // Workflows run in background — when on, a Workflow tool call the model leaves
  // unspecified defaults to background (returns a runId immediately + notifies on
  // completion) instead of blocking the turn, and the /workflows dialog runs its
  // run detached. undefined/false → off (opt-in). Never backgrounds in headless -p
  // (getIsNonInteractiveSession gate) to avoid orphaned runs.
  workflowsDefaultBackground?: boolean

  // Preferred browser binary used by OAuth flows (Anthropic sign-in, Codex,
  // GitHub Copilot, MCP). Overrides Linux auto-detection but is overridden by
  // $BROWSER. Path or bare binary name (e.g. "brave-browser"). undefined → use
  // detection chain in src/shared/browser.ts.
  oauthBrowser?: string

  // Inline terminal images (T5.29). 'auto' (default) detects Kitty-family
  // terminals; 'enable' is semantically auto with explicit intent; 'disable'
  // forces the legacy text/hyperlink fallback even on supported terminals.
  inlineImagesMode?: 'auto' | 'enable' | 'disable'

  // Picker favorites — entries starred with ctrl+f in /model and /provider,
  // pinned to the top of their list. Deliberately absent from
  // GLOBAL_CONFIG_KEYS: they are set from the picker, not from
  // `claudin config set`. Model ids and profile ids respectively; a profile
  // deleted while starred leaves an orphan id, filtered on read.
  favoriteModels?: string[]
  favoriteProviderProfiles?: string[]
}

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }
