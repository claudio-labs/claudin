// Edit's read-before-edit refusals, driven through the real validateInput
// against a real cache and real files — the served-region half in particular
// (tools/shared/servedRegion.ts): when `old_string` sits in the file exactly
// once, the refusal carries the region, registers it, and the identical
// resubmit passes.
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

let dir: string
let ctx: ToolUseContext

beforeAll(() => {
  setOriginalFsImplementation()
  dir = mkdtempSync(join(tmpdir(), 'edit-read-gate-'))
})

afterAll(() => {
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

function edit(path: string, old_string: string, new_string: string) {
  return FileEditTool.validateInput({ file_path: path, old_string, new_string }, ctx)
}

async function refusal(
  p: ReturnType<typeof edit>,
): Promise<string> {
  const r = await p
  if (r.result) throw new Error('expected a refusal, got a pass')
  return r.message
}

describe('Edit — the refusal serves the region', () => {
  test('a coverage refusal carries the lines and the same edit then passes', async () => {
    const p = join(dir, 'coverage.txt')
    writeNumbered(p)
    markRange(p, 1, 3)

    const message = await refusal(edit(p, 'line8', 'LINE8'))
    expect(message).toContain('only read in part (lines 1-3)')
    expect(message).toContain('now count as read')
    expect(message).toContain('6→line6')
    expect(message).toContain('8→line8')
    expect(message).toContain('10→line10')
    expect(message).not.toContain('5→line5')

    expect(await edit(p, 'line8', 'LINE8')).toMatchObject({ result: true })
    // The slice the model had read is still authorized too.
    expect(await edit(p, 'line2', 'LINE2')).toMatchObject({ result: true })
  })

  test('a never-read refusal is served the same way', async () => {
    const p = join(dir, 'never.txt')
    writeNumbered(p)

    const message = await refusal(edit(p, 'line5', 'LINE5'))
    expect(message).toContain('has not been read yet')
    expect(message).toContain('5→line5')

    expect(await edit(p, 'line5', 'LINE5')).toMatchObject({ result: true })
  })

  test('a stale refusal serves the current lines', async () => {
    const p = join(dir, 'stale.txt')
    writeNumbered(p)
    markRange(p, 1, 3)
    writeFileSync(p, readFileSync(p, 'utf8').replace('line8', 'LINE8'))
    const when = new Date(Date.now() + 10_000)
    utimesSync(p, when, when)

    const message = await refusal(edit(p, 'LINE8', 'line8'))
    expect(message).toContain('modified since read')
    expect(message).toContain('8→LINE8')

    expect(await edit(p, 'LINE8', 'line8')).toMatchObject({ result: true })
  })

  test('a needle that starts and ends mid-line is served whole-line', async () => {
    const p = join(dir, 'midline.txt')
    writeNumbered(p)
    markRange(p, 1, 3)

    const message = await refusal(edit(p, 'ne7\nline8\nli', 'X'))
    expect(message).toContain('7→line7')
    expect(message).toContain('9→line9')
    expect(await edit(p, 'ne7\nline8\nli', 'X')).toMatchObject({ result: true })
  })

  test('an ambiguous needle is not served', async () => {
    const p = join(dir, 'ambiguous.txt')
    writeFileSync(p, 'same\nother\nsame\nend\n')
    markRange(p, 4, 1)

    const message = await refusal(edit(p, 'same', 'SAME'))
    expect(message).toContain('only read in part')
    expect(message).not.toContain('→')
  })

  test('a needle that is not in the file is not served', async () => {
    const p = join(dir, 'miss.txt')
    writeNumbered(p)
    markRange(p, 1, 3)

    const message = await refusal(edit(p, 'nowhere', 'x'))
    expect(message).not.toContain('→')
  })

  test('a clip-pin stand-down marker is never served over', async () => {
    const p = join(dir, 'clipped.txt')
    writeNumbered(p)
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8'),
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
      standDownOutline: {
        message: '<outline>',
        servedOutline: true,
        epoch: 0,
        replays: 0,
      },
    })

    const message = await refusal(edit(p, 'line5', 'LINE5'))
    expect(message).toContain('clipped out of the transcript')
    expect(message).not.toContain('→')
  })
})
