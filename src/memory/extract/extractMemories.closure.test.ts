import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'
import {
  drainPendingExtraction,
  executeExtractMemories,
  type ExtractMemoriesDeps,
  humanTurnsSince,
  initExtractMemories,
} from 'src/memory/extract/extractMemories.js'
import type { Message } from 'src/shared/types/message.js'
import { memoryCursorStore } from 'src/memory/extract/extractionCursor.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

// The extraction closure, driven end to end through its injected deps: the
// gates, the turn throttle, the skip after a main-agent memory write, the
// cursor, the trailing run and the drain. The fork is a fake runForkedAgent.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_EXTRACT_MEMORIES',
  'CLAUDIN_EXTRACT_MEMORIES_EVERY',
  'CLAUDIN_EXTRACT_MEMORIES_MODEL',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

const savedEnv = new Map<string, string | undefined>()
let savedProjectRoot: string
let root: string
let memDir: string

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  root = mkdtempSync(join(tmpdir(), 'extract-closure-'))
  mkdirSync(join(root, 'project', '.git'), { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  savedProjectRoot = getProjectRoot()
  setProjectRoot(join(root, 'project'))
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  memDir = getPrivateMemPath()
})

beforeEach(() => {
  delete process.env.CLAUDIN_EXTRACT_MEMORIES
  delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
  delete process.env.CLAUDIN_EXTRACT_MEMORIES_MODEL
  process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '2'
})

afterAll(() => {
  setProjectRoot(savedProjectRoot)
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

function writeTurn(filePath: string): Message {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id: `w-${filePath}`, name: FILE_WRITE_TOOL_NAME, input: { file_path: filePath, content: 'x' } }] as never,
  })
}

function conversation(...asks: string[]): Message[] {
  return asks.flatMap(ask => [createUserMessage({ content: ask }), createAssistantMessage({ content: `did ${ask}` })])
}

function contextOf(messages: Message[], agentId?: string): REPLHookContext {
  return {
    messages,
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext: { agentId },
  } as unknown as REPLHookContext
}

type Fork = Record<string, unknown> & { promptMessages: unknown[] }

// One store for the whole file, as the cursor file outlives a process: a
// re-init below is a restart of the same session.
const cursors = memoryCursorStore()
let turnActive = false

function fakeDeps(over: Partial<ExtractMemoriesDeps> & { written?: string[] } = {}) {
  const forks: Fork[] = []
  const deps: ExtractMemoriesDeps = {
    existingMemoryManifest: async () => '- existing.md',
    notifyMemorySaved: () => true,
    cursors,
    sessionId: () => 'session-1',
    isTurnActive: () => turnActive,
    runForkedAgent: (async (params: Fork) => {
      forks.push(params)
      return {
        messages: (over.written ?? []).map(writeTurn),
        totalUsage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
      }
    }) as unknown as ExtractMemoriesDeps['runForkedAgent'],
    ...over,
  }
  return { deps, forks }
}

const promptOf = (fork: Fork) => JSON.stringify(fork.promptMessages)

describe('the extraction gates', () => {
  test('a sub-agent, the killswitch and auto memory off never fork', async () => {
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    await executeExtractMemories(contextOf(conversation('a'), 'agent-1'))
    process.env.CLAUDIN_EXTRACT_MEMORIES = '0'
    await executeExtractMemories(contextOf(conversation('a')))
    delete process.env.CLAUDIN_EXTRACT_MEMORIES
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    await executeExtractMemories(contextOf(conversation('a')))
    expect(forks).toHaveLength(0)
  })
})

