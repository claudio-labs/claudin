/**
 * Errors the engine reports to the user. The CLI prints their message and
 * exits with code 2; anything else is a bug and exits with code 1.
 */
export class PricingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Malformed input: a catalog entry, a cart line, a coupon, a CLI option. */
export class ValidationError extends PricingError {}

export class UnknownSkuError extends PricingError {
  readonly sku: string

  constructor(sku: string) {
    super('unknown SKU ' + sku)
    this.sku = sku
  }
}

/** A well-formed coupon that cannot be applied to this cart. */
export class CouponError extends PricingError {}
