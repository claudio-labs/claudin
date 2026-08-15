import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  pollDeviceCodeToken,
  requestDeviceCode,
  type KimiDeviceCodeResponse,
} from 'src/providers/oauth/kimiOAuth.js'

const originalFetch = globalThis.fetch
const originalClientId = process.env.KIMI_OAUTH_CLIENT_ID
const originalConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeEach(() => {
  // Hermetic secure storage (device id persistence) in a throwaway dir.
  process.env.CLAUDIN_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'kimi-oauth-'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalClientId === undefined) delete process.env.KIMI_OAUTH_CLIENT_ID
  else process.env.KIMI_OAUTH_CLIENT_ID = originalClientId
  if (originalConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = originalConfigDir
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('requestDeviceCode posts client_id + X-Msh-* headers and normalizes response', async () => {
  process.env.KIMI_OAUTH_CLIENT_ID = 'test-client-id'

  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(
      'https://auth.kimi.com/api/oauth/device_authorization',
    )
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Msh-Platform')).toBe('kimi_code_cli')
    // Auth host gets the bare `node` UA, not the coding-host kimi-code-cli UA.
    expect(headers.get('User-Agent')).toBe('node')
    expect(headers.get('X-Msh-Device-Id')).toBeTruthy()
    const body = new URLSearchParams(String(init?.body ?? ''))
    expect(body.get('client_id')).toBe('test-client-id')
    // Kimi's device_authorization body carries only client_id (no scope).
    expect(body.get('scope')).toBeNull()
    return jsonResponse({
      device_code: 'device-abc',
      user_code: 'MZIW-W9DM',
      verification_uri: 'https://www.kimi.com/code/authorize_device',
      verification_uri_complete:
        'https://www.kimi.com/code/authorize_device?user_code=MZIW-W9DM',
      expires_in: 1800,
      interval: 5,
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const device = await requestDeviceCode()
  expect(device.device_code).toBe('device-abc')
  expect(device.user_code).toBe('MZIW-W9DM')
  expect(device.verification_uri_complete).toContain('user_code=MZIW-W9DM')
  expect(device.interval).toBe(5)
})

test('pollDeviceCodeToken keeps polling on authorization_pending, then returns tokens', async () => {
  process.env.KIMI_OAUTH_CLIENT_ID = 'test-client-id'
  const device: KimiDeviceCodeResponse = {
    device_code: 'device-abc',
    user_code: 'MZIW-W9DM',
    verification_uri: 'https://www.kimi.com/code/authorize_device',
    expires_in: 1800,
    interval: 1,
  }

  let call = 0
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://auth.kimi.com/api/oauth/token')
    const body = new URLSearchParams(String(init?.body ?? ''))
    expect(body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    )
    expect(body.get('device_code')).toBe('device-abc')
    call += 1
    if (call === 1) {
      return jsonResponse({ error: 'authorization_pending' }, 400)
    }
    return jsonResponse({
      access_token: 'acc-123',
      refresh_token: 'ref-456',
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'kimi-code',
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  let virtualNow = 1_000
  const tokens = await pollDeviceCodeToken(device, {
    sleep: async () => {
      virtualNow += 1_000
    },
    now: () => virtualNow,
  })

  expect(call).toBe(2)
  expect(tokens.accessToken).toBe('acc-123')
  expect(tokens.refreshToken).toBe('ref-456')
  expect(tokens.expiresAt).toBe(virtualNow + 900 * 1000)
})

test('pollDeviceCodeToken throws on access_denied', async () => {
  const device: KimiDeviceCodeResponse = {
    device_code: 'device-abc',
    user_code: 'MZIW-W9DM',
    verification_uri: 'https://www.kimi.com/code/authorize_device',
    expires_in: 1800,
    interval: 1,
  }
  globalThis.fetch = mock(async () =>
    jsonResponse({ error: 'access_denied' }, 400),
  ) as unknown as typeof fetch

  await expect(pollDeviceCodeToken(device, { now: () => 0 })).rejects.toThrow(
    /denied/i,
  )
})
