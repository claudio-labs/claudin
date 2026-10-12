// Edit's read rule, driven through the real validateInput and call() against a
// real cache and real files. Edit is an in-place write, like Patch
// (readBeforeEditMessages.ts): any earlier read of the file authorizes it, and
// whether `old_string` is still in the file decides it. A file never read is
// edited only when `old_string` sits in it exactly once.
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
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
import { outputSchema, type FileEditInput } from 'src/tools/FileEditTool/types.js'
import { FILE_NOT_READ_ERROR } from 'src/tools/shared/readBeforeEditMessages.js'

let dir: string
let ctx: ToolUseContext
const savedCheckpointing = process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING

/** The never-read refusal, naming how often old_string occurs instead (none, or several). */
const unreadRefusal = (occurs: string) =>
  `${FILE_NOT_READ_ERROR} old_string ${occurs}, so it was not edited unread.`

beforeAll(() => {
  setOriginalFsImplementation()
  // call() would back the file up under the config dir otherwise.
  process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
  dir = mkdtempSync(join(tmpdir(), 'edit-read-gate-'))
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

function writeNumbered(path: string, count = 10): void {
  writeFileSync(
    path,
    Array.from({ length: count }, (_, i) => `line${i + 1}`).join('\n') + '\n',
  )
}

/** A range Read: the model only saw lines [offset, offset + limit - 1]. */
function markRange(path: string, offset: number, limit: number): void {
  const lines = readFileSync(path, 'utf8').split('\n')
  ctx.readFileState.set(path, {
    content: `${lines.slice(offset - 1, offset - 1 + limit).join('\n')}\n`,
    timestamp: getFileModificationTime(path),
    offset,
    limit,
  })
}

function validate(input: FileEditInput) {
  return FileEditTool.validateInput(input, ctx)
}

function call(input: FileEditInput) {
  return FileEditTool.call(input, ctx, undefined as never, { uuid: randomUUID() } as never)
}

/** validateInput, then call() — the harness only calls a validated input. */
async function edit(input: FileEditInput) {
  const verdict = await validate(input)
  if (!verdict.result) throw new Error(`refused: ${verdict.message}`)
  return (await call(input)).data
}

async function refusal(input: FileEditInput): Promise<string> {
  const r = await validate(input)
  if (r.result) throw new Error('expected a refusal, got a pass')
  return r.message
}

describe('Edit — any read of the file authorizes it', () => {
  test('a range read authorizes an edit outside the range', async () => {
    const p = join(dir, 'range.txt')
    writeNumbered(p)
    markRange(p, 1, 3)
    await edit({ file_path: p, old_string: 'line8', new_string: 'LINE8' })
    expect(readFileSync(p, 'utf8')).toContain('\nLINE8\n')
  })

  test('an outline or partial view authorizes it', async () => {
    const p = join(dir, 'outline.txt')
    writeNumbered(p)
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8'),
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    await edit({ file_path: p, old_string: 'line5', new_string: 'LINE5' })
    expect(readFileSync(p, 'utf8')).toContain('\nLINE5\n')
  })

  test('a file changed since the read is edited as it is now, keeping the change', async () => {
    const p = join(dir, 'changed.txt')
    writeNumbered(p)
    markRange(p, 1, 3)
    writeFileSync(p, readFileSync(p, 'utf8').replace('line8', 'LINE8'))
    const when = new Date(Date.now() + 10_000)
    utimesSync(p, when, when)

    await edit({ file_path: p, old_string: 'line2', new_string: 'LINE2' })
    const after = readFileSync(p, 'utf8')
    expect(after).toContain('\nLINE2\n')
    expect(after).toContain('\nLINE8\n')
  })

  test('a clip-pin stand-down marker does not stop it, and the edit replaces the marker', async () => {
    const p = join(dir, 'clipped.txt')
    writeNumbered(p)
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8'),
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
      standDownOutline: { message: '<outline>', servedOutline: true, epoch: 0, replays: 0 },
    })
    await edit({ file_path: p, old_string: 'line5', new_string: 'LINE5' })
    expect(ctx.readFileState.get(p)!.standDownOutline).toBeUndefined()
  })

  test('a change between the check and the write that makes old_string ambiguous is not written', async () => {
    // The staleness throw that guarded this window went with the stale lane;
    // without a re-count, replace() would silently edit the FIRST occurrence.
    const p = join(dir, 'race-read.txt')
    writeNumbered(p)
    markRange(p, 1, 10)
    const input = { file_path: p, old_string: 'line5', new_string: 'LINE5' }
    expect(await validate(input)).toMatchObject({ result: true })
    writeFileSync(p, 'line5 inserted by someone else\n' + readFileSync(p, 'utf8'))
    await expect(call(input)).rejects.toThrow('Found 2 matches of the string to replace, at lines 1, 6')
    expect(readFileSync(p, 'utf8')).toStartWith('line5 inserted by someone else\n')
  })

  test('an old_string that ends with the newline of the last line read passes', async () => {
    // Refused twice in a row in the census week (floor.test.ts): the coverage
    // lane compared the needle with slices joined without their final \n.
    const p = join(dir, 'eof.txt')
    writeNumbered(p)
    markRange(p, 6, 5)
    await edit({ file_path: p, old_string: 'line9\nline10\n', new_string: 'line9\nline10\nline11\n' })
    expect(readFileSync(p, 'utf8')).toEndWith('line10\nline11\n')
  })
})

