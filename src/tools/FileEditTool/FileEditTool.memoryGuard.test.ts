// The memory format guard (memoryFormatGuard.ts) through the real tools: one
// final file content gets one verdict, whichever tool writes it — Write,
// Edit (creating the file or changing it), Patch (Add, Update) and the staged
// rewrite. Placement (TYPE_SCOPES, `paths:` where a directory takes none) is
// judged when the file is new or changes its type, so a memory saved before a
// rule existed stays updatable in place by every tool. Pinned against a fresh
// git project and config home: the real ~/.claudin is never resolved.
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getPrivateMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { checkMemoryFileFormat } from 'src/memory/memdir/memoryFormatGuard.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { runApplyPatch } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { stageContentReplacement } from 'src/tools/shared/stagedWrite/stagedWrite.js'

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_GLOBAL_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

const savedEnv = new Map<string, string | undefined>()
let previousProjectRoot: string
let root: string
let globalDir: string
let privateDir: string
let ctx: ToolUseContext

beforeAll(() => {
  setOriginalFsImplementation()
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  root = mkdtempSync(join(tmpdir(), 'edit-memory-guard-'))
  mkdirSync(join(root, 'project', '.git'), { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  previousProjectRoot = getProjectRoot()
  setProjectRoot(join(root, 'project'))
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  globalDir = getGlobalMemPath()
  privateDir = getPrivateMemPath()
  mkdirSync(globalDir, { recursive: true })
  mkdirSync(getTeamMemPath(), { recursive: true })
})

afterAll(() => {
  setProjectRoot(previousProjectRoot)
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  const toolPermissionContext = getEmptyToolPermissionContext()
  ctx = {
    abortController: new AbortController(),
    readFileState: new FileStateCache(100, 10_000_000),
    updateFileHistoryState: () => {},
    agentId: undefined,
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
})

function memory(type: string, extra: string[] = [], description = 'how the user works'): string {
  return ['---', 'name: probe', `description: ${description}`, `type: ${type}`, ...extra, '---', 'Answer in pt-BR.', ''].join('\n')
}

/** The file as `before` (null: absent), marked fully read. */
function fresh(path: string, before: string | null): void {
  rmSync(path, { force: true })
  if (before === null) return
  writeFileSync(path, before)
  ctx.readFileState.set(path, {
    content: before,
    timestamp: getFileModificationTime(path),
    offset: undefined,
    limit: undefined,
  })
}

/** null when the tool lets the write through, else the guard's refusal. */
type Verdict = string | null

function guardRefusal(message: string): Verdict {
  if (!message.startsWith('Memory file not written')) throw new Error(`not a guard refusal: ${message}`)
  return message
}

async function viaWrite(path: string, after: string): Promise<Verdict> {
  const r = await FileWriteTool.validateInput!({ file_path: path, content: after }, ctx)
  return r.result ? null : guardRefusal(r.message)
}

async function viaEdit(path: string, oldString: string, newString: string): Promise<Verdict> {
  const r = await FileEditTool.validateInput!({ file_path: path, old_string: oldString, new_string: newString }, ctx)
  return r.result ? null : guardRefusal(r.message)
}

function patchText(header: string, oldText: string, newText: string): string {
  const lines = (text: string, mark: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n').map(l => `${mark}${l}`))
  return ['*** Begin Patch', header, ...(header.startsWith('*** Update') ? ['@@'] : []), ...lines(oldText, '-'), ...lines(newText, '+'), '*** End Patch'].join('\n')
}

async function viaPatch(text: string): Promise<Verdict> {
  try {
    await runApplyPatch({ patchText: text }, ctx, randomUUID())
    return null
  } catch (e) {
    return guardRefusal((e as Error).message)
  }
}

function viaStaged(path: string, after: string): Verdict {
  try {
    stageContentReplacement(path, after)
    return null
  } catch (e) {
    return guardRefusal((e as Error).message)
  }
}

/** Every tool's verdict on creating `path` as `after`. */
async function createVerdicts(path: string, after: string): Promise<Record<string, Verdict>> {
  const verdicts: Record<string, Verdict> = {}
  fresh(path, null)
  verdicts.write = await viaWrite(path, after)
  fresh(path, null)
  verdicts.editCreate = await viaEdit(path, '', after)
  fresh(path, null)
  verdicts.patchAdd = await viaPatch(patchText(`*** Add File: ${path}`, '', after))
  fresh(path, null)
  verdicts.pure = checkMemoryFileFormat(path, after)
  return verdicts
}

/** Every tool's verdict on turning `before` into `before` with `from` replaced by `to`. */
async function updateVerdicts(path: string, before: string, from: string, to: string): Promise<Record<string, Verdict>> {
  const after = before.replace(from, to)
  const verdicts: Record<string, Verdict> = {}
  fresh(path, before)
  verdicts.write = await viaWrite(path, after)
  fresh(path, before)
  verdicts.editExisting = await viaEdit(path, from, to)
  fresh(path, before)
  verdicts.patchUpdate = await viaPatch(patchText(`*** Update File: ${path}`, from, to))
  if (verdicts.patchUpdate === null) expect(readFileSync(path, 'utf8')).toBe(after)
  fresh(path, before)
  verdicts.staged = viaStaged(path, after)
  fresh(path, before)
  verdicts.pure = checkMemoryFileFormat(path, after)
  return verdicts
}

function expectAll(verdicts: Record<string, Verdict>, expected: 'pass' | string): void {
  for (const [tool, verdict] of Object.entries(verdicts)) {
    if (expected === 'pass') expect({ tool, verdict }).toEqual({ tool, verdict: null })
    else expect({ tool, refused: verdict?.includes(expected) ?? false }).toEqual({ tool, refused: true })
  }
  // One content, one verdict: the refusals are the same text
  expect(new Set(Object.values(verdicts)).size).toBe(1)
}

describe('one final content, one verdict — every tool', () => {
  test('a NEW `type: user` file in the private dir is sent to the global one', async () => {
    expectAll(await createVerdicts(join(privateDir, 'user-new.md'), memory('user')), `write it under \`${globalDir}\``)
  })

  test('a new feedback memory in the private dir passes', async () => {
    expectAll(await createVerdicts(join(privateDir, 'feedback-new.md'), memory('feedback')), 'pass')
  })

  test('a legacy private `type: user` file (saved before the global dir) is updated in place', async () => {
    const path = join(privateDir, 'user-legacy.md')
    expectAll(await updateVerdicts(path, memory('user'), 'Answer in pt-BR.', 'Answer in pt-BR, always.'), 'pass')
  })

  test('a private memory retyped to `user` is refused', async () => {
    const path = join(privateDir, 'feedback-retyped.md')
    expectAll(await updateVerdicts(path, memory('feedback'), 'type: feedback', 'type: user'), `write it under \`${globalDir}\``)
  })

  test('a global memory retyped to `project` is refused', async () => {
    const path = join(globalDir, 'feedback-retyped.md')
    expectAll(await updateVerdicts(path, memory('feedback'), 'type: feedback', 'type: project'), '`type: project` is')
  })

  test('a global memory whose body changes passes', async () => {
    const path = join(globalDir, 'feedback-body.md')
    expectAll(await updateVerdicts(path, memory('feedback'), 'Answer in pt-BR.', 'Answer in pt-BR, always.'), 'pass')
  })

  test('`paths:` added to an existing global memory is refused', async () => {
    const path = join(globalDir, 'feedback-paths.md')
    expectAll(
      await updateVerdicts(path, memory('feedback'), 'type: feedback', 'type: feedback\npaths:\n  - "src/**"'),
      'a global memory takes no `paths:`',
    )
  })

  test('completeness is asked of every update: a legacy file losing its description is refused', async () => {
    const path = join(privateDir, 'user-incomplete.md')
    expectAll(await updateVerdicts(path, memory('user'), 'description: how the user works', 'description: ""'), 'it lacks `description:`')
  })

  test('a file outside memory is never looked at', async () => {
    const path = join(root, 'project', 'notes.md')
    expectAll(await updateVerdicts(path, 'no frontmatter\n', 'no frontmatter', 'still none'), 'pass')
  })
})

describe('the Edit advice', () => {
  test('an Edit that creates a memory file gets the index-line note a Write gets', () => {
    const path = join(privateDir, 'feedback-unlisted.md')
    const input = { file_path: path, old_string: '', new_string: memory('feedback') }
    const edit = FileEditTool.advise!(input, ctx)?.message
    const write = FileWriteTool.advise!({ file_path: path, content: memory('feedback') }, ctx)?.message
    expect(edit).toContain('`feedback-unlisted.md` is not in the private memory index yet')
    expect(edit).toBe(write!)
  })

  test('an index line the same response writes counts', () => {
    const path = join(privateDir, 'feedback-listed.md')
    const input = { file_path: path, old_string: '', new_string: memory('feedback') }
    const sibling = { id: 't2', name: 'Write', input: { file_path: join(privateDir, 'MEMORY.md'), content: '- [Listed](feedback-listed.md) — hook\n' } }
    expect(FileEditTool.advise!(input, { ...ctx, responseToolUses: [sibling] })).toBeNull()
  })

  test('an Edit that changes an existing file, or a file outside memory, gets none', () => {
    expect(FileEditTool.advise!({ file_path: join(privateDir, 'feedback-x.md'), old_string: 'a', new_string: 'b' }, ctx)).toBeNull()
    expect(FileEditTool.advise!({ file_path: join(root, 'project', 'a.md'), old_string: '', new_string: 'x' }, ctx)).toBeNull()
  })
})

test('the fixture keeps the files it creates inside its own dirs', () => {
  expect(globalDir.startsWith(join(root, 'config'))).toBe(true)
  expect(privateDir.startsWith(join(root, 'project'))).toBe(true)
  expect(existsSync(join(privateDir, 'MEMORY.md'))).toBe(false)
})
