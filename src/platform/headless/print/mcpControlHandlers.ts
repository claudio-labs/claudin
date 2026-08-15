// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// MCP-facing control-request handlers for the headless stdin loop, extracted
// from the `else if` chain in `runHeadlessStreaming`
// (`src/platform/headless/print/runHeadless.ts`) as the deferred half of ROADMAP 11b.
//
// Same shape as the pre-existing `controlHandlers.ts`: one exported function
// per subtype. These additionally take the shared `HeadlessStreamingContext`
// because they WRITE `dynamicMcpState` and read the live `sdkClients` — the
// reconnect paths must update `dynamicMcpState` as well as AppState, since the
// turn loop assembles its tool pool from `dynamicMcpState`, not from AppState.
//
// The per-handler config lookups differ ON PURPOSE and are preserved verbatim:
// `mcp_reconnect`/`mcp_toggle` search five sources (gh-31339 / CC-314 widened
// them to cover SDK-injected and dynamically-added servers), while
// `mcp_authenticate`/`mcp_clear_auth` search three. Do not "unify" them without
// checking those issues first.

import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import {
  clearServerCache,
  reconnectMcpServerImpl,
} from 'src/mcp/client.js'
import {
  getMcpConfigByName,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/mcp/config.js'
import {
  performMCPOAuthFlow,
  revokeServerTokens,
} from 'src/mcp/auth.js'
import { getMcpPrefix } from 'src/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from 'src/mcp/utils.js'
import { reregisterChannelHandlerAfterReconnect } from 'src/platform/headless/print/controlHandlers.js'
import type {
  HeadlessStreamingContext,
  ControlRequestWith,
} from 'src/platform/headless/print/streamingContext.js'

/** `mcp_reconnect` and `mcp_clear_auth` both carry only a server name. */
export type McpServerNameRequest = ControlRequestWith<{
  subtype: string
  serverName: string
}>

export type McpToggleRequest = ControlRequestWith<{
  subtype: string
  serverName: string
  enabled: boolean
}>

export type McpOauthCallbackUrlRequest = ControlRequestWith<{
  subtype: string
  serverName: string
  callbackUrl: string
}>

export async function handleMcpReconnect(
  ctx: HeadlessStreamingContext,
  message: McpServerNameRequest,
): Promise<void> {
  const { getAppState, setAppState, initialMcpClients } = ctx
  const currentAppState = getAppState()
  const { serverName } = message.request
  ctx.elicitationRegistered.delete(serverName)
  // Config-existence gate must cover the SAME sources as the
  // operations below. SDK-injected servers (query({mcpServers:{...}}))
  // and dynamically-added servers were missing here, so
  // toggleMcpServer/reconnect returned "Server not found" even though
  // the disconnect/reconnect would have worked (gh-31339 / CC-314).
  const config =
    getMcpConfigByName(serverName) ??
    initialMcpClients.find(c => c.name === serverName)?.config ??
    ctx.sdkClients.find(c => c.name === serverName)?.config ??
    ctx.dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null
  if (!config) {
    ctx.sendControlResponseError(message, `Server not found: ${serverName}`)
  } else {
    const result = await reconnectMcpServerImpl(serverName, config)
    // Update appState.mcp with the new client, tools, commands, and resources
    const prefix = getMcpPrefix(serverName)
    setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: prev.mcp.clients.map(c =>
          c.name === serverName ? result.client : c,
        ),
        tools: [
          ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
          ...result.tools,
        ],
        commands: [
          ...reject(prev.mcp.commands, c =>
            commandBelongsToServer(c, serverName),
          ),
          ...result.commands,
        ],
        resources:
          result.resources && result.resources.length > 0
            ? { ...prev.mcp.resources, [serverName]: result.resources }
            : omit(prev.mcp.resources, serverName),
      },
    }))
    // Also update dynamicMcpState so run() picks up the new tools
    // on the next turn (run() reads dynamicMcpState, not appState)
    ctx.dynamicMcpState = {
      ...ctx.dynamicMcpState,
      clients: [
        ...ctx.dynamicMcpState.clients.filter(c => c.name !== serverName),
        result.client,
      ],
      tools: [
        ...ctx.dynamicMcpState.tools.filter(t => !t.name?.startsWith(prefix)),
        ...result.tools,
      ],
    }
    if (result.client.type === 'connected') {
      ctx.registerElicitationHandlers([result.client])
      reregisterChannelHandlerAfterReconnect(result.client)
      ctx.sendControlResponseSuccess(message)
    } else {
      const failureMessage =
        result.client.type === 'failed'
          ? (result.client.error ?? 'Connection failed')
          : `Server status: ${result.client.type}`
      ctx.sendControlResponseError(message, failureMessage)
    }
  }
}

