// Mock rate limits for testing [internal-only]
// The external build keeps this module as a stable no-op surface so imports
// remain valid without exposing internal-only rate-limit simulation behavior.
// This allows testing various rate limit scenarios without hitting actual limits
//
// WARNING: This is for internal testing/demo purposes only!
// The mock headers may not exactly match the API specification or real-world behavior.
// Always validate against actual API responses before relying on this for production features.

import { setMockBillingAccessOverride } from '../utils/billing.js'
import type { OverageDisabledReason } from './claudeAiLimits.js'

type SubscriptionType = string

type MockHeaders = {
  'anthropic-ratelimit-unified-status'?:
    | 'allowed'
    | 'allowed_warning'
    | 'rejected'
  'anthropic-ratelimit-unified-reset'?: string
  'anthropic-ratelimit-unified-representative-claim'?:
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
  'anthropic-ratelimit-unified-overage-status'?:
    | 'allowed'
    | 'allowed_warning'
    | 'rejected'
  'anthropic-ratelimit-unified-overage-reset'?: string
  'anthropic-ratelimit-unified-overage-disabled-reason'?: OverageDisabledReason
  'anthropic-ratelimit-unified-fallback'?: 'available'
  'anthropic-ratelimit-unified-fallback-percentage'?: string
  'retry-after'?: string
  'anthropic-ratelimit-unified-5h-utilization'?: string
  'anthropic-ratelimit-unified-5h-reset'?: string
  'anthropic-ratelimit-unified-5h-surpassed-threshold'?: string
  'anthropic-ratelimit-unified-7d-utilization'?: string
  'anthropic-ratelimit-unified-7d-reset'?: string
  'anthropic-ratelimit-unified-7d-surpassed-threshold'?: string
  'anthropic-ratelimit-unified-overage-utilization'?: string
  'anthropic-ratelimit-unified-overage-surpassed-threshold'?: string
}

export type MockHeaderKey =
  | 'status'
  | 'reset'
  | 'claim'
  | 'overage-status'
  | 'overage-reset'
  | 'overage-disabled-reason'
  | 'fallback'
  | 'fallback-percentage'
  | 'retry-after'
  | '5h-utilization'
  | '5h-reset'
  | '5h-surpassed-threshold'
  | '7d-utilization'
  | '7d-reset'
  | '7d-surpassed-threshold'

export type MockScenario =
  | 'normal'
  | 'session-limit-reached'
  | 'approaching-weekly-limit'
  | 'weekly-limit-reached'
  | 'overage-active'
  | 'overage-warning'
  | 'overage-exhausted'
  | 'out-of-credits'
  | 'org-zero-credit-limit'
  | 'org-spend-cap-hit'
  | 'member-zero-credit-limit'
  | 'seat-tier-zero-credit-limit'
  | 'opus-limit'
  | 'opus-warning'
  | 'sonnet-limit'
  | 'sonnet-warning'
  | 'fast-mode-limit'
  | 'fast-mode-short-limit'
  | 'extra-usage-required'
  | 'clear'


export function getMockHeaderless429Message(): string | null {
  return null
}

export function getMockHeaders(): MockHeaders | null {
  return null
}


export function applyMockHeaders(
  headers: globalThis.Headers,
): globalThis.Headers {
  return headers
}

export function shouldProcessMockLimits(): boolean {
  return false
}


export function getMockSubscriptionType(): SubscriptionType | null {
  return null
}

export function shouldUseMockSubscription(): boolean {
  return false
}


export function isMockFastModeRateLimitScenario(): boolean {
  return false
}

export function checkMockFastModeRateLimit(
  _isFastModeActive?: boolean,
): MockHeaders | null {
  return null
}
