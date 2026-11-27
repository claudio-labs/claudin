import {
  type ElicitRequestParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  ProtocolError,
  ProtocolErrorCode,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import type { AppState } from 'src/terminal/state/AppState.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import { detectCodeIndexingFromMcpServerName } from 'src/shared/fs/codeIndexing.js'
import { errorMessage, TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import type { MCPToolResult } from 'src/mcp/mcpValidation.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type { MCPProgress } from 'src/tools/MCPTool/MCPTool.js'
import {
  elicitFromUser,
  type ElicitationWaitingState,
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/mcp/elicitationHandler.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from 'src/mcp/types.js'
import { clearServerCache, listRootsResult } from 'src/mcp/client/connection.js'
import {
  httpStatusOf,
  isMcpConnectionClosedError,
  isMcpSessionExpiredError,
  McpAuthError,
  McpSessionExpiredError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/mcp/client/errors.js'
import { processMCPResult } from 'src/mcp/client/toolResult.js'
import { getMcpToolTimeoutMs } from 'src/mcp/client/serverOptions.js'
import {
  cancelPolledTask,
  inlineTaskBudgetMs,
  MCP_TASK_INLINE_MS,
  type McpTask,
  McpTaskAckSchema,
  type McpTaskInputRequest,
  McpTaskSchema,
  pollTask,
  readTaskMarker,
  startTaskPoll,
  type TaskPollDeps,
  type TaskPollOutcome,
  type TaskPollState,
} from 'src/mcp/client/taskPoll.js'
import { getAgentContext } from 'src/agent/coordinator/agentContext.js'
import { ownsBackgroundAgents } from 'src/tools/AgentTool/autoBackground.js'
import { isRunInBackgroundHidden } from 'src/tools/AgentTool/prompt.js'
import {
  type MonitorMcpTaskHandle,
  registerMonitorMcpTask,
  type RegisterMonitorMcpTaskInput,
} from 'src/agent/tasks/MonitorMcpTask/registerMonitorMcpTask.js'
import { stopWithin } from 'src/agent/tasks/MonitorMcpTask/controllers.js'
import { MONITOR_MCP_STOP_BUDGET_MS } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { sleep } from 'src/shared/sleep.js'

/**
 * Call an MCP tool, handling UrlElicitationRequiredError (-32042) by
 * displaying the URL elicitation to the user, waiting for the completion
 * notification, and retrying the tool call.
 */
type MCPToolCallResult = {
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}

/** @internal Exported for testing. */
export async function callMCPToolWithUrlElicitationRetry({
  client: connectedClient,
  clientConnection,
  tool,
  args,
  meta,
  signal,
  setAppState,
  onProgress,
  callToolFn = callMCPTool,
  handleElicitation,
  taskDeps,
}: {
  client: ConnectedMCPServer
  clientConnection: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  setAppState: (f: (prev: AppState) => AppState) => void
  onProgress?: (data: MCPProgress) => void
  /** Injectable for testing. Defaults to callMCPTool. */
  callToolFn?: (opts: {
    client: ConnectedMCPServer
    tool: string
    args: Record<string, unknown>
    meta?: Record<string, unknown>
    signal: AbortSignal
    onProgress?: (data: MCPProgress) => void
  }) => Promise<MCPToolCallResult>
  /** Handler for URL elicitations when no hook handles them.
   * In print/SDK mode, delegates to structuredIO. In REPL, falls back to queue. */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  /** Injectable for testing: the clock, the timer and the background gate of a task call. */
  taskDeps?: Partial<McpTaskCallDeps>
}): Promise<MCPToolCallResult> {
  const MAX_URL_ELICITATION_RETRIES = 3
  for (let attempt = 0; ; attempt++) {
    // Check abort signal before each attempt — without this, a cancelled
    // elicitation retry loop continues spinning until MAX retries
    if (signal.aborted) {
      throw new Error('Tool call aborted during URL elicitation')
    }
    let result: MCPToolCallResult
    try {
      result = await callToolFn({
        client: connectedClient,
        tool,
        args,
        meta,
        signal,
        onProgress,
      })
    } catch (error) {
      // The MCP SDK's Protocol creates plain ProtocolError (not UrlElicitationRequiredError)
      // for error responses, so we check the error code instead of instanceof.
      if (
        !(error instanceof ProtocolError) ||
        error.code !== ProtocolErrorCode.UrlElicitationRequired
      ) {
        throw error
      }

      // Limit the number of URL elicitation retries
      if (attempt >= MAX_URL_ELICITATION_RETRIES) {
        throw error
      }

      const errorData = error.data
      const rawElicitations =
        errorData != null &&
          typeof errorData === 'object' &&
          'elicitations' in errorData &&
          Array.isArray(errorData.elicitations)
          ? (errorData.elicitations as unknown[])
          : []

      // Validate each element has the required fields for ElicitRequestURLParams
      const elicitations = rawElicitations.filter(
        (e): e is ElicitRequestURLParams => {
          if (e == null || typeof e !== 'object') return false
          const obj = e as Record<string, unknown>
          return (
            obj.mode === 'url' &&
            typeof obj.url === 'string' &&
            typeof obj.elicitationId === 'string' &&
            typeof obj.message === 'string'
          )
        },
      )

      const serverName =
        clientConnection.type === 'connected'
          ? clientConnection.name
          : 'unknown'

      if (elicitations.length === 0) {
        logMCPDebug(
          serverName,
          `Tool '${tool}' returned -32042 but no valid elicitations in error data`,
        )
        throw error
      }

      logMCPDebug(
        serverName,
        `Tool '${tool}' requires URL elicitation (error -32042, attempt ${attempt + 1}), processing ${elicitations.length} elicitation(s)`,
      )

      // Process each URL elicitation from the error.
      // The completion notification handler (in registerElicitationHandler) sets
      // `completed: true` on the matching queue event; the dialog reacts to this flag.
      for (const elicitation of elicitations) {
        const { elicitationId } = elicitation

        // Run elicitation hooks — they can resolve URL elicitations programmatically
        const hookResponse = await runElicitationHooks(
          serverName,
          elicitation,
          signal,
        )
        if (hookResponse) {
          logMCPDebug(
            serverName,
            `URL elicitation ${elicitationId} resolved by hook: ${jsonStringify(hookResponse)}`,
          )
          if (hookResponse.action !== 'accept') {
            return {
              content: `URL elicitation was ${hookResponse.action === 'decline' ? 'declined' : hookResponse.action + 'ed'} by a hook. The tool "${tool}" could not complete because it requires the user to open a URL.`,
            }
          }
          // Hook accepted — skip the UI and proceed to retry
          continue
        }

        // Resolve the URL elicitation via callback (print/SDK mode) or queue (REPL mode).
        let userResult: ElicitResult
        if (handleElicitation) {
          // Print/SDK mode: delegate to structuredIO which sends a control request
          userResult = await handleElicitation(serverName, elicitation, signal)
        } else {
          // REPL mode: queue for ElicitationDialog with two-phase consent/waiting flow
          const waitingState: ElicitationWaitingState = {
            actionLabel: 'Retry now',
            showCancel: true,
          }
          userResult = await new Promise<ElicitResult>(resolve => {
            const onAbort = () => {
              void resolve({ action: 'cancel' })
            }
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })

            setAppState(prev => ({
              ...prev,
              elicitation: {
                queue: [
                  ...prev.elicitation.queue,
                  {
                    serverName,
                    requestId: `error-elicit-${elicitationId}`,
                    params: elicitation,
                    signal,
                    waitingState,
                    respond: result => {
                      // Phase 1 consent: accept is a no-op (doesn't resolve retry Promise)
                      if (result.action === 'accept') {
                        return
                      }
                      // Decline or cancel: resolve the retry Promise
                      signal.removeEventListener('abort', onAbort)
                      void resolve(result)
                    },
                    onWaitingDismiss: action => {
                      signal.removeEventListener('abort', onAbort)
                      if (action === 'retry') {
                        void resolve({ action: 'accept' })
                      } else {
                        void resolve({ action: 'cancel' })
                      }
                    },
                  },
                ],
              },
            }))
          })
        }

        // Run ElicitationResult hooks — they can modify or block the response
        const finalResult = await runElicitationResultHooks(
          serverName,
          userResult,
          signal,
          'url',
          elicitationId,
        )

        if (finalResult.action !== 'accept') {
          logMCPDebug(
            serverName,
            `User ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} URL elicitation ${elicitationId}`,
          )
          return {
            content: `URL elicitation was ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} by the user. The tool "${tool}" could not complete because it requires the user to open a URL.`,
          }
        }

        logMCPDebug(
          serverName,
          `Elicitation ${elicitationId} completed, retrying tool call`,
        )
      }

      // Loop back to retry the tool call
      continue
    }
    const task = readTaskMarker(result._meta)
    if (!task) return result
    const toolUseId = meta?.['claudecode/toolUseId']
    return runTaskAugmentedCall({
      connection: connectedClient,
      tool,
      task,
      signal,
      setAppState,
      onProgress,
      toolUseId: typeof toolUseId === 'string' ? toolUseId : undefined,
      handleElicitation,
      deps: { ...defaultTaskCallDeps, ...taskDeps },
    })
  }
}

export async function callMCPTool({
  client: { client, name, config },
  tool,
  args,
  meta,
  signal,
  onProgress,
}: {
  client: ConnectedMCPServer
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
}): Promise<{
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}> {
  const toolStartTime = Date.now()
  let progressInterval: NodeJS.Timeout | undefined

  try {
    logMCPDebug(name, `Calling MCP tool: ${tool}`)

    // Set up progress logging for long-running tools (every 30 seconds)
    progressInterval = setInterval(
      (startTime, name, tool) => {
        const elapsed = Date.now() - startTime
        const elapsedSeconds = Math.floor(elapsed / 1000)
        const duration = `${elapsedSeconds}s`
        logMCPDebug(name, `Tool '${tool}' still running (${duration} elapsed)`)
      },
      30000, // Log every 30 seconds
      toolStartTime,
      name,
      tool,
    )

    // Use Promise.race with our own timeout to handle cases where SDK's
    // internal timeout doesn't work (e.g., SSE stream breaks mid-request)
    const timeoutMs = getMcpToolTimeoutMs(config)
    let timeoutId: NodeJS.Timeout | undefined

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        (reject, name, tool, timeoutMs) => {
          reject(toolTimeoutError(name, tool, timeoutMs))
        },
        timeoutMs,
        reject,
        name,
        tool,
        timeoutMs,
      )
    })

    const result = await Promise.race([
      client.callTool(
        {
          name: tool,
          arguments: args,
          _meta: meta,
        },
        {
          signal,
          timeout: timeoutMs,
          onprogress: onProgress
            ? sdkProgress => {
              onProgress({
                type: 'mcp_progress',
                status: 'progress',
                serverName: name,
                toolName: tool,
                progress: sdkProgress.progress,
                total: sdkProgress.total,
                progressMessage: sdkProgress.message,
              })
            }
            : undefined,
        },
      ),
      timeoutPromise,
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    })

    // A task-augmented call: the caller polls the task (runTaskAugmentedCall).
    if (readTaskMarker(result._meta)) {
      logMCPDebug(name, `Tool '${tool}' is running as an MCP task`)
      return { content: undefined, _meta: result._meta }
    }

    throwIfToolError(result, name, tool)
    const elapsed = Date.now() - toolStartTime
    const duration =
      elapsed < 1000
        ? `${elapsed}ms`
        : elapsed < 60000
          ? `${Math.floor(elapsed / 1000)}s`
          : `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`

    logMCPDebug(name, `Tool '${tool}' completed successfully in ${duration}`)

    // Log code indexing tool usage
    const codeIndexingTool = detectCodeIndexingFromMcpServerName(name)

    const content = await processMCPResult(result, tool, name)
    return {
      content,
      _meta: result._meta as Record<string, unknown> | undefined,
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
    }
  } catch (e) {
    // Clear intervals on error
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }

    const elapsed = Date.now() - toolStartTime

    if (e instanceof Error && e.name !== 'AbortError') {
      logMCPDebug(
        name,
        `Tool '${tool}' failed after ${Math.floor(elapsed / 1000)}s: ${e.message}`,
      )
    }

    // Check for 401 errors indicating expired/invalid OAuth tokens
    // The MCP SDK's SdkHttpError carries the HTTP status
    if (e instanceof Error) {
      if (httpStatusOf(e) === 401 || e instanceof UnauthorizedError) {
        logMCPDebug(
          name,
          `Tool call returned 401 Unauthorized - token may have expired`,
        )
        throw new McpAuthError(
          name,
          `MCP server "${name}" requires re-authorization (token expired)`,
        )
      }

      // Check for session expiry — two error shapes can surface here:
      // 1. Direct 404 + JSON-RPC -32001 from the server (SdkHttpError)
      // 2. "Connection closed" (SdkError) — the SDK closes the transport
      //    after the onerror handler fires, so the pending callTool() rejects
      //    with this derived error instead of the original 404.
      // In both cases, clear the connection cache so the next tool call
      // creates a fresh session.
      const isSessionExpired = isMcpSessionExpiredError(e)
      const isConnectionClosedOnHttp =
        isMcpConnectionClosedError(e) &&
        (config.type === 'http' || config.type === 'claudeai-proxy')
      if (isSessionExpired || isConnectionClosedOnHttp) {
        logMCPDebug(
          name,
          `MCP session expired during tool call (${isSessionExpired ? '404/-32001' : 'connection closed'}), clearing connection cache for re-initialization`,
        )
        await clearServerCache(name, config)
        throw new McpSessionExpiredError(name)
      }
    }

    // When the users hits esc, avoid logspew
    if (!(e instanceof Error) || e.name !== 'AbortError') {
      throw e
    }
    return { content: undefined }
  } finally {
    // Always clear intervals
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }
  }
}

