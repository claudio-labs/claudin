import { describe, expect, test } from 'bun:test'

import {
  buildCodexUsageRows,
  formatCodexPlanType,
  getCodexUsageUrl,
  normalizeCodexRateLimitEvent,
  normalizeCodexRateLimitHeaders,
  normalizeCodexUsagePayload,
} from 'src/providers/usage/codexUsage.js'

describe('normalizeCodexUsagePayload', () => {
  test('normalizes live Codex usage payloads from /backend-api/wham/usage', () => {
    const usage = normalizeCodexUsagePayload({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 38,
          limit_window_seconds: 18_000,
          reset_at: 1_775_154_358,
        },
        secondary_window: {
          used_percent: 32,
          limit_window_seconds: 604_800,
          reset_at: 1_775_685_041,
        },
      },
      code_review_rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604_800,
          reset_at: 1_775_744_471,
        },
        secondary_window: null,
      },
      credits: {
        has_credits: false,
        unlimited: false,
        balance: '0',
      },
    })

    expect(usage.planType).toBe('plus')
    expect(usage.snapshots).toHaveLength(2)
    expect(usage.snapshots[0]).toMatchObject({
      limitName: 'codex',
      primary: {
        usedPercent: 38,
        windowMinutes: 300,
      },
      secondary: {
        usedPercent: 32,
        windowMinutes: 10_080,
      },
    })
    expect(usage.snapshots[1]).toMatchObject({
      limitName: 'code review',
      primary: {
        usedPercent: 0,
        windowMinutes: 10_080,
      },
    })
  })

  test('supports direct protocol-style snapshot collections', () => {
    const usage = normalizeCodexUsagePayload({
      rateLimitsByLimitId: {
        codex: {
          limit_name: 'codex',
          primary: {
            used_percent: 12,
            window_minutes: 300,
            resets_at: 1_700_000_000,
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: '25',
          },
        },
      },
    })

    expect(usage.snapshots).toEqual([
      {
        limitName: 'codex',
        primary: {
          usedPercent: 12,
          windowMinutes: 300,
          resetsAt: new Date(1_700_000_000 * 1000).toISOString(),
        },
        secondary: undefined,
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '25',
        },
      },
    ])
  })
})

describe('buildCodexUsageRows', () => {
  test('builds Codex-like labels for primary and secondary windows', () => {
    const rows = buildCodexUsageRows([
      {
        limitName: 'codex',
        primary: {
          usedPercent: 38,
          windowMinutes: 300,
          resetsAt: '2026-04-02T10:00:00.000Z',
        },
        secondary: {
          usedPercent: 32,
          windowMinutes: 10_080,
          resetsAt: '2026-04-09T10:00:00.000Z',
        },
      },
      {
        limitName: 'code review',
        primary: {
          usedPercent: 0,
          windowMinutes: 10_080,
          resetsAt: '2026-04-09T10:00:00.000Z',
        },
      },
    ])

    expect(rows).toEqual([
      {
        kind: 'window',
        label: '5h limit',
        usedPercent: 38,
        resetsAt: '2026-04-02T10:00:00.000Z',
      },
      {
        kind: 'window',
        label: 'Weekly limit',
        usedPercent: 32,
        resetsAt: '2026-04-09T10:00:00.000Z',
      },
      {
        kind: 'window',
        label: 'Code review Weekly limit',
        usedPercent: 0,
        resetsAt: '2026-04-09T10:00:00.000Z',
      },
    ])
  })

  test('renders credits rows only when credits are available', () => {
    const rows = buildCodexUsageRows([
      {
        limitName: 'codex',
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '25.2',
        },
      },
      {
        limitName: 'code review',
        credits: {
          hasCredits: true,
          unlimited: true,
        },
      },
      {
        limitName: 'other',
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '0',
        },
      },
    ])

    expect(rows).toEqual([
      {
        kind: 'text',
        label: 'Credits',
        value: '25 credits',
      },
      {
        kind: 'text',
        label: 'Code review limit',
        value: '',
      },
      {
        kind: 'text',
        label: 'Credits',
        value: 'Unlimited',
      },
    ])
  })
})

describe('Codex usage helpers', () => {
  test('formats plan labels and usage endpoint url', () => {
    expect(formatCodexPlanType('team_max')).toBe('Team Max')
    expect(getCodexUsageUrl()).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(getCodexUsageUrl('https://chatgpt.com/backend-api/codex')).toBe(
      'https://chatgpt.com/backend-api/wham/usage',
    )
  })
})

// Both shapes as captured from the Codex backend on 2026-10-22 (free plan).
describe('live rate limits from a Codex response', () => {
  test('the codex.rate_limits socket event: one snapshot, plus its credits', () => {
    const data = normalizeCodexRateLimitEvent({
      type: 'codex.rate_limits',
      plan_type: 'free',
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 12, window_minutes: 43200, reset_after_seconds: 2591988, reset_at: 1795289225 },
        secondary: null,
      },
      code_review_rate_limits: null,
      additional_rate_limits: null,
      credits: { has_credits: true, unlimited: false, balance: '5' },
      promo: null,
    })
    expect(data).toEqual({
      planType: 'free',
      snapshots: [
        {
          limitName: 'codex',
          primary: { usedPercent: 12, windowMinutes: 43200, resetsAt: '2026-11-21T19:27:05.000Z' },
          secondary: undefined,
          credits: { hasCredits: true, unlimited: false, balance: '5' },
        },
      ],
    })
  })

  test('an event without rate limits, or not an object, gives no snapshot', () => {
    expect(normalizeCodexRateLimitEvent({ type: 'codex.rate_limits' }).snapshots).toEqual([])
    expect(normalizeCodexRateLimitEvent('nope').snapshots).toEqual([])
  })

  test('the x-codex-* headers of an HTTP response; an absent window is dropped', () => {
    const headers = new Headers({
      'x-codex-plan-type': 'free',
      'x-codex-primary-used-percent': '76',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1795289222',
      'x-codex-primary-reset-after-seconds': '2592000',
      'x-codex-secondary-used-percent': '0',
      'x-codex-secondary-window-minutes': '0',
      'x-codex-secondary-reset-after-seconds': '0',
    })
    expect(normalizeCodexRateLimitHeaders(headers)).toEqual({
      planType: 'free',
      snapshots: [
        {
          limitName: 'codex',
          primary: { usedPercent: 76, windowMinutes: 300, resetsAt: '2026-11-21T19:27:02.000Z' },
          secondary: undefined,
        },
      ],
    })
  })

  test('a weekly secondary window is kept', () => {
    const data = normalizeCodexRateLimitHeaders(
      new Headers({
        'x-codex-primary-used-percent': '10',
        'x-codex-primary-window-minutes': '300',
        'x-codex-secondary-used-percent': '91.5',
        'x-codex-secondary-window-minutes': '10080',
      }),
    )
    expect(data?.snapshots[0]?.secondary).toEqual({
      usedPercent: 91.5,
      windowMinutes: 10080,
      resetsAt: undefined,
    })
  })

  test('a response with no x-codex-* headers carries no limits', () => {
    expect(normalizeCodexRateLimitHeaders(new Headers({ 'content-type': 'text/event-stream' }))).toBeUndefined()
    expect(
      normalizeCodexRateLimitHeaders(new Headers({ 'x-codex-primary-used-percent': 'garbage' })),
    ).toBeUndefined()
  })
})
