import { describe, expect, test } from 'bun:test'

import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import {
  coveredSegments,
  seenRegionCoversText,
} from 'src/tools/shared/readBeforeEditMessages.js'
import {
  fileLinesOf,
  locateExactLines,
  locateExactText,
  MAX_SERVED_LINES,
  mergeServedRegions,
  SERVED_REGION_CONTEXT_LINES,
  serveRegions,
} from 'src/tools/shared/servedRegion.js'

const LINES = Array.from({ length: 20 }, (_, i) => `l${i + 1}`)
const TEXT = `${LINES.join('\n')}\n`

describe('fileLinesOf', () => {
  test('drops the trailing newline phantom line, like the coverage lane', () => {
    expect(fileLinesOf('a\nb\n')).toEqual(['a', 'b'])
    expect(fileLinesOf('a\nb')).toEqual(['a', 'b'])
    expect(fileLinesOf('')).toEqual([])
    expect(fileLinesOf('\n')).toEqual([])
  })
})

describe('locateExactLines', () => {
  test('finds a unique block and reports 1-based inclusive lines', () => {
    expect(locateExactLines(LINES, ['l7', 'l8', 'l9'])).toEqual({ start: 7, end: 9 })
  })

  test('compares trimmed, the way the coverage lane does', () => {
    expect(locateExactLines(['  const a = 1', 'const b = 2'], ['const a = 1'])).toEqual(
      { start: 1, end: 1 },
    )
  })

  test('refuses an absent block', () => {
    expect(locateExactLines(LINES, ['nowhere'])).toBeNull()
    expect(locateExactLines(LINES, ['l7', 'l9'])).toBeNull()
  })

  test('refuses an ambiguous block — the gate must not guess', () => {
    expect(locateExactLines(['x', 'y', 'x', 'y'], ['x', 'y'])).toBeNull()
  })

  test('a blank-only needle localizes nothing', () => {
    expect(locateExactLines(LINES, [])).toBeNull()
    expect(locateExactLines(['', 'a', ''], ['', ''])).toBeNull()
  })
})

describe('locateExactText', () => {
  test('a needle that starts and ends mid-line spans the right lines', () => {
    expect(locateExactText(TEXT, '5\nl6\nl')).toEqual({ start: 5, end: 7 })
  })

  test('a whole-line needle with its newline does not spill onto the next line', () => {
    expect(locateExactText(TEXT, 'l3\n')).toEqual({ start: 3, end: 3 })
  })

  test('refuses absent, ambiguous and blank needles', () => {
    expect(locateExactText(TEXT, 'nowhere')).toBeNull()
    expect(locateExactText(TEXT, 'l1')).toBeNull() // l1, l10..l19
    expect(locateExactText(TEXT, '   ')).toBeNull()
  })
})

describe('mergeServedRegions', () => {
  test('widens by the context lines and clamps to the file', () => {
    expect(mergeServedRegions([{ start: 1, end: 1 }], 20)).toEqual([
      { start: 1, end: 1 + SERVED_REGION_CONTEXT_LINES },
    ])
    expect(mergeServedRegions([{ start: 20, end: 20 }], 20)).toEqual([
      { start: 20 - SERVED_REGION_CONTEXT_LINES, end: 20 },
    ])
  })

  test('merges regions that touch or overlap after widening', () => {
    expect(
      mergeServedRegions([{ start: 10, end: 10 }, { start: 3, end: 4 }, { start: 13, end: 14 }], 20),
    ).toEqual([
      { start: 1, end: 6 },
      { start: 8, end: 16 },
    ])
  })

  test('refuses past the cap', () => {
    expect(mergeServedRegions([{ start: 1, end: MAX_SERVED_LINES + 1 }], 1000)).toBeNull()
    // The context lines count toward the cap: 196 matched + 2 + 2 = 200.
    expect(
      mergeServedRegions([{ start: 10, end: 10 + MAX_SERVED_LINES - 5 }], 1000),
    ).toEqual([{ start: 8, end: 7 + MAX_SERVED_LINES }])
  })
})

describe('serveRegions', () => {
  test('renders like Read and registers one slice per region, exempt from dedup', () => {
    const cache = new FileStateCache(10, 1024 * 1024)
    const rendered = serveRegions(cache, '/f.txt', LINES, 123, [
      { start: 2, end: 3 },
      { start: 9, end: 10 },
    ])

    expect(rendered).toContain('2→l2')
    expect(rendered).toContain('3→l3')
    expect(rendered).toContain('9→l9')
    expect(rendered).toContain('…')

    const entry = cache.get('/f.txt')!
    expect(entry).toMatchObject({
      timestamp: 123,
      offset: 9,
      limit: 2,
      dedupExempt: true,
      content: 'l9\nl10\n',
    })
    // The first region was carried onto the second: both authorize a write.
    expect(coveredSegments(entry).map(s => [s.offset, s.lines.length])).toEqual([
      [2, 2],
      [9, 2],
    ])
    expect(seenRegionCoversText(entry, 'l2\nl3')).toBe(true)
    expect(seenRegionCoversText(entry, 'l5')).toBe(false)
  })

  test('a previous slice of the same version survives the serve', () => {
    const cache = new FileStateCache(10, 1024 * 1024)
    cache.set('/f.txt', { content: 'l15\nl16\n', timestamp: 123, offset: 15, limit: 2 })
    serveRegions(cache, '/f.txt', LINES, 123, [{ start: 2, end: 3 }])
    expect(seenRegionCoversText(cache.get('/f.txt')!, 'l15\nl16')).toBe(true)
  })

  test('a previous slice of an OLDER version does not', () => {
    const cache = new FileStateCache(10, 1024 * 1024)
    cache.set('/f.txt', { content: 'l15\nl16\n', timestamp: 100, offset: 15, limit: 2 })
    serveRegions(cache, '/f.txt', LINES, 123, [{ start: 2, end: 3 }])
    expect(seenRegionCoversText(cache.get('/f.txt')!, 'l15\nl16')).toBe(false)
  })
})
