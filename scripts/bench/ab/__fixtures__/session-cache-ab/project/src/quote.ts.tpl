import { getProduct, type Catalog } from './catalog'
import { applyCoupons } from './discounts'
import { sumCents } from './money'
import { getRegion } from './regions'
import { shippingCost, totalWeight } from './shipping'
import { lineTax } from './tax'
import type { Cart, PricedLine, Quote, QuoteLine, RegionCode } from './types'

export interface QuoteOptions {
  /** Overrides the cart's own region. */
  region?: RegionCode
}

/** Prices a cart. The steps, and their order, are specified in README.md. */
export function buildQuote(cart: Cart, catalog: Catalog, options: QuoteOptions = {}): Quote {
  const region = getRegion(options.region ?? cart.region)
  const priced = priceLines(cart, catalog)
  const subtotalCents = sumCents(priced.map(line => line.lineCents))

  const { lineDiscounts, applied } = applyCoupons(priced, cart.coupons)
  const discountCents = sumCents(lineDiscounts)

  const lines: QuoteLine[] = priced.map((line, i) => {
    const lineDiscount = lineDiscounts[i]
    return {
      sku: line.product.sku,
      name: line.product.name,
      qty: line.qty,
      unitCents: line.unitCents,
      lineCents: line.lineCents,
      discountCents: lineDiscount,
      taxCents: lineTax(line.lineCents - lineDiscount, line.product.taxClass, region),
    }
  })
  const taxCents = sumCents(lines.map(line => line.taxCents))
  const shippingCents = shippingCost(totalWeight(priced), subtotalCents, region)

  return {
    region: region.code,
    currency: region.currency,
    lines,
    coupons: applied,
    subtotalCents,
    discountCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents - discountCents + taxCents + shippingCents,
  }
}

function priceLines(cart: Cart, catalog: Catalog): PricedLine[] {
  return cart.lines.map(line => {
    const product = getProduct(catalog, line.sku)
    return { product, qty: line.qty, unitCents: product.unitCents, lineCents: product.unitCents * line.qty }
  })
}
