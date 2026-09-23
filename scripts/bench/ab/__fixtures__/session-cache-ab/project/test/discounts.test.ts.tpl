import { describe, expect, test } from 'bun:test'
import { applyCoupons, describeCoupon } from '../src/discounts'
import { CouponError } from '../src/errors'
import type { Coupon, PricedLine } from '../src/types'
import { product } from './helpers'

function priced(sku: string, category: string, unitCents: number, qty: number): PricedLine {
  return { product: product({ sku, category, unitCents }), qty, unitCents, lineCents: unitCents * qty }
}

const tea = priced('TEA-001', 'tea', 899, 2) // 1798
const mug = priced('MUG-001', 'kitchen', 1250, 1) // 1250

describe('applyCoupons', () => {
  test('no coupons, no discount', () => {
    expect(applyCoupons([tea, mug], [])).toEqual({ lineDiscounts: [0, 0], applied: [] })
  })

  test('a percent coupon covers every line, rounding per line', () => {
    const result = applyCoupons([tea, mug], [{ code: 'WELCOME10', kind: 'percent', value: 10 }])
    expect(result.lineDiscounts).toEqual([180, 125]) // 179.8 rounds to 180
    expect(result.applied).toEqual([{ code: 'WELCOME10', label: '-10%', discountCents: 305 }])
  })

  test('a category coupon covers only its category', () => {
    const result = applyCoupons([tea, mug], [{ code: 'TEA20', kind: 'category', category: 'tea', value: 20 }])
    expect(result.lineDiscounts).toEqual([360, 0])
    expect(result.applied[0]?.label).toBe('-20% tea')
  })

  test('each coupon takes its share of what the previous ones left', () => {
    const coupons: Coupon[] = [
      { code: 'WELCOME10', kind: 'percent', value: 10 },
      { code: 'EXTRA10', kind: 'percent', value: 10 },
    ]
    const result = applyCoupons([priced('ABC-001', 'misc', 1000, 1)], coupons)
    expect(result.lineDiscounts).toEqual([190])
    expect(result.applied.map(c => c.discountCents)).toEqual([100, 90])
  })

  test('a coupon that covers no line is an error', () => {
    expect(() => applyCoupons([mug], [{ code: 'TEA20', kind: 'category', category: 'tea', value: 20 }])).toThrow(
      CouponError,
    )
  })
})

test('describeCoupon', () => {
  expect(describeCoupon({ code: 'A10', kind: 'percent', value: 10 })).toBe('-10%')
  expect(describeCoupon({ code: 'C15', kind: 'category', category: 'coffee', value: 15 })).toBe('-15% coffee')
})
