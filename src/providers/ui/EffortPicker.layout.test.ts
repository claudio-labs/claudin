import { describe, expect, test } from 'bun:test'
import {
  computeSliderLayout,
  FASTER_LABEL,
  fitSliderLayout,
  SLIDER_GAP,
  SLIDER_GAP_MIN,
  SLIDER_MARKER,
  SMARTER_LABEL,
} from 'src/providers/ui/EffortPicker.layout.js'

const LABELS = ['Adaptive', 'Low', 'Medium', 'High', 'Extra', 'Max']

describe('computeSliderLayout', () => {
  test('label starts are cumulative with the gap', () => {
    const { labelStarts } = computeSliderLayout(LABELS, 0)
    expect(labelStarts[0]).toBe(0)
    expect(labelStarts[1]).toBe('Adaptive'.length + SLIDER_GAP)
    expect(labelStarts[2]).toBe(
      'Adaptive'.length + SLIDER_GAP + 'Low'.length + SLIDER_GAP,
    )
  })

  test('total width matches the last label end column', () => {
    const { totalWidth, labelStarts } = computeSliderLayout(LABELS, 0)
    const lastStart = labelStarts[LABELS.length - 1]!
    expect(totalWidth).toBe(lastStart + LABELS[LABELS.length - 1]!.length)
  })

  test('marker is centered on the focused label', () => {
    const focus = 2 // 'Medium'
    const { markerColumn, labelStarts, ruleLine } = computeSliderLayout(
      LABELS,
      focus,
    )
    expect(markerColumn).toBe(
      labelStarts[focus]! + Math.floor('Medium'.length / 2),
    )
    expect(ruleLine[markerColumn]).toBe(SLIDER_MARKER)
  })

  test('rule line width equals total width and has exactly one marker', () => {
    const { ruleLine, totalWidth } = computeSliderLayout(LABELS, 3)
    expect(ruleLine.length).toBe(totalWidth)
    expect([...ruleLine].filter(c => c === SLIDER_MARKER).length).toBe(1)
  })

  test('header: Faster flush left, Smarter flush right', () => {
    const { headerLine, totalWidth } = computeSliderLayout(LABELS, 0)
    expect(headerLine.startsWith(FASTER_LABEL)).toBe(true)
    expect(headerLine.endsWith(SMARTER_LABEL)).toBe(true)
    expect(headerLine.length).toBe(totalWidth)
  })

  test('header falls back to Faster…Smarter for a single label', () => {
    const { headerLine } = computeSliderLayout(['only'], 0)
    expect(headerLine.startsWith(FASTER_LABEL)).toBe(true)
    expect(headerLine.endsWith(SMARTER_LABEL)).toBe(true)
  })

  test('handles an empty label list without throwing', () => {
    const { totalWidth, markerColumn, ruleLine } = computeSliderLayout([], 0)
    expect(totalWidth).toBe(0)
    expect(markerColumn).toBe(0)
    expect(ruleLine).toBe('')
  })

  test('marker is a single-codepoint ASCII glyph (Ghostty width safety)', () => {
    // Regression guard: an East-Asian-ambiguous marker (e.g. ▲ U+25B2) renders
    // 2 cells wide in Ghostty and drifts the rule out of column alignment.
    expect([...SLIDER_MARKER].length).toBe(1)
    expect(SLIDER_MARKER.codePointAt(0)!).toBeLessThan(0x80)
  })

  test('clamps an out-of-range focus index', () => {
    const high = computeSliderLayout(LABELS, 999)
    expect(high.ruleLine.indexOf(SLIDER_MARKER)).toBeGreaterThanOrEqual(0)
    const low = computeSliderLayout(LABELS, -5)
    expect(low.ruleLine.indexOf(SLIDER_MARKER)).toBe(
      Math.floor(LABELS[0]!.length / 2),
    )
  })

  test('reports the gap it was built with (default and explicit)', () => {
    expect(computeSliderLayout(LABELS, 0).gap).toBe(SLIDER_GAP)
    expect(computeSliderLayout(LABELS, 0, 2).gap).toBe(2)
  })
})

describe('fitSliderLayout', () => {
  test('uses the full gap when it fits', () => {
    const full = computeSliderLayout(LABELS, 0, SLIDER_GAP)
    const fitted = fitSliderLayout(LABELS, 0, full.totalWidth)
    expect(fitted.gap).toBe(SLIDER_GAP)
    expect(fitted.totalWidth).toBe(full.totalWidth)
  })

  test('shrinks the gap to fit a narrow width, staying column-aligned', () => {
    const full = computeSliderLayout(LABELS, 0, SLIDER_GAP)
    const narrow = full.totalWidth - 6
    const fitted = fitSliderLayout(LABELS, 2, narrow)
    expect(fitted.gap).toBeLessThan(SLIDER_GAP)
    expect(fitted.totalWidth).toBeLessThanOrEqual(narrow)
    // Rule/marker derived from the same gap → marker still on the focused label.
    expect(fitted.ruleLine.length).toBe(fitted.totalWidth)
    expect(fitted.ruleLine[fitted.markerColumn]).toBe(SLIDER_MARKER)
  })

  test('never shrinks below the minimum gap even if it overflows', () => {
    const fitted = fitSliderLayout(LABELS, 0, 1)
    expect(fitted.gap).toBe(SLIDER_GAP_MIN)
  })
})
