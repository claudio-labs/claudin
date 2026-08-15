// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// The headless turn loop — the `run()` closure extracted from
// `runHeadlessStreaming` in `src/platform/headless/print/runHeadless.ts` as the deferred half
// of ROADMAP 11b.
//
// `runTurnLoop` drains the command queue, calls `ask()` per batch, streams the
// resulting SDK messages, then handles the post-turn tail: proactive ticks,
// teammate inbox polling, swarm shutdown and (when stdin is closed) closing the
// output stream.
//
// RE-ENTRANCY: `ctx.running` is the mutex. `runTurnLoop` returns immediately if
// a run is already in flight, and the bottom of the function re-checks the
// queue after releasing it — a message that arrived between the last `dequeue()`
// returning undefined and `running = false` would otherwise be stranded with
// nobody to process it. Several tail branches deliberately `void ctx.run()` and
// return rather than looping inline, so the mutex is released between passes.

import { feature } from 'bun:bundle'
import { cwd } from 'process'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { RemoteIO } from 'src/platform/headless/remoteIO.js'
import { ask } from 'src/QueryEngine.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import {
  dequeue,
  enqueue,
  peek,
} from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import { notifySessionStateChanged } from 'src/services/session/sessionState.js'
import { getInMemoryErrors, logError } from 'src/shared/log.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import { logEvent } from 'src/platform/analytics/index.js'
import { logForDebugging } from 'src/shared/debug.js'
import { mergeFileStateCaches } from 'src/shared/fs/fileStateCache.js'
import { installLiveReadFileCache } from 'src/platform/headless/print/readFileCacheHandover.js'
import { executeFilePersistence } from 'src/platform/filePersistence/filePersistence.js'
import { finalizePendingAsyncHooks } from 'src/platform/lifecycleHooks/AsyncHookRegistry.js'
import {
  gracefulShutdownSync,
  isShuttingDown,
} from 'src/shared/proc/gracefulShutdown.js'
import type {
  SDKUserMessageReplay,
} from 'src/platform/entrypoints/agentSdkTypes.js'
import { createAbortController } from 'src/shared/abortController.js'
import { TEAMMATE_MESSAGE_TAG } from 'src/constants/xml.js'
import {
  tryGenerateSuggestion,
  logSuggestionOutcome,
  logSuggestionSuppressed,
} from 'src/terminal/prompt-suggestion/promptSuggestion.js'
import { getLastCacheSafeParams } from 'src/coordinator/forkedAgent.js'
import { getInitJsonSchema, getSessionId } from 'src/platform/bootstrap/state.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  logHeadlessProfilerTurn,
} from 'src/platform/headlessProfiler.js'
import {
  startQueryProfile,
  logQueryProfileReport,
} from 'src/utils/queryProfiler.js'
import {
  isTeamLead,
  hasActiveInProcessTeammates,
  hasWorkingInProcessTeammates,
  waitForTeammatesToBecomeIdle,
} from 'src/coordinator/teammate.js'
import {
  readUnreadMessages,
  markMessagesAsRead,
  isShutdownApproved,
} from 'src/coordinator/teammateMailbox.js'
import { removeTeammateFromTeamFile } from 'src/coordinator/swarm/teamHelpers.js'
import { unassignTeammateTasks } from 'src/tasks/tasks.js'
import { getRunningTasks } from 'src/tasks/framework.js'
import { isBackgroundTask } from 'src/tasks/types.js'
import { drainSdkEvents } from 'src/utils/sdkEventQueue.js'
import { errorMessage, toError } from 'src/shared/errors.js'
import { sleep } from 'src/shared/sleep.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { reregisterChannelHandlerAfterReconnect } from 'src/platform/headless/print/controlHandlers.js'
import { canBatchWith, joinPromptValues } from 'src/platform/headless/print/promptBatching.js'
import { proactiveModule } from 'src/platform/headless/print/headlessOptionalModules.js'
import type { HeadlessStreamingContext } from 'src/platform/headless/print/streamingContext.js'
import type { StdoutMessage } from 'src/platform/entrypoints/sdk/controlTypes.js'

const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

