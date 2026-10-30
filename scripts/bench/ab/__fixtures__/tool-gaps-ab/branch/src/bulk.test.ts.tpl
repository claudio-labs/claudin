import { describe, expect, test } from 'bun:test'
import { checkBatchSize, describeImport, importBulk, MAX_BULK_ITEMS, readBulkRequest } from './bulk.ts'
import { createHandler } from './server.ts'
import { ApiError, type Item, Store } from './store.ts'

const seed: Item[] = [
  { id: 'itm_1', name: 'Widget', qty: 3, tags: ['hardware'], updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'itm_2', name: 'Gadget', qty: 0, tags: ['electronics'], updatedAt: '2026-01-01T00:00:00.000Z' },
]

function batch(n: number, prefix = 'Part') {
  return Array.from({ length: n }, (_, i) => ({ name: `${prefix} ${i + 1}`, qty: i }))
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    if (err instanceof ApiError) return err.code
    throw err
  }
  return undefined
}

async function postBulk(store: Store, body: unknown) {
  const req = new Request('http://x/items/bulk', { method: 'POST', body: JSON.stringify(body) })
  const res = await createHandler(store)(req)
  return { status: res.status, body: (await res.json()) as any }
}

describe('bulk import', () => {
  test('creates every entry and answers in request order', async () => {
    const store = new Store(seed)
    const res = await postBulk(store, { items: [{ name: 'Washer', qty: 5, tags: ['Fastener'] }, { name: 'Nut', qty: 4 }] })
    expect(res.status).toBe(201)
    expect(res.body.created.map((i: Item) => [i.id, i.name])).toEqual([
      ['itm_3', 'Washer'],
      ['itm_4', 'Nut'],
    ])
    expect(res.body.created[0].tags).toEqual(['fastener'])
    expect(store.list()).toHaveLength(4)
  })

  test('accepts a batch of exactly MAX_BULK_ITEMS', () => {
    const store = new Store()
    expect(importBulk(store, { items: batch(MAX_BULK_ITEMS) }).created).toHaveLength(MAX_BULK_ITEMS)
  })

  test('refuses a batch far over the limit', () => {
    expect(codeOf(() => checkBatchSize(batch(150)))).toBe('batch_too_large')
  })

  test('refuses a name already in the store, ignoring case and spaces', async () => {
    const store = new Store(seed)
    const res = await postBulk(store, { items: [{ name: 'Spring', qty: 1 }, { name: '  WIDGET ', qty: 1 }] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('duplicate_name')
    expect(store.list()).toHaveLength(2)
  })

  test('refuses an invalid entry with invalid_item and its index', async () => {
    const res = await postBulk(new Store(seed), { items: [{ name: 'Spring', qty: -1 }] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_item')
    expect(res.body.error.message).toContain('items[0]')
  })

  test('refuses a body without an items array', () => {
    expect(codeOf(() => readBulkRequest({ entries: [] }))).toBe('invalid_item')
    expect(codeOf(() => readBulkRequest({ items: 'nope' }))).toBe('invalid_item')
  })

  test('an empty batch creates nothing', async () => {
    const res = await postBulk(new Store(seed), { items: [] })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ created: [] })
  })

  test('describeImport summarizes the result', () => {
    const created = importBulk(new Store(), { items: batch(3) }).created
    expect(describeImport({ created })).toBe('bulk import: created 3 items (itm_1..itm_3)')
    expect(describeImport({ created: [] })).toBe('bulk import: nothing to create')
  })
})
