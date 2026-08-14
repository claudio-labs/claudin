/**
 * Kimi Code OAuth using the Device Authorization Grant (RFC 8628).
 *
 * No loopback HTTP server, no callback URL, no PKCE — the user copies a short
 * `user_code` into `verification_uri` (or follows the prebuilt
 * `verification_uri_complete` URL) and we poll the token endpoint until they
 * approve. Every request carries the `X-Msh-*` device headers (the backend
 * rejects requests without them) and, on the auth host, the bare `node`
 * User-Agent the official CLI uses there.
 *
 * Endpoints/client_id captured from the official CLI — see
 * `docs/tech/kimi-code/wire-format.md`.
 */

import { getKimiDeviceHeaders } from 'src/services/api/kimiDeviceHeaders.js'
import {
  asTrimmedString,
  getKimiOAuthClientId,
  KIMI_AUTH_HOST_USER_AGENT,
  KIMI_OAUTH_DEVICE_CODE_GRANT_TYPE,
  KIMI_OAUTH_DEVICE_CODE_URL,
  KIMI_OAUTH_TOKEN_URL,
} from './kimiOAuthShared.js'

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_MAX_INTERVAL_MS = 60_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 30 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

type KimiOAuthTokenResponse = {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

export type KimiOAuthTokens = {
  accessToken: string
  refreshToken: string
  /** Absolute epoch-ms when the access token expires (Date.now() + expires_in*1000). */
  expiresAt?: number
}

export type KimiDeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

type DeviceTokenErrorBody = {
  error?: string
  error_description?: string
}

async function authHeaders(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': KIMI_AUTH_HOST_USER_AGENT,
    ...(await getKimiDeviceHeaders()),
  }
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Request a fresh device + user code from Kimi. Caller renders the `user_code`
 * and `verification_uri_complete` to the user, then passes the response to
 * {@link pollDeviceCodeToken}.
 */
export async function requestDeviceCode(options?: {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<KimiDeviceCodeResponse> {
  const fetchFn = options?.fetchImpl ?? fetch
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000)

  const response = await fetchFn(KIMI_OAUTH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: await authHeaders(),
    body: new URLSearchParams({
      client_id: getKimiOAuthClientId(),
    }).toString(),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Kimi device code request failed (${response.status})${
        detail ? `: ${detail.trim()}` : ''
      }`,
    )
  }

  const json = (await response.json()) as Partial<KimiDeviceCodeResponse>
  const deviceCode = asTrimmedString(json.device_code)
  const userCode = asTrimmedString(json.user_code)
  const verificationUri = asTrimmedString(json.verification_uri)
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      'Kimi device code response is missing device_code / user_code / verification_uri.',
    )
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: asTrimmedString(json.verification_uri_complete),
    expires_in:
      typeof json.expires_in === 'number' && json.expires_in > 0
        ? json.expires_in
        : DEVICE_CODE_DEFAULT_EXPIRES_MS / 1000,
    interval:
      typeof json.interval === 'number' && json.interval > 0
        ? json.interval
        : DEVICE_CODE_DEFAULT_INTERVAL_MS / 1000,
  }
}

/**
 * Poll the Kimi token endpoint until the user approves the device code (or we
 * hit `expires_in`). Implements RFC 8628 §3.5: respect `authorization_pending`
 * (keep polling at current interval) and `slow_down` (bump interval by ≥5s).
 */
export async function pollDeviceCodeToken(
  device: KimiDeviceCodeResponse,
  options?: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    now?: () => number
  },
): Promise<KimiOAuthTokens> {
  const fetchFn = options?.fetchImpl ?? fetch
  const sleep = options?.sleep ?? defaultSleep
  const now = options?.now ?? (() => Date.now())
  const expiresInMs = positiveSecondsToMs(
    device.expires_in,
    DEVICE_CODE_DEFAULT_EXPIRES_MS,
  )
  const deadline = now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (now() < deadline) {
    if (options?.signal?.aborted) {
      throw new Error('Kimi device authorization was cancelled.')
    }

    const response = await fetchFn(KIMI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: await authHeaders(),
      body: new URLSearchParams({
        grant_type: KIMI_OAUTH_DEVICE_CODE_GRANT_TYPE,
        client_id: getKimiOAuthClientId(),
        device_code: device.device_code,
      }).toString(),
      signal: options?.signal,
    })

    if (response.ok) {
      const payload = (await response.json()) as KimiOAuthTokenResponse
      const accessToken = asTrimmedString(payload.access_token)
      const refreshToken = asTrimmedString(payload.refresh_token)
      if (!accessToken || !refreshToken) {
        throw new Error(
          'Kimi OAuth completed, but the token response was missing credentials.',
        )
      }
      const expiresInSec =
        typeof payload.expires_in === 'number' &&
        Number.isFinite(payload.expires_in) &&
        payload.expires_in > 0
          ? payload.expires_in
          : 900
      return {
        accessToken,
        refreshToken,
        expiresAt: now() + expiresInSec * 1000,
      }
    }

    const body = (await response.json().catch(() => ({}))) as DeviceTokenErrorBody
    const remaining = Math.max(0, deadline - now())

    if (body.error === 'authorization_pending') {
      await sleep(
        Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining),
        options?.signal,
      )
      continue
    }
    if (body.error === 'slow_down') {
      intervalMs = Math.min(
        intervalMs + DEVICE_CODE_SLOW_DOWN_INCREMENT_MS,
        DEVICE_CODE_MAX_INTERVAL_MS,
      )
      await sleep(
        Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining),
        options?.signal,
      )
      continue
    }
    if (body.error === 'access_denied' || body.error === 'authorization_denied') {
      throw new Error('Kimi device authorization was denied.')
    }
    if (body.error === 'expired_token') {
      throw new Error('Kimi device code expired - please re-run login.')
    }
    const detail = body.error_description ?? body.error ?? ''
    throw new Error(
      `Kimi device token exchange failed (${response.status})${
        detail ? `: ${detail}` : ''
      }`,
    )
  }

  throw new Error('Kimi device authorization timed out.')
}

/**
 * Convenience wrapper: requests the device code, hands it to `onDeviceCode`
 * for rendering, then polls until the user authorizes or the flow fails.
 */
export class KimiOAuthService {
  private abortController: AbortController | null = null

  async startDeviceFlow(
    onDeviceCode: (device: KimiDeviceCodeResponse) => void | Promise<void>,
  ): Promise<KimiOAuthTokens> {
    const abortController = new AbortController()
    this.abortController = abortController
    try {
      const device = await requestDeviceCode({ signal: abortController.signal })
      await onDeviceCode(device)
      return await pollDeviceCodeToken(device, {
        signal: abortController.signal,
      })
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null
      }
    }
  }

  cleanup(): void {
    this.abortController?.abort(
      new Error('Kimi device authorization was cancelled.'),
    )
    this.abortController = null
  }
}
