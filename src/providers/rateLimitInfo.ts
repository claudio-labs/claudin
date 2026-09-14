/**
 * Provider-agnostic reading of a 429 response: when does the limit reset, and
 * what kind of limit is it.
 *
 * This module is deliberately **pure** — no `getAPIProvider()`, no config, no
 * I/O. The reset readers are a table tried in order rather than a switch on the
 * provider tag: a provider tag is not a capability, and the tag is coarse
 * anyway (`openai` covers xAI, Kimi, Ollama, MiniMax, NVIDIA and every other
 * OpenAI-compatible endpoint). A header that is present gets read no matter who
 * sent it, so a new provider is covered without touching this file.
 *
 * Everything that formats the result for a human lives in rateLimitMessages.ts;
 * everything that decides what to *do* about it lives in transport/withRetry.ts.
 */

import type { APIError } from '@anthropic-ai/sdk'

/**
 * Ceiling on how long anything will WAIT for a limit to clear, so a
 * pathological header — or a genuine weekly window — can't pin the session for
 * days. Deliberately not applied to the reported reset instant: see
 * `extractRateLimitInfo`.
 */
export const RATE_LIMIT_RESET_CAP_MS = 6 * 60 * 60 * 1000

/**
 * A 429 whose reset is further out than this is not worth retrying: ten
 * attempts of exponential backoff top out around a minute of waiting and then
 * fail anyway. Below it, the limit is a burst throttle the backoff clears.
 */
export const RATE_LIMIT_STOP_THRESHOLD_MS = 60_000

/** Ceiling on the provider wording carried into the user-facing line. */
const MAX_DETAIL_CHARS = 140

const NUMERIC_RETRY_AFTER_RE = /^\d+(?:\.\d+)?$/
const OPENAI_DURATION_RE =
  /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/
// Google's google.rpc.RetryInfo, carried in the JSON body of a
// RESOURCE_EXHAUSTED response rather than in a header.
const GEMINI_RETRY_DELAY_RE = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/
const OPENAI_CATEGORY_MARKER_RE = /\s*\[openai_category=[a-z_]+\]\s*/g
const LEADING_STATUS_RE = /^429\s+/
const INNER_MESSAGE_RE = /"message"\s*:\s*"([^"]*)"/
const COLLAPSE_SPACES_RE = /\s{2,}/g

/** Where the reset instant came from, or `none` when nothing reported one. */
export type ResetSource =
  | 'anthropic-unified'
  | 'openai-reset'
  | 'gemini-retry-info'
  | 'retry-after'
  | 'none'

/**
 * - `window` — a real usage window with a known reset instant.
 * - `burst`  — rate limited, but nothing told us when it clears.
 * - `exhausted` — billing/quota is spent. There is no reset to wait for.
 */
export type RateLimitKind = 'window' | 'burst' | 'exhausted'

export type RateLimitInfo = {
  kind: RateLimitKind
  /** Absolute epoch ms. Only set when a reader actually found one. */
  resetsAtMs?: number
  source: ResetSource
  /** The provider's own wording, with transport metadata stripped. */
  detail?: string
}

/**
 * Read one response header off an SDK error.
 *
 * Headers arrive either as a plain object (some SDK error shapes) or as a Fetch
 * `Headers` instance, so both are tried.
 */
export function readHeader(error: unknown, name: string): string | null {
  const headers = (error as { headers?: unknown }).headers
  if (!headers) return null
  const plain = (headers as Record<string, string | undefined>)[name]
  if (typeof plain === 'string' && plain !== '') return plain
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const got = (headers as Headers).get?.(name)
  return typeof got === 'string' && got !== '' ? got : null
}

/**
 * Parse a Retry-After header value into milliseconds, as the server stated it.
 *
 * Accepts:
 *   - integer seconds: "5" → 5000
 *   - decimal seconds: "0.5" → 500
 *   - HTTP-date (RFC 7231): "Wed, 21 Oct 2099 07:28:00 GMT" → ms until that
 *     instant (clamped at 0 for past dates)
 *
 * Uncapped on purpose: what the server said and how long we are willing to
 * wait are different questions, and clamping here made the second answer
 * masquerade as the first — a three-day window was reported as six hours.
 * The cap belongs at the point of use.
 */
function parseRetryAfterUncapped(
  value: string | null | undefined,
  nowMs: number,
): number | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null

  // Numeric path covers both integer and decimal seconds.
  if (NUMERIC_RETRY_AFTER_RE.test(trimmed)) {
    const seconds = Number(trimmed)
    // A negative cannot reach here — the regex is digits only — but a long
    // enough run of digits overflows to Infinity.
    if (!Number.isFinite(seconds)) return null
    return Math.round(seconds * 1000)
  }

  // HTTP-date fallback. Date.parse returns NaN for unrecognized formats.
  const target = Date.parse(trimmed)
  if (!Number.isFinite(target)) return null
  const delta = target - nowMs
  return delta <= 0 ? 0 : delta
}