export async function handleMcpToggle(
  ctx: HeadlessStreamingContext,
  message: McpToggleRequest,
): Promise<void> {
  const { getAppState, setAppState, initialMcpClients } = ctx
  const currentAppState = getAppState()
  const { serverName, enabled } = message.request
  ctx.elicitationRegistered.delete(serverName)
  // Gate must match the client-lookup spread below (which
  // includes sdkClients and dynamicMcpState.clients). Same fix as
  // mcp_reconnect above (gh-31339 / CC-314).
  const config =
    getMcpConfigByName(serverName) ??
    initialMcpClients.find(c => c.name === serverName)?.config ??
    ctx.sdkClients.find(c => c.name === serverName)?.config ??
    ctx.dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null

  if (!config) {
    ctx.sendControlResponseError(message, `Server not found: ${serverName}`)
  } else if (!enabled) {
    // Disabling: persist + disconnect (matches TUI toggleMcpServer behavior)
    setMcpServerEnabled(serverName, false)
    const client = [
      ...initialMcpClients,
      ...ctx.sdkClients,
      ...ctx.dynamicMcpState.clients,
      ...currentAppState.mcp.clients,
    ].find(c => c.name === serverName)
    if (client && client.type === 'connected') {
      await clearServerCache(serverName, config)
    }
    // Update appState.mcp to reflect disabled status and remove tools/commands/resources
    const prefix = getMcpPrefix(serverName)
    setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: prev.mcp.clients.map(c =>
          c.name === serverName
            ? { name: serverName, type: 'disabled' as const, config }
            : c,
        ),
        tools: reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
        commands: reject(prev.mcp.commands, c =>
          commandBelongsToServer(c, serverName),
        ),
        resources: omit(prev.mcp.resources, serverName),
      },
    }))
    ctx.sendControlResponseSuccess(message)
  } else {
    // Enabling: persist + reconnect
    setMcpServerEnabled(serverName, true)
    const result = await reconnectMcpServerImpl(serverName, config)
    // Update appState.mcp with the new client, tools, commands, and resources
    // This ensures the LLM sees updated tools after enabling the server
    const prefix = getMcpPrefix(serverName)
    setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: prev.mcp.clients.map(c =>
          c.name === serverName ? result.client : c,
        ),
        tools: [
          ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
          ...result.tools,
        ],
        commands: [
          ...reject(prev.mcp.commands, c =>
            commandBelongsToServer(c, serverName),
          ),
          ...result.commands,
        ],
        resources:
          result.resources && result.resources.length > 0
            ? { ...prev.mcp.resources, [serverName]: result.resources }
            : omit(prev.mcp.resources, serverName),
      },
    }))
    if (result.client.type === 'connected') {
      ctx.registerElicitationHandlers([result.client])
      reregisterChannelHandlerAfterReconnect(result.client)
      ctx.sendControlResponseSuccess(message)
    } else {
      const failureMessage =
        result.client.type === 'failed'
          ? (result.client.error ?? 'Connection failed')
          : `Server status: ${result.client.type}`
      ctx.sendControlResponseError(message, failureMessage)
    }
  }
}

