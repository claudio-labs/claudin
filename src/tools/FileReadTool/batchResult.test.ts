// A batch Read's result read back per file (batchResult.ts). Every case here
// runs the real batch Read (CLAUDIN_READ_MULTI on) and splits what it wrote,
// so the reader cannot drift from batchRead.ts unnoticed: each file has to
// come back as exactly the text a Read of that one file returns.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  fixtureDir,
  makeContext,
  read,
  SAMPLE_TS,
  useFileReadEnv,
  writeFixture,
  type ReadInput,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'
import { importWithReadMulti } from 'src/tools/FileReadTool/__testutils__/readMultiFlag.js'
import { splitBatchReadResult } from 'src/tools/FileReadTool/batchResult.js'
import { FileReadTool as HarnessReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FILE_UNCHANGED_STUB } from 'src/tools/FileReadTool/prompt.js'
import { readPathsOf } from 'src/tools/FileReadTool/readMulti.js'
import {
  _resetReadReminderStateForTesting,
  _setMitigationModelResolverForTesting,
} from 'src/tools/FileReadTool/resultContent.js'
import type { Input } from 'src/tools/FileReadTool/schemas.js'

useFileReadEnv()

type ReadModule = typeof import('src/tools/FileReadTool/FileReadTool.js')
let ReadOn: ReadModule['FileReadTool']

beforeAll(async () => {
  ReadOn = (
    await importWithReadMulti<ReadModule>('src/tools/FileReadTool/FileReadTool.js', true)
  ).FileReadTool
  // An exempt model: the once-per-agent mitigation reminder would otherwise
  // land on whichever read comes first and make the comparisons order-bound.
  _setMitigationModelResolverForTesting(() => 'claude-opus-5-5')
})

afterAll(() => {
  _setMitigationModelResolverForTesting(undefined)
  _resetReadReminderStateForTesting()
})

let toolUseSeq = 0

function context(maxTokens?: number): ToolUseContext {
  return makeContext({
    fileReadingLimits: maxTokens === undefined ? undefined : { maxTokens },
    toolUseId: `toolu_split_${++toolUseSeq}`,
  })
}

/** A batch Read run with `cwd` as the working directory: its tool_result text and the files it showed. */
async function runBatch(
  input: Input,
  ctx: ToolUseContext,
  cwd = fixtureDir(),
): Promise<{ text: string; shown: string[] }> {
  const { data } = await runWithCwdOverride(cwd, () =>
    ReadOn.call(input, ctx, undefined as never, undefined as never),
  )
  if (data.type !== 'batch') throw new Error(`expected a batch result, got ${data.type}`)
  return {
    text: ReadOn.mapToolResultToToolResultBlockParam(data, 'toolu_x').content as string,
    shown: data.files.map(file => file.filePath),
  }
}

/** What a Read of that one file returns. */
async function singleText(filePath: string, input: ReadInput = {}): Promise<string> {
  const { data } = await read(filePath, input)
  return HarnessReadTool.mapToolResultToToolResultBlockParam(data, 'toolu_single')
    .content as string
}

function textLines(count: number, width: number, tag: string): string {
  return Array.from({ length: count }, (_, i) => `${tag}-${i}-`.padEnd(width, 'x')).join('\n')
}

