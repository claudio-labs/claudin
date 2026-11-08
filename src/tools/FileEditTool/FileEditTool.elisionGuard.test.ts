// The elision guard (src/tools/shared/elisionGuard.ts) through the real
// tools: Edit, Write and Patch refuse new text carrying a placeholder comment
// the old text does not hold, before any permission prompt or write. Patch
// refuses only the file that carries it; the rest of the patch applies.
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { runApplyPatch, validateApplyPatchInput } from 'src/tools/ApplyPatchTool/applyPatch.js'

const ORIGINAL = 'export function a() {\n  return 1\n}\n\nexport function b() {\n  return 2\n}\n'
const ELIDED = 'export function a() {\n  return 10\n}\n\n// ... existing code ...\n'

const savedEnv = {
  checkpointing: process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING,
  guard: process.env.CLAUDIN_ELISION_GUARD,
}
let dir: string
let ctx: ToolUseContext

beforeAll(() => {
  setOriginalFsImplementation()
  process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
  dir = mkdtempSync(join(tmpdir(), 'elision-guard-'))
})

afterAll(() => {
  for (const [key, value] of [
    ['CLAUDIN_DISABLE_FILE_CHECKPOINTING', savedEnv.checkpointing],
    ['CLAUDIN_ELISION_GUARD', savedEnv.guard],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.CLAUDIN_ELISION_GUARD
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

/** `path` holding `content` (null: absent), marked fully read. */
function fresh(name: string, content: string | null): string {
  const path = join(dir, name)
  rmSync(path, { force: true })
  if (content === null) return path
  writeFileSync(path, content)
  ctx.readFileState.set(path, {
    content,
    timestamp: getFileModificationTime(path),
    offset: undefined,
    limit: undefined,
  })
  return path
}

describe('Edit', () => {
  test('refuses a new_string that turns code into a placeholder, naming the line, with error code 11', async () => {
    const path = fresh('edit.ts', ORIGINAL)
    const r = await FileEditTool.validateInput!(
      {
        file_path: path,
        old_string: '  return 2\n}',
        new_string: '  return 2\n}\n// ... existing code ...',
      },
      ctx,
    )
    expect(r).toEqual({
      result: false,
      message: expect.stringContaining('Edit refused: new_string line 3 is an elision placeholder:\n    // ... existing code ...\n'),
      errorCode: 11,
    })
  })

  test('lets through a placeholder already in old_string', async () => {
    const path = fresh('edit-kept.ts', `${ORIGINAL}// ... existing code ...\n`)
    const r = await FileEditTool.validateInput!(
      { file_path: path, old_string: '  return 2\n}\n// ... existing code ...', new_string: '  return 3\n}\n// ... existing code ...' },
      ctx,
    )
    expect(r.result).toBe(true)
  })

  test('refuses it on file creation too', async () => {
    const path = fresh('edit-new.ts', null)
    const r = await FileEditTool.validateInput!({ file_path: path, old_string: '', new_string: ELIDED }, ctx)
    expect(r.result).toBe(false)
    expect(r.result === false && r.errorCode).toBe(11)
  })

  test('CLAUDIN_ELISION_GUARD=0 lets it through', async () => {
    process.env.CLAUDIN_ELISION_GUARD = '0'
    const path = fresh('edit-off.ts', ORIGINAL)
    const r = await FileEditTool.validateInput!(
      { file_path: path, old_string: '  return 2\n}', new_string: '  // ...\n}' },
      ctx,
    )
    expect(r.result).toBe(true)
  })
})

describe('Write', () => {
  test('refuses content that elides part of the file, with error code 5', async () => {
    const path = fresh('write.ts', ORIGINAL)
    const r = await FileWriteTool.validateInput!({ file_path: path, content: ELIDED }, ctx)
    expect(r).toEqual({
      result: false,
      message: expect.stringContaining('Write refused: content line 5 is an elision placeholder:\n    // ... existing code ...\n'),
      errorCode: 5,
    })
  })

  test('refuses it in a new file', async () => {
    const path = fresh('write-new.py', null)
    const r = await FileWriteTool.validateInput!({ file_path: path, content: 'def a():\n    # ... rest of the module\n' }, ctx)
    expect(r.result === false && r.errorCode).toBe(5)
  })

  test('lets through a placeholder the file already has, and a full rewrite', async () => {
    const kept = fresh('write-kept.ts', `${ORIGINAL}// ... existing code ...\n`)
    expect((await FileWriteTool.validateInput!({ file_path: kept, content: `// head\n${ORIGINAL}// ... existing code ...\n` }, ctx)).result).toBe(true)
    const full = fresh('write-full.ts', ORIGINAL)
    expect((await FileWriteTool.validateInput!({ file_path: full, content: ORIGINAL.replace('1', '10') }, ctx)).result).toBe(true)
  })

  test('never checks prose', async () => {
    const path = fresh('notes.md', '# Notes\n')
    expect((await FileWriteTool.validateInput!({ file_path: path, content: '```ts\n// ... existing code ...\n```\n' }, ctx)).result).toBe(true)
  })
})

describe('Patch', () => {
  test('a patch whose only file carries a placeholder is refused in validation', () => {
    const path = fresh('patch.ts', ORIGINAL)
    const r = validateApplyPatchInput(
      { patchText: ['*** Begin Patch', `*** Update File: ${path}`, '@@', '-  return 2', '+  // ... existing code ...', '*** End Patch'].join('\n') },
      ctx,
    )
    expect(r.result).toBe(false)
    expect(r.result === false && r.message).toContain('an added line of')
    expect(r.result === false && r.message).toContain('is an elision placeholder:\n    // ... existing code ...')
  })

  test('an Add File carrying a placeholder is refused', () => {
    const path = fresh('patch-add.ts', null)
    const r = validateApplyPatchInput(
      { patchText: ['*** Begin Patch', `*** Add File: ${path}`, '+const a = 1', '+// ... rest of the file', '*** End Patch'].join('\n') },
      ctx,
    )
    expect(r.result).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  test('the other files of the patch apply; the elided one is left untouched and reported', async () => {
    const elided = fresh('patch-elided.ts', ORIGINAL)
    const clean = fresh('patch-clean.ts', ORIGINAL)
    const patchText = [
      '*** Begin Patch',
      `*** Update File: ${elided}`,
      '@@',
      '-  return 2',
      '+  // ... existing code ...',
      `*** Update File: ${clean}`,
      '@@',
      '-  return 2',
      '+  return 20',
      '*** End Patch',
    ].join('\n')
    expect(validateApplyPatchInput({ patchText }, ctx).result).toBe(true)
    const { output } = await runApplyPatch({ patchText }, ctx, randomUUID())
    expect(readFileSync(clean, 'utf8')).toContain('return 20')
    expect(readFileSync(elided, 'utf8')).toBe(ORIGINAL)
    expect(output.notApplied?.join('\n')).toContain('is an elision placeholder')
  })

  test('a placeholder kept as context is not new', () => {
    const path = fresh('patch-context.ts', `${ORIGINAL}// ... existing code ...\n`)
    const r = validateApplyPatchInput(
      {
        patchText: ['*** Begin Patch', `*** Update File: ${path}`, '@@', '-  return 2', '+  return 3', ' }', ' // ... existing code ...', '*** End Patch'].join('\n'),
      },
      ctx,
    )
    expect(r.result).toBe(true)
  })
})
