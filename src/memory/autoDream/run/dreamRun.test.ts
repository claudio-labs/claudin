/**
 * One dream driven through its dependencies: a scripted fork, the real task
 * store over an in-memory app state, and a recorded rollback.
 */
import { describe, expect, test } from 'bun:test'

import type { ForkedAgentParams, ForkedAgentResult } from 'src/agent/coordinator/forkedAgent.js'
import { type DreamTaskState } from 'src/agent/tasks/DreamTask/DreamTask.js'
import {
  type DreamOutcome,
  type DreamRunDeps,
  productionTaskStore,
  runDream,
} from 'src/memory/autoDream/run/dreamRun.js'
import {
  assistantCalls,
  forkReturns,
  humanSays,
  toolAnswers,
  turnEnded,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import { readDreamTurn } from 'src/memory/autoDream/run/forkMessages.js'
import { addDreamTurn } from 'src/agent/tasks/DreamTask/DreamTask.js'
import type { Message } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

const MEMORY = '/home/dev/.claudin/memory/'
const write = (path: string, id: string) => ({ tool: FILE_WRITE_TOOL_NAME, input: { file_path: path }, id })

function scene(fork: (request: ForkedAgentParams) => Promise<ForkedAgentResult>) {
  let state = { tasks: {} } as unknown as AppState
  const notices: unknown[] = []
  const rollbacks: number[] = []
  const context = turnEnded([humanSays('ship it')], {
    getAppState: () => state,
    setAppState: update => {
      state = update(state)
    },
  })
  const deps: DreamRunDeps = {
    runFork: fork,
    digest: async () => '## Decision sources',
    tasks: productionTaskStore,
    prompt: extra => `the dream\n\n${extra}`,
    canUseTool: () => async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    watch: (taskId, setAppState) => message => {
      const turn = readDreamTurn(message, path => path.startsWith(MEMORY))
      if (turn) addDreamTurn(taskId, turn, turn.touchedPaths, setAppState)
    },
    rollback: async priorMtime => {
      rollbacks.push(priorMtime)
    },
    announceSaves: () => true,
  }
  const run = (): Promise<DreamOutcome> =>
    runDream(
      { context, appendSystemMessage: m => notices.push(m), sessionIds: ['s1'], lastConsolidatedAt: 5, priorMtime: 5 },
      deps,
    )
  const task = () => Object.values(state.tasks ?? {})[0] as DreamTaskState
  return { run, notices, rollbacks, task }
}

/** A fork that streams `messages` through the watcher and returns them. */
const streams = (...messages: Message[]) => async (request: ForkedAgentParams) => {
  for (const message of messages) request.onMessage?.(message)
  return forkReturns(messages)
}

describe('runDream, the saved-memory notice (finding 2)', () => {
  test('lists only memory files whose write was not refused or failed', async () => {
    const kept = `${MEMORY}kept.md`
    const refused = `${MEMORY}refused.md`
    const { run, notices, task } = scene(
      streams(
        assistantCalls(write(kept, 'w1'), write('/work/shop/notes.md', 'w2'), write(refused, 'w3')),
        toolAnswers('w1', 'written', false),
        toolAnswers('w2', 'denied: outside the memory directory', true),
        toolAnswers('w3', 'denied', true),
        assistantCalls(write(`${MEMORY}MEMORY.md`, 'w4')),
      ),
    )
    expect(await run()).toBe('completed')
    expect(task().filesTouched).toEqual([kept, refused, `${MEMORY}MEMORY.md`])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ subtype: 'memory_saved', writtenPaths: [kept, `${MEMORY}MEMORY.md`], verb: 'Improved' })
  })

  test('no notice when every write failed', async () => {
    const { run, notices } = scene(
      streams(assistantCalls(write(`${MEMORY}a.md`, 'x1')), toolAnswers('x1', 'denied', true)),
    )
    expect(await run()).toBe('completed')
    expect(notices).toEqual([])
  })
})

describe('runDream, how it settles', () => {
  test('a failing fork fails the task and rolls the lock back; an aborted one leaves both', async () => {
    const failing = scene(async () => {
      throw new Error('the model went away')
    })
    expect(await failing.run()).toBe('failed')
    expect(failing.task().status).toBe('failed')
    expect(failing.rollbacks).toEqual([5])

    const aborted = scene(async request => {
      request.overrides?.abortController?.abort()
      throw new Error('aborted')
    })
    expect(await aborted.run()).toBe('abortedElsewhere')
    expect(aborted.task().status).toBe('running')
    expect(aborted.rollbacks).toEqual([])
  })

  test('the prompt carries the run context, the digest last', async () => {
    let prompt = ''
    const { run } = scene(async request => {
      prompt = String((request.promptMessages[0] as { message: { content: unknown } }).message.content)
      return forkReturns([])
    })
    await run()
    expect(prompt.startsWith('the dream\n\n')).toBe(true)
    expect(prompt).toContain('(1):**\n- s1\n')
    expect(prompt.endsWith('## Decision sources')).toBe(true)
  })
})