type RawToolResult = {
  isError?: unknown
  content?: unknown
  error?: unknown
  _meta?: Record<string, unknown>
}

/** Throws the McpToolCallError an `isError` result stands for. */
function throwIfToolError(result: RawToolResult, name: string, tool: string): void {
  if (!result.isError) return
  let errorDetails = 'Unknown error'
  if (Array.isArray(result.content) && result.content.length > 0) {
    const firstContent: unknown = result.content[0]
    if (
      firstContent &&
      typeof firstContent === 'object' &&
      'text' in firstContent
    ) {
      errorDetails = String(firstContent.text)
    }
  } else if ('error' in result) {
    // Fallback for legacy error format
    errorDetails = String(result.error)
  }
  logMCPError(name, errorDetails)
  // Include server and tool name in telemetry for debugging, but keep
  // the human-readable message unchanged to avoid breaking error consumers
  // that parse the message string.
  throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    errorDetails,
    `MCP tool [${name}] ${tool}: ${errorDetails}`,
    result._meta ? { _meta: result._meta } : undefined,
  )
}

/** The error a tool call past its toolTimeout fails with, task or not. */
function toolTimeoutError(name: string, tool: string, timeoutMs: number): Error {
  return new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
    'MCP tool timeout',
  )
}

// One tasks/* round trip; the poll's own pace is the server's pollIntervalMs.
const TASK_REQUEST_TIMEOUT_MS = 30_000
// tasks/cancel is best effort, and an exit gives a stop 1 s (MonitorMcpTask.ts).
const TASK_CANCEL_TIMEOUT_MS = 5_000
const TASK_SUMMARY_MAX_CHARS = 200
const WHITESPACE_RUN_RE = /\s+/g

