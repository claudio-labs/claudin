import { randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { runApplyPatch } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'

// A memory index is in context from the session's first turn, so an in-place
// write to it (Edit, Patch) does not need a Read first — the 30-day census
// found Edits of a MEMORY.md refused as never read, each resubmitted as is.
// A whole-file Write keeps the gate: the index in context may be the fitted
// one, shortened to its cap. Any other memory file keeps the rule too.
const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_FILE_CHECKPOINTING', 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE'] as const
const savedEnv = new Map<string, string | undefined>()
let savedProjectRoot: string
let root: string
let memDir: string
let ctx: ToolUseContext

// A curly apostrophe on disk and a straight one in old_string: not an exact
// match, which is what a never-read file needs, but Edit's quote
// normalization applies it once the file counts as read.
const INDEX = '- [User’s language](user.md) — writes in PT-BR\n- [Build](build.md) — always build\n'
const STRAIGHT = "- [User's language](user.md) — writes in PT-BR"

beforeAll(() => {
  setOriginalFsImplementation()
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
  root = mkdtempSync(join(tmpdir(), 'index-read-gate-'))
  mkdirSync(join(root, 'project', '.git'), { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  savedProjectRoot = getProjectRoot()
  setProjectRoot(join(root, 'project'))
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  memDir = getPrivateMemPath()
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

beforeEach(() => {
  const toolPermissionContext = getEmptyToolPermissionContext()
  ctx = {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    updateFileHistoryState: () => {},
    agentId: undefined,
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
  writeFileSync(join(memDir, 'MEMORY.md'), INDEX)
  writeFileSync(join(memDir, 'user.md'), INDEX)
})

describe('a memory index counts as read for an in-place write', () => {
  test('Edit applies to a MEMORY.md never read', async () => {
    const index = join(memDir, 'MEMORY.md')
    const input = { file_path: index, old_string: STRAIGHT, new_string: '- [Language](user.md) — PT-BR' }
    expect((await FileEditTool.validateInput(input, ctx)).result).toBe(true)
    await FileEditTool.call(input, ctx, undefined as never, { uuid: randomUUID() } as never)
    expect(readFileSync(index, 'utf8')).toContain('- [Language](user.md) — PT-BR')
  })

  test('Patch applies to a MEMORY.md never read', async () => {
    const index = join(memDir, 'MEMORY.md')
    const patchText = `*** Begin Patch\n*** Update File: ${index}\n@@\n-${STRAIGHT}\n+- [Language](user.md) — PT-BR\n*** End Patch`
    const { output } = await runApplyPatch({ patchText }, ctx, randomUUID())
    expect(output.notApplied ?? []).toEqual([])
    expect(readFileSync(index, 'utf8')).toContain('- [Language](user.md) — PT-BR')
  })

  test('another memory file never read is still refused', async () => {
    const input = { file_path: join(memDir, 'user.md'), old_string: STRAIGHT, new_string: 'x' }
    const verdict = await FileEditTool.validateInput(input, ctx)
    expect(verdict.result).toBe(false)
  })

  test('a whole-file Write to a MEMORY.md never read is still refused', async () => {
    const verdict = await FileWriteTool.validateInput(
      { file_path: join(memDir, 'MEMORY.md'), content: '- [Only](only.md) — one\n' },
      ctx,
    )
    expect(verdict.result).toBe(false)
  })
})