export async function handleMcpAuthenticate(
  ctx: HeadlessStreamingContext,
  message: McpServerNameRequest,
): Promise<void> {
  const {
    getAppState,
    setAppState,
    initialMcpClients,
    activeOAuthFlows,
    oauthCallbackSubmitters,
    oauthManualCallbackUsed,
    oauthAuthPromises,
  } = ctx
  const { serverName } = message.request
  const currentAppState = getAppState()
  const config =
    getMcpConfigByName(serverName) ??
    initialMcpClients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null
  if (!config) {
    ctx.sendControlResponseError(message, `Server not found: ${serverName}`)
  } else if (config.type !== 'sse' && config.type !== 'http') {
    ctx.sendControlResponseError(
      message,
      `Server type "${config.type}" does not support OAuth authentication`,
    )
  } else {
    try {
      // Abort any previous in-flight OAuth flow for this server
      activeOAuthFlows.get(serverName)?.abort()
      const controller = new AbortController()
      activeOAuthFlows.set(serverName, controller)

      // Capture the auth URL from the callback
      let resolveAuthUrl: (url: string) => void
      const authUrlPromise = new Promise<string>(resolve => {
        resolveAuthUrl = resolve
      })

      // Start the OAuth flow in the background
      const oauthPromise = performMCPOAuthFlow(
        serverName,
        config,
        url => resolveAuthUrl!(url),
        controller.signal,
        {
          skipBrowserOpen: true,
          onWaitingForCallback: submit => {
            oauthCallbackSubmitters.set(serverName, submit)
          },
        },
      )

      // Wait for the auth URL (or the flow to complete without needing redirect)
      const authUrl = await Promise.race([
        authUrlPromise,
        oauthPromise.then(() => null as string | null),
      ])

      if (authUrl) {
        ctx.sendControlResponseSuccess(message, {
          authUrl,
          requiresUserAction: true,
        })
      } else {
        ctx.sendControlResponseSuccess(message, {
          requiresUserAction: false,
        })
      }

      // Store auth-only promise for mcp_oauth_callback_url handler.
      // Don't swallow errors — the callback handler needs to detect
      // auth failures and report them to the caller.
      oauthAuthPromises.set(serverName, oauthPromise)

      // Handle background completion — reconnect after auth.
      // When manual callback is used, skip the reconnect here;
      // the extension's handleAuthDone → mcp_reconnect handles it
      // (which also updates dynamicMcpState for tool registration).
      const fullFlowPromise = oauthPromise
        .then(async () => {
          // Don't reconnect if the server was disabled during the OAuth flow
          if (isMcpServerDisabled(serverName)) {
            return
          }
          // Skip reconnect if the manual callback path was used —
          // handleAuthDone will do it via mcp_reconnect (which
          // updates dynamicMcpState for tool registration).
          if (oauthManualCallbackUsed.has(serverName)) {
            return
          }
          // Reconnect the server after successful auth
          const result = await reconnectMcpServerImpl(serverName, config)
          const prefix = getMcpPrefix(serverName)
          setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.map(c =>
                c.name === serverName ? result.client : c,
              ),
              tools: [
                ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                ...result.tools,
              ],
              commands: [
                ...reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName),
                ),
                ...result.commands,
              ],
              resources:
                result.resources && result.resources.length > 0
                  ? {
                      ...prev.mcp.resources,
                      [serverName]: result.resources,
                    }
                  : omit(prev.mcp.resources, serverName),
            },
          }))
          // Also update dynamicMcpState so run() picks up the new tools
          // on the next turn (run() reads dynamicMcpState, not appState)
          ctx.dynamicMcpState = {
            ...ctx.dynamicMcpState,
            clients: [
              ...ctx.dynamicMcpState.clients.filter(c => c.name !== serverName),
              result.client,
            ],
            tools: [
              ...ctx.dynamicMcpState.tools.filter(
                t => !t.name?.startsWith(prefix),
              ),
              ...result.tools,
            ],
          }
        })
        .catch(error => {
          logForDebugging(`MCP OAuth failed for ${serverName}: ${error}`, {
            level: 'error',
          })
        })
        .finally(() => {
          // Clean up only if this is still the active flow
          if (activeOAuthFlows.get(serverName) === controller) {
            activeOAuthFlows.delete(serverName)
            oauthCallbackSubmitters.delete(serverName)
            oauthManualCallbackUsed.delete(serverName)
            oauthAuthPromises.delete(serverName)
          }
        })
      void fullFlowPromise
    } catch (error) {
      ctx.sendControlResponseError(message, errorMessage(error))
    }
  }
}

