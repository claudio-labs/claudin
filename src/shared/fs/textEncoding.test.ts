import { describe, expect, test } from 'bun:test'

import {
  assertKnownEncoding,
  createTextDecoder,
  decodeBuffer,
  encodingOverride,
  isUtf8Label,
  UnknownEncodingError,
} from 'src/shared/fs/textEncoding.js'

// ---------------------------------------------------------------------------
// The label space here is ripgrep's (Encoding Standard), not Node's
// BufferEncoding — that mismatch is the whole reason this module exists, so
// most of what follows pins labels readFile could NOT have handled.
// ---------------------------------------------------------------------------

describe('isUtf8Label / encodingOverride', () => {
  test.each(['utf8', 'utf-8', 'UTF-8', ' Utf8 '])(
    '%p means no override',
    label => {
      expect(isUtf8Label(label)).toBe(true)
      expect(encodingOverride(label)).toBe(null)
    },
  )

  test('undefined means no override', () => {
    expect(encodingOverride(undefined)).toBe(null)
  })

  test.each(['utf-16le', 'shift_jis', 'windows-1252', 'latin1', 'utf16le'])(
    '%p takes the override',
    label => {
      expect(isUtf8Label(label)).toBe(false)
      expect(encodingOverride(label)).toBe(label)
    },
  )

  test('utf16le takes the override even though readFile could do it', () => {
    // Deliberate: one decoder owns every non-UTF-8 label, so the two paths
    // cannot disagree about which of them handles a given spelling.
    expect(encodingOverride('utf16le')).toBe('utf16le')
  })
})

describe('decodeBuffer', () => {
  test('decodes UTF-16LE without a BOM', () => {
    const buf = Buffer.from('hello', 'utf16le')
    expect(decodeBuffer(buf, 'utf-16le')).toBe('hello')
    // The bug this fixes: the same bytes read as UTF-8.
    expect(buf.toString('utf8')).not.toBe('hello')
  })

  test('consumes a leading BOM rather than leaving U+FEFF in the text', () => {
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('hi', 'utf16le'),
    ])
    expect(decodeBuffer(buf, 'utf-16le')).toBe('hi')
  })

  test('decodes a single-byte legacy encoding Node cannot name', () => {
    // 0x80 is the Euro sign in windows-1252 and invalid in UTF-8.
    const buf = Buffer.from([0x80])
    expect(decodeBuffer(buf, 'windows-1252')).toBe('€')
    expect(buf.toString('utf8')).toBe('\ufffd')
  })

  test('decodes Shift-JIS', () => {
    const buf = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])
    expect(decodeBuffer(buf, 'shift_jis')).toBe('日本語')
  })

  test('is non-fatal: undecodable bytes become U+FFFD, not an exception', () => {
    // Matches ripgrep's behavior with the same label — a file that is mostly
    // the declared encoding still reads.
    const buf = Buffer.from([0x93, 0xfa, 0xff])
    expect(decodeBuffer(buf, 'shift_jis')).toContain('日')
  })

  test('an empty buffer decodes to an empty string', () => {
    expect(decodeBuffer(Buffer.alloc(0), 'utf-16le')).toBe('')
  })
})

describe('unknown labels', () => {
  test('createTextDecoder throws UnknownEncodingError, not RangeError', () => {
    expect(() => createTextDecoder('utf16')).toThrow(UnknownEncodingError)
  })

  test('the message names the label and shows valid ones', () => {
    // "utf16" is the exact label ripgrep also rejects, and the mistake a caller
    // makes reaching for "utf-16le".
    expect(() => createTextDecoder('utf16')).toThrow(/Unknown encoding "utf16"/)
    expect(() => createTextDecoder('utf16')).toThrow(/utf-16le/)
  })

  test('assertKnownEncoding accepts a good label and rejects a bad one', () => {
    expect(() => assertKnownEncoding('shift_jis')).not.toThrow()
    expect(() => assertKnownEncoding('definitely-not-an-encoding')).toThrow(
      UnknownEncodingError,
    )
  })

  test('a reused decoder resets between whole-buffer decodes', () => {
    // buildSymbolsOutput builds one decoder and runs it over up to 50 files;
    // a decode() without {stream:true} must not carry state into the next.
    const dec = createTextDecoder('utf-16le')
    expect(dec.decode(Buffer.from('one', 'utf16le'))).toBe('one')
    expect(dec.decode(Buffer.from('two', 'utf16le'))).toBe('two')
  })
})
