import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { memoryScopeOf } from 'src/memory/memdir/memoryDirs.js'
import {
  drainPendingExtraction,
  executeExtractMemories,
  type ExtractMemoriesDeps,
  initExtractMemories,
  prunePatchProblem,
} from 'src/memory/extract/extractMemories.js'
import { memoryCursorStore } from 'src/memory/extract/extractionCursor.js'
import type { Message } from 'src/shared/types/message.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { runApplyPatch } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { expandPath } from 'src/shared/fs/path.js'

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_EXTRACT_MEMORIES',
  'CLAUDIN_EXTRACT_MEMORIES_EVERY',
  'CLAUDIN_EXTRACT_MEMORIES_IDLE_MS',
  'CLAUDIN_EXTRACT_MEMORIES_MODEL',
  'CLAUDIN_PATCH_ALL_OR_NOTHING',
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

describe('the dream Patch gate', () => {
  function makeContext(): ToolUseContext {
    const toolPermissionContext = getEmptyToolPermissionContext()
    return {
      abortController: new AbortController(),
      readFileState: new FileStateCache(100, 10_000_000),
      updateFileHistoryState: () => {},
      agentId: undefined,
      getAppState: () => ({ toolPermissionContext }),
    } as unknown as ToolUseContext
  }
  const markRead = (ctx: ToolUseContext, p: string) =>
    ctx.readFileState.set(p, { content: readFileSync(p, 'utf8'), timestamp: getFileModificationTime(p), offset: undefined, limit: undefined })

  test('a private delete approved for its survivor is not applied when the survivor write fails', async () => {
    const copy = join(memDir, 'copy.md')
    const survivor = join(memDir, 'survivor.md')
    writeFileSync(copy, '---\nname: copy\ndescription: d\ntype: project\n---\nThe only record of fact X.\n')
    writeFileSync(survivor, '---\nname: survivor\ndescription: d\ntype: project\n---\nFact Y.\n')
    const patchText = [
      '*** Begin Patch',
      `*** Update File: ${survivor}`,
      '@@',
      ' Fact Y, as the model remembered it.',
      '+The only record of fact X.',
      `*** Delete File: ${copy}`,
      '*** End Patch',
    ].join('\n')
    expect(prunePatchProblem(patchText, ['global'])).toBeNull() // the gate approves: the survivor is "written"
    const ctx = makeContext()
    markRead(ctx, copy)
    markRead(ctx, survivor)
    await runApplyPatch({ patchText }, ctx, randomUUID()).catch(() => undefined)
    // The merge did not land; the private copy (no git history) must survive.
    expect(readFileSync(survivor, 'utf8')).not.toContain('The only record of fact X.') // the survivor write failed
    expect(existsSync(copy)).toBe(true)
  })

  test('the gate judges a `~` path where the tool will write it', () => {
    const cwd = join(root, 'project')
    const target = join(memDir, 'team', 'old-note.md')
    const path = `~/${relative(join(cwd, '~'), target)}`
    // A gate that resolves `~` as a directory under cwd sees a team memory,
    // while ApplyPatch (expandPath) deletes this path, outside every memory
    // dir: the gate must judge the path the tool will write
    expect(prunePatchProblem(['*** Begin Patch', `*** Delete File: ${path}`, '*** End Patch'].join('\n'), ['global'], cwd)).not.toBeNull()
    expect(memoryScopeOf(expandPath(path, cwd))).toBeNull()
  })
})
