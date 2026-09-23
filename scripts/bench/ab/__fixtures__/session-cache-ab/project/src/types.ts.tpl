import type { Cents } from './money'

export type Currency = 'USD' | 'EUR' | 'GBP'
export type RegionCode = 'US' | 'EU' | 'UK'
export type TaxClass = 'standard' | 'reduced' | 'exempt'

export interface Product {
  sku: string
  name: string
  unitCents: Cents
  category: string
  taxClass: TaxClass
  weightGrams: number
}

export interface CartLine {
  sku: string
  qty: number
}

export type Coupon =
  | { code: string; kind: 'percent'; value: number }
  | { code: string; kind: 'category'; category: string; value: number }

export interface Cart {
  region: RegionCode
  lines: CartLine[]
  coupons: Coupon[]
}

/** A cart line after the catalog lookup, before coupons. */
export interface PricedLine {
  product: Product
  qty: number
  unitCents: Cents
  /** unitCents × qty */
  lineCents: Cents
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
}

export interface AppliedCoupon {
  code: string
  label: string
  discountCents: Cents
}

export interface Quote {
  region: RegionCode
  currency: Currency
  lines: QuoteLine[]
  coupons: AppliedCoupon[]
  subtotalCents: Cents
  discountCents: Cents
  taxCents: Cents
  shippingCents: Cents
  totalCents: Cents
}
