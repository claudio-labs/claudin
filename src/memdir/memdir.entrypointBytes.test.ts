import { describe, expect, test } from 'bun:test'

import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from 'src/memdir/memdir.js'

// The cap is named BYTES and rendered through formatFileSize(), so it has to be
// measured and cut in byte space. Measuring with `.length` (UTF-16 code units)
// undercounts multibyte content by up to ~4x, which let a large non-ASCII
// MEMORY.md ship whole into the system prompt every turn while reporting
// wasByteTruncated: false. Every case below fails against a `.length` version.
describe('truncateEntrypointContent byte cap', () => {
  test('fires on multibyte content that is under the cap in characters', () => {
    // 50 short lines of CJK: under the line cap, under the byte cap when
    // counted as characters, ~3x over it in real bytes (each 一 is 3 bytes).
    const line = '一'.repeat(498)
    const raw = Array.from({ length: 50 }, () => line).join('\n')

    expect(raw.split('\n').length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES)
    expect(raw.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(Buffer.byteLength(raw)).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)

    const result = truncateEntrypointContent(raw)

    expect(result.wasByteTruncated).toBe(true)
    expect(result.byteCount).toBe(Buffer.byteLength(raw))
    expect(Buffer.byteLength(bodyOf(result.content))).toBeLessThanOrEqual(
      MAX_ENTRYPOINT_BYTES,
    )
  })

  test('leaves small multibyte content untouched', () => {
    const raw = '# 見出し\n\n- 項目一つ\n- 項目二つ'
    const result = truncateEntrypointContent(raw)

    expect(result.wasByteTruncated).toBe(false)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.content).toBe(raw)
    expect(result.byteCount).toBe(Buffer.byteLength(raw))
  })

  test('line-truncates first, then byte-cuts the already clipped result', () => {
    // 250 lines where even the first 200 are ~60KB (100 CJK chars = 300 bytes
    // per line), so both caps fire and the byte cut runs on the line-clipped
    // body — the combined path.
    const line = '一'.repeat(100)
    const raw = Array.from({ length: 250 }, () => line).join('\n')

    const result = truncateEntrypointContent(raw)

    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain('lines and')
    const body = bodyOf(result.content)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(body).not.toContain('\uFFFD')
  })

  test('the hard cut lands on a character boundary, not mid-character', () => {
    // One 30KB line with no newline before the cap forces the hard-cut branch.
    // Byte 25000 lands inside a 3-byte 一; decoding a split character yields
    // U+FFFD, which is itself 3 bytes and puts the body back over the cap.
    const raw = '一'.repeat(10_000)
    const result = truncateEntrypointContent(raw)

    expect(result.wasByteTruncated).toBe(true)
    const body = bodyOf(result.content)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(body).not.toContain('\uFFFD')
  })

  test('still cuts at a newline when there is one before the cap', () => {
    // ASCII, so bytes and characters agree: the pre-existing behavior of
    // preferring the last newline must survive the move to byte space. 150
    // lines keeps this under the line cap so only the byte path runs.
    const line = 'x'.repeat(200)
    const raw = Array.from({ length: 150 }, () => line).join('\n')

    const result = truncateEntrypointContent(raw)

    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)
    const body = bodyOf(result.content)
    expect(body.endsWith(line)).toBe(true)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
  })
})

function bodyOf(content: string): string {
  return content.split('\n\n> WARNING:')[0]!
}
