import { describe, expect, test } from 'bun:test'
import { formatCents, percentOf, sumCents } from '../src/money'

describe('percentOf', () => {
  test('whole percentages', () => {
    expect(percentOf(2000, 10)).toBe(200)
    expect(percentOf(1999, 50)).toBe(1000) // 999.5
  })

  test('rounds half-up to a whole cent', () => {
    expect(percentOf(250, 1)).toBe(3) // 2.5
    expect(percentOf(249, 1)).toBe(2) // 2.49
    expect(percentOf(1798, 4)).toBe(72) // 71.92
  })

  test('fractional rates are exact', () => {
    expect(percentOf(1250, 8.25)).toBe(103) // 103.125
    expect(percentOf(1000, 8.25)).toBe(83) // 82.5
  })

  test('negative amounts round away from zero', () => {
    expect(percentOf(-250, 1)).toBe(-3)
  })

  test('zero amount or zero rate', () => {
    expect(percentOf(0, 21)).toBe(0)
    expect(percentOf(1234, 0)).toBe(0)
  })
})

describe('formatCents', () => {
  test('dollars, euros and pounds', () => {
    expect(formatCents(1234, 'USD')).toBe('$12.34')
    expect(formatCents(5, 'EUR')).toBe('€0.05')
    expect(formatCents(100, 'GBP')).toBe('£1.00')
  })

  test('thousands separators', () => {
    expect(formatCents(123456789, 'USD')).toBe('$1,234,567.89')
  })

  test('negative amounts', () => {
    expect(formatCents(-360, 'USD')).toBe('-$3.60')
  })
})

test('sumCents', () => {
  expect(sumCents([])).toBe(0)
  expect(sumCents([1, 2, 3])).toBe(6)
})