describe('an extraction', () => {
  test('waits for the turn interval, then reads the messages since the cursor', async () => {
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    const messages = conversation('a')
    await executeExtractMemories(contextOf(messages))
    expect(forks).toHaveLength(0)
    messages.push(...conversation('b'))
    await executeExtractMemories(contextOf(messages))
    expect(forks).toHaveLength(1)
    expect(promptOf(forks[0]!)).toContain('~4 messages')
    expect(promptOf(forks[0]!)).toContain('- existing.md')
    expect(forks[0]!.querySource).toBe('extract_memories')

    messages.push(...conversation('c'), ...conversation('d'))
    await executeExtractMemories(contextOf(messages))
    await executeExtractMemories(contextOf(messages))
    expect(forks).toHaveLength(2)
    expect(promptOf(forks[1]!)).toContain('~4 messages')
  })

  test('skips the range the main agent already saved a memory in', async () => {
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    const messages = [...conversation('a'), writeTurn(join(memDir, 'saved.md'))]
    await executeExtractMemories(contextOf(messages))
    expect(forks).toHaveLength(0)
    messages.push(...conversation('b'))
    await executeExtractMemories(contextOf(messages))
    expect(forks).toHaveLength(1)
    expect(promptOf(forks[0]!)).toContain('~2 messages')
  })

  test('reports what it saved, index aside, when notifyMemorySaved is on', async () => {
    const written = [join(memDir, 'new.md'), join(memDir, 'MEMORY.md')]
    const appended: unknown[] = []
    const { deps } = fakeDeps({ written })
    initExtractMemories(deps)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    await executeExtractMemories(contextOf(conversation('a')), m => appended.push(m))
    expect(appended).toHaveLength(1)
    expect(JSON.stringify(appended[0])).toContain('new.md')
    expect(JSON.stringify(appended[0])).not.toContain('MEMORY.md')

    const quiet: unknown[] = []
    initExtractMemories(fakeDeps({ written, notifyMemorySaved: () => false }).deps)
    await executeExtractMemories(contextOf(conversation('a')), m => quiet.push(m))
    expect(quiet).toHaveLength(0)
  })

  test('a failed fork keeps the cursor, so the next run reads those messages again', async () => {
    let fail = true
    const { deps, forks } = fakeDeps()
    const failing: ExtractMemoriesDeps = {
      ...deps,
      runForkedAgent: (async (params: Fork) => {
        if (fail) throw new Error('overloaded')
        return deps.runForkedAgent(params as never)
      }) as unknown as ExtractMemoriesDeps['runForkedAgent'],
    }
    initExtractMemories(failing)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    const messages = conversation('a')
    await executeExtractMemories(contextOf(messages))
    fail = false
    messages.push(...conversation('b'))
    await executeExtractMemories(contextOf(messages))
    expect(forks).toHaveLength(1)
    expect(promptOf(forks[0]!)).toContain('~4 messages')
  })

  test('a call during a run is stashed and runs once after it, past the throttle', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => {
      release = r
    })
    const { deps, forks } = fakeDeps()
    const slow: ExtractMemoriesDeps = {
      ...deps,
      runForkedAgent: (async (params: Fork) => {
        if (forks.length === 0) await gate
        return deps.runForkedAgent(params as never)
      }) as unknown as ExtractMemoriesDeps['runForkedAgent'],
    }
    initExtractMemories(slow)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    const messages = conversation('a')
    const first = executeExtractMemories(contextOf(messages))
    await Promise.resolve()
    await executeExtractMemories(contextOf([...messages, ...conversation('b')]))
    await executeExtractMemories(contextOf([...messages, ...conversation('b'), ...conversation('c')]))
    release()
    await first
    await drainPendingExtraction(1_000)
    expect(forks).toHaveLength(2)
    expect(promptOf(forks[1]!)).toContain('~4 messages')
  })

  test('the fresh-agent arm hands the fork an extract_memories agent type', async () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_MODEL = 'haiku'
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    await executeExtractMemories(
      contextOf(conversation('a')),
    )
    expect((forks[0]!.overrides as { agentType?: string }).agentType).toBe('extract_memories')
  })
})

