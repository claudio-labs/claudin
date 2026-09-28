import { describe, expect, test } from 'bun:test'
import { type Baseline, compare, serializeBaseline, toAllowances } from './ratchet.js'
import type { Row } from './scan.js'

const row = (file: string, claudeCode: number, openclaude: number): Row => ({ file, lines: 100, claudeCode, openclaude })

const baseline: Baseline = {
  capturedAt: '2026-09-27',
  capturedFrom: 'abc',
  files: { 'src/a.ts': [10, 2], 'src/gone.ts': [5, 0] },
}

describe('compare', () => {
  test('passes a tree that only shed inherited lines', () => {
    const result = compare([row('src/a.ts', 4, 2), row('src/own.ts', 0, 0)], baseline)
    expect(result.grown).toEqual([])
    // 6 from src/a.ts, 5 from the deleted src/gone.ts.
    expect(result.shed).toBe(11)
    expect(result.now).toEqual([4, 2])
    expect(result.baseline).toEqual([15, 2])
  })

  test('fails a file that grew in either origin, even when the tree total fell', () => {
    const result = compare([row('src/a.ts', 3, 3)], baseline)
    expect(result.grown).toEqual([{ file: 'src/a.ts', now: [3, 3], allowed: [10, 2] }])
  })

  test('a file the baseline never saw is allowed nothing, which is how a move shows up', () => {
    const result = compare([row('src/a.ts', 10, 2), row('src/moved.ts', 5, 0)], baseline)
    expect(result.grown).toEqual([{ file: 'src/moved.ts', now: [5, 0], allowed: [0, 0] }])
  })
})

describe('serializeBaseline', () => {
  test('writes one sorted file per line and parses back to the same allowances', () => {
    const files = toAllowances([row('src/z.ts', 1, 0), row('src/own.ts', 0, 0), row('src/b.ts', 2, 3)])
    const text = serializeBaseline({ capturedAt: '2026-09-27', capturedFrom: 'abc', files })
    const fileLines = text.split('\n').filter(l => l.startsWith('    "'))
    expect(fileLines).toEqual(['    "src/b.ts": [2, 3],', '    "src/z.ts": [1, 0]'])
    const parsed = JSON.parse(text) as { totals: unknown; files: unknown }
    expect(parsed.files).toEqual({ 'src/b.ts': [2, 3], 'src/z.ts': [1, 0] })
    expect(parsed.totals).toEqual({ claudeCode: 3, openclaude: 3 })
  })
})
