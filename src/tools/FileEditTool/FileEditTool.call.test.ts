// Edit end to end on a file it has read whole: validateInput, then call(),
// against a real cache and real files. What is pinned here is how the edit is
// matched and applied, and what the cache holds after it.
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import type { FileEditInput } from 'src/tools/FileEditTool/types.js'

let dir: string
let ctx: ToolUseContext
const savedCheckpointing = process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING

beforeAll(() => {
  setOriginalFsImplementation()
  // call() would back the file up under the config dir otherwise.
  process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
  dir = mkdtempSync(join(tmpdir(), 'edit-call-'))
})

afterAll(() => {
  if (savedCheckpointing === undefined) delete process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING
  else process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = savedCheckpointing
  rmSync(dir, { recursive: true, force: true })
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
})

/** A file the model has Read whole. */
function readFile(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  ctx.readFileState.set(p, {
    content,
    timestamp: getFileModificationTime(p),
    offset: undefined,
    limit: undefined,
  })
  return p
}

function validate(input: FileEditInput) {
  return FileEditTool.validateInput(input, ctx)
}

/** validateInput, then call() — the harness only calls a validated input. */
async function edit(input: FileEditInput) {
  const verdict = await validate(input)
  if (!verdict.result) throw new Error(`refused: ${verdict.message}`)
  const { data } = await FileEditTool.call(input, ctx, undefined as never, { uuid: randomUUID() } as never)
  return data
}

async function refusal(input: FileEditInput) {
  const r = await validate(input)
  if (r.result) throw new Error('expected a refusal, got a pass')
  return r
}

describe('Edit — matching and applying', () => {
  test('an exact match is replaced once and the cache holds the whole new file', async () => {
    const p = readFile('exact.ts', 'const a = 1\nconst b = 2\n')
    const data = await edit({ file_path: p, old_string: 'const b = 2', new_string: 'const b = 3' })
    expect(readFileSync(p, 'utf8')).toBe('const a = 1\nconst b = 3\n')
    expect(ctx.readFileState.get(p)).toMatchObject({
      content: 'const a = 1\nconst b = 3\n',
      offset: undefined,
      limit: undefined,
      timestamp: getFileModificationTime(p),
    })
    expect(FileEditTool.mapToolResultToToolResultBlockParam(data, 'id').content).toBe(
      `The file ${p} has been updated successfully.`,
    )
  })

  test('replace_all replaces every occurrence and says so', async () => {
    const p = readFile('all.ts', 'x\ny\nx\n')
    const data = await edit({ file_path: p, old_string: 'x', new_string: 'z', replace_all: true })
    expect(readFileSync(p, 'utf8')).toBe('z\ny\nz\n')
    expect(FileEditTool.mapToolResultToToolResultBlockParam(data, 'id').content).toContain(
      'All occurrences were successfully replaced.',
    )
  })

  test('straight quotes match the file’s curly ones, and the curly style is kept', async () => {
    const p = readFile('quotes.md', 'He said \u201chello\u201d.\n')
    await edit({ file_path: p, old_string: 'He said "hello".', new_string: 'He said "goodbye".' })
    expect(readFileSync(p, 'utf8')).toBe('He said \u201cgoodbye\u201d.\n')
  })

  test('an indentation drift matches fuzzily and new_string takes the file’s indent', async () => {
    const p = readFile('indent.ts', 'function f() {\n    return 1\n}\n')
    await edit({ file_path: p, old_string: '  return 1', new_string: '  return 2' })
    expect(readFileSync(p, 'utf8')).toBe('function f() {\n    return 2\n}\n')
  })

  test('an empty old_string creates a missing file', async () => {
    const p = join(dir, 'created.ts')
    await edit({ file_path: p, old_string: '', new_string: 'export {}\n' })
    expect(readFileSync(p, 'utf8')).toBe('export {}\n')
  })
})

describe('Edit — refusals that are about the edit, not the read', () => {
  test('no change at all', async () => {
    const p = readFile('same.ts', 'a\n')
    expect((await refusal({ file_path: p, old_string: 'a', new_string: 'a' })).errorCode).toBe(1)
  })

  test('a string that is not in the file', async () => {
    const p = readFile('missing.ts', 'a\nb\n')
    const r = await refusal({ file_path: p, old_string: 'nowhere', new_string: 'x' })
    expect(r.errorCode).toBe(8)
    expect(r.message).toStartWith('String to replace not found in file.')
  })

  test('a string found twice without replace_all', async () => {
    const p = readFile('twice.ts', 'x = 1\ny\nx = 1\n')
    const r = await refusal({ file_path: p, old_string: 'x = 1', new_string: 'x = 2' })
    expect(r.errorCode).toBe(9)
    expect(r.message).toStartWith('Found 2 matches of the string to replace')
  })

  test('a block not found says where it diverges, as Patch does, without echoing it back', async () => {
    const p = readFile('diverges.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
    const r = await refusal({ file_path: p, old_string: 'const a = 1\nconst c = 3', new_string: 'x' })
    expect(r.message).toBe(
      'String to replace not found in file.\n' +
        'line(s) 1-1 of your old_string match starting at line 1, then line 2 diverges.\n' +
        '  your line 2: const c = 3\n' +
        '  file line 2: const b = 2\n' +
        'Re-read that region and copy every line in between — a dropped intervening line is the usual cause.',
    )
  })

  test('a block that matches nowhere is told so, without echoing it back', async () => {
    const p = readFile('nowhere.ts', 'a\nb\n')
    expect((await refusal({ file_path: p, old_string: 'nowhere', new_string: 'x' })).message).toBe(
      'String to replace not found in file. Read the file again and copy the context verbatim — a block that matches nowhere usually means it was written from memory, or aimed at the wrong file.',
    )
  })

  test('several matches are named by line, exact or whitespace-tolerant', async () => {
    const exact = readFile('lines-exact.ts', 'x = 1\ny\nx = 1\n')
    expect((await refusal({ file_path: exact, old_string: 'x = 1', new_string: 'x = 2' })).message).toBe(
      'Found 2 matches of the string to replace, at lines 1, 3, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.',
    )
    // Not a substring (trailing spaces), so only the whitespace-tolerant pass finds it — twice.
    const fuzzy = readFile('lines-fuzzy.ts', 'foo()\nbar\nfoo()\n')
    expect((await refusal({ file_path: fuzzy, old_string: 'foo()  ', new_string: 'baz()' })).message).toStartWith(
      'Found 2 matches of the string to replace, at lines 1, 3, but replace_all is false.',
    )
  })

  test('creating over a file that has content', async () => {
    const p = readFile('exists.ts', 'a\n')
    expect((await refusal({ file_path: p, old_string: '', new_string: 'b\n' })).errorCode).toBe(3)
  })
})
