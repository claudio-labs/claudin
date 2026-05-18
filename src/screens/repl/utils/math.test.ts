import { describe, expect, test } from 'bun:test'
import { median } from './math.js'

describe('median', () => {
  test('odd-length: returns the middle element', () => {
    expect(median([1, 2, 3])).toBe(2)
    expect(median([5, 1, 9])).toBe(5)
  })

  test('even-length: returns the rounded average of the two midpoints', () => {
    expect(median([1, 2, 3, 4])).toBe(3) // (2+3)/2 = 2.5 → 3
    expect(median([1, 2, 3, 5])).toBe(3) // (2+3)/2 = 2.5 → 3
    expect(median([10, 20])).toBe(15)
  })

  test('does not mutate the input', () => {
    const input = [3, 1, 2]
    median(input)
    expect(input).toEqual([3, 1, 2])
  })

  test('single element returns itself', () => {
    expect(median([42])).toBe(42)
  })

  test('handles negative numbers', () => {
    expect(median([-3, -1, -2])).toBe(-2)
  })
})
