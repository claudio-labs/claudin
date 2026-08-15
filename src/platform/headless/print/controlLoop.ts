// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// The headless stdin reader — extracted from the trailing IIFE of
// `runHeadlessStreaming` (`src/platform/headless/print/runHeadless.ts`) as the deferred half
// of ROADMAP 11b.
//
// This is one half of a two-task pipeline: this loop reads stdin and appends to
// the command queue, while `turnLoop.ts` reads from that queue, runs the model
// and emits results. The session is complete when the input stream ends AND the
// last generation has finished — hence the `if (!ctx.running)` teardown at the
// bottom, which mirrors the one at the tail of the turn loop.
//
// SERIALITY IS A CONTRACT. Every `await` in the dispatch below stalls the
// reader, so a handler that parks on a network roundtrip delays every later
// user message and interrupt. Handlers that must not block (session-title
// generation, side questions, the Anthropic OAuth wait) deliberately detach —
// see the notes on those handlers.
//
// The long-tail subtypes live in sibling modules (`mcpControlHandlers`,
// `oauthControlHandlers`, `settingsControlHandlers`, and the pre-existing
// `controlHandlers`); only the short ones stay inline here.

import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import {
  dequeueAllMatching,
  enqueue,
  hasCommandsInQueue,
} from 'src/agent/messageQueueManager.js'
import { notifySessionMetadataChanged } from 'src/services/session/sessionState.js'
import { errorMessage } from 'src/shared/errors.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import { collectContextData } from 'src/commands/context/context-noninteractive.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
} from 'src/utils/model/model.js'
import {
  setMainLoopModelOverride,
  setSdkAgentProgressSummariesEnabled,
  getSessionId,
} from 'src/platform/bootstrap/state.js'
import { toInternalMessages } from 'src/agent/messages/mappers.js'
import { resolveAndPrepend } from 'src/platform/bridge/inboundAttachments.js'
import { doesMessageExistInSession } from 'src/services/session/sessionStorage.js'
import { recordAttributionSnapshot } from 'src/services/session/sessionStorage.js'
import { incrementPromptCount } from 'src/services/git/commitAttribution.js'
import { stopTask } from 'src/tasks/stopTask.js'
import type { SDKUserMessageReplay } from 'src/platform/entrypoints/agentSdkTypes.js'
import {
  handleRewindFiles,
  handleSetPermissionMode,
  handleChannelEnable,
} from 'src/platform/headless/print/controlHandlers.js'
import { handleInitializeRequest } from 'src/platform/headless/print/initHandler.js'
import {
  hasReceivedMessageUuid,
  trackReceivedMessageUuid,
} from 'src/platform/headless/print/uuidDedupe.js'
import {
  handleMcpReconnect,
  handleMcpToggle,
  handleMcpAuthenticate,
  handleMcpOauthCallbackUrl,
  handleMcpClearAuth,
  type McpServerNameRequest,
  type McpToggleRequest,
  type McpOauthCallbackUrlRequest,
} from 'src/platform/headless/print/mcpControlHandlers.js'
import {
  handleClaudeAuthenticate,
  handleClaudeOauthCallback,
  type ClaudeAuthenticateRequest,
  type ClaudeOauthCallbackRequest,
} from 'src/platform/headless/print/oauthControlHandlers.js'
import {
  handleSeedReadState,
  handleReloadPlugins,
  handleApplyFlagSettings,
  handleGetSettings,
  handleGenerateSessionTitle,
  handleSideQuestion,
  handleRemoteControl,
  type SeedReadStateRequest,
  type ApplyFlagSettingsRequest,
  type GenerateSessionTitleRequest,
  type SideQuestionRequest,
  type RemoteControlRequest,
} from 'src/platform/headless/print/settingsControlHandlers.js'
import { proactiveModule } from 'src/platform/headless/print/headlessOptionalModules.js'
import type { HeadlessStreamingContext } from 'src/platform/headless/print/streamingContext.js'

