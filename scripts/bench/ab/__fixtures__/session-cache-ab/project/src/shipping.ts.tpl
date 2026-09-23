import type { Cents } from './money'
import type { Region } from './regions'
import type { PricedLine } from './types'

/**
 * Shipping for one parcel. The base fee covers the first kilogram and every
 * further kilogram started adds `perKgCents`; a parcel with nothing in it (only
 * weightless items, like gift cards) ships for nothing. Free once
 * `merchandiseCents` reaches the region's threshold.
 */
export function shippingCost(weightGrams: number, merchandiseCents: Cents, region: Region): Cents {
  if (weightGrams <= 0) return 0
  const rule = region.shipping
  if (merchandiseCents >= rule.freeThresholdCents) return 0
  const extraKg = Math.max(0, Math.ceil(weightGrams / 1000) - 1)
  return rule.baseCents + extraKg * rule.perKgCents
}

export function totalWeight(lines: readonly Pick<PricedLine, 'product' | 'qty'>[]): number {
  let grams = 0
  for (const line of lines) grams += line.product.weightGrams * line.qty
  return grams
}
