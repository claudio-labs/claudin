import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileTooLargeError, readFileInRange } from './readFileInRange.js'

// ---------------------------------------------------------------------------
// Line-counting semantics (cat -n): a trailing '\n' does NOT open a phantom
// empty last line, and an empty file has 0 lines. Both code paths (fast
// in-memory split for files < 10 MB, streaming for larger) must agree.
// ---------------------------------------------------------------------------

// Files of exactly FAST_PATH_MAX_SIZE take the streaming path
// (the fast-path condition is size < 10 MB, strictly).
const STREAMING_MIN_SIZE = 10 * 1024 * 1024

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-file-in-range-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFixture(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('readFileInRange — fast path', () => {
  test('counts lines without a trailing newline', async () => {
    const p = writeFixture('plain.txt', 'a\nb\nc')
    const r = await readFileInRange(p)
    expect(r.content).toBe('a\nb\nc')
    expect(r.lineCount).toBe(3)
    expect(r.totalLines).toBe(3)
  })

  test('a trailing newline does not add a phantom empty line', async () => {
    const p = writeFixture('trailing.txt', 'a\nb\n')
    const r = await readFileInRange(p)
    expect(r.content).toBe('a\nb')
    expect(r.lineCount).toBe(2)
    expect(r.totalLines).toBe(2)
  })

  test('an empty file has 0 lines', async () => {
    const p = writeFixture('empty.txt', '')
    const r = await readFileInRange(p)
    expect(r.content).toBe('')
    expect(r.lineCount).toBe(0)
    expect(r.totalLines).toBe(0)
  })

  test('a file containing only a newline has exactly one empty line', async () => {
    const p = writeFixture('only-newline.txt', '\n')
    const r = await readFileInRange(p)
    expect(r.content).toBe('')
    expect(r.lineCount).toBe(1)
    expect(r.totalLines).toBe(1)
  })

  test('CRLF line endings are normalized and counted like LF', async () => {
    const p = writeFixture('crlf.txt', 'a\r\nb\r\n')
    const r = await readFileInRange(p)
    expect(r.content).toBe('a\nb')
    expect(r.lineCount).toBe(2)
    expect(r.totalLines).toBe(2)
  })

  test('a final unterminated line ending in bare \\r is counted and stripped', async () => {
    const p = writeFixture('bare-cr.txt', 'a\nb\r')
    const r = await readFileInRange(p)
    expect(r.content).toBe('a\nb')
    expect(r.lineCount).toBe(2)
    expect(r.totalLines).toBe(2)
  })

  test('strips a UTF-8 BOM before splitting', async () => {
    const p = writeFixture('bom.txt', '﻿a\n')
    const r = await readFileInRange(p)
    expect(r.content).toBe('a')
    expect(r.totalLines).toBe(1)
  })

  test('offset/maxLines select a range; totalLines still counts the file', async () => {
    const p = writeFixture('range.txt', 'a\nb\nc\nd\n')
    const r = await readFileInRange(p, 1, 2)
    expect(r.content).toBe('b\nc')
    expect(r.lineCount).toBe(2)
    expect(r.totalLines).toBe(4)
  })

  test('offset past the end returns empty content with the real totalLines', async () => {
    const p = writeFixture('past-end.txt', 'a\nb\n')
    const r = await readFileInRange(p, 50)
    expect(r.content).toBe('')
    expect(r.lineCount).toBe(0)
    expect(r.totalLines).toBe(2)
  })

  test('truncateOnByteLimit clips at the last complete line that fits', async () => {
    const p = writeFixture('truncate.txt', 'aaaa\nbbbb\n')
    const r = await readFileInRange(p, 0, undefined, 4, undefined, {
      truncateOnByteLimit: true,
    })
    expect(r.content).toBe('aaaa')
    expect(r.truncatedByBytes).toBe(true)
    expect(r.totalLines).toBe(2)
  })

  test('legacy maxBytes mode throws FileTooLargeError', async () => {
    const p = writeFixture('too-large.txt', 'x'.repeat(2048))
    await expect(readFileInRange(p, 0, undefined, 1024)).rejects.toBeInstanceOf(
      FileTooLargeError,
    )
  })

  test('reading a directory throws EISDIR', async () => {
    await expect(readFileInRange(dir)).rejects.toThrow(/EISDIR/)
  })
})

describe('readFileInRange — streaming path (files ≥ 10 MB)', () => {
  test('a trailing newline does not add a phantom empty line', async () => {
    // 1024-byte lines × 10240 = exactly 10 MB, last byte is '\n'.
    const line = 'x'.repeat(1023)
    const lineTotal = STREAMING_MIN_SIZE / 1024
    const p = writeFixture(
      'streaming-trailing.txt',
      `${line}\n`.repeat(lineTotal),
    )
    const r = await readFileInRange(p, 0, 2)
    expect(r.content).toBe(`${line}\n${line}`)
    expect(r.lineCount).toBe(2)
    expect(r.totalLines).toBe(lineTotal)
  }, 30_000)

  test('a final unterminated line is counted', async () => {
    // One giant line, no newline at all.
    const p = writeFixture(
      'streaming-one-line.txt',
      'y'.repeat(STREAMING_MIN_SIZE),
    )
    const r = await readFileInRange(p, 0, 5)
    expect(r.lineCount).toBe(1)
    expect(r.totalLines).toBe(1)
    expect(r.content.length).toBe(STREAMING_MIN_SIZE)
  }, 30_000)
})
