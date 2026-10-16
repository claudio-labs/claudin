import { describe, expect, test } from 'bun:test'

import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  countIndexEntries,
  fitEntrypointContent,
} from 'src/memory/memdir/memdir.js'

// The cap is named BYTES and rendered through formatFileSize(), so it has to be
// measured and cut in byte space. Measuring with `.length` (UTF-16 code units)
// undercounts multibyte content by up to ~4x, which let a large non-ASCII
// MEMORY.md ship whole into the system prompt every turn while reporting
// wasByteTruncated: false. Every case below fails against a `.length` version.
describe('fitEntrypointContent byte cap', () => {
  test('fires on multibyte content that is under the cap in characters', () => {
    // 50 short lines of CJK: under the line cap, under the byte cap when
    // counted as characters, ~3x over it in real bytes (each 一 is 3 bytes).
    const line = '一'.repeat(498)
    const raw = Array.from({ length: 50 }, () => line).join('\n')

    expect(raw.split('\n').length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES)
    expect(raw.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(Buffer.byteLength(raw)).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)

    const result = fitEntrypointContent(raw)

    expect(result.wasByteTruncated).toBe(true)
    expect(result.byteCount).toBe(Buffer.byteLength(raw))
    expect(Buffer.byteLength(bodyOf(result.content))).toBeLessThanOrEqual(
      MAX_ENTRYPOINT_BYTES,
    )
  })

  test('leaves small multibyte content untouched', () => {
    const raw = '# 見出し\n\n- 項目一つ\n- 項目二つ'
    const result = fitEntrypointContent(raw)

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

    const result = fitEntrypointContent(raw)

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
    const result = fitEntrypointContent(raw)

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

    const result = fitEntrypointContent(raw)

    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)
    const body = bodyOf(result.content)
    expect(body.endsWith(line)).toBe(true)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
  })
})

// Over a cap, the index gives up blank lines, then hooks from the bottom up,
// and only then its tail — every entry keeps its pointer for as long as it can.
describe('fitEntrypointContent coverage first', () => {
  const entry = (i: number, hook = 'what it covers, why it matters, who measured it first, which file it lives in, and the follow-up still open on it today') =>
    `- [Memory ${String(i).padStart(3, '0')}](m${i}.md) — ${hook}`
  const sections = (perSection: number, count: number, line = entry) =>
    Array.from({ length: count }, (_, s) =>
      [`## Section ${s}`, ...Array.from({ length: perSection }, (_, i) => line(s * perSection + i))].join('\n'),
    ).join('\n\n')

  test('over the line cap only through its blank lines: every entry, every hook, a NOTE', () => {
    // 10 sections of 19 entries, blank lines between: 209 lines, 199 without them.
    const raw = sections(19, 10, i => `- [M${i}](m${i}.md) — h`)
    expect(raw.split('\n').length).toBeGreaterThan(MAX_ENTRYPOINT_LINES)
    const result = fitEntrypointContent(raw)
    expect(countIndexEntries(result.content)).toBe(190)
    expect(result.shortenedEntryCount).toBe(0)
    expect(result.content).toContain('> NOTE: MEMORY.md is 209 lines (limit: 200). Every entry was loaded, its blank lines dropped.')
    expect(result.content).not.toContain('WARNING')
    expect(result.content).toContain(`- [M189](m189.md) — h`)
  })

  test('over the byte cap: hooks go from the bottom up, every pointer stays', () => {
    const raw = sections(20, 9)
    expect(Buffer.byteLength(raw)).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)
    const result = fitEntrypointContent(raw)
    const body = result.content.split('\n\n> NOTE:')[0]!
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(countIndexEntries(body)).toBe(180)
    expect(body).toContain(entry(0))
    expect(body.split('\n').at(-1)).toBe('- [Memory 179](m179.md)')
    const hookless = body.split('\n').filter(l => l.startsWith('- ') && !l.includes(' — '))
    expect(hookless.length).toBe(result.shortenedEntryCount)
    expect(result.shortenedEntryCount).toBeGreaterThan(0)
    expect(result.content).toContain(`${result.shortenedEntryCount} entries are shown without their hook`)
  })

  test('the hook is what follows the last link, so a grouped line and a dashed title keep their links', () => {
    // At the bottom, so they are the first the byte cap shortens.
    const filler = Array.from({ length: 190 }, (_, i) => entry(i)).join('\n')
    const dashed = '- [Index — the cut](cut.md) — why the tail went'
    const grouped = '- Censuses: [09-08](c1.md) · [09-20](c2.md) — rewrites are 39% of the cost'
    const plain = '- A note with no link at all — and a dash'
    // A pointer inside what follows the first dash is still a pointer: it stays.
    const seeAlso = '- [Retry policy](retry.md) — see also [backoff](backoff.md)'
    const result = fitEntrypointContent([filler, dashed, grouped, plain, seeAlso].join('\n'))
    const body = result.content.split('\n\n> ')[0]!.split('\n')
    expect(body.slice(-4)).toEqual([
      '- [Index — the cut](cut.md)',
      '- Censuses: [09-08](c1.md) · [09-20](c2.md)',
      plain,
      seeAlso,
    ])
  })

  test('still over once every hook is gone: the tail is cut, and the warning says both', () => {
    // 200 entries whose pointers alone pass the byte cap.
    const longTitle = 'x'.repeat(140)
    const raw = Array.from({ length: 200 }, (_, i) => `- [${longTitle}](m${i}.md) — hook ${i}`).join('\n')
    const result = fitEntrypointContent(raw)
    expect(result.content).toContain('> WARNING:')
    expect(result.content).toContain('Only part of it was loaded, and 200 entries are shown without their hook')
    expect(Buffer.byteLength(result.content.split('\n\n> WARNING:')[0]!)).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(countIndexEntries(result.content)).toBeLessThan(200)
  })

  test('within both caps nothing changes, blank lines included', () => {
    const raw = sections(5, 3)
    const result = fitEntrypointContent(raw)
    expect(result.content).toBe(raw)
    expect(result.shortenedEntryCount).toBe(0)
  })
})

// countIndexEntries is what the transcript's "Loaded N memories" line counts,
// and it is read on both sides of fitEntrypointContent — the loaded body
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
    const truncated = fitEntrypointContent(
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
