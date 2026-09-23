import { formatCents, type Cents } from './money'
import type { Quote } from './types'

export const RECEIPT_WIDTH = 52

/** The plain-text receipt. Every row is RECEIPT_WIDTH wide, amounts right-aligned. */
export function renderReceipt(quote: Quote): string {
  const money = (cents: Cents) => formatCents(cents, quote.currency)
  const rows: string[] = []
  rows.push('Quote for region ' + quote.region + ' (' + quote.currency + ')')
  rows.push(rule('-'))
  for (const line of quote.lines) {
    rows.push(row(line.qty + ' x ' + line.name + ' (' + line.sku + ')', money(line.lineCents)))
  }
  rows.push(rule('-'))
  rows.push(row('Subtotal', money(quote.subtotalCents)))
  for (const coupon of quote.coupons) {
    rows.push(row('Coupon ' + coupon.code + ' (' + coupon.label + ')', money(-coupon.discountCents)))
  }
  rows.push(row('Tax', money(quote.taxCents)))
  rows.push(row('Shipping', quote.shippingCents === 0 ? 'FREE' : money(quote.shippingCents)))
  rows.push(rule('='))
  rows.push(row('Total', money(quote.totalCents)))
  return rows.join('\n') + '\n'
}

function row(label: string, value: string): string {
  const gap = Math.max(1, RECEIPT_WIDTH - label.length - value.length)
  return label + ' '.repeat(gap) + value
}

function rule(char: string): string {
  return char.repeat(RECEIPT_WIDTH)
}
