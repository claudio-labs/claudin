// Phase 2 acceptance: POST /items/bulk on feature/bulk, per docs/SPEC.md §8.
// Run from the grader dir with TGA_WORKSPACE=<workspace>.
import { describe, expect, test } from 'bun:test'

const ws = process.env.TGA_WORKSPACE
if (!ws) throw new Error('TGA_WORKSPACE is not set')
const { createHandler } = await import(`${ws}/src/server.ts`)
const { Store } = await import(`${ws}/src/store.ts`)

type Item = { id: string; name: string; qty: number; tags: string[]; updatedAt: string }

const OLD = '2020-01-01T00:00:00.000Z'
const seed: Item[] = [
  { id: 'itm_1', name: 'Widget', qty: 25, tags: ['hardware'], updatedAt: OLD },
  { id: 'itm_2', name: 'Gadget', qty: 4, tags: ['electronics'], updatedAt: OLD },
  { id: 'itm_3', name: 'Bolt M6', qty: 400, tags: ['fastener', 'hardware'], updatedAt: OLD },
]

function setup() {
  const store = new Store(structuredClone(seed))
  const handler = createHandler(store) as (req: Request) => Promise<Response>
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method }
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
    const res = await handler(new Request(`http://x${path}`, init))
    return { status: res.status, body: (await res.json()) as any }
  }
  const count = async () => ((await call('GET', '/items')).body.items as Item[]).length
  return { call, count }
}

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Part ${i + 1}`, qty: i }))

describe('POST /items/bulk', () => {
  test('creates every entry with 201, in request order, normalized', async () => {
    const { call, count } = setup()
    const res = await call('POST', '/items/bulk', {
      items: [
        { name: '  Washer M6 ', qty: 500, tags: ['Fastener', 'fastener'] },
        { name: 'Nut M6', qty: 450 },
      ],
    })
    expect(res.status).toBe(201)
    expect(res.body.created.map((i: Item) => [i.id, i.name, i.tags])).toEqual([
      ['itm_4', 'Washer M6', ['fastener']],
      ['itm_5', 'Nut M6', []],
    ])
    expect(await count()).toBe(5)
  })

  test('accepts a batch of exactly 100', async () => {
    const { call, count } = setup()
    const res = await call('POST', '/items/bulk', { items: entries(100) })
    expect(res.status).toBe(201)
    expect(res.body.created).toHaveLength(100)
    expect(await count()).toBe(103)
  })

  test('refuses a batch of 101 with batch_too_large', async () => {
    const { call, count } = setup()
    const res = await call('POST', '/items/bulk', { items: entries(101) })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('batch_too_large')
    expect(await count()).toBe(3)
  })

  test('refuses a batch of 250 with batch_too_large', async () => {
    const { call } = setup()
    const res = await call('POST', '/items/bulk', { items: entries(250) })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('batch_too_large')
  })

  test('refuses a name already in the store, trimmed and case-insensitive', async () => {
    const { call, count } = setup()
    const res = await call('POST', '/items/bulk', { items: [{ name: 'Spring', qty: 1 }, { name: ' bolt m6  ', qty: 2 }] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('duplicate_name')
    expect(await count()).toBe(3)
  })

  test('refuses a name repeated inside the batch', async () => {
    const { call, count } = setup()
    const res = await call('POST', '/items/bulk', {
      items: [{ name: 'Spring', qty: 1 }, { name: 'Clip', qty: 2 }, { name: '  SPRING ', qty: 3 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('duplicate_name')
    expect(await count()).toBe(3)
  })

  test('an invalid entry is invalid_item', async () => {
    const { call } = setup()
    const res = await call('POST', '/items/bulk', { items: [{ name: 'Spring', qty: 1.5 }] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_item')
  })

  test('is atomic: an invalid last entry leaves the store untouched', async () => {
    const { call, count } = setup()
    const res = await call('POST', '/items/bulk', {
      items: [{ name: 'Spring', qty: 1 }, { name: 'Clip', qty: 2 }, { name: 'Pin', qty: -1 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_item')
    expect(await count()).toBe(3)
  })

  test('a malformed body is invalid_json, and single creation still works', async () => {
    const { call } = setup()
    const bad = await call('POST', '/items/bulk', '{"items": [')
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('invalid_json')
    const one = await call('POST', '/items', { name: 'Spring', qty: 1 })
    expect(one.status).toBe(201)
    expect(one.body.id).toBe('itm_4')
  })
})
