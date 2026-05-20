import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { READ_FILE_STATE_CACHE_SIZE } from '../../utils/fileStateCache.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
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
process.env.CLAUDIO_DISABLE_TOOL_RESULT_CACHE = '1'

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
}

function makeContext(overrides: ContextOverrides = {}): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits: overrides.fileReadingLimits,
    getAppState: () => ({ toolPermissionContext: {} }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
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
    // No trailing newline keeps the line count exact (a trailing \n adds an
    // empty final fragment that counts as a line).
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
