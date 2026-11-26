import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { MaxFileReadTokenExceededError } from 'src/tools/FileReadTool/guards.js'
import { linesUnderCap, pageOverCap } from 'src/tools/FileReadTool/overCapPage.js'

describe('linesUnderCap', () => {
  const lines = Array.from({ length: 100 }, () => 'x'.repeat(99))

  test('scales the count the whole made down to the cap, with a margin', () => {
    // 100 lines counted 1,000 tokens; a 500 cap takes 90% of half of them.
    expect(linesUnderCap(lines, 1_000, 500)).toBe(45)
  })

  test('long lines take more of the page than short ones', () => {
    const mixed = ['x'.repeat(4_000), ...Array.from({ length: 40 }, () => 'y'.repeat(99))]
    // 8,001 chars counted 2,000 tokens: a 1,125 cap leaves ~4,050 chars, the
    // long line and none of the 40 short ones after it.
    expect(linesUnderCap(mixed, 2_000, 1_125)).toBe(1)
  })

  test('0 when the first line alone is over the cap', () => {
    expect(linesUnderCap(['z'.repeat(100_000), 'short'], 25_000, 1_000)).toBe(0)
  })
})

describe('pageOverCap', () => {
  const body = Array.from({ length: 100 }, (_, i) => `row ${String(i + 1).padStart(3, '0')} ${'x'.repeat(91)}`).join('\n')

  test('the first lines that fit, and a note naming them and where to go on', () => {
    const page = pageOverCap(body, new MaxFileReadTokenExceededError(1_000, 500), {
      filePath: '/tmp/a.txt',
      startLine: 1,
      totalLines: 100,
      wholeFile: true,
    })
    expect(page.numLines).toBe(45)
    expect(page.content.split('\n')).toHaveLength(45)
    expect(page.content.endsWith('row 045 ' + 'x'.repeat(91))).toBe(true)
    expect(page.note).toBe(
      'Lines 1-45 of 100 are shown. The file is ~1,000 tokens, over the 500-token cap. Read with offset=46 for the rest.',
    )
  })

  test('a range counts from where it starts', () => {
    const page = pageOverCap(body, new MaxFileReadTokenExceededError(136_793, 25_000), {
      filePath: '/tmp/a.txt',
      startLine: 23,
      totalLines: 400,
      wholeFile: false,
    })
    expect(page.note).toStartWith(`Lines 23-${22 + page.numLines} of 400 are shown. The range asked for is ~136,793 tokens`)
  })

  test('a first line over the cap alone names a Bash cut of it', () => {
    const read = () =>
      pageOverCap('z'.repeat(100_000) + '\nshort', new MaxFileReadTokenExceededError(25_000, 1_000), {
        filePath: '/tmp/big.json',
        startLine: 23,
        totalLines: 60,
        wholeFile: false,
      })
    expect(read).toThrow(MaxFileReadTokenExceededError)
    expect(read).toThrow(
      "File content (25000 tokens) exceeds maximum allowed tokens (1000). Line 23 alone is over the cap; read part of it with Bash: sed -n '23p' '/tmp/big.json' | cut -c1-20000",
    )
  })
})

// The VCR layer keys token counts by body (token-count-*.json); this is the
// body autoOutlineOnElision.test.ts recorded, generated the same way, so the
// page costs no new recording.
function bigTextSource(): string {
  const lines: string[] = []
  for (let i = 1; i <= 400; i++) {
    lines.push(`line ${String(i).padStart(4, '0')} ${'lorem ipsum '.repeat(4)}`)
  }
  return lines.join('\n') + '\n'
}

describe('a paged Read through the tool', () => {
  let dir = ''
  const priorSimple = process.env.CLAUDIN_SIMPLE
  beforeAll(() => {
    process.env.CLAUDIN_SIMPLE = '1'
    dir = mkdtempSync(join(tmpdir(), 'overcap-page-'))
  })
  afterAll(() => {
    if (priorSimple === undefined) delete process.env.CLAUDIN_SIMPLE
    else process.env.CLAUDIN_SIMPLE = priorSimple
    rmSync(dir, { recursive: true, force: true })
  })

  test('the read gate records the page as the range it is', async () => {
    const path = join(dir, 'dump.txt')
    writeFileSync(path, bigTextSource())
    const context = {
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      fileReadingLimits: { maxSizeBytes: 10 * 1024 * 1024, maxTokens: 1000 },
      getAppState: () => ({ toolPermissionContext: {} }),
      setAppState: () => {},
      options: {},
    } as unknown as ToolUseContext
    const { data } = await FileReadTool.call({ file_path: path, view: 'full' }, context, undefined as never, undefined as never)
    if (data.type !== 'text') throw new Error(`expected text, got ${data.type}`)
    expect(context.readFileState.get(path)).toMatchObject({ offset: 1, limit: data.file.numLines })
    expect(data.file.note).toContain(`offset=${data.file.numLines + 1}`)
  })
})
