import { afterEach, describe, expect, test } from 'bun:test'

import { AuthCodeListener } from 'src/providers/oauth/auth-code-listener.js'
import {
  CLAUDE_AI_INFERENCE_SCOPE,
  getOauthConfig,
} from 'src/shared/constants/oauth.js'

const listeners: AuthCodeListener[] = []

afterEach(() => {
  while (listeners.length > 0) {
    listeners.pop()?.close()
  }
})

async function startListener(
  callbackPath?: string,
): Promise<{ listener: AuthCodeListener; port: number }> {
  const listener = new AuthCodeListener(callbackPath)
  listeners.push(listener)
  const port = await listener.start()
  return { listener, port }
}

function get(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' })
}

async function authorize(
  listener: AuthCodeListener,
  port: number,
  path: string,
): Promise<{ code: string; response: Promise<Response> }> {
  let response: Promise<Response> | undefined
  const code = await listener.waitForAuthorization('state-ok', async () => {
    response = get(port, path)
  })
  return { code, response: response! }
}

test('cancelPendingAuthorization rejects a pending OAuth wait', async () => {
  const listener = new AuthCodeListener('/callback')
  listeners.push(listener)

  await listener.start()

  const pendingAuthorization = listener.waitForAuthorization(
    'state-test',
    async () => {},
  )

  listener.cancelPendingAuthorization(
    new Error('Codex OAuth flow was cancelled.'),
  )

  await expect(pendingAuthorization).rejects.toThrow(
    'Codex OAuth flow was cancelled.',
  )
})

test('cancelPendingAuthorization without an error uses the default message', async () => {
  const { listener } = await startListener()
  const pending = listener.waitForAuthorization('state-ok', async () => {})

  listener.cancelPendingAuthorization()

  await expect(pending).rejects.toThrow('OAuth authorization was cancelled.')
})

describe('start', () => {
  test('binds to an OS-assigned port on 127.0.0.1 and reports it', async () => {
    const { listener, port } = await startListener()

    expect(port).toBeGreaterThan(0)
    expect(listener.getPort()).toBe(port)
    expect(listener.hasPendingResponse()).toBe(false)
  })

  test('listens on the requested port', async () => {
    const { listener: first, port } = await startListener()
    first.close()

    const second = new AuthCodeListener()
    listeners.push(second)

    expect(await second.start(port)).toBe(port)
  })

  test('rejects with a readable error when the port is taken', async () => {
    const { port } = await startListener()
    const second = new AuthCodeListener()
    listeners.push(second)

    await expect(second.start(port)).rejects.toThrow(
      'Failed to start OAuth callback server:',
    )
  })

  test('close resets the reported port', async () => {
    const { listener } = await startListener()

    listener.close()

    expect(listener.getPort()).toBe(0)
  })
})

describe('redirect handling', () => {
  test('resolves the authorization code and holds the browser response', async () => {
    const { listener, port } = await startListener()

    const { code, response } = await authorize(
      listener,
      port,
      '/callback?code=auth-123&state=state-ok',
    )

    expect(code).toBe('auth-123')
    expect(listener.hasPendingResponse()).toBe(true)

    listener.handleSuccessRedirect([])
    const res = await response
    expect(res.status).toBe(302)
    expect(listener.hasPendingResponse()).toBe(false)
  })

  test('answers 404 for a path other than the callback and keeps waiting', async () => {
    const { listener, port } = await startListener()
    let settled = false
    let notFound: Response | undefined

    const pending = listener
      .waitForAuthorization('state-ok', async () => {
        notFound = await get(port, '/favicon.ico?code=x&state=state-ok')
        void get(port, '/callback?code=later&state=state-ok')
      })
      .finally(() => {
        settled = true
      })

    expect(await pending).toBe('later')
    expect(settled).toBe(true)
    expect(notFound?.status).toBe(404)
  })

  test('honours a custom callback path', async () => {
    const { listener, port } = await startListener('/auth/callback')
    let defaultPath: Response | undefined

    const code = await listener.waitForAuthorization('state-ok', async () => {
      defaultPath = await get(port, '/callback?code=x&state=state-ok')
      void get(port, '/auth/callback?code=custom&state=state-ok')
    })

    expect(defaultPath?.status).toBe(404)
    expect(code).toBe('custom')
  })

  test('a callback with the right state and no code answers 400 and rejects', async () => {
    const { listener, port } = await startListener()
    let response: Promise<Response> | undefined

    const pending = listener.waitForAuthorization('state-ok', async () => {
      response = get(port, '/callback?state=state-ok&error=access_denied')
    })

    await expect(pending).rejects.toThrow('No authorization code received')
    const res = await response!
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Authorization code not found')
    expect(listener.hasPendingResponse()).toBe(false)
  })
})

