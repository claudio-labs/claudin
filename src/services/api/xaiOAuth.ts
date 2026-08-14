/**
 * xAI / Grok OAuth using the Device Authorization Grant (RFC 8628).
 *
 * No loopback HTTP server, no callback URL, no PKCE — the user copies a
 * short `user_code` into `verification_uri` (or follows the prebuilt
 * `verification_uri_complete` URL) and we poll the token endpoint until
 * they approve. Works in SSH/Docker/VPS/CI as long as the user can reach
 * a browser on some device.
 */

import { getXaiUserAgent } from 'src/utils/xaiUserAgent.js'
import {
  asTrimmedString,
  getXaiOAuthClientId,
  XAI_OAUTH_DEVICE_CODE_GRANT_TYPE,
  XAI_OAUTH_DEVICE_CODE_URL,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_TOKEN_URL,
} from './xaiOAuthShared.js'

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_MAX_INTERVAL_MS = 60_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

type XaiOAuthTokenResponse = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

export type XaiOAuthTokens = {
  accessToken: string
  refreshToken: string
  idToken?: string
  /** Absolute epoch-ms when the access token expires (Date.now() + expires_in*1000). */
  expiresAt?: number
}

export type XaiDeviceCodeResponse = {
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

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': getXaiUserAgent(),
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
 * Request a fresh device + user code from xAI. Caller renders the
 * `user_code` and `verification_uri` (or `verification_uri_complete`) to the
 * user, then passes the response to `pollDeviceCodeToken`.
 */
export async function requestDeviceCode(options?: {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<XaiDeviceCodeResponse> {
  const fetchFn = options?.fetchImpl ?? fetch
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000)

  const response = await fetchFn(XAI_OAUTH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: getXaiOAuthClientId(),
      scope: XAI_OAUTH_SCOPE,
    }).toString(),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `xAI device code request failed (${response.status})${
        detail ? `: ${detail.trim()}` : ''
      }`,
    )
  }

  const json = (await response.json()) as Partial<XaiDeviceCodeResponse>
  const deviceCode = asTrimmedString(json.device_code)
  const userCode = asTrimmedString(json.user_code)
  const verificationUri = asTrimmedString(json.verification_uri)
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      'xAI device code response is missing device_code / user_code / verification_uri.',
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
 * Poll the xAI token endpoint until the user approves the device code (or
 * we hit `expires_in`). Implements RFC 8628 §3.5: respect `authorization_pending`
 * (keep polling at current interval) and `slow_down` (bump interval by ≥5s).
 */
export async function pollDeviceCodeToken(
  device: XaiDeviceCodeResponse,
  options?: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    now?: () => number
  },
): Promise<XaiOAuthTokens> {
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
      throw new Error('xAI device authorization was cancelled.')
    }

    const response = await fetchFn(XAI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: XAI_OAUTH_DEVICE_CODE_GRANT_TYPE,
        client_id: getXaiOAuthClientId(),
        device_code: device.device_code,
      }).toString(),
      signal: options?.signal,
    })

    if (response.ok) {
      const payload = (await response.json()) as XaiOAuthTokenResponse
      const accessToken = asTrimmedString(payload.access_token)
      const refreshToken = asTrimmedString(payload.refresh_token)
      if (!accessToken || !refreshToken) {
        throw new Error(
          'xAI OAuth completed, but the token response was missing credentials.',
        )
      }
      const expiresInSec =
        typeof payload.expires_in === 'number' &&
        Number.isFinite(payload.expires_in) &&
        payload.expires_in > 0
          ? payload.expires_in
          : 3600
      return {
        accessToken,
        refreshToken,
        idToken: asTrimmedString(payload.id_token),
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
      // RFC 8628 §3.5 requires bumping by ≥5s; clamp at 60s so a misbehaving
      // server can't push us into multi-minute backoffs that block the user.
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
      throw new Error('xAI device authorization was denied.')
    }
    if (body.error === 'expired_token') {
      throw new Error('xAI device code expired - please re-run login.')
    }
    const detail = body.error_description ?? body.error ?? ''
    throw new Error(
      `xAI device token exchange failed (${response.status})${
        detail ? `: ${detail}` : ''
      }`,
    )
  }

  throw new Error('xAI device authorization timed out.')
}

/**
 * Convenience wrapper: requests the device code and polls until the user
 * authorizes or the flow fails. Callers that need to render the user_code
 * to the UI before polling should use {@link requestDeviceCode} +
 * {@link pollDeviceCodeToken} directly.
 */
export class XaiOAuthService {
  private abortController: AbortController | null = null

  async startDeviceFlow(
    onDeviceCode: (device: XaiDeviceCodeResponse) => void | Promise<void>,
  ): Promise<XaiOAuthTokens> {
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
      new Error('xAI device authorization was cancelled.'),
    )
    this.abortController = null
  }
}