export async function runTurnLoop(
  ctx: HeadlessStreamingContext,
): Promise<void> {
  const {
    structuredIO,
    output,
    options,
    getAppState,
    setAppState,
    mutableMessages,
    pendingSeeds,
    suggestionState,
    canUseTool,
    idleTimeout,
  } = ctx

  if (ctx.running) {
    return
  }

  ctx.running = true
  ctx.runPhase = undefined
  notifySessionStateChanged('running')
  idleTimeout.stop()

  headlessProfilerCheckpoint('run_entry')
  // TODO(custom-tool-refactor): Should move to the init message, like browser

  await ctx.updateSdkMcp()
  headlessProfilerCheckpoint('after_updateSdkMcp')

  // Resolve deferred plugin installation (CLAUDE_CODE_SYNC_PLUGIN_INSTALL).
  // The promise was started eagerly so installation overlaps with other init.
  // Awaiting here guarantees plugins are available before the first ask().
  // If CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS is set, races against that
  // deadline and proceeds without plugins on timeout (logging an error).
  if (ctx.pluginInstallPromise) {
    const timeoutMs = parseInt(
      process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS || '',
      10,
    )
    if (timeoutMs > 0) {
      const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
      const result = await Promise.race([ctx.pluginInstallPromise, timeout])
      if (result === 'timeout') {
        logError(
          new Error(
            `CLAUDE_CODE_SYNC_PLUGIN_INSTALL: plugin installation timed out after ${timeoutMs}ms`,
          ),
        )
        logEvent('tengu_sync_plugin_install_timeout', {
          timeout_ms: timeoutMs,
        })
      }
    } else {
      await ctx.pluginInstallPromise
    }
    ctx.pluginInstallPromise = null

    // Refresh commands, agents, and hooks now that plugins are installed
    await ctx.refreshPluginState()

    // Set up hot-reload for plugin hooks now that the initial install is done.
    // In sync-install mode, setup.ts skips this to avoid racing with the install,
    // so this is the ONLY call site that arms it under CLAUDE_CODE_SYNC_PLUGIN_INSTALL.
    // Path-aliased on purpose. This specifier was relative until #57 and had been
    // resolving one directory short since 2e178cf7 moved runHeadless deeper, so the
    // rejected import left `run()` unfinished and the output stream never closed --
    // `-p` under this env var HUNG rather than failing. An alias cannot rot the same
    // way when a file changes depth, which is why the repo rule forbids `../../`.
    const { setupPluginHookHotReload } = await import(
      'src/services/plugins/loadPluginHooks.js'
    )
    setupPluginHookHotReload()
  }

  // Only main-thread commands (agentId===undefined) — subagent
  // notifications are drained by the subagent's mid-turn gate in query.ts.
  // Defined outside the try block so it's accessible in the post-finally
  // queue re-checks at the bottom of run().
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  try {
    let command: QueuedCommand | undefined
    let waitingForAgents = false

    // Extract command processing into a named function for the do-while pattern.
    // Drains the queue, batching consecutive prompt-mode commands into one
    // ask() call so messages that queued up during a long turn coalesce
    // into a single follow-up turn instead of N separate turns.
    const drainCommandQueue = async () => {
      while ((command = dequeue(isMainThread))) {
        if (
          command.mode !== 'prompt' &&
          command.mode !== 'orphaned-permission' &&
          command.mode !== 'task-notification'
        ) {
          throw new Error(
            'only prompt commands are supported in streaming mode',
          )
        }

        // Non-prompt commands (task-notification, orphaned-permission) carry
        // side effects or orphanedPermission state, so they process singly.
        // Prompt commands greedily collect compatible followers.
        const batch: QueuedCommand[] = [command]
        if (command.mode === 'prompt') {
          while (canBatchWith(command, peek(isMainThread))) {
            batch.push(dequeue(isMainThread)!)
          }
          if (batch.length > 1) {
            command = {
              ...command,
              value: joinPromptValues(batch.map(c => c.value)),
              uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
            }
          }
        }
        const batchUuids = batch.map(c => c.uuid).filter(u => u !== undefined)

        // QueryEngine will emit a replay for command.uuid (the last uuid in
        // the batch) via its messagesToAck path. Emit replays here for the
        // rest so consumers that track per-uuid delivery (clank's
        // asyncMessages footer, CCR) see an ack for every message they sent,
        // not just the one that survived the merge.
        if (options.replayUserMessages && batch.length > 1) {
          for (const c of batch) {
            if (c.uuid && c.uuid !== command.uuid) {
              output.enqueue({
                type: 'user',
                message: { role: 'user', content: c.value },
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: c.uuid,
                isReplay: true,
              } satisfies SDKUserMessageReplay)
            }
          }
        }

        // Combine all MCP clients. appState.mcp is populated incrementally
        // per-server by main.tsx (mirrors useManageMCPConnections). Reading
        // fresh per-command means late-connecting servers are visible on the
        // next turn. registerElicitationHandlers is idempotent (tracking set).
        const appState = getAppState()
        const allMcpClients = [
          ...appState.mcp.clients,
          ...ctx.sdkClients,
          ...ctx.dynamicMcpState.clients,
        ]
        ctx.registerElicitationHandlers(allMcpClients)
        // Channel handlers for servers allowlisted via --channels at
        // construction time (or enableChannel() mid-session). Runs every
        // turn like registerElicitationHandlers — idempotent per-client
        // (setNotificationHandler replaces, not stacks) and no-ops for
        // non-allowlisted servers (one feature-flag check).
        for (const client of allMcpClients) {
          reregisterChannelHandlerAfterReconnect(client)
        }

        const allTools = ctx.buildAllTools(appState)

        for (const uuid of batchUuids) {
          notifyCommandLifecycle(uuid, 'started')
        }

        // Task notifications arrive when background agents complete.
        // Emit an SDK system event for SDK consumers, then fall through
        // to ask() so the model sees the agent result and can act on it.
        // This matches TUI behavior where useQueueProcessor always feeds
        // notifications to the model regardless of coordinator mode.
        if (command.mode === 'task-notification') {
          const notificationText =
            typeof command.value === 'string' ? command.value : ''
          // Parse the XML-formatted notification
          const taskIdMatch = notificationText.match(
            /<task-id>([^<]+)<\/task-id>/,
          )
          const toolUseIdMatch = notificationText.match(
            /<tool-use-id>([^<]+)<\/tool-use-id>/,
          )
          const outputFileMatch = notificationText.match(
            /<output-file>([^<]+)<\/output-file>/,
          )
          const statusMatch = notificationText.match(
            /<status>([^<]+)<\/status>/,
          )
          const summaryMatch = notificationText.match(
            /<summary>([^<]+)<\/summary>/,
          )

          const isValidStatus = (
            s: string | undefined,
          ): s is 'completed' | 'failed' | 'stopped' | 'killed' =>
            s === 'completed' ||
            s === 'failed' ||
            s === 'stopped' ||
            s === 'killed'
          const rawStatus = statusMatch?.[1]
          const status = isValidStatus(rawStatus)
            ? rawStatus === 'killed'
              ? 'stopped'
              : rawStatus
            : 'completed'

          const usageMatch = notificationText.match(/<usage>([\s\S]*?)<\/usage>/)
          const usageContent = usageMatch?.[1] ?? ''
          const totalTokensMatch = usageContent.match(
            /<total_tokens>(\d+)<\/total_tokens>/,
          )
          const toolUsesMatch = usageContent.match(
            /<tool_uses>(\d+)<\/tool_uses>/,
          )
          const durationMsMatch = usageContent.match(
            /<duration_ms>(\d+)<\/duration_ms>/,
          )

          // Only emit a task_notification SDK event when a <status> tag is
          // present — that means this is a terminal notification (completed/
          // failed/stopped). Stream events from enqueueStreamEvent carry no
          // <status> (they're progress pings); emitting them here would
          // default to 'completed' and falsely close the task for SDK
          // consumers. Terminal bookends are now emitted directly via
          // emitTaskTerminatedSdk, so skipping statusless events is safe.
          if (statusMatch) {
            output.enqueue({
              type: 'system',
              subtype: 'task_notification',
              task_id: taskIdMatch?.[1] ?? '',
              tool_use_id: toolUseIdMatch?.[1],
              status,
              output_file: outputFileMatch?.[1] ?? '',
              summary: summaryMatch?.[1] ?? '',
              usage:
                totalTokensMatch && toolUsesMatch
                  ? {
                      total_tokens: parseInt(totalTokensMatch[1]!, 10),
                      tool_uses: parseInt(toolUsesMatch[1]!, 10),
                      duration_ms: durationMsMatch
                        ? parseInt(durationMsMatch[1]!, 10)
                        : 0,
                    }
                  : undefined,
              session_id: getSessionId(),
              uuid: randomUUID(),
            })
          }
          // No continue -- fall through to ask() so the model processes the result
        }

        const input = command.value

        if (structuredIO instanceof RemoteIO && command.mode === 'prompt') {
          logEvent('tengu_bridge_message_received', {
            is_repl: false,
          })
        }

        // Abort any in-flight suggestion generation and track acceptance
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        suggestionState.pendingSuggestion = null
        suggestionState.pendingLastEmittedEntry = null
        if (suggestionState.lastEmitted) {
          if (command.mode === 'prompt') {
            // SDK user messages enqueue ContentBlockParam[], not a plain string
            const inputText =
              typeof input === 'string'
                ? input
                : (
                    input.find(b => b.type === 'text') as
                      | { type: 'text'; text: string }
                      | undefined
                  )?.text
            if (typeof inputText === 'string') {
              logSuggestionOutcome(
                suggestionState.lastEmitted.text,
                inputText,
                suggestionState.lastEmitted.emittedAt,
                suggestionState.lastEmitted.promptId,
                suggestionState.lastEmitted.generationRequestId,
              )
            }
            suggestionState.lastEmitted = null
          }
        }

        ctx.abortController = createAbortController()
        const abortController = ctx.abortController
        const turnStartTime = feature('FILE_PERSISTENCE') ? Date.now() : undefined

        headlessProfilerCheckpoint('before_ask')
        startQueryProfile()
        // const-capture: TS loses `while ((command = dequeue()))` narrowing
        // inside the closure.
        const cmd = command
        // Usage refresh for assistant events (emit-now + re-emit-final):
        // assistant SDK messages are normalized (inner message CLONED) at
        // content_block_stop, BEFORE message_delta writes the request's
        // final usage into the engine-side message — so the serialized
        // event carries zero usage. We emit immediately (preserving the
        // assistant-before-permission-request ordering and zero added
        // latency), track the event, and once the engine-side copy in the
        // shared mutableMessages carries final usage (stop_reason set or
        // any token count nonzero), re-emit the SAME-id event with the
        // refreshed usage. Same-id last-wins is the documented Claude Code
        // stream contract; consumers dedupe by message id.
        type RefreshableAssistant = {
          type: 'assistant'
          message: { id?: string; usage?: unknown; stop_reason?: unknown }
        }
        let pendingUsageRefresh: RefreshableAssistant | null = null
        const maybeEmitUsageRefresh = (): void => {
          if (!pendingUsageRefresh) return
          const held = pendingUsageRefresh
          const heldId = held.message?.id
          if (!heldId) {
            pendingUsageRefresh = null
            return
          }
          const src = (
            mutableMessages as unknown as RefreshableAssistant[]
          ).findLast(m => m?.type === 'assistant' && m.message?.id === heldId)
          if (!src) {
            pendingUsageRefresh = null
            return
          }
          const usage = src.message.usage as
            | {
                input_tokens?: number
                output_tokens?: number
                cache_read_input_tokens?: number
                cache_creation_input_tokens?: number
              }
            | undefined
          const usageLanded =
            src.message.stop_reason != null ||
            (usage &&
              (usage.input_tokens ?? 0) +
                (usage.output_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0) >
                0)
          // Final usage not written yet (e.g. a stream_event arriving
          // between content_block_stop and message_delta) → keep pending
          // and try again on the next trigger.
          if (!usageLanded) return
          pendingUsageRefresh = null
          output.enqueue({
            ...held,
            message: {
              ...held.message,
              usage: src.message.usage,
              stop_reason: src.message.stop_reason ?? held.message.stop_reason,
            },
          } as unknown as StdoutMessage)
        }

        for await (const message of ask({
          commands: uniqBy(
            [...ctx.currentCommands, ...appState.mcp.commands],
            'name',
          ),
          prompt: input,
          promptUuid: cmd.uuid,
          isMeta: cmd.isMeta,
          cwd: cwd(),
          tools: allTools,
          verbose: options.verbose,
          mcpClients: allMcpClients,
          thinkingConfig: options.thinkingConfig,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          taskBudget: options.taskBudget,
          canUseTool,
          userSpecifiedModel: ctx.activeUserSpecifiedModel,
          fallbackModel: options.fallbackModel,
          jsonSchema: getInitJsonSchema() ?? options.jsonSchema,
          mutableMessages,
          getReadFileCache: () =>
            pendingSeeds.size === 0
              ? ctx.readFileState
              : mergeFileStateCaches(ctx.readFileState, pendingSeeds),
          setReadFileCache: cache => {
            // The incoming cache may be the transient merge above, which owns
            // no pins by construction. Promoting it over the live cache would
            // strand every pin the live one owned — nothing left is entitled
            // to release them. installLiveReadFileCache owns that invariant
            // and has the test this closure could not have.
            ctx.readFileState = installLiveReadFileCache(
              ctx.readFileState,
              cache,
              pendingSeeds,
            )
          },
          customSystemPrompt: options.systemPrompt,
          appendSystemPrompt: options.appendSystemPrompt,
          getAppState,
          setAppState,
          abortController,
          replayUserMessages: options.replayUserMessages,
          includePartialMessages: options.includePartialMessages,
          handleElicitation: (serverName, params, elicitSignal) =>
            structuredIO.handleElicitation(
              serverName,
              params.message,
              undefined,
              elicitSignal,
              params.mode,
              params.url,
              'elicitationId' in params ? params.elicitationId : undefined,
            ),
          agents: ctx.currentAgents,
          orphanedPermission: cmd.orphanedPermission,
          setSDKStatus: status => {
            output.enqueue({
              type: 'system',
              subtype: 'status',
              status,
              session_id: getSessionId(),
              uuid: randomUUID(),
            })
          },
        })) {
          // Forward messages to bridge incrementally (mid-turn) so
          // claude.ai sees progress and the connection stays alive
          // while blocked on permission requests.
          ctx.forwardMessagesToBridge()

          // Assistant events are emitted IMMEDIATELY (ordering with
          // permission control_requests preserved, nothing held across
          // errors) and a same-id refresh event with final usage follows
          // once message_delta lands — see maybeEmitUsageRefresh above.
          if (message.type === 'assistant') {
            // A newer assistant event supersedes any pending refresh for
            // the PREVIOUS one — try to refresh it first (same-id events
            // of one request: earlier blocks legitimately keep zeros, the
            // final block gets the refresh once usage lands).
            maybeEmitUsageRefresh()
            output.enqueue(message)
            pendingUsageRefresh = message as unknown as RefreshableAssistant
            continue
          }

          if (message.type === 'result') {
            // Last chance before the turn's result: if usage still hasn't
            // landed, DROP the pending refresh — emitting an assistant
            // event after `result` would violate the per-turn protocol
            // shape consumers rely on (many stop reading at result).
            maybeEmitUsageRefresh()
            pendingUsageRefresh = null
            // Flush pending SDK events so they appear before result on the stream.
            for (const event of drainSdkEvents()) {
              output.enqueue(event)
            }

            // Hold-back: don't emit result while background agents are running
            const currentState = getAppState()
            if (
              getRunningTasks(currentState).some(
                t =>
                  (t.type === 'local_agent' || t.type === 'local_workflow') &&
                  isBackgroundTask(t),
              )
            ) {
              ctx.heldBackResult = message
            } else {
              ctx.heldBackResult = null
              output.enqueue(message)
            }
          } else {
            maybeEmitUsageRefresh()
            // Flush SDK events (task_started, task_progress) so background
            // agent progress is streamed in real-time, not batched until result.
            for (const event of drainSdkEvents()) {
              output.enqueue(event)
            }
            output.enqueue(message)
          }
        }
        // Post-loop: the final result already went out; drop rather than
        // emit a post-result event.
        pendingUsageRefresh = null

        for (const uuid of batchUuids) {
          notifyCommandLifecycle(uuid, 'completed')
        }

        // Forward messages to bridge after each turn
        ctx.forwardMessagesToBridge()
        ctx.bridgeHandle?.sendResult()

        if (feature('FILE_PERSISTENCE') && turnStartTime !== undefined) {
          void executeFilePersistence(
            turnStartTime,
            abortController.signal,
            result => {
              output.enqueue({
                type: 'system' as const,
                subtype: 'files_persisted' as const,
                // Every entry in `result.files` came from a successful
                // upload (see executeBYOCPersistence), where fileId is
                // always set — PersistedFile's `file_id?` is just looser
                // than that guarantee.
                files: result.files as { filename: string; file_id: string }[],
                failed: result.failed,
                processed_at: new Date().toISOString(),
                uuid: randomUUID(),
                session_id: getSessionId(),
              })
            },
          )
        }

        // Generate and emit prompt suggestion for SDK consumers
        if (
          options.promptSuggestions &&
          !isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)
        ) {
          // TS narrows suggestionState to never in the while loop body;
          // cast via unknown to reset narrowing.
          const state = suggestionState as unknown as typeof suggestionState
          state.abortController?.abort()
          const localAbort = new AbortController()
          suggestionState.abortController = localAbort

          const cacheSafeParams = getLastCacheSafeParams()
          if (!cacheSafeParams) {
            logSuggestionSuppressed('sdk_no_params', undefined, undefined, 'sdk')
          } else {
            // Use a ref object so the IIFE's finally can compare against its own
            // promise without a self-reference (which upsets TypeScript's flow analysis).
            const ref: { promise: Promise<void> | null } = { promise: null }
            ref.promise = (async () => {
              try {
                const result = await tryGenerateSuggestion(
                  localAbort,
                  mutableMessages,
                  getAppState,
                  cacheSafeParams,
                  'sdk',
                )
                if (!result || localAbort.signal.aborted) return
                const suggestionMsg = {
                  type: 'prompt_suggestion' as const,
                  suggestion: result.suggestion,
                  uuid: randomUUID(),
                  session_id: getSessionId(),
                }
                const lastEmittedEntry = {
                  text: result.suggestion,
                  emittedAt: Date.now(),
                  promptId: result.promptId,
                  generationRequestId: result.generationRequestId,
                }
                // Defer emission if the result is being held for background agents,
                // so that prompt_suggestion always arrives after result.
                // Only set lastEmitted when the suggestion is actually delivered
                // to the consumer; deferred suggestions may be discarded before
                // delivery if a new command arrives first.
                if (ctx.heldBackResult) {
                  suggestionState.pendingSuggestion = suggestionMsg
                  suggestionState.pendingLastEmittedEntry = {
                    text: lastEmittedEntry.text,
                    promptId: lastEmittedEntry.promptId,
                    generationRequestId: lastEmittedEntry.generationRequestId,
                  }
                } else {
                  suggestionState.lastEmitted = lastEmittedEntry
                  output.enqueue(suggestionMsg)
                }
              } catch (error) {
                if (
                  error instanceof Error &&
                  (error.name === 'AbortError' ||
                    error.name === 'APIUserAbortError')
                ) {
                  logSuggestionSuppressed('aborted', undefined, undefined, 'sdk')
                  return
                }
                logError(toError(error))
              } finally {
                if (suggestionState.inflightPromise === ref.promise) {
                  suggestionState.inflightPromise = null
                }
              }
            })()
            suggestionState.inflightPromise = ref.promise
          }
        }

        // Log headless profiler metrics for this turn and start next turn
        logHeadlessProfilerTurn()
        logQueryProfileReport()
        headlessProfilerStartTurn()
      }
    }

    // Use a do-while loop to drain commands and then wait for any
    // background agents that are still running. When agents complete,
    // their notifications are enqueued and the loop re-drains.
    do {
      // Drain SDK events (task_started, task_progress) before command queue
      // so progress events precede task_notification on the stream.
      for (const event of drainSdkEvents()) {
        output.enqueue(event)
      }

      ctx.runPhase = 'draining_commands'
      await drainCommandQueue()

      // Check for running background tasks before exiting.
      // Exclude in_process_teammate — teammates are long-lived by design
      // (status: 'running' for their whole lifetime, cleaned up by the
      // shutdown protocol, not by transitioning to 'completed'). Waiting
      // on them here loops forever (gh-30008). Same exclusion already
      // exists at useBackgroundTaskNavigation.ts:55 for the same reason;
      // the hold-back check above is already narrower (type === 'local_agent')
      // so it doesn't hit this.
      waitingForAgents = false
      {
        const state = getAppState()
        const hasRunningBg = getRunningTasks(state).some(
          t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
        )
        const hasMainThreadQueued = peek(isMainThread) !== undefined
        if (hasRunningBg || hasMainThreadQueued) {
          waitingForAgents = true
          if (!hasMainThreadQueued) {
            ctx.runPhase = 'waiting_for_agents'
            // No commands ready yet, wait for tasks to complete
            await sleep(100)
          }
          // Loop back to drain any newly queued commands
        }
      }
    } while (waitingForAgents)

    if (ctx.heldBackResult) {
      output.enqueue(ctx.heldBackResult)
      ctx.heldBackResult = null
      if (suggestionState.pendingSuggestion) {
        output.enqueue(suggestionState.pendingSuggestion)
        // Now that the suggestion is actually delivered, record it for acceptance tracking
        if (suggestionState.pendingLastEmittedEntry) {
          suggestionState.lastEmitted = {
            ...suggestionState.pendingLastEmittedEntry,
            emittedAt: Date.now(),
          }
          suggestionState.pendingLastEmittedEntry = null
        }
        suggestionState.pendingSuggestion = null
      }
    }
  } catch (error) {
    // Emit error result message before shutting down
    // Write directly to structuredIO to ensure immediate delivery
    try {
      await structuredIO.write({
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: 0,
        usage: EMPTY_USAGE,
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        errors: [errorMessage(error), ...getInMemoryErrors().map(_ => _.error)],
      })
    } catch {
      // If we can't emit the error result, continue with shutdown anyway
    }
    suggestionState.abortController?.abort()
    gracefulShutdownSync(1)
    return
  } finally {
    ctx.runPhase = 'finally_flush'
    // Flush pending internal events before going idle
    await structuredIO.flushInternalEvents()
    ctx.runPhase = 'finally_post_flush'
    if (!isShuttingDown()) {
      notifySessionStateChanged('idle')
      // Drain so the idle session_state_changed SDK event (plus any
      // terminal task_notification bookends emitted during bg-agent
      // teardown) reach the output stream before we block on the next
      // command. The do-while drain above only runs while
      // waitingForAgents; once we're here the next drain would be the
      // top of the next run(), which won't come if input is idle.
      for (const event of drainSdkEvents()) {
        output.enqueue(event)
      }
    }
    ctx.running = false
    // Start idle timer when we finish processing and are waiting for input
    idleTimeout.start()
  }

  // Proactive tick: if proactive is active and queue is empty, inject a tick
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule?.isProactiveActive() &&
    !proactiveModule.isProactivePaused()
  ) {
    if (peek(isMainThread) === undefined && !ctx.inputClosed) {
      ctx.scheduleProactiveTick!()
      return
    }
  }

  // Re-check the queue after releasing the mutex. A message may have
  // arrived (and called run()) between the last dequeue() returning
  // undefined and `running = false` above. In that case the caller
  // saw `running === true` and returned immediately, leaving the
  // message stranded in the queue with no one to process it.
  if (peek(isMainThread) !== undefined) {
    void ctx.run()
    return
  }

  // Check for unread teammate messages and process them
  // This mirrors what useInboxPoller does in interactive REPL mode
  // Poll until no more messages (teammates may still be working)
  {
    const currentAppState = getAppState()
    const teamContext = currentAppState.teamContext

    if (teamContext && isTeamLead(teamContext)) {
      const agentName = 'team-lead'

      // Poll for messages while teammates are active
      // This is needed because teammates may send messages while we're waiting
      // Keep polling until the team is shut down
      const POLL_INTERVAL_MS = 500

      while (true) {
        // Check if teammates are still active
        const refreshedState = getAppState()
        const hasActiveTeammates =
          hasActiveInProcessTeammates(refreshedState) ||
          (refreshedState.teamContext &&
            Object.keys(refreshedState.teamContext.teammates).length > 0)

        if (!hasActiveTeammates) {
          logForDebugging('[print.ts] No more active teammates, stopping poll')
          break
        }

        const unread = await readUnreadMessages(
          agentName,
          refreshedState.teamContext?.teamName,
        )

        if (unread.length > 0) {
          logForDebugging(
            `[print.ts] Team-lead found ${unread.length} unread messages`,
          )

          // Mark as read immediately to avoid duplicate processing
          await markMessagesAsRead(
            agentName,
            refreshedState.teamContext?.teamName,
          )

          // Process shutdown_approved messages - remove teammates from team file
          // This mirrors what useInboxPoller does in interactive mode (lines 546-606)
          const teamName = refreshedState.teamContext?.teamName
          for (const m of unread) {
            const shutdownApproval = isShutdownApproved(m.text)
            if (shutdownApproval && teamName) {
              const teammateToRemove = shutdownApproval.from
              logForDebugging(
                `[print.ts] Processing shutdown_approved from ${teammateToRemove}`,
              )

              // Find the teammate ID by name
              const teammateId = refreshedState.teamContext?.teammates
                ? Object.entries(refreshedState.teamContext.teammates).find(
                    ([, t]) => t.name === teammateToRemove,
                  )?.[0]
                : undefined

              if (teammateId) {
                // Remove from team file
                removeTeammateFromTeamFile(teamName, {
                  agentId: teammateId,
                  name: teammateToRemove,
                })
                logForDebugging(
                  `[print.ts] Removed ${teammateToRemove} from team file`,
                )

                // Unassign tasks owned by this teammate
                await unassignTeammateTasks(
                  teamName,
                  teammateId,
                  teammateToRemove,
                  'shutdown',
                )

                // Remove from teamContext in AppState
                setAppState(prev => {
                  if (!prev.teamContext?.teammates) return prev
                  if (!(teammateId in prev.teamContext.teammates)) return prev
                  const { [teammateId]: _, ...remainingTeammates } =
                    prev.teamContext.teammates
                  return {
                    ...prev,
                    teamContext: {
                      ...prev.teamContext,
                      teammates: remainingTeammates,
                    },
                  }
                })
              }
            }
          }

          // Format messages same as useInboxPoller
          const formatted = unread
            .map(
              (m: { from: string; text: string; color?: string }) =>
                `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${m.color ? ` color="${m.color}"` : ''}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
            )
            .join('\n\n')

          // Enqueue and process
          enqueue({
            mode: 'prompt',
            value: formatted,
            uuid: randomUUID(),
          })
          void ctx.run()
          return // run() will come back here after processing
        }

        // No messages - check if we need to prompt for shutdown
        // If input is closed and teammates are active, inject shutdown prompt once
        if (ctx.inputClosed && !ctx.shutdownPromptInjected) {
          ctx.shutdownPromptInjected = true
          logForDebugging(
            '[print.ts] Input closed with active teammates, injecting shutdown prompt',
          )
          enqueue({
            mode: 'prompt',
            value: SHUTDOWN_TEAM_PROMPT,
            uuid: randomUUID(),
          })
          void ctx.run()
          return // run() will come back here after processing
        }

        // Wait and check again
        await sleep(POLL_INTERVAL_MS)
      }
    }
  }

  if (ctx.inputClosed) {
    // Check for active swarm that needs shutdown
    const hasActiveSwarm = await (async () => {
      // Wait for any working in-process team members to finish
      const currentAppState = getAppState()
      if (hasWorkingInProcessTeammates(currentAppState)) {
        await waitForTeammatesToBecomeIdle(setAppState, currentAppState)
      }

      // Re-fetch state after potential wait
      const refreshedAppState = getAppState()
      const refreshedTeamContext = refreshedAppState.teamContext
      const hasTeamMembersNotCleanedUp =
        refreshedTeamContext &&
        Object.keys(refreshedTeamContext.teammates).length > 0

      return (
        hasTeamMembersNotCleanedUp ||
        hasActiveInProcessTeammates(refreshedAppState)
      )
    })()

    if (hasActiveSwarm) {
      // Team members are idle or pane-based - inject prompt to shut down team
      enqueue({
        mode: 'prompt',
        value: SHUTDOWN_TEAM_PROMPT,
        uuid: randomUUID(),
      })
      void ctx.run()
    } else {
      await ctx.closeOutput()
    }
  }
}

/**
 * Shared teardown for the two "stdin closed and nothing running" exits: the
 * tail of `runTurnLoop` and the tail of the stdin control loop. Waits for any
 * in-flight push suggestion (5s safety timeout so a hung generation can't hold
 * the process open), finalizes async hooks, drops the listeners, then closes
 * the output stream.
 */
export async function closeHeadlessOutput(
  ctx: HeadlessStreamingContext,
  unsubscribeSkillChanges: () => void,
  unsubscribeAuthStatus: (() => void) | undefined,
  removeRateLimitListener: () => void,
): Promise<void> {
  const { suggestionState, output } = ctx
  // Wait for any in-flight push suggestion before closing the output stream.
  if (suggestionState.inflightPromise) {
    await Promise.race([suggestionState.inflightPromise, sleep(5000)])
  }
  suggestionState.abortController?.abort()
  suggestionState.abortController = null
  await finalizePendingAsyncHooks()
  unsubscribeSkillChanges()
  unsubscribeAuthStatus?.()
  removeRateLimitListener()
  output.done()
}