describe('handleSuccessRedirect', () => {
  test('sends a Claude.ai login to the Claude.ai success page', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )

    listener.handleSuccessRedirect([CLAUDE_AI_INFERENCE_SCOPE])

    const res = await response
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      getOauthConfig().CLAUDEAI_SUCCESS_URL,
    )
  })

  test('sends a Console login to the Console success page', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )

    listener.handleSuccessRedirect(['org:create_api_key'])

    const res = await response
    expect(res.headers.get('location')).toBe(
      getOauthConfig().CONSOLE_SUCCESS_URL,
    )
  })

  test('a custom handler serves the response with the granted scopes', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )
    let seenScopes: string[] | undefined

    listener.handleSuccessRedirect(['a', 'b'], (res, scopes) => {
      seenScopes = scopes
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('signed in')
    })

    const res = await response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('signed in')
    expect(seenScopes).toEqual(['a', 'b'])
    expect(listener.hasPendingResponse()).toBe(false)
  })

  test('a custom handler that does not end the response gets it ended', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )

    listener.handleSuccessRedirect([], res => {
      res.writeHead(204)
    })

    const res = await response
    expect(res.status).toBe(204)
  })

  test('a custom handler that throws answers 500', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )

    listener.handleSuccessRedirect([], () => {
      throw new Error('render failed')
    })

    const res = await response
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Authentication redirect failed')
    expect(listener.hasPendingResponse()).toBe(false)
  })

  test('is a no-op without a pending response', async () => {
    const { listener } = await startListener()
    let called = false

    listener.handleSuccessRedirect([], () => {
      called = true
    })

    expect(called).toBe(false)
  })
})

describe('handleErrorRedirect', () => {
  test('redirects to the Claude.ai success page by default', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )

    listener.handleErrorRedirect()

    const res = await response
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      getOauthConfig().CLAUDEAI_SUCCESS_URL,
    )
    expect(listener.hasPendingResponse()).toBe(false)
  })

  test('a custom handler serves the error response', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )

    listener.handleErrorRedirect(res => {
      res.writeHead(502)
      res.end('token exchange failed')
    })

    const res = await response
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('token exchange failed')
  })

  test('is a no-op without a pending response', async () => {
    const { listener } = await startListener()
    let called = false

    listener.handleErrorRedirect(() => {
      called = true
    })

    expect(called).toBe(false)
  })

  test('close with a pending response sends the error redirect first', async () => {
    const { listener, port } = await startListener()
    const { response } = await authorize(
      listener,
      port,
      '/callback?code=c&state=state-ok',
    )

    listener.close()

    const res = await response
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      getOauthConfig().CLAUDEAI_SUCCESS_URL,
    )
    expect(listener.hasPendingResponse()).toBe(false)
  })
})

test('a server error after the wait started rejects the pending authorization', async () => {
  const { listener } = await startListener()
  const pending = listener.waitForAuthorization('state-ok', async () => {})
  const server = (listener as unknown as { localServer: import('http').Server })
    .localServer

  server.emit('error', new Error('socket exploded'))

  await expect(pending).rejects.toThrow('socket exploded')
  expect(listener.getPort()).toBe(0)
})
