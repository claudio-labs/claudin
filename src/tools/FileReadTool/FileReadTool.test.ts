import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
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
  _getPinnedToolResultsForTesting,
  addClippedIds,
  bumpStandDownEpoch,
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
  STAND_DOWN_STRIKES,
  STICKY_REPLAY_BUDGET,
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

/** Longest run of consecutive `value`s in `xs` — the shape the bounds are
 *  stated in ("never two futile re-sends in a row"). */
function longestRun<T>(xs: readonly T[], value: T): number {
  let best = 0
  let cur = 0
  for (const x of xs) {
    cur = x === value ? cur + 1 : 0
    if (cur > best) best = cur
  }
  return best
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

  test('the killswitch path is still bounded by the strike counter', async () => {
    // With the pin gated off there is nothing to remember a stand-down by, so
    // this used to re-send the full body on every re-read, forever — strictly
    // worse than the three-strike breaker this feature replaced. The env var a
    // frustrated user reaches for handed them the original bug. Lane 2 sits
    // outside clipPinEnabled() precisely so that is no longer true.
    const p = writeFixture('clip-pin-off.ts', SAMPLE_TS)
    const ctx = makeContext()

    const types: string[] = []
    for (let i = 0; i < 5; i++) {
      types.push((await readWithPriorClipped(p, ctx)).data.type)
    }
    // Bounded: the run of consecutive bodies never exceeds the threshold.
    expect(types).toContain('clip_pin_fallback')
    expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
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
    //
    // The phrase used to be "…even though it was protected". Dropped: this arm
    // also fires for an id retired on sight by MAX_PINNED_RESULT_TOKENS, which
    // is registered but over the ceiling and never actually shielded anything,
    // so the claim was not always true (audit finding).
    expect(tripped.data.file.message).toContain(
      'that copy is no longer in the conversation',
    )
    // Cache-safety: transcript-dependent, must never be replayed from cache.
    // (noResultCache is optional across the call() return union; cast to read.)
    expect((tripped as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('the fallback BOUNDS the loop without ever denying the file for good', async () => {
    // TWO properties, and every version of this mechanism so far has traded
    // one away for the other:
    //   (1) never an unbounded run of futile full bodies — the original bug;
    //   (2) never an indefinite refusal for a file readable on disk.
    // Returning the outline without touching readFileState kept (1) and broke
    // (2). Deleting the entry to re-arm kept (2) and broke (1) — two bodies
    // every THREE reads under this harness (which clips every prior result, so
    // the pin never protects a round; four when it does), forever. A
    // permanently sticky marker kept (1) and broke (2) again, worse: the
    // marker sets isPartialView, so Edit/Write were refused too, and Read
    // stopped rewriting the entry, so nothing could ever lift the refusal.
    //
    // STICKY_REPLAY_BUDGET holds both at once, and this asserts both.
    const p = writeFixture('clip-pin-stays.ts', SAMPLE_TS)
    const ctx = makeContext()

    // Three full cycles' worth, so the assertions below are about a repeating
    // regime and not about one lucky prefix.
    const period = STICKY_REPLAY_BUDGET + 3
    const types: string[] = []
    for (let i = 0; i < period * 3; i++) {
      types.push((await readWithPriorClipped(p, ctx)).data.type)
    }

    expect(types).toContain('clip_pin_fallback')
    expect(types).toContain('text')
    // (1) Bodies are bounded, back to back AND as a rate. The rate is the half
    // the delete-to-re-arm version failed: it satisfied longestRun and still
    // paid two bodies every three reads.
    //
    // Asserted EXACTLY, not with <=. The regime is deterministic, so a loose
    // bound here would let a real rate regression through: `<= 2 * 3 + 1`
    // passed while the code delivered 6, i.e. it tolerated a 17% regression
    // silently. These stay symbolic in STICKY_REPLAY_BUDGET on purpose — the
    // tuning of the constant is a judgement call documented at its definition,
    // while the SHAPE it produces is what must not drift.
    expect(longestRun(types, 'text')).toBe(2)
    expect(types.filter(t => t === 'text').length).toBe(2 * 3)
    // (2) Outlines are bounded too, so the refusal always ends. Exactly one
    // more than the budget: the fallback that WRITES the marker, then `budget`
    // replays off it.
    expect(longestRun(types, 'clip_pin_fallback')).toBe(
      STICKY_REPLAY_BUDGET + 1,
    )
    // …stated as the thing the user actually cares about: after the outlines
    // start, a body always comes back.
    const firstFallback = types.indexOf('clip_pin_fallback')
    expect(types.slice(firstFallback)).toContain('text')
  })

  test('the sticky refusal lifts, so Edit stops being blocked forever', async () => {
    // The deadlock that the permanent marker created, pinned as the exact
    // predicate the edit tools use. FileEditTool.ts, FileWriteTool.ts,
    // applyPatch.ts and NotebookEditTool.ts all gate on `!entry ||
    // entry.isPartialView`, and the sticky entry sets isPartialView — so while
    // the marker stands, an Edit is refused with "File has not been read yet".
    //
    // That refusal is CORRECT (the model has seen an outline, not the body);
    // what was broken is that Read replayed the marker without rewriting the
    // entry, so the model could neither read its way to a body nor edit. The
    // budget is the only thing that lifts it.
    const p = writeFixture('clip-pin-edit-unblock.ts', SAMPLE_TS)
    const ctx = makeContext()

    const editWouldBeRefused = () => {
      const entry = ctx.readFileState.get(p)
      return !entry || entry.isPartialView === true
    }

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    expect(editWouldBeRefused()).toBe(true)

    // Keep re-reading the way a blocked model would. The body must come back
    // within the budget — before the marker was budgeted this loop never
    // terminated, for any number of iterations.
    let readsUntilEditable = 0
    while (editWouldBeRefused() && readsUntilEditable < 20) {
      readsUntilEditable++
      await readWithPriorClipped(p, ctx)
    }
    expect(editWouldBeRefused()).toBe(false)
    expect(readsUntilEditable).toBeLessThanOrEqual(STICKY_REPLAY_BUDGET + 1)
  })

  // The sticky marker must be sticky, NOT permanent — the failure mode of the
  // first version of this fallback. Four ways out; one test each.

  test('a changed file breaks out of the sticky fallback', async () => {
    const p = writeFixture('clip-pin-escape-mtime.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    // Still stuck while the bytes hold still.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // Now the file changes. The outline describes bytes that no longer exist,
    // so the marker must not answer for them. utimesSync rather than a second
    // write: two writes inside one millisecond can share an mtime, which would
    // make this pass or fail on timing rather than on the guard.
    writeFileSync(p, `${SAMPLE_TS}\nexport const added = 1\n`)
    const future = new Date(Date.now() + 5_000)
    utimesSync(p, future, future)

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('a main-thread compaction breaks out of the sticky fallback', async () => {
    const p = writeFixture('clip-pin-escape-epoch.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // Compaction rewrote the transcript and relieved the pressure that clipped
    // the body. postCompactCleanup bumps the epoch for main-thread compacts
    // (its own test pins that gate); here we assert what the bump BUYS.
    bumpStandDownEpoch()

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('a different range is never answered by the sticky fallback', async () => {
    const p = writeFixture('clip-pin-escape-range.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // The marker is per (path, offset, limit). A read of a DIFFERENT range is
    // a different question and must get real content — the fallback's redirect
    // footer tells the model to do exactly this, so answering it with the same
    // outline would be a dead end.
    expect((await readWithPriorClipped(p, ctx, { offset: 2 })).data.type).toBe(
      'text',
    )
  })

  test('a different limit is never answered by the sticky fallback either', async () => {
    // The `limit` half of the range key, which needs its OWN marker to test
    // against: asserting it right after the offset case above proved nothing,
    // because that read had already replaced the entry and there was no marker
    // left for the branch to match. It passed with the limit comparison
    // deleted — a vacuous assertion, caught by break-and-restore.
    const p = writeFixture('clip-pin-escape-limit.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // Same offset as the marker, different limit. Only the limit comparison
    // can send this to a real read.
    expect((await readWithPriorClipped(p, ctx, { limit: 2 })).data.type).toBe(
      'text',
    )
  })

  test('a file that changes before the fallback never goes sticky', async () => {
    // The fallback's own mtime guard, which is a DIFFERENT line from the one
    // the sticky replay checks — same expression, 30 lines apart, and only the
    // replay's copy had a test. Forcing this one to `if (true)` left the whole
    // suite green (audit finding), which is trap (a) from
    // .claudin/rules/agent-safety.md exactly: two identical-looking lines.
    const p = writeFixture('clip-pin-write-arm-mtime.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)

    // The file changes BETWEEN the pinned re-send and the fallback. The
    // outline about to be rendered describes the NEW bytes while the entry's
    // content and timestamp describe the old ones, so there is no coherent
    // pair to make sticky — and a marker keyed to a stale mtime would just sit
    // there being skipped.
    writeFileSync(p, `${SAMPLE_TS}\nexport const added = 1\n`)
    const future = new Date(Date.now() + 5_000)
    utimesSync(p, future, future)

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    // Delete-and-re-arm instead: no entry at all, so the next read is a real
    // body of the new content.
    expect(ctx.readFileState.get(p)).toBeUndefined()
  })

  test('the sticky replay is never served from the tool-result cache', async () => {
    // The first fallback asserts this too, but they are separate returns with
    // separate flags, and the replay is the one that runs for the rest of the
    // marker's life. A cached replay would freeze the budget as well, since
    // call() would never run to charge it.
    const p = writeFixture('clip-pin-replay-nocache.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)

    const replay = await readWithPriorClipped(p, ctx)
    expect(replay.data.type).toBe('clip_pin_fallback')
    expect((replay as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('the sticky fallback keeps Edit/Write demanding a real Read first', async () => {
    // Keeping an entry where the previous design deleted one must not quietly
    // buy back the Edit permission: isPartialView is what preserves it, and
    // FileEditTool, FileWriteTool, applyPatch and NotebookEditTool all check
    // that same field. (A test asserting the marker is DROPPED by a direct
    // readFileState.set used to sit here, framed as the Edit/Write exit. It
    // was deleted: it passed with the entire sticky replay disabled, and the
    // exit it advertised cannot open in production anyway — the marker refuses
    // the Edit that would have replaced the entry. The budget is that exit
    // now, covered by "the sticky refusal lifts" above.)
    const p = writeFixture('clip-pin-partial-view.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    const sticky = ctx.readFileState.get(p)
    // Assert the entry EXISTS first: `?.toolUseId` being undefined is also
    // true when there is no entry at all, so on its own it was tautological.
    expect(sticky?.standDownOutline).toBeDefined()
    expect(sticky?.isPartialView).toBe(true)
    // …and it carries no tool_use id, so the blind-pointer stub the dedup
    // serves is not even representable from this state.
    expect(sticky?.toolUseId).toBeUndefined()
  })

  test('non-code file falls back to the head of the file plus a redirect', async () => {
    // 200 lines: past CLIP_PIN_HEAD_LINES (60), so the cap is exercised rather
    // than incidentally satisfied by a short fixture.
    const body = Array.from({ length: 200 }, (_, i) => `plain line ${i}`).join(
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
    // The code arm serves an outline — a real view of the file. The non-code
    // arm used to serve a bare system-reminder, i.e. the model asked to read a
    // file and got zero bytes of it, which is worse than the three-strike
    // breaker this replaced (two more full bodies first). It must carry the
    // head of the file with the redirect.
    expect(tripped.data.file.message).toContain('plain line 0')
    expect(tripped.data.file.message).toContain('plain line 59')
    // …the HEAD of it, not the whole thing — the fallback exists because the
    // full body keeps getting clipped, so re-sending it would defeat the point.
    expect(tripped.data.file.message).not.toContain('plain line 199')
    // Line-numbered like every other Read result: the redirect tells the model
    // to go read a different part of the file, which needs anchors.
    expect(tripped.data.file.message).toMatch(/1→plain line 0\b/)
  })

  test('the legacy CLAUDIN_DISABLE_READ_RERUN_BREAKER killswitch still works', async () => {
    // The mechanism shipped under the old name; the rename must not silently
    // take a working opt-out away from anyone who had already set it.
    const p = writeFixture('clip-pin-legacy-killswitch.ts', SAMPLE_TS)
    const ctx = makeContext()
    process.env.CLAUDIN_DISABLE_READ_RERUN_BREAKER = '1'
    try {
      // Still opts out of the PIN (nothing gets protected), but not out of the
      // strike bound — a killswitch that reinstates an unbounded loop is a
      // trap, not an opt-out.
      const types: string[] = []
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      // IMMEDIATELY after the stand-down re-send: this is the id the pin
      // would protect if the alias were ignored. Asserting any later is
      // blind — the next fallback deletes the entry and the dispose hook
      // releases the pin, so a delayed check passes with the env check
      // deleted.
      expect(isPinRegistered(lastReadToolUseId)).toBe(false)
      for (let i = 0; i < 2; i++) {
        types.push((await readWithPriorClipped(p, ctx)).data.type)
      }
      expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_RERUN_BREAKER
    }
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
    expect(tripped.data.file.message).not.toContain(
      'that copy is no longer in the conversation',
    )
    expect(tripped.data.file.message).toContain('the API keeps clearing tool results')
  })

  test('a latched server clear still reaches the fallback while the local copy looks intact', async () => {
    // REGRESSION GUARD. The tempting optimisation here is "the prior block is
    // still visible in context.messages AND we pinned it, so the session-wide
    // clear latch must be stale evidence about some OTHER result — take the
    // intact branch". It is wrong in the worst possible way: clear_tool_uses
    // is applied API-side and never rewrites our local copy (the response
    // carries counts only), so isPriorReadClippedOrMissing is structurally
    // blind to it and "still visible locally" is true for EVERY cleared block.
    // The gate would therefore be permanently on under a latched clear,
    // replacing the outline fallback with a dedup stub that points at content
    // the API removed — re-read, same stub, forever.
    const p = writeFixture('clip-pin-latch-visible.ts', SAMPLE_TS)
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })

    const readWithPriorVisible = async () => {
      const priorId = ctx.readFileState.get(p)?.toolUseId
      setContextMessages(ctx, [
        assistantWithClearing(4),
        ...(priorId ? [userWithToolResult(priorId, 'the real body')] : []),
      ])
      assignFreshToolUseId(ctx)
      return read(p, {}, ctx)
    }

    // 1st: ordinary read. 2nd: the latch forces a stand-down re-send, which
    // pins the copy it delivers — even though the pin cannot survive a
    // server-side clear, which is exactly why the 3rd read must not trust it.
    expect((await readWithPriorVisible()).data.type).toBe('text')
    expect((await readWithPriorVisible()).data.type).toBe('text')
    expect(isPinRegistered(lastReadToolUseId)).toBe(true)

    const third = await readWithPriorVisible()
    expect(third.data.type).toBe('clip_pin_fallback')
  })

  test('a cached first read never preempts the stand-down', async () => {
    const p = writeFixture('clip-pin-cache.ts', SAMPLE_TS)
    const ctx = makeContext()
    // The suite disables the cache at module load; enable it for this test.
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    try {
      setContextMessages(ctx, [])
      assignFreshToolUseId(ctx)
      expect((await read(p, {}, ctx)).data.type).toBe('text')
      // The first read is a pure function of input + disk, so it caches.
      expect(getCached('Read', { file_path: p })).toBeDefined()

      // Same input, but now the prior result is clipped. A cache hit would
      // short-circuit call() for the whole 60s TTL, handing the model an
      // UNPINNED replay and freezing the stand-down state machine — the loop
      // would spin invisibly instead of terminating after one re-send.
      const { data } = await readWithPriorClipped(p, ctx)
      expect(data.type).toBe('text')
      expect(isPinRegistered(lastReadToolUseId)).toBe(true)
    } finally {
      process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
      invalidateAll()
    }
  })

  test('bypassResultCache fires on stand-down evidence, not on "have I read this"', async () => {
    const p = writeFixture('clip-pin-bypass.ts', SAMPLE_TS)
    const ctx = makeContext()
    const bypasses = () =>
      FileReadTool.bypassResultCache?.({ file_path: p }, ctx)

    // 1. Never read here → nothing to stand down from → cache normally.
    setContextMessages(ctx, [])
    expect(bypasses()).toBe(false)

    assignFreshToolUseId(ctx)
    await read(p, {}, ctx)
    const priorId = lastReadToolUseId

    // 2. Read, and the prior tool_result is sitting intact in the transcript.
    //    THIS is the case that decides whether the Read cache keeps any value:
    //    keying the bypass on mere readFileState presence would return true
    //    here and, because readFileState is session-lifetime with no TTL and is
    //    written by Bash/Edit/Write/attachments too, would stay true forever —
    //    deleting every in-context Read hit while the dead entries kept
    //    evicting live Glob/Grep results from the shared LRU.
    setContextMessages(ctx, [userWithToolResult(priorId, 'the real body')])
    expect(bypasses()).toBe(false)

    // 3. Prior result clipped → the stand-down could fire → call() must run.
    setContextMessages(ctx, [
      userWithToolResult(priorId, buildClipStub('Read', 1234)),
    ])
    expect(bypasses()).toBe(true)

    // 4. Prior result intact again, but the API cleared something this session.
    //    Session-wide latch, no ids: call() has to make that call, not the cache.
    setContextMessages(ctx, [
      assistantWithClearing(4),
      userWithToolResult(priorId, 'the real body'),
    ])
    expect(bypasses()).toBe(true)
  })

  test('CLAUDIN_DISABLE_READ_CLIP_PIN wins over the force flag', async () => {
    process.env.CLAUDIN_DISABLE_READ_CLIP_PIN = '1'
    try {
      const p = writeFixture('clip-pin-disabled.ts', SAMPLE_TS)
      const ctx = makeContext()
      const types: string[] = []
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      // The killswitch must mean "nothing gets pinned" — checked IMMEDIATELY
      // after the re-send that would have pinned. The final read of the loop
      // serves the fallback (never pinned) and a later fallback would release
      // this id through the dispose hook, so a check anywhere else passes
      // with the env check deleted.
      expect(isPinRegistered(lastReadToolUseId)).toBe(false)
      for (let i = 0; i < 4; i++) {
        types.push((await readWithPriorClipped(p, ctx)).data.type)
      }
      // ...but the strike bound still applies (lane 2 is outside the gate).
      expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
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

  test('an intact-content dedup hit frees the slot but remembers the re-send', async () => {
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
    // The SHIELD goes — the slot is freed and the clip frontier stops stalling
    // on this block.
    expect(_getPinnedToolResultsForTesting().has(pinnedId)).toBe(false)
    // The MEMORY stays. Fully forgetting it here is what re-arms the loop:
    // the block is still intact, so an ordinary re-read erases the state, the
    // next clip pass stubs it, and the stand-down grants another full re-send —
    // one body per rotation, with no bound. This copy already had its one
    // protected re-send, so a later clip goes straight to the outline.
    expect(isPinRegistered(pinnedId)).toBe(true)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
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

  test('a context with no toolUseId is bounded by strikes, not denied on the first', async () => {
    // The un-pinnable case: Tool.ts's toolUseId is optional, and the callers
    // that skip it are user-facing — @-mentions (attachments/file-pipeline.ts
    // calls FileReadTool.call directly), MagicDocs, SessionMemory, the MCP
    // entrypoint. Two wrong answers were shipped here in a row: re-sending
    // forever (nothing records the stand-down), then serving the outline on the
    // FIRST stand-down, which tells a user who explicitly re-@-mentioned a file
    // to stop re-reading it. Lane 2 is the third answer: a real bound, but the
    // model gets bodies first.
    const p = writeFixture('clip-pin-no-id.ts', SAMPLE_TS)
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })
    // No assignFreshToolUseId anywhere in this test: ctx.toolUseId stays
    // undefined, so readFileState entries carry no id.
    const types: string[] = []
    for (let i = 0; i < 6; i++) {
      types.push((await read(p, {}, ctx)).data.type)
    }
    expect(ctx.readFileState.get(p)?.toolUseId).toBeUndefined()

    // The first stand-down must NOT be a refusal.
    expect(types[0]).toBe('text')
    expect(types[1]).toBe('text')
    // ...and the run is still bounded.
    expect(types).toContain('clip_pin_fallback')
    expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
  })

  test('a spent cycle lets the Read cache work again on an intact re-read', async () => {
    // isPinRegistered answers true for SPENT ids too, so keying the cache bypass
    // on it would latch: the intact branch retires the id into spent while
    // leaving readFileState pointing at it, and the path would then skip the
    // cache for the rest of the session. isPinShielding is the in-flight half.
    const p = writeFixture('clip-pin-spent-bypass.ts', SAMPLE_TS)
    const ctx = makeContext()
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastReadToolUseId

    // Close the cycle: prior result intact ⇒ retirePinAfterUse ⇒ id is spent.
    setContextMessages(ctx, [userWithToolResult(pinnedId, 'the real body')])
    await read(p, {}, ctx)
    expect(isPinRegistered(pinnedId)).toBe(true)

    // Still spent, still intact, nothing in flight → the cache is allowed again.
    expect(FileReadTool.bypassResultCache?.({ file_path: p }, ctx)).toBe(false)
  })

  test('a clip registered mid-prompt is caught even though the bytes still look intact', async () => {
    // The blindness the whole feature almost shipped with. The array a tool
    // sees during a turn (toolUseContext.messages, refreshed from
    // messagesForQuery) holds the UNCLIPPED originals — applyStableStubs
    // rewrites a separate copy on its way to the wire and the clipped form is
    // only written back post-turn. So a Read clipped by microCompact in the
    // middle of one long prompt still reads as intact content, the stand-down
    // never fires, and the model gets a dedup stub pointing at bytes it can no
    // longer see: exactly the loop this mechanism exists to close, surviving
    // inside the case where clipping is most aggressive.
    const p = writeFixture('clip-pin-inflight.ts', SAMPLE_TS)
    const ctx = makeContext()
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    const priorId = ctx.readFileState.get(p)?.toolUseId
    expect(priorId).toBeDefined()

    // The transcript the tool can see still carries the REAL body — this is
    // the whole point, the clip has not been written back yet.
    setContextMessages(ctx, [userWithToolResult(priorId!, 'the real body')])
    // ...but the clip path has already registered the id on its way to the API.
    addClippedIds([priorId!])

    assignFreshToolUseId(ctx)
    const { data } = await read(p, {}, ctx)
    // Must re-send. Before the registry check this returned 'file_unchanged',
    // pointing the model at content the API had already dropped.
    expect(data.type).toBe('text')
  })

  test('a SHIELDING pin means a registered clip id is not evidence of a clip', async () => {
    // The other half of the registry check above, and the case it got wrong.
    // The registry records what the clip machinery DECIDED to clip, not what
    // it managed to clip: microCompact adds candidates without consulting the
    // pin registry, and stubOneBlock then skips the pinned ones. So a
    // shielding id sits in the clipped set with its bytes fully intact.
    //
    // Reading the registry alone made the pin actively counterproductive: the
    // model was sent to the outline fallback for content it still had
    // verbatim, and the fallback's exit released the pin, so the block it had
    // been protecting was stubbed on the very next pass. The pin bought a
    // round-trip and nothing else.
    const p = writeFixture('clip-pin-shielded-id.ts', SAMPLE_TS)
    const ctx = makeContext()
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    const priorId = ctx.readFileState.get(p)?.toolUseId
    expect(priorId).toBeDefined()

    // Same setup as above — the id is registered as clipped — except that this
    // one is SHIELDING, which is why the bytes are still in the transcript.
    setContextMessages(ctx, [userWithToolResult(priorId!, 'the real body')])
    pinToolResult(priorId!)
    addClippedIds([priorId!])

    assignFreshToolUseId(ctx)
    // Without the isPinShielding check this returned 'clip_pin_fallback': an
    // outline, for a body sitting in front of the model.
    expect((await read(p, {}, ctx)).data.type).toBe('file_unchanged')
  })

  test('a body over the pin ceiling skips the futile re-send', async () => {
    // Above MAX_PINNED_RESULT_TOKENS pinShieldsBlock retires the id on sight,
    // so the re-sent copy is clipped in the same pass that first examines it
    // and the id lands in the spent registry — which sends the NEXT read to
    // the fallback anyway. One full futile body, every cycle, to reach a
    // decision that was already made.
    //
    // .txt on purpose: with a code fixture the auto-outline pivot intercepts
    // a file this size and the first read never produces the oversized body
    // under test — the sibling-path trap from .claudin/rules/agent-safety.md.
    // ~50k chars sits above the 8k-token ceiling and below the 25k-token read
    // cap, so neither bound is the thing being measured by accident.
    const body = Array.from(
      { length: 1500 },
      (_, i) => `plain log line ${i} with some filler text to pad the bytes`,
    ).join('\n')
    const p = writeFixture('clip-pin-oversized.txt', body)
    // maxTokens raised on purpose. validateContentTokens calls the counting
    // API once the estimate passes maxTokens/4 — 6250 by default, which is
    // BELOW the 8k pin ceiling, so any fixture big enough to test this lane
    // would drag the VCR layer in and record a fixtures/token-count-*.json.
    // The read cap is not what is under test here; pin it out of the way.
    const ctx = makeContext({
      fileReadingLimits: { maxSizeBytes: 10 * 1024 * 1024, maxTokens: 100_000 },
    })

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    // The stand-down. This used to re-send the whole body and pin it; now it
    // goes straight to the fallback, because that body could never have been
    // shielded in the first place.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
  })

  test('a sticky fallback entry bypasses the tool-result cache', async () => {
    // The fallback's decision lives on the ENTRY, not in the tool input, and a
    // cache hit short-circuits before call(). Replaying a cached body here
    // would hand back precisely the content the fallback concluded cannot
    // survive, while the marker was never consulted — the loop keeps spinning
    // invisibly for the whole TTL. The old code could not even reach this
    // question: the fallback deleted the entry, so bypassResultCache returned
    // at `if (!prior)` before looking at anything.
    const p = writeFixture('clip-pin-sticky-bypass.ts', SAMPLE_TS)
    const ctx = makeContext()
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // An empty transcript on purpose: it fails every OTHER reason this method
    // has to bypass (no server clearing, no id to ask the pin about), so a
    // true here can only come from the sticky check.
    setContextMessages(ctx, [])
    expect(FileReadTool.bypassResultCache?.({ file_path: p }, ctx)).toBe(true)
  })

  test('a cancelled fallback propagates the abort instead of degrading', async () => {
    // The head-slice helper swallows read errors and returns '' so the fallback
    // degrades to a bare redirect. An abort is not a failed read — it is the
    // user pressing escape — and turning it into '' hands the model a truncated
    // answer for a request that was called off, plus logs a phantom error.
    // An audit found the `if (isAbortError(e)) throw e` rethrow untested.
    //
    // The fixture must have NO outline language (.txt, not .ts): with one, the
    // fallback calls scanFile first and THAT rethrows the abort, so the head
    // slice is never reached and the test passes without touching the line it
    // claims to guard. The first version of this test did exactly that.
    const p = writeFixture('clip-pin-abort.txt', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)

    // Third read is the fallback. Abort before it runs the head slice.
    const priorId = ctx.readFileState.get(p)?.toolUseId
    setContextMessages(
      ctx,
      priorId ? [userWithToolResult(priorId, buildClipStub('Read', 1234))] : [],
    )
    assignFreshToolUseId(ctx)
    ctx.abortController.abort()

    await expect(read(p, {}, ctx)).rejects.toThrow()
  })

  test('an ordinary dedup hit does not spend the one re-send a later clip is owed', async () => {
    // retirePinAfterUse runs on EVERY intact dedup hit, including for files
    // that were never in a clip loop and never had a pin. Its no-op guard is
    // what keeps such an id out of the spent set — and `spent` is one of the
    // two halves isPinRegistered answers true for, which is what lane 1 of the
    // stand-down keys on.
    //
    // So without the guard: read a file twice normally, and the second (dedup)
    // read marks the id spent; the FIRST time that file is ever clipped, lane 1
    // sees a "registered" id, concludes the protected re-send was already used
    // and goes straight to the outline. The file is never re-sent even once.
    // An audit found this consequence documented on the guard but untested.
    const p = writeFixture('clip-pin-never-pinned.ts', SAMPLE_TS)
    const ctx = makeContext()

    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    const id = ctx.readFileState.get(p)?.toolUseId
    expect(id).toBeDefined()
    // No pin was ever placed on this id — an ordinary read of an ordinary file.
    expect(isPinRegistered(id!)).toBe(false)

    // An intact dedup hit. This calls retirePinAfterUse(id).
    setContextMessages(ctx, [userWithToolResult(id!, 'the real body')])
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('file_unchanged')
    // The guard's whole job: an id that never shielded anything stays unknown.
    expect(isPinRegistered(id!)).toBe(false)

    // Now the first clip this file has ever seen. It is owed a real re-send.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('a one-symbol file falls back to the head slice, not a one-line outline', async () => {
    // scanFile only returns null at ZERO symbols, so a long file whose parser
    // finds a single top-level symbol used to be "answered" with a one-line
    // outline. That is technically an outline and useless as a view of the
    // file — the same floor the auto-outline pivot applies keeps it on the head
    // slice, which is real content.
    const body = [
      'export function onlySymbol() {',
      ...Array.from({ length: 300 }, (_, i) => `  const v${i} = ${i}`),
      '}',
    ].join('\n')
    const p = writeFixture('clip-pin-onesymbol.ts', body)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const out = await readWithPriorClipped(p, ctx)
    expect(out.data.type).toBe('clip_pin_fallback')
    const file = (
      out.data as { file: { message: string; servedOutline: boolean } }
    ).file
    expect(file.servedOutline).toBe(false)
    // Head slice ⇒ real, line-numbered content from the top of the file.
    expect(file.message).toContain('onlySymbol')
    expect(file.message).toMatch(/\b1→/)
  })

  test('a clipped notebook gets the bare redirect, not raw nbformat JSON', async () => {
    // .ipynb has no outline language, so it reaches the head-slice arm — where
    // its first 60 lines are metadata and base64 outputs, line-numbered to look
    // like content the model can aim at. It cannot.
    //
    // Sibling case, same arm: `a one-symbol file…` below covers a file that
    // HAS an outline language but too few symbols for the outline to be worth
    // serving.
    const nb = writeFixture(
      'clip-pin-nb.ipynb',
      JSON.stringify(
        {
          cells: [
            { cell_type: 'code', source: ['print(1)\n'], outputs: [], metadata: {} },
          ],
          metadata: { kernelspec: { name: 'python3' } },
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        2,
      ),
    )
    const ctx = makeContext()
    await readWithPriorClipped(nb, ctx) // first read
    await readWithPriorClipped(nb, ctx) // the one protected re-send
    const out = await readWithPriorClipped(nb, ctx) // pinned and gone → fallback
    expect(out.data.type).toBe('clip_pin_fallback')
    const message = (out.data as { file: { message: string } }).file.message
    expect(message).not.toContain('nbformat')
    expect(message).not.toContain('kernelspec')
    expect(message).toContain('Stop re-reading this range')
    // The redirect and nothing else — no line-numbered JSON in front of it.
    expect(message.startsWith('<system-reminder>')).toBe(true)
  })
})
