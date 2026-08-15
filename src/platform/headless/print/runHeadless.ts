// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// The headless `-p` / `--print` driver entry point.
//
// `runHeadless` does the one-shot setup a headless session needs (settings
// subscription, sandbox, session load, tool filtering, permission glue) and
// then consumes `runHeadlessStreaming`, formatting the final message according
// to `--output-format`. Everything streaming-related — the turn loop, the MCP
// runtime and the stdin control-request dispatcher — lives in sibling modules
// under `src/platform/headless/print/`; see the barrel header in `src/platform/headless/print.ts` for the
// full map. That split is the deferred half of ROADMAP 11b.
//
// Re-entrancy note: the streaming host registers process-global handlers
// (registerHookEventHandler, setPermissionModeChangedListener) and is designed
// to be called once per process. The CLI exits after -p completes, so a second
// invocation is never expected at runtime.

import { feature } from 'bun:bundle'
import type { Command } from 'src/commands/commands.js'
import { createStreamlinedTransformer } from 'src/agent/tools/streamlinedTransform.js'
import { installStreamJsonStdoutGuard } from 'src/terminal/render/streamJsonStdoutGuard.js'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import { filterToolsByDenyRules } from 'src/tools/tools.js'
import { toolMatchesName, type Tools } from 'src/tools/Tool.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import {
  notifySessionStateChanged,
  type RequiresActionDetails,
} from 'src/sessions/sessionState.js'
import {
  writeToStdout,
  registerProcessOutputErrorHandlers,
} from 'src/shared/proc/process.js'
import type { McpSdkServerConfig } from 'src/mcp/types.js'
import { validateUuid } from 'src/shared/data/uuid.js'
import { registerHookEventHandler } from 'src/platform/lifecycleHooks/hookEvents.js'
import { gracefulShutdownSync } from 'src/shared/proc/gracefulShutdown.js'
import type { SDKStatus, SDKMessage } from 'src/platform/entrypoints/agentSdkTypes.js'
import type { StdoutMessage } from 'src/platform/entrypoints/sdk/controlTypes.js'
import { getIsRemoteMode, getSessionId } from 'src/platform/bootstrap/state.js'
import { ensureModelStringsInitialized } from 'src/providers/model/modelStrings.js'
import {
  processSessionStartHooks,
  processSetupHooks,
  takeInitialUserMessage,
} from 'src/sessions/sessionStart.js'
import { settingsChangeDetector } from 'src/platform/settings/changeDetector.js'
import { applySettingsChange } from 'src/platform/settings/applySettingsChange.js'
import { isFastModeEnabled } from 'src/providers/fastMode.js'
import { restoreAgentFromSession } from 'src/sessions/sessionRestore.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  logHeadlessProfilerTurn,
} from 'src/platform/headlessProfiler.js'
import { saveAgentSetting } from 'src/sessions/sessionStorage.js'
import { getMainThreadAgentType } from 'src/platform/bootstrap/state.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { initializeGrowthBook } from 'src/platform/analytics/growthbook.js'
import { errorMessage } from 'src/shared/errors.js'
import { isExtractModeActive } from 'src/memory/memdir/paths.js'
import { getCanUseToolFn } from 'src/platform/headless/print/permissionGlue.js'
import { handleRewindFiles } from 'src/platform/headless/print/controlHandlers.js'
import { loadInitialMessages } from 'src/platform/headless/print/sessionLoad.js'
import { getStructuredIO } from 'src/platform/headless/print/structuredIOFactory.js'
import { proactiveModule } from 'src/platform/headless/print/headlessOptionalModules.js'
import { runHeadlessStreaming } from 'src/platform/headless/print/runHeadlessStreaming.js'

// Dead code elimination: conditional imports
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('src/agent/coordinator/coordinatorMode.js') as typeof import('src/agent/coordinator/coordinatorMode.js'))
  : null
