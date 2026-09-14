import { describe, expect, test } from 'bun:test'

import {
  canArmResume,
  describeLimit,
  isSessionIdle,
  MAX_AUTO_RESUMES,
  RESUME_COMMAND,
  RESUME_MAX_HORIZON_MS,
  resumeDelayMs,
} from 'src/agent/hooks/rateLimitResume.js'
import type { ProviderRateLimit } from 'src/providers/rateLimitState.js'

const NOW = 1_700_000_000_000

function limit(overrides: Partial<ProviderRateLimit> = {}): ProviderRateLimit {
  return {
    kind: 'window',
    source: 'openai-reset',
    resetsAtMs: NOW + 2 * 3_600_000 + 14 * 60_000,
    providerLabel: 'OpenAI',
    model: 'gpt-5',
    observedAtMs: NOW,
    ...overrides,
  }
}

describe('describeLimit', () => {
  test('names the provider and how long the wait is', () => {
    expect(describeLimit(limit(), NOW)).toBe('Rate limited · OpenAI · back in 2h 14m')
  })

  test('reports a sub-minute throttle in seconds', () => {
    // Rounded up to "1m" this contradicted the retry notice ticking beside it,
    // which counts the real seconds down.
    expect(describeLimit(limit({ resetsAtMs: NOW + 7_000 }), NOW)).toBe(
      'Rate limited · OpenAI · back in 7s',
    )
  })

  test('omits the wait when no reset was reported', () => {
    expect(describeLimit(limit({ resetsAtMs: undefined }), NOW)).toBe(
      'Rate limited · OpenAI',
    )
  })

  test('omits the wait for a reset already in the past', () => {
    expect(describeLimit(limit({ resetsAtMs: NOW - 1 }), NOW)).toBe(
      'Rate limited · OpenAI',
    )
  })
})

describe('isSessionIdle', () => {
  const idle = { isLoading: false, draft: '', queueLength: 0 }

  test('is idle only when nothing is running, typed or queued', () => {
    expect(isSessionIdle(idle)).toBe(true)
  })

  test('a query in flight blocks the resume', () => {
    expect(isSessionIdle({ ...idle, isLoading: true })).toBe(false)
  })

  test('a draft in the input blocks the resume', () => {
    // The user is mid-thought; re-sending under them would steal the turn.
    expect(isSessionIdle({ ...idle, draft: 'w' })).toBe(false)
  })

  test('anything already queued blocks the resume', () => {
    expect(isSessionIdle({ ...idle, queueLength: 1 })).toBe(false)
  })
})

describe('canArmResume', () => {
  test('arms for a reset inside the horizon', () => {
    expect(canArmResume(NOW + 2 * 3_600_000, NOW)).toBe(true)
    expect(canArmResume(NOW - 1_000, NOW)).toBe(true)
  })

  test('refuses a reset beyond the horizon', () => {
    // A weekly window is days out. setTimeout fires IMMEDIATELY above
    // 2^31-1 ms, so arming one would resume straight into a live limit.
    expect(canArmResume(NOW + 7 * 86_400_000, NOW)).toBe(false)
    expect(canArmResume(NOW + RESUME_MAX_HORIZON_MS + 1, NOW)).toBe(false)
  })

  test('refuses when no reset was reported', () => {
    expect(canArmResume(undefined, NOW)).toBe(false)
  })
})

describe('resumeDelayMs', () => {
  test('is the time remaining', () => {
    expect(resumeDelayMs(NOW + 90_000, NOW)).toBe(90_000)
  })

  test('never goes negative', () => {
    expect(resumeDelayMs(NOW - 90_000, NOW)).toBe(0)
  })

  test('never exceeds the horizon, so it cannot overflow setTimeout', () => {
    // Above 2^31-1 ms a setTimeout fires immediately instead of later.
    const delay = resumeDelayMs(NOW + 30 * 86_400_000, NOW)
    expect(delay).toBe(RESUME_MAX_HORIZON_MS)
    expect(delay).toBeLessThan(2 ** 31 - 1)
  })
})

describe('RESUME_COMMAND', () => {
  test('is hidden from the transcript and never jumps the queue', () => {
    // isMeta false would render it as something the user apparently typed;
    // a priority above 'later' would let it run before what they did type.
    expect(RESUME_COMMAND.isMeta).toBe(true)
    expect(RESUME_COMMAND.priority).toBe('later')
    expect(RESUME_COMMAND.mode).toBe('prompt')
  })

  test('is plain text, so it cannot be taken for a slash command or a skill', () => {
    expect(RESUME_COMMAND.value.startsWith('/')).toBe(false)
    expect(RESUME_COMMAND.value.length).toBeGreaterThan(0)
  })
})

describe('MAX_AUTO_RESUMES', () => {
  test('is a small finite ceiling', () => {
    // The loop it stops is resume → 429 → wait → resume, which records a new
    // limit each time round and would otherwise never terminate.
    expect(MAX_AUTO_RESUMES).toBeGreaterThan(0)
    expect(MAX_AUTO_RESUMES).toBeLessThanOrEqual(5)
  })
})
