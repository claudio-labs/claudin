// Line numbering and line counting — cat -n semantics, asserted through
// mapToolResultToToolResultBlockParam.
//
// Split out of the 2177-line FileReadTool.test.ts; the fixtures and the
// process-global env pair live in __testutils__/fileReadHarness.ts.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import {
  SAMPLE_TS,
  makeContext,
  read,
  useFileReadEnv,
  writeFixture,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'

useFileReadEnv()

// ---------------------------------------------------------------------------
// Line numbering & line counting — cat -n semantics.
// ---------------------------------------------------------------------------

describe('FileReadTool — line numbering and counting', () => {
  let savedDisableReminders: string | undefined

  beforeAll(() => {
    // Make mapToolResultToToolResultBlockParam output deterministic: no
    // model-dependent mitigation reminder.
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
