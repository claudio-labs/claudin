/**
 * The fetch every OAuth request goes through, and authorization-server
 * metadata discovery, against real servers on loopback.
 *
 * Neither function is on the barrel: the provider, the sign-in flow and
 * revocation reach them inside the slice, so they are imported from the file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthFetch, fetchAuthServerMetadata } from 'src/mcp/auth/authFetch.js'
import {
  type AuthBed,
  makeLoopbackCert,
  startAuthBed,
  withSelfSignedTrust,
} from 'src/mcp/auth/__testutils__/oauthTestBed.js'

const beds: AuthBed[] = []
const bedWith = (overrides: Parameters<typeof startAuthBed>[0] = {}, tls?: { cert: string; key: string }) => {
  const b = startAuthBed(overrides, tls)
  beds.push(b)
  return b
}
afterEach(() => {
  for (const b of beds.splice(0)) b.stop()
})

let certDir = ''
let cert: { cert: string; key: string }
beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'mcp-authfetch-cert-'))
  cert = makeLoopbackCert(certDir)
})
afterAll(() => rmSync(certDir, { recursive: true, force: true }))

/** A server whose every answer is `body` with status 200, after `delayMs`. */
function answering(body: unknown, delayMs = 0) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      if (delayMs) await Bun.sleep(delayMs)
      return Response.json(body)
    },
  })
  return { url: `http://127.0.0.1:${server.port}/token`, stop: () => server.stop(true) }
}

describe('createAuthFetch', () => {
  test('a 200 POST carrying an OAuth error is turned into a 400 the SDK can classify', async () => {
    type Case = [label: string, method: string, body: unknown, status: number, out: unknown]
    const cases: Case[] = [
      ['Slack alias', 'POST', { error: 'invalid_refresh_token' }, 400, { error: 'invalid_grant', error_description: 'Server returned non-standard error code: invalid_refresh_token' }],
      ['alias keeps its description', 'post', { error: 'token_expired', error_description: 'old' }, 400, { error: 'invalid_grant', error_description: 'old' }],
      ['standard code passes through', 'POST', { error: 'invalid_scope' }, 400, { error: 'invalid_scope' }],
      ['a token response is left alone', 'POST', { access_token: 'a', token_type: 'Bearer' }, 200, { access_token: 'a', token_type: 'Bearer' }],
      ['a GET is never rewritten', 'GET', { error: 'invalid_refresh_token' }, 200, { error: 'invalid_refresh_token' }],
    ]
    for (const [label, method, body, status, out] of cases) {
      const server = answering(body)
      try {
        const res = await createAuthFetch()(server.url, { method })
        expect(res.status, label).toBe(status)
        expect(await res.json(), label).toEqual(out)
      } finally {
        server.stop()
      }
    }
  })

  test('a caller signal is honoured alongside the request timeout', async () => {
    const quick = answering({ error: 'expired_refresh_token' })
    const slow = answering({ ok: true }, 2000)
    try {
      const live = new AbortController()
      const res = await createAuthFetch()(quick.url, { method: 'POST', signal: live.signal })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_grant')

      await expect(createAuthFetch()(quick.url, { signal: AbortSignal.abort() })).rejects.toThrow()

      const cut = new AbortController()
      const started = Date.now()
      const pending = createAuthFetch()(slow.url, { signal: cut.signal })
      setTimeout(() => cut.abort(), 100)
      await expect(pending).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(1500)
    } finally {
      quick.stop()
      slow.stop()
    }
  })
})

describe('fetchAuthServerMetadata', () => {
  test('a configured metadata URL must be https', async () => {
    await expect(fetchAuthServerMetadata('docs', 'https://mcp.test/mcp', 'http://as.test/meta')).rejects.toThrow(
      'authServerMetadataUrl must use https:// (got: http://as.test/meta)',
    )
  })

  test('a configured metadata URL is fetched directly, and a failure names its status', async () => {
    const ok = bedWith({}, cert)
    const missing = bedWith({ metadataAt: 'nowhere' }, cert)
    const okUrl = `${ok.base}/.well-known/oauth-authorization-server`
    const missingUrl = `${missing.base}/.well-known/oauth-authorization-server`
    await withSelfSignedTrust(async () => {
      const metadata = await fetchAuthServerMetadata('docs', 'https://unrelated.test/mcp', okUrl)
      expect(metadata?.token_endpoint).toBe(`${ok.base}/token`)
      await expect(fetchAuthServerMetadata('docs', 'https://unrelated.test/mcp', missingUrl)).rejects.toThrow(
        `HTTP 404 fetching configured auth server metadata from ${missingUrl}`,
      )
    })
    expect(ok.hits('/.well-known/oauth-protected-resource/mcp')).toHaveLength(0)
  })

  test('without a configured URL it discovers, falling back to the path-aware location', async () => {
    type Case = [label: string, overrides: Parameters<typeof startAuthBed>[0], underMcpHit: boolean]
    const cases: Case[] = [
      ['RFC 9728 then RFC 8414', {}, false],
      ['legacy server, root metadata missing', { protectedResource: false, metadataAt: 'under-mcp' }, true],
      ['legacy server, root metadata erroring', { protectedResource: false, metadataAt: 'under-mcp', rootMetadataStatus: 500 }, true],
    ]
    for (const [label, overrides, underMcpHit] of cases) {
      const b = bedWith(overrides)
      const metadata = await fetchAuthServerMetadata('docs', b.mcpUrl, undefined)
      expect(metadata?.issuer, label).toBe(b.base)
      expect(b.hits('/.well-known/oauth-authorization-server/mcp').length > 0, label).toBe(underMcpHit)
    }
  })

  test('a root server URL with no metadata anywhere yields undefined', async () => {
    const b = bedWith({ protectedResource: false, metadataAt: 'nowhere' })
    expect(await fetchAuthServerMetadata('docs', `${b.base}/`, undefined)).toBeUndefined()
    expect(b.hits('/.well-known/oauth-authorization-server/mcp')).toHaveLength(0)
  })

  test('a given fetch and resource metadata URL are the ones used', async () => {
    const b = bedWith()
    const urls: string[] = []
    const counting = (url: string | URL, init?: RequestInit) => {
      urls.push(String(url))
      return fetch(url, init)
    }
    const prm = `${b.base}/.well-known/oauth-protected-resource/mcp`
    const metadata = await fetchAuthServerMetadata('docs', `${b.base}/elsewhere`, undefined, counting, new URL(prm))
    expect(metadata?.issuer).toBe(b.base)
    expect(urls[0]).toBe(prm)
  })
})
