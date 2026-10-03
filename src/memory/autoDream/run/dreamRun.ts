/**
 * One dream, once the lock is taken: the task, the fork, and how it settles.
 * The run owns the task and the lock until the fork ends, except when its
 * abort controller fired: whoever aborted it settles both.
 */
import {
  createCacheSafeParams,
  type ForkedAgentParams,
  type ForkedAgentResult,
} from 'src/agent/coordinator/forkedAgent.js'
import { createMemorySavedMessage, createUserMessage } from 'src/agent/messages/messages.js'
import type { SetAppState } from 'src/agent/Task.js'
import {
  completeDreamTask,
  failDreamTask,
  isDreamTask,
  registerDreamTask,
} from 'src/agent/tasks/DreamTask/DreamTask.js'
import { buildDreamRunContext } from 'src/memory/autoDream/prompt/runContext.js'
import { writtenPaths } from 'src/memory/autoDream/run/forkMessages.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { Message, SystemMemorySavedMessage } from 'src/shared/types/message.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

/**
 * The saved-memory notice of a dream. The renderer does not read `verb` yet,
 * and the shared message type does not declare it, so it is declared here.
 */
type DreamSavedNotice = SystemMemorySavedMessage & { readonly verb: 'Improved' }

export type DreamTaskStore = {
  readonly register: typeof registerDreamTask
  readonly complete: typeof completeDreamTask
  readonly fail: typeof failDreamTask
}

export const productionTaskStore: DreamTaskStore = {
  register: registerDreamTask,
  complete: completeDreamTask,
  fail: failDreamTask,
}

export type DreamRunDeps = {
  readonly runFork: (params: ForkedAgentParams) => Promise<ForkedAgentResult>
  readonly digest: (sinceMs: number, sessionIds: readonly string[]) => Promise<string>
  readonly tasks: DreamTaskStore
  /** The dream prompt for this memory directory, with `extra` as its additional context. */
  readonly prompt: (extra: string) => string
  readonly canUseTool: () => CanUseToolFn
  readonly watch: (taskId: string, setAppState: SetAppState) => (message: Message) => void
  readonly rollback: (priorMtime: number) => Promise<void>
  readonly announceSaves: () => boolean
}

export type DreamRunInput = {
  readonly context: REPLHookContext
  readonly appendSystemMessage?: AppendSystemMessageFn
  readonly sessionIds: readonly string[]
  /** The start of the period the digest covers. */
  readonly lastConsolidatedAt: number
  /** The lock's time before this run took it; 0 when there was none. */
  readonly priorMtime: number
}

export type DreamOutcome = 'completed' | 'failed' | 'abortedElsewhere'

const QUERY_SOURCE = 'auto_dream'

function taskSetter(context: REPLHookContext): SetAppState {
  const { setAppStateForTasks, setAppState } = context.toolUseContext
  return setAppStateForTasks ?? setAppState
}

function savedNotice(paths: string[]): DreamSavedNotice {
  return { ...createMemorySavedMessage(paths), verb: 'Improved' }
}

/** The files to announce: the task's, as the context's app state shows it, that were written. */
function pathsToAnnounce(context: REPLHookContext, taskId: string, forkMessages: readonly Message[]): string[] {
  const task = context.toolUseContext.getAppState?.().tasks?.[taskId]
  return isDreamTask(task) ? writtenPaths(task.filesTouched, forkMessages) : []
}

export async function runDream(input: DreamRunInput, deps: DreamRunDeps): Promise<DreamOutcome> {
  const { context, sessionIds } = input
  const setTaskState = taskSetter(context)
  const abortController = new AbortController()
  const taskId = deps.tasks.register(setTaskState, {
    sessionsReviewing: sessionIds.length,
    priorMtime: input.priorMtime,
    abortController,
  })

  try {
    const digest = await deps.digest(input.lastConsolidatedAt, sessionIds)
    const prompt = deps.prompt(buildDreamRunContext(sessionIds, digest))
    const result = await deps.runFork({
      promptMessages: [createUserMessage({ content: prompt })],
      cacheSafeParams: createCacheSafeParams(context),
      canUseTool: deps.canUseTool(),
      querySource: QUERY_SOURCE,
      forkLabel: QUERY_SOURCE,
      skipTranscript: true,
      overrides: { abortController },
      onMessage: deps.watch(taskId, setTaskState),
    })
    logForDebugging(`[autoDream] finished; usage ${JSON.stringify(result.totalUsage)}`)
    deps.tasks.complete(taskId, setTaskState)

    const paths = pathsToAnnounce(context, taskId, result.messages)
    if (input.appendSystemMessage && paths.length > 0 && deps.announceSaves()) {
      input.appendSystemMessage(savedNotice(paths))
    }
    return 'completed'
  } catch (error) {
    if (abortController.signal.aborted) {
      logForDebugging('[autoDream] the run was aborted; its task and lock are left to whoever aborted it')
      return 'abortedElsewhere'
    }
    logForDebugging(`[autoDream] the run failed: ${errorMessage(error)}`, { level: 'error' })
    deps.tasks.fail(taskId, setTaskState)
    await deps.rollback(input.priorMtime)
    return 'failed'
  }
}