// The cursor and the turn count used to live in the closure only, so a new
// process — a restart, a `--resume`, an in-process `/resume` that comes back —
// re-mined the session from its first message and restarted the count.
describe('an extraction across a restart', () => {
  test('reads only what came after the last extraction of this session', async () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    const first = fakeDeps()
    initExtractMemories(first.deps)
    const messages = conversation('a', 'b')
    await executeExtractMemories(contextOf(messages))
    expect(first.forks).toHaveLength(1)

    const second = fakeDeps()
    initExtractMemories(second.deps)
    messages.push(...conversation('c'))
    await executeExtractMemories(contextOf(messages))
    expect(promptOf(second.forks[0]!)).toContain('~2 messages')
  })

  test('counts the human turns since that extraction, not since the restart', async () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    const seeded = fakeDeps()
    initExtractMemories(seeded.deps)
    const messages = conversation('a')
    await executeExtractMemories(contextOf(messages))

    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '2'
    const before = fakeDeps()
    initExtractMemories(before.deps)
    messages.push(...conversation('b'))
    await executeExtractMemories(contextOf(messages))
    expect(before.forks).toHaveLength(0)

    const after = fakeDeps()
    initExtractMemories(after.deps)
    messages.push(...conversation('c'))
    await executeExtractMemories(contextOf(messages))
    expect(after.forks).toHaveLength(1)
  })
})

describe('the idle trigger', () => {
  const savedIdle = process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  beforeEach(() => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS = '20'
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '5'
    turnActive = false
  })
  afterAll(() => {
    if (savedIdle === undefined) delete process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS
    else process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS = savedIdle
    turnActive = false
  })

  test('a throttled turn is extracted once nothing else happens for a while', async () => {
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    await executeExtractMemories(contextOf(conversation('a', 'b')))
    expect(forks).toHaveLength(0)
    await sleep(60)
    await drainPendingExtraction(1_000)
    expect(forks).toHaveLength(1)
    expect(promptOf(forks[0]!)).toContain('~4 messages')
  })

  test('it waits while a turn runs, and a new prompt resets it', async () => {
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    turnActive = true
    await executeExtractMemories(contextOf(conversation('a')))
    await sleep(60)
    expect(forks).toHaveLength(0)
    turnActive = false
    process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS = '200'
    await executeExtractMemories(contextOf(conversation('a')))
    await sleep(40)
    await executeExtractMemories(contextOf(conversation('a', 'b')))
    await sleep(100)
    expect(forks).toHaveLength(0)
    await sleep(200)
    await drainPendingExtraction(1_000)
    expect(forks).toHaveLength(1)
  })

  test('a session with nothing new since its cursor arms nothing', async () => {
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    const messages = conversation('a')
    await executeExtractMemories(contextOf(messages))
    expect(forks).toHaveLength(1)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '5'
    await executeExtractMemories(contextOf(messages))
    await sleep(60)
    expect(forks).toHaveLength(1)
  })
})

describe('the cursor follows the session', () => {
  test('a switch to another session reads that one\'s cursor', async () => {
    let session = 'session-a'
    const { deps, forks } = fakeDeps({ sessionId: () => session })
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    initExtractMemories(deps)
    const a = conversation('a1', 'a2')
    await executeExtractMemories(contextOf(a))
    session = 'session-b'
    const b = conversation('b1')
    cursors.write('session-b', b[1]!.uuid)
    b.push(...conversation('b2'))
    await executeExtractMemories(contextOf(b))
    expect(promptOf(forks[1]!)).toContain('~2 messages')
  })

  test('humanTurnsSince counts prompts, not tool results, after the cursor', () => {
    const toolResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }], toolUseResult: 'x' })
    const messages = [...conversation('a'), toolResult, ...conversation('b', 'c')]
    expect(humanTurnsSince(messages, undefined)).toBe(3)
    expect(humanTurnsSince(messages, messages[1]!.uuid)).toBe(2)
    expect(humanTurnsSince(messages, 'gone')).toBe(3)
  })
})
