import { expect, test } from 'bun:test'
import { RECEIPT_WIDTH, renderReceipt } from '../src/receipt'
import type { Quote } from '../src/types'

const quote: Quote = {
  region: 'US',
  currency: 'USD',
  lines: [
    { sku: 'TEA-001', name: 'Green Tea 100g', qty: 2, unitCents: 899, lineCents: 1798, discountCents: 360, taxCents: 58 },
    { sku: 'MUG-001', name: 'Ceramic Mug', qty: 1, unitCents: 1250, lineCents: 1250, discountCents: 0, taxCents: 103 },
  ],
  coupons: [{ code: 'TEA20', label: '-20% tea', discountCents: 360 }],
  subtotalCents: 3048,
  discountCents: 360,
  taxCents: 161,
  shippingCents: 599,
  totalCents: 3448,
}

test('renders the lines, the coupons and the totals', () => {
  const text = renderReceipt(quote)
  expect(text).toContain('Quote for region US (USD)')
  expect(text).toMatch(/^2 x Green Tea 100g \(TEA-001\) +\$17\.98$/m)
  expect(text).toMatch(/^Coupon TEA20 \(-20% tea\) +-\$3\.60$/m)
  expect(text).toMatch(/^Shipping +\$5\.99$/m)
  expect(text).toMatch(/^Total +\$34\.48$/m)
})

test('free shipping reads FREE', () => {
  expect(renderReceipt({ ...quote, shippingCents: 0 })).toMatch(/^Shipping +FREE$/m)
})

test('rows are right-aligned to the receipt width', () => {
  for (const row of renderReceipt(quote).trimEnd().split('\n').slice(1)) {
    expect(row.length).toBe(RECEIPT_WIDTH)
  }
})
