// Smart Code Navigation — view='outline', symbol= and the auto-outline
// degrade, both for TypeScript and across the three scanner families.
//
// Split out of the 2177-line FileReadTool.test.ts; the SAMPLE_* fixtures and
// the process-global env pair live in __testutils__/fileReadHarness.ts.

import { describe, expect, test } from 'bun:test'

import { scanFile } from 'src/tools/FileReadTool/FileReadTool.js'
import {
  SAMPLE_CPP,
  SAMPLE_CSS,
  SAMPLE_HTML,
  SAMPLE_RB,
  SAMPLE_SQL,
  SAMPLE_TS,
  makeContext,
  read,
  useFileReadEnv,
  writeFixture,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'

useFileReadEnv()

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

  // A file made only of calls has no symbol table, so neither `view: 'outline'`
  // nor `symbol=` can be answered. Both used to fall through to a plain read
  // with nothing said — which is how three explicit outline calls in the
  // session corpus came back as ~52 KB of body.
  const CALLS_ONLY = "describe('suite', () => {\n  test('x', () => {})\n})\n"

  test('a small file with no symbols still returns its body', async () => {
    const p = writeFixture('calls-small.test.ts', CALLS_ONLY)
    const { data } = await read(p, { view: 'outline' })

    if (data.type !== 'text') throw new Error('expected text')
    expect(data.file.content).toContain("describe('suite'")
  })

  test("a large file with no symbols refuses view='outline' instead of dumping", async () => {
    // Padded past READ_AUTO_OUTLINE_THRESHOLD_CHARS with more calls, so the
    // table stays empty while the body becomes the expensive answer.
    const big = CALLS_ONLY + 'noop()\n'.repeat(2000)
    const p = writeFixture('calls-big.test.ts', big)

    await expect(read(p, { view: 'outline' })).rejects.toThrow(
      /No symbol table.*view: 'outline'.*offset\/limit.*view='full'/s,
    )
  })

  test('a large file with no symbols refuses symbol= and names the symbol', async () => {
    const big = CALLS_ONLY + 'noop()\n'.repeat(2000)
    const p = writeFixture('calls-big-sym.test.ts', big)

    await expect(read(p, { symbol: 'suite' })).rejects.toThrow(
      /No symbol table.*symbol 'suite'/s,
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
