/**
 * The client side of an MCP task (SEP-2663, the 2026-07-28 extension
 * `io.modelcontextprotocol/tasks`). A server that knows the client declared
 * the extension may answer a `tools/call` with a task instead of a result;
 * wireRules.ts hands it over under MCP_TASK_META_KEY, and this polls it to an
 * end: `tasks/get` at the server's `pollIntervalMs` (floor 1 s, cap 30 s,
 * 2 s when it names none), its `statusMessage` reported as progress, every
 * `input_required` request answered once and sent back with `tasks/update`,
 * and `tasks/cancel` when the caller aborts or a poll request fails.
 *
 * An input request Claudin cannot answer (anything but an elicitation or
 * `roots/list`: sampling is not declared) cancels the task at once, so
 * nothing waits out the task's lifetime for an answer that never comes.
 *
 * The decisions are pure; pollTask is the one loop, over injected I/O, clock
 * and sleep. It can stop at a deadline with the task still running and pick
 * up again from the same state, which is how callTool.ts hands a call that
 * outlives its inline window to a background monitor_mcp task.
 */
import { z } from 'zod/v4'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { MCP_TASK_META_KEY } from 'src/mcp/client/wireRules.js'

export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

export const TASK_POLL_FLOOR_MS = 1_000
export const TASK_POLL_CAP_MS = 30_000
export const TASK_POLL_DEFAULT_MS = 2_000

/**
 * How long the main thread waits on a task inside the tool call before it
 * moves to the background, never past the server's tool timeout.
 */
export const MCP_TASK_INLINE_MS = 120_000

/** The input requests a task may ask that Claudin answers. */
export const SUPPORTED_TASK_INPUT_METHODS: ReadonlySet<string> = new Set(['elicitation/create', 'roots/list'])

// Only the id and status are required: a field of the wrong type reads as
// absent rather than failing the poll.
export const McpTaskSchema = z.looseObject({
  taskId: z.string(),
  status: z.string(),
  statusMessage: z.string().optional().catch(undefined),
  ttlMs: z.number().optional().catch(undefined),
  pollIntervalMs: z.number().optional().catch(undefined),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  inputRequests: z.record(z.string(), z.unknown()).optional().catch(undefined),
})

export type McpTask = z.infer<typeof McpTaskSchema>

/** What `tasks/update` and `tasks/cancel` answer; nothing in it is read. */
export const McpTaskAckSchema = z.looseObject({})

const InputRequestSchema = z.looseObject({
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})

export type McpTaskInputRequest = z.infer<typeof InputRequestSchema>

/** The task a tool result carries under MCP_TASK_META_KEY, if it is one. */
export function readTaskMarker(meta: Record<string, unknown> | undefined): McpTask | undefined {
  const parsed = McpTaskSchema.safeParse(meta?.[MCP_TASK_META_KEY])
  return parsed.success ? parsed.data : undefined
}

/** How long to wait before the next `tasks/get`. */
export function pollDelayMs(task: Pick<McpTask, 'pollIntervalMs'>): number {
  const asked = task.pollIntervalMs
  if (asked === undefined || !Number.isFinite(asked)) return TASK_POLL_DEFAULT_MS
  return Math.min(TASK_POLL_CAP_MS, Math.max(TASK_POLL_FLOOR_MS, asked))
}

/**
 * How long a task may run inside the tool call before it moves to the
 * background: `inlineMs` (MCP_TASK_INLINE_MS), never past the tool timeout.
 */
export function inlineTaskBudgetMs(inlineMs: number, toolTimeoutMs: number): number {
  return Math.min(inlineMs, toolTimeoutMs)
}

/** The tool error for a task that asked for an input Claudin does not offer. */
export function unsupportedTaskInputMessage(method: string): string {
  return `the MCP server asked for ${method}, which Claudin does not support`
}

/** The server's words for a task that did not complete, or a stand-in. */
export function taskFailureMessage(task: McpTask): string {
  const error = task.error
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  if (typeof error === 'string' && error) return error
  if (task.statusMessage) return task.statusMessage
  return `MCP task ${task.taskId} ${task.status === 'cancelled' ? 'was cancelled' : 'failed'}`
}

export type TaskStep =
  | { kind: 'completed'; result: unknown }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'input'; requests: Array<[string, McpTaskInputRequest]> }
  | { kind: 'unsupported'; method: string }
  | { kind: 'working' }

/**
 * What the task's latest status asks of the client. `answered` holds the
 * input keys already sent, so a request the server still lists while it
 * works through the update is not asked twice; an entry that is not a
 * request is never asked, and one Claudin cannot answer ends the task.
 * Any status the spec does not name reads as working.
 */
export function taskStep(task: McpTask, answered: ReadonlySet<string>): TaskStep {
  switch (task.status) {
    case 'completed':
      return { kind: 'completed', result: task.result }
    case 'failed':
      return { kind: 'failed', message: taskFailureMessage(task) }
    case 'cancelled':
      return { kind: 'cancelled', message: taskFailureMessage(task) }
    case 'input_required': {
      const requests: Array<[string, McpTaskInputRequest]> = []
      for (const [key, raw] of Object.entries(task.inputRequests ?? {})) {
        if (answered.has(key)) continue
        const request = InputRequestSchema.safeParse(raw)
        if (!request.success) continue
        if (!SUPPORTED_TASK_INPUT_METHODS.has(request.data.method)) {
          return { kind: 'unsupported', method: request.data.method }
        }
        requests.push([key, request.data])
      }
      return requests.length > 0 ? { kind: 'input', requests } : { kind: 'working' }
    }
    default:
      return { kind: 'working' }
  }
}

