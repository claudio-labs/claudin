// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// The headless streaming host: builds the shared `HeadlessStreamingContext`,
// installs the process-level listeners, and starts the two concurrent tasks
// (the stdin control loop in `controlLoop.ts` and the turn loop in
// `turnLoop.ts`). Extracted from `src/cli/print/runHeadless.ts` as the deferred
// half of ROADMAP 11b.
//
// ORDER OF SIDE EFFECTS IS LOAD-BEARING and is preserved from the original
// single-closure version:
//   1. SIGINT handler + SIGTERM state dump
//   2. permission-mode → SDK-output listener
//   3. AWS auth-status and rate-limit listeners
//   4. auto-resume of an interrupted turn (enqueues BEFORE anything can drain)
//   5. `void updateSdkMcp()` — starts before plugin install, which may re-diff
//   6. background plugin install (or the sync-install promise)
//   7. skill-change hot reload, command-queue interrupt subscription
//   8. UDS inbox callback, cron scheduler
//   9. orphaned-permission callback
//  10. the stdin loop
//
// The context object is constructed FIRST, before any of the above, so that the
// listeners can reference `ctx` fields that used to be lexical `let`s. That is
// safe because construction is fully synchronous — no signal, timer or stdin
// chunk can interleave with it.

import { feature } from 'bun:bundle'
import { cwd } from 'process'
import { randomUUID } from 'crypto'
import type { StructuredIO } from 'src/cli/structuredIO.js'
import type { Command } from 'src/commands.js'
import type { Tools } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { TurnInterruptionState } from 'src/utils/conversationRecovery.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
} from 'src/services/mcp/types.js'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type {
  SDKUserMessageReplay,
  PermissionMode,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import { extractReadFilesFromMessages } from 'src/utils/queryHelpers.js'
import { enqueue, subscribeToCommandQueue, getCommandsByMaxPriority } from 'src/utils/messageQueueManager.js'
import {
  getSessionState,
  setPermissionModeChangedListener,
} from 'src/utils/sessionState.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import {
  gracefulShutdown,
} from 'src/utils/gracefulShutdown.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { createIdleTimeoutManager } from 'src/utils/idleTimeout.js'
import { AwsAuthStatusManager } from 'src/utils/awsAuthStatusManager.js'
import {
  statusListeners,
  type ClaudeAILimits,
} from 'src/services/claudeAiLimits.js'
import { toSDKRateLimitInfo } from 'src/utils/messages/mappers.js'
import { createModelSwitchBreadcrumbs } from 'src/utils/messages.js'
import { LOCAL_COMMAND_STDOUT_TAG, TICK_TAG } from 'src/constants/xml.js'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import {
  getDefaultMainLoopModel,
  modelDisplayString,
  parseUserSpecifiedModel,
} from 'src/utils/model/model.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  EFFORT_LEVELS,
} from 'src/utils/effort.js'
import { modelSupportsAdaptiveThinking } from 'src/utils/thinking.js'
import { modelSupportsAutoMode } from 'src/utils/betas.js'
import { isFastModeSupportedByModel } from 'src/utils/fastMode.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { getCommands, clearCommandsCache } from '../../commands.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import { getRunningTasks } from '../../utils/task/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { removeInterruptedMessage } from 'src/cli/print/messageOps.js'
import { handleOrphanedPermissionResponse } from 'src/cli/print/orphanPermission.js'
import { proactiveModule } from 'src/cli/print/headlessOptionalModules.js'
import {
  registerElicitationHandlers,
  updateSdkMcp,
  buildAllTools,
  forwardMessagesToBridge,
  applyMcpServerChanges,
  buildMcpServerStatuses,
  installPluginsAndApplyMcpInBackground,
  refreshPluginState,
  applyPluginMcpDiff,
} from 'src/cli/print/mcpRuntime.js'
import { runTurnLoop, closeHeadlessOutput } from 'src/cli/print/turnLoop.js'
import { runControlLoop } from 'src/cli/print/controlLoop.js'
import type {
  HeadlessStreamingContext,
  HeadlessStreamingOptions,
  SuggestionState,
} from 'src/cli/print/streamingContext.js'

