import { ValidationError } from './errors'
import type { Cents } from './money'
import type { Currency, RegionCode, TaxClass } from './types'

export interface ShippingRule {
  /** Charged for the first kilogram, or part of it. */
  baseCents: Cents
  /** Charged for every further kilogram started. */
  perKgCents: Cents
  /** Merchandise amount at or above which shipping is free. */
  freeThresholdCents: Cents
}

export interface Region {
  code: RegionCode
  currency: Currency
  /** Percent, by tax class. */
  taxRates: Record<TaxClass, number>
  shipping: ShippingRule
}

export const REGIONS: Record<RegionCode, Region> = {
  US: {
    code: 'US',
    currency: 'USD',
    taxRates: { standard: 8.25, reduced: 4, exempt: 0 },
    shipping: { baseCents: 599, perKgCents: 150, freeThresholdCents: 7500 },
  },
  EU: {
    code: 'EU',
    currency: 'EUR',
    taxRates: { standard: 21, reduced: 9, exempt: 0 },
    shipping: { baseCents: 899, perKgCents: 200, freeThresholdCents: 10000 },
  },
  UK: {
    code: 'UK',
    currency: 'GBP',
    taxRates: { standard: 20, reduced: 5, exempt: 0 },
    shipping: { baseCents: 499, perKgCents: 175, freeThresholdCents: 6000 },
  },
}

export function isRegionCode(code: string): code is RegionCode {
  return Object.hasOwn(REGIONS, code)
}

export function getRegion(code: string): Region {
  if (!isRegionCode(code)) {
    throw new ValidationError(
      'unknown region ' + JSON.stringify(code) + ' (expected one of ' + Object.keys(REGIONS).join(', ') + ')',
    )
  }
  return REGIONS[code]
}
