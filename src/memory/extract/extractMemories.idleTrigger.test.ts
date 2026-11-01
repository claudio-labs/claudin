import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
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
  initExtractMemories,
} from 'src/memory/extract/extractMemories.js'
import { memoryCursorStore } from 'src/memory/extract/extractionCursor.js'
import type { Message } from 'src/shared/types/message.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_EXTRACT_MEMORIES',
  'CLAUDIN_EXTRACT_MEMORIES_EVERY',
  'CLAUDIN_EXTRACT_MEMORIES_IDLE_MS',
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
  root = mkdtempSync(join(tmpdir(), 'extract-review-'))
  mkdirSync(join(root, 'project', '.git'), { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  savedProjectRoot = getProjectRoot()
  setProjectRoot(join(root, 'project'))
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  memDir = getPrivateMemPath()
  mkdirSync(join(memDir, 'team'), { recursive: true })
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function writeTurn(filePath: string): Message {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id: `w-${randomUUID()}`, name: FILE_WRITE_TOOL_NAME, input: { file_path: filePath, content: 'x' } }] as never,
  })
}

function conversation(...asks: string[]): Message[] {
  return asks.flatMap(ask => [createUserMessage({ content: ask }), createAssistantMessage({ content: `did ${ask}` })])
}

function contextOf(messages: Message[]): REPLHookContext {
  return { messages, systemPrompt: [], userContext: {}, systemContext: {}, toolUseContext: {} } as unknown as REPLHookContext
}

type Fork = Record<string, unknown> & { promptMessages: unknown[] }

function fakeDeps(over: Partial<ExtractMemoriesDeps> = {}) {
  const forks: Fork[] = []
  const deps: ExtractMemoriesDeps = {
    existingMemoryManifest: async () => '- existing.md',
    notifyMemorySaved: () => false,
    cursors: memoryCursorStore(),
    sessionId: () => 'session-1',
    isTurnActive: () => false,
    runForkedAgent: (async (params: Fork) => {
      forks.push(params)
      return { messages: [], totalUsage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } }
    }) as unknown as ExtractMemoriesDeps['runForkedAgent'],
    ...over,
  }
  return { deps, forks }
}

// Found by the 2026-10-31 review round, each red before its fix.
describe('the idle trigger', () => {
  beforeEach(() => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS = '20'
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '5'
  })

  test('a turn where the main agent saved a memory disarms the idle timer of the turn before', async () => {
    const { deps, forks } = fakeDeps()
    initExtractMemories(deps)
    const first = conversation('a')
    await executeExtractMemories(contextOf(first)) // throttled: arms the idle timer on `first`
    const second = [...first, ...conversation('b'), writeTurn(join(memDir, 'saved.md'))]
    await executeExtractMemories(contextOf(second)) // main agent wrote memory: cursor -> end of `second`
    expect(deps.cursors.read('session-1')).toBe(second.at(-1)!.uuid)
    await sleep(80)
    await drainPendingExtraction(1_000)
    // Nothing after the cursor is unextracted, so no fork should run, and the cursor must not move back.
    expect(forks).toHaveLength(0)
    expect(deps.cursors.read('session-1')).toBe(second.at(-1)!.uuid)
  })

  test('an idle run after a session switch keeps each session cursor its own', async () => {
    let session = 'session-a'
    const { deps, forks } = fakeDeps({ sessionId: () => session })
    initExtractMemories(deps)
    const a = conversation('a1', 'a2')
    await executeExtractMemories(contextOf(a)) // throttled: arms the timer on session A's context
    session = 'session-b' // in-process /resume or /clear
    deps.cursors.write('session-b', 'b-cursor')
    await sleep(80)
    await drainPendingExtraction(1_000)
    expect(forks).toHaveLength(1)
    // The run extracted session A's messages: A's cursor should move, B's must be left alone.
    expect(deps.cursors.read('session-b')).toBe('b-cursor')
    expect(deps.cursors.read('session-a')).toBe(a.at(-1)!.uuid)
  })
})