/** What a task-augmented call reads from the process, injectable for tests. */
export type McpTaskCallDeps = {
  now: () => number
  /** Resolves after `ms`, or early on abort. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** How long the main thread polls inline before backgrounding (MCP_TASK_INLINE_MS). */
  inlineMs: () => number
  /** True where nothing may run in the background: `-p`, CLAUDIN_DISABLE_BACKGROUND_TASKS. */
  isBackgroundHidden: () => boolean
  registerTask: (input: RegisterMonitorMcpTaskInput) => MonitorMcpTaskHandle
  /** The process-exit hook of the inline poll; the monitor_mcp task has its own. */
  registerCleanup: (cleanup: () => Promise<void>) => () => void
}

const defaultTaskCallDeps: McpTaskCallDeps = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, signal),
  inlineMs: () => MCP_TASK_INLINE_MS,
  isBackgroundHidden: isRunInBackgroundHidden,
  registerTask: input => registerMonitorMcpTask(input),
  registerCleanup,
}

type TaskCallContext = {
  connection: ConnectedMCPServer
  tool: string
  setAppState: (f: (prev: AppState) => AppState) => void
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  deps: McpTaskCallDeps
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Answers one `input_required` entry: `roots/list` as the connection answers
 * it, an elicitation by asking the user the way a server-initiated one is
 * asked. taskPoll.ts never hands over another method; an elicitation with
 * no message is left unanswered.
 */
async function answerTaskInput(
  context: TaskCallContext,
  taskId: string,
  key: string,
  request: McpTaskInputRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const { connection, setAppState, handleElicitation } = context
  if (request.method === 'roots/list') return listRootsResult()
  if (request.method !== 'elicitation/create' || typeof request.params?.message !== 'string') {
    logMCPDebug(connection.name, `MCP task ${taskId}: no answer for input request '${key}' (${request.method})`)
    return undefined
  }
  return elicitFromUser({
    serverName: connection.name,
    requestId: `task-${taskId}-${key}`,
    params: request.params as ElicitRequestParams,
    signal,
    modern: connection.client.getProtocolEra() === 'modern',
    setAppState,
    // Print/SDK mode asks structuredIO, as for a URL elicitation retry.
    ...(handleElicitation && {
      ask: (params: ElicitRequestParams, askSignal: AbortSignal) =>
        handleElicitation(connection.name, params as ElicitRequestURLParams, askSignal),
    }),
  })
}

function taskPollIO(context: TaskCallContext, taskId: string): Omit<TaskPollDeps, 'onStatus'> {
  const { client } = context.connection
  return {
    getTask: (id, signal) =>
      client.request({ method: 'tasks/get', params: { taskId: id } }, McpTaskSchema, {
        signal,
        timeout: TASK_REQUEST_TIMEOUT_MS,
      }),
    updateTask: async (id, inputResponses, signal) => {
      await client.request({ method: 'tasks/update', params: { taskId: id, inputResponses } }, McpTaskAckSchema, {
        signal,
        timeout: TASK_REQUEST_TIMEOUT_MS,
      })
    },
    cancelTask: async id => {
      await client.request({ method: 'tasks/cancel', params: { taskId: id } }, McpTaskAckSchema, {
        timeout: TASK_CANCEL_TIMEOUT_MS,
      })
    },
    answerInput: (key, request, signal) => answerTaskInput(context, taskId, key, request, signal),
    now: context.deps.now,
    sleep: context.deps.sleep,
  }
}

/** The tool result a finished poll stands for, through the same transform as a plain call. */
async function taskOutcomeResult(
  outcome: TaskPollOutcome,
  name: string,
  tool: string,
): Promise<MCPToolCallResult> {
  switch (outcome.kind) {
    case 'completed': {
      const result = outcome.result
      if (!isRecord(result)) {
        throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
          `MCP server "${name}" tool "${tool}": the task completed without a result`,
          'MCP task without a result',
        )
      }
      throwIfToolError(result, name, tool)
      const content = await processMCPResult(result, tool, name)
      return {
        content,
        _meta: isRecord(result._meta) ? result._meta : undefined,
        structuredContent: isRecord(result.structuredContent) ? result.structuredContent : undefined,
      }
    }
    case 'failed':
    case 'cancelled':
    case 'expired':
    case 'unsupported':
      logMCPError(name, outcome.message)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        outcome.message,
        `MCP tool [${name}] ${tool}: ${outcome.message}`,
      )
    default:
      // Aborted: the user pressed esc, as callMCPTool answers it.
      return { content: undefined }
  }
}

