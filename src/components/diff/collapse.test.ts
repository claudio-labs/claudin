import type { StructuredPatchHunk } from 'diff'
import { describe, expect, test } from 'bun:test'
import { buildDiffRenderModel } from 'src/components/diff/collapse.js'

// A 20-line file; one hunk touching new lines 8-10 (3 context lines built in
// by git would normally widen this, but we keep it tight to exercise gaps).
const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

function hunk(
  newStart: number,
  newLines: number,
  oldStart = newStart,
  oldLines = newLines,
): StructuredPatchHunk {
  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines: Array.from({ length: newLines }, (_, i) => ` line ${newStart + i}`),
  }
}

describe('buildDiffRenderModel', () => {
  test('fails open to raw hunks when fileContent is undefined', () => {
    const hunks = [hunk(8, 3)]
    const model = buildDiffRenderModel(hunks, undefined)
    expect(model).toEqual([{ kind: 'hunk', hunk: hunks[0] }])
  })

  test('returns [] for no hunks', () => {
    expect(buildDiffRenderModel([], FILE)).toEqual([])
  })

  test('inserts head, and tail gap markers around a single hunk', () => {
    const model = buildDiffRenderModel([hunk(8, 3)], FILE)
    // head gap (lines 1-7), hunk, tail gap (lines 11-20)
    expect(model.map(s => s.kind)).toEqual(['gap', 'hunk', 'gap'])
    const head = model[0] as { kind: 'gap'; startLine: number; lineCount: number }
    expect(head).toMatchObject({ startLine: 1, lineCount: 7 })
    const tail = model[2] as { kind: 'gap'; startLine: number; lineCount: number }
    expect(tail).toMatchObject({ startLine: 11, lineCount: 10 })
  })

  test('a gap between two hunks is emitted', () => {
    const model = buildDiffRenderModel([hunk(3, 2), hunk(10, 2)], FILE)
    // head(1-2), hunk, gap(5-9), hunk, tail(12-20)
    expect(model.map(s => s.kind)).toEqual(['gap', 'hunk', 'gap', 'hunk', 'gap'])
    const mid = model[2] as { kind: 'gap'; startLine: number; lineCount: number }
    expect(mid).toMatchObject({ startLine: 5, lineCount: 5 })
  })

  test('expandAll reveals every gap as context hunks (no markers)', () => {
    const model = buildDiffRenderModel([hunk(8, 3)], FILE, new Map(), true)
    expect(model.every(s => s.kind === 'hunk')).toBe(true)
    const headHunk = model[0]
    expect(headHunk.kind).toBe('hunk')
    if (headHunk.kind === 'hunk') {
      expect(headHunk.hunk.newStart).toBe(1)
      expect(headHunk.hunk.newLines).toBe(7)
      expect(headHunk.hunk.lines[0]).toBe(' line 1')
    }
  })

  test('partial reveal splits a gap into a context hunk + smaller marker', () => {
    // Reveal 3 of the tail gap (lines 11-20, id gap@11).
    const revealed = new Map([['gap@11', 3]])
    const model = buildDiffRenderModel([hunk(8, 3)], FILE, revealed)
    // head gap, hunk, revealed-context hunk (11-13), remaining gap (14-20)
    expect(model.map(s => s.kind)).toEqual(['gap', 'hunk', 'hunk', 'gap'])
    const remaining = model[3] as {
      kind: 'gap'
      id: string
      startLine: number
      lineCount: number
    }
    expect(remaining).toMatchObject({
      id: 'gap@11',
      startLine: 14,
      lineCount: 7,
    })
  })

  test('reveal larger than the gap clamps to full reveal', () => {
    const revealed = new Map([['gap@11', 999]])
    const model = buildDiffRenderModel([hunk(8, 3)], FILE, revealed)
    expect(model.map(s => s.kind)).toEqual(['gap', 'hunk', 'hunk'])
  })

  test('a trailing newline does not reveal a phantom blank line at EOF', () => {
    // 3-line file WITH a trailing newline: split('\n') yields a 4th empty
    // element that must not become a context line in the tail gap.
    const file = 'line 1\nline 2\nline 3\n'
    const model = buildDiffRenderModel([hunk(1, 1)], file, undefined, true)
    // head hunk (line 1) + fully-revealed tail (lines 2-3), all hunks, no gaps.
    expect(model.every(s => s.kind === 'hunk')).toBe(true)
    const tail = model[model.length - 1]
    expect(tail.kind).toBe('hunk')
    if (tail.kind === 'hunk') {
      // Tail covers exactly lines 2 and 3 — not a spurious empty line 4.
      expect(tail.hunk.newStart).toBe(2)
      expect(tail.hunk.newLines).toBe(2)
      expect(tail.hunk.lines).toEqual([' line 2', ' line 3'])
    }
  })
})