describe('Edit — a file never read', () => {
  test('is edited when old_string sits in it exactly once, and the result says so', async () => {
    const p = join(dir, 'unread.txt')
    writeNumbered(p)
    const data = await edit({ file_path: p, old_string: 'line5', new_string: 'LINE5' })
    expect(readFileSync(p, 'utf8')).toContain('\nLINE5\n')
    expect(data.unread).toBe(true)
    expect(FileEditTool.mapToolResultToToolResultBlockParam(data, 'id').content).toBe(
      `The file ${p} has been updated successfully.\nNote: ${p} had not been read — edited because old_string matched it exactly once.`,
    )
    // And it counts as read now, like any file the model wrote.
    expect(ctx.readFileState.get(p)).toMatchObject({ offset: undefined, limit: undefined })
  })

  test('the note is in the output the renderer parses', () => {
    const parsed = outputSchema().parse({
      filePath: 'f',
      oldString: 'a',
      newString: 'b',
      originalFile: 'a',
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
      unread: true,
    })
    expect(parsed.unread).toBe(true)
  })

  test('is refused when old_string is not in it exactly', async () => {
    // A quote-normalized or whitespace-tolerant match is fine on a file the
    // model read; on one it never read, only the exact bytes vouch for it.
    const p = join(dir, 'curly.md')
    writeFileSync(p, 'He said \u201chello\u201d.\n')
    expect(await refusal({ file_path: p, old_string: 'He said "hello".', new_string: 'x' })).toBe(
      unreadRefusal('does not occur in it'),
    )
  })

  test('is refused when old_string sits in it more than once, replace_all or not', async () => {
    const p = join(dir, 'twice.txt')
    writeFileSync(p, 'same\nother\nsame\n')
    expect(await refusal({ file_path: p, old_string: 'same', new_string: 'SAME' })).toBe(
      unreadRefusal('occurs in it 2 times'),
    )
    expect(
      await refusal({ file_path: p, old_string: 'same', new_string: 'SAME', replace_all: true }),
    ).toBe(unreadRefusal('occurs in it 2 times'))
  })

  test('call() checks again: a file that changed after the check is not written', async () => {
    const p = join(dir, 'race.txt')
    writeNumbered(p)
    const input = { file_path: p, old_string: 'line5', new_string: 'LINE5' }
    expect(await validate(input)).toMatchObject({ result: true })
    writeFileSync(p, 'line5\nline5\n')
    await expect(call(input)).rejects.toThrow(unreadRefusal('occurs in it 2 times'))
    expect(readFileSync(p, 'utf8')).toBe('line5\nline5\n')
  })
})
