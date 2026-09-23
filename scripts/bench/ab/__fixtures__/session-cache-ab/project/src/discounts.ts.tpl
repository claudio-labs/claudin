import { CouponError } from './errors'
import { percentOf, type Cents } from './money'
import type { AppliedCoupon, Coupon, PricedLine } from './types'

export interface CouponResult {
  /** What the coupons took off each line, in the order of the lines. */
  lineDiscounts: Cents[]
  applied: AppliedCoupon[]
}

/**
 * Applies the coupons in the order they appear in the cart. Each coupon takes
 * its percentage off what is left of every line it covers after the coupons
 * before it — two 10% coupons take 19%, not 20% — rounding per line.
 */
export function applyCoupons(lines: readonly PricedLine[], coupons: readonly Coupon[]): CouponResult {
  const remaining = lines.map(line => line.lineCents)
  const lineDiscounts = lines.map(() => 0)
  const applied: AppliedCoupon[] = []
  for (const coupon of coupons) {
    const covered = lines.map(line => covers(coupon, line))
    if (!covered.includes(true)) {
      throw new CouponError('coupon ' + coupon.code + ' does not apply to any item in the cart')
    }
    let discountCents = 0
    covered.forEach((isCovered, i) => {
      if (!isCovered) return
      const off = percentOf(remaining[i], coupon.value)
      remaining[i] -= off
      lineDiscounts[i] += off
      discountCents += off
    })
    applied.push({ code: coupon.code, label: describeCoupon(coupon), discountCents })
  }
  return { lineDiscounts, applied }
}

function covers(coupon: Coupon, line: PricedLine): boolean {
  return coupon.kind === 'percent' || line.product.category === coupon.category
}

/** `-10%`, or `-15% coffee` for a category coupon. */
export function describeCoupon(coupon: Coupon): string {
  const pct = '-' + coupon.value + '%'
  return coupon.kind === 'category' ? pct + ' ' + coupon.category : pct
}
