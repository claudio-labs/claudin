// Write's read-before-edit gate, driven through the real validateInput and
// call() against a real cache and real files. A Write replaces the whole
// file, so it keeps the full gate: the file read whole, as it is now.
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
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
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from 'src/tools/FileEditTool/constants.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'

let dir: string
let ctx: ToolUseContext
const savedCheckpointing = process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING

beforeAll(() => {
  setOriginalFsImplementation()
  // call() would back the file up under the config dir otherwise.
  process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
  dir = mkdtempSync(join(tmpdir(), 'write-read-gate-'))
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

function markWhole(path: string): void {
  ctx.readFileState.set(path, {
    content: readFileSync(path, 'utf8'),
    timestamp: getFileModificationTime(path),
    offset: undefined,
    limit: undefined,
  })
}

function markRange(path: string, offset: number, limit: number): void {
  const lines = readFileSync(path, 'utf8').split('\n')
  ctx.readFileState.set(path, {
    content: `${lines.slice(offset - 1, offset - 1 + limit).join('\n')}\n`,
    timestamp: getFileModificationTime(path),
    offset,
    limit,
  })
}

/** Move the file's mtime past the entry's, as an outside write would. */
function touchLater(path: string): void {
  const when = new Date(Date.now() + 10_000)
  utimesSync(path, when, when)
}

function validate(path: string, content = 'new\n') {
  return FileWriteTool.validateInput({ file_path: path, content }, ctx)
}

async function refusal(p: ReturnType<typeof validate>) {
  const r = await p
  if (r.result) throw new Error('expected a refusal, got a pass')
  return r
}

function call(path: string, content: string) {
  return FileWriteTool.call(
    { file_path: path, content },
    ctx,
    undefined as never,
    { uuid: randomUUID() } as never,
  )
}

describe('Write — validateInput keeps the full gate', () => {
  test('a new file needs no read', async () => {
    expect(await validate(join(dir, 'brand-new.txt'))).toEqual({ result: true })
  })

  test('an existing file never read is refused', async () => {
    const p = join(dir, 'never.txt')
    writeNumbered(p)
    const r = await refusal(validate(p))
    expect(r.errorCode).toBe(2)
    expect(r.message).toStartWith('File has not been read yet.')
  })

  test('an outline or partial view is refused, naming view=full', async () => {
    const p = join(dir, 'partial.txt')
    writeNumbered(p)
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8'),
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    const r = await refusal(validate(p))
    expect(r.errorCode).toBe(2)
    expect(r.message).toContain("only been seen as an outline or a partial view")
  })

  test('an injected, truncated file is refused: written back it would lose its tail', async () => {
    const p = join(dir, 'injected.md')
    writeNumbered(p)
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8'),
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
      injectedView: 'line1\nline2\n',
    })
    expect((await refusal(validate(p))).errorCode).toBe(2)
  })

  test('a clip-pin stand-down marker is refused with the clipped wording', async () => {
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
    const r = await refusal(validate(p))
    expect(r.errorCode).toBe(2)
    expect(r.message).toContain('clipped out of the transcript')
  })

  test('a file that changed and was too large to refresh says so', async () => {
    const p = join(dir, 'too-large.txt')
    writeNumbered(p)
    ctx.readFileState.set(p, {
      content: '',
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
      refreshFailed: 'too-large',
    })
    const r = await refusal(validate(p))
    expect(r.errorCode).toBe(2)
    expect(r.message).toContain('too large to re-read whole')
  })

  test('a file changed on disk since the read is refused', async () => {
    const p = join(dir, 'stale.txt')
    writeNumbered(p)
    markWhole(p)
    touchLater(p)
    const r = await refusal(validate(p))
    expect(r.errorCode).toBe(3)
    expect(r.message).toStartWith('File has been modified since read')
  })

  test('a range read is not enough: the rest would be dropped', async () => {
    const p = join(dir, 'range.txt')
    writeNumbered(p)
    markRange(p, 3, 2)
    const r = await refusal(validate(p))
    expect(r.errorCode).toBe(4)
    expect(r.message).toContain('was only read in part (lines 3-4)')
  })

  test('a whole Read, then a range Read of the same file: the whole one still counts', async () => {
    // ruleMapScheduler.ts in the 2026-10-05..12 census: refused as "only read
    // in part (lines 1-275)" — every line of the file.
    const p = join(dir, 'whole-then-range.txt')
    writeNumbered(p)
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8'),
      timestamp: getFileModificationTime(p),
      offset: 1,
      limit: undefined,
    })
    markRange(p, 4, 2)
    expect(await validate(p)).toEqual({ result: true })
  })

  test('ranges that together hold every line count; a gap between them does not', async () => {
    const p = join(dir, 'two-halves.txt')
    writeNumbered(p)
    markRange(p, 1, 5)
    markRange(p, 6, 5)
    expect(await validate(p)).toEqual({ result: true })

    const q = join(dir, 'gap.txt')
    writeNumbered(q)
    markRange(q, 1, 5)
    markRange(q, 7, 4)
    expect((await refusal(validate(q))).message).toContain('was only read in part (lines 1-5, 7-10)')
  })

  test('a whole, current read passes', async () => {
    const p = join(dir, 'whole.txt')
    writeNumbered(p)
    markWhole(p)
    expect(await validate(p)).toEqual({ result: true })
  })
})

describe('Write — call()', () => {
  test('an update writes the file and leaves a whole-file entry for it', async () => {
    const p = join(dir, 'update.txt')
    writeNumbered(p, 3)
    markWhole(p)
    const { data } = await call(p, 'a\nb\n')
    expect(data.type).toBe('update')
    expect(data.originalFile).toBe('line1\nline2\nline3\n')
    expect(readFileSync(p, 'utf8')).toBe('a\nb\n')
    expect(ctx.readFileState.get(p)).toMatchObject({
      content: 'a\nb\n',
      offset: undefined,
      limit: undefined,
      timestamp: getFileModificationTime(p),
    })
    expect(
      FileWriteTool.mapToolResultToToolResultBlockParam(data, 'id').content,
    ).toBe(`The file ${p} has been updated successfully.`)
  })

  test('a create writes the file and reports it as created', async () => {
    const p = join(dir, 'created.txt')
    const { data } = await call(p, 'hello\n')
    expect(data.type).toBe('create')
    expect(existsSync(p)).toBe(true)
    expect(
      FileWriteTool.mapToolResultToToolResultBlockParam(data, 'id').content,
    ).toBe(`File created successfully at: ${p}`)
  })

  test('a file changed between the check and the write is not overwritten', async () => {
    const p = join(dir, 'race.txt')
    writeNumbered(p, 3)
    markWhole(p)
    writeFileSync(p, 'someone else\n')
    touchLater(p)
    await expect(call(p, 'mine\n')).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(readFileSync(p, 'utf8')).toBe('someone else\n')
  })

  test('a newer mtime over the same bytes is not a change', async () => {
    const p = join(dir, 'touched.txt')
    writeNumbered(p, 3)
    markWhole(p)
    touchLater(p)
    await call(p, 'mine\n')
    expect(readFileSync(p, 'utf8')).toBe('mine\n')
  })
})
