import { expect, mock, test } from 'bun:test'

/**
 * `handleErrorRedirect` hands the pending HTTP response to a caller-supplied
 * handler. Whatever that handler does — end the response, leave it open, or
 * throw — the listener must close it and drop its reference, or the browser
 * tab hangs on a request that never completes.
 *
 * These three cases used to be observed through an OAuth analytics
 * event the method emitted. That event reached a function the build stubs to
 * an empty body, so it is gone, and the assertions now read the response and
 * the listener directly. That is the stronger observation: it pins what the
 * user experiences rather than what was reported about it.
 */

type FakeResponse = {
  destroyed: boolean
  headersSent: boolean
  writableEnded: boolean
  statusCode: number
  body: string
  writeHead: (statusCode: number, headers?: Record<string, string>) => void
  end: (body?: string) => void
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: '',
    writeHead: (statusCode: number) => {
      response.headersSent = true
      response.statusCode = statusCode
    },
    end: (body = '') => {
      response.writableEnded = true
      response.body = body
    },
  }
  return response
}

/** Cache-busted so each test gets its own module instance and its own mocks. */
async function freshListener() {
  const { AuthCodeListener } = await import(
    `./auth-code-listener.js?ts=${Date.now()}-${Math.random()}`
  )
  return new AuthCodeListener('/callback')
}

test('a handler that ends the response leaves nothing pending', async () => {
  const response = makeResponse()
  const listener = await freshListener()
  ;(listener as any).pendingResponse = response

  listener.handleErrorRedirect((res: FakeResponse) => {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('cancelled')
  })

  expect(response.writableEnded).toBe(true)
  expect(response.body).toBe('cancelled')
  expect((listener as any).pendingResponse).toBeNull()
})

test('a handler that does not end the response is closed automatically', async () => {
  mock.module('src/shared/log.js', () => ({ logError: () => {} }))

  const response = makeResponse()
  const listener = await freshListener()
  ;(listener as any).pendingResponse = response

  // Writes the head and returns without calling end().
  listener.handleErrorRedirect((res: FakeResponse) => {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
  })

  expect(response.writableEnded).toBe(true)
  expect((listener as any).pendingResponse).toBeNull()
})

test('a handler that throws falls back to a 500 and is logged', async () => {
  const loggedErrors: unknown[] = []
  mock.module('src/shared/log.js', () => ({
    logError: (error: unknown) => {
      loggedErrors.push(error)
    },
  }))

  const response = makeResponse()
  const listener = await freshListener()
  ;(listener as any).pendingResponse = response

  listener.handleErrorRedirect(() => {
    throw new Error('handler exploded')
  })

  expect(response.statusCode).toBe(500)
  expect(response.body).toBe('Authentication redirect failed')
  expect(response.writableEnded).toBe(true)
  expect((listener as any).pendingResponse).toBeNull()
  expect(loggedErrors).toHaveLength(1)
})
