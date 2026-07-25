import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { READ_FILE_STATE_CACHE_SIZE } from '../../utils/fileStateCache.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
} from '../../utils/fileStateCache.js'
import {
  buildClipStub,
  buildClipStubWithHead,
  _resetAllClippedIdsForTesting,
  isPinRegistered,
  pinToolResult,
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
// Clip-pin stand-down — when a Read's tool_result is clipped out of context and
// the model re-reads the same (file, range), re-sending the body is only useful
// if the copy survives: the stand-down therefore re-sends ONCE and pins that
// copy, which every clip path skips. If the pinned copy is clipped anyway
// (server-side clear, eviction), re-sending is provably futile and a stable
// form is served instead — the file's structural outline for code, a textual
// redirect stub otherwise.
// ---------------------------------------------------------------------------

let pinIdSeq = 0
/** tool_use id of the most recent read issued through the helpers below. */
let lastReadToolUseId = ''

function assignFreshToolUseId(ctx: ToolUseContext): void {
  lastReadToolUseId = `toolu_clip_pin_${++pinIdSeq}`
  ;(ctx as unknown as { toolUseId: string }).toolUseId = lastReadToolUseId
}

/** Read `p` with the transcript showing the PRIOR Read's result clipped to a
 *  stub — the exact condition the client-clipping stand-down detects. Each call
 *  gets its own tool_use id, like a real turn, so pins never conflate two
 *  reads. Returns the full call result so callers can inspect `noResultCache`. */
async function readWithPriorClipped(
  p: string,
  ctx: ToolUseContext,
  input: ReadInput = {},
) {
  const priorId = ctx.readFileState.get(p)?.toolUseId
  setContextMessages(
    ctx,
    priorId ? [userWithToolResult(priorId, buildClipStub('Read', 1234))] : [],
  )
  assignFreshToolUseId(ctx)
  return read(p, input, ctx)
}

describe('FileReadTool — clip pin disabled (default) never falls back', () => {
  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })

  test('five consecutive clipped stand-downs all re-send the full body', async () => {
    const p = writeFixture('clip-pin-off.ts', SAMPLE_TS)
    const ctx = makeContext()

    for (let i = 0; i < 5; i++) {
      const { data } = await readWithPriorClipped(p, ctx)
      expect(data.type).toBe('text')
    }
    // Gate off ⇒ nothing was pinned either.
    expect(isPinRegistered(lastReadToolUseId)).toBe(false)
  })
})

