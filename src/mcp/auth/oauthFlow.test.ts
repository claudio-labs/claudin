/**
 * performMCPOAuthFlow behaviour the characterization suite does not reach:
 * the 404 fix on the callback server, cancelling during discovery, the
 * callback-port fallbacks, and the error page without a description.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { AuthenticationCancelledError, getServerKey, performMCPOAuthFlow } from 'src/mcp/auth.js'
import {
  type AuthBed,
  approveInBrowser,
  startAuthBed,
  useIsolatedStore,
} from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import type { McpHTTPServerConfig } from 'src/mcp/types.js'

const store = useIsolatedStore()
let bed: AuthBed | undefined
const extraServers: { stop(force?: boolean): void }[] = []
const holders: Server[] = []
afterEach(() => {
  bed?.stop()
  bed = undefined
  for (const s of extraServers.splice(0)) s.stop(true)
  for (const h of holders.splice(0)) h.close(() => undefined)
})

const http = (url: string): McpHTTPServerConfig => ({ type: 'http', url })

const CALLBACK_RE = /^http:\/\/localhost:(\d+)\/callback$/

describe('the callback server', () => {
  test('answers any path other than /callback with a 404 and keeps waiting', async () => {
    bed = startAuthBed()
    let stray: { status: number; body: string } | undefined
    await performMCPOAuthFlow(
      'docs',
      http(bed.mcpUrl),
      url => {
        void (async () => {
          const callback = new URL(new URL(url).searchParams.get('redirect_uri')!)
          const response = await fetch(`${callback.origin}/favicon.ico`)
          stray = { status: response.status, body: await response.text() }
          await approveInBrowser(url)
        })()
      },
      undefined,
      { skipBrowserOpen: true },
    )
    expect(stray).toEqual({ status: 404, body: 'Not found' })
    expect(bed.hits('/token')).toHaveLength(1)
  })

  test('an error with no description shows the error code alone', async () => {
    bed = startAuthBed({ denyWith: { error: 'access_denied' } })
    let page: ReturnType<typeof approveInBrowser> | undefined
    const flow = performMCPOAuthFlow('docs', http(bed.mcpUrl), url => {
      page = approveInBrowser(url)
    }, undefined, { skipBrowserOpen: true })
    await expect(flow).rejects.toThrow('OAuth error: access_denied')
    expect((await page!).html).toBe(
      '<h1>Authentication Error</h1><p>access_denied</p><p>You can close this window.</p>',
    )
  })

  test('an unusable port in the environment falls back to any free port', async () => {
    // Bun clamps a listen port above 65535 to 65535, so holding that port is
    // what makes an unchecked 70000 fail instead of passing unnoticed. Someone
    // else already holding it serves the same purpose.
    const holder = createServer()
    holders.push(holder)
    await new Promise<void>(done => {
      holder.once('error', () => done())
      holder.listen(65535, '127.0.0.1', done)
    })
    for (const value of ['not-a-port', '70000']) {
      bed?.stop()
      bed = startAuthBed()
      process.env.MCP_OAUTH_CALLBACK_PORT = value
      let redirect = ''
      await performMCPOAuthFlow('docs', http(bed.mcpUrl), url => {
        redirect = new URL(url).searchParams.get('redirect_uri')!
        void approveInBrowser(url)
      }, undefined, { skipBrowserOpen: true })
      const port = Number(CALLBACK_RE.exec(redirect)?.[1])
      expect(port, value).toBeGreaterThan(0)
      expect(port, value).toBeLessThanOrEqual(65535)
    }
  })
})

describe('cancelling', () => {
  test('an already aborted sign-in leaves the stored credentials alone', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    const entry = { serverName: 'docs', serverUrl: cfg.url, clientId: 'kept', accessToken: 'kept', expiresAt: 1 }
    store.write({ mcpOAuth: { [getServerKey('docs', cfg)]: entry } })
    await expect(performMCPOAuthFlow('docs', cfg, () => {}, AbortSignal.abort())).rejects.toBeInstanceOf(
      AuthenticationCancelledError,
    )
    expect(store.read()!.mcpOAuth[getServerKey('docs', cfg)]).toEqual(entry)
  })

  test('an abort during metadata discovery stops before a client is registered or a URL reported', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        seen.push(new URL(req.url).pathname)
        controller.abort()
        return Response.json({}, { status: 404 })
      },
    })
    extraServers.push(server)
    const reported: string[] = []
    await expect(
      performMCPOAuthFlow('docs', http(`http://127.0.0.1:${server.port}/mcp`), url => reported.push(url), controller.signal),
    ).rejects.toBeInstanceOf(AuthenticationCancelledError)
    expect(reported).toEqual([])
    expect(seen).not.toContain('/register')
  })
})
