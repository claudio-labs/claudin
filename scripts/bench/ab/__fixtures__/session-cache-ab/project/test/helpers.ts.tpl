import type { Cart, CartLine, Coupon, Product, RegionCode } from '../src/types'

/** A valid product; override what the test is about. */
export function product(overrides: Partial<Product> & { sku: string }): Product {
  return {
    name: 'Product ' + overrides.sku,
    unitCents: 1000,
    category: 'misc',
    taxClass: 'standard',
    weightGrams: 100,
    ...overrides,
  }
}

export function cartOf(region: RegionCode, lines: CartLine[], coupons: Coupon[] = []): Cart {
  return { region, lines, coupons }
}
