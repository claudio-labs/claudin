import { afterEach, expect, mock, test } from 'bun:test'

import {
  pollDeviceCodeToken,
  requestDeviceCode,
  XaiOAuthService,
  type XaiDeviceCodeResponse,
} from 'src/providers/oauth/xaiOAuth.js'

const originalFetch = globalThis.fetch
const originalClientId = process.env.XAI_OAUTH_CLIENT_ID

afterEach(() => {
  globalThis.fetch = originalFetch

  if (originalClientId === undefined) {
    delete process.env.XAI_OAUTH_CLIENT_ID
  } else {
    process.env.XAI_OAUTH_CLIENT_ID = originalClientId
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('requestDeviceCode posts client_id + scope and returns normalized response', async () => {
  process.env.XAI_OAUTH_CLIENT_ID = 'test-client-id'

  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    expect(url).toBe('https://auth.x.ai/oauth2/device/code')
    expect(init?.method).toBe('POST')
    const body = new URLSearchParams(String(init?.body ?? ''))
    expect(body.get('client_id')).toBe('test-client-id')
    expect(body.get('scope')).toContain('offline_access')
    expect(body.get('scope')).toContain('grok-cli:access')
    return jsonResponse({
      device_code: 'device-abc',
      user_code: 'WXYZ-1234',
      verification_uri: 'https://accounts.x.ai/device',
      verification_uri_complete:
        'https://accounts.x.ai/device?user_code=WXYZ-1234',
      expires_in: 600,
      interval: 5,
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const device = await requestDeviceCode()
  expect(device.device_code).toBe('device-abc')
  expect(device.user_code).toBe('WXYZ-1234')
  expect(device.verification_uri).toBe('https://accounts.x.ai/device')
  expect(device.verification_uri_complete).toBe(
    'https://accounts.x.ai/device?user_code=WXYZ-1234',
  )
  expect(device.interval).toBe(5)
  expect(device.expires_in).toBe(600)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('requestDeviceCode throws when the response is missing required fields', async () => {
  globalThis.fetch = mock(async () =>
    jsonResponse({ user_code: 'X' }),
  ) as unknown as typeof fetch

  await expect(requestDeviceCode()).rejects.toThrow(/missing device_code/)
})

test('requestDeviceCode surfaces server errors', async () => {
  globalThis.fetch = mock(
    async () => new Response('rate limited', { status: 429 }),
  ) as unknown as typeof fetch

  await expect(requestDeviceCode()).rejects.toThrow(
    /xAI device code request failed \(429\): rate limited/,
  )
})

const DEVICE: XaiDeviceCodeResponse = {
  device_code: 'device-abc',
  user_code: 'WXYZ-1234',
  verification_uri: 'https://accounts.x.ai/device',
  expires_in: 600,
  interval: 1,
}

test('pollDeviceCodeToken returns tokens on success', async () => {
  process.env.XAI_OAUTH_CLIENT_ID = 'test-client-id'

  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://auth.x.ai/oauth2/token')
    const body = new URLSearchParams(String(init?.body ?? ''))
    expect(body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    )
    expect(body.get('client_id')).toBe('test-client-id')
    expect(body.get('device_code')).toBe('device-abc')
    return jsonResponse({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const tokens = await pollDeviceCodeToken(DEVICE, {
    sleep: async () => {},
  })
  expect(tokens.accessToken).toBe('access-token')
  expect(tokens.refreshToken).toBe('refresh-token')
  expect(tokens.expiresAt).toBeGreaterThan(Date.now())
})

test('pollDeviceCodeToken keeps polling while authorization_pending', async () => {
  let call = 0
  globalThis.fetch = mock(async () => {
    call += 1
    if (call < 3) {
      return jsonResponse({ error: 'authorization_pending' }, 400)
    }
    return jsonResponse({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    })
  }) as unknown as typeof fetch

  const sleeps: number[] = []
  const tokens = await pollDeviceCodeToken(DEVICE, {
    sleep: async ms => {
      sleeps.push(ms)
    },
  })
  expect(call).toBe(3)
  expect(tokens.accessToken).toBe('access-token')
  expect(sleeps.length).toBe(2)
})

test('pollDeviceCodeToken increases interval on slow_down', async () => {
  let call = 0
  globalThis.fetch = mock(async () => {
    call += 1
    if (call === 1) return jsonResponse({ error: 'slow_down' }, 400)
    return jsonResponse({
      access_token: 'a',
      refresh_token: 'b',
      expires_in: 100,
    })
  }) as unknown as typeof fetch

  const sleeps: number[] = []
  await pollDeviceCodeToken(DEVICE, {
    sleep: async ms => {
      sleeps.push(ms)
    },
  })
  // After slow_down: interval bumped from 1s by 5s → ~6_000ms + 3_000ms margin.
  expect(sleeps[0]).toBeGreaterThanOrEqual(6_000)
})

test('pollDeviceCodeToken clamps slow_down interval at 60s', async () => {
  let call = 0
  globalThis.fetch = mock(async () => {
    call += 1
    if (call < 20) return jsonResponse({ error: 'slow_down' }, 400)
    return jsonResponse({
      access_token: 'a',
      refresh_token: 'b',
      expires_in: 100,
    })
  }) as unknown as typeof fetch

  const sleeps: number[] = []
  await pollDeviceCodeToken(
    { ...DEVICE, expires_in: 3600 },
    {
      sleep: async ms => {
        sleeps.push(ms)
      },
    },
  )
  // Cap is 60s + 3s safety margin. No sleep should exceed that.
  const maxSleep = Math.max(...sleeps)
  expect(maxSleep).toBeLessThanOrEqual(63_000)
})

test('pollDeviceCodeToken throws on access_denied', async () => {
  globalThis.fetch = mock(async () =>
    jsonResponse({ error: 'access_denied' }, 400),
  ) as unknown as typeof fetch

  await expect(
    pollDeviceCodeToken(DEVICE, { sleep: async () => {} }),
  ).rejects.toThrow(/xAI device authorization was denied/)
})

test('pollDeviceCodeToken throws on expired_token', async () => {
  globalThis.fetch = mock(async () =>
    jsonResponse({ error: 'expired_token' }, 400),
  ) as unknown as typeof fetch

  await expect(
    pollDeviceCodeToken(DEVICE, { sleep: async () => {} }),
  ).rejects.toThrow(/xAI device code expired/)
})

test('pollDeviceCodeToken surfaces unknown errors with description', async () => {
  globalThis.fetch = mock(async () =>
    jsonResponse(
      { error: 'invalid_grant', error_description: 'bad device code' },
      400,
    ),
  ) as unknown as typeof fetch

  await expect(
    pollDeviceCodeToken(DEVICE, { sleep: async () => {} }),
  ).rejects.toThrow(/bad device code/)
})

test('XaiOAuthService.startDeviceFlow exposes the device code to the UI before tokens resolve', async () => {
  let observedUserCode: string | undefined
  let call = 0
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/device/code')) {
      return jsonResponse({
        device_code: 'device-abc',
        user_code: 'CODE-9999',
        verification_uri: 'https://accounts.x.ai/device',
        expires_in: 600,
        interval: 1,
      })
    }
    call += 1
    if (call === 1) return jsonResponse({ error: 'authorization_pending' }, 400)
    return jsonResponse({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    })
  }) as unknown as typeof fetch

  const service = new XaiOAuthService()
  // Bypass the real polling delay via a private cast — the service calls
  // pollDeviceCodeToken without a sleep override in production, so for the
  // test we just rely on the second poll succeeding immediately.
  const tokens = await service.startDeviceFlow(async device => {
    observedUserCode = device.user_code
  })
  expect(observedUserCode).toBe('CODE-9999')
  expect(tokens.accessToken).toBe('access-token')
})
