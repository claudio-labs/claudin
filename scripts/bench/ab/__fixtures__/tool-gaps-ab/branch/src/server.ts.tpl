import { readFileSync } from 'node:fs'
import { describeImport, importBulk } from './bulk.ts'
import { ApiError, type Item, Store } from './store.ts'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(err: ApiError): Response {
  return json(err.status, { error: { code: err.code, message: err.message } })
}

/** Parses the body as a JSON object; anything else is `invalid_json`. */
async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'invalid_json', 'request body is not valid JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_json', 'request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

async function route(store: Store, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(200, { status: 'ok' })
  }

  if (req.method === 'POST' && url.pathname === '/items/bulk') {
    const result = importBulk(store, await readJsonObject(req))
    console.log(describeImport(result))
    return json(201, result)
  }

  if (parts[0] === 'items' && parts.length === 1) {
    if (req.method === 'GET') return json(200, { items: store.list() })
    if (req.method === 'POST') return json(201, store.create(await readJsonObject(req)))
  }

  if (parts[0] === 'items' && parts.length === 2 && req.method === 'GET') {
    const item = store.get(parts[1]!)
    if (!item) throw new ApiError(404, 'not_found', `no item with id ${parts[1]}`)
    return json(200, item)
  }

  throw new ApiError(404, 'not_found', `no route for ${req.method} ${url.pathname}`)
}

export function createHandler(store: Store): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await route(store, req)
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err)
      console.error(err)
      return json(500, { error: { code: 'internal', message: 'internal error' } })
    }
  }
}

if (import.meta.main) {
  const root = new URL('..', import.meta.url)
  const port = Number(readFileSync(new URL('config/port', root), 'utf8').trim())
  const seed = JSON.parse(readFileSync(new URL('data/items.json', root), 'utf8')) as Item[]
  const store = new Store(seed)
  Bun.serve({ port, fetch: createHandler(store) })
  console.log(`listening on ${port}`)
}
