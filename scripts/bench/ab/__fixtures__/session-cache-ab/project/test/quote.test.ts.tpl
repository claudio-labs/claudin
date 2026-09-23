import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { loadCart } from '../src/cart'
import { loadCatalog } from '../src/catalog'
import { UnknownSkuError } from '../src/errors'
import { buildQuote } from '../src/quote'
import { cartOf } from './helpers'

const data = (path: string) => fileURLToPath(new URL('../data/' + path, import.meta.url))
const catalog = loadCatalog(data('catalog.json'))
const quoteFor = (cartFile: string) => buildQuote(loadCart(data('carts/' + cartFile)), catalog)

describe('sample carts', () => {
  test('basic-us: no coupons', () => {
    const q = quoteFor('basic-us.json')
    expect(q.currency).toBe('USD')
    expect(q.subtotalCents).toBe(3048)
    expect(q.discountCents).toBe(0)
    expect(q.taxCents).toBe(175) // 72 reduced + 103 standard
    expect(q.shippingCents).toBe(599)
    expect(q.totalCents).toBe(3822)
  })

  test('coupons-eu: a category coupon, then a percent coupon, free shipping', () => {
    const q = quoteFor('coupons-eu.json')
    expect(q.subtotalCents).toBe(12646)
    expect(q.coupons.map(c => [c.code, c.discountCents])).toEqual([
      ['COFFEE15', 870],
      ['WELCOME10', 1178],
    ])
    expect(q.discountCents).toBe(2048)
    expect(q.taxCents).toBe(1428)
    expect(q.shippingCents).toBe(0)
    expect(q.totalCents).toBe(12026)
  })

  test('uk-books: an exempt gift card and a books coupon', () => {
    const q = quoteFor('uk-books.json')
    expect(q.subtotalCents).toBe(5892)
    expect(q.discountCents).toBe(379)
    expect(q.taxCents).toBe(375)
    expect(q.shippingCents).toBe(674)
    expect(q.totalCents).toBe(6562)
  })
})

describe('buildQuote', () => {
  test('line amounts and per-line discounts', () => {
    const cart = cartOf('US', [{ sku: 'TEA-001', qty: 2 }], [{ code: 'TEA20', kind: 'category', category: 'tea', value: 20 }])
    expect(buildQuote(cart, catalog).lines).toEqual([
      { sku: 'TEA-001', name: 'Green Tea 100g', qty: 2, unitCents: 899, lineCents: 1798, discountCents: 360, taxCents: 58 },
    ])
  })

  test('the region option overrides the cart region', () => {
    const q = buildQuote(cartOf('US', [{ sku: 'MUG-001', qty: 1 }]), catalog, { region: 'UK' })
    expect(q.region).toBe('UK')
    expect(q.currency).toBe('GBP')
    expect(q.taxCents).toBe(250)
  })

  test('gift cards alone ship for nothing', () => {
    const q = buildQuote(cartOf('EU', [{ sku: 'GFT-025', qty: 1 }]), catalog)
    expect(q.shippingCents).toBe(0)
    expect(q.totalCents).toBe(2500)
  })

  test('an unknown SKU is reported', () => {
    expect(() => buildQuote(cartOf('US', [{ sku: 'ZZZ-999', qty: 1 }]), catalog)).toThrow(UnknownSkuError)
  })
})
