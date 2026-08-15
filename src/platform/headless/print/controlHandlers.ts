import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import type {
  RewindFilesResult,
} from 'src/platform/entrypoints/agentSdkTypes.js'
import type { StdoutMessage } from 'src/platform/entrypoints/sdk/controlTypes.js'
import type { PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { Stream } from 'src/shared/stream.js'
import {
  ChannelMessageNotificationSchema,
  gateChannelServer,
  wrapChannelMessage,
  findChannelEntry,
} from 'src/services/mcp/channelNotification.js'
import { asMcpSchema } from 'src/services/mcp/zodCompat.js'
import {
  getAllowedChannels,
  setAllowedChannels,
  type ChannelEntry,
} from 'src/platform/bootstrap/state.js'
import {
  fileHistoryRewind,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from 'src/shared/fs/fileHistory.js'
import { parsePluginIdentifier } from 'src/services/plugins/pluginIdentifier.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/platform/analytics/index.js'
import {
  isAutoModeGateEnabled,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from 'src/permissions/permissionSetup.js'
import { enqueue } from 'src/agent/messageQueueManager.js'

export async function handleRewindFiles(
  userMessageId: UUID,
  appState: AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  dryRun: boolean,
): Promise<RewindFilesResult> {
  if (!fileHistoryEnabled()) {
    return { canRewind: false, error: 'File rewinding is not enabled.' }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }

  if (dryRun) {
    const diffStats = await fileHistoryGetDiffStats(
      appState.fileHistory,
      userMessageId,
    )
    return {
      canRewind: true,
      filesChanged: diffStats?.filesChanged,
      insertions: diffStats?.insertions,
      deletions: diffStats?.deletions,
    }
  }

  try {
    await fileHistoryRewind(
      updater =>
        setAppState(prev => ({
          ...prev,
          fileHistory: updater(prev.fileHistory),
        })),
      userMessageId,
    )
  } catch (error) {
    return {
      canRewind: false,
      error: `Failed to rewind: ${errorMessage(error)}`,
    }
  }

  return { canRewind: true }
}

export function handleSetPermissionMode(
  request: { mode: InternalPermissionMode },
  requestId: string,
  toolPermissionContext: ToolPermissionContext,
  output: Stream<StdoutMessage>,
): ToolPermissionContext {
  // Check if trying to switch to bypassPermissions mode
  if (request.mode === 'bypassPermissions') {
    if (isBypassPermissionsModeDisabled()) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
        },
      })
      return toolPermissionContext
    }
    if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions. Enable it with --allow-dangerously-skip-permissions or set permissions.allowBypassPermissionsMode in settings.json',
        },
      })
      return toolPermissionContext
    }
  }

  // Check if trying to switch to auto mode without the classifier gate
  if (
    feature('TRANSCRIPT_CLASSIFIER') &&
    request.mode === 'auto' &&
    !isAutoModeGateEnabled()
  ) {
    const reason = getAutoModeUnavailableReason()
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: reason
          ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
          : 'Cannot set permission mode to auto',
      },
    })
    return toolPermissionContext
  }

  // Allow the mode switch
  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        mode: request.mode,
      },
    },
  })

  return {
    ...transitionPermissionMode(
      toolPermissionContext.mode,
      request.mode,
      toolPermissionContext,
    ),
    mode: request.mode,
  }
}

/**
 * IDE-triggered channel enable. Derives the ChannelEntry from the connection's
 * pluginSource (IDE can't spoof kind/marketplace — we only take the server
 * name), appends it to session allowedChannels, and runs the full gate. On
 * gate failure, rolls back the append. On success, registers a notification
 * handler that enqueues channel messages at priority:'next' — drainCommandQueue
 * picks them up between turns.
 *
 * Intentionally does NOT register the claude/channel/permission handler that
 * useManageMCPConnections sets up for interactive mode. That handler resolves
 * a pending dialog inside handleInteractivePermission — but print.ts never
 * calls handleInteractivePermission. When SDK permission lands on 'ask', it
 * goes to the consumer's canUseTool callback over stdio; there is no CLI-side
 * dialog for a remote "yes tbxkq" to resolve. If an IDE wants channel-relayed
 * tool approval, that's IDE-side plumbing against its own pending-map. (Also
 * gated separately by tengu_harbor_permissions — not yet shipping on
 * interactive either.)
 */
