// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// The MCP/plugin runtime of the headless streaming host, extracted from
// `src/platform/headless/print/runHeadless.ts` as the deferred half of ROADMAP 11b.
//
// Everything here used to be a nested function inside `runHeadlessStreaming`,
// carrying comments like "NOTE: Nested function required - mutates closure
// state". That is still true in substance — these functions mutate
// `sdkClients`, `sdkTools`, `dynamicMcpState`, `currentCommands` and
// `currentAgents` — but the state now lives on the shared
// `HeadlessStreamingContext` object rather than in a lexical scope, so the
// functions can be top-level. The aliasing is identical; see the invariant
// notes in `streamingContext.ts` (in particular: never destructure the mutable
// fields, or late-connecting servers become invisible again).

import { feature } from 'bun:bundle'
import uniqBy from 'lodash-es/uniqBy.js'
import { uniq } from 'src/shared/data/array.js'
import { cwd } from 'process'
import { waitForRemoteManagedSettingsToLoad } from 'src/platform/remoteManagedSettings/index.js'
import { assembleToolPool } from 'src/tools/tools.js'
import { mergeAndFilterTools } from 'src/agent/tools/toolPool.js'
import { toolMatchesName, type Tools } from 'src/tools/Tool.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/platform/analytics/index.js'
import { logForDebugging } from 'src/shared/debug.js'
import { withDiagnosticsTiming } from 'src/shared/diagLogs.js'
import { logError, logMCPDebug } from 'src/shared/log.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import {
  isChannelAllowlisted,
  isChannelsEnabled,
} from 'src/mcp/channelAllowlist.js'
import type {
  McpServerConfigForProcessTransport,
  McpServerStatus,
} from 'src/platform/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { setupSdkMcpClients } from 'src/mcp/client.js'
import { getAllMcpConfigs } from 'src/mcp/config.js'
import {
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/mcp/elicitationHandler.js'
import { executeNotificationHooks } from 'src/platform/lifecycleHooks/hooks.js'
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getMcpPrefix } from 'src/mcp/mcpStringUtils.js'
import { filterToolsByServer } from 'src/mcp/utils.js'
import { setupVscodeSdkMcp } from 'src/mcp/vscodeSdkMcp.js'
import {
  getInitJsonSchema,
  getSessionId,
} from 'src/platform/bootstrap/state.js'
import { createSyntheticOutputTool } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { randomUUID } from 'crypto'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { getCommands } from 'src/commands/commands.js'
import { installPluginsForHeadless } from 'src/plugins/headlessPluginInstall.js'
import { refreshActivePlugins } from 'src/plugins/refresh.js'
import { handleMcpSetServers } from 'src/platform/headless/print/mcpReconcile.js'
import type {
  HeadlessStreamingContext,
  McpSetServersOutcome,
} from 'src/platform/headless/print/streamingContext.js'

/**
 * Register elicitation request/completion handlers on connected MCP clients
 * that haven't been registered yet. SDK MCP servers are excluded because they
 * route through SdkControlClientTransport. Hooks run first (matching REPL
 * behavior); if no hook responds, the request is forwarded to the SDK
 * consumer via the control protocol.
 */
