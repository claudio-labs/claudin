// The default test preload stubs `feature()` → false for every flag, which
// would short-circuit the pivot path under test, and a local
// `mock.module('bun:bundle', …)` runs too late to override the preload.
// FileReadTool exposes a test-only env-var override so we can exercise the
// real gated branch end-to-end. Must be set before importing FileReadTool.
process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION = '1'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import {
  AUTO_OUTLINE_PIVOT_FOOTER,
  FileReadTool,
} from 'src/tools/FileReadTool/FileReadTool.js'

// ---------------------------------------------------------------------------
// AUTO_OUTLINE_ON_ELISION coverage.
//
// When the model receives a literal Read body over ~10 KB it reliably starts
// narrating ("preciso do trecho do meio") and re-reads in smaller windows —
// the dominant narration pattern observed in bench samples. The pivot routes
// those vanilla Reads to the structural outline instead, removing the
// stimulus entirely.
//
// These tests cover the trigger matrix:
//   - vanilla Read on a >10 KB code file → outline + footer
//   - view='full'                        → full body, no footer
//   - offset/limit set                   → full body, no footer
//   - small file                         → full body, no footer
//   - footer text is stable              → exact-match assertion
//   - pivot header                       → "is large", never a cap claim
//   - genuinely over-cap file            → still claims the cap
//   - explicit view='outline'            → neutral header, no footer
// ---------------------------------------------------------------------------

process.env.CLAUDIN_SIMPLE = '1'
process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'

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