const extractMemoriesModule = feature('EXTRACT_MEMORIES')
  ? (require('src/memory/extract/extractMemories.js') as typeof import('src/memory/extract/extractMemories.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  commands: Command[],
  tools: Tools,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  agents: AgentDefinition[],
  options: {
    continue: boolean | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    verbose: boolean | undefined
    outputFormat: string | undefined
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
    teleport: string | true | null | undefined
    sdkUrl: string | undefined
    replayUserMessages: boolean | undefined
    includePartialMessages: boolean | undefined
    forkSession: boolean | undefined
    rewindFiles: string | undefined
    enableAuthStatus: boolean | undefined
    agent: string | undefined
    setupTrigger?: 'init' | 'maintenance' | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
    setSDKStatus?: (status: SDKStatus) => void
  },
): Promise<void> {
  // In headless mode there is no React tree, so the useSettingsChange hook
  // never runs. Subscribe directly so that settings changes (including
  // managed-settings / policy updates) are fully applied.
  settingsChangeDetector.subscribe(source => {
    applySettingsChange(source, setAppState)

    // In headless mode, also sync the denormalized fastMode field from
    // settings. The TUI manages fastMode via the UI so it skips this.
    if (isFastModeEnabled()) {
      setAppState(prev => {
        const s = prev.settings as Record<string, unknown>
        const fastMode = s.fastMode === true && !s.fastModePerSessionOptIn
        return { ...prev, fastMode }
      })
    }
  })

  // Proactive activation is now handled in main.tsx before getTools() so
  // SleepTool passes isEnabled() filtering. This fallback covers the case
  // where CLAUDIN_PROACTIVE is set but main.tsx's check didn't fire
  // (e.g. env was injected by the SDK transport after argv parsing).
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule &&
    !proactiveModule.isProactiveActive() &&
    isEnvTruthy(process.env.CLAUDIN_PROACTIVE)
  ) {
    proactiveModule.activateProactive('command')
  }

  // Periodically force a full GC to keep memory usage in check
  if (typeof Bun !== 'undefined') {
    const gcTimer = setInterval(Bun.gc, 1000)
    gcTimer.unref()
  }

  // Start headless profiler for first turn
  headlessProfilerStartTurn()
  headlessProfilerCheckpoint('runHeadless_entry')

  // Initialize GrowthBook so feature flags take effect in headless mode.
  // Without this, the disk cache is empty and all flags fall back to defaults.
  void initializeGrowthBook()

  if (options.resumeSessionAt && !options.resume) {
    process.stderr.write(`Error: --resume-session-at requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && !options.resume) {
    process.stderr.write(`Error: --rewind-files requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && inputPrompt) {
    process.stderr.write(
      `Error: --rewind-files is a standalone operation and cannot be used with a prompt\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  const structuredIO = getStructuredIO(inputPrompt, options)

  // When emitting NDJSON for SDK clients, any stray write to stdout (debug
  // prints, dependency console.log, library banners) breaks the client's
  // line-by-line JSON parser. Install a guard that diverts non-JSON lines to
  // stderr so the stream stays clean. Must run before the first
  // structuredIO.write below.
  if (options.outputFormat === 'stream-json') {
    installStreamJsonStdoutGuard()
  }

  // #34044: if user explicitly set sandbox.enabled=true but deps are missing,
  // isSandboxingEnabled() returns false silently. Surface the reason so users
  // know their security config isn't being enforced.
  const sandboxUnavailableReason = SandboxManager.getSandboxUnavailableReason()
  if (sandboxUnavailableReason) {
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${sandboxUnavailableReason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    process.stderr.write(
      `\n⚠ Sandbox disabled: ${sandboxUnavailableReason}\n` +
        `  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n\n`,
    )
  } else if (SandboxManager.isSandboxingEnabled()) {
    // Initialize sandbox with a callback that forwards network permission
    // requests to the SDK host via the can_use_tool control_request protocol.
    // This must happen after structuredIO is created so we can send requests.
    try {
      await SandboxManager.initialize(structuredIO.createSandboxAskCallback())
    } catch (err) {
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`)
      gracefulShutdownSync(1, 'other')
      return
    }
  }

  if (options.outputFormat === 'stream-json' && options.verbose) {
    registerHookEventHandler(event => {
      const message: StdoutMessage = (() => {
        switch (event.type) {
          case 'started':
            return {
              type: 'system' as const,
              subtype: 'hook_started' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'progress':
            return {
              type: 'system' as const,
              subtype: 'hook_progress' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              stdout: event.stdout,
              stderr: event.stderr,
              output: event.output,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'response':
            return {
              type: 'system' as const,
              subtype: 'hook_response' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              output: event.output,
              stdout: event.stdout,
              stderr: event.stderr,
              exit_code: event.exitCode,
              outcome: event.outcome,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
        }
      })()
      void structuredIO.write(message)
    })
  }

  if (options.setupTrigger) {
    await processSetupHooks(options.setupTrigger)
  }

  headlessProfilerCheckpoint('before_loadInitialMessages')
  // NOTE deliberately NOT seeding appState.mainLoopModel here: the resolution
  // chains in query.ts/advisor/spawnMultiAgent treat appState as the highest-
  // priority source, and the headless set_model control handlers and CCRv2
  // resume metadata only update the bootstrap override — a startup seed would
  // permanently shadow those later switches. Instead, the consumers fall back
  // to the LIVE override chain (getUserSpecifiedModelSetting/getMainLoopModel).
  const appState = getAppState()
  const {
    messages: initialMessages,
    turnInterruptionState,
    agentSetting: resumedAgentSetting,
  } = await loadInitialMessages(setAppState, {
    continue: options.continue,
    teleport: options.teleport,
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
    restoredWorkerState: structuredIO.restoredWorkerState,
  })

  // SessionStart hooks can emit initialUserMessage — the first user turn for
  // headless orchestrator sessions where stdin is empty and additionalContext
  // alone (an attachment, not a turn) would leave the REPL with nothing to
  // respond to. The hook promise is awaited inside loadInitialMessages, so the
  // module-level pending value is set by the time we get here.
  const hookInitialUserMessage = takeInitialUserMessage()
  if (hookInitialUserMessage) {
    structuredIO.prependUserMessage(hookInitialUserMessage)
  }

  // Restore agent setting from the resumed session (if not overridden by current --agent flag
  // or settings-based agent, which would already have set mainThreadAgentType in main.tsx)
  if (!options.agent && !getMainThreadAgentType() && resumedAgentSetting) {
    const { agentDefinition: restoredAgent } = restoreAgentFromSession(
      resumedAgentSetting,
      undefined,
      { activeAgents: agents, allAgents: agents },
    )
    if (restoredAgent) {
      setAppState(prev => ({ ...prev, agent: restoredAgent.agentType }))
      // Apply the agent's system prompt for non-built-in agents (mirrors main.tsx initial --agent path)
      if (!options.systemPrompt && !isBuiltInAgent(restoredAgent)) {
        const agentSystemPrompt = restoredAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }
      // Re-persist agent setting so future resumes maintain the agent
      saveAgentSetting(restoredAgent.agentType)
    }
  }

  // gracefulShutdownSync schedules an async shutdown and sets process.exitCode.
  // If a loadInitialMessages error path triggered it, bail early to avoid
  // unnecessary work while the process winds down.
  if (initialMessages.length === 0 && process.exitCode !== undefined) {
    return
  }

  // Handle --rewind-files: restore filesystem and exit immediately
  if (options.rewindFiles) {
    // File history snapshots are only created for user messages,
    // so we require the target to be a user message
    const targetMessage = initialMessages.find(
      m => m.uuid === options.rewindFiles,
    )

    if (!targetMessage || targetMessage.type !== 'user') {
      process.stderr.write(
        `Error: --rewind-files requires a user message UUID, but ${options.rewindFiles} is not a user message in this session\n`,
      )
      gracefulShutdownSync(1)
      return
    }

    const currentAppState = getAppState()
    const result = await handleRewindFiles(
      options.rewindFiles as UUID,
      currentAppState,
      setAppState,
      false,
    )
    if (!result.canRewind) {
      process.stderr.write(`Error: ${result.error || 'Unexpected error'}\n`)
      gracefulShutdownSync(1)
      return
    }

    // Rewind complete - exit successfully
    process.stdout.write(
      `Files rewound to state at message ${options.rewindFiles}\n`,
    )
    gracefulShutdownSync(0)
    return
  }

  // Check if we need input prompt - skip if we're resuming with a valid session ID/JSONL file or using SDK URL
  const hasValidResumeSessionId =
    typeof options.resume === 'string' &&
    (Boolean(validateUuid(options.resume)) || options.resume.endsWith('.jsonl'))
  const isUsingSdkUrl = Boolean(options.sdkUrl)

  if (!inputPrompt && !hasValidResumeSessionId && !isUsingSdkUrl) {
    process.stderr.write(
      `Error: Input must be provided either through stdin or as a prompt argument when using --print\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  if (options.outputFormat === 'stream-json' && !options.verbose) {
    process.stderr.write(
      'Error: When using --print, --output-format=stream-json requires --verbose\n',
    )
    gracefulShutdownSync(1)
    return
  }

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(
    appState.mcp.tools,
    appState.toolPermissionContext,
  )
  let filteredTools = [...tools, ...allowedMcpTools]

  // When using SDK URL, always use stdio permission prompting to delegate to the SDK
  const effectivePermissionPromptToolName = options.sdkUrl
    ? 'stdio'
    : options.permissionPromptToolName

  // Callback for when a permission prompt is shown
  const onPermissionPrompt = (details: RequiresActionDetails) => {
    if (feature('COMMIT_ATTRIBUTION')) {
      setAppState(prev => ({
        ...prev,
        attribution: {
          ...prev.attribution,
          permissionPromptCount: prev.attribution.permissionPromptCount + 1,
        },
      }))
    }
    notifySessionStateChanged('requires_action', details)
  }

  const canUseTool = getCanUseToolFn(
    effectivePermissionPromptToolName,
    structuredIO,
    () => getAppState().mcp.tools,
    onPermissionPrompt,
  )
  if (options.permissionPromptToolName) {
    // Remove the permission prompt tool from the list of available tools.
    filteredTools = filteredTools.filter(
      tool => !toolMatchesName(tool, options.permissionPromptToolName!),
    )
  }

  // Install errors handlers to gracefully handle broken pipes (e.g., when parent process dies)
  registerProcessOutputErrorHandlers()

  headlessProfilerCheckpoint('after_loadInitialMessages')

  // Ensure model strings are initialized before generating model options.
  // For Bedrock users, this waits for the profile fetch to get correct region strings.
  await ensureModelStringsInitialized()
  headlessProfilerCheckpoint('after_modelStrings')

  // UDS inbox store registration is deferred until after `run` is defined
  // so we can pass `run` as the onEnqueue callback (see below).

  // Only `json` + `verbose` needs the full array (jsonStringify(messages) below).
  // For stream-json (SDK/CCR) and default text output, only the last message is
  // read for the exit code / final result. Avoid accumulating every message in
  // memory for the entire session.
  const needsFullArray = options.outputFormat === 'json' && options.verbose
  const messages: SDKMessage[] = []
  let lastMessage: SDKMessage | undefined
  // Streamlined mode transforms messages when CLAUDIN_STREAMLINED_OUTPUT=true and using stream-json
  // Build flag gates this out of external builds; env var is the runtime opt-in for ant builds
  const transformToStreamlined =
    feature('STREAMLINED_OUTPUT') &&
    isEnvTruthy(process.env.CLAUDIN_STREAMLINED_OUTPUT) &&
    options.outputFormat === 'stream-json'
      ? createStreamlinedTransformer()
      : null

  headlessProfilerCheckpoint('before_runHeadlessStreaming')
  for await (const message of runHeadlessStreaming(
    structuredIO,
    appState.mcp.clients,
    [...commands, ...appState.mcp.commands],
    filteredTools,
    initialMessages,
    canUseTool,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    agents,
    options,
    turnInterruptionState,
  )) {
    if (transformToStreamlined) {
      // Streamlined mode: transform messages and stream immediately
      const transformed = transformToStreamlined(message)
      if (transformed) {
        await structuredIO.write(transformed)
      }
    } else if (options.outputFormat === 'stream-json' && options.verbose) {
      await structuredIO.write(message)
    }
    // Should not be getting control messages or stream events in non-stream mode.
    // Also filter out streamlined types since they're only produced by the transformer.
    // SDK-only system events are excluded so lastMessage stays at the result
    // (session_state_changed(idle) and any late task_notification drain after
    // result in the finally block).
    if (
      message.type !== 'control_response' &&
      message.type !== 'control_request' &&
      message.type !== 'control_cancel_request' &&
      !(
        message.type === 'system' &&
        (message.subtype === 'session_state_changed' ||
          message.subtype === 'task_notification' ||
          message.subtype === 'task_started' ||
          message.subtype === 'task_progress' ||
          message.subtype === 'post_turn_summary')
      ) &&
      message.type !== 'stream_event' &&
      message.type !== 'keep_alive' &&
      message.type !== 'streamlined_text' &&
      message.type !== 'streamlined_tool_use_summary' &&
      message.type !== 'prompt_suggestion'
    ) {
      // `message` here is `StdoutMessage` (controlTypes.ts) — a direct
      // z.infer of the schema union, so its assistant/user arms carry
      // `message: unknown` (APIAssistantMessagePlaceholder in
      // coreSchemas.ts). `SDKMessage` (coreTypes.generated.ts) is the same
      // set of arms but hand-patched to the real API message shape. The
      // narrowing above already proves `message` isn't one of the
      // StdoutMessage-only variants (control/stream/keep_alive/streamlined/
      // prompt_suggestion), so this is a type-shape gap, not a real mismatch.
      const sdkMessage = message as unknown as SDKMessage
      if (needsFullArray) {
        messages.push(sdkMessage)
      }
      lastMessage = sdkMessage
    }
  }

  switch (options.outputFormat) {
    case 'json':
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      if (options.verbose) {
        writeToStdout(jsonStringify(messages) + '\n')
        break
      }
      writeToStdout(jsonStringify(lastMessage) + '\n')
      break
    case 'stream-json':
      // already logged above
      break
    default:
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      switch (lastMessage.subtype) {
        case 'success':
          writeToStdout(
            lastMessage.result.endsWith('\n')
              ? lastMessage.result
              : lastMessage.result + '\n',
          )
          break
        case 'error_during_execution':
          writeToStdout(`Execution error`)
          break
        case 'error_max_turns':
          writeToStdout(`Error: Reached max turns (${options.maxTurns})`)
          break
        case 'error_max_budget_usd':
          writeToStdout(`Error: Exceeded USD budget (${options.maxBudgetUsd})`)
          break
        case 'error_max_structured_output_retries':
          writeToStdout(
            `Error: Failed to provide valid structured output after maximum retries`,
          )
      }
  }

  // Log headless latency metrics for the final turn
  logHeadlessProfilerTurn()

  // Drain any in-flight memory extraction before shutdown. The response is
  // already flushed above, so this adds no user-visible latency — it just
  // delays process exit so gracefulShutdownSync's 5s failsafe doesn't kill
  // the forked agent mid-flight. Gated by isExtractModeActive so the
  // tengu_slate_thimble flag controls non-interactive extraction end-to-end.
  if (feature('EXTRACT_MEMORIES') && isExtractModeActive()) {
    await extractMemoriesModule!.drainPendingExtraction()
  }

  gracefulShutdownSync(
    lastMessage?.type === 'result' && lastMessage?.is_error ? 1 : 0,
  )
}
