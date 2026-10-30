// Phase 1 acceptance: PATCH /items/:id and GET /items?tag=, per docs/SPEC.md.
// Run from the grader dir with TGA_WORKSPACE=<workspace>.
import { describe, expect, test } from 'bun:test'

const ws = process.env.TGA_WORKSPACE
if (!ws) throw new Error('TGA_WORKSPACE is not set')
const { createHandler } = await import(`${ws}/src/server.ts`)
const { Store } = await import(`${ws}/src/store.ts`)

type Item = { id: string; name: string; qty: number; tags: string[]; updatedAt: string }

const OLD = '2020-01-01T00:00:00.000Z'
const seed: Item[] = [
  { id: 'itm_1', name: 'Widget', qty: 25, tags: ['hardware', 'small'], updatedAt: OLD },
  { id: 'itm_2', name: 'Gadget', qty: 4, tags: ['electronics'], updatedAt: OLD },
  { id: 'itm_3', name: 'Desk Lamp', qty: 7, tags: ['electronics', 'office'], updatedAt: OLD },
  { id: 'itm_4', name: 'Notebook', qty: 120, tags: ['office', 'paper'], updatedAt: OLD },
  { id: 'itm_10', name: 'Stapler', qty: 3, tags: ['office'], updatedAt: OLD },
]

function setup() {
  const handler = createHandler(new Store(structuredClone(seed))) as (req: Request) => Promise<Response>
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      init.headers = { 'content-type': 'application/json' }
    }
    const res = await handler(new Request(`http://x${path}`, init))
    return { status: res.status, body: (await res.json()) as any }
  }
  const getItem = async (id: string) => (await call('GET', `/items/${id}`)).body as Item
  return { call, getItem }
}

describe('PATCH /items/:id', () => {
  test('updates qty and returns the full item with 200', async () => {
    const { call } = setup()
    const res = await call('PATCH', '/items/itm_2', { qty: 9 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'itm_2', name: 'Gadget', qty: 9, tags: ['electronics'] })
    expect(Object.keys(res.body).sort()).toEqual(['id', 'name', 'qty', 'tags', 'updatedAt'])
  })

  test('trims the name and persists the change', async () => {
    const { call, getItem } = setup()
    const res = await call('PATCH', '/items/itm_1', { name: '  Widget XL  ' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Widget XL')
    expect((await getItem('itm_1')).name).toBe('Widget XL')
  })

  test('lowercases, dedupes and sorts tags, replacing the old list', async () => {
    const { call } = setup()
    const res = await call('PATCH', '/items/itm_1', { tags: ['Zeta', 'alpha', 'ZETA', 'Beta'] })
    expect(res.status).toBe(200)
    expect(res.body.tags).toEqual(['alpha', 'beta', 'zeta'])
  })

  test('refreshes updatedAt with a new ISO timestamp', async () => {
    const { call } = setup()
    const res = await call('PATCH', '/items/itm_2', { qty: 5 })
    expect(res.status).toBe(200)
    expect(res.body.updatedAt).not.toBe(OLD)
    expect(new Date(res.body.updatedAt).toISOString()).toBe(res.body.updatedAt)
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(OLD))
  })

  test('an unknown field is 400 unknown_field', async () => {
    const { call } = setup()
    const res = await call('PATCH', '/items/itm_2', { quantity: 9 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('unknown_field')
  })

  test('an empty body is 400 empty_patch', async () => {
    const { call } = setup()
    const res = await call('PATCH', '/items/itm_2', {})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('empty_patch')
  })

  test('a qty that is not an integer >= 0 is 400 invalid_qty', async () => {
    const { call } = setup()
    for (const qty of [-1, 1.5, '3']) {
      const res = await call('PATCH', '/items/itm_2', { qty })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('invalid_qty')
    }
  })

  test('a blank name is 400 invalid_name', async () => {
    const { call } = setup()
    const res = await call('PATCH', '/items/itm_2', { name: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_name')
  })

  test('a missing id is 404 not_found', async () => {
    const { call } = setup()
    const res = await call('PATCH', '/items/itm_999', { qty: 1 })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  test('a refused update changes nothing, even when only one field is bad', async () => {
    const { call, getItem } = setup()
    const res = await call('PATCH', '/items/itm_2', { name: 'Gadget Pro', tags: ['new'], qty: -3 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_qty')
    expect(await getItem('itm_2')).toEqual(seed[1]!)
  })
})

describe('GET /items?tag=', () => {
  const ids = (body: any) => (body.items as Item[]).map((i) => i.id)

  test('filters by one tag, case-insensitively, in numeric id order', async () => {
    const { call } = setup()
    const res = await call('GET', '/items?tag=OFFICE')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual(['itm_3', 'itm_4', 'itm_10'])
  })

  test('several comma-separated tags must all be present', async () => {
    const { call } = setup()
    const res = await call('GET', '/items?tag=office,Electronics')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual(['itm_3'])
  })

  test('a tag nobody has is 200 with an empty list', async () => {
    const { call } = setup()
    const res = await call('GET', '/items?tag=garden')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [] })
  })

  test('without tag every item is listed in numeric id order', async () => {
    const { call } = setup()
    const res = await call('GET', '/items')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual(['itm_1', 'itm_2', 'itm_3', 'itm_4', 'itm_10'])
  })
})
