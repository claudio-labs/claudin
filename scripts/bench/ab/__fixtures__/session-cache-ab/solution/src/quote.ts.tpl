import { getProduct, type Catalog } from './catalog'
import { applyCoupons } from './discounts'
import { percentOf, sumCents } from './money'
import { getRegion } from './regions'
import { shippingCost, totalWeight } from './shipping'
import { lineTax } from './tax'
import type { Cart, Coupon, IgnoredCoupon, PriceTier, PricedLine, Product, Quote, QuoteLine, RegionCode } from './types'

export interface QuoteOptions {
  /** Overrides the cart's own region. */
  region?: RegionCode
  /** Pricing date, YYYY-MM-DD. Coupons that expired before it are ignored. Defaults to today. */
  date?: string
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Prices a cart. The steps, and their order, are specified in README.md. */
export function buildQuote(cart: Cart, catalog: Catalog, options: QuoteOptions = {}): Quote {
  const region = getRegion(options.region ?? cart.region)
  const date = options.date ?? today()
  const priced = priceLines(cart, catalog)
  const subtotalCents = sumCents(priced.map(line => line.lineCents))

  const active: Coupon[] = []
  const ignoredCoupons: IgnoredCoupon[] = []
  for (const coupon of cart.coupons) {
    if (coupon.expires !== undefined && coupon.expires < date) ignoredCoupons.push({ code: coupon.code, reason: 'expired' })
    else active.push(coupon)
  }
  const { lineDiscounts, applied } = applyCoupons(priced, active)
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
      ...(line.tierPercentOff === undefined ? {} : { tierPercentOff: line.tierPercentOff }),
    }
  })
  const taxCents = sumCents(lines.map(line => line.taxCents))
  const shippingCents = shippingCost(totalWeight(priced), subtotalCents - discountCents, region)

  return {
    region: region.code,
    currency: region.currency,
    lines,
    coupons: applied,
    ignoredCoupons,
    subtotalCents,
    discountCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents - discountCents + taxCents + shippingCents,
  }
}

/** The highest tier `qty` reaches; tiers are ascending, so that is the last one reached. */
export function tierFor(product: Product, qty: number): PriceTier | undefined {
  let reached: PriceTier | undefined
  for (const tier of product.tiers ?? []) {
    if (qty >= tier.minQty) reached = tier
  }
  return reached
}

function priceLines(cart: Cart, catalog: Catalog): PricedLine[] {
  return cart.lines.map(line => {
    const product = getProduct(catalog, line.sku)
    const tier = tierFor(product, line.qty)
    const unitCents = tier ? product.unitCents - percentOf(product.unitCents, tier.percentOff) : product.unitCents
    return {
      product,
      qty: line.qty,
      unitCents,
      lineCents: unitCents * line.qty,
      ...(tier ? { tierPercentOff: tier.percentOff } : {}),
    }
  })
}
