// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// Settings / session / bridge control-request handlers for the headless stdin
// loop, extracted from `runHeadlessStreaming` (`src/platform/headless/print/runHeadless.ts`)
// as the deferred half of ROADMAP 11b.
//
// Grouped by "mutates process-wide session state" rather than by protocol
// family: flag settings, plugin hot-reload, the readFileState seed queue, the
// two fire-and-forget model calls, and the remote-control bridge.
//
// The fire-and-forget shape of `generate_session_title` and `side_question` is
// load-bearing, not an oversight: the stdin reader is serial, so awaiting an
// API roundtrip here would delay every subsequent user message and interrupt
// for its duration.

import { feature } from 'bun:bundle'
import { readFile, stat } from 'fs/promises'
import { cwd } from 'process'
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { logError } from 'src/shared/log.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { expandPath } from 'src/shared/fs/path.js'
import {
  getCommandName,
  formatDescriptionWithSource,
} from 'src/commands.js'
import { getCommands } from 'src/commands.js'
import { loadAllPluginsCacheOnly } from 'src/services/plugins/pluginLoader.js'
import { refreshActivePlugins } from 'src/services/plugins/refresh.js'
import { redownloadUserSettings } from 'src/platform/settingsSync/index.js'
import { settingsChangeDetector } from 'src/platform/settings/changeDetector.js'
import { getSettingsWithSources } from 'src/platform/settings/settings.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import {
  getFlagSettingsInline,
  setFlagSettingsInline,
  setMainLoopModelOverride,
  getIsRemoteMode,
  getSessionId,
} from 'src/platform/bootstrap/state.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import { modelSupportsEffort, resolveAppliedEffort } from 'src/utils/effort.js'
import { notifySessionMetadataChanged } from 'src/services/session/sessionState.js'
import { createAbortController } from 'src/shared/abortController.js'
import { generateSessionTitle } from 'src/services/session/sessionTitle.js'
import { saveAiGeneratedTitle } from 'src/services/session/sessionStorage.js'
import { getLastCacheSafeParams } from 'src/agent/coordinator/forkedAgent.js'
import { buildSideQuestionFallbackParams } from 'src/agent/queryContext.js'
import { runSideQuestion } from 'src/agent/sideQuestion.js'
import { getRemoteSessionUrl } from 'src/constants/product.js'
import { buildBridgeConnectUrl } from 'src/platform/bridge/bridgeStatusUtil.js'
import { extractInboundMessageFields } from 'src/platform/bridge/inboundMessages.js'
import { enqueue } from 'src/agent/messageQueueManager.js'
import { getDefaultMainLoopModel } from 'src/utils/model/model.js'
import type {
  StdoutMessage,
  SDKControlRequest,
  SDKControlReloadPluginsResponse,
} from 'src/platform/entrypoints/sdk/controlTypes.js'
import type {
  HeadlessStreamingContext,
  ControlRequestWith,
} from 'src/platform/headless/print/streamingContext.js'

export type SeedReadStateRequest = ControlRequestWith<{
  subtype: string
  path: string
  mtime: number
}>

export type ApplyFlagSettingsRequest = ControlRequestWith<{
  subtype: string
  settings: Record<string, unknown>
}>

export type GenerateSessionTitleRequest = ControlRequestWith<{
  subtype: string
  description: string
  persist?: boolean
}>

export type SideQuestionRequest = ControlRequestWith<{
  subtype: string
  question: string
}>

export type RemoteControlRequest = ControlRequestWith<{
  subtype: string
  enabled: boolean
}>

/**
 * Client observed a Read that was later removed from context (e.g. by snip), so
 * transcript-based seeding missed it. Queued into `pendingSeeds`; applied at the
 * next clone-replace boundary.
 */
export async function handleSeedReadState(
  ctx: HeadlessStreamingContext,
  message: SeedReadStateRequest,
): Promise<void> {
  try {
    // expandPath: all other readFileState writers normalize (~, relative,
    // session cwd vs process cwd). FileEditTool looks up by expandPath'd
    // key — a verbatim client path would miss.
    const normalizedPath = expandPath(message.request.path)
    // Check disk mtime before reading content. If the file changed
    // since the client's observation, readFile would return C_current
    // but we'd store it with the client's M_observed — getChangedFiles
    // then sees disk > cache.timestamp, re-reads, diffs C_current vs
    // C_current = empty, emits no attachment, and the model is never
    // told about the C_observed → C_current change. Skipping the seed
    // makes Edit fail "file not read yet" → forces a fresh Read.
    // Math.floor matches FileReadTool and getFileModificationTime.
    const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
    if (diskMtime <= message.request.mtime) {
      const raw = await readFile(normalizedPath, 'utf-8')
      // Strip BOM + normalize CRLF→LF to match readFileInRange and
      // readFileSyncWithMetadata. FileEditTool's content-compare
      // fallback (for Windows mtime bumps without content change)
      // compares against LF-normalized disk reads.
      const content = (
        raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      ).replaceAll('\r\n', '\n')
      ctx.pendingSeeds.set(normalizedPath, {
        content,
        timestamp: diskMtime,
        offset: undefined,
        limit: undefined,
      })
    }
  } catch {
    // ENOENT etc — skip seeding but still succeed
  }
  ctx.sendControlResponseSuccess(message)
}

