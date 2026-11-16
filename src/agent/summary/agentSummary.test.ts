import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { CacheSafeParams } from 'src/agent/coordinator/forkedAgent.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import {
  type AgentSummaryDeps,
  defaultAgentSummaryDeps,
  periodicSummaryEnabled,
  startAgentSummarization,
  summarizeAgentResult,
  summaryForkParams,
} from 'src/agent/summary/agentSummary.js'
import {
  getSdkAgentProgressSummariesEnabled,
  setSdkAgentProgressSummariesEnabled,
} from 'src/platform/bootstrap/state.js'
import { EMPTY_USAGE } from 'src/providers/usage/emptyUsage.js'
import * as logModule from 'src/shared/log.js'
import { asAgentId } from 'src/shared/types/ids.js'

describe('summaryForkParams', () => {
  const cacheSafeParams = {} as CacheSafeParams

  test.each(['agent_summary', 'agent_result_summary'] as const)(
    '%s skips the cache write: no later request reads a summary tail',
    forkLabel => {
      const params = summaryForkParams(
        'Describe your most recent action',
        cacheSafeParams,
        forkLabel,
        new AbortController(),
      )
      expect(params.skipCacheWrite).toBe(true)
      expect(params.forkLabel).toBe(forkLabel)
      // Both forks keep the parent's cache key: same params, tools denied by
      // callback rather than removed.
      expect(params.cacheSafeParams).toBe(cacheSafeParams)
      expect(params.skipTranscript).toBe(true)
    },
  )
})

// Both summary forks, driven through AgentSummaryDeps: the transcript, the
// fork and the writer are fakes, and the 30 s timer is a list the test fires
// by hand. No mock.module, no timer globals. The gate is open in the shared
// fake; the suites at the end close it and read the real one.

type Messages = CacheSafeParams['forkContextMessages']
type ForkParams = Parameters<AgentSummaryDeps['runForkedAgent']>[0]
type ForkResult = Awaited<ReturnType<AgentSummaryDeps['runForkedAgent']>>
type TimerHandle = ReturnType<AgentSummaryDeps['schedule']>
type SetAppState = Parameters<typeof startAgentSummarization>[3]

const TASK_ID = 'task-1'
const AGENT_ID = asAgentId('a0123456789abcdef')
const setAppState: SetAppState = () => {}

const user = (content: string) => createUserMessage({ content })
const assistant = (content: string) => createAssistantMessage({ content })
const toolUse = (id: string) =>
  createAssistantMessage({
    content: [{ type: 'tool_use' as const, id, name: 'Read', input: { file_path: '/a' } }],
  })

function forkResult(...messages: Messages): ForkResult {
  return { messages, totalUsage: { ...EMPTY_USAGE } }
}

function cacheSafeParams(forkContextMessages: Messages = []): CacheSafeParams {
  return {
    systemPrompt: ['SYSTEM-MARKER'],
    userContext: { marker: 'USER-CONTEXT-MARKER' },
    systemContext: {},
    toolUseContext: { marker: 'TOOLS-MARKER' },
    forkContextMessages,
  } as unknown as CacheSafeParams
}

/** Enough transcript for a tick to fork: the gate is three messages. */
function threeMessages(): Messages {
  return [user('fix the null check'), assistant('Looking at validate.ts'), user('go on')]
}

function promptText(params: ForkParams): string {
  expect(params.promptMessages).toHaveLength(1)
  const [prompt] = params.promptMessages
  if (prompt?.type !== 'user') throw new Error('the summary prompt is a user message')
  return String(prompt.message.content)
}

