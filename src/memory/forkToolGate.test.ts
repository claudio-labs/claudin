import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { memoryScopeOf } from 'src/memory/memdir/memoryDirs.js'
import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { createMemoryCanUseTool, prunePatchProblem } from 'src/memory/forkToolGate.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { expandPath } from 'src/shared/fs/path.js'
import { runApplyPatch } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from 'src/tools/Tool.js'

// The background forks' tool gate, against a fresh git project and config
// home: what the extraction and the dream may run, and the dream's prune Patch.
const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_AUTO_MEMORY', 'CLAUDIN_PATCH_ALL_OR_NOTHING', 'CLAUDIN_SIMPLE', 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE'] as const

const savedEnv = new Map<string, string | undefined>()
let savedProjectRoot: string
let root: string
let memDir: string

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  root = mkdtempSync(join(tmpdir(), 'fork-tool-gate-'))
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

describe('a pruning Patch (the dream)', () => {
  const team = () => join(memDir, 'team')
  const global = () => join(root, 'config', 'memory')
  const patch = (...sections: string[]) => ['*** Begin Patch', ...sections, '*** End Patch'].join('\n')
  const del = (path: string) => `*** Delete File: ${path}`
  const update = (path: string, old: string, next: string[]) => [`*** Update File: ${path}`, '@@', ` ${old}`, ...next.map(l => `+${l}`)].join('\n')
  const problem = (text: unknown) => prunePatchProblem(text, ['global'])

  test('a team memory is deleted alone: git keeps it', () => {
    expect(problem(patch(del(join(team(), 'old-note.md'))))).toBeNull()
  })

  test('a private memory is deleted only beside the write of its survivor', () => {
    expect(problem(patch(del(join(memDir, 'copy.md'))))).toContain('only in the Patch that writes the memory it was merged into')
    expect(problem(patch(del(join(memDir, 'copy.md')), update(join(memDir, 'survivor.md'), 'fact', ['more'])))).toBeNull()
    expect(problem(patch(del(join(memDir, 'copy.md')), update(join(memDir, 'MEMORY.md'), '- [Copy](copy.md)', [])))).toContain(
      'only in the Patch that writes',
    )
  })

  test('the private copy of a global memory merges in one Patch that only adds to the global one', () => {
    expect(problem(patch(update(join(global(), 'user-language.md'), 'Answers in PT-BR.', ['Examples in TypeScript.']), del(join(memDir, 'copy.md'))))).toBeNull()
  })

  test('the global dir takes an Add or an Update that keeps its lines, nothing else', () => {
    expect(problem(patch(`*** Add File: ${join(global(), 'new.md')}`, '+fact'))).toBeNull()
    const rewrite = ['*** Update File: ' + join(global(), 'x.md'), '@@', '-old line', '+new line'].join('\n')
    expect(problem(patch(rewrite))).toContain('append-only')
    expect(problem(patch(del(join(global(), 'x.md'))))).toContain('append-only')
  })

  test('an index is never deleted, nothing outside memory is touched, and a broken Patch is refused', () => {
    expect(problem(patch(del(join(team(), 'MEMORY.md'))))).toContain('MEMORY.md is never deleted')
    expect(problem(patch(del(join(root, 'project', 'src.ts'))))).toContain('outside the memory dirs')
    expect(problem('not a patch')).toContain('does not parse')
    expect(problem(undefined)).toContain('patchText')
  })

  test('the extraction gate refuses a Patch; the dream gate takes a sound one', async () => {
    const tool = { name: 'Patch' } as unknown as Tool
    const input = { patchText: patch(del(join(team(), 'old-note.md'))) }
    expect((await createMemoryCanUseTool(['global'])(tool, input, null as never, null as never, 't')).behavior).toBe('deny')
    expect((await createMemoryCanUseTool(['global'], { patch: 'prune' })(tool, input, null as never, null as never, 't')).behavior).toBe('allow')
    const lone = { patchText: patch(del(join(memDir, 'copy.md'))) }
    expect((await createMemoryCanUseTool(['global'], { patch: 'prune' })(tool, lone, null as never, null as never, 't')).behavior).toBe('deny')
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

// Found by the 2026-10-31 review round, each red before its fix.
describe('the dream Patch gate, as the Patch tool applies it', () => {
  // The context the auto-dream's fork runs its Patch in (autoDream.ts overrides)
  function makeContext(): ToolUseContext {
    const toolPermissionContext = getEmptyToolPermissionContext()
    return {
      options: { patchAllOrNothing: true },
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