export type TaskPollDeps = {
  getTask: (taskId: string, signal: AbortSignal) => Promise<McpTask>
  updateTask: (taskId: string, inputResponses: Record<string, unknown>, signal: AbortSignal) => Promise<void>
  /** Best effort; a failure is logged and the poll still ends as it would have. */
  cancelTask: (taskId: string) => Promise<void>
  /** The bare response for one input request, or undefined to leave it unanswered. */
  answerInput: (key: string, request: McpTaskInputRequest, signal: AbortSignal) => Promise<unknown>
  onStatus: (message: string) => void
  now: () => number
  /** Resolves after `ms`, or early on abort. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/** A poll in progress, carried from the inline window into the background. */
export type TaskPollState = {
  task: McpTask
  answered: Set<string>
  /** The task's `ttlMs` past its arrival: a server that never ends it stops being polled. */
  expiresAt?: number
  lifetimeMs?: number
  lastStatus?: string
}

export function startTaskPoll(task: McpTask, now: number): TaskPollState {
  const ttl = task.ttlMs
  return {
    task,
    answered: new Set(),
    ...(ttl !== undefined && ttl > 0 && { expiresAt: now + ttl, lifetimeMs: ttl }),
  }
}

export type TaskPollOutcome =
  | { kind: 'completed'; result: unknown }
  | { kind: 'failed' | 'cancelled' | 'expired' | 'unsupported'; message: string }
  | { kind: 'aborted' }
  /** `stopAt` came with the task still running; `state` goes on from here. */
  | { kind: 'pending' }

/** Sends `tasks/cancel`, best effort: a failure is logged, never thrown. */
export async function cancelPolledTask(taskId: string, deps: Pick<TaskPollDeps, 'cancelTask'>): Promise<void> {
  try {
    await deps.cancelTask(taskId)
  } catch (error) {
    logForDebugging(`MCP task ${taskId}: tasks/cancel failed: ${errorMessage(error)}`)
  }
}

async function cancelled(state: TaskPollState, deps: TaskPollDeps): Promise<TaskPollOutcome> {
  await cancelPolledTask(state.task.taskId, deps)
  return { kind: 'aborted' }
}

/**
 * A tasks/get or tasks/update that failed ends the poll with its error, and
 * nothing polls the task after that: it is cancelled first, or it would run
 * on the server until its ttl.
 */
async function abandoned(state: TaskPollState, deps: TaskPollDeps, error: unknown): Promise<never> {
  await cancelPolledTask(state.task.taskId, deps)
  throw error
}

export async function pollTask(
  state: TaskPollState,
  deps: TaskPollDeps,
  { signal, stopAt }: { signal: AbortSignal; stopAt?: number },
): Promise<TaskPollOutcome> {
  for (;;) {
    const task = state.task
    if (task.statusMessage && task.statusMessage !== state.lastStatus) {
      state.lastStatus = task.statusMessage
      deps.onStatus(task.statusMessage)
    }
    const step = taskStep(task, state.answered)
    if (step.kind === 'completed' || step.kind === 'failed' || step.kind === 'cancelled') return step
    if (signal.aborted) return cancelled(state, deps)
    if (step.kind === 'unsupported') {
      await cancelPolledTask(task.taskId, deps)
      return { kind: 'unsupported', message: unsupportedTaskInputMessage(step.method) }
    }

    if (step.kind === 'input') {
      const responses: Record<string, unknown> = {}
      for (const [key, request] of step.requests) {
        state.answered.add(key)
        const response = await deps.answerInput(key, request, signal)
        if (response !== undefined) responses[key] = response
      }
      if (signal.aborted) return cancelled(state, deps)
      if (Object.keys(responses).length > 0) {
        try {
          await deps.updateTask(task.taskId, responses, signal)
        } catch (error) {
          if (signal.aborted) return cancelled(state, deps)
          return abandoned(state, deps, error)
        }
      }
    }

    const now = deps.now()
    if (state.expiresAt !== undefined && now >= state.expiresAt) {
      return {
        kind: 'expired',
        message: `MCP task ${task.taskId} was still ${task.status} when its ${Math.round((state.lifetimeMs ?? 0) / 1000)}s lifetime ran out`,
      }
    }
    if (stopAt !== undefined && now >= stopAt) return { kind: 'pending' }
    const until = Math.min(stopAt ?? Infinity, state.expiresAt ?? Infinity)
    await deps.sleep(Math.min(pollDelayMs(task), until - now), signal)
    if (signal.aborted) return cancelled(state, deps)
    try {
      state.task = await deps.getTask(task.taskId, signal)
    } catch (error) {
      if (signal.aborted) return cancelled(state, deps)
      return abandoned(state, deps, error)
    }
  }
}
