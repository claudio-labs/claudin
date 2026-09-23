import { expect, test } from 'bun:test'
import { REGIONS } from '../src/regions'
import { lineTax } from '../src/tax'

test('uses the rate of the tax class in the region', () => {
  expect(lineTax(10000, 'standard', REGIONS.US)).toBe(825)
  expect(lineTax(10000, 'reduced', REGIONS.EU)).toBe(900)
  expect(lineTax(10000, 'standard', REGIONS.UK)).toBe(2000)
})

test('exempt items pay no tax', () => {
  expect(lineTax(2500, 'exempt', REGIONS.EU)).toBe(0)
})

test('rounds half-up per line', () => {
  expect(lineTax(1250, 'standard', REGIONS.US)).toBe(103) // 103.125
  expect(lineTax(1000, 'standard', REGIONS.US)).toBe(83) // 82.5
})