function makeContext(fileReadingLimits?: {
  maxSizeBytes: number
  maxTokens: number
}): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits,
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
    // The pivot withholds the body by POLICY — it must not claim a cap was
    // hit. BIG_TS is ~30 KB against a 10 MB byte cap, and the view='full'
    // case below returns that same body in full, so "exceeds the read cap"
    // was telling the model the content was unreachable when it never was.
    expect(rendered.content).not.toContain('exceeds the read cap')
    // Assert the LEAD on the pre-footer content: AUTO_OUTLINE_PIVOT_FOOTER
    // itself contains "File is large", so the same check against `rendered`
    // passes with the header's pivot branch deleted entirely.
    expect(data.file.content).toContain('is large')
    expect(data.file.content).not.toContain('exceeds the read cap')
    expect(rendered.content.endsWith(AUTO_OUTLINE_PIVOT_FOOTER)).toBe(true)
  })

  test('a genuinely over-cap file still says the cap was exceeded', async () => {
    // The discriminator the `reason` parameter exists for. Same fixture, read
    // under a 1 KB cap so readFileInRange really throws FileTooLargeError and
    // the catch-arm outline is the one that answers. Without this the change
    // above could be "fixed" by deleting the cap wording everywhere.
    const p = writeFixture('big-overcap.ts', BIG_TS)
    const { data } = await read(
      p,
      {},
      makeContext({ maxSizeBytes: 1024, maxTokens: 25_000 }),
    )

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.content).toContain('exceeds the read cap')
    // Not a pivot: the body genuinely does not fit, so no opt-in footer.
    expect(data.file.autoPivot).toBeUndefined()
  })

  test("the pivot footer offers view='full', and the header does not", async () => {
    // view='full' is the one-round-trip way back to the body, and measurement
    // said the model never found it: across eight headless A/B runs it was
    // used once in ~200 Reads, while the pivot arm rebuilt each file in ~19
    // repeat slice Reads. The footer named every option except that one.
    const p = writeFixture('big-full-hint.ts', BIG_TS)
    const { data } = await read(p)

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.autoPivot).toBe(true)

    // Split header from footer, the same way the lead assertion above has to.
    // Checking `rendered` alone would still pass if the hint were moved into
    // renderOutline's shared header — where it is a lie for the over-cap arm.
    expect(data.file.content).not.toContain("view='full'")

    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'tool_use_id_test',
    )
    if (typeof rendered.content !== 'string')
      throw new Error('expected string content')
    expect(rendered.content).toContain("view='full'")
    // The suggestion this replaced was a no-op: the pivot and an explicit
    // view='outline' both render through renderBody() under the same token
    // cap, so "use view='outline' to map further" returned the same table.
    expect(rendered.content).not.toContain("view='outline'")
  })

  test("the over-cap outline never offers view='full', which would rethrow", async () => {
    // The over-cap outline comes from a catch arm that also requires
    // view === undefined, so view='full' does not reach a body there — it
    // rethrows FileTooLargeError. This is why the hint lives in the pivot's
    // own footer and not in the header the two arms share.
    const p = writeFixture('big-overcap-hint.ts', BIG_TS)
    const ctx = makeContext({ maxSizeBytes: 1024, maxTokens: 25_000 })
    const { data } = await read(p, {}, ctx)

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.autoPivot).toBeUndefined()
    expect(data.file.content).not.toContain("view='full'")

    await expect(read(p, { view: 'full' }, ctx)).rejects.toThrow()
  })

  test("explicit view='outline' keeps the neutral header and no footer", async () => {
    // Guards the third makeOutlineData call site. Mutation testing found it
    // unguarded: flipping its reason to 'pivot' passed every other test, and
    // an outline the caller asked for would start claiming the file "is
    // large" and pick up the opt-back-in footer for a pivot that never
    // happened.
    const p = writeFixture('big-explicit.ts', BIG_TS)
    const { data } = await read(p, { view: 'outline' })

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.content).toContain('Structural outline')
    expect(data.file.content).not.toContain('is large')
    expect(data.file.content).not.toContain('exceeds the read cap')
    expect(data.file.autoPivot).toBeUndefined()

    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'tool_use_id_test',
    )
    if (typeof rendered.content !== 'string')
      throw new Error('expected string content')
    expect(rendered.content.endsWith(AUTO_OUTLINE_PIVOT_FOOTER)).toBe(false)
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
    // returned verbatim (the pivot only helps the code-file case, where we
    // can produce an outline).
    const p = writeFixture('big.txt', BIG_TS)
    const { data } = await read(p)

    expect(data.type).toBe('text')
  })

  test('footer text is stable (exact-match)', () => {
    expect(AUTO_OUTLINE_PIVOT_FOOTER).toBe(
      "\n\n<system-reminder>File is large; returned outline instead of full body. Pass view='full' to load the whole body in one call, or offset/limit/symbol for a specific range.</system-reminder>",
    )
  })

  test('a large Ruby (.rb) file auto-pivots to an outline', async () => {
    // Same char trigger as TS, exercising a new (end-block) scanner language.
    let body = ''
    for (let i = 0; i < 40; i++) {
      body += [
        `def handler_${i}(arg)`,
        `  # ${'pad-'.repeat(70)}`,
        `  arg * ${i}`,
        'end',
        '',
      ].join('\n')
    }
    expect(body.length).toBeGreaterThan(10_000)
    const p = writeFixture('big.rb', body)
    const { data } = await read(p)

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.autoPivot).toBe(true)
  })

  test('a large SQL (.sql) file auto-pivots to an outline', async () => {
    let body = ''
    for (let i = 0; i < 30; i++) {
      body += [
        `-- ${'pad-'.repeat(70)}`,
        `CREATE TABLE t${i} (`,
        '  id INT PRIMARY KEY,',
        '  name TEXT',
        ');',
        '',
      ].join('\n')
    }
    expect(body.length).toBeGreaterThan(10_000)
    const p = writeFixture('big.sql', body)
    const { data } = await read(p)

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.autoPivot).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Line-count auto-pivot: a long code file with many short lines can stay under
// the 10 KB char trigger while still warranting an outline. Fires only when
// the scan also finds ≥ 3 symbols, so a long single-function file is spared.
// ---------------------------------------------------------------------------

describe('FileReadTool — line-count auto-pivot', () => {
  test('≥250 lines with ≥3 symbols pivots even under the char threshold', async () => {
    const parts: string[] = []
    for (let i = 0; i < 5; i++) {
      parts.push(`def fn${i}`, '  x = 1', '  x', 'end', '')
    }
    // Pad with short comment lines to cross 250 lines while staying < 10 KB.
    while (parts.length < 260) parts.push('# note')
    const body = parts.join('\n')
    expect(body.length).toBeLessThan(10_000)
    expect(body.split('\n').length).toBeGreaterThanOrEqual(250)

    const p = writeFixture('many-lines.rb', body)
    const { data } = await read(p)

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.autoPivot).toBe(true)
  })

  test('a long single-symbol file stays a full read (symbol-count gate)', async () => {
    const parts = ['def only_one']
    while (parts.length < 260) parts.push('  x = 1')
    parts.push('  x', 'end')
    const body = parts.join('\n')
    expect(body.length).toBeLessThan(10_000)
    expect(body.split('\n').length).toBeGreaterThanOrEqual(250)

    const p = writeFixture('one-symbol.rb', body)
    const { data } = await read(p)

    // 1 symbol < 3 → the line trigger declines; the full body is returned.
    expect(data.type).toBe('text')
  })

  test('a short file below both thresholds is unaffected', async () => {
    const p = writeFixture('short.rb', 'def a\n  1\nend\n')
    const { data } = await read(p)
    expect(data.type).toBe('text')
  })
})