// The seam's handle is setTimeout's own type, and the code under test only
// hands it back to cancel(): a real handle, cleared before it can fire.
function deadHandle(): TimerHandle {
  const handle = setTimeout(() => {}, 0)
  clearTimeout(handle)
  return handle
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(over: Partial<AgentSummaryDeps> = {}) {
  const timers: { fn: () => unknown; ms: number; handle: TimerHandle; cancelled: boolean }[] = []
  const reads: string[] = []
  const forks: ForkParams[] = []
  const written: { taskId: string; summary: string; setAppState: SetAppState }[] = []
  const forkStarted = deferred<ForkParams>()
  // What the fakes answer with; a test assigns either before the tick.
  const answers: {
    transcript: { messages: Messages } | null
    reply: (params: ForkParams) => Promise<ForkResult>
  } = {
    transcript: null,
    reply: async () => forkResult(assistant('Reading runAgent.ts')),
  }
  const deps: AgentSummaryDeps = {
    enabled: () => true,
    getAgentTranscript: async agentId => {
      reads.push(agentId)
      return answers.transcript
    },
    runForkedAgent: async params => {
      forks.push(params)
      forkStarted.resolve(params)
      return answers.reply(params)
    },
    updateAgentSummary: (taskId, summary, set) => {
      written.push({ taskId, summary, setAppState: set })
    },
    schedule: (fn, ms) => {
      const handle = deadHandle()
      timers.push({ fn, ms, handle, cancelled: false })
      return handle
    },
    cancel: handle => {
      for (const timer of timers) {
        if (timer.handle === handle) timer.cancelled = true
      }
    },
    ...over,
  }
  return {
    deps,
    answers,
    timers,
    reads,
    forks,
    written,
    /** Resolves with the params of the first fork, for a test that leaves it in flight. */
    forkStarted: forkStarted.promise,
    /** Fires the newest timer — also one stop() cancelled, as a callback already dequeued would. */
    tick: async () => {
      await timers.at(-1)?.fn()
    },
  }
}

function start(h: ReturnType<typeof harness>, params = cacheSafeParams()) {
  return startAgentSummarization(TASK_ID, AGENT_ID, params, setAppState, h.deps)
}

/** The sub-agent's next step: the same transcript with more at its end. */
function grow(h: ReturnType<typeof harness>, ...more: Messages) {
  h.answers.transcript = { messages: [...(h.answers.transcript?.messages ?? []), ...more] }
}

let logError: ReturnType<typeof spyOn<typeof logModule, 'logError'>>

beforeEach(() => {
  logError = spyOn(logModule, 'logError').mockImplementation(() => {})
})

afterEach(() => {
  logError.mockRestore()
})

describe('startAgentSummarization', () => {
  test('start arms one timer at 30 000 ms and forks nothing yet', () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    start(h)
    expect(h.timers.map(t => t.ms)).toEqual([30_000])
    expect(h.reads).toEqual([])
    expect(h.forks).toEqual([])
  })

  test.each([
    ['no transcript', null],
    ['fewer than three messages', { messages: [user('fix it'), assistant('Looking')] }],
  ])('a tick with %s forks nothing and reschedules', async (_label, transcript) => {
    const h = harness()
    h.answers.transcript = transcript
    start(h)
    await h.tick()
    expect(h.reads).toEqual([AGENT_ID])
    expect(h.forks).toEqual([])
    expect(h.written).toEqual([])
    expect(h.timers.map(t => t.ms)).toEqual([30_000, 30_000])
  })

  test('a tick forks the cleaned transcript with the summary prompt as the only prompt message', async () => {
    const h = harness()
    const complete = threeMessages()
    // A tool call with no result yet is cut: the fork would be rejected on it.
    h.answers.transcript = { messages: [...complete, toolUse('toolu_pending')] }
    start(h)
    await h.tick()

    expect(h.forks).toHaveLength(1)
    const [fork] = h.forks
    expect(fork!.cacheSafeParams.forkContextMessages).toEqual(complete)
    const prompt = promptText(fork!)
    expect(prompt).toContain('Describe your most recent action in 3-5 words')
    expect(prompt).not.toContain('Previous:')
    expect(fork!.querySource).toBe('agent_summary')
    expect(fork!.forkLabel).toBe('agent_summary')
    expect(fork!.skipTranscript).toBe(true)
    expect(fork!.skipCacheWrite).toBe(true)
    expect(fork!.overrides?.abortController?.signal.aborted).toBe(false)
  })

  test('the fork keeps the tools in its params and denies them through canUseTool', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    const params = cacheSafeParams()
    start(h, params)
    await h.tick()

    const [fork] = h.forks
    expect(fork!.cacheSafeParams.toolUseContext).toBe(params.toolUseContext)
    expect(fork!.cacheSafeParams.systemPrompt).toBe(params.systemPrompt)
    const decision = await fork!.canUseTool(
      {} as never,
      {},
      {} as never,
      {} as never,
      'toolu_1',
    )
    expect(decision.behavior).toBe('deny')
  })

  test('the summary text is written through the writer with the task id, whitespace trimmed', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    h.answers.reply = async () => forkResult(assistant('  Reading runAgent.ts \n'))
    start(h)
    await h.tick()
    expect(h.written).toEqual([{ taskId: TASK_ID, summary: 'Reading runAgent.ts', setAppState }])
    expect(h.timers).toHaveLength(2)
  })

  test('an API-error assistant message is skipped for the text after it', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    h.answers.reply = async () =>
      forkResult(
        createAssistantAPIErrorMessage({ content: 'API Error: overloaded' }),
        assistant('Fixing null check in validate.ts'),
      )
    start(h)
    await h.tick()
    expect(h.written.map(w => w.summary)).toEqual(['Fixing null check in validate.ts'])
  })

  test.each([
    ['only an API error', () => [createAssistantAPIErrorMessage({ content: 'API Error: overloaded' })]],
    ['whitespace', () => [assistant('   ')]],
    ['a tool call and no text', () => [toolUse('toolu_1')]],
    ['no assistant message', () => [user('Describe your most recent action')]],
  ])('a fork that answers with %s writes nothing and reschedules', async (_label, messages) => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    h.answers.reply = async () => forkResult(...messages())
    start(h)
    await h.tick()
    expect(h.forks).toHaveLength(1)
    expect(h.written).toEqual([])
    expect(h.timers).toHaveLength(2)
  })

  test('the previous summary is carried into the next tick prompt, past a tick with no text', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    start(h)
    await h.tick()
    // The transcript grows between ticks: an unchanged one is not forked again.
    grow(h, assistant('Opening validate.ts'))
    h.answers.reply = async () => forkResult(assistant('   '))
    await h.tick()
    grow(h, user('and the tests'))
    await h.tick()

    // Each tick reads the transcript again.
    expect(h.reads).toHaveLength(3)
    const carried = 'Previous: "Reading runAgent.ts" — say something NEW.'
    expect(promptText(h.forks[0]!)).not.toContain('Previous:')
    expect(promptText(h.forks[1]!)).toContain(carried)
    expect(promptText(h.forks[2]!)).toContain(carried)
  })

  test('a fork that throws is logged and the timer is still rescheduled', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    const failure = new Error('fork failed')
    h.answers.reply = async () => {
      throw failure
    }
    start(h)
    await h.tick()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(failure)
    expect(h.written).toEqual([])
    expect(h.timers).toHaveLength(2)
    expect(h.timers[1]!.cancelled).toBe(false)
  })

  test('a rejection that is not an Error is dropped without a log line, and still rescheduled', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    h.answers.reply = async () => {
      throw 'fork failed'
    }
    start(h)
    await h.tick()
    expect(logError).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(2)
  })

  test('the next timer is armed when the fork settles, not when it starts', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    const reply = deferred<ForkResult>()
    h.answers.reply = () => reply.promise
    start(h)
    const running = h.tick()
    await h.forkStarted
    expect(h.timers).toHaveLength(1)
    reply.resolve(forkResult(assistant('Running auth module tests')))
    await running
    expect(h.timers).toHaveLength(2)
  })

  test('stop() cancels the pending timer and schedules nothing after it', () => {
    const h = harness()
    const { stop } = start(h)
    stop()
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]!.cancelled).toBe(true)
  })

  test('a tick that fires after stop() does nothing', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    const { stop } = start(h)
    stop()
    await h.tick()
    expect(h.reads).toEqual([])
    expect(h.forks).toEqual([])
    expect(h.timers).toHaveLength(1)
  })

  test('stop() aborts an in-flight fork; its answer is dropped and nothing is rescheduled', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    const reply = deferred<ForkResult>()
    h.answers.reply = () => reply.promise
    const { stop } = start(h)
    const running = h.tick()
    const fork = await h.forkStarted
    const signal = fork.overrides?.abortController?.signal
    expect(signal?.aborted).toBe(false)

    stop()
    expect(signal?.aborted).toBe(true)
    reply.resolve(forkResult(assistant('Reading runAgent.ts')))
    await running
    expect(h.written).toEqual([])
    expect(h.timers).toHaveLength(1)
  })

  test('a fork that rejects because stop() aborted it is not logged', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    h.answers.reply = params =>
      new Promise((_resolve, reject) => {
        params.overrides?.abortController?.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        )
      })
    const { stop } = start(h)
    const running = h.tick()
    await h.forkStarted
    stop()
    await running
    expect(logError).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(1)
  })

  test('forkContextMessages passed at start are not pinned: the tick sends the transcript', async () => {
    const h = harness()
    const atStart = [user('PINNED-AT-START')]
    const current = threeMessages()
    h.answers.transcript = { messages: current }
    start(h, cacheSafeParams(atStart))
    await h.tick()
    expect(h.forks[0]!.cacheSafeParams.forkContextMessages).toEqual(current)
    expect(JSON.stringify(h.forks[0]!.cacheSafeParams)).not.toContain('PINNED-AT-START')
  })
})

