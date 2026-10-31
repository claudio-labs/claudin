import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'
import {
  createMemoryCanUseTool,
  drainPendingExtraction,
  executeExtractMemories,
  type ExtractMemoriesDeps,
  initExtractMemories,
} from 'src/memory/extract/extractMemories.js'
import type { Message } from 'src/shared/types/message.js'
import type { Tool } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
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

function fakeDeps(over: Partial<ExtractMemoriesDeps> & { written?: string[] } = {}) {
  const forks: Fork[] = []
  const deps: ExtractMemoriesDeps = {
    existingMemoryManifest: async () => '- existing.md',
    notifyMemorySaved: () => true,
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

describe('the fork gate', () => {
  const gate = createMemoryCanUseTool()
  const call = (tool: Tool, input: Record<string, unknown>) => gate(tool, input, null as never, null as never, 'toolu_1')

  test('reads are free, a shell command only when read-only', async () => {
    expect((await call({ name: FILE_READ_TOOL_NAME } as Tool, { file_path: '/etc/hosts' })).behavior).toBe('allow')
    const bash = {
      name: BASH_TOOL_NAME,
      inputSchema: { safeParse: (input: unknown) => ({ success: true, data: input }) },
      isReadOnly: (input: { command: string }) => input.command.startsWith('ls'),
    } as unknown as Tool
    expect((await call(bash, { command: 'ls -la' })).behavior).toBe('allow')
    const denied = await call(bash, { command: 'rm -rf x' })
    expect(denied.behavior).toBe('deny')
    expect((denied as { message: string }).message).toContain('read-only shell commands')
  })
})
