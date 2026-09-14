import { describe, expect, test } from 'bun:test'

import type { RateLimitInfo } from 'src/providers/rateLimitInfo.js'
import {
  formatProviderLimitHead,
  formatProviderLimitMessage,
  formatProviderLimitTail,
  getRateLimitErrorMessage,
  isRateLimitErrorMessage,
} from 'src/providers/rateLimitMessages.js'

const NOW = 1_700_000_000_000

const WINDOW: RateLimitInfo = {
  kind: 'window',
  source: 'openai-reset',
  resetsAtMs: NOW + 2 * 3_600_000 + 14 * 60_000,
}
const BURST: RateLimitInfo = { kind: 'burst', source: 'none' }
const EXHAUSTED: RateLimitInfo = { kind: 'exhausted', source: 'none' }

describe('formatProviderLimitMessage', () => {
  test('names the provider and the remaining time', () => {
    expect(formatProviderLimitMessage(WINDOW, 'OpenAI', NOW)).toBe(
      'Rate limit reached · OpenAI · resets in 2h 14m',
    )
  })

  test('says so plainly when the provider reported no reset', () => {
    expect(formatProviderLimitMessage(BURST, 'AWS Bedrock', NOW)).toBe(
      'Rate limit reached · AWS Bedrock · no reset time reported',
    )
  })

  test("keeps the provider's own wording when there is no clock to show", () => {
    // errorDetails is not rendered anywhere, so with no reset time this is the
    // only place the reason can appear. This is the case that used to read
    // "Request rejected (429) · <detail>".
    expect(
      formatProviderLimitMessage(
        { ...BURST, detail: 'monthly spend limit of $50 exceeded' },
        'OpenAI',
        NOW,
      ),
    ).toBe(
      'Rate limit reached · OpenAI · monthly spend limit of $50 exceeded · no reset time reported',
    )
  })

  test('leaves the wording out once there is a countdown to show instead', () => {
    expect(
      formatProviderLimitMessage({ ...WINDOW, detail: 'rate limit exceeded' }, 'OpenAI', NOW),
    ).toBe('Rate limit reached · OpenAI · resets in 2h 14m')
  })

  test('billing exhaustion points at billing, not at a clock', () => {
    expect(formatProviderLimitMessage(EXHAUSTED, 'OpenAI', NOW)).toBe(
      'Quota exhausted · OpenAI · enable billing for this provider, or switch with /provider',
    )
  })

  test('a reset that has already passed invites a retry', () => {
    expect(formatProviderLimitTail({ ...WINDOW, resetsAtMs: NOW - 1 }, NOW)).toBe(
      'the limit should have cleared — try again',
    )
  })

  test('head and tail compose into the whole message', () => {
    expect(
      `${formatProviderLimitHead(WINDOW, 'Kimi')} · ${formatProviderLimitTail(WINDOW, NOW)}`,
    ).toBe(formatProviderLimitMessage(WINDOW, 'Kimi', NOW))
  })

  test('the head is stable as the clock runs down', () => {
    // The renderer matches a transcript message to the live limit by its head,
    // so the head must not carry anything time-dependent.
    const head = formatProviderLimitHead(WINDOW, 'Kimi')
    expect(formatProviderLimitMessage(WINDOW, 'Kimi', NOW).startsWith(head)).toBe(true)
    expect(
      formatProviderLimitMessage(WINDOW, 'Kimi', NOW + 3_600_000).startsWith(head),
    ).toBe(true)
  })
})

describe('every limit message routes to the rate-limit renderer', () => {
  test.each([
    [WINDOW, 'OpenAI'],
    [BURST, 'AWS Bedrock'],
    [EXHAUSTED, 'OpenAI'],
  ] as const)('%o', (info, label) => {
    // AssistantTextMessage picks the component by prefix, so a message whose
    // prefix is missing from the list renders as plain error text instead.
    expect(isRateLimitErrorMessage(formatProviderLimitMessage(info, label, NOW))).toBe(
      true,
    )
  })
})

describe('the Anthropic limit text carries the remaining time', () => {
  test('appends "(in …)" beside the wall-clock reset', () => {
    const resetsAt = Math.floor((Date.now() + 2 * 3_600_000 + 14 * 60_000) / 1000)
    const message = getRateLimitErrorMessage(
      {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: 'five_hour',
        resetsAt,
      },
      'claude-opus-5',
    )
    expect(message).toContain("You've hit your session limit · resets ")
    expect(message).toContain('(in 2h 14m)')
  })

  test('omits the reset entirely when the API sent no timestamp', () => {
    const message = getRateLimitErrorMessage(
      {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: 'five_hour',
      },
      'claude-opus-5',
    )
    expect(message).toBe("You've hit your session limit")
  })

  test('a reset already in the past keeps the time and drops the countdown', () => {
    const message = getRateLimitErrorMessage(
      {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: 'seven_day',
        resetsAt: Math.floor((Date.now() - 60_000) / 1000),
      },
      'claude-opus-5',
    )
    expect(message).toContain("You've hit your weekly limit · resets ")
    expect(message).not.toContain('(in ')
  })

  test('with overage also rejected, it counts down to whichever clears first', () => {
    const inOneHour = Math.floor((Date.now() + 3_600_000) / 1000)
    const inThreeHours = Math.floor((Date.now() + 3 * 3_600_000) / 1000)

    const subscriptionFirst = getRateLimitErrorMessage(
      {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        overageStatus: 'rejected',
        resetsAt: inOneHour,
        overageResetsAt: inThreeHours,
      },
      'claude-opus-5',
    )
    const overageFirst = getRateLimitErrorMessage(
      {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        overageStatus: 'rejected',
        resetsAt: inThreeHours,
        overageResetsAt: inOneHour,
      },
      'claude-opus-5',
    )

    // Asserted both ways round: picking one side unconditionally passes one of
    // these and fails the other.
    expect(subscriptionFirst).toContain('(in 1h)')
    expect(overageFirst).toContain('(in 1h)')
  })

  test('running out of extra usage says so, with the earlier reset', () => {
    const message = getRateLimitErrorMessage(
      {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
        overageResetsAt: Math.floor((Date.now() + 2 * 3_600_000) / 1000),
      },
      'claude-opus-5',
    )
    expect(message).toContain("You're out of extra usage · resets ")
    expect(message).toContain('(in 2h)')
  })
})