describe('splitBatchReadResult — round trips through the batch Read', () => {
  test('each file comes back as exactly what a Read of it returns', async () => {
    const a = writeFixture('rt-a.ts', SAMPLE_TS)
    const b = writeFixture('rt-b.txt', 'first\nsecond\n')
    const input: Input = { file_paths: [a, b] }
    const { text } = await runBatch(input, context())
    expect(splitBatchReadResult(text, readPathsOf(input), fixtureDir())).toEqual([
      { path: a, text: await singleText(a) },
      { path: b, text: await singleText(b) },
    ])
  })

  test('a symbol list is one file, its bodies as the batch joined them; the miss note is dropped', async () => {
    const a = writeFixture('rt-sym.ts', SAMPLE_TS)
    const input: Input = { file_path: a, symbol: ['alpha', 'beta', 'nope'] }
    const { text } = await runBatch(input, context())
    expect(text).toContain('Symbol not found: nope in rt-sym.ts.')
    expect(splitBatchReadResult(text, readPathsOf(input), fixtureDir())).toEqual([
      {
        path: a,
        text: `${await singleText(a, { symbol: 'alpha' })}\n\n${await singleText(a, { symbol: 'beta' })}`,
      },
    ])
  })

  test('a file answered with the unchanged stub comes back as the stub', async () => {
    const a = writeFixture('rt-stub-a.ts', SAMPLE_TS)
    const c = writeFixture('rt-stub-c.txt', 'c\n')
    const d = writeFixture('rt-stub-d.txt', 'd\n')
    const ctx = context()
    await runBatch({ file_paths: [a, c] }, ctx)
    const input: Input = { file_paths: [a, d] }
    const { text } = await runBatch(input, ctx)
    expect(splitBatchReadResult(text, readPathsOf(input), fixtureDir())).toEqual([
      { path: a, text: FILE_UNCHANGED_STUB },
      { path: d, text: await singleText(d) },
    ])
  })

  test('files past the budget and media are only notes; the last file shown keeps its text', async () => {
    // Each file stays under a quarter of the cap in characters, so the
    // per-file guard never needs the counting API; together they overrun it.
    const files = [0, 1, 2, 3, 4, 5].map(i =>
      writeFixture(`rt-budget-${i}.txt`, textLines(30, 44, `rt${i}`)),
    )
    const png = writeFixture('rt-budget.png', 'not really a png')
    const input: Input = { file_paths: [png, ...files] }
    const { text, shown } = await runBatch(input, context(1500))
    expect(text).toContain('\n\nNot read — images')
    expect(text).toContain('\nNot shown — over the')
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(files.length)
    expect(splitBatchReadResult(text, readPathsOf(input), fixtureDir())).toEqual(
      await Promise.all(shown.map(async path => ({ path, text: await singleText(path) }))),
    )
  })

  test('outside the working directory a file is headed by its absolute path', async () => {
    const a = writeFixture('rt-abs-a.txt', 'a\n')
    const b = writeFixture('rt-abs-b.txt', 'b\n')
    const elsewhere = join(fixtureDir(), 'nested-cwd')
    const input: Input = { file_paths: [a, b] }
    const { text } = await runBatch(input, context(), elsewhere)
    expect(text.startsWith(`==> ${a} <==`)).toBe(true)
    expect(splitBatchReadResult(text, readPathsOf(input), elsewhere)).toEqual([
      { path: a, text: await singleText(a) },
      { path: b, text: await singleText(b) },
    ])
  })
})

describe('splitBatchReadResult — what it will not take', () => {
  test('a header matches only a path the call named, and its text goes with it', () => {
    const a = join(fixtureDir(), 'named.ts')
    const text = [
      '==> named.ts <==\n   1→kept',
      '==> /etc/passwd <==\n   1→root',
      '==> other.ts <==\n   1→other',
    ].join('\n\n')
    expect(splitBatchReadResult(text, [a], fixtureDir())).toEqual([
      { path: a, text: '   1→kept' },
    ])
  })

  test('a relative label resolves against the working directory before its tail is tried', () => {
    const top = join(fixtureDir(), 'a.ts')
    const nested = join(fixtureDir(), 'sub', 'a.ts')
    const text = '==> a.ts <==\n   1→top\n\n==> sub/a.ts <==\n   1→nested'
    expect(splitBatchReadResult(text, [nested, top], fixtureDir())).toEqual([
      { path: top, text: '   1→top' },
      { path: nested, text: '   1→nested' },
    ])
  })

  test('from another working directory a label matches by its tail, never by a guess', () => {
    const x = join(fixtureDir(), 'pkg', 'x.ts')
    const one = join(fixtureDir(), 'one', 'y.ts')
    const two = join(fixtureDir(), 'two', 'y.ts')
    const text = '==> x.ts <==\n   1→x\n\n==> y.ts <==\n   1→y'
    expect(splitBatchReadResult(text, [x, one, two], fixtureDir())).toEqual([
      { path: x, text: '   1→x' },
    ])
  })

  // The batch reads a path named twice once, under one header, so the call
  // names one file there, not two that share a tail.
  test('a path the call named twice still matches by its tail', () => {
    const x = join(fixtureDir(), 'pkg', 'x.ts')
    const text = '==> x.ts <==\n   1→x'
    expect(splitBatchReadResult(text, [x, x], fixtureDir())).toEqual([
      { path: x, text: '   1→x' },
    ])
  })

  test('the note lines stay text when no blank line sets them apart', () => {
    const a = join(fixtureDir(), 'n.ts')
    const text = '==> n.ts <==\nNot shown — as a line of the file itself'
    expect(splitBatchReadResult(text, [a], fixtureDir())).toEqual([
      { path: a, text: 'Not shown — as a line of the file itself' },
    ])
  })
})