export async function runControlLoop(
  ctx: HeadlessStreamingContext,
): Promise<void> {
  const {
    structuredIO,
    output,
    options,
    getAppState,
    setAppState,
    sdkMcpConfigs,
    mutableMessages,
    suggestionState,
    initialCommands,
    initialAgents,
    modelInfos,
  } = ctx

  let initialized = false
  logForDiagnosticsNoPII('info', 'cli_message_loop_started')
  for await (const message of structuredIO.structuredInput) {
    // Non-user events are handled inline (no queue). started→completed in
    // the same tick carries no information, so only fire completed.
    // control_response is reported by StructuredIO.processLine (which also
    // sees orphans that never yield here).
    const eventId = 'uuid' in message ? message.uuid : undefined
    if (
      eventId &&
      message.type !== 'user' &&
      message.type !== 'control_response'
    ) {
      notifyCommandLifecycle(eventId, 'completed')
    }

    if (message.type === 'control_request') {
      // Subtypes this loop handles that `controlSchemas.ts` has no union arm
      // for are matched through this widened view — the same escape hatch the
      // `set_proactive` branch below already uses.
      const requestSubtype: string = message.request.subtype
      if (message.request.subtype === 'interrupt') {
        // Track escapes for attribution (internal-only feature)
        if (feature('COMMIT_ATTRIBUTION')) {
          setAppState(prev => ({
            ...prev,
            attribution: {
              ...prev.attribution,
              escapeCount: prev.attribution.escapeCount + 1,
            },
          }))
        }
        if (ctx.abortController) {
          ctx.abortController.abort()
        }
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        suggestionState.lastEmitted = null
        suggestionState.pendingSuggestion = null
        ctx.sendControlResponseSuccess(message)
      } else if (requestSubtype === 'end_session') {
        logForDebugging(
          `[print.ts] end_session received, reason=${(message.request as { reason?: string }).reason ?? 'unspecified'}`,
        )
        if (ctx.abortController) {
          ctx.abortController.abort()
        }
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        suggestionState.lastEmitted = null
        suggestionState.pendingSuggestion = null
        ctx.sendControlResponseSuccess(message)
        break // exits for-await → falls through to inputClosed=true drain below
      } else if (message.request.subtype === 'initialize') {
        // SDK MCP server names from the initialize message
        // Populated by both browser and ProcessTransport sessions
        if (
          message.request.sdkMcpServers &&
          message.request.sdkMcpServers.length > 0
        ) {
          for (const serverName of message.request.sdkMcpServers) {
            // Create placeholder config for SDK MCP servers
            // The actual server connection is managed by the SDK Query class
            sdkMcpConfigs[serverName] = {
              type: 'sdk',
              name: serverName,
            }
          }
        }

        await handleInitializeRequest(
          message.request,
          message.request_id,
          initialized,
          output,
          initialCommands,
          modelInfos,
          structuredIO,
          !!options.enableAuthStatus,
          options,
          initialAgents,
          getAppState,
        )

        // Enable prompt suggestions in AppState when SDK consumer opts in.
        // shouldEnablePromptSuggestion() returns false for non-interactive
        // sessions, but the SDK consumer explicitly requested suggestions.
        if (message.request.promptSuggestions) {
          setAppState(prev => {
            if (prev.promptSuggestionEnabled) return prev
            return { ...prev, promptSuggestionEnabled: true }
          })
        }

        if (
          message.request.agentProgressSummaries &&
          getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_prism', true)
        ) {
          setSdkAgentProgressSummariesEnabled(true)
        }

        initialized = true

        // If the auto-resume logic pre-enqueued a command, drain it now
        // that initialize has set up systemPrompt, agents, hooks, etc.
        if (hasCommandsInQueue()) {
          void ctx.run()
        }
      } else if (message.request.subtype === 'set_permission_mode') {
        const m = message.request // for typescript (TODO: use readonly types to avoid this)
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: handleSetPermissionMode(
            m,
            message.request_id,
            prev.toolPermissionContext,
            output,
          ),
          isUltraplanMode: m.ultraplan ?? prev.isUltraplanMode,
        }))
        // handleSetPermissionMode sends the control_response; the
        // notifySessionMetadataChanged that used to follow here is
        // now fired by onChangeAppState (with externalized mode name).
      } else if (message.request.subtype === 'set_model') {
        const requestedModel = message.request.model ?? 'default'
        const model =
          requestedModel === 'default'
            ? getDefaultMainLoopModel()
            : requestedModel
        ctx.activeUserSpecifiedModel = model
        setMainLoopModelOverride(model)
        notifySessionMetadataChanged({ model })
        ctx.injectModelSwitchBreadcrumbs(requestedModel, model)

        ctx.sendControlResponseSuccess(message)
      } else if (message.request.subtype === 'set_max_thinking_tokens') {
        if (message.request.max_thinking_tokens === null) {
          options.thinkingConfig = undefined
        } else if (message.request.max_thinking_tokens === 0) {
          options.thinkingConfig = { type: 'disabled' }
        } else {
          options.thinkingConfig = {
            type: 'enabled',
            budgetTokens: message.request.max_thinking_tokens,
          }
        }
        ctx.sendControlResponseSuccess(message)
      } else if (message.request.subtype === 'mcp_status') {
        ctx.sendControlResponseSuccess(message, {
          mcpServers: ctx.buildMcpServerStatuses(),
        })
      } else if (message.request.subtype === 'get_context_usage') {
        try {
          const appState = getAppState()
          const data = await collectContextData({
            messages: mutableMessages,
            getAppState,
            options: {
              mainLoopModel: getMainLoopModel(),
              tools: ctx.buildAllTools(appState),
              agentDefinitions: appState.agentDefinitions,
              customSystemPrompt: options.systemPrompt,
              appendSystemPrompt: options.appendSystemPrompt,
            },
          })
          ctx.sendControlResponseSuccess(message, { ...data })
        } catch (error) {
          ctx.sendControlResponseError(message, errorMessage(error))
        }
      } else if (message.request.subtype === 'mcp_message') {
        // Handle MCP notifications from SDK servers
        const mcpRequest = message.request
        const sdkClient = ctx.sdkClients.find(
          client => client.name === mcpRequest.server_name,
        )
        // Check client exists - dynamically added SDK servers may have
        // placeholder clients with null client until updateSdkMcp() runs
        if (
          sdkClient &&
          sdkClient.type === 'connected' &&
          sdkClient.client?.transport?.onmessage
        ) {
          sdkClient.client.transport.onmessage(
            mcpRequest.message as JSONRPCMessage,
          )
        }
        ctx.sendControlResponseSuccess(message)
      } else if (message.request.subtype === 'rewind_files') {
        const appState = getAppState()
        const result = await handleRewindFiles(
          message.request.user_message_id as UUID,
          appState,
          setAppState,
          message.request.dry_run ?? false,
        )
        if (result.canRewind || message.request.dry_run) {
          ctx.sendControlResponseSuccess(message, result)
        } else {
          ctx.sendControlResponseError(message, result.error ?? 'Unexpected error')
        }
      } else if (message.request.subtype === 'cancel_async_message') {
        const targetUuid = message.request.message_uuid
        const removed = dequeueAllMatching(cmd => cmd.uuid === targetUuid)
        ctx.sendControlResponseSuccess(message, {
          cancelled: removed.length > 0,
        })
      } else if (message.request.subtype === 'seed_read_state') {
        await handleSeedReadState(ctx, message as unknown as SeedReadStateRequest)
      } else if (message.request.subtype === 'mcp_set_servers') {
        const { response, sdkServersChanged } = await ctx.applyMcpServerChanges(
          message.request.servers,
        )
        ctx.sendControlResponseSuccess(message, response)

        // Connect SDK servers AFTER response to avoid deadlock
        if (sdkServersChanged) {
          void ctx.updateSdkMcp()
        }
      } else if (message.request.subtype === 'reload_plugins') {
        await handleReloadPlugins(ctx, message)
      } else if (message.request.subtype === 'mcp_reconnect') {
        await handleMcpReconnect(ctx, message as unknown as McpServerNameRequest)
      } else if (message.request.subtype === 'mcp_toggle') {
        await handleMcpToggle(ctx, message as unknown as McpToggleRequest)
      } else if (requestSubtype === 'channel_enable') {
        const currentAppState = getAppState()
        handleChannelEnable(
          message.request_id,
          (message.request as unknown as { serverName: string }).serverName,
          // Pool spread matches mcp_status — all three client sources.
          [
            ...currentAppState.mcp.clients,
            ...ctx.sdkClients,
            ...ctx.dynamicMcpState.clients,
          ],
          output,
        )
      } else if (requestSubtype === 'mcp_authenticate') {
        await handleMcpAuthenticate(ctx, message as unknown as McpServerNameRequest)
      } else if (requestSubtype === 'mcp_oauth_callback_url') {
        await handleMcpOauthCallbackUrl(
          ctx,
          message as unknown as McpOauthCallbackUrlRequest,
        )
      } else if (requestSubtype === 'claude_authenticate') {
        await handleClaudeAuthenticate(
          ctx,
          message as unknown as ClaudeAuthenticateRequest,
        )
      } else if (
        requestSubtype === 'claude_oauth_callback' ||
        requestSubtype === 'claude_oauth_wait_for_completion'
      ) {
        handleClaudeOauthCallback(
          ctx,
          message as unknown as ClaudeOauthCallbackRequest,
        )
      } else if (requestSubtype === 'mcp_clear_auth') {
        await handleMcpClearAuth(ctx, message as unknown as McpServerNameRequest)
      } else if (message.request.subtype === 'apply_flag_settings') {
        handleApplyFlagSettings(
          ctx,
          message as unknown as ApplyFlagSettingsRequest,
        )
      } else if (message.request.subtype === 'get_settings') {
        handleGetSettings(ctx, message)
      } else if (message.request.subtype === 'stop_task') {
        const { task_id: taskId } = message.request
        try {
          await stopTask(taskId, {
            getAppState,
            setAppState,
          })
          ctx.sendControlResponseSuccess(message, {})
        } catch (error) {
          ctx.sendControlResponseError(message, errorMessage(error))
        }
      } else if (requestSubtype === 'generate_session_title') {
        handleGenerateSessionTitle(
          ctx,
          message as unknown as GenerateSessionTitleRequest,
        )
      } else if (requestSubtype === 'side_question') {
        handleSideQuestion(ctx, message as unknown as SideQuestionRequest)
      } else if (
        (feature('PROACTIVE') || feature('KAIROS')) &&
        requestSubtype === 'set_proactive'
      ) {
        const req = message.request as unknown as {
          subtype: string
          enabled: boolean
        }
        if (req.enabled) {
          if (!proactiveModule!.isProactiveActive()) {
            proactiveModule!.activateProactive('command')
            ctx.scheduleProactiveTick!()
          }
        } else {
          proactiveModule!.deactivateProactive()
        }
        ctx.sendControlResponseSuccess(message)
      } else if (requestSubtype === 'remote_control') {
        await handleRemoteControl(ctx, message as unknown as RemoteControlRequest)
      } else {
        // Unknown control request subtype — send an error response so
        // the caller doesn't hang waiting for a reply that never comes.
        ctx.sendControlResponseError(
          message,
          `Unsupported control request subtype: ${requestSubtype}`,
        )
      }
      continue
    } else if (message.type === 'control_response') {
      // Replay control_response messages when replay mode is enabled
      if (options.replayUserMessages) {
        output.enqueue(message)
      }
      continue
    } else if (message.type === 'keep_alive') {
      // Silently ignore keep-alive messages
      continue
    } else if (message.type === 'update_environment_variables') {
      // Handled in structuredIO.ts, but TypeScript needs the type guard
      continue
    } else if (message.type === 'assistant' || message.type === 'system') {
      // History replay from bridge: inject into mutableMessages as
      // conversation context so the model sees prior turns.
      const internalMsgs = toInternalMessages([message])
      mutableMessages.push(...internalMsgs)
      // Echo assistant messages back so CCR displays them
      if (message.type === 'assistant' && options.replayUserMessages) {
        output.enqueue(message)
      }
      continue
    }
    // After handling control, keep-alive, env-var, assistant, and system
    // messages above, only user messages should remain.
    if (message.type !== 'user') {
      continue
    }

    // First prompt message implicitly initializes if not already done.
    initialized = true

    // Check for duplicate user message - skip if already processed
    if (message.uuid) {
      const messageUuid = message.uuid as UUID
      const sessionId = getSessionId() as UUID
      const existsInSession = await doesMessageExistInSession(
        sessionId,
        messageUuid,
      )

      // Check both historical duplicates (from file) and runtime duplicates (this session)
      if (existsInSession || hasReceivedMessageUuid(messageUuid)) {
        logForDebugging(`Skipping duplicate user message: ${message.uuid}`)
        // Send acknowledgment for duplicate message if replay mode is enabled
        if (options.replayUserMessages) {
          logForDebugging(
            `Sending acknowledgment for duplicate user message: ${message.uuid}`,
          )
          output.enqueue({
            type: 'user',
            message: message.message,
            session_id: sessionId,
            parent_tool_use_id: null,
            uuid: message.uuid,
            timestamp: message.timestamp,
            isReplay: true,
          } as SDKUserMessageReplay)
        }
        // Historical dup = transcript already has this turn's output, so it
        // ran but its lifecycle was never closed (interrupted before ack).
        // Runtime dups don't need this — the original enqueue path closes them.
        if (existsInSession) {
          notifyCommandLifecycle(message.uuid, 'completed')
        }
        // Don't enqueue duplicate messages for execution
        continue
      }

      // Track this UUID to prevent runtime duplicates
      trackReceivedMessageUuid(messageUuid)
    }

    enqueue({
      mode: 'prompt' as const,
      // file_attachments rides the protobuf catchall from the web composer.
      // Same-ref no-op when absent (no 'file_attachments' key).
      value: await resolveAndPrepend(
        message,
        (message.message as { content: Parameters<typeof resolveAndPrepend>[1] })
          .content,
      ),
      uuid: message.uuid as UUID | undefined,
      priority: message.priority,
    })
    // Increment prompt count for attribution tracking and save snapshot
    // The snapshot persists promptCount so it survives compaction
    if (feature('COMMIT_ATTRIBUTION')) {
      setAppState(prev => ({
        ...prev,
        attribution: incrementPromptCount(prev.attribution, snapshot => {
          void recordAttributionSnapshot(snapshot).catch(error => {
            logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
          })
        }),
      }))
    }
    void ctx.run()
  }
  ctx.inputClosed = true
  ctx.cronScheduler?.stop()
  if (!ctx.running) {
    await ctx.closeOutput()
  }
}
