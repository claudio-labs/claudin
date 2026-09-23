import { describe, expect, test } from 'bun:test'
import { REGIONS } from '../src/regions'
import { shippingCost, totalWeight } from '../src/shipping'
import { product } from './helpers'

describe('shippingCost', () => {
  test('the base fee covers the first kilogram', () => {
    expect(shippingCost(1, 1000, REGIONS.US)).toBe(599)
    expect(shippingCost(1000, 1000, REGIONS.US)).toBe(599)
  })

  test('every further kilogram started adds the per-kg fee', () => {
    expect(shippingCost(1001, 1000, REGIONS.US)).toBe(749)
    expect(shippingCost(2960, 1000, REGIONS.EU)).toBe(1299)
  })

  test('free from the region threshold', () => {
    expect(shippingCost(500, 7499, REGIONS.US)).toBe(599)
    expect(shippingCost(500, 7500, REGIONS.US)).toBe(0)
    expect(shippingCost(500, 6000, REGIONS.UK)).toBe(0)
  })

  test('nothing to ship costs nothing', () => {
    expect(shippingCost(0, 100, REGIONS.EU)).toBe(0)
  })
})

test('totalWeight sums weight × qty', () => {
  const lines = [
    { product: product({ sku: 'ABC-001', weightGrams: 120 }), qty: 2 },
    { product: product({ sku: 'ABC-002', weightGrams: 0 }), qty: 5 },
  ]
  expect(totalWeight(lines)).toBe(240)
})