export async function handleMcpOauthCallbackUrl(
  ctx: HeadlessStreamingContext,
  message: McpOauthCallbackUrlRequest,
): Promise<void> {
  const { oauthCallbackSubmitters, oauthManualCallbackUsed, oauthAuthPromises } =
    ctx
  const { serverName, callbackUrl } = message.request
  const submit = oauthCallbackSubmitters.get(serverName)
  if (submit) {
    // Validate the callback URL before submitting. The submit
    // callback in auth.ts silently ignores URLs missing a code
    // param, which would leave the auth promise unresolved and
    // block the control message loop until timeout.
    let hasCodeOrError = false
    try {
      const parsed = new URL(callbackUrl)
      hasCodeOrError =
        parsed.searchParams.has('code') || parsed.searchParams.has('error')
    } catch {
      // Invalid URL
    }
    if (!hasCodeOrError) {
      ctx.sendControlResponseError(
        message,
        'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
      )
    } else {
      oauthManualCallbackUsed.add(serverName)
      submit(callbackUrl)
      // Wait for auth (token exchange) to complete before responding.
      // Reconnect is handled by the extension via handleAuthDone →
      // mcp_reconnect (which updates dynamicMcpState for tools).
      const authPromise = oauthAuthPromises.get(serverName)
      if (authPromise) {
        try {
          await authPromise
          ctx.sendControlResponseSuccess(message)
        } catch (error) {
          ctx.sendControlResponseError(
            message,
            error instanceof Error
              ? error.message
              : 'OAuth authentication failed',
          )
        }
      } else {
        ctx.sendControlResponseSuccess(message)
      }
    }
  } else {
    ctx.sendControlResponseError(
      message,
      `No active OAuth flow for server: ${serverName}`,
    )
  }
}

export async function handleMcpClearAuth(
  ctx: HeadlessStreamingContext,
  message: McpServerNameRequest,
): Promise<void> {
  const { getAppState, setAppState, initialMcpClients } = ctx
  const { serverName } = message.request
  const currentAppState = getAppState()
  const config =
    getMcpConfigByName(serverName) ??
    initialMcpClients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null
  if (!config) {
    ctx.sendControlResponseError(message, `Server not found: ${serverName}`)
  } else if (config.type !== 'sse' && config.type !== 'http') {
    ctx.sendControlResponseError(
      message,
      `Cannot clear auth for server type "${config.type}"`,
    )
  } else {
    await revokeServerTokens(serverName, config)
    const result = await reconnectMcpServerImpl(serverName, config)
    const prefix = getMcpPrefix(serverName)
    setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: prev.mcp.clients.map(c =>
          c.name === serverName ? result.client : c,
        ),
        tools: [
          ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
          ...result.tools,
        ],
        commands: [
          ...reject(prev.mcp.commands, c =>
            commandBelongsToServer(c, serverName),
          ),
          ...result.commands,
        ],
        resources:
          result.resources && result.resources.length > 0
            ? {
                ...prev.mcp.resources,
                [serverName]: result.resources,
              }
            : omit(prev.mcp.resources, serverName),
      },
    }))
    ctx.sendControlResponseSuccess(message, {})
  }
}
