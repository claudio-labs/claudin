/**
 * Task-augmented tool calls (SEP-2663, 2026-07-28 only): a `tools/call` the
 * server answers with a task instead of a result. callTool.ts sends the call
 * and turns such an answer into a marker (wireRules.ts); this module polls
 * the task (taskPoll.ts) inline, then hands it to a background monitor_mcp
 * task, or cancels it at the tool timeout where nothing can run in the
 * background. It is the only part of the tool call that reaches into the
 * agent: the background gate and the task registry.
 */
import type {
  ElicitRequestParams,
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/client'
import type { AppState } from 'src/terminal/state/AppState.js'
import { errorMessage, TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import type { MCPToolResult } from 'src/mcp/mcpValidation.js'
import type { MCPProgress } from 'src/tools/MCPTool/MCPTool.js'
import { elicitFromUser } from 'src/mcp/elicitationHandler.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import {
  callMCPToolWithUrlElicitationRetry,
  type MCPToolCallResult,
  throwIfToolError,
  toolTimeoutError,
} from 'src/mcp/client/callTool.js'
import { listRootsResult } from 'src/mcp/client/connection.js'
import { McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/mcp/client/errors.js'
import { isRecord } from 'src/mcp/client/listValidation.js'
import { processMCPResult } from 'src/mcp/client/toolResult.js'
import { getMcpToolTimeoutMs } from 'src/mcp/client/serverOptions.js'
import {
  cancelPolledTask,
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
    deps.now() + (mayBackground ? Math.min(deps.inlineMs(), toolTimeoutMs) : toolTimeoutMs)
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

/**
 * A tool call that may come back as a task: callMCPToolWithUrlElicitationRetry,
 * then, when the answer is a task marker, runTaskAugmentedCall on it.
 *
 * @internal `taskDeps` is injectable for testing.
 */
export async function callMCPToolWithTasks({
  taskDeps,
  ...call
}: Parameters<typeof callMCPToolWithUrlElicitationRetry>[0] & {
  /** The clock, the timer and the background gate of a task call. */
  taskDeps?: Partial<McpTaskCallDeps>
}): Promise<MCPToolCallResult> {
  const result = await callMCPToolWithUrlElicitationRetry(call)
  const task = readTaskMarker(result._meta)
  if (!task) return result
  const toolUseId = call.meta?.['claudecode/toolUseId']
  return runTaskAugmentedCall({
    connection: call.client,
    tool: call.tool,
    task,
    signal: call.signal,
    setAppState: call.setAppState,
    onProgress: call.onProgress,
    toolUseId: typeof toolUseId === 'string' ? toolUseId : undefined,
    handleElicitation: call.handleElicitation,
    deps: { ...defaultTaskCallDeps, ...taskDeps },
  })
}
