import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { READ_FILE_STATE_CACHE_SIZE } from '../../utils/fileStateCache.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  buildClipStub,
  buildClipStubWithHead,
} from '../../services/compact/stableStubState.js'
import {
  getCached,
  invalidateAll,
} from '../../services/tools/toolResultCache.js'
import {
  assistantWithAppliedEdits,
  assistantWithClearing,
  userWithToolResult,
} from './__test-helpers__/contextManagementFixtures.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
  scanFile,
} from './FileReadTool.js'

// ---------------------------------------------------------------------------
// Baseline regression suite for FileReadTool.
//
// Captured BEFORE the Smart Code Navigation feature (view/symbol/outline) is
// added, so the history proves these paths behaved as expected on the
// pre-feature codebase. The feature commits append their own cases below.
// ---------------------------------------------------------------------------

// Skill discovery touches the real filesystem and is irrelevant here.
process.env.CLAUDE_CODE_SIMPLE = '1'
// The tool-result cache short-circuits call() on identical inputs, which would
// mask the in-call dedup path we want to exercise. Disable it for this suite.
process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'

// Frozen body for the token-cap test — the VCR fixture key depends on it.
const TOKEN_CAP_BODY =
  Array.from({ length: 80 }, (_, i) => `const value${i} = ${i} + ${i};`).join(
    '\n',
  ) + '\n'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fileread-regression-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFixture(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

type ContextOverrides = {
  fileReadingLimits?: ToolUseContext['fileReadingLimits']
  messages?: unknown[]
  toolUseId?: string
}

function makeContext(overrides: ContextOverrides = {}): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits: overrides.fileReadingLimits,
    messages: overrides.messages,
    toolUseId: overrides.toolUseId,
    getAppState: () => ({ toolPermissionContext: {} }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

/** Swap the transcript a context exposes to the dedup scanners mid-test —
 *  mirrors toolUseContext.messages being reassigned each query iteration. */
function setContextMessages(ctx: ToolUseContext, messages: unknown[]): void {
  ;(ctx as unknown as { messages: unknown[] }).messages = messages
}

type ReadInput = {
  offset?: number
  limit?: number
  view?: 'outline'
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

describe('FileReadTool — baseline regression', () => {
  test('reads a plain text file in full', async () => {
    const p = writeFixture('plain.txt', 'line one\nline two\nline three')
    const { data } = await read(p)

    expect(data.type).toBe('text')
    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.content).toBe('line one\nline two\nline three')
    expect(data.file.numLines).toBe(3)
    expect(data.file.startLine).toBe(1)
    expect(data.file.totalLines).toBe(3)
  })

  test('honors offset and limit (partial view)', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join('\n')
    const p = writeFixture('partial.txt', lines)

    const { data } = await read(p, { offset: 5, limit: 3 })
    if (data.type !== 'text') throw new Error('expected text')

    expect(data.file.startLine).toBe(5)
    expect(data.file.numLines).toBe(3)
    expect(data.file.content).toBe('row 5\nrow 6\nrow 7')
    expect(data.file.totalLines).toBe(20)
  })

  test('throws when the file exceeds the byte cap', async () => {
    const big = 'x'.repeat(4096) + '\n'
    const p = writeFixture('toobig-bytes.txt', big)
    const ctx = makeContext({
      fileReadingLimits: { maxSizeBytes: 1024, maxTokens: 25000 },
    })

    await expect(read(p, {}, ctx)).rejects.toThrow(
      /exceeds maximum allowed size/i,
    )
  })

  test('throws MaxFileReadTokenExceededError when a non-code file exceeds the token cap', async () => {
    // ~2 KB of text. With maxTokens=200 the estimate exceeds the cap.
    // A non-code extension (.txt) has no outline language, so the over-cap
    // path still throws — code files now degrade to an outline instead
    // (covered in the Smart Code Navigation suite below).
    // validateContentTokens calls countTokensWithAPI, which the VCR layer
    // records under fixtures/token-count-*.json (keyed by this exact body).
    // The fixture is committed; do not edit TOKEN_CAP_BODY without re-recording
    // via VCR_RECORD=1.
    const body = TOKEN_CAP_BODY
    const p = writeFixture('toobig-tokens.txt', body)
    const ctx = makeContext({
      fileReadingLimits: { maxSizeBytes: 10 * 1024 * 1024, maxTokens: 200 },
    })

    await expect(read(p, {}, ctx)).rejects.toBeInstanceOf(
      MaxFileReadTokenExceededError,
    )
  })

  test('dedups a repeated read of the same range when the file is unchanged', async () => {
    const p = writeFixture('dedup.txt', 'alpha\nbeta\ngamma')
    const ctx = makeContext()

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('returns an empty-content text result for an empty file', async () => {
    const p = writeFixture('empty.txt', '')
    const { data } = await read(p)
    if (data.type !== 'text') throw new Error('expected text')

    expect(data.file.content).toBe('')
  })

  test('returns empty content when offset is past the end of the file', async () => {
    const p = writeFixture('short.txt', 'one\ntwo')
    const { data } = await read(p, { offset: 100 })
    if (data.type !== 'text') throw new Error('expected text')

    expect(data.file.content).toBe('')
    expect(data.file.totalLines).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Smart Code Navigation — view / symbol / auto-outline.
// ---------------------------------------------------------------------------

const SAMPLE_TS = [
  'export function alpha(x: number): number {',
  '  return x + 1',
  '}',
  '',
  'export class Widget {',
  '  render(): string {',
  '    return "w"',
  '  }',
  '}',
  '',
  'export const beta = (y: number) => {',
  '  return y * 2',
  '}',
].join('\n')

describe('FileReadTool — Smart Code Navigation', () => {
  test("view='outline' returns the structural skeleton of a small file", async () => {
    const p = writeFixture('sample-outline.ts', SAMPLE_TS)
    const { data } = await read(p, { view: 'outline' })

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.symbolCount).toBe(4) // alpha, Widget, render, beta
    expect(data.file.content).toContain('Structural outline')
    expect(data.file.content).toContain('function alpha(x: number)')
    expect(data.file.content).toContain('class Widget')
  })

  test("symbol='name' expands one function with its real line numbers", async () => {
    const p = writeFixture('sample-symbol.ts', SAMPLE_TS)
    const { data } = await read(p, { symbol: 'beta' })

    expect(data.type).toBe('text')
    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.startLine).toBe(11)
    expect(data.file.numLines).toBe(3)
    expect(data.file.content).toBe(
      'export const beta = (y: number) => {\n  return y * 2\n}',
    )
  })

  test('symbol takes precedence over offset/limit', async () => {
    const p = writeFixture('sample-precedence.ts', SAMPLE_TS)
    const { data } = await read(p, { symbol: 'alpha', offset: 99, limit: 1 })

    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.startLine).toBe(1)
    expect(data.file.content).toContain('function alpha')
  })

  test('an unknown symbol throws a friendly error listing the real ones', async () => {
    const p = writeFixture('sample-missing.ts', SAMPLE_TS)

    await expect(read(p, { symbol: 'doesNotExist' })).rejects.toThrow(
      /not found.*alpha.*Widget/s,
    )
  })

  test('a code file over the byte cap auto-degrades to an outline', async () => {
    const p = writeFixture('overcap.ts', SAMPLE_TS)
    const ctx = makeContext({
      fileReadingLimits: { maxSizeBytes: 40, maxTokens: 25000 },
    })
    const { data } = await read(p, {}, ctx)

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.content).toContain('exceeds the read cap')
    expect(data.file.symbolCount).toBe(4)
  })

  test('a non-code file over the byte cap still throws (degrade preserved)', async () => {
    const p = writeFixture('overcap.txt', SAMPLE_TS)
    const ctx = makeContext({
      fileReadingLimits: { maxSizeBytes: 40, maxTokens: 25000 },
    })

    await expect(read(p, {}, ctx)).rejects.toThrow(
      /exceeds maximum allowed size/i,
    )
  })

  test('a code file with no scannable symbols falls back to a normal read', async () => {
    const p = writeFixture('nosymbols.ts', 'doThing()\nlogOther()\n')
    const { data } = await read(p, { view: 'outline' })

    // scanSymbols returns [] → degrade to a normal text read.
    expect(data.type).toBe('text')
  })

  test("symbol='name' on overloaded functions expands the implementation", async () => {
    const overloaded = [
      'export function pick(x: number): number;',
      'export function pick(x: string): string;',
      'export function pick(x: number | string) {',
      '  return x',
      '}',
    ].join('\n')
    const p = writeFixture('overloaded.ts', overloaded)
    const { data } = await read(p, { symbol: 'pick' })

    if (data.type !== 'text') throw new Error('expected text')
    // Must land on the implementation (lines 3-5), not a 1-line overload stub.
    expect(data.file.startLine).toBe(3)
    expect(data.file.numLines).toBe(3)
    expect(data.file.content).toContain('return x')
  })
})

// ---------------------------------------------------------------------------
// Smart Code Navigation — one language per scanner family (C-like, end-block,
// dedicated) exercised end-to-end through the tool: outline, symbol unfold,
// and the symbol-not-found error.
// ---------------------------------------------------------------------------

const SAMPLE_CPP = [
  'struct Point {',
  '  int x;',
  '};',
  '',
  'int add(int a, int b) {',
  '  return a + b;',
  '}',
].join('\n')

const SAMPLE_RB = [
  'class Greeter',
  '  def greet(name)',
  '    "hi #{name}"',
  '  end',
  'end',
].join('\n')

const SAMPLE_SQL = [
  'CREATE TABLE users (',
  '  id INT',
  ');',
  '',
  'CREATE VIEW active AS SELECT 1;',
].join('\n')

const SAMPLE_CSS = ['.header {', '  color: red;', '}'].join('\n')

const SAMPLE_HTML = ['<main id="app">', '  <h1>Title</h1>', '</main>'].join('\n')

describe('FileReadTool — Smart Code Navigation across scanner families', () => {
  test("view='outline' works for a C++ file (.cpp)", async () => {
    const p = writeFixture('sample.cpp', SAMPLE_CPP)
    const { data } = await read(p, { view: 'outline' })

    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.content).toContain('struct Point')
    expect(data.file.content).toContain('int add(int a, int b)')
  })

  test("symbol='add' unfolds one C++ function with real line numbers", async () => {
    const p = writeFixture('sample-sym.cpp', SAMPLE_CPP)
    const { data } = await read(p, { symbol: 'add' })

    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.startLine).toBe(5)
    expect(data.file.content).toContain('int add(int a, int b)')
  })

  test('a Ruby file (.rb) outlines its class and method', async () => {
    const p = writeFixture('greeter.rb', SAMPLE_RB)
    const { data } = await read(p, { view: 'outline' })

    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.symbolCount).toBe(2) // Greeter + greet
    expect(data.file.content).toContain('class Greeter')
  })

  test('an unknown symbol in a Ruby file lists the real ones', async () => {
    const p = writeFixture('greeter-missing.rb', SAMPLE_RB)
    await expect(read(p, { symbol: 'nope' })).rejects.toThrow(
      /not found.*Greeter.*greet/s,
    )
  })

  test('a SQL file (.sql) outlines CREATE statements', async () => {
    const p = writeFixture('schema.sql', SAMPLE_SQL)
    const { data } = await read(p, { view: 'outline' })

    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.content).toContain('CREATE TABLE users')
    expect(data.file.content).toContain('CREATE VIEW active')
  })

  test('a CSS file (.css) outlines its selectors', async () => {
    const p = writeFixture('style.css', SAMPLE_CSS)
    const { data } = await read(p, { view: 'outline' })

    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.content).toContain('.header')
  })

  test('an HTML file (.html) outlines landmarks and headings', async () => {
    const p = writeFixture('page.html', SAMPLE_HTML)
    const { data } = await read(p, { view: 'outline' })

    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.content).toContain('main#app')
    expect(data.file.content).toContain('Title')
  })

  test('scanFile surfaces the byte-cap truncation flag (small injected cap)', async () => {
    // A ~4 KB C file read under a tiny 200-byte scan cap must flag the scan
    // as truncated — no real multi-MB fixture needed.
    const padded = SAMPLE_CPP + '\n' + 'int filler = 0;\n'.repeat(300)
    const p = writeFixture('truncated.cpp', padded)
    const signal = new AbortController().signal

    const capped = await scanFile(p, 'c', signal, { maxBytes: 200 })
    expect(capped?.truncated).toBe(true)

    const full = await scanFile(p, 'c', signal)
    expect(full?.truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Line numbering & line counting — cat -n semantics.
// ---------------------------------------------------------------------------

describe('FileReadTool — line numbering and counting', () => {
  let savedDisableReminders: string | undefined

  beforeAll(() => {
    // Make mapToolResultToToolResultBlockParam output deterministic: no
    // model-dependent mitigation reminder, no serial-read nudge.
    savedDisableReminders = process.env.CLAUDIN_DISABLE_TOOL_REMINDERS
    process.env.CLAUDIN_DISABLE_TOOL_REMINDERS = '1'
  })

  afterAll(() => {
    if (savedDisableReminders === undefined) {
      delete process.env.CLAUDIN_DISABLE_TOOL_REMINDERS
    } else {
      process.env.CLAUDIN_DISABLE_TOOL_REMINDERS = savedDisableReminders
    }
  })

  function mapToText(data: Awaited<ReturnType<typeof read>>['data']): string {
    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu_test',
    )
    if (typeof block.content !== 'string') {
      throw new Error('expected string tool_result content')
    }
    return block.content
  }

  test('offset 0 is treated as line 1 — numbering never starts at 0', async () => {
    const p = writeFixture('offset-zero.txt', 'first\nsecond')
    const { data } = await read(p, { offset: 0 })

    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.startLine).toBe(1)
    expect(data.file.content).toBe('first\nsecond')
    expect(mapToText(data)).toBe('1→first\n2→second')
  })

  test('offset 0 and a default read dedup as the same range', async () => {
    const p = writeFixture('offset-zero-dedup.txt', 'alpha\nbeta')
    const ctx = makeContext()

    const first = (await read(p, { offset: 0 }, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('a trailing newline does not produce a phantom numbered line', async () => {
    const p = writeFixture('trailing-newline.txt', 'a\nb\n')
    const { data } = await read(p)

    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.numLines).toBe(2)
    expect(data.file.totalLines).toBe(2)
    expect(mapToText(data)).toBe('1→a\n2→b')
  })

  test('an empty file maps to the empty-contents warning', async () => {
    const p = writeFixture('empty-warning.txt', '')
    const { data } = await read(p)

    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.numLines).toBe(0)
    expect(data.file.totalLines).toBe(0)
    expect(mapToText(data)).toBe(
      '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
    )
  })

  test('an offset past the end maps to the shorter-than-offset warning', async () => {
    const p = writeFixture('past-end-warning.txt', 'one\ntwo')
    const { data } = await read(p, { offset: 100 })

    if (data.type !== 'text') throw new Error('expected text')
    expect(mapToText(data)).toContain(
      'shorter than the provided offset (100). The file has 2 lines.',
    )
  })

  test('the shorter-than-offset warning uses the singular for 1 line', async () => {
    const p = writeFixture('past-end-singular.txt', 'only\n')
    const { data } = await read(p, { offset: 100 })

    if (data.type !== 'text') throw new Error('expected text')
    expect(mapToText(data)).toContain('The file has 1 line.')
  })

  test('a file containing only a newline renders one numbered empty line', async () => {
    const p = writeFixture('only-newline.txt', '\n')
    const { data } = await read(p)

    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.numLines).toBe(1)
    expect(data.file.totalLines).toBe(1)
    // One empty line 1 — not the empty-file warning.
    expect(mapToText(data)).toBe('1→')
  })

  test('outline totalLines ignores the phantom line of a trailing newline', async () => {
    const p = writeFixture('outline-trailing.ts', SAMPLE_TS + '\n')
    const { data } = await read(p, { view: 'outline' })

    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.totalLines).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// Dedup vs server-side clear_tool_uses — once the API has cleared old
// tool_results, the file_unchanged stub would point at content the model can
// no longer see, so dedup must stand down. See serverClearingDetection.ts.
// ---------------------------------------------------------------------------

describe('FileReadTool — dedup vs server-side tool clearing', () => {
  test('dedup is suppressed once clearing has been applied in the session', async () => {
    const p = writeFixture('dedup-cleared.txt', 'alpha\nbeta')
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    // Same file, same range, unchanged on disk — would normally dedup to a
    // file_unchanged stub. With clearing evidence in the transcript the full
    // content must be re-sent.
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
    if (second.type !== 'text') throw new Error('expected text')
    expect(second.file.content).toBe('alpha\nbeta')
  })

  test('an applied edit that cleared nothing keeps dedup active', async () => {
    const p = writeFixture('dedup-noop-clear.txt', 'alpha\nbeta')
    const ctx = makeContext({ messages: [assistantWithClearing(0)] })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('a clear_thinking edit keeps dedup active — it leaves tool_results alone', async () => {
    const p = writeFixture('dedup-clear-thinking.txt', 'alpha\nbeta')
    const ctx = makeContext({
      messages: [
        assistantWithAppliedEdits([
          { type: 'clear_thinking_20251015', cleared_thinking_turns: 2 },
        ]),
      ],
    })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('a context without messages keeps dedup active', async () => {
    const p = writeFixture('dedup-no-messages.txt', 'alpha\nbeta')
    const ctx = makeContext()

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })
})

// ---------------------------------------------------------------------------
// Dedup vs client-side clipping — the in-process clip paths (age prune, RSS
// byte-guard, time-based clear, microcompact stable stubs) rewrite old
// tool_results to clip stubs without touching readFileState. The entry
// records the Read's toolUseId; dedup must stand down when THAT tool_result
// is clipped or gone from the transcript. See clientClippingDetection.ts.
// ---------------------------------------------------------------------------

describe('FileReadTool — dedup vs client-side clipping', () => {
  const ID = 'toolu_client_clip'

  test('dedup is suppressed when the prior tool_result was clipped to a pure stub', async () => {
    const p = writeFixture('dedup-clipped-pure.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    setContextMessages(ctx, [
      userWithToolResult(ID, buildClipStub('Read', 1234)),
    ])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
    if (second.type !== 'text') throw new Error('expected text')
    expect(second.file.content).toBe('alpha\nbeta')
  })

  test('dedup is suppressed when the prior tool_result was clipped to a head-preserving stub', async () => {
    const p = writeFixture('dedup-clipped-head.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    setContextMessages(ctx, [
      userWithToolResult(ID, buildClipStubWithHead('Read', 1234, 'alpha')),
    ])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
  })

  test('dedup stays active while the prior tool_result is intact in the transcript', async () => {
    const p = writeFixture('dedup-intact.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    setContextMessages(ctx, [
      userWithToolResult(ID, '     1\talpha\n     2\tbeta'),
    ])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('dedup is suppressed when the prior tool_result is missing from the transcript', async () => {
    const p = writeFixture('dedup-missing.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    // A present messages array with no trace of the prior Read — the stub
    // would point at nothing. Fail toward correctness: re-send.
    setContextMessages(ctx, [])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
  })

  test('an entry without a recorded toolUseId keeps the pre-existing dedup behavior', async () => {
    const p = writeFixture('dedup-no-tooluseid.txt', 'alpha\nbeta')
    // No toolUseId on the context → the entry records none → the clipping
    // scan cannot run, even though the transcript holds a clipped result.
    const ctx = makeContext({
      messages: [userWithToolResult(ID, buildClipStub('Read', 50))],
    })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('a recorded toolUseId with no messages array keeps dedup active', async () => {
    const p = writeFixture('dedup-id-no-messages.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })
})

// ---------------------------------------------------------------------------
// Dedup stub vs the local tool-result cache — a cached file_unchanged would
// be replayed for the TTL window without running call(), bypassing the
// server-clearing / client-clipping stand-downs exactly when a clip lands
// right after a legitimate dedup hit. The stub must never be stored.
// ---------------------------------------------------------------------------

describe('FileReadTool — dedup stub is not stored in the tool-result cache', () => {
  test('file_unchanged is recomputed per call; text results still cache', async () => {
    const p = writeFixture('dedup-nocache.txt', 'alpha\nbeta')
    const ctx = makeContext()
    // The suite disables the cache at module load (the wrapper reads the env
    // per call); enable it for this test only.
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    try {
      const first = (await read(p, {}, ctx)).data
      expect(first.type).toBe('text')
      // Normal results keep getting cached — the noResultCache flag must not
      // widen into a blanket opt-out.
      expect(getCached('Read', { file_path: p })).toBeDefined()

      // Force the next call through to dedup: a cache hit would replay the
      // full text and never reach it.
      invalidateAll()
      const second = (await read(p, {}, ctx)).data
      expect(second.type).toBe('file_unchanged')

      // The decisive assertion: the stub was NOT stored, so the next
      // identical call re-enters call() and re-evaluates the stand-downs.
      expect(getCached('Read', { file_path: p })).toBeUndefined()
    } finally {
      process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
      invalidateAll()
    }
  })
})

// ---------------------------------------------------------------------------
// Re-read circuit breaker — when the same (file, range) keeps being clipped
// out of context and the model keeps re-reading, the dedup stand-down re-sends
// the full body forever (it just gets clipped again). After K consecutive
// clipped stand-downs the breaker trips and serves a stable form (the file's
// structural outline for code, a textual redirect stub otherwise) instead.
// ---------------------------------------------------------------------------

const BREAKER_ID = 'toolu_rerun_breaker'

/** Read `p` with the transcript showing the prior Read's result clipped to a
 *  stub — the exact condition the client-clipping stand-down detects. Returns
 *  the full call result so callers can inspect `noResultCache`. */
async function readWithPriorClipped(
  p: string,
  ctx: ToolUseContext,
  input: ReadInput = {},
) {
  setContextMessages(ctx, [
    userWithToolResult(BREAKER_ID, buildClipStub('Read', 1234)),
  ])
  return read(p, input, ctx)
}

describe('FileReadTool — re-read breaker disabled (default) never trips', () => {
  test('five consecutive clipped stand-downs all re-send the full body', async () => {
    const p = writeFixture('breaker-off.ts', SAMPLE_TS)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    for (let i = 0; i < 5; i++) {
      const { data } = await readWithPriorClipped(p, ctx)
      expect(data.type).toBe('text')
    }
  })
})

describe('FileReadTool — re-read breaker (forced on)', () => {
  beforeAll(() => {
    process.env.CLAUDIN_FORCE_READ_RERUN_BREAKER = '1'
  })
  afterAll(() => {
    delete process.env.CLAUDIN_FORCE_READ_RERUN_BREAKER
  })

  test('trips on the 3rd consecutive clipped stand-down of a code range → serves an outline', async () => {
    const p = writeFixture('breaker-trip.ts', SAMPLE_TS)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    // read 1: fresh full read (no prior state to dedup against).
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    // stand-downs 1 and 2 (below K): re-send the full body.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')

    // stand-down 3: TRIP.
    const tripped = await readWithPriorClipped(p, ctx)
    expect(tripped.data.type).toBe('rerun_breaker')
    if (tripped.data.type !== 'rerun_breaker') throw new Error('expected breaker')
    expect(tripped.data.file.servedOutline).toBe(true)
    // The served message is the structural outline (carries symbol names) plus
    // a redirect footer telling the model to stop re-reading.
    expect(tripped.data.file.message).toContain('alpha')
    // Footer-exclusive text: renderOutline's own body also mentions symbol=,
    // so asserting /symbol=/ alone is tautological — this string only exists
    // in the breaker footer (audit finding).
    expect(tripped.data.file.message).toContain('keeps clipping it out')
    // Cache-safety: transcript-dependent, must never be replayed from cache.
    // (noResultCache is optional across the call() return union; cast to read.)
    expect((tripped as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('stays tripped on further same-range re-reads (no re-loop into a full read)', async () => {
    const p = writeFixture('breaker-stays.ts', SAMPLE_TS)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    for (let i = 0; i < 3; i++) await readWithPriorClipped(p, ctx)
    // 3rd stand-down tripped above; the 4th and 5th keep serving the outline.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('rerun_breaker')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('rerun_breaker')
  })

  test('non-code file (no symbols to outline) trips to a textual redirect stub', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `plain line ${i}`).join(
      '\n',
    )
    const p = writeFixture('breaker-noncode.txt', body)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    for (let i = 0; i < 3; i++) await readWithPriorClipped(p, ctx)
    const tripped = await readWithPriorClipped(p, ctx)
    expect(tripped.data.type).toBe('rerun_breaker')
    if (tripped.data.type !== 'rerun_breaker') throw new Error('expected breaker')
    expect(tripped.data.file.servedOutline).toBe(false)
    expect(tripped.data.file.message).toMatch(/re-read/i)
    expect((tripped as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('the server-clearing stand-down arm also counts toward the breaker', async () => {
    const p = writeFixture('breaker-servercleared.ts', SAMPLE_TS)
    const ctx = makeContext({
      toolUseId: BREAKER_ID,
      messages: [assistantWithClearing(4)],
    })

    // Static server-cleared transcript on every read.
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    expect((await read(p, {}, ctx)).data.type).toBe('rerun_breaker')
  })

  test('CLAUDIN_DISABLE_READ_RERUN_BREAKER wins over the force flag', async () => {
    process.env.CLAUDIN_DISABLE_READ_RERUN_BREAKER = '1'
    try {
      const p = writeFixture('breaker-disabled.ts', SAMPLE_TS)
      const ctx = makeContext({ toolUseId: BREAKER_ID })
      for (let i = 0; i < 6; i++) {
        expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
      }
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_RERUN_BREAKER
    }
  })

  test('a different range between clips resets the counter', async () => {
    const p = writeFixture('breaker-reset-range.ts', SAMPLE_TS)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    // Build the count on the default range up to 2 (would trip on the next).
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    // Read a DIFFERENT range — overwrites the entry, dropping the streak.
    await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })
    // Back to the default range: the streak is gone, so three fresh reads
    // stay text (none of them is the 3rd consecutive same-range stand-down).
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('an intact-content dedup hit between clips resets the counter', async () => {
    const p = writeFixture('breaker-reset-intact.ts', SAMPLE_TS)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    // Two clipped stand-downs (count reaches 2).
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    // A read where the prior result is INTACT → normal dedup hit, resets.
    setContextMessages(ctx, [
      userWithToolResult(BREAKER_ID, '     1\texport function alpha'),
    ])
    expect((await read(p, {}, ctx)).data.type).toBe('file_unchanged')
    // Clip again: the counter restarted, so the immediate re-reads are text.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('an explicit-range streak does not leak into the vanilla range', async () => {
    const p = writeFixture('breaker-vanilla-leak.ts', SAMPLE_TS)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    // Streak of 2 on an explicit range.
    await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })
    await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })
    await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })
    // Switch to vanilla full reads (offset=1, no limit): the range change
    // must reset the streak — the explicit-range count must NOT carry over
    // and trip the vanilla range one clip early (audit finding: the vanilla
    // transition hit neither explicit clear).
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    // And the vanilla streak still counts correctly from its own zero.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('rerun_breaker')
  })

  test('an Edit/Write-style overwrite resets the streak', async () => {
    const p = writeFixture('breaker-edit-reset.ts', SAMPLE_TS)
    const ctx = makeContext({ toolUseId: BREAKER_ID })

    // Streak of 2 on the default range.
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    // Simulate FileEditTool/FileWriteTool updating readFileState after an
    // edit: offset/limit undefined. Post-edit content is fresh, so the loop
    // streak must not survive it (audit finding: the side-map outlived the
    // overwrite the committed version relied on).
    ctx.readFileState.set(p, {
      content: SAMPLE_TS,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
    })
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('bumpRerunCount restarts at 1 on a range mismatch (side-map contract)', () => {
    // Direct contract test: this restart is redundant with set() invalidation
    // in every Read flow, but it is the only guard on paths that bypass set()
    // (load()/clone) — pin it so it can't silently rot (round-2 audit).
    const cache = makeContext().readFileState
    expect(cache.bumpRerunCount('/tmp/f.ts', 1, undefined)).toBe(1)
    expect(cache.bumpRerunCount('/tmp/f.ts', 1, undefined)).toBe(2)
    // Different range → streak restarts, not continues.
    expect(cache.bumpRerunCount('/tmp/f.ts', 5, 10)).toBe(1)
    // And the new range now accrues normally.
    expect(cache.bumpRerunCount('/tmp/f.ts', 5, 10)).toBe(2)
  })
})