export function registerElicitationHandlers(
  ctx: HeadlessStreamingContext,
  clients: MCPServerConnection[],
): void {
  const { structuredIO, output, elicitationRegistered } = ctx
  for (const connection of clients) {
    if (
      connection.type !== 'connected' ||
      elicitationRegistered.has(connection.name)
    ) {
      continue
    }
    // Skip SDK MCP servers — elicitation flows through SdkControlClientTransport
    if (connection.config.type === 'sdk') {
      continue
    }
    const serverName = connection.name

    // Wrapped in try/catch because setRequestHandler throws if the client wasn't
    // created with elicitation capability declared (e.g., SDK-created clients).
    try {
      connection.client.setRequestHandler(
        ElicitRequestSchema,
        async (request, extra) => {
          logMCPDebug(
            serverName,
            `Elicitation request received in print mode: ${jsonStringify(request)}`,
          )

          const mode = request.params.mode === 'url' ? 'url' : 'form'

          logEvent('tengu_mcp_elicitation_shown', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          // Run elicitation hooks first — they can provide a response programmatically
          const hookResponse = await runElicitationHooks(
            serverName,
            request.params,
            extra.signal,
          )
          if (hookResponse) {
            logMCPDebug(
              serverName,
              `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
            )
            logEvent('tengu_mcp_elicitation_response', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              action:
                hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return hookResponse
          }

          // Delegate to SDK consumer via control protocol
          const url =
            'url' in request.params ? (request.params.url as string) : undefined
          const requestedSchema =
            'requestedSchema' in request.params
              ? (request.params.requestedSchema as
                  | Record<string, unknown>
                  | undefined)
              : undefined

          const elicitationId =
            'elicitationId' in request.params
              ? (request.params.elicitationId as string | undefined)
              : undefined

          const rawResult = await structuredIO.handleElicitation(
            serverName,
            request.params.message,
            requestedSchema,
            extra.signal,
            mode,
            url,
            elicitationId,
          )

          const result = await runElicitationResultHooks(
            serverName,
            rawResult,
            extra.signal,
            mode,
            elicitationId,
          )

          logEvent('tengu_mcp_elicitation_response', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            action:
              result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return result
        },
      )

      // Surface completion notifications to SDK consumers (URL mode)
      connection.client.setNotificationHandler(
        ElicitationCompleteNotificationSchema,
        notification => {
          const { elicitationId } = notification.params
          logMCPDebug(
            serverName,
            `Elicitation completion notification: ${elicitationId}`,
          )
          void executeNotificationHooks({
            message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
            notificationType: 'elicitation_complete',
          })
          output.enqueue({
            type: 'system',
            subtype: 'elicitation_complete',
            mcp_server_name: serverName,
            elicitation_id: elicitationId,
            uuid: randomUUID(),
            session_id: getSessionId(),
          })
        },
      )

      elicitationRegistered.add(serverName)
    } catch {
      // setRequestHandler throws if the client wasn't created with
      // elicitation capability — skip silently
    }
  }
}

export async function updateSdkMcp(
  ctx: HeadlessStreamingContext,
): Promise<void> {
  const { sdkMcpConfigs, structuredIO, setAppState } = ctx
  // Check if SDK MCP servers need to be updated (new servers added or removed)
  const currentServerNames = new Set(Object.keys(sdkMcpConfigs))
  const connectedServerNames = new Set(ctx.sdkClients.map(c => c.name))

  // Check if there are any differences (additions or removals)
  const hasNewServers = Array.from(currentServerNames).some(
    name => !connectedServerNames.has(name),
  )
  const hasRemovedServers = Array.from(connectedServerNames).some(
    name => !currentServerNames.has(name),
  )
  // Check if any SDK clients are pending and need to be upgraded
  const hasPendingSdkClients = ctx.sdkClients.some(c => c.type === 'pending')
  // Check if any SDK clients failed their handshake and need to be retried.
  // Without this, a client that lands in 'failed' (e.g. handshake timeout on
  // a WS reconnect race) stays failed forever — its name satisfies the
  // connectedServerNames diff but it contributes zero tools.
  const hasFailedSdkClients = ctx.sdkClients.some(c => c.type === 'failed')

  const haveServersChanged =
    hasNewServers ||
    hasRemovedServers ||
    hasPendingSdkClients ||
    hasFailedSdkClients

  if (haveServersChanged) {
    // Clean up removed servers
    for (const client of ctx.sdkClients) {
      if (!currentServerNames.has(client.name)) {
        if (client.type === 'connected') {
          await client.cleanup()
        }
      }
    }

    // Re-initialize all SDK MCP servers with current config
    const sdkSetup = await setupSdkMcpClients(sdkMcpConfigs, (serverName, message) =>
      structuredIO.sendMcpMessage(serverName, message),
    )
    ctx.sdkClients = sdkSetup.clients
    ctx.sdkTools = sdkSetup.tools

    // Store SDK MCP tools in appState so subagents can access them via
    // assembleToolPool. Only tools are stored here — SDK clients are already
    // merged separately in the query loop (allMcpClients) and mcp_status handler.
    // Use both old (connectedServerNames) and new (currentServerNames) to remove
    // stale SDK tools when servers are added or removed.
    const allSdkNames = uniq([...connectedServerNames, ...currentServerNames])
    const sdkTools = ctx.sdkTools
    setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        tools: [
          ...prev.mcp.tools.filter(
            t => !allSdkNames.some(name => t.name.startsWith(getMcpPrefix(name))),
          ),
          ...sdkTools,
        ],
      },
    }))

    // Set up the special internal VSCode MCP server if necessary.
    setupVscodeSdkMcp(ctx.sdkClients)
  }
}

/**
 * Shared tool assembly for `ask()` and the `get_context_usage` control request.
 * Reads the mutable `sdkTools`/`dynamicMcpState` fields on every call so both
 * call sites see late-connecting servers.
 */
export function buildAllTools(
  ctx: HeadlessStreamingContext,
  appState: AppState,
): Tools {
  const { baseTools, options } = ctx
  const assembledTools = assembleToolPool(
    appState.toolPermissionContext,
    appState.mcp.tools,
  )
  let allTools = uniqBy(
    mergeAndFilterTools(
      [...baseTools, ...ctx.sdkTools, ...ctx.dynamicMcpState.tools],
      assembledTools,
      appState.toolPermissionContext.mode,
    ),
    'name',
  )
  if (options.permissionPromptToolName) {
    allTools = allTools.filter(
      tool => !toolMatchesName(tool, options.permissionPromptToolName!),
    )
  }
  const initJsonSchema = getInitJsonSchema()
  if (initJsonSchema && !options.jsonSchema) {
    const syntheticOutputResult = createSyntheticOutputTool(initJsonSchema)
    if ('tool' in syntheticOutputResult) {
      allTools = [...allTools, syntheticOutputResult.tool]
    }
  }
  return allTools
}

/**
 * Forward new messages from `mutableMessages` to the bridge.
 * Called incrementally during each turn (so claude.ai sees progress
 * and stays alive during permission waits) and again after the turn.
 *
 * writeMessages has its own UUID-based dedup (initialMessageUUIDs,
 * recentPostedUUIDs) — the index cursor here is a pre-filter to avoid
 * O(n) re-scanning of already-sent messages on every call.
 */
export function forwardMessagesToBridge(ctx: HeadlessStreamingContext): void {
  const { mutableMessages } = ctx
  if (!ctx.bridgeHandle) return
  // Guard against mutableMessages shrinking (compaction truncates it).
  const startIndex = Math.min(ctx.bridgeLastForwardedIndex, mutableMessages.length)
  const newMessages = mutableMessages
    .slice(startIndex)
    .filter(m => m.type === 'user' || m.type === 'assistant')
  ctx.bridgeLastForwardedIndex = mutableMessages.length
  if (newMessages.length > 0) {
    ctx.bridgeHandle.writeMessages(newMessages)
  }
}

/**
 * Apply MCP server changes — used by both the `mcp_set_servers` control message
 * and background plugin installation. Mutates `sdkMcpConfigs` (in place),
 * `sdkClients`, `sdkTools` and `dynamicMcpState` on the context.
 */
export function applyMcpServerChanges(
  ctx: HeadlessStreamingContext,
  servers: Record<string, McpServerConfigForProcessTransport>,
): Promise<McpSetServersOutcome> {
  const { sdkMcpConfigs, setAppState } = ctx
  // Serialize calls to prevent race conditions between concurrent callers
  // (background plugin install and mcp_set_servers control messages)
  const doWork = async (): Promise<McpSetServersOutcome> => {
    const oldSdkClientNames = new Set(ctx.sdkClients.map(c => c.name))

    const result = await handleMcpSetServers(
      servers,
      {
        configs: sdkMcpConfigs,
        clients: ctx.sdkClients,
        tools: ctx.sdkTools,
      },
      ctx.dynamicMcpState,
      setAppState,
    )

    // Update SDK state (need to mutate sdkMcpConfigs since it's shared)
    for (const key of Object.keys(sdkMcpConfigs)) {
      delete sdkMcpConfigs[key]
    }
    Object.assign(sdkMcpConfigs, result.newSdkState.configs)
    ctx.sdkClients = result.newSdkState.clients
    ctx.sdkTools = result.newSdkState.tools
    ctx.dynamicMcpState = result.newDynamicState

    // Keep appState.mcp.tools in sync so subagents can see SDK MCP tools.
    // Use both old and new SDK client names to remove stale tools.
    if (result.sdkServersChanged) {
      const newSdkClientNames = new Set(ctx.sdkClients.map(c => c.name))
      const allSdkNames = uniq([...oldSdkClientNames, ...newSdkClientNames])
      const sdkTools = ctx.sdkTools
      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          tools: [
            ...prev.mcp.tools.filter(
              t =>
                !allSdkNames.some(name => t.name.startsWith(getMcpPrefix(name))),
            ),
            ...sdkTools,
          ],
        },
      }))
    }

    return {
      response: result.response,
      sdkServersChanged: result.sdkServersChanged,
    }
  }

  ctx.mcpChangesPromise = ctx.mcpChangesPromise.then(doWork, doWork)
  return ctx.mcpChangesPromise
}

/**
 * Build `McpServerStatus[]` for control responses. Shared by `mcp_status` and
 * `reload_plugins`. Reads the mutable `sdkClients`/`dynamicMcpState` fields.
 */
export function buildMcpServerStatuses(
  ctx: HeadlessStreamingContext,
): McpServerStatus[] {
  const currentAppState = ctx.getAppState()
  const currentMcpClients = currentAppState.mcp.clients
  const allMcpTools = uniqBy(
    [...currentAppState.mcp.tools, ...ctx.dynamicMcpState.tools],
    'name',
  )
  const existingNames = new Set([
    ...currentMcpClients.map(c => c.name),
    ...ctx.sdkClients.map(c => c.name),
  ])
  return [
    ...currentMcpClients,
    ...ctx.sdkClients,
    ...ctx.dynamicMcpState.clients.filter(c => !existingNames.has(c.name)),
  ].map(connection => {
    let config
    if (connection.config.type === 'sse' || connection.config.type === 'http') {
      config = {
        type: connection.config.type,
        url: connection.config.url,
        headers: connection.config.headers,
        oauth: connection.config.oauth,
      }
    } else if (connection.config.type === 'claudeai-proxy') {
      config = {
        type: 'claudeai-proxy' as const,
        url: connection.config.url,
        id: connection.config.id,
      }
    } else if (
      connection.config.type === 'stdio' ||
      connection.config.type === undefined
    ) {
      config = {
        type: 'stdio' as const,
        command: connection.config.command,
        args: connection.config.args,
      }
    }
    const serverTools =
      connection.type === 'connected'
        ? filterToolsByServer(allMcpTools, connection.name).map(tool => ({
            name: tool.mcpInfo?.toolName ?? tool.name,
            annotations: {
              readOnly: tool.isReadOnly({}) || undefined,
              destructive: tool.isDestructive?.({}) || undefined,
              openWorld: tool.isOpenWorld?.({}) || undefined,
            },
          }))
        : undefined
    // Capabilities passthrough with allowlist pre-filter. The IDE reads
    // experimental['claude/channel'] to decide whether to show the
    // Enable-channel prompt — only echo it if channel_enable would
    // actually pass the allowlist. Not a security boundary (the
    // handler re-runs the full gate); just avoids dead buttons.
    let capabilities: { experimental?: Record<string, unknown> } | undefined
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      connection.type === 'connected' &&
      connection.capabilities.experimental
    ) {
      const exp = { ...connection.capabilities.experimental }
      if (
        exp['claude/channel'] &&
        (!isChannelsEnabled() ||
          !isChannelAllowlisted(connection.config.pluginSource))
      ) {
        delete exp['claude/channel']
      }
      if (Object.keys(exp).length > 0) {
        capabilities = { experimental: exp }
      }
    }
    return {
      name: connection.name,
      status: connection.type,
      serverInfo:
        connection.type === 'connected' ? connection.serverInfo : undefined,
      error: connection.type === 'failed' ? connection.error : undefined,
      config,
      scope: connection.config.scope,
      tools: serverTools,
      capabilities,
    }
  })
}

export async function installPluginsAndApplyMcpInBackground(
  ctx: HeadlessStreamingContext,
): Promise<void> {
  try {
    // Join point for managed settings, fired in main.tsx preAction.
    await withDiagnosticsTiming('headless_managed_settings_wait', () =>
      waitForRemoteManagedSettingsToLoad(),
    )

    const pluginsInstalled = await installPluginsForHeadless()

    if (pluginsInstalled) {
      await ctx.applyPluginMcpDiff()
    }
  } catch (error) {
    logError(error)
  }
}

/**
 * Clear all plugin-related caches, reload commands/agents/hooks.
 * Called after CLAUDIN_SYNC_PLUGIN_INSTALL completes (before first query)
 * and after non-sync background install finishes.
 * refreshActivePlugins calls clearAllCaches() which is required because
 * loadAllPlugins() may have run during main.tsx startup BEFORE managed
 * settings were fetched. Without clearing, getCommands() would rebuild
 * from a stale plugin list.
 */
export async function refreshPluginState(
  ctx: HeadlessStreamingContext,
): Promise<void> {
  // refreshActivePlugins handles the full cache sweep (clearAllCaches),
  // reloads all plugin component loaders, writes AppState.plugins +
  // AppState.agentDefinitions, registers hooks, and bumps mcp.pluginReconnectKey.
  const { agentDefinitions: freshAgentDefs } = await refreshActivePlugins(
    ctx.setAppState,
  )

  // Headless-specific: currentCommands/currentAgents are mutable context fields
  // captured by the query loop (REPL uses AppState instead). getCommands is
  // fresh because refreshActivePlugins cleared its cache.
  ctx.currentCommands = await getCommands(cwd())

  // Preserve SDK-provided agents (--agents CLI flag or SDK initialize
  // control_request) — both inject via parseAgentsFromJson with
  // source='flagSettings'. loadMarkdownFilesForSubdir never assigns this
  // source, so it cleanly discriminates "injected, not disk-loadable".
  //
  // The previous filter used a negative set-diff (!freshAgentTypes.has(a))
  // which also matched plugin agents that were in the poisoned initial
  // currentAgents but correctly excluded from freshAgentDefs after managed
  // settings applied — leaking policy-blocked agents into the init message.
  // See gh-23085: isBridgeEnabled() at Commander-definition time poisoned
  // the settings cache before setEligibility(true) ran.
  const sdkAgents = ctx.currentAgents.filter(a => a.source === 'flagSettings')
  ctx.currentAgents = [...freshAgentDefs.allAgents, ...sdkAgents]
}

/**
 * Re-diff MCP configs after plugin state changes. Filters to
 * process-transport-supported types and carries SDK-mode servers through
 * so applyMcpServerChanges' diff doesn't close their transports.
 */
export async function applyPluginMcpDiff(
  ctx: HeadlessStreamingContext,
): Promise<void> {
  const { sdkMcpConfigs } = ctx
  const { servers: newConfigs } = await getAllMcpConfigs()
  const supportedConfigs: Record<string, McpServerConfigForProcessTransport> = {}
  for (const [name, config] of Object.entries(newConfigs)) {
    const type = config.type
    if (
      type === undefined ||
      type === 'stdio' ||
      type === 'sse' ||
      type === 'http' ||
      type === 'sdk'
    ) {
      supportedConfigs[name] = config
    }
  }
  for (const [name, config] of Object.entries(sdkMcpConfigs)) {
    if (config.type === 'sdk' && !(name in supportedConfigs)) {
      supportedConfigs[name] = config
    }
  }
  const { response, sdkServersChanged } =
    await ctx.applyMcpServerChanges(supportedConfigs)
  if (sdkServersChanged) {
    void ctx.updateSdkMcp()
  }
  logForDebugging(
    `Headless MCP refresh: added=${response.added.length}, removed=${response.removed.length}`,
  )
}
