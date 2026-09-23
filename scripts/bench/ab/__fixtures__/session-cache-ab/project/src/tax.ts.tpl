import { percentOf, type Cents } from './money'
import type { Region } from './regions'
import type { TaxClass } from './types'

/**
 * Tax on one line: the rate of its tax class in the region, charged on what is
 * left of the line after coupons and rounded half-up per line.
 */
export function lineTax(amountCents: Cents, taxClass: TaxClass, region: Region): Cents {
  return percentOf(amountCents, region.taxRates[taxClass])
}
