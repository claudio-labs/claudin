import { beforeEach, describe, expect, test } from 'bun:test'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  type AutoDreamDeps,
  executeAutoDream,
  initAutoDream,
} from 'src/memory/autoDream/autoDream.js'
import { isDreamTask } from 'src/agent/tasks/DreamTask/DreamTask.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

// The auto-dream runner, driven end to end through its injected deps: the
// gates in their order, the lock, the fork and what the task and transcript
// show afterwards. No mock.module — the fork is a fake runForkedAgent.

type AnyState = { tasks: Record<string, unknown> }

function harness() {
  let state: AnyState = { tasks: {} }
  const appended: unknown[] = []
  const toolUseContext = {
    setAppState: (update: (prev: AnyState) => AnyState) => {
      state = update(state)
    },
    getAppState: () => state,
  }
  const context = {
    messages: [],
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext,
  } as unknown as REPLHookContext
  const dreams = () => Object.values(state.tasks).filter(isDreamTask)
  return { context, appended, append: (m: unknown) => appended.push(m), dreams }
}

const FIVE_SESSIONS = ['s1', 's2', 's3', 's4', 's5']

function assistant(content: unknown[]) {
  return { type: 'assistant', message: { content } }
}

function fakeDeps(over: Partial<AutoDreamDeps> = {}) {
  const calls = { read: 0, list: 0, acquire: 0, rollback: [] as number[], forks: [] as Record<string, unknown>[] }
  const deps: AutoDreamDeps = {
    isGateOpen: () => true,
    readLastConsolidatedAt: async () => {
      calls.read++
      return 0
    },
    listSessionsTouchedSince: async () => {
      calls.list++
      return [...FIVE_SESSIONS]
    },
    tryAcquireConsolidationLock: async () => {
      calls.acquire++
      return 123
    },
    rollbackConsolidationLock: async (mtime: number) => {
      calls.rollback.push(mtime)
    },
    collectDreamDigest: async () => 'DIGEST-MARKER',
    runForkedAgent: (async (params: Record<string, unknown>) => {
      calls.forks.push(params)
      const onMessage = params.onMessage as (m: unknown) => void
      onMessage({ type: 'user', message: { content: [] } })
      onMessage(
        assistant([
          { type: 'text', text: 'merging two files' },
          { type: 'tool_use', name: FILE_EDIT_TOOL_NAME, input: { file_path: '/mem/a.md' } },
          { type: 'tool_use', name: FILE_WRITE_TOOL_NAME, input: { file_path: '/mem/b.md' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/mem/c.md' } },
        ]),
      )
      return { messages: [], totalUsage: { cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } }
    }) as unknown as AutoDreamDeps['runForkedAgent'],
    notifyMemorySaved: () => true,
    ...over,
  }
  return { deps, calls }
}

async function run(deps: AutoDreamDeps, h = harness()) {
  initAutoDream(deps)
  await executeAutoDream(h.context, h.append as never)
  return h
}

describe('auto-dream gates', () => {
  beforeEach(() => initAutoDream(fakeDeps().deps))

  test('a closed gate reads nothing', async () => {
    const { deps, calls } = fakeDeps({ isGateOpen: () => false })
    await run(deps)
    expect(calls.read).toBe(0)
  })

  test('a recent consolidation stops it before the session scan', async () => {
    const { deps, calls } = fakeDeps({
      readLastConsolidatedAt: async () => Date.now() - 60_000,
    })
    await run(deps)
    expect(calls.list).toBe(0)
  })

  test('an unreadable lock stops it', async () => {
    const { deps, calls } = fakeDeps({
      readLastConsolidatedAt: async () => {
        throw new Error('EACCES')
      },
    })
    await run(deps)
    expect(calls.list).toBe(0)
  })

  test('fewer than five other sessions stop it, and the next scan waits ten minutes', async () => {
    const { deps, calls } = fakeDeps({
      listSessionsTouchedSince: async () => {
        calls.list++
        return ['s1', 's2', 's3', 's4', getSessionId()]
      },
    })
    const h = harness()
    initAutoDream(deps)
    await executeAutoDream(h.context, h.append as never)
    await executeAutoDream(h.context, h.append as never)
    expect(calls.list).toBe(1)
    expect(calls.acquire).toBe(0)
  })

  test('a failed session scan stops it', async () => {
    const { deps, calls } = fakeDeps({
      listSessionsTouchedSince: async () => {
        throw new Error('ENOENT')
      },
    })
    await run(deps)
    expect(calls.acquire).toBe(0)
  })

  test('a held or failing lock stops it before the fork', async () => {
    const held = fakeDeps({ tryAcquireConsolidationLock: async () => null })
    await run(held.deps)
    expect(held.calls.forks).toHaveLength(0)

    const failing = fakeDeps({
      tryAcquireConsolidationLock: async () => {
        throw new Error('EEXIST')
      },
    })
    await run(failing.deps)
    expect(failing.calls.forks).toHaveLength(0)
  })
})

describe('an auto-dream run', () => {
  test('forks with the digest and the session list, then completes its task', async () => {
    const { deps, calls } = fakeDeps()
    const h = await run(deps)

    expect(calls.forks).toHaveLength(1)
    const fork = calls.forks[0]!
    expect(fork.querySource).toBe('auto_dream')
    expect(fork.skipTranscript).toBe(true)
    const prompt = JSON.stringify(fork.promptMessages)
    expect(prompt).toContain('DIGEST-MARKER')
    expect(prompt).toContain('Sessions since last consolidation (5)')
    expect(prompt).toContain('read-only commands')

    const [dream] = h.dreams()
    expect(dream?.status).toBe('completed')
    expect(dream?.filesTouched).toEqual(['/mem/a.md', '/mem/b.md'])
    expect(dream?.turns.at(-1)).toEqual({ text: 'merging two files', toolUseCount: 3 })
    expect(calls.rollback).toEqual([])
  })

  test('says "Improved" in the transcript only when notifyMemorySaved is on', async () => {
    const on = await run(fakeDeps().deps)
    expect(on.appended).toHaveLength(1)
    expect((on.appended[0] as { verb?: string }).verb).toBe('Improved')

    const off = await run(fakeDeps({ notifyMemorySaved: () => false }).deps)
    expect(off.appended).toHaveLength(0)
  })

  test('a failed fork fails the task and rewinds the lock', async () => {
    const { deps, calls } = fakeDeps({
      runForkedAgent: (async () => {
        throw new Error('overloaded')
      }) as unknown as AutoDreamDeps['runForkedAgent'],
    })
    const h = await run(deps)
    expect(h.dreams()[0]?.status).toBe('failed')
    expect(calls.rollback).toEqual([123])
  })

  test('a fork the user killed leaves the lock to the kill', async () => {
    const { deps, calls } = fakeDeps({
      runForkedAgent: (async (params: { overrides: { abortController: AbortController } }) => {
        params.overrides.abortController.abort()
        throw new Error('aborted')
      }) as unknown as AutoDreamDeps['runForkedAgent'],
    })
    const h = await run(deps)
    expect(calls.rollback).toEqual([])
    expect(h.dreams()[0]?.status).toBe('running')
  })
})