describe('a transcript that has not grown', () => {
  test('a tick whose transcript has not grown does not fork again', async () => {
    const h = harness()
    const messages = threeMessages()
    h.answers.transcript = { messages }
    start(h)
    await h.tick()
    // A second read of the same file: other arrays, the same last uuid.
    h.answers.transcript = { messages: [...messages] }
    await h.tick()

    expect(h.reads).toHaveLength(2)
    expect(h.forks).toHaveLength(1)
    expect(h.written).toHaveLength(1)
    // The skipped tick still rearms the timer.
    expect(h.timers.map(t => t.ms)).toEqual([30_000, 30_000, 30_000])
    expect(h.timers.at(-1)!.cancelled).toBe(false)
  })

  test('a new message after a skipped tick is summarized', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    start(h)
    await h.tick()
    await h.tick()
    expect(h.forks).toHaveLength(1)

    const next = assistant('Opening validate.ts')
    grow(h, next)
    await h.tick()
    expect(h.forks).toHaveLength(2)
    expect(h.forks[1]!.cacheSafeParams.forkContextMessages.at(-1)).toEqual(next)
    expect(promptText(h.forks[1]!)).toContain('Previous: "Reading runAgent.ts"')
  })

  test('the key is the last message, not the length', async () => {
    const h = harness()
    const messages = threeMessages()
    h.answers.transcript = { messages }
    start(h)
    await h.tick()
    // As long as before, ending on another message.
    h.answers.transcript = { messages: [...messages.slice(0, -1), user('try the other file')] }
    await h.tick()
    expect(h.forks).toHaveLength(2)
  })

  test('a tick that threw is retried on the same transcript', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    h.answers.reply = async () => {
      throw new Error('fork failed')
    }
    start(h)
    await h.tick()
    h.answers.reply = async () => forkResult(assistant('Reading runAgent.ts'))
    await h.tick()
    expect(h.forks).toHaveLength(2)
    expect(h.written.map(w => w.summary)).toEqual(['Reading runAgent.ts'])
  })

  test('a tick that answered with no text is not asked again on the same transcript', async () => {
    const h = harness()
    h.answers.transcript = { messages: threeMessages() }
    h.answers.reply = async () => forkResult(assistant('   '))
    start(h)
    await h.tick()
    await h.tick()
    expect(h.forks).toHaveLength(1)
    expect(h.timers).toHaveLength(3)
  })
})

