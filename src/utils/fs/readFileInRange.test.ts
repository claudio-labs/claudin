import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileTooLargeError, readFileInRange } from 'src/utils/fs/readFileInRange.js'

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

// ---------------------------------------------------------------------------
// options.encoding — the same Encoding Standard labels ripgrep takes, decoded
// by TextDecoder rather than by readFile (whose BufferEncoding set does not
// cover most of them). What matters is that the decode changes only how bytes
// become characters: line counting, ranges and byte accounting must behave
// exactly as they do on the UTF-8 path.
// ---------------------------------------------------------------------------

function writeBufferFixture(name: string, buf: Buffer): string {
  const p = join(dir, name)
  writeFileSync(p, buf)
  return p
}

describe('readFileInRange — encoding, fast path', () => {
  test('reads UTF-16LE that would otherwise be mojibake', async () => {
    const p = writeBufferFixture(
      'utf16.txt',
      Buffer.from('alpha\nbeta\ngamma\n', 'utf16le'),
    )

    const plain = await readFileInRange(p)
    expect(plain.content).not.toBe('alpha\nbeta\ngamma')

    const r = await readFileInRange(p, 0, undefined, undefined, undefined, {
      encoding: 'utf-16le',
    })
    expect(r.content).toBe('alpha\nbeta\ngamma')
    expect(r.lineCount).toBe(3)
    expect(r.totalLines).toBe(3)
  })

  test('offset and limit select lines, not bytes', async () => {
    const p = writeBufferFixture(
      'utf16-range.txt',
      Buffer.from('l1\nl2\nl3\nl4\nl5\n', 'utf16le'),
    )
    const r = await readFileInRange(p, 1, 2, undefined, undefined, {
      encoding: 'utf-16le',
    })
    expect(r.content).toBe('l2\nl3')
    expect(r.lineCount).toBe(2)
    expect(r.totalLines).toBe(5)
  })

  test('totalBytes stays in file bytes, not re-encoded string bytes', async () => {
    // 'abc\n' is 8 bytes as UTF-16LE and 4 as UTF-8. Reporting 4 would make
    // maxBytes mean something different depending on the encoding.
    const buf = Buffer.from('abc\n', 'utf16le')
    const p = writeBufferFixture('utf16-bytes.txt', buf)
    const r = await readFileInRange(p, 0, undefined, undefined, undefined, {
      encoding: 'utf-16le',
    })
    expect(buf.length).toBe(8)
    expect(r.totalBytes).toBe(8)
  })

  test('a BOM is consumed, not returned as a stray character', async () => {
    const p = writeBufferFixture(
      'utf16-bom.txt',
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('x\ny\n', 'utf16le'),
      ]),
    )
    const r = await readFileInRange(p, 0, undefined, undefined, undefined, {
      encoding: 'utf-16le',
    })
    expect(r.content).toBe('x\ny')
    expect(r.content.charCodeAt(0)).toBe(0x78)
  })

  test('CRLF is normalized the same way as on the UTF-8 path', async () => {
    const p = writeBufferFixture(
      'utf16-crlf.txt',
      Buffer.from('a\r\nb\r\n', 'utf16le'),
    )
    const r = await readFileInRange(p, 0, undefined, undefined, undefined, {
      encoding: 'utf-16le',
    })
    expect(r.content).toBe('a\nb')
    expect(r.lineCount).toBe(2)
  })

  test('a legacy single-byte encoding decodes', async () => {
    const p = writeBufferFixture(
      'cp1252.txt',
      Buffer.from([0x80, 0x0a, 0x41, 0x0a]),
    )
    const r = await readFileInRange(p, 0, undefined, undefined, undefined, {
      encoding: 'windows-1252',
    })
    expect(r.content).toBe('€\nA')
  })

  test('an explicit utf-8 label keeps the default path', async () => {
    const p = writeFixture('plain-utf8.txt', 'a\nb\n')
    const r = await readFileInRange(p, 0, undefined, undefined, undefined, {
      encoding: 'utf-8',
    })
    expect(r.content).toBe('a\nb')
  })

  test('an unknown label throws instead of reading the file as UTF-8', async () => {
    const p = writeFixture('unused.txt', 'a\n')
    await expect(
      readFileInRange(p, 0, undefined, undefined, undefined, {
        encoding: 'utf16',
      }),
    ).rejects.toThrow(/Unknown encoding/)
  })
})

describe('readFileInRange — encoding, streaming path', () => {
  // The streaming path decodes chunk by chunk, so it is the one that can
  // mangle a character split across a chunk boundary. highWaterMark is
  // 512 KB; this fixture puts a surrogate pair astride byte 524288 on purpose.
  const HIGH_WATER_MARK = 512 * 1024
  let streamPath: string

  beforeAll(() => {
    const padChars = HIGH_WATER_MARK / 2 - 1 // 2 bytes per ASCII char in UTF-16
    const head = 'a'.repeat(padChars) + '😀'
    // Pad past 10 MB so the size check picks the streaming path.
    const filler = '\nb'.repeat(3_000_000)
    const buf = Buffer.from(`${head}${filler}\n`, 'utf16le')
    if (buf.length < STREAMING_MIN_SIZE) {
      throw new Error(`fixture too small for the streaming path: ${buf.length}`)
    }
    streamPath = writeBufferFixture('utf16-stream.txt', buf)
  })

  test('a surrogate pair split across a chunk boundary survives', async () => {
    const r = await readFileInRange(
      streamPath,
      0,
      1,
      undefined,
      undefined,
      { encoding: 'utf-16le' },
    )
    expect(r.content.endsWith('😀')).toBe(true)
    expect(r.content).not.toContain('\ufffd')
  })

  test('later lines decode and line counting matches the fast path', async () => {
    const r = await readFileInRange(
      streamPath,
      1,
      3,
      undefined,
      undefined,
      { encoding: 'utf-16le' },
    )
    expect(r.content).toBe('b\nb\nb')
  })

  test('totalBytes counts file bytes, not decoded characters', async () => {
    const r = await readFileInRange(
      streamPath,
      0,
      1,
      undefined,
      undefined,
      { encoding: 'utf-16le' },
    )
    // A decoded-string count would land near half of this.
    expect(r.totalBytes).toBeGreaterThan(STREAMING_MIN_SIZE)
  })
})

describe('readFileInRange — streaming decode flush', () => {
  // The streaming decoder holds an incomplete sequence between chunks. At
  // end-of-stream that hold has to be flushed, or the file's last character is
  // dropped silently — which for a truncated file means the read quietly
  // disagrees with the bytes on disk.
  let truncatedPath: string

  beforeAll(() => {
    const body = Buffer.from(`${'\nb'.repeat(3_000_000)}\ntail`, 'utf16le')
    // One stray byte: the final UTF-16 code unit is now incomplete, so the
    // decoder is mid-character when the stream ends.
    const buf = Buffer.concat([body, Buffer.from([0x41])])
    if (buf.length < STREAMING_MIN_SIZE) {
      throw new Error(`fixture too small for the streaming path: ${buf.length}`)
    }
    truncatedPath = join(dir, 'utf16-truncated.txt')
    writeFileSync(truncatedPath, buf)
  })

  test('the held partial sequence is emitted at end of stream', async () => {
    const r = await readFileInRange(
      truncatedPath,
      3_000_000,
      undefined,
      undefined,
      undefined,
      { encoding: 'utf-16le' },
    )
    expect(r.content).toContain('tail')
    // Without the flush this is absent and the trailing byte vanishes.
    expect(r.content.endsWith('\ufffd')).toBe(true)
  })
})