export function handleChannelEnable(
  requestId: string,
  serverName: string,
  connectionPool: readonly MCPServerConnection[],
  output: Stream<StdoutMessage>,
): void {
  const respondError = (error: string) =>
    output.enqueue({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })

  if (!(feature('KAIROS') || feature('KAIROS_CHANNELS'))) {
    return respondError('channels feature not available in this build')
  }

  // Only a 'connected' client has .capabilities and .client to register the
  // handler on. The pool spread at the call site matches mcp_status.
  const connection = connectionPool.find(
    c => c.name === serverName && c.type === 'connected',
  )
  if (!connection || connection.type !== 'connected') {
    return respondError(`server ${serverName} is not connected`)
  }

  const pluginSource = connection.config.pluginSource
  const parsed = pluginSource ? parsePluginIdentifier(pluginSource) : undefined
  if (!parsed?.marketplace) {
    // No pluginSource or @-less source — can never pass the {plugin,
    // marketplace}-keyed allowlist. Short-circuit with the same reason the
    // gate would produce.
    return respondError(
      `server ${serverName} is not plugin-sourced; channel_enable requires a marketplace plugin`,
    )
  }

  const entry: ChannelEntry = {
    kind: 'plugin',
    name: parsed.name,
    marketplace: parsed.marketplace,
  }
  // Idempotency: don't double-append on repeat enable.
  const prior = getAllowedChannels()
  const already = prior.some(
    e =>
      e.kind === 'plugin' &&
      e.name === entry.name &&
      e.marketplace === entry.marketplace,
  )
  if (!already) setAllowedChannels([...prior, entry])

  const gate = gateChannelServer(
    serverName,
    connection.capabilities,
    pluginSource,
  )
  if (gate.action === 'skip') {
    // Rollback — only remove the entry we appended.
    if (!already) setAllowedChannels(prior)
    return respondError(gate.reason)
  }

  const pluginId =
    `${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  logMCPDebug(serverName, 'Channel notifications registered')
  logEvent('tengu_mcp_channel_enable', { plugin: pluginId })

  // Identical enqueue shape to the interactive register block in
  // useManageMCPConnections. drainCommandQueue processes it between turns —
  // channel messages queue at priority 'next' and are seen by the model on
  // the turn after they arrive.
  connection.client.setNotificationHandler(
    asMcpSchema(ChannelMessageNotificationSchema()),
    async notification => {
      const { content, meta } = notification.params
      logMCPDebug(
        serverName,
        `notifications/claude/channel: ${content.slice(0, 80)}`,
      )
      logEvent('tengu_mcp_channel_message', {
        content_length: content.length,
        meta_key_count: Object.keys(meta ?? {}).length,
        entry_kind:
          'plugin' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_dev: false,
        plugin: pluginId,
      })
      enqueue({
        mode: 'prompt',
        value: wrapChannelMessage(serverName, content, meta),
        priority: 'next',
        isMeta: true,
        origin: { kind: 'channel', server: serverName },
        skipSlashCommands: true,
      })
    },
  )

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: undefined,
    },
  })
}

/**
 * Re-register the channel notification handler after mcp_reconnect /
 * mcp_toggle creates a new client. handleChannelEnable bound the handler to
 * the OLD client object; allowedChannels survives the reconnect but the
 * handler binding does not. Without this, channel messages silently drop
 * after a reconnect while the IDE still believes the channel is live.
 *
 * Mirrors the interactive CLI's onConnectionAttempt in
 * useManageMCPConnections, which re-gates on every new connection. Paired
 * with registerElicitationHandlers at the same call sites.
 *
 * No-op if the server was never channel-enabled: gateChannelServer calls
 * findChannelEntry internally and returns skip/session for an unlisted
 * server, so reconnecting a non-channel MCP server costs one feature-flag
 * check.
 */
export function reregisterChannelHandlerAfterReconnect(
  connection: MCPServerConnection,
): void {
  if (!(feature('KAIROS') || feature('KAIROS_CHANNELS'))) return
  if (connection.type !== 'connected') return

  const gate = gateChannelServer(
    connection.name,
    connection.capabilities,
    connection.config.pluginSource,
  )
  if (gate.action !== 'register') return

  const entry = findChannelEntry(connection.name, getAllowedChannels())
  const pluginId =
    entry?.kind === 'plugin'
      ? (`${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : undefined

  logMCPDebug(
    connection.name,
    'Channel notifications re-registered after reconnect',
  )
  connection.client.setNotificationHandler(
    asMcpSchema(ChannelMessageNotificationSchema()),
    async notification => {
      const { content, meta } = notification.params
      logMCPDebug(
        connection.name,
        `notifications/claude/channel: ${content.slice(0, 80)}`,
      )
      logEvent('tengu_mcp_channel_message', {
        content_length: content.length,
        meta_key_count: Object.keys(meta ?? {}).length,
        entry_kind:
          entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_dev: entry?.dev ?? false,
        plugin: pluginId,
      })
      enqueue({
        mode: 'prompt',
        value: wrapChannelMessage(connection.name, content, meta),
        priority: 'next',
        isMeta: true,
        origin: { kind: 'channel', server: connection.name },
        skipSlashCommands: true,
      })
    },
  )
}