function contentText(content: MCPToolResult): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
}

/** The notification's summary: the result's first text, on one line. */
export function taskResultSummary(content: MCPToolResult): string {
  const first =
    typeof content === 'string'
      ? content
      : (content?.find(block => block.type === 'text') as { text: string } | undefined)?.text ?? ''
  const line = first.replace(WHITESPACE_RUN_RE, ' ').trim()
  return line.length > TASK_SUMMARY_MAX_CHARS ? `${line.slice(0, TASK_SUMMARY_MAX_CHARS - 1)}…` : line
}

/** What the model reads when the call moves to the background, in the Bash shape. */
export function backgroundTaskCallText(tool: string, serverName: string, taskId: string, outputFile: string): string {
  return `Tool "${tool}" on MCP server "${serverName}" is still running as an MCP task and was moved to the background with ID: ${taskId}. You will be notified when it completes. Output is being written to: ${outputFile}`
}

async function finishInBackground(
  context: TaskCallContext,
  state: TaskPollState,
  handle: MonitorMcpTaskHandle,
  signal: AbortSignal,
): Promise<void> {
  const { connection, tool } = context
  let ending: { status: 'completed' | 'failed'; summary: string }
  try {
    const outcome = await pollTask(
      state,
      {
        ...taskPollIO(context, state.task.taskId),
        onStatus: message => {
          handle.setStatus(message)
          handle.appendOutput(`${message}\n`)
        },
      },
      { signal },
    )
    // Stopped by TaskStop, the dialog or exit: the kill already ended the task.
    if (outcome.kind === 'aborted' || outcome.kind === 'pending') return
    const { content } = await taskOutcomeResult(outcome, connection.name, tool)
    const text = contentText(content)
    handle.appendOutput(text.endsWith('\n') ? text : `${text}\n`)
    ending = { status: 'completed', summary: taskResultSummary(content) }
  } catch (error) {
    const message = errorMessage(error)
    handle.appendOutput(`${message}\n`)
    ending = { status: 'failed', summary: message }
  }
  await handle.finish(ending)
}

