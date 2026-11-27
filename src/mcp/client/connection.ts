import { feature } from 'bun:bundle'
import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/client/ext/skills'
import memoize from 'lodash-es/memoize.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { type Tool } from 'src/tools/Tool.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { logForDebugging } from 'src/shared/debug.js'
import {
  errorMessage,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/shared/errors.js'
import { maybeNotifyIDEConnected } from 'src/platform/ide/ide.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { sleep } from 'src/shared/sleep.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from 'src/mcp/types.js'
import { setMcpAuthCacheEntry } from 'src/mcp/client/authCache.js'
import { httpStatusOf, isMcpSessionExpiredError } from 'src/mcp/client/errors.js'
import {
  getMcpConnectTimeoutMs,
  getMcpExtensionEnabled,
  getMcpProtocolMode,
} from 'src/mcp/client/serverOptions.js'
import { MCP_TASKS_EXTENSION } from 'src/mcp/client/taskPoll.js'
import { MCP_EVENTS_EXTENSION } from 'src/mcp/client/events.js'
import { nextConnectRetryDelay } from 'src/mcp/client/connectRetry.js'
import { getMcpClientInfo } from 'src/mcp/client/clientInfo.js'
import {
  dropEraVerdict,
  getEraCacheKey,
  readEraVerdict,
  saveEraVerdict,
} from 'src/mcp/client/eraCache.js'
import {
  confirmsPriorInPlace,
  type EraOverride,
  type NegotiableTransport,
  nextEraStep,
  planConnect,
  probeTimeoutMs,
  verdictAfterConnect,
} from 'src/mcp/client/negotiation.js'
import { stopMcpSubscriptions } from 'src/mcp/client/subscriptions.js'
import { resumeMcpResourceWatches } from 'src/mcp/resourceWatch.js'
import { SDK_LIST_MAX_PAGES } from 'src/mcp/client/cursorCycleGuard.js'
import {
  attachMcpWireFilter,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchResourceTemplatesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import { createTransport, type InProcessMcpServer } from 'src/mcp/client/transport.js'

// connection.ts <-> fetchCapabilities.ts form an intentional ESM cycle: each
// references the other only inside function bodies (never at module-eval time),
// so live bindings resolve after both modules finish loading. Do not "fix" it
// by collapsing the modules.

/**
 * Cap on MCP tool descriptions and server instructions sent to the model.
 * OpenAPI-generated MCP servers have been observed dumping 15-60KB of endpoint
 * docs into tool.description; this caps the p95 tail without losing the intent.
 */
export const MAX_MCP_DESCRIPTION_LENGTH = 2048

export async function cleanupFailedConnection(
  transport: Pick<Transport, 'close'>,
  inProcessServer?: Pick<InProcessMcpServer, 'close'>,
): Promise<void> {
  if (inProcessServer) {
    await inProcessServer.close().catch(() => {})
  }

  await transport.close().catch(() => {})
}

export function isLocalMcpServer(config: ScopedMcpServerConfig): boolean {
  return !config.type || config.type === 'stdio' || config.type === 'sdk'
}

/**
 * What Claudin answers a server's `roots/list` with: the directory it was
 * started in. A task's `input_required` gets the same answer (callTool.ts).
 */
export function listRootsResult(): { roots: Array<{ uri: string }> } {
  return { roots: [{ uri: `file://${getOriginalCwd()}` }] }
}

/**
 * Which SDK transport this is, for negotiation.ts. A stdio server is probed
 * on a sibling process only through the SDK's own base class (a subclass is
 * probed in place, which kills servers that exit on a pre-`initialize`
 * request), and an in-process server has nothing to negotiate.
 */
function negotiableTransportOf(transport: Transport): NegotiableTransport {
  if (transport instanceof StreamableHTTPClientTransport) return 'http'
  if (Object.getPrototypeOf(transport) === StdioClientTransport.prototype) return 'stdio'
  return 'other'
}

// For the IDE MCP servers, we only include specific tools
const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']
export function isIncludedMcpTool(tool: Tool): boolean {
  return (
    !tool.name.startsWith('mcp__ide__') || ALLOWED_IDE_TOOLS.includes(tool.name)
  )
}

/**
 * Generates the cache key for a server connection
 * @param name Server name
 * @param serverRef Server configuration
 * @returns Cache key string
 */
export function getServerCacheKey(
  name: string,
  serverRef: ScopedMcpServerConfig,
): string {
  return `${name}-${jsonStringify(serverRef)}`
}

/**
 * Shared handler for sse/http/claudeai-proxy auth failures during connect:
 * caches the needs-auth entry and returns the needs-auth connection result.
 */
function handleRemoteAuthFailure(
  name: string,
  serverRef: ScopedMcpServerConfig,
  transportType: 'sse' | 'http' | 'claudeai-proxy',
): MCPServerConnection {
  const label: Record<typeof transportType, string> = {
    sse: 'SSE',
    http: 'HTTP',
    'claudeai-proxy': 'claude.ai proxy',
  }
  logMCPDebug(
    name,
    `Authentication required for ${label[transportType]} server`,
  )
  setMcpAuthCacheEntry(name)
  return { name, type: 'needs-auth', config: serverRef }
}

// Shutdown gives every registered cleanup 2 s in total (gracefulShutdown.ts).
const SESSION_DELETE_TIMEOUT_MS = 1000

/**
 * Ends a Streamable HTTP session with the DELETE the transports spec asks of
 * a client that no longer needs it. A 2026-07-28 connection has no session,
 * so nothing is sent. A failure only costs the server a session it expires.
 */
async function endHttpSession(
  name: string,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  if (transport.sessionId === undefined) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      transport.terminateSession(),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, SESSION_DELETE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    logMCPDebug(name, `Error ending the HTTP session: ${errorMessage(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * TODO (ollie): The memoization here increases complexity by a lot, and im not sure it really improves performance
 * Attempts to connect to a single MCP server
 * @param name Server name
 * @param serverRef Scoped server configuration
 * @param retry Internal: the attempt a transient-failure retry is on, and the
 *   startup deadline every attempt shares (connectRetry.ts); `era` when this
 *   attempt follows a probe the server turned down or a failed cached verdict
 *   (negotiation.ts)
 * @returns A wrapped client (either connected or failed)
 */
export const connectToServer = memoize(
  async function connectAttempt(
    name: string,
    serverRef: ScopedMcpServerConfig,
    serverStats?: {
      totalServers: number
      stdioCount: number
      sseCount: number
      httpCount: number
      sseIdeCount: number
      wsIdeCount: number
    },
    retry?: { attempt: number; deadline: number; era?: EraOverride },
  ): Promise<MCPServerConnection> {
    const connectStartTime = Date.now()
    const deadline =
      retry?.deadline ?? connectStartTime + getMcpConnectTimeoutMs(serverRef)
    let inProcessServer: InProcessMcpServer | undefined
    try {
      const created = await createTransport(name, serverRef)
      const transport = created.transport
      inProcessServer = created.inProcessServer

      const negotiable = negotiableTransportOf(transport)
      const protocolMode = getMcpProtocolMode(serverRef)
      const eraKey = getEraCacheKey(name, serverRef)
      const plan = planConnect({
        mode: protocolMode,
        transport: negotiable,
        verdict:
          protocolMode === 'auto' && negotiable !== 'other' && !retry?.era
            ? await readEraVerdict(eraKey)
            : undefined,
        override: retry?.era,
        startupTimeoutMs: deadline - Date.now(),
        now: Date.now(),
      })
      logMCPDebug(
        name,
        `Protocol negotiation: ${plan.prior ? `cached ${plan.prior.kind} verdict` : plan.mode === 'auto' ? `probe (${plan.probeTimeoutMs}ms)` : 'legacy'}`,
      )

      // Set up stderr logging for stdio transport before connecting in case there are any stderr
      // outputs emitted during the connection start (this can be useful for debugging failed connections).
      // Store handler reference for cleanup to prevent memory leaks
      let stderrHandler: ((data: Buffer) => void) | undefined
      let stderrOutput = ''
      if (serverRef.type === 'stdio' || !serverRef.type) {
        const stdioTransport = transport as StdioClientTransport
        if (stdioTransport.stderr) {
          stderrHandler = (data: Buffer) => {
            // Cap stderr accumulation to prevent unbounded memory growth
            if (stderrOutput.length < 64 * 1024 * 1024) {
              try {
                stderrOutput += data.toString()
              } catch {
                // Ignore errors from exceeding max string length
              }
            }
          }
          stdioTransport.stderr.on('data', stderrHandler)
        }
      }

      const extensions = {
        ...(getMcpExtensionEnabled(serverRef, 'skills') && { [SKILLS_EXTENSION_ID]: {} }),
        ...(getMcpExtensionEnabled(serverRef, 'tasks') && { [MCP_TASKS_EXTENSION]: {} }),
        ...(getMcpExtensionEnabled(serverRef, 'events') && { [MCP_EVENTS_EXTENSION]: {} }),
      }
      const client = new Client(
        getMcpClientInfo(),
        {
          capabilities: {
            roots: {},
            // A 2026-07-28 server asks for a URL only from a client that says
            // url; the 2025 initialize goes out as {} (SEND_RULES in
            // wireRules.ts), which Spring AI servers accept.
            elicitation: { form: {}, url: {} },
            // Every extension Claudin runs is declared: a server may answer a
            // tools/call with a task only from a client that declares tasks
            // (taskPoll.ts), offers events only to one that declares events
            // (events.ts), and skills are declared because Claudin loads them
            // (mcpSkills.ts). The 2025 initialize drops them with the rest
            // (SEND_RULES), as extensions exist only in 2026-07-28.
            ...(Object.keys(extensions).length > 0 && { extensions }),
          },
          versionNegotiation:
            plan.mode === 'auto'
              ? {
                  mode: 'auto',
                  ...(plan.probeTimeoutMs !== undefined && {
                    probe: { timeoutMs: plan.probeTimeoutMs },
                  }),
                }
              : { mode: 'legacy' },
          // The wire filter cuts a long listing first (cursorCycleGuard.ts).
          listMaxPages: SDK_LIST_MAX_PAGES,
        },
      )

      // Add debug logging for client events if available
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Client created, setting up request handler`)
      }

      client.setRequestHandler('roots/list', async () => {
        logMCPDebug(name, `Received ListRoots request from server`)
        return listRootsResult()
      })

      // Add a timeout to connection attempts to prevent tests from hanging indefinitely
      logMCPDebug(
        name,
        `Starting connection with timeout of ${getMcpConnectTimeoutMs(serverRef)}ms`,
      )

      // For HTTP transport, try a basic connectivity test first
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Testing basic HTTP connectivity to ${serverRef.url}`)
        try {
          const testUrl = new URL(serverRef.url)
          logMCPDebug(
            name,
            `Parsed URL: host=${testUrl.hostname}, port=${testUrl.port || 'default'}, protocol=${testUrl.protocol}`,
          )

          // Log DNS resolution attempt
          if (
            testUrl.hostname === '127.0.0.1' ||
            testUrl.hostname === 'localhost'
          ) {
            logMCPDebug(name, `Using loopback address: ${testUrl.hostname}`)
          }
        } catch (urlError) {
          logMCPDebug(name, `Failed to parse URL: ${urlError}`)
        }
      }

      // Before connect, which chains the filter's onmessage ahead of the
      // SDK's decode (wireFilter.ts).
      attachMcpWireFilter(name, transport)
      const connectPromise = client
        .connect(transport, plan.prior ? { prior: plan.prior } : undefined)
        .then(async () => {
          // A failure here drops the verdict and probes (negotiation.ts).
          if (confirmsPriorInPlace(plan, negotiable)) {
            await client.discover({ timeout: probeTimeoutMs(deadline - Date.now()) })
          }
        })
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutId = setTimeout(() => {
          const elapsed = Date.now() - connectStartTime
          logMCPDebug(
            name,
            `Connection timeout triggered after ${elapsed}ms (limit: ${getMcpConnectTimeoutMs(serverRef)}ms)`,
          )
          if (inProcessServer) {
            inProcessServer.close().catch(() => { })
          }
          transport.close().catch(() => { })
          reject(
            new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `MCP server "${name}" connection timed out after ${getMcpConnectTimeoutMs(serverRef)}ms`,
              'MCP connection timeout',
            ),
          )
        }, deadline - connectStartTime)

        // Clean up timeout if connect resolves or rejects
        connectPromise.then(
          () => {
            clearTimeout(timeoutId)
          },
          _error => {
            clearTimeout(timeoutId)
          },
        )
      })

      try {
        await Promise.race([connectPromise, timeoutPromise])
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
          stderrOutput = '' // Release accumulated string to prevent memory growth
        }
        const elapsed = Date.now() - connectStartTime
        logMCPDebug(
          name,
          `Successfully connected (transport: ${serverRef.type || 'stdio'}) in ${elapsed}ms`,
        )
      } catch (error) {
        // A probe an HTTP server turned down is tried again in the 2025
        // protocol, and a failed cached verdict with a probe, each on a fresh
        // transport and inside the same deadline. Neither counts as a retry.
        const eraStep = nextEraStep(error, { plan, transport: negotiable })
        if (eraStep !== null && deadline - Date.now() > 0) {
          logMCPDebug(
            name,
            `Connection failed during protocol negotiation: ${errorMessage(error)}. ${eraStep.kind === 'probe' ? 'Dropping the cached verdict and probing again' : 'Connecting in the 2025 protocol'}`,
          )
          if (eraStep.kind === 'probe') await dropEraVerdict(eraKey)
          await cleanupFailedConnection(transport)
          return connectAttempt(name, serverRef, serverStats, {
            attempt: retry?.attempt ?? 0,
            deadline,
            era: eraStep,
          })
        }
        // A transient failure of a remote server gets another attempt, which
        // calls this function directly: the memoized wrapper would hand back
        // this very attempt's promise.
        const attempt = retry?.attempt ?? 0
        const delay = nextConnectRetryDelay(error, {
          type: serverRef.type ?? 'stdio',
          attempt,
          remainingMs: deadline - Date.now(),
        })
        if (delay !== null) {
          logMCPDebug(
            name,
            `Connection attempt ${attempt + 1} failed: ${errorMessage(error)}. Retrying in ${delay}ms`,
          )
          await cleanupFailedConnection(transport)
          await sleep(delay)
          return connectAttempt(name, serverRef, serverStats, {
            attempt: attempt + 1,
            deadline,
            era: retry?.era,
          })
        }
        const elapsed = Date.now() - connectStartTime
        // SSE-specific error logging
        if (serverRef.type === 'sse' && error instanceof Error) {
          logMCPDebug(
            name,
            `SSE Connection failed after ${elapsed}ms: ${jsonStringify({
              url: serverRef.url,
              error: error.message,
              errorType: error.constructor.name,
              stack: error.stack,
            })}`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'sse')
          }
        } else if (serverRef.type === 'http' && error instanceof Error) {
          const errorObj = error as Error & {
            cause?: unknown
            code?: string
            errno?: string | number
            syscall?: string
          }
          logMCPDebug(
            name,
            `HTTP Connection failed after ${elapsed}ms: ${error.message} (code: ${errorObj.code || 'none'}, errno: ${errorObj.errno || 'none'})`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'http')
          }
        } else if (
          serverRef.type === 'claudeai-proxy' &&
          error instanceof Error
        ) {
          logMCPDebug(
            name,
            `claude.ai proxy connection failed after ${elapsed}ms: ${error.message}`,
          )
          logMCPError(name, error)

          if (httpStatusOf(error) === 401) {
            return handleRemoteAuthFailure(name, serverRef, 'claudeai-proxy')
          }
        } else         if (inProcessServer) {
          await cleanupFailedConnection(transport, inProcessServer)
        } else {
          await cleanupFailedConnection(transport)
        }
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
        }
        throw error
      }

      const capabilities = client.getServerCapabilities()
      const serverVersion = client.getServerVersion()
      const rawInstructions = client.getInstructions()
      // Read while connected: the SDK forgets the era once the client closes.
      const protocolVersion = client.getNegotiatedProtocolVersion()
      const era = client.getProtocolEra()
      logMCPDebug(name, `Protocol ${protocolVersion ?? 'unknown'} (${era ?? 'unknown'} era)`)
      const verdict = verdictAfterConnect({
        plan,
        transport: negotiable,
        override: retry?.era,
        era,
        discover: client.getDiscoverResult(),
        now: Date.now(),
      })
      if (verdict) await saveEraVerdict(eraKey, verdict)
      let instructions = rawInstructions
      if (
        rawInstructions &&
        rawInstructions.length > MAX_MCP_DESCRIPTION_LENGTH
      ) {
        instructions =
          rawInstructions.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
        logMCPDebug(
          name,
          `Server instructions truncated from ${rawInstructions.length} to ${MAX_MCP_DESCRIPTION_LENGTH} chars`,
        )
      }

      // Log successful connection details
      logMCPDebug(
        name,
        `Connection established with capabilities: ${jsonStringify({
          hasTools: !!capabilities?.tools,
          hasPrompts: !!capabilities?.prompts,
          hasResources: !!capabilities?.resources,
          hasResourceSubscribe: !!capabilities?.resources?.subscribe,
          serverVersion: serverVersion || 'unknown',
        })}`,
      )
      logForDebugging(
        `[MCP] Server "${name}" connected with subscribe=${!!capabilities?.resources?.subscribe}`,
      )

      // Register default elicitation handler that returns cancel during the
      // window before registerElicitationHandler overwrites it in
      // onConnectionAttempt (useManageMCPConnections).
      client.setRequestHandler('elicitation/create', async request => {
        logMCPDebug(
          name,
          `Elicitation request received during initialization: ${jsonStringify(request)}`,
        )
        return { action: 'cancel' as const }
      })

      if (serverRef.type === 'sse-ide' || serverRef.type === 'ws-ide') {
        const ideConnectionDurationMs = Date.now() - connectStartTime
        try {
          void maybeNotifyIDEConnected(client)
        } catch (error) {
          logMCPError(
            name,
            `Failed to send ide_connected notification: ${error}`,
          )
        }
      }

      // Enhanced connection drop detection and logging for all transport types
      const connectionStartTime = Date.now()
      let hasErrorOccurred = false

      // Store original handlers
      const originalOnerror = client.onerror
      const originalOnclose = client.onclose

      // The SDK's transport calls onerror on connection failures but doesn't call onclose,
      // which CC uses to trigger reconnection. We bridge this gap by tracking consecutive
      // terminal errors and manually closing after MAX_ERRORS_BEFORE_RECONNECT failures.
      let consecutiveConnectionErrors = 0
      const MAX_ERRORS_BEFORE_RECONNECT = 3

      // Guard against re-entry: close() aborts in-flight streams which may fire
      // onerror again before the close chain completes.
      let hasTriggeredClose = false

      // client.close() → transport.close() → transport.onclose → SDK's _onclose():
      // rejects all pending request handlers (so hung callTool() promises fail with
      // SdkError CONNECTION_CLOSED) and then invokes our client.onclose
      // handler below (which clears the memo cache so the next call reconnects).
      // Calling client.onclose?.() directly would only clear the cache — pending
      // tool calls would stay hung.
      const closeTransportAndRejectPending = (reason: string) => {
        if (hasTriggeredClose) return
        hasTriggeredClose = true
        logMCPDebug(name, `Closing transport (${reason})`)
        void client.close().catch(e => {
          logMCPDebug(name, `Error during close: ${errorMessage(e)}`)
        })
      }

      const isTerminalConnectionError = (msg: string): boolean => {
        return (
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EPIPE') ||
          msg.includes('EHOSTUNREACH') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('Body Timeout Error') ||
          msg.includes('terminated') ||
          // SDK SSE reconnection intermediate errors — may be wrapped around the
          // actual network error, so the substrings above won't match
          msg.includes('SSE stream disconnected') ||
          msg.includes('Failed to reconnect SSE stream')
        )
      }

      // Enhanced error handler with detailed logging
      client.onerror = (error: Error) => {
        const uptime = Date.now() - connectionStartTime
        hasErrorOccurred = true
        const transportType = serverRef.type || 'stdio'

        // Log the connection drop with context
        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection dropped after ${Math.floor(uptime / 1000)}s uptime`,
        )

        // Log specific error details for debugging
        if (error.message) {
          if (error.message.includes('ECONNRESET')) {
            logMCPDebug(
              name,
              `Connection reset - server may have crashed or restarted`,
            )
          } else if (error.message.includes('ETIMEDOUT')) {
            logMCPDebug(
              name,
              `Connection timeout - network issue or server unresponsive`,
            )
          } else if (error.message.includes('ECONNREFUSED')) {
            logMCPDebug(name, `Connection refused - server may be down`)
          } else if (error.message.includes('EPIPE')) {
            logMCPDebug(
              name,
              `Broken pipe - server closed connection unexpectedly`,
            )
          } else if (error.message.includes('EHOSTUNREACH')) {
            logMCPDebug(name, `Host unreachable - network connectivity issue`)
          } else if (error.message.includes('ESRCH')) {
            logMCPDebug(
              name,
              `Process not found - stdio server process terminated`,
            )
          } else if (error.message.includes('spawn')) {
            logMCPDebug(
              name,
              `Failed to spawn process - check command and permissions`,
            )
          } else {
            logMCPDebug(name, `Connection error: ${error.message}`)
          }
        }

        // For HTTP transports, detect session expiry (404 + JSON-RPC -32001)
        // and close the transport so pending tool calls reject and the next
        // call reconnects with a fresh session ID.
        if (
          (transportType === 'http' || transportType === 'claudeai-proxy') &&
          isMcpSessionExpiredError(error)
        ) {
          logMCPDebug(
            name,
            `MCP session expired (server returned 404 with session-not-found), triggering reconnection`,
          )
          closeTransportAndRejectPending('session expired')
          if (originalOnerror) {
            originalOnerror(error)
          }
          return
        }

        // For remote transports (SSE/HTTP), track terminal connection errors
        // and trigger reconnection via close if we see repeated failures.
        if (
          transportType === 'sse' ||
          transportType === 'http' ||
          transportType === 'claudeai-proxy'
        ) {
          // The SDK's StreamableHTTP transport fires this after exhausting its
          // own SSE reconnect attempts (default maxRetries: 2) — but it never
          // calls onclose, so pending callTool() promises hang indefinitely.
          // This is the definitive "transport gave up" signal.
          if (error.message.includes('Maximum reconnection attempts')) {
            closeTransportAndRejectPending('SSE reconnection exhausted')
            if (originalOnerror) {
              originalOnerror(error)
            }
            return
          }

          if (isTerminalConnectionError(error.message)) {
            consecutiveConnectionErrors++
            logMCPDebug(
              name,
              `Terminal connection error ${consecutiveConnectionErrors}/${MAX_ERRORS_BEFORE_RECONNECT}`,
            )

            if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
              consecutiveConnectionErrors = 0
              closeTransportAndRejectPending('max consecutive terminal errors')
            }
          } else {
            // Non-terminal error (e.g., transient issue), reset counter
            consecutiveConnectionErrors = 0
          }
        }

        // Call original handler
        if (originalOnerror) {
          originalOnerror(error)
        }
      }

      // Enhanced close handler with connection drop context
      client.onclose = () => {
        const uptime = Date.now() - connectionStartTime
        const transportType = serverRef.type ?? 'unknown'

        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection closed after ${Math.floor(uptime / 1000)}s (${hasErrorOccurred ? 'with errors' : 'cleanly'})`,
        )

        // Clear the memoization cache so next operation reconnects
        const key = getServerCacheKey(name, serverRef)

        // Also clear fetch caches (keyed by server name). Reconnection
        // creates a new connection object; without clearing, the next
        // fetch would return stale tools/resources from the old connection.
        fetchToolsForClient.cache.delete(name)
        fetchResourcesForClient.cache.delete(name)
        fetchResourceTemplatesForClient.cache.delete(name)
        fetchCommandsForClient.cache.delete(name)

        connectToServer.cache.delete(key)
        logMCPDebug(name, `Cleared connection cache for reconnection`)

        if (originalOnclose) {
          originalOnclose()
        }
      }

      const cleanup = async () => {
        await stopMcpSubscriptions(client)
        // In-process servers (e.g. Chrome MCP) don't have child processes or stderr
        if (inProcessServer) {
          try {
            await inProcessServer.close()
          } catch (error) {
            logMCPDebug(name, `Error closing in-process server: ${error}`)
          }
          try {
            await client.close()
          } catch (error) {
            logMCPDebug(name, `Error closing client: ${error}`)
          }
          return
        }

        // Remove stderr event listener to prevent memory leaks
        if (stderrHandler && (serverRef.type === 'stdio' || !serverRef.type)) {
          const stdioTransport = transport as StdioClientTransport
          stdioTransport.stderr?.off('data', stderrHandler)
        }

        // For stdio transports, explicitly terminate the child process with proper signals
        // NOTE: StdioClientTransport.close() only sends an abort signal, but many MCP servers
        // (especially Docker containers) need explicit SIGINT/SIGTERM signals to trigger graceful shutdown
        if (serverRef.type === 'stdio') {
          try {
            const stdioTransport = transport as StdioClientTransport
            const childPid = stdioTransport.pid

            if (childPid) {
              logMCPDebug(name, 'Sending SIGINT to MCP server process')

              // First try SIGINT (like Ctrl+C)
              try {
                process.kill(childPid, 'SIGINT')
              } catch (error) {
                logMCPDebug(name, `Error sending SIGINT: ${error}`)
                return
              }

              // Wait for graceful shutdown with rapid escalation (total 500ms to keep CLI responsive)
              await new Promise<void>(async resolve => {
                let resolved = false

                // Set up a timer to check if process still exists
                const checkInterval = setInterval(() => {
                  try {
                    // process.kill(pid, 0) checks if process exists without killing it
                    process.kill(childPid, 0)
                  } catch {
                    // Process no longer exists
                    if (!resolved) {
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      logMCPDebug(name, 'MCP server process exited cleanly')
                      resolve()
                    }
                  }
                }, 50)

                // Absolute failsafe: clear interval after 600ms no matter what
                const failsafeTimeout = setTimeout(() => {
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    logMCPDebug(
                      name,
                      'Cleanup timeout reached, stopping process monitoring',
                    )
                    resolve()
                  }
                }, 600)

                try {
                  // Wait 100ms for SIGINT to work (usually much faster)
                  await sleep(100)

                  if (!resolved) {
                    // Check if process still exists
                    try {
                      process.kill(childPid, 0)
                      // Process still exists, SIGINT failed, try SIGTERM
                      logMCPDebug(
                        name,
                        'SIGINT failed, sending SIGTERM to MCP server process',
                      )
                      try {
                        process.kill(childPid, 'SIGTERM')
                      } catch (termError) {
                        logMCPDebug(name, `Error sending SIGTERM: ${termError}`)
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                        return
                      }
                    } catch {
                      // Process already exited
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      resolve()
                      return
                    }

                    // Wait 400ms for SIGTERM to work (slower than SIGINT, often used for cleanup)
                    await sleep(400)

                    if (!resolved) {
                      // Check if process still exists
                      try {
                        process.kill(childPid, 0)
                        // Process still exists, SIGTERM failed, force kill with SIGKILL
                        logMCPDebug(
                          name,
                          'SIGTERM failed, sending SIGKILL to MCP server process',
                        )
                        try {
                          process.kill(childPid, 'SIGKILL')
                        } catch (killError) {
                          logMCPDebug(
                            name,
                            `Error sending SIGKILL: ${killError}`,
                          )
                        }
                      } catch {
                        // Process already exited
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                      }
                    }
                  }

                  // Final timeout - always resolve after 500ms max (total cleanup time)
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                } catch {
                  // Handle any errors in the escalation sequence
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                }
              })
            }
          } catch (processError) {
            logMCPDebug(name, `Error terminating process: ${processError}`)
          }
        }

        if (transport instanceof StreamableHTTPClientTransport) {
          await endHttpSession(name, transport)
        }

        // Close the client connection (which also closes the transport)
        try {
          await client.close()
        } catch (error) {
          logMCPDebug(name, `Error closing client: ${error}`)
        }
      }

      // Register cleanup for all transport types - even network transports might need cleanup
      // This ensures all MCP servers get properly terminated, not just stdio ones
      const cleanupUnregister = registerCleanup(cleanup)

      // Create the wrapped cleanup that includes unregistering
      const wrappedCleanup = async () => {
        cleanupUnregister?.()
        await cleanup()
      }

      const connectionDurationMs = Date.now() - connectStartTime
      // A reconnect: the resources read on the connections before this one
      // are subscribed again, or their changes would go untold.
      void resumeMcpResourceWatches({ name, client })
      return {
        name,
        client,
        type: 'connected' as const,
        capabilities: capabilities ?? {},
        serverInfo: serverVersion,
        instructions,
        config: serverRef,
        cleanup: wrappedCleanup,
        protocolVersion,
      }
    } catch (error) {
      const connectionDurationMs = Date.now() - connectStartTime
      logMCPDebug(
        name,
        `Connection failed after ${connectionDurationMs}ms: ${errorMessage(error)}`,
      )
      logMCPError(name, `Connection failed: ${errorMessage(error)}`)

      if (inProcessServer) {
        inProcessServer.close().catch(() => { })
      }
      return {
        name,
        type: 'failed' as const,
        config: serverRef,
        error: errorMessage(error),
      }
    }
  },
  getServerCacheKey,
)

/**
 * Clears the memoize cache for a specific server
 * @param name Server name
 * @param serverRef Server configuration
 */
export async function clearServerCache(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<void> {
  const key = getServerCacheKey(name, serverRef)

  try {
    const wrappedClient = await connectToServer(name, serverRef)

    if (wrappedClient.type === 'connected') {
      await wrappedClient.cleanup()
    }
  } catch {
    // Ignore errors - server might have failed to connect
  }

  // Clear from cache (both connection and fetch caches so reconnect
  // fetches fresh tools/resources/commands instead of stale ones)
  connectToServer.cache.delete(key)
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchResourceTemplatesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
}

/**
 * Ensures a valid connected client for an MCP server.
 * For most server types, uses the memoization cache if available, or reconnects
 * if the cache was cleared (e.g., after onclose). This ensures tool/resource
 * calls always use a valid connection.
 *
 * SDK MCP servers run in-process and are handled separately via setupSdkMcpClients,
 * so they are returned as-is without going through connectToServer.
 *
 * @param client The connected MCP server client
 * @returns Connected MCP server client (same or reconnected)
 * @throws Error if server cannot be connected
 */
export async function ensureConnectedClient(
  client: ConnectedMCPServer,
): Promise<ConnectedMCPServer> {
  // SDK MCP servers run in-process and are handled separately via setupSdkMcpClients
  if (client.config.type === 'sdk') {
    return client
  }

  const connectedClient = await connectToServer(client.name, client.config)
  if (connectedClient.type !== 'connected') {
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server not connected',
    )
  }
  return connectedClient
}

/**
 * Compares two MCP server configurations to determine if they are equivalent.
 * Used to detect when a server needs to be reconnected due to config changes.
 */
export function areMcpConfigsEqual(
  a: ScopedMcpServerConfig,
  b: ScopedMcpServerConfig,
): boolean {
  // Quick type check first
  if (a.type !== b.type) return false

  // Compare by serializing - this handles all config variations
  // We exclude 'scope' from comparison since it's metadata, not connection config
  const { scope: _scopeA, ...configA } = a
  const { scope: _scopeB, ...configB } = b
  return jsonStringify(configA) === jsonStringify(configB)
}
