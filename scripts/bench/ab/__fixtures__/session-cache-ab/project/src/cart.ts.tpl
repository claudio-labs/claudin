import { readFileSync } from 'node:fs'
import { SKU_RE } from './catalog'
import { CouponError, ValidationError } from './errors'
import { getRegion } from './regions'
import type { Cart, CartLine, Coupon } from './types'

export const MAX_QTY = 999
const COUPON_CODE_RE = /^[A-Z0-9]{3,16}$/

export function parseCart(raw: unknown): Cart {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('cart must be a JSON object')
  }
  const r = raw as Record<string, unknown>
  const region = getRegion(r.region === undefined ? 'US' : String(r.region)).code
  if (!Array.isArray(r.lines) || r.lines.length === 0) {
    throw new ValidationError('cart must have at least one line')
  }
  const lines = mergeLines(r.lines.map(parseLine))
  if (r.coupons !== undefined && !Array.isArray(r.coupons)) {
    throw new ValidationError('coupons must be an array')
  }
  const coupons = ((r.coupons as unknown[] | undefined) ?? []).map(parseCoupon)
  const seen = new Set<string>()
  for (const coupon of coupons) {
    if (seen.has(coupon.code)) throw new CouponError('coupon ' + coupon.code + ' is used more than once')
    seen.add(coupon.code)
  }
  return { region, lines, coupons }
}

function parseLine(raw: unknown, index: number): CartLine {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError('line ' + (index + 1) + ' is not an object')
  }
  const l = raw as Record<string, unknown>
  if (typeof l.sku !== 'string' || !SKU_RE.test(l.sku)) {
    throw new ValidationError('line ' + (index + 1) + ': sku must look like ABC-123')
  }
  if (typeof l.qty !== 'number' || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) {
    throw new ValidationError('line ' + (index + 1) + ' (' + l.sku + '): qty must be an integer from 1 to ' + MAX_QTY)
  }
  return { sku: l.sku, qty: l.qty }
}

/** Lines for the same SKU are merged into the first of them; the order is otherwise kept. */
export function mergeLines(lines: readonly CartLine[]): CartLine[] {
  const merged: CartLine[] = []
  const bySku = new Map<string, CartLine>()
  for (const line of lines) {
    const existing = bySku.get(line.sku)
    if (existing) {
      existing.qty += line.qty
      if (existing.qty > MAX_QTY) throw new ValidationError(line.sku + ': total qty exceeds ' + MAX_QTY)
      continue
    }
    const copy = { ...line }
    bySku.set(copy.sku, copy)
    merged.push(copy)
  }
  return merged
}

function parseCoupon(raw: unknown, index: number): Coupon {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError('coupon ' + (index + 1) + ' is not an object')
  }
  const c = raw as Record<string, unknown>
  if (typeof c.code !== 'string' || !COUPON_CODE_RE.test(c.code)) {
    throw new ValidationError('coupon ' + (index + 1) + ': code must be 3-16 uppercase letters or digits')
  }
  if (typeof c.value !== 'number' || !(c.value > 0) || c.value > 100) {
    throw new ValidationError('coupon ' + c.code + ': value must be a percentage above 0 and at most 100')
  }
  if (c.kind === 'percent') return { code: c.code, kind: 'percent', value: c.value }
  if (c.kind === 'category') {
    if (typeof c.category !== 'string' || c.category === '') {
      throw new ValidationError('coupon ' + c.code + ': a category coupon needs a category')
    }
    return { code: c.code, kind: 'category', category: c.category, value: c.value }
  }
  throw new ValidationError('coupon ' + c.code + ': kind must be "percent" or "category"')
}

export function loadCart(path: string): Cart {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new ValidationError('cannot read cart ' + path + ': ' + (e as Error).message)
  }
  return parseCart(raw)
}
