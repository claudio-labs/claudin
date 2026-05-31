// The default test preload stubs `feature()` → false for every flag, which
// would short-circuit the pivot path under test, and a local
// `mock.module('bun:bundle', …)` runs too late to override the preload.
// FileReadTool exposes a test-only env-var override so we can exercise the
// real gated branch end-to-end. Must be set before importing FileReadTool.
process.env.CLAUDIO_FORCE_AUTO_OUTLINE_ON_ELISION = '1'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  AUTO_OUTLINE_PIVOT_FOOTER,
  FileReadTool,
} from './FileReadTool.js'

// ---------------------------------------------------------------------------
// AUTO_OUTLINE_ON_ELISION coverage.
//
// The toolResultSummarizer head-tail-elides any Read whose body is over ~10 KB.
// Models react by narrating ("preciso do trecho do meio") and re-reading in
// smaller windows — the dominant narration pattern observed in bench samples.
// The pivot routes those same vanilla Reads to the structural outline instead,
// so the model never sees a mid-elided body.
//
// These tests cover the trigger matrix:
//   - vanilla Read on a >10 KB code file → outline + footer
//   - view='full'                        → full body, no footer
//   - offset/limit set                   → full body, no footer
//   - small file                         → full body, no footer
//   - footer text is stable              → exact-match assertion
// ---------------------------------------------------------------------------

process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDIO_DISABLE_TOOL_RESULT_CACHE = '1'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fileread-autopivot-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFixture(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits: undefined,
    getAppState: () => ({ toolPermissionContext: {} }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

type ReadInput = {
  offset?: number
  limit?: number
  view?: 'outline' | 'full'
  symbol?: string
}

async function read(
  filePath: string,
  input: ReadInput = {},
  context: ToolUseContext = makeContext(),
) {
  return FileReadTool.call(
    { file_path: filePath, ...input },
    context,
    undefined as never,
    undefined as never,
  )
}

// Builds a TS source whose serialized size comfortably crosses the 10 KB
// auto-pivot threshold while keeping a small, deterministic set of top-level
// symbols so the outline-stage scan returns predictable shapes.
function bigTsSource(): string {
  const padBody = 'const padding = "x".repeat(400)\n'.repeat(8) // ~250 B each
  const fn = (n: number) =>
    [
      `export function fn${n}(arg: number): number {`,
      `  // ${'pad-'.repeat(50)}`,
      padBody,
      `  return arg * ${n}`,
      `}`,
      '',
    ].join('\n')
  let body = ''
  for (let i = 0; i < 24; i++) body += fn(i)
  return body
}

// Quick precondition: our fixture really is big enough to elide.
const BIG_TS = bigTsSource()
if (BIG_TS.length < 10_000) {
  throw new Error(
    `bigTsSource() must exceed 10 KB; got ${BIG_TS.length} chars — adjust the generator.`,
  )
}

describe('FileReadTool — AUTO_OUTLINE_ON_ELISION', () => {
  test('large code file with no view/offset auto-pivots to outline + footer', async () => {
    const p = writeFixture('big.ts', BIG_TS)
    const result = await read(p)
    const { data } = result

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')

    // The outline must flag itself as an auto-pivot so the renderer appends
    // the footer (rather than silently looking like a model-asked outline).
    expect(data.file.autoPivot).toBe(true)

    // Renders correctly through the result formatter and carries the footer
    // verbatim — this is what the model actually sees in tool_result.
    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'tool_use_id_test',
    )
    expect(typeof rendered.content).toBe('string')
    if (typeof rendered.content !== 'string')
      throw new Error('expected string content')
    expect(rendered.content).toContain('exceeds the read cap')
    expect(rendered.content.endsWith(AUTO_OUTLINE_PIVOT_FOOTER)).toBe(true)
  })

  test("view='full' on a large code file returns full body, no footer", async () => {
    const p = writeFixture('big-full.ts', BIG_TS)
    const { data } = await read(p, { view: 'full' })

    expect(data.type).toBe('text')
    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.content.length).toBeGreaterThanOrEqual(10_000)
    expect(data.file.startLine).toBe(1)
  })

  test('offset on a large code file returns the targeted slice, no pivot', async () => {
    const p = writeFixture('big-offset.ts', BIG_TS)
    const { data } = await read(p, { offset: 10, limit: 5 })

    expect(data.type).toBe('text')
    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.startLine).toBe(10)
    expect(data.file.numLines).toBe(5)
  })

  test('small code file under the threshold returns full body, no pivot', async () => {
    const small = [
      'export function tiny(x: number): number {',
      '  return x + 1',
      '}',
    ].join('\n')
    const p = writeFixture('tiny.ts', small)
    const { data } = await read(p)

    expect(data.type).toBe('text')
    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.content).toBe(small)
  })

  test('non-code large file does not auto-pivot (no outline language)', async () => {
    // .txt has no outlineLang → the pivot guard skips and the full body is
    // returned (and will be head-tail elided downstream, as before — the
    // pivot only helps the code-file case, where we can produce an outline).
    const p = writeFixture('big.txt', BIG_TS)
    const { data } = await read(p)

    expect(data.type).toBe('text')
  })

  test('footer text is stable (exact-match)', () => {
    expect(AUTO_OUTLINE_PIVOT_FOOTER).toBe(
      "\n\n<system-reminder>File is large; returned outline instead of full body. Use view='outline' explicitly to map further, or pass offset/limit/symbol to load a specific range.</system-reminder>",
    )
  })
})
