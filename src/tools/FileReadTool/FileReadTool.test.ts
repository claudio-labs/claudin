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
  assistantWithAppliedEdits,
  assistantWithClearing,
  userWithToolResult,
} from './__test-helpers__/contextManagementFixtures.js'
import { FileReadTool, MaxFileReadTokenExceededError } from './FileReadTool.js'

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
