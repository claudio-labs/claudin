import { describe, expect, test } from 'bun:test'
import { mergeLines, parseCart } from '../src/cart'
import { CouponError, ValidationError } from '../src/errors'

const line = (sku: string, qty: number) => ({ sku, qty })

describe('parseCart', () => {
  test('parses lines and coupons', () => {
    const cart = parseCart({
      region: 'EU',
      lines: [line('TEA-001', 2)],
      coupons: [{ code: 'TEA20', kind: 'category', category: 'tea', value: 20 }],
    })
    expect(cart.region).toBe('EU')
    expect(cart.lines).toEqual([line('TEA-001', 2)])
    expect(cart.coupons).toEqual([{ code: 'TEA20', kind: 'category', category: 'tea', value: 20 }])
  })

  test('the region defaults to US and the coupons to none', () => {
    const cart = parseCart({ lines: [line('TEA-001', 1)] })
    expect(cart.region).toBe('US')
    expect(cart.coupons).toEqual([])
  })

  test('rejects an unknown region', () => {
    expect(() => parseCart({ region: 'BR', lines: [line('TEA-001', 1)] })).toThrow('unknown region "BR"')
  })

  test('rejects an empty cart', () => {
    expect(() => parseCart({ lines: [] })).toThrow('at least one line')
  })

  test.each([0, -1, 1.5, 1000])('rejects qty %p', qty => {
    expect(() => parseCart({ lines: [line('TEA-001', qty)] })).toThrow(ValidationError)
  })

  test('rejects a malformed SKU', () => {
    expect(() => parseCart({ lines: [line('tea1', 1)] })).toThrow('sku must look like ABC-123')
  })

  test('merges lines for the same SKU', () => {
    const cart = parseCart({ lines: [line('TEA-001', 1), line('MUG-001', 1), line('TEA-001', 2)] })
    expect(cart.lines).toEqual([line('TEA-001', 3), line('MUG-001', 1)])
  })
})

describe('coupons', () => {
  const cartWith = (...coupons: unknown[]) => parseCart({ lines: [line('TEA-001', 1)], coupons })

  test('rejects a malformed code', () => {
    expect(() => cartWith({ code: 'x', kind: 'percent', value: 10 })).toThrow('code must be')
  })

  test('rejects a value out of range', () => {
    expect(() => cartWith({ code: 'BIG', kind: 'percent', value: 150 })).toThrow('value must be')
    expect(() => cartWith({ code: 'ZERO', kind: 'percent', value: 0 })).toThrow('value must be')
  })

  test('rejects an unknown kind', () => {
    expect(() => cartWith({ code: 'FIVE', kind: 'fixed', value: 5 })).toThrow('kind must be')
  })

  test('a category coupon needs its category', () => {
    expect(() => cartWith({ code: 'TEA20', kind: 'category', value: 20 })).toThrow('needs a category')
  })

  test('rejects a code used twice', () => {
    const coupon = { code: 'WELCOME10', kind: 'percent', value: 10 }
    expect(() => cartWith(coupon, coupon)).toThrow(CouponError)
  })
})

test('mergeLines rejects a merged qty above the limit', () => {
  expect(() => mergeLines([line('TEA-001', 600), line('TEA-001', 600)])).toThrow('exceeds 999')
})
