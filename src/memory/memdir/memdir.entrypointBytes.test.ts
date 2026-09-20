import { describe, expect, test } from 'bun:test'

import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  countIndexEntries,
  truncateEntrypointContent,
} from 'src/memory/memdir/memdir.js'

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

// countIndexEntries is what the transcript's "Loaded N memories" line counts,
// and it is read on both sides of truncateEntrypointContent — the loaded body
// and the raw one — so the gap between the two is the truncation signal.
describe('countIndexEntries', () => {
  test('counts top-level bullets, not headings or blank lines', () => {
    const index = [
      '# Memory',
      '',
      '- [One](one.md) — hook',
      '- [Two](two.md) — hook',
      '',
      '## Section',
      '- [Three](three.md) — hook',
    ].join('\n')
    expect(countIndexEntries(index)).toBe(3)
  })

  test('counts an entry that groups several memories behind prose', () => {
    // Real shape in this repo's team index: three entries open with text
    // instead of `[`, and a bracket-only regex silently drops them.
    const index = [
      '- [One](one.md) — hook',
      '- Dead-code rounds 2–4: [r2](r2.md) · [r3](r3.md) · [r4](r4.md)',
    ].join('\n')
    expect(countIndexEntries(index)).toBe(2)
  })

  test('a nested sub-bullet is not an entry', () => {
    const index = '- [One](one.md) — hook\n  - a detail under it'
    expect(countIndexEntries(index)).toBe(1)
  })

  test('the WARNING line truncation appends is not an entry', () => {
    const truncated = truncateEntrypointContent(
      Array.from({ length: 250 }, (_, i) => `- [M${i}](m${i}.md) — hook`).join('\n'),
    )
    expect(truncated.wasLineTruncated).toBe(true)
    expect(truncated.content).toContain('> WARNING:')
    expect(countIndexEntries(truncated.content)).toBe(MAX_ENTRYPOINT_LINES)
  })

  test('an index with no entries counts zero rather than throwing', () => {
    expect(countIndexEntries('')).toBe(0)
    expect(countIndexEntries('# Memory\n\nNothing here yet.')).toBe(0)
  })
})

function bodyOf(content: string): string {
  return content.split('\n\n> WARNING:')[0]!
}