describe('periodicSummaryEnabled', () => {
  const off = { coordinator: false, sdkAsked: false, env: undefined }

  test('off with no coordinator, no SDK request and no switch', () => {
    expect(periodicSummaryEnabled(off)).toBe(false)
  })

  test.each([
    ['coordinator mode', { coordinator: true }],
    ['an SDK that asked for progress summaries', { sdkAsked: true }],
    ['CLAUDIN_AGENT_SUMMARY=1', { env: '1' }],
  ])('on under %s', (_label, on) => {
    expect(periodicSummaryEnabled({ ...off, ...on })).toBe(true)
  })

  test.each(['0', ''])('CLAUDIN_AGENT_SUMMARY=%p leaves it off', env => {
    expect(periodicSummaryEnabled({ ...off, env })).toBe(false)
  })
})

describe('the periodic summary gate', () => {
  test('in the default TUI start arms no timer and forks nothing', async () => {
    const h = harness({ enabled: () => false })
    h.answers.transcript = { messages: threeMessages() }
    const { stop } = start(h)
    expect(h.timers).toEqual([])
    expect(h.reads).toEqual([])
    expect(h.forks).toEqual([])
    expect(() => stop()).not.toThrow()
    expect(h.timers).toEqual([])
  })

  // The gate production passes: the session's SDK flag and the env switch.
  // Coordinator mode is a build flag, off under `bun test`.
  describe('as production wires it', () => {
    let priorEnv: string | undefined
    let priorSdk: boolean

    beforeEach(() => {
      priorEnv = process.env.CLAUDIN_AGENT_SUMMARY
      priorSdk = getSdkAgentProgressSummariesEnabled()
      delete process.env.CLAUDIN_AGENT_SUMMARY
      setSdkAgentProgressSummariesEnabled(false)
    })

    afterEach(() => {
      if (priorEnv === undefined) delete process.env.CLAUDIN_AGENT_SUMMARY
      else process.env.CLAUDIN_AGENT_SUMMARY = priorEnv
      setSdkAgentProgressSummariesEnabled(priorSdk)
    })

    const startWired = () => {
      const h = harness({ enabled: defaultAgentSummaryDeps.enabled })
      start(h)
      return h
    }

    test('a session that asked for nothing arms no timer', () => {
      expect(startWired().timers).toEqual([])
    })

    test('CLAUDIN_AGENT_SUMMARY=1 arms it', () => {
      process.env.CLAUDIN_AGENT_SUMMARY = '1'
      expect(startWired().timers.map(t => t.ms)).toEqual([30_000])
    })

    test('CLAUDIN_AGENT_SUMMARY=0 does not', () => {
      process.env.CLAUDIN_AGENT_SUMMARY = '0'
      expect(startWired().timers).toEqual([])
    })

    test('an SDK that asked for progress summaries arms it', () => {
      setSdkAgentProgressSummariesEnabled(true)
      expect(startWired().timers.map(t => t.ms)).toEqual([30_000])
    })
  })
})