/**
 * Parse the millisecond-precision `retry-after-ms` extension. Value is already
 * in ms — no second→ms conversion. Returns null for invalid input.
 */
function parseRetryAfterMsUncapped(value: string | null | undefined): number | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!NUMERIC_RETRY_AFTER_RE.test(trimmed)) return null
  const ms = Number(trimmed)
  if (!Number.isFinite(ms)) return null
  return Math.round(ms)
}

/**
 * Parse a Retry-After header into a delay we are willing to sleep for: the
 * server's value, capped at RATE_LIMIT_RESET_CAP_MS so a pathological header
 * cannot pin the session for days.
 */
export function parseRetryAfterValue(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  const ms = parseRetryAfterUncapped(value, nowMs)
  return ms === null ? null : Math.min(ms, RATE_LIMIT_RESET_CAP_MS)
}

/**
 * Read a Retry-After hint from the error and return how long to sleep, capped.
 *
 * Prefers `retry-after-ms` (millisecond-precision extension used by Anthropic
 * and OpenAI) over `retry-after` (RFC 7231) when both are present.
 */
export function getRetryAfterMs(
  error: unknown,
  nowMs: number = Date.now(),
): number | null {
  const ms = getRetryAfterUncappedMs(error, nowMs)
  return ms === null ? null : Math.min(ms, RATE_LIMIT_RESET_CAP_MS)
}

function getRetryAfterUncappedMs(error: unknown, nowMs: number): number | null {
  const ms = parseRetryAfterMsUncapped(readHeader(error, 'retry-after-ms'))
  if (ms !== null) return ms
  return parseRetryAfterUncapped(readHeader(error, 'retry-after'), nowMs)
}

/**
 * Parse OpenAI-style relative duration strings into milliseconds.
 * Formats: "1s", "6m0s", "1h30m0s", "500ms", "2m"
 * Returns null for unrecognized formats.
 */
export function parseOpenAIDuration(s: string): number | null {
  if (!s) return null
  const m = OPENAI_DURATION_RE.exec(s)
  if (!m || m[0] === '') return null
  const h = parseInt(m[1] ?? '0', 10)
  const min = parseInt(m[2] ?? '0', 10)
  const sec = parseInt(m[3] ?? '0', 10)
  const ms = parseInt(m[4] ?? '0', 10)
  const total = h * 3_600_000 + min * 60_000 + sec * 1_000 + ms
  return total > 0 ? total : null
}

/**
 * The searchable text of an error: its message (which embeds the raw response
 * body on the OpenAI-compatible path) plus the parsed body when the SDK kept
 * one. Used only for body-carried signals like Google's RetryInfo.
 */
function errorText(error: unknown): string {
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''
  const body = (error as { error?: unknown }).error
  if (body && typeof body === 'object') {
    try {
      return `${message} ${JSON.stringify(body)}`
    } catch {
      // Circular or non-serializable body — the message alone is enough.
      return message
    }
  }
  return message
}

type ResetReader = {
  source: Exclude<ResetSource, 'none'>
  /** Milliseconds from now until the limit clears, or null when silent. */
  read: (error: unknown, nowMs: number) => number | null
}

/**
 * Tried in order. The specific window headers come first on purpose: a
 * multi-hour window limit can still carry a short `retry-after`, and honoring
 * that would report a reset minutes away for a limit that clears in hours.
 */
const RESET_READERS: ResetReader[] = [
  {
    source: 'anthropic-unified',
    read: (error, nowMs) => {
      const header = readHeader(error, 'anthropic-ratelimit-unified-reset')
      if (header === null) return null
      const resetUnixSec = Number(header)
      if (!Number.isFinite(resetUnixSec)) return null
      const delayMs = resetUnixSec * 1000 - nowMs
      return delayMs > 0 ? delayMs : null
    },
  },
  {
    source: 'openai-reset',
    read: error => readOpenAIReset(error),
  },
  {
    source: 'gemini-retry-info',
    read: error => {
      const match = GEMINI_RETRY_DELAY_RE.exec(errorText(error))
      if (!match?.[1]) return null
      const seconds = Number(match[1])
      if (!Number.isFinite(seconds) || seconds <= 0) return null
      return Math.round(seconds * 1000)
    },
  },
  {
    source: 'retry-after',
    read: (error, nowMs) => {
      const ms = getRetryAfterUncappedMs(error, nowMs)
      return ms !== null && ms > 0 ? ms : null
    },
  },
]