/**
 * Polls a task a `tools/call` came back as. The main thread of an
 * interactive session waits for it up to MCP_TASK_INLINE_MS (never past the
 * tool timeout) and then hands it to a background monitor_mcp task,
 * returning at once. A sub-agent, `-p` or a session with background tasks
 * off has no background (autoBackground.ts): the task is a plain call there,
 * cancelled at the tool timeout with the same error.
 *
 * @internal Exported for testing.
 */
export async function runTaskAugmentedCall({
  task,
  signal,
  onProgress,
  toolUseId,
  ...context
}: TaskCallContext & {
  task: McpTask
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
  toolUseId?: string
}): Promise<MCPToolCallResult> {
  const { connection, tool, deps } = context
  const { name, config } = connection
  logMCPDebug(name, `Tool '${tool}' returned MCP task ${task.taskId} (${task.status})`)
  const state = startTaskPoll(task, deps.now())
  const agentId = getAgentContext()?.agentId
  const mayBackground = ownsBackgroundAgents(agentId) && !deps.isBackgroundHidden()
  const toolTimeoutMs = getMcpToolTimeoutMs(config)
  const stopAt =
    deps.now() + (mayBackground ? inlineTaskBudgetMs(deps.inlineMs(), toolTimeoutMs) : toolTimeoutMs)
  const io = taskPollIO(context, task.taskId)

  // An exit does not abort the turn's signal, so the inline poll has its own
  // stop: the poll then sends the one tasks/cancel, and the exit waits for
  // it as it waits for a monitor_mcp task's.
  const inlineStop = new AbortController()
  // Without a background the tool timeout ends the call even inside a
  // request: a tasks/get that never answers is cut there, not at its own
  // TASK_REQUEST_TIMEOUT_MS.
  let timedOut = false
  const deadline = mayBackground
    ? undefined
    : setTimeout(() => {
        timedOut = true
        inlineStop.abort()
      }, toolTimeoutMs)
  const inlinePoll = pollTask(
    state,
    {
      ...io,
      onStatus: message =>
        onProgress?.({
          type: 'mcp_progress',
          status: 'progress',
          serverName: name,
          toolName: tool,
          progressMessage: message,
        }),
    },
    { signal: AbortSignal.any([signal, inlineStop.signal]), stopAt },
  )
  const unregisterExit = deps.registerCleanup(() => {
    inlineStop.abort()
    return stopWithin(() => inlinePoll.then(() => {}, () => {}), MONITOR_MCP_STOP_BUDGET_MS)
  })
  let inline: TaskPollOutcome
  try {
    inline = await inlinePoll
  } finally {
    clearTimeout(deadline)
    // Settled or about to be handed off: the monitor_mcp task stops it at exit from here.
    unregisterExit()
  }
  if (inline.kind === 'aborted' && timedOut && !signal.aborted) {
    // Cut mid-request or mid-sleep: the poll has sent the tasks/cancel.
    logMCPError(name, `MCP task ${task.taskId} cancelled at the tool timeout`)
    throw toolTimeoutError(name, tool, toolTimeoutMs)
  }
  if (inline.kind !== 'pending') return taskOutcomeResult(inline, name, tool)
  if (!mayBackground) {
    await cancelPolledTask(task.taskId, io)
    logMCPError(name, `MCP task ${task.taskId} cancelled at the tool timeout`)
    throw toolTimeoutError(name, tool, toolTimeoutMs)
  }

  // The turn's signal ends with the turn; the background poll stops only
  // through the task (TaskStop, the dialog, agent or process exit).
  const background = new AbortController()
  let settled: Promise<void> = Promise.resolve()
  const handle = deps.registerTask({
    kind: 'call',
    serverName: name,
    description: tool,
    toolUseId,
    onStop: () => {
      background.abort()
      return settled
    },
    setAppState: context.setAppState,
  })
  if (state.lastStatus) handle.setStatus(state.lastStatus)
  settled = finishInBackground(context, state, handle, background.signal).catch((error: unknown) =>
    logMCPError(name, `MCP task ${task.taskId} in the background: ${errorMessage(error)}`),
  )
  logMCPDebug(name, `MCP task ${task.taskId} moved to the background as ${handle.taskId}`)
  return { content: backgroundTaskCallText(tool, name, handle.taskId, handle.outputFile) }
}

export function extractToolUseId(
  message: AssistantMessage,
): string | undefined {
  if (message.message.content[0]?.type !== 'tool_use') {
    return undefined
  }
  return message.message.content[0].id
}
