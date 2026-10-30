import { describe, expect, test } from 'bun:test'
import { createHandler } from './server.ts'
import { type Item, Store } from './store.ts'

const OLD = '2020-01-01T00:00:00.000Z'
const seed: Item[] = [
  { id: 'itm_1', name: 'Widget', qty: 3, tags: ['hardware', 'small'], updatedAt: OLD },
  { id: 'itm_2', name: 'Lamp', qty: 1, tags: ['electronics', 'office'], updatedAt: OLD },
  { id: 'itm_10', name: 'Stapler', qty: 2, tags: ['office'], updatedAt: OLD },
]

async function call(h: (r: Request) => Promise<Response>, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await h(new Request(`http://x${path}`, init))
  return { status: res.status, body: (await res.json()) as any }
}

describe('PATCH /items/:id', () => {
  test('updates the given fields and refreshes updatedAt', async () => {
    const res = await call(createHandler(new Store(seed)), 'PATCH', '/items/itm_1', { qty: 7, tags: ['B', 'a', 'b'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'itm_1', name: 'Widget', qty: 7, tags: ['a', 'b'] })
    expect(res.body.updatedAt).not.toBe(OLD)
  })

  test('rejects unknown fields, empty bodies and bad values without changing anything', async () => {
    const h = createHandler(new Store(seed))
    expect((await call(h, 'PATCH', '/items/itm_1', { quantity: 1 })).body.error.code).toBe('unknown_field')
    expect((await call(h, 'PATCH', '/items/itm_1', {})).body.error.code).toBe('empty_patch')
    expect((await call(h, 'PATCH', '/items/itm_1', { name: ' ' })).body.error.code).toBe('invalid_name')
    expect((await call(h, 'PATCH', '/items/itm_1', { name: 'X', qty: -1 })).body.error.code).toBe('invalid_qty')
    expect((await call(h, 'GET', '/items/itm_1')).body).toEqual(seed[0]!)
  })

  test('a missing id is not_found', async () => {
    const res = await call(createHandler(new Store(seed)), 'PATCH', '/items/itm_9', { qty: 1 })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('GET /items?tag=', () => {
  test('filters case-insensitively and requires every tag', async () => {
    const h = createHandler(new Store(seed))
    const ids = async (q: string) => ((await call(h, 'GET', `/items?tag=${q}`)).body.items as Item[]).map((i) => i.id)
    expect(await ids('Office')).toEqual(['itm_2', 'itm_10'])
    expect(await ids('office,electronics')).toEqual(['itm_2'])
    expect(await ids('garden')).toEqual([])
  })
})
