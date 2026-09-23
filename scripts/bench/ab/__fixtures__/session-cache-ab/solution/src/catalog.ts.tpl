import { readFileSync } from 'node:fs'
import { UnknownSkuError, ValidationError } from './errors'
import type { PriceTier, Product, TaxClass } from './types'

export type Catalog = Map<string, Product>

export const SKU_RE = /^[A-Z]{3}-\d{3}$/
const TAX_CLASSES: readonly TaxClass[] = ['standard', 'reduced', 'exempt']

export function parseCatalog(raw: unknown): Catalog {
  if (!Array.isArray(raw)) throw new ValidationError('catalog must be a JSON array of products')
  const catalog: Catalog = new Map()
  raw.forEach((entry, index) => {
    const product = parseProduct(entry, index)
    if (catalog.has(product.sku)) throw new ValidationError('duplicate SKU ' + product.sku + ' in catalog')
    catalog.set(product.sku, product)
  })
  return catalog
}

function parseProduct(entry: unknown, index: number): Product {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ValidationError('catalog entry ' + index + ' is not an object')
  }
  const e = entry as Record<string, unknown>
  const where = typeof e.sku === 'string' ? e.sku : 'catalog entry ' + index
  if (typeof e.sku !== 'string' || !SKU_RE.test(e.sku)) {
    throw new ValidationError(where + ': sku must look like ABC-123')
  }
  if (typeof e.name !== 'string' || e.name.trim() === '') {
    throw new ValidationError(where + ': name is required')
  }
  if (!isPositiveInteger(e.unitCents)) {
    throw new ValidationError(where + ': unitCents must be a positive integer')
  }
  if (typeof e.category !== 'string' || e.category.trim() === '') {
    throw new ValidationError(where + ': category is required')
  }
  if (!TAX_CLASSES.includes(e.taxClass as TaxClass)) {
    throw new ValidationError(where + ': taxClass must be one of ' + TAX_CLASSES.join(', '))
  }
  if (typeof e.weightGrams !== 'number' || !Number.isInteger(e.weightGrams) || e.weightGrams < 0) {
    throw new ValidationError(where + ': weightGrams must be a non-negative integer')
  }
  const tiers = parseTiers(e.tiers, e.sku)
  return {
    sku: e.sku,
    name: e.name,
    unitCents: e.unitCents,
    category: e.category,
    taxClass: e.taxClass as TaxClass,
    weightGrams: e.weightGrams,
    ...(tiers === undefined ? {} : { tiers }),
  }
}

function parseTiers(value: unknown, sku: string): PriceTier[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ValidationError(sku + ': tiers must be an array')
  const tiers: PriceTier[] = []
  for (const raw of value) {
    const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const { minQty, percentOff } = t
    if (typeof minQty !== 'number' || !Number.isInteger(minQty) || minQty < 2) {
      throw new ValidationError(sku + ': a tier minQty must be an integer of at least 2')
    }
    if (typeof percentOff !== 'number' || !(percentOff > 0 && percentOff < 100)) {
      throw new ValidationError(sku + ': a tier percentOff must be above 0 and below 100')
    }
    const previous = tiers.at(-1)
    if (previous !== undefined && minQty <= previous.minQty) {
      throw new ValidationError(sku + ': tier minQty values must increase')
    }
    tiers.push({ minQty, percentOff })
  }
  return tiers
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function loadCatalog(path: string): Catalog {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new ValidationError('cannot read catalog ' + path + ': ' + (e as Error).message)
  }
  return parseCatalog(raw)
}

export function getProduct(catalog: Catalog, sku: string): Product {
  const product = catalog.get(sku)
  if (!product) throw new UnknownSkuError(sku)
  return product
}