/**
 * OpenAI reports BOTH buckets on every 429, so the two reset values say
 * nothing on their own about which one tripped: a seconds-long
 * requests-per-minute throttle routinely ships beside a multi-hour
 * requests-per-day reset. Taking the larger of the two — which is what this
 * did while it only fed a wait loop — ends a turn that one retry would have
 * cleared.
 *
 * The `remaining` counters disambiguate, so prefer the bucket that is actually
 * spent. With neither counter present, take the SMALLER reset: over-reporting
 * costs the user a turn, under-reporting costs one more attempt.
 */
function readOpenAIReset(error: unknown): number | null {
  const reqMs = parseOpenAIDuration(
    readHeader(error, 'x-ratelimit-reset-requests') ?? '',
  )
  const tokMs = parseOpenAIDuration(
    readHeader(error, 'x-ratelimit-reset-tokens') ?? '',
  )
  if (reqMs === null && tokMs === null) return null

  const reqSpent = isBucketSpent(error, 'x-ratelimit-remaining-requests')
  const tokSpent = isBucketSpent(error, 'x-ratelimit-remaining-tokens')
  if (reqSpent && !tokSpent && reqMs !== null) return reqMs
  if (tokSpent && !reqSpent && tokMs !== null) return tokMs

  if (reqMs === null) return tokMs
  if (tokMs === null) return reqMs
  return Math.min(reqMs, tokMs)
}

function isBucketSpent(error: unknown, headerName: string): boolean {
  const header = readHeader(error, headerName)
  if (header === null) return false
  const remaining = Number(header)
  return Number.isFinite(remaining) && remaining <= 0
}

/**
 * Billing exhaustion rather than a usage window: the account is out of credit
 * or the model has a zero quota. Waiting does not help, so this never carries a
 * reset instant.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
  if ((error as { status?: unknown }).status !== 429) return false
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return false
  const lower = message.toLowerCase()
  return lower.includes('limit: 0') || lower.includes('exceeded your current quota')
}

/**
 * The provider's own wording, with the shim's category marker, the SDK's
 * `429 ` prefix and a JSON envelope stripped off, truncated so a body that
 * came back as one long blob cannot take over the message line.
 */
function extractDetail(error: unknown): string | undefined {
  const raw = (error as { message?: unknown }).message
  if (typeof raw !== 'string' || raw === '') return undefined
  const stripped = raw
    .replace(OPENAI_CATEGORY_MARKER_RE, ' ')
    .replace(LEADING_STATUS_RE, '')
    .replace(COLLAPSE_SPACES_RE, ' ')
    .trim()
  // The SDK JSON-stringifies the whole body when there is no top-level
  // `.message` — pull the inner one back out rather than showing the envelope.
  const inner = INNER_MESSAGE_RE.exec(stripped)?.[1]
  const detail = (inner ?? stripped).trim()
  if (detail === '') return undefined
  return detail.length > MAX_DETAIL_CHARS
    ? `${detail.slice(0, MAX_DETAIL_CHARS)}…`
    : detail
}

/**
 * Classify a 429 and, when anything reported one, work out when it clears.
 * Returns null for anything that is not a rate limit.
 */
export function extractRateLimitInfo(
  error: unknown,
  nowMs: number = Date.now(),
): RateLimitInfo | null {
  if ((error as { status?: unknown }).status !== 429) return null

  const detail = extractDetail(error)

  if (isQuotaExhaustedError(error)) {
    return { kind: 'exhausted', source: 'none', detail }
  }

  for (const reader of RESET_READERS) {
    const delayMs = reader.read(error, nowMs)
    if (delayMs === null) continue
    return {
      kind: 'window',
      // Reported as the provider stated it. Clamping here would have the
      // message assert a reset time that is simply untrue for a weekly window;
      // how long anything is willing to WAIT is capped at the point of use.
      resetsAtMs: nowMs + delayMs,
      source: reader.source,
      detail,
    }
  }

  return { kind: 'burst', source: 'none', detail }
}

/**
 * How long to wait for the limit to clear, or null when nothing reported a
 * reset. Capped at RATE_LIMIT_RESET_CAP_MS — this is the "how long are we
 * prepared to sleep" answer, not the "when does it reset" one.
 */
export function getRateLimitResetDelayMs(
  error: APIError,
  nowMs: number = Date.now(),
): number | null {
  const info = extractRateLimitInfo(error, nowMs)
  if (!info?.resetsAtMs) return null
  const delayMs = info.resetsAtMs - nowMs
  return delayMs > 0 ? Math.min(delayMs, RATE_LIMIT_RESET_CAP_MS) : null
}

/**
 * True when the provider told us the limit clears further out than the retry
 * loop can usefully wait. An unreported reset is deliberately NOT long: with
 * no information, the existing backoff is still the best guess.
 */
export function isLongRateLimit(
  error: unknown,
  nowMs: number = Date.now(),
): boolean {
  const info = extractRateLimitInfo(error, nowMs)
  if (info?.resetsAtMs === undefined) return false
  return info.resetsAtMs - nowMs > RATE_LIMIT_STOP_THRESHOLD_MS
}