describe('summarizeAgentResult', () => {
  function forkFake(reply: (params: ForkParams) => Promise<ForkResult>) {
    const forks: ForkParams[] = []
    const started = deferred<ForkParams>()
    const deps: Pick<AgentSummaryDeps, 'runForkedAgent'> = {
      runForkedAgent: async params => {
        forks.push(params)
        started.resolve(params)
        return reply(params)
      },
    }
    return { deps, forks, started: started.promise }
  }

  const live = () => new AbortController().signal

  test('returns the trimmed text of the fork', async () => {
    const { deps } = forkFake(async () => forkResult(assistant('\n Touched validate.ts; tests pass. ')))
    const summary = await summarizeAgentResult(cacheSafeParams(), threeMessages(), live(), deps)
    expect(summary).toBe('Touched validate.ts; tests pass.')
  })

  test('forks the given messages, cleaned, under the agent_result_summary label', async () => {
    const { deps, forks } = forkFake(async () => forkResult(assistant('done')))
    const complete = threeMessages()
    const params = cacheSafeParams([user('PINNED-AT-START')])
    await summarizeAgentResult(params, [...complete, toolUse('toolu_pending')], live(), deps)

    expect(forks).toHaveLength(1)
    const [fork] = forks
    expect(fork!.cacheSafeParams.forkContextMessages).toEqual(complete)
    expect(fork!.cacheSafeParams.systemPrompt).toBe(params.systemPrompt)
    expect(fork!.forkLabel).toBe('agent_result_summary')
    expect(fork!.querySource).toBe('agent_summary')
    expect(fork!.skipTranscript).toBe(true)
    expect(fork!.skipCacheWrite).toBe(true)
    expect(promptText(fork!)).toContain('Produce a concise, actionable summary of your final result')
  })

  test.each([
    ['only an API error', () => [createAssistantAPIErrorMessage({ content: 'API Error: overloaded' })]],
    ['whitespace', () => [assistant('  ')]],
    ['no message', () => []],
  ])('returns null when the fork answers with %s', async (_label, messages) => {
    const { deps, forks } = forkFake(async () => forkResult(...messages()))
    expect(await summarizeAgentResult(cacheSafeParams(), threeMessages(), live(), deps)).toBeNull()
    expect(forks).toHaveLength(1)
  })

  test('returns null on a thrown fork, and logs it', async () => {
    const failure = new Error('fork failed')
    const { deps } = forkFake(async () => {
      throw failure
    })
    expect(await summarizeAgentResult(cacheSafeParams(), threeMessages(), live(), deps)).toBeNull()
    expect(logError).toHaveBeenCalledWith(failure)
  })

  test('a signal already aborted forks nothing', async () => {
    const { deps, forks } = forkFake(async () => forkResult(assistant('done')))
    const parent = new AbortController()
    parent.abort()
    expect(await summarizeAgentResult(cacheSafeParams(), threeMessages(), parent.signal, deps)).toBeNull()
    expect(forks).toEqual([])
  })

  test('no complete message forks nothing', async () => {
    const { deps, forks } = forkFake(async () => forkResult(assistant('done')))
    expect(await summarizeAgentResult(cacheSafeParams(), [toolUse('toolu_pending')], live(), deps)).toBeNull()
    expect(forks).toEqual([])
  })

  test('a parent abort during the fork aborts it, and its answer is dropped', async () => {
    const reply = deferred<ForkResult>()
    const { deps, started } = forkFake(() => reply.promise)
    const parent = new AbortController()
    const pending = summarizeAgentResult(cacheSafeParams(), threeMessages(), parent.signal, deps)
    const fork = await started
    expect(fork.overrides?.abortController?.signal.aborted).toBe(false)

    parent.abort()
    expect(fork.overrides?.abortController?.signal.aborted).toBe(true)
    reply.resolve(forkResult(assistant('done')))
    expect(await pending).toBeNull()
  })
})
