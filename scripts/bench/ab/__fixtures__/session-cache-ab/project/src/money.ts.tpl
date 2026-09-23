import type { Currency } from './types'

/** Every amount in this project is an integer number of cents. */
export type Cents = number

const SYMBOLS: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£' }

/**
 * `pct` percent of `cents`, rounded half-up (away from zero) to a whole cent.
 * Works in basis points so that 8.25% of 1250 is integer math, not 103.12499….
 */
export function percentOf(cents: Cents, pct: number): Cents {
  const basisPoints = Math.round(pct * 100)
  const rounded = Math.floor((Math.abs(cents) * basisPoints + 5000) / 10000)
  return cents < 0 ? -rounded : rounded
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0
  for (const value of values) total += value
  return total
}

/** `formatCents(123456, 'USD')` is `$1,234.56`; a negative amount gets a leading minus. */
export function formatCents(cents: Cents, currency: Currency): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  const fraction = String(abs % 100).padStart(2, '0')
  return sign + SYMBOLS[currency] + whole + '.' + fraction
}
