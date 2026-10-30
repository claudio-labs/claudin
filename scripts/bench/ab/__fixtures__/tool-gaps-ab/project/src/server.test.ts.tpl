import { describe, expect, test } from 'bun:test'
import { createHandler } from './server.ts'
import { type Item, Store } from './store.ts'

const seed: Item[] = [
  { id: 'itm_1', name: 'Widget', qty: 3, tags: ['hardware'], updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'itm_2', name: 'Gadget', qty: 0, tags: ['electronics'], updatedAt: '2026-01-01T00:00:00.000Z' },
]

function handler() {
  return createHandler(new Store(seed))
}

function post(path: string, body: string): Request {
  return new Request(`http://x${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
}

describe('server', () => {
  test('GET /health', async () => {
    const res = await handler()(new Request('http://x/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  test('GET /items lists every item', async () => {
    const res = await handler()(new Request('http://x/items'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Item[] }
    expect(body.items.map((i) => i.id)).toEqual(['itm_1', 'itm_2'])
  })

  test('GET /items/:id returns the item or not_found', async () => {
    const h = handler()
    expect(await (await h(new Request('http://x/items/itm_2'))).json()).toMatchObject({ name: 'Gadget' })
    const missing = await h(new Request('http://x/items/itm_9'))
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as any).error.code).toBe('not_found')
  })

  test('POST /items creates an item', async () => {
    const res = await handler()(post('/items', JSON.stringify({ name: 'Bolt', qty: 5, tags: ['Fastener'] })))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: 'itm_3', name: 'Bolt', qty: 5, tags: ['fastener'] })
  })

  test('a malformed body is invalid_json', async () => {
    const res = await handler()(post('/items', '{nope'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('invalid_json')
  })

  test('an unknown route is not_found', async () => {
    const res = await handler()(new Request('http://x/nowhere'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('not_found')
  })
})
