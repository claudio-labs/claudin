import type { Cents } from './money'

export type Currency = 'USD' | 'EUR' | 'GBP'
export type RegionCode = 'US' | 'EU' | 'UK'
export type TaxClass = 'standard' | 'reduced' | 'exempt'

export interface PriceTier {
  minQty: number
  percentOff: number
}

export interface Product {
  sku: string
  name: string
  unitCents: Cents
  category: string
  taxClass: TaxClass
  weightGrams: number
  /** Ascending by minQty. */
  tiers?: PriceTier[]
}

export interface CartLine {
  sku: string
  qty: number
}

export type Coupon =
  | { code: string; kind: 'percent'; value: number; expires?: string }
  | { code: string; kind: 'category'; category: string; value: number; expires?: string }

export interface Cart {
  region: RegionCode
  lines: CartLine[]
  coupons: Coupon[]
}

/** A cart line after the catalog lookup and any bulk tier, before coupons. */
export interface PricedLine {
  product: Product
  qty: number
  unitCents: Cents
  /** unitCents × qty */
  lineCents: Cents
  tierPercentOff?: number
}

export interface QuoteLine {
  sku: string
  name: string
  qty: number
  unitCents: Cents
  lineCents: Cents
  /** What the coupons took off this line. */
  discountCents: Cents
  taxCents: Cents
  tierPercentOff?: number
}

export interface AppliedCoupon {
  code: string
  label: string
  discountCents: Cents
}

export interface IgnoredCoupon {
  code: string
  reason: 'expired'
}

export interface Quote {
  region: RegionCode
  currency: Currency
  lines: QuoteLine[]
  coupons: AppliedCoupon[]
  ignoredCoupons?: IgnoredCoupon[]
  subtotalCents: Cents
  discountCents: Cents
  taxCents: Cents
  shippingCents: Cents
  totalCents: Cents
}