describe('FileReadTool — clip pin (forced on)', () => {
  beforeAll(() => {
    process.env.CLAUDIN_FORCE_READ_CLIP_PIN = '1'
  })
  afterAll(() => {
    delete process.env.CLAUDIN_FORCE_READ_CLIP_PIN
  })
  // The pin registry is module-global state; isolate each case.
  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })

  test('the first clipped stand-down re-sends the body and pins the copy', async () => {
    const p = writeFixture('clip-pin-first.ts', SAMPLE_TS)
    const ctx = makeContext()

    // read 1: fresh full read (no prior state to dedup against) — nothing to
    // stand down from, so nothing to protect yet.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect(isPinRegistered(lastReadToolUseId)).toBe(false)

    // read 2: the prior result is clipped → stand down, re-send the body, and
    // pin THIS copy so the next clip pass skips it (that is what ends the loop
    // in production; here the fixture keeps clipping regardless).
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect(isPinRegistered(lastReadToolUseId)).toBe(true)
  })

  test('a pinned copy that is clipped anyway serves an outline instead of re-sending', async () => {
    const p = writeFixture('clip-pin-fallback.ts', SAMPLE_TS)
    const ctx = makeContext()

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')

    // The pinned copy got clipped too → re-sending is futile.
    const tripped = await readWithPriorClipped(p, ctx)
    expect(tripped.data.type).toBe('clip_pin_fallback')
    if (tripped.data.type !== 'clip_pin_fallback') {
      throw new Error('expected the clip-pin fallback')
    }
    expect(tripped.data.file.servedOutline).toBe(true)
    // The served message is the structural outline (carries symbol names) plus
    // a redirect footer telling the model to stop re-reading.
    expect(tripped.data.file.message).toContain('alpha')
    // Footer-exclusive text: renderOutline's own body also mentions symbol=,
    // so asserting /symbol=/ alone is tautological — this string only exists
    // in the fallback footer (audit finding).
    expect(tripped.data.file.message).toContain('even though it was protected')
    // Cache-safety: transcript-dependent, must never be replayed from cache.
    // (noResultCache is optional across the call() return union; cast to read.)
    expect((tripped as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('stays on the fallback for further same-range re-reads (no flip-flop back to a re-send)', async () => {
    const p = writeFixture('clip-pin-stays.ts', SAMPLE_TS)
    const ctx = makeContext()

    for (let i = 0; i < 3; i++) await readWithPriorClipped(p, ctx)
    // The 3rd read fell back above; the 4th and 5th keep serving the outline.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
  })

  test('non-code file (no symbols to outline) falls back to a textual redirect stub', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `plain line ${i}`).join(
      '\n',
    )
    const p = writeFixture('clip-pin-noncode.txt', body)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const tripped = await readWithPriorClipped(p, ctx)
    expect(tripped.data.type).toBe('clip_pin_fallback')
    if (tripped.data.type !== 'clip_pin_fallback') {
      throw new Error('expected the clip-pin fallback')
    }
    expect(tripped.data.file.servedOutline).toBe(false)
    expect(tripped.data.file.message).toMatch(/re-read/i)
    expect((tripped as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('the server-clearing arm reaches the fallback but never claims the copy was protected', async () => {
    const p = writeFixture('clip-pin-servercleared.ts', SAMPLE_TS)
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })

    // Static server-cleared transcript on every read; fresh id per read.
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    assignFreshToolUseId(ctx)
    const tripped = await read(p, {}, ctx)
    expect(tripped.data.type).toBe('clip_pin_fallback')
    if (tripped.data.type !== 'clip_pin_fallback') {
      throw new Error('expected the clip-pin fallback')
    }
    // clear_tool_uses latches session-wide and reports counts only, so we never
    // observe THIS result being cleared — and a client-side pin cannot stop
    // server-side clearing anyway. Borrowing the clipped arm's wording here
    // would tell the model something we did not verify.
    expect(tripped.data.file.message).not.toContain('even though it was protected')
    expect(tripped.data.file.message).toContain('the API keeps clearing tool results')
  })

  test('CLAUDIN_DISABLE_READ_CLIP_PIN wins over the force flag', async () => {
    process.env.CLAUDIN_DISABLE_READ_CLIP_PIN = '1'
    try {
      const p = writeFixture('clip-pin-disabled.ts', SAMPLE_TS)
      const ctx = makeContext()
      for (let i = 0; i < 6; i++) {
        expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
      }
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_CLIP_PIN
    }
  })

  test('a different range gets its own pin, not the previous range\u2019s', async () => {
    const p = writeFixture('clip-pin-range.ts', SAMPLE_TS)
    const ctx = makeContext()

    // Default range: fresh read, then a stand-down that pins its copy.
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    // A DIFFERENT range overwrites the entry (new id, unpinned), so its first
    // clipped stand-down re-sends instead of inheriting the other range's pin.
    expect(
      (await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })).data.type,
    ).toBe('text')
    expect(
      (await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })).data.type,
    ).toBe('text')
    // …and only then does that range reach the fallback on its own.
    expect(
      (await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })).data.type,
    ).toBe('clip_pin_fallback')
  })

  test('an intact-content dedup hit releases the pin', async () => {
    const p = writeFixture('clip-pin-release.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastReadToolUseId
    expect(isPinRegistered(pinnedId)).toBe(true)

    // A read where the prior result is INTACT → normal dedup hit. The model is
    // not looping, so the protection is released.
    setContextMessages(ctx, [
      userWithToolResult(pinnedId, '     1\texport function alpha'),
    ])
    expect((await read(p, {}, ctx)).data.type).toBe('file_unchanged')
    expect(isPinRegistered(pinnedId)).toBe(false)
    // A later clip therefore starts over with a re-send, not the fallback.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('an Edit/Write-style overwrite drops the dedup entry entirely', async () => {
    const p = writeFixture('clip-pin-edit.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    // Simulate FileEditTool/FileWriteTool updating readFileState after an
    // edit: offset/limit undefined, no toolUseId. The dedup gate requires a
    // Read-written entry, so the next reads are plain full reads again.
    ctx.readFileState.set(p, {
      content: SAMPLE_TS,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
    })
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  // -------------------------------------------------------------------------
  // Pin ownership: a pin is only justified while the readFileState entry that
  // asked for it still points at that tool_result. Every way of losing the
  // entry must release the pin — a leaked pin keeps its block out of every
  // clip path, which keeps the block mutable, which parks the prompt-cache
  // clip frontier at that block's index for the rest of the session.
  // -------------------------------------------------------------------------

  test('switching range releases the abandoned range\u2019s pin', async () => {
    const p = writeFixture('clip-pin-leak-range.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastReadToolUseId
    expect(isPinRegistered(pinnedId)).toBe(true)

    // The model moves on to a different range: the entry now vouches for that
    // read instead, so nothing owns the old pin any more.
    await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })
    expect(isPinRegistered(pinnedId)).toBe(false)
  })

  test('an Edit/Write-style overwrite releases the pin', async () => {
    const p = writeFixture('clip-pin-leak-edit.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastReadToolUseId
    expect(isPinRegistered(pinnedId)).toBe(true)

    ctx.readFileState.set(p, {
      content: SAMPLE_TS,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
    })
    expect(isPinRegistered(pinnedId)).toBe(false)
  })

  test('dropping the file entry (delete / LRU eviction) releases the pin', async () => {
    const p = writeFixture('clip-pin-leak-evict.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastReadToolUseId
    expect(isPinRegistered(pinnedId)).toBe(true)

    // Eviction bypasses delete() in production; both funnel through the same
    // dispose hook, so exercising the explicit drop covers the pair.
    ctx.readFileState.delete(p)
    expect(isPinRegistered(pinnedId)).toBe(false)
  })

  test('the stand-down re-send is never replayed from the tool-result cache', async () => {
    const p = writeFixture('clip-pin-nocache.ts', SAMPLE_TS)
    const ctx = makeContext()

    // A plain first read is cacheable — that is the whole point of the cache.
    const first = await readWithPriorClipped(p, ctx)
    expect(first.data.type).toBe('text')
    expect((first as { noResultCache?: boolean }).noResultCache).toBeUndefined()

    // The re-send is not: a cache hit short-circuits before call(), so
    // replaying it would hand the model an UNPINNED copy and leave the state
    // machine parked for the Read TTL — the loop spins with nothing observing
    // it. This suite runs with the cache disabled, so the flag is the only
    // thing standing between the feature and that bypass in production.
    const resend = await readWithPriorClipped(p, ctx)
    expect(resend.data.type).toBe('text')
    expect((resend as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('a re-send that throws pins nothing', async () => {
    const p = writeFixture('clip-pin-throws.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    // The file disappears between the stand-down decision and the read: the
    // pin is placed only on a body actually delivered, so a throw must leave
    // the registry untouched instead of burning a slot on an id whose content
    // the state machine will never look at again.
    rmSync(p)
    await expect(readWithPriorClipped(p, ctx)).rejects.toThrow(
      /File does not exist/,
    )
    expect(isPinRegistered(lastReadToolUseId)).toBe(false)
  })

  test('a re-send that pivots to auto-outline pins nothing', async () => {
    const p = writeFixture('clip-pin-pivot.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)

    // The stand-down arms skip the mtime check on purpose, so the file can
    // cross the auto-outline threshold (10k chars / 250 lines / 3 symbols)
    // between the clipped read and the re-send.
    writeFileSync(
      p,
      Array.from(
        { length: 400 },
        (_, i) => `export function fn${i}(): number {\n  return ${i}\n}\n`,
      ).join('\n'),
    )
    const prevForce = process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION
    process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION = '1'
    try {
      const pivoted = await readWithPriorClipped(p, ctx)
      expect(pivoted.data.type).toBe('outline')
      // The outline rewrites the entry as a partial view with no toolUseId:
      // it disarms the dedup gate, so nothing would ever release a pin placed
      // here. Pinning is conditioned on the entry still owning the id.
      expect(ctx.readFileState.get(p)?.isPartialView).toBe(true)
      expect(isPinRegistered(lastReadToolUseId)).toBe(false)
      // Still uncacheable: the decision to re-send was transcript-dependent
      // whatever shape the answer took.
      expect((pivoted as { noResultCache?: boolean }).noResultCache).toBe(true)
    } finally {
      if (prevForce === undefined) {
        delete process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION
      } else {
        process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION = prevForce
      }
    }
  })

  test('a clone releases only the pins it took in itself', async () => {
    const p = writeFixture('clip-pin-clone.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastReadToolUseId
    expect(isPinRegistered(pinnedId)).toBe(true)

    // Forked sub-agents (the default spawn) run on a clone of the parent's
    // readFileState and clear() it on exit — runAgent.ts / forkedAgent.ts.
    // clear() disposes every inherited entry, so an unconditional release
    // there would unpin a block the parent's entry still vouches for: the
    // parent would go on believing its content is protected while it had
    // quietly become clippable again.
    const clone = cloneFileStateCache(ctx.readFileState)
    clone.set('/other/file.ts', {
      content: 'x',
      timestamp: Date.now(),
      offset: 1,
      limit: undefined,
      toolUseId: 'toolu_clone_own',
    })
    pinToolResult('toolu_clone_own')

    clone.clear()
    expect(isPinRegistered(pinnedId)).toBe(true)
    // Entries it took in through set() it does own, so those release normally.
    expect(isPinRegistered('toolu_clone_own')).toBe(false)

    // And the parent still releases when ITS entry goes.
    ctx.readFileState.delete(p)
    expect(isPinRegistered(pinnedId)).toBe(false)
  })
})
