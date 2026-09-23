import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { getProduct, loadCatalog, parseCatalog } from '../src/catalog'
import { UnknownSkuError, ValidationError } from '../src/errors'
import { product } from './helpers'

const SHIPPED = fileURLToPath(new URL('../data/catalog.json', import.meta.url))

describe('parseCatalog', () => {
  test('indexes products by SKU', () => {
    const catalog = parseCatalog([product({ sku: 'ABC-001' }), product({ sku: 'ABC-002', unitCents: 250 })])
    expect(catalog.size).toBe(2)
    expect(catalog.get('ABC-002')?.unitCents).toBe(250)
  })

  test('rejects anything but an array', () => {
    expect(() => parseCatalog({})).toThrow(ValidationError)
  })

  test('rejects duplicate SKUs', () => {
    expect(() => parseCatalog([product({ sku: 'ABC-001' }), product({ sku: 'ABC-001' })])).toThrow(
      'duplicate SKU ABC-001',
    )
  })

  test('rejects a malformed SKU', () => {
    expect(() => parseCatalog([product({ sku: 'abc-1' })])).toThrow('sku must look like ABC-123')
  })

  test('rejects a price that is not a positive integer', () => {
    expect(() => parseCatalog([product({ sku: 'ABC-001', unitCents: 9.99 })])).toThrow('ABC-001: unitCents')
    expect(() => parseCatalog([product({ sku: 'ABC-001', unitCents: 0 })])).toThrow('ABC-001: unitCents')
  })

  test('rejects an unknown tax class', () => {
    expect(() => parseCatalog([{ ...product({ sku: 'ABC-001' }), taxClass: 'luxury' }])).toThrow('taxClass')
  })

  test('rejects a negative weight', () => {
    expect(() => parseCatalog([product({ sku: 'ABC-001', weightGrams: -1 })])).toThrow('weightGrams')
  })
})

describe('the shipped catalog', () => {
  test('loads', () => {
    const catalog = loadCatalog(SHIPPED)
    expect(catalog.size).toBe(12)
    expect(getProduct(catalog, 'TEA-001').name).toBe('Green Tea 100g')
  })

  test('a missing file is a validation error', () => {
    expect(() => loadCatalog('/nonexistent/catalog.json')).toThrow(ValidationError)
  })
})

test('getProduct throws UnknownSkuError for an unknown SKU', () => {
  const catalog = parseCatalog([product({ sku: 'ABC-001' })])
  expect(() => getProduct(catalog, 'ZZZ-999')).toThrow(UnknownSkuError)
})
