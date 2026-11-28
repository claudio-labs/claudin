import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { createAuthFetch, fetchAuthServerMetadata } from 'src/mcp/auth/authFetch.js'

// createAuthFetch against a local server on 127.0.0.1, and
// fetchAuthServerMetadata's discovery order through an injected fetchFn.

let hits: string[] = []
let release: () => void = () => {}

const srv: Server<undefined> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    hits.push(`${req.method} ${url.pathname}`)
    if (url.pathname === '/slack-error') {
      return Response.json({ error: 'invalid_refresh_token' })
    }
    if (url.pathname === '/hang') {
      await new Promise<void>(r => {
        release = r
      })
      return new Response('late')
    }
    return new Response('plain')
  },
})

const at = (path: string): string => `http://127.0.0.1:${srv.port}${path}`

afterAll(() => {
  release()
  srv.stop(true)
})

beforeEach(() => {
  hits = []
})

describe('createAuthFetch', () => {
  test('a GET passes a 200 error-shaped body through untouched', async () => {
    const res = await createAuthFetch()(at('/slack-error'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ error: 'invalid_refresh_token' })
  })

  test('a POST rewrites a 200 error body to a 400 invalid_grant', async () => {
    const res = await createAuthFetch()(at('/slack-error'), { method: 'post' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  test('with a caller signal, a POST is normalized and a GET is not', async () => {
    const f = createAuthFetch()
    const post = await f(at('/slack-error'), { method: 'POST', signal: new AbortController().signal })
    expect(post.status).toBe(400)
    const get = await f(at('/slack-error'), { signal: new AbortController().signal })
    expect(get.status).toBe(200)
    expect(await get.text()).toContain('invalid_refresh_token')
  })

  test('an already-aborted caller signal rejects without reaching the server', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(createAuthFetch()(at('/plain'), { signal: ctrl.signal })).rejects.toThrow()
    expect(hits).toEqual([])
  })

  test('aborting the caller signal mid-request rejects the fetch', async () => {
    const ctrl = new AbortController()
    const pending = createAuthFetch()(at('/hang'), { signal: ctrl.signal })
    pending.catch(() => {})
    for (let i = 0; i < 50 && !hits.includes('GET /hang'); i++) await Bun.sleep(5)
    ctrl.abort()
    await expect(pending).rejects.toThrow()
    release()
  })
})

const META = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  response_types_supported: ['code'],
}

/** A fetchFn answering from a URL → response table; everything else is 404. */
function table(routes: Record<string, () => Response>): {
  fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>
  seen: string[]
  inits: (RequestInit | undefined)[]
} {
  const seen: string[] = []
  const inits: (RequestInit | undefined)[] = []
  return {
    seen,
    inits,
    fetchFn: async (url, init) => {
      seen.push(String(url))
      inits.push(init)
      const route = routes[String(url)]
      return route ? route() : new Response('nope', { status: 404 })
    },
  }
}

describe('fetchAuthServerMetadata with a configured metadata URL', () => {
  test('a non-https URL is refused before any request', async () => {
    const t = table({})
    await expect(
      fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', 'http://auth.example.com/meta', t.fetchFn),
    ).rejects.toThrow('authServerMetadataUrl must use https:// (got: http://auth.example.com/meta)')
    expect(t.seen).toEqual([])
  })

  test('an https URL is fetched as JSON and parsed', async () => {
    const t = table({ 'https://auth.example.com/meta': () => Response.json(META) })
    const got = await fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', 'https://auth.example.com/meta', t.fetchFn)
    expect(got?.token_endpoint).toBe(META.token_endpoint)
    expect(t.seen).toEqual(['https://auth.example.com/meta'])
    expect(t.inits[0]?.headers).toEqual({ Accept: 'application/json' })
  })

  test('a non-ok answer throws with the status and URL, without falling back to discovery', async () => {
    const t = table({ 'https://auth.example.com/meta': () => new Response('x', { status: 503 }) })
    await expect(
      fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', 'https://auth.example.com/meta', t.fetchFn),
    ).rejects.toThrow('HTTP 503 fetching configured auth server metadata from https://auth.example.com/meta')
    expect(t.seen).toEqual(['https://auth.example.com/meta'])
  })

  test('a body that is not authorization-server metadata is rejected', async () => {
    const t = table({ 'https://auth.example.com/meta': () => Response.json({ issuer: 'x' }) })
    await expect(
      fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', 'https://auth.example.com/meta', t.fetchFn),
    ).rejects.toThrow()
  })
})

describe('fetchAuthServerMetadata discovery', () => {
  const PRM = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
  const ROOT_AS = 'https://auth.example.com/.well-known/oauth-authorization-server'
  const PATH_AS = 'https://mcp.example.com/.well-known/oauth-authorization-server/mcp'

  test('RFC 9728: the protected resource names the authorization server, whose metadata is returned', async () => {
    const t = table({
      [PRM]: () => Response.json({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'] }),
      [ROOT_AS]: () => Response.json(META),
    })
    const got = await fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', undefined, t.fetchFn)
    expect(got?.issuer).toBe(META.issuer)
    expect(t.seen).toEqual([PRM, ROOT_AS])
  })

  test('a resource metadata URL from WWW-Authenticate replaces the well-known probe', async () => {
    const custom = 'https://mcp.example.com/prm-from-header'
    const t = table({
      [custom]: () => Response.json({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'] }),
      [ROOT_AS]: () => Response.json(META),
    })
    const got = await fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', undefined, t.fetchFn, new URL(custom))
    expect(got?.issuer).toBe(META.issuer)
    expect(t.seen).toEqual([custom, ROOT_AS])
  })

  test('when the RFC 9728 chain throws (5xx), the path-aware RFC 8414 probe still finds co-hosted metadata', async () => {
    const legacy = { ...META, issuer: 'https://mcp.example.com' }
    const t = table({
      'https://mcp.example.com/.well-known/oauth-authorization-server': () => new Response('down', { status: 500 }),
      [PATH_AS]: () => Response.json(legacy),
    })
    const got = await fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', undefined, t.fetchFn)
    expect(got?.issuer).toBe('https://mcp.example.com')
    expect(t.seen.at(-1)).toBe(PATH_AS)
  })

  test('when RFC 9728 finds nothing, a path URL falls back to path-aware discovery', async () => {
    const legacy = { ...META, issuer: 'https://mcp.example.com' }
    const t = table({ [PATH_AS]: () => Response.json(legacy) })
    const got = await fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', undefined, t.fetchFn)
    expect(got?.issuer).toBe('https://mcp.example.com')
    expect(t.seen).toContain(PATH_AS)
  })

  test('a root URL with nothing to discover returns undefined without a second probe round', async () => {
    const t = table({})
    const got = await fetchAuthServerMetadata('s', 'https://mcp.example.com/', undefined, t.fetchFn)
    expect(got).toBeUndefined()
    const rootAsProbes = t.seen.filter(u => u === 'https://mcp.example.com/.well-known/oauth-authorization-server')
    expect(rootAsProbes).toHaveLength(1)
  })

  test('a path URL with nothing anywhere returns undefined', async () => {
    const t = table({})
    expect(await fetchAuthServerMetadata('s', 'https://mcp.example.com/mcp', undefined, t.fetchFn)).toBeUndefined()
  })
})