// Dead code elimination: conditional imports
/* eslint-disable @typescript-eslint/no-require-imports */
const cronSchedulerModule = require('../../utils/cronScheduler.js') as typeof import('../../utils/cronScheduler.js')
const cronJitterConfigModule = require('../../utils/cronJitterConfig.js') as typeof import('../../utils/cronJitterConfig.js')
const cronGate = require('../../tools/ScheduleCronTool/prompt.js') as typeof import('../../tools/ScheduleCronTool/prompt.js')
/* eslint-enable @typescript-eslint/no-require-imports */

export function runHeadlessStreaming(
  structuredIO: StructuredIO,
  mcpClients: MCPServerConnection[],
  commands: Command[],
  tools: Tools,
  initialMessages: Message[],
  canUseTool: CanUseToolFn,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  agents: AgentDefinition[],
  options: HeadlessStreamingOptions,
  turnInterruptionState?: TurnInterruptionState,
): AsyncIterable<StdoutMessage> {
  // Same queue sendRequest() enqueues to — one FIFO for everything.
  const output = structuredIO.outbound

  // Prompt suggestion tracking (push model)
  const suggestionState: SuggestionState = {
    abortController: null,
    inflightPromise: null,
    lastEmitted: null,
    pendingSuggestion: null,
    pendingLastEmittedEntry: null,
  }

  // Messages for internal tracking, directly mutated by ask(). These messages
  // include Assistant, User, Attachment, and Progress messages.
  // TODO: Clean up this code to avoid passing around a mutable array.
  const mutableMessages: Message[] = initialMessages

  // Client-supplied readFileState seeds (via seed_read_state control request).
  // The stdin loop runs concurrently with ask() — a seed arriving mid-turn
  // would be lost to ask()'s clone-then-replace (QueryEngine.ts finally block)
  // if written directly into readFileState. Instead, seeds land here, merge
  // into getReadFileCache's view (readFileState-wins-ties: seeds fill gaps),
  // and are re-applied then CLEARED in setReadFileCache. One-shot: each seed
  // survives exactly one clone-replace cycle, then becomes a regular
  // readFileState entry subject to compact's clear like everything else.
  const pendingSeeds = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )

  const modelOptions = getModelOptions()
  const modelInfos = modelOptions.map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const hasEffort = modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    // Static per-model-family capability advertisement for the model picker,
    // NOT the runtime gate. Intentionally the name-based check, not
    // autoModeAllowedForModel: this maps over ALL candidate models, while the
    // probe cache is keyed by the ACTIVE provider — pairing the active provider
    // with a non-active model's key would be meaningless. Runtime entry is
    // still enforced by verifyAutoModeGateAccess (probe-gated for non-Claude).
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      value: modelId,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: modelSupportsMaxEffort(resolvedModel)
          ? [...EFFORT_LEVELS]
          : EFFORT_LEVELS.filter(l => l !== 'max'),
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
    }
  })

  // Idle timeout management. The predicate dereferences `ctx` lazily; it is
  // only ever called after construction completes.
  const idleTimeout = createIdleTimeoutManager(() => !ctx.running)

  // Set up AWS auth status listener if enabled
  let unsubscribeAuthStatus: (() => void) | undefined

  const rateLimitListener = (limits: ClaudeAILimits) => {
    const rateLimitInfo = toSDKRateLimitInfo(limits)
    if (rateLimitInfo) {
      output.enqueue({
        type: 'rate_limit_event',
        rate_limit_info: rateLimitInfo,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }

  // Subscribe to skill changes for hot reloading
  const unsubscribeSkillChanges = skillChangeDetector.subscribe(() => {
    clearCommandsCache()
    void getCommands(cwd()).then(newCommands => {
      ctx.currentCommands = newCommands
    })
  })

  const ctx: HeadlessStreamingContext = {
    // deps
    structuredIO,
    output,
    initialMcpClients: mcpClients,
    baseTools: tools,
    initialCommands: commands,
    initialAgents: agents,
    canUseTool,
    getAppState,
    setAppState,
    options,
    sdkMcpConfigs,
    mutableMessages,
    pendingSeeds,
    suggestionState,
    elicitationRegistered: new Set<string>(),
    modelInfos,
    idleTimeout,
    // Track active OAuth flows per server so we can abort a previous flow
    // when a new mcp_authenticate request arrives for the same server.
    activeOAuthFlows: new Map<string, AbortController>(),
    // Track manual callback URL submit functions for active OAuth flows.
    // Used when localhost is not reachable (e.g., browser-based IDEs).
    oauthCallbackSubmitters: new Map<string, (callbackUrl: string) => void>(),
    // Track servers where the manual callback was actually invoked (so the
    // automatic reconnect path knows to skip — the extension will reconnect).
    oauthManualCallbackUsed: new Set<string>(),
    // Track OAuth auth-only promises so mcp_oauth_callback_url can await
    // token exchange completion. Reconnect is handled separately by the
    // extension via handleAuthDone → mcp_reconnect.
    oauthAuthPromises: new Map<string, Promise<void>>(),

    // state
    running: false,
    runPhase: undefined,
    inputClosed: false,
    shutdownPromptInjected: false,
    heldBackResult: null,
    abortController: undefined,
    // Seed the readFileState cache from the transcript (content the model saw,
    // with message timestamps) so getChangedFiles can detect external edits.
    // This cache instance must persist across ask() calls, since the edit tool
    // relies on this as a global state.
    readFileState: extractReadFilesFromMessages(
      initialMessages,
      cwd(),
      READ_FILE_STATE_CACHE_SIZE,
    ),
    activeUserSpecifiedModel: options.userSpecifiedModel,
    // Cache SDK MCP clients to avoid reconnecting on each run
    sdkClients: [],
    sdkTools: [],
    // State for dynamically added MCP servers (via mcp_set_servers control
    // message). These are separate from SDK MCP servers and support all
    // transport types.
    dynamicMcpState: { clients: [], tools: [], configs: {} },
    // Bridge handle for remote-control (SDK control message).
    // Mirrors the REPL's useReplBridge hook: the handle is created when
    // `remote_control` is enabled and torn down when disabled.
    bridgeHandle: null,
    // Cursor into mutableMessages — tracks how far we've forwarded.
    // Same index-based diff as useReplBridge's lastWrittenIndexRef.
    bridgeLastForwardedIndex: 0,
    mcpChangesPromise: Promise.resolve({
      response: {
        added: [] as string[],
        removed: [] as string[],
        errors: {} as Record<string, string>,
      },
      sdkServersChanged: false,
    }),
    pluginInstallPromise: null,
    // Mutable commands and agents for hot reloading
    currentCommands: commands,
    currentAgents: agents,
    cronScheduler: null,
    // In-flight Anthropic OAuth flow (claude_authenticate). Single-slot: a
    // second authenticate request cleans up the first. The service holds the
    // PKCE verifier + localhost listener; the promise settles after
    // installOAuthTokens — after it resolves, the in-process memoized token
    // cache is already cleared and the next API call picks up the new creds.
    claudeOAuth: null,

    // wiring — thunks so the units stay mutually recursive
    run: () => runTurnLoop(ctx),
    updateSdkMcp: () => updateSdkMcp(ctx),
    applyMcpServerChanges: servers => applyMcpServerChanges(ctx, servers),
    refreshPluginState: () => refreshPluginState(ctx),
    applyPluginMcpDiff: () => applyPluginMcpDiff(ctx),
    buildAllTools: appState => buildAllTools(ctx, appState),
    registerElicitationHandlers: clients =>
      registerElicitationHandlers(ctx, clients),
    buildMcpServerStatuses: () => buildMcpServerStatuses(ctx),
    forwardMessagesToBridge: () => forwardMessagesToBridge(ctx),
    injectModelSwitchBreadcrumbs: (modelArg, resolvedModel) => {
      const breadcrumbs = createModelSwitchBreadcrumbs(
        modelArg,
        modelDisplayString(resolvedModel),
      )
      mutableMessages.push(...breadcrumbs)
      for (const crumb of breadcrumbs) {
        if (
          typeof crumb.message.content === 'string' &&
          crumb.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)
        ) {
          output.enqueue({
            type: 'user',
            message: crumb.message,
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: crumb.uuid,
            timestamp: crumb.timestamp,
            isReplay: true,
          } satisfies SDKUserMessageReplay)
        }
      }
    },
    sendControlResponseSuccess: (
      message: { request_id: string },
      response?: Record<string, unknown>,
    ) => {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: response,
        },
      })
    },
    sendControlResponseError: (
      message: { request_id: string },
      errorMessage: string,
    ) => {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: errorMessage,
        },
      })
    },
    // Proactive mode: schedule a tick to keep the model looping autonomously.
    // setTimeout(0) yields to the event loop so pending stdin messages
    // (interrupts, user messages) are processed before the tick fires.
    scheduleProactiveTick:
      feature('PROACTIVE') || feature('KAIROS')
        ? () => {
            setTimeout(() => {
              if (
                !proactiveModule?.isProactiveActive() ||
                proactiveModule.isProactivePaused() ||
                ctx.inputClosed
              ) {
                return
              }
              const tickContent = `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`
              enqueue({
                mode: 'prompt' as const,
                value: tickContent,
                uuid: randomUUID(),
                priority: 'later',
                isMeta: true,
              })
              void ctx.run()
            }, 0)
          }
        : undefined,
    closeOutput: () =>
      closeHeadlessOutput(ctx, unsubscribeSkillChanges, unsubscribeAuthStatus, () =>
        statusListeners.delete(rateLimitListener),
      ),
  }

  // Ctrl+C in -p mode: abort the in-flight query, then shut down gracefully.
  // gracefulShutdown persists session state and flushes analytics, with a
  // failsafe timer that force-exits if cleanup hangs.
  const sigintHandler = () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    if (ctx.abortController && !ctx.abortController.signal.aborted) {
      ctx.abortController.abort()
    }
    void gracefulShutdown(0)
  }
  process.on('SIGINT', sigintHandler)

  // Dump run()'s state at SIGTERM so a stuck session's healthsweep can name
  // the do/while(waitingForAgents) poll without reading the transcript.
  registerCleanup(async () => {
    const bg: Record<string, number> = {}
    for (const t of getRunningTasks(getAppState())) {
      if (isBackgroundTask(t)) bg[t.type] = (bg[t.type] ?? 0) + 1
    }
    logForDiagnosticsNoPII('info', 'run_state_at_shutdown', {
      run_active: ctx.running,
      run_phase: ctx.runPhase,
      worker_status: getSessionState(),
      internal_events_pending: structuredIO.internalEventsPending,
      bg_tasks: bg,
    })
  })

  // Wire the central onChangeAppState mode-diff hook to the SDK output stream.
  // This fires whenever ANY code path mutates toolPermissionContext.mode —
  // Shift+Tab, ExitPlanMode dialog, /plan slash command, rewind, bridge
  // set_permission_mode, the query loop, stop_task — rather than the two
  // paths that previously went through a bespoke wrapper.
  // The wrapper's body was fully redundant (it enqueued here AND called
  // notifySessionMetadataChanged, both of which onChangeAppState now covers);
  // keeping it would double-emit status messages.
  setPermissionModeChangedListener(newMode => {
    // Only emit for SDK-exposed modes.
    if (
      newMode === 'default' ||
      newMode === 'acceptEdits' ||
      newMode === 'bypassPermissions' ||
      newMode === 'plan' ||
      newMode === (feature('TRANSCRIPT_CLASSIFIER') && 'auto') ||
      newMode === 'dontAsk'
    ) {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: newMode as PermissionMode,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  })

  if (options.enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    unsubscribeAuthStatus = authStatusManager.subscribe(status => {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
  }

  // Set up rate limit status listener to emit SDKRateLimitEvent for all status
  // changes. Emitting for all statuses (including 'allowed') ensures consumers
  // can clear warnings when rate limits reset. The upstream emitStatusChange
  // already deduplicates via isEqual.
  statusListeners.add(rateLimitListener)

  // Auto-resume interrupted turns on restart so CC continues from where it
  // left off without requiring the SDK to re-send the prompt.
  const resumeInterruptedTurnEnv = process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  if (
    turnInterruptionState &&
    turnInterruptionState.kind !== 'none' &&
    resumeInterruptedTurnEnv
  ) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // Remove the interrupted message and its sentinel, then re-enqueue so
    // the model sees it exactly once. For mid-turn interruptions, the
    // deserialization layer transforms them into interrupted_prompt by
    // appending a synthetic "Continue from where you left off." message.
    removeInterruptedMessage(mutableMessages, turnInterruptionState.message)
    enqueue({
      mode: 'prompt',
      value: turnInterruptionState.message.message.content,
      uuid: randomUUID(),
    })
  }

  void ctx.updateSdkMcp()

  // Background plugin installation for all headless users
  // Installs marketplaces from extraKnownMarketplaces and missing enabled
  // plugins. CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true: resolved in run() before the
  // first query so plugins are guaranteed available on the first ask().
  // --bare / SIMPLE: skip plugin install. Scripted calls don't add plugins
  // mid-session; the next interactive run reconciles.
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) {
      ctx.pluginInstallPromise = installPluginsAndApplyMcpInBackground(ctx)
    } else {
      void installPluginsAndApplyMcpInBackground(ctx)
    }
  }

  // Abort the current operation when a 'now' priority message arrives.
  subscribeToCommandQueue(() => {
    if (ctx.abortController && getCommandsByMaxPriority('now').length > 0) {
      ctx.abortController.abort('interrupt')
    }
  })

  // Set up UDS inbox callback so the query loop is kicked off
  // when a message arrives via the UDS socket in headless mode.
  if (feature('UDS_INBOX')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setOnEnqueue } = require('../../utils/udsMessaging.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setOnEnqueue(() => {
      if (!ctx.inputClosed) {
        void ctx.run()
      }
    })
  }

  // Cron scheduler: runs scheduled_tasks.json tasks in SDK/-p mode.
  // Mirrors REPL's useScheduledTasks hook. Fired prompts enqueue + kick
  // off run() directly — unlike REPL, there's no queue subscriber here
  // that drains on enqueue while idle. The run() mutex makes this safe
  // during an active turn: the call no-ops and the post-run recheck at
  // the end of run() picks up the queued command.
  if (cronGate.isKairosCronEnabled()) {
    ctx.cronScheduler = cronSchedulerModule.createCronScheduler({
      onFire: prompt => {
        if (ctx.inputClosed) return
        enqueue({
          mode: 'prompt',
          value: prompt,
          uuid: randomUUID(),
          priority: 'later',
          // System-generated — matches useScheduledTasks.ts REPL equivalent.
          // Without this, messages.ts metaProp eval is {} → prompt leaks
          // into visible transcript when cron fires mid-turn in -p mode.
          isMeta: true,
        })
        void ctx.run()
      },
      isLoading: () => ctx.running || ctx.inputClosed,
      getJitterConfig: cronJitterConfigModule.getCronJitterConfig,
      isKilled: () => !cronGate.isKairosCronEnabled(),
    })
    ctx.cronScheduler.start()
  }

  // Handle unexpected permission responses by looking up the unresolved tool
  // call in the transcript and executing it
  const handledOrphanedToolUseIds = new Set<string>()
  structuredIO.setUnexpectedResponseCallback(async message => {
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      onEnqueued: () => {
        // The first message of a session might be the orphaned permission
        // check rather than a user prompt, so kick off the loop.
        void ctx.run()
      },
    })
  })

  // This is essentially spawning a parallel async task — we have two
  // running in parallel: one reading from stdin and adding to the
  // queue to be processed, and another reading from the queue,
  // processing and returning the result of the generation.
  // The process is complete when the input stream completes and
  // the last generation of the queue has completed.
  void runControlLoop(ctx)

  return output
}