export async function handleReloadPlugins(
  ctx: HeadlessStreamingContext,
  message: SDKControlRequest,
): Promise<void> {
  const { setAppState } = ctx
  try {
    if (
      feature('DOWNLOAD_USER_SETTINGS') &&
      (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
    ) {
      // Re-pull user settings so enabledPlugins pushed from the
      // user's local CLI take effect before the cache sweep.
      const applied = await redownloadUserSettings()
      if (applied) {
        settingsChangeDetector.notifyChange('userSettings')
      }
    }

    const r = await refreshActivePlugins(setAppState)

    const sdkAgents = ctx.currentAgents.filter(a => a.source === 'flagSettings')
    ctx.currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

    // Reload succeeded — gather response data best-effort so a
    // read failure doesn't mask the successful state change.
    // allSettled so one failure doesn't discard the others.
    let plugins: SDKControlReloadPluginsResponse['plugins'] = []
    const [cmdsR, mcpR, pluginsR] = await Promise.allSettled([
      getCommands(cwd()),
      ctx.applyPluginMcpDiff(),
      loadAllPluginsCacheOnly(),
    ])
    if (cmdsR.status === 'fulfilled') {
      ctx.currentCommands = cmdsR.value
    } else {
      logError(cmdsR.reason)
    }
    if (mcpR.status === 'rejected') {
      logError(mcpR.reason)
    }
    if (pluginsR.status === 'fulfilled') {
      plugins = pluginsR.value.enabled.map(p => ({
        name: p.name,
        path: p.path,
        source: p.source,
      }))
    } else {
      logError(pluginsR.reason)
    }

    ctx.sendControlResponseSuccess(message, {
      commands: ctx.currentCommands
        .filter(cmd => cmd.userInvocable !== false)
        .map(cmd => ({
          name: getCommandName(cmd),
          description: formatDescriptionWithSource(cmd),
          argumentHint: cmd.argumentHint || '',
        })),
      agents: ctx.currentAgents.map(a => ({
        name: a.agentType,
        description: a.whenToUse,
        model: a.model === 'inherit' ? undefined : a.model,
      })),
      plugins,
      mcpServers: ctx.buildMcpServerStatuses(),
      error_count: r.error_count,
    } satisfies SDKControlReloadPluginsResponse)
  } catch (error) {
    ctx.sendControlResponseError(message, errorMessage(error))
  }
}

export function handleApplyFlagSettings(
  ctx: HeadlessStreamingContext,
  message: ApplyFlagSettingsRequest,
): void {
  // Snapshot the current model before applying — we need to detect
  // model switches so we can inject breadcrumbs and notify listeners.
  const prevModel = getMainLoopModel()

  // Merge the provided settings into the in-memory flag settings
  const existing = getFlagSettingsInline() ?? {}
  const incoming = message.request.settings
  // Shallow-merge top-level keys; getSettingsForSource handles
  // the deep merge with file-based flag settings via mergeWith.
  // JSON serialization drops `undefined`, so callers use `null`
  // to signal "clear this key". Convert nulls to deletions so
  // SettingsSchema().safeParse() doesn't reject the whole object
  // (z.string().optional() accepts string | undefined, not null).
  const merged = { ...existing, ...incoming }
  for (const key of Object.keys(merged)) {
    if (merged[key as keyof typeof merged] === null) {
      delete merged[key as keyof typeof merged]
    }
  }
  setFlagSettingsInline(merged)
  // Route through notifyChange so fanOut() resets the settings cache
  // before listeners run. The subscriber in runHeadless calls
  // applySettingsChange for us. Pre-#20625 this was a direct
  // applySettingsChange() call that relied on its own internal reset —
  // now that the reset is centralized in fanOut, a direct call here
  // would read stale cached settings and silently drop the update.
  // Bonus: going through notifyChange also tells the other subscribers
  // (loadPluginHooks, sandbox-adapter) about the change, which the
  // previous direct call skipped.
  settingsChangeDetector.notifyChange('flagSettings')

  // If the incoming settings include a model change, update the
  // override so getMainLoopModel() reflects it. The override has
  // higher priority than the settings cascade in
  // getUserSpecifiedModelSetting(), so without this update,
  // getMainLoopModel() returns the stale override and the model
  // change is silently ignored (matching the set_model handler).
  if ('model' in incoming) {
    if (incoming.model != null) {
      setMainLoopModelOverride(String(incoming.model))
    } else {
      setMainLoopModelOverride(undefined)
    }
  }

  // If the model changed, inject breadcrumbs so the model sees the
  // mid-conversation switch, and notify metadata listeners (CCR).
  const newModel = getMainLoopModel()
  if (newModel !== prevModel) {
    ctx.activeUserSpecifiedModel = newModel
    const modelArg = incoming.model ? String(incoming.model) : 'default'
    notifySessionMetadataChanged({ model: newModel })
    ctx.injectModelSwitchBreadcrumbs(modelArg, newModel)
  }

  ctx.sendControlResponseSuccess(message)
}

export function handleGetSettings(
  ctx: HeadlessStreamingContext,
  message: SDKControlRequest,
): void {
  const currentAppState = ctx.getAppState()
  const model = getMainLoopModel()
  // modelSupportsEffort gate matches claude.ts — applied.effort must
  // mirror what actually goes to the API, not just what's configured.
  const effort = modelSupportsEffort(model)
    ? resolveAppliedEffort(model, currentAppState.effortValue)
    : undefined
  ctx.sendControlResponseSuccess(message, {
    ...getSettingsWithSources(),
    applied: {
      model,
      // Numeric effort (internal-only) → null; SDK schema is string-level only.
      effort: typeof effort === 'string' ? effort : null,
    },
  })
}

export function handleGenerateSessionTitle(
  ctx: HeadlessStreamingContext,
  message: GenerateSessionTitleRequest,
): void {
  // Fire-and-forget so the Haiku call does not block the stdin loop
  // (which would delay processing of subsequent user messages /
  // interrupts for the duration of the API roundtrip).
  const { description, persist } = message.request
  // Reuse the live controller only if it has not already been aborted
  // (e.g. by interrupt()); an aborted signal would cause queryHaiku to
  // immediately throw APIUserAbortError → {title: null}.
  const titleSignal = (
    ctx.abortController && !ctx.abortController.signal.aborted
      ? ctx.abortController
      : createAbortController()
  ).signal
  void (async () => {
    try {
      const title = await generateSessionTitle(description, titleSignal)
      if (title && persist) {
        try {
          saveAiGeneratedTitle(getSessionId() as UUID, title)
        } catch (e) {
          logError(e)
        }
      }
      ctx.sendControlResponseSuccess(message, { title })
    } catch (e) {
      // Unreachable in practice — generateSessionTitle wraps its
      // own body and returns null, saveAiGeneratedTitle is wrapped
      // above. Propagate (not swallow) so unexpected failures are
      // visible to the SDK caller (hostComms.ts catches and logs).
      ctx.sendControlResponseError(message, errorMessage(e))
    }
  })()
}

export function handleSideQuestion(
  ctx: HeadlessStreamingContext,
  message: SideQuestionRequest,
): void {
  // Same fire-and-forget pattern as generate_session_title above —
  // the forked agent's API roundtrip must not block the stdin loop.
  //
  // The snapshot captured by stopHooks (for querySource === 'sdk')
  // holds the exact systemPrompt/userContext/systemContext/messages
  // sent on the last main-thread turn. Reusing them gives a byte-
  // identical prefix → prompt cache hit.
  //
  // Fallback (resume before first turn completes — no snapshot yet):
  // rebuild from scratch. buildSideQuestionFallbackParams mirrors
  // QueryEngine.ts:ask()'s system prompt assembly (including
  // --system-prompt / --append-system-prompt) so the rebuilt prefix
  // matches in the common case. May still miss the cache for
  // coordinator mode or memory-mechanics extras — acceptable, the
  // alternative is the side question failing entirely.
  const { getAppState, setAppState, options, mutableMessages } = ctx
  const { question } = message.request
  void (async () => {
    try {
      const saved = getLastCacheSafeParams()
      const cacheSafeParams = saved
        ? {
            ...saved,
            // If the last turn was interrupted, the snapshot holds an
            // already-aborted controller; createChildAbortController in
            // createSubagentContext would propagate it and the fork
            // would die before sending a request. The controller is
            // not part of the cache key — swapping in a fresh one is
            // safe. Same guard as generate_session_title above.
            toolUseContext: {
              ...saved.toolUseContext,
              abortController: createAbortController(),
            },
          }
        : await buildSideQuestionFallbackParams({
            tools: ctx.buildAllTools(getAppState()),
            commands: ctx.currentCommands,
            mcpClients: [
              ...getAppState().mcp.clients,
              ...ctx.sdkClients,
              ...ctx.dynamicMcpState.clients,
            ],
            messages: mutableMessages,
            readFileState: ctx.readFileState,
            getAppState,
            setAppState,
            customSystemPrompt: options.systemPrompt,
            appendSystemPrompt: options.appendSystemPrompt,
            thinkingConfig: options.thinkingConfig,
            agents: ctx.currentAgents,
          })
      const result = await runSideQuestion({
        question,
        cacheSafeParams,
      })
      ctx.sendControlResponseSuccess(message, { response: result.response })
    } catch (e) {
      ctx.sendControlResponseError(message, errorMessage(e))
    }
  })()
}

export async function handleRemoteControl(
  ctx: HeadlessStreamingContext,
  message: RemoteControlRequest,
): Promise<void> {
  const { structuredIO, output, options, mutableMessages } = ctx
  if (message.request.enabled) {
    if (ctx.bridgeHandle) {
      // Already connected
      ctx.sendControlResponseSuccess(message, {
        session_url: getRemoteSessionUrl(
          ctx.bridgeHandle.bridgeSessionId,
          ctx.bridgeHandle.sessionIngressUrl,
        ),
        connect_url: buildBridgeConnectUrl(
          ctx.bridgeHandle.environmentId,
          ctx.bridgeHandle.sessionIngressUrl,
        ),
        environment_id: ctx.bridgeHandle.environmentId,
      })
    } else {
      // initReplBridge surfaces gate-failure reasons via
      // onStateChange('failed', detail) before returning null.
      // Capture so the control-response error is actionable
      // ("/login", "disabled by your organization's policy", etc.)
      // instead of a generic "initialization failed".
      let bridgeFailureDetail: string | undefined
      try {
        const { initReplBridge } = await import('src/platform/bridge/initReplBridge.js')
        const handle = await initReplBridge({
          onInboundMessage(msg) {
            const fields = extractInboundMessageFields(msg)
            if (!fields) return
            const { content, uuid } = fields
            enqueue({
              value: content,
              mode: 'prompt' as const,
              uuid,
              skipSlashCommands: true,
            })
            void ctx.run()
          },
          onPermissionResponse(response) {
            // Forward bridge permission responses into the
            // stdin processing loop so they resolve pending
            // permission requests from the SDK consumer.
            structuredIO.injectControlResponse(response)
          },
          onInterrupt() {
            ctx.abortController?.abort()
          },
          onSetModel(model) {
            const resolved =
              model === 'default' ? getDefaultMainLoopModel() : model
            ctx.activeUserSpecifiedModel = resolved
            setMainLoopModelOverride(resolved)
          },
          onSetMaxThinkingTokens(maxTokens) {
            if (maxTokens === null) {
              options.thinkingConfig = undefined
            } else if (maxTokens === 0) {
              options.thinkingConfig = { type: 'disabled' }
            } else {
              options.thinkingConfig = {
                type: 'enabled',
                budgetTokens: maxTokens,
              }
            }
          },
          onStateChange(state, detail) {
            if (state === 'failed') {
              bridgeFailureDetail = detail
            }
            logForDebugging(
              `[bridge:sdk] State change: ${state}${detail ? ` — ${detail}` : ''}`,
            )
            output.enqueue({
              type: 'system' as StdoutMessage['type'],
              subtype: 'bridge_state' as string,
              state,
              detail,
              uuid: randomUUID(),
              session_id: getSessionId(),
            } as StdoutMessage)
          },
          initialMessages:
            mutableMessages.length > 0 ? mutableMessages : undefined,
        })
        if (!handle) {
          ctx.sendControlResponseError(
            message,
            bridgeFailureDetail ?? 'Remote Control initialization failed',
          )
        } else {
          ctx.bridgeHandle = handle
          ctx.bridgeLastForwardedIndex = mutableMessages.length
          // Forward permission requests to the bridge
          structuredIO.setOnControlRequestSent(request => {
            handle.sendControlRequest(request)
          })
          // Cancel stale bridge permission prompts when the SDK
          // consumer resolves a can_use_tool request first.
          structuredIO.setOnControlRequestResolved(requestId => {
            handle.sendControlCancelRequest(requestId)
          })
          ctx.sendControlResponseSuccess(message, {
            session_url: getRemoteSessionUrl(
              handle.bridgeSessionId,
              handle.sessionIngressUrl,
            ),
            connect_url: buildBridgeConnectUrl(
              handle.environmentId,
              handle.sessionIngressUrl,
            ),
            environment_id: handle.environmentId,
          })
        }
      } catch (err) {
        ctx.sendControlResponseError(message, errorMessage(err))
      }
    }
  } else {
    // Disable
    if (ctx.bridgeHandle) {
      structuredIO.setOnControlRequestSent(undefined)
      structuredIO.setOnControlRequestResolved(undefined)
      await ctx.bridgeHandle.teardown()
      ctx.bridgeHandle = null
    }
    ctx.sendControlResponseSuccess(message)
  }
}
