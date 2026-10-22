import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'

import * as auth from 'src/providers/auth/auth.js'
import * as billing from 'src/providers/usage/billing.js'
import type { ClaudeAILimits } from 'src/providers/claudeAiLimits.js'
import type { AccountInfo } from 'src/platform/config/config/types.js'
import type { SubscriptionType } from 'src/providers/oauth/types.js'
import type { RateLimitInfo } from 'src/providers/rateLimitInfo.js'
import {
  claudeWindowLabel,
  formatProviderLimitHead,
  formatProviderLimitMessage,
  formatProviderLimitTail,
  getClaudeWarningWindow,
  getRateLimitErrorMessage,
  getRateLimitMessage,
  getRateLimitWarning,
  getUsingOverageText,
  isRateLimitErrorMessage,
} from 'src/providers/rateLimitMessages.js'
import { formatResetTime } from 'src/shared/text/format.js'

const NOW = 1_700_000_000_000

const WINDOW: RateLimitInfo = {
  kind: 'window',
  source: 'openai-reset',
  resetsAtMs: NOW + 2 * 3_600_000 + 14 * 60_000,
}
const BURST: RateLimitInfo = { kind: 'burst', source: 'none' }
const EXHAUSTED: RateLimitInfo = { kind: 'exhausted', source: 'none' }

describe('formatProviderLimitMessage', () => {
  test('names the provider first, then the remaining time', () => {
    expect(formatProviderLimitMessage(WINDOW, 'OpenAI', NOW)).toBe(
      'OpenAI · rate limit reached · resets in 2h 14m',
    )
  })

  test('a named limit reads as that limit', () => {
    expect(
      formatProviderLimitMessage({ ...WINDOW, source: 'codex-usage-limit', limitName: '5h limit' }, 'Codex OAuth', NOW),
    ).toBe('Codex OAuth · 5h limit reached · resets in 2h 14m')
  })

  test('says so plainly when the provider reported no reset', () => {
    expect(formatProviderLimitMessage(BURST, 'AWS Bedrock', NOW)).toBe(
      'AWS Bedrock · rate limit reached · no reset time reported',
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
      'OpenAI · rate limit reached · monthly spend limit of $50 exceeded · no reset time reported',
    )
  })

  test('leaves the wording out once there is a countdown to show instead', () => {
    expect(
      formatProviderLimitMessage({ ...WINDOW, detail: 'rate limit exceeded' }, 'OpenAI', NOW),
    ).toBe('OpenAI · rate limit reached · resets in 2h 14m')
  })

  test('billing exhaustion points at billing, not at a clock', () => {
    expect(formatProviderLimitMessage(EXHAUSTED, 'OpenAI', NOW)).toBe(
      'OpenAI · quota exhausted · enable billing for this provider, or switch with /provider',
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
    [{ ...WINDOW, limitName: 'weekly limit' }, 'Codex OAuth'],
  ] as const)('%o', (info, label) => {
    // AssistantTextMessage picks the component by shape, so a message the
    // router does not recognize renders as plain assistant text instead.
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
      'Anthropic',
    )
    expect(message).toContain('Anthropic · session limit reached · resets ')
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
      'Anthropic',
    )
    expect(message).toBe('Anthropic · session limit reached')
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
      'Anthropic',
    )
    expect(message).toContain('Anthropic · weekly limit reached · resets ')
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
      'Anthropic',
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
      'Anthropic',
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
      'Anthropic',
    )
    expect(message).toContain('Anthropic · out of extra usage · resets ')
    expect(message).toContain('(in 2h)')
  })
})

// Every Claude-subscription string, pinned exactly. The wall-clock part comes
// from the real formatResetTime so the pin holds in any time zone; the template
// and the countdown around it are what these assertions guard.
describe('Claude subscription limit text', () => {
  const CLOCK_MS = 1_800_000_000_000
  const CLOCK_S = CLOCK_MS / 1000
  const IN_2H14M = CLOCK_S + 2 * 3600 + 14 * 60
  const IN_3D = CLOCK_S + 3 * 24 * 3600
  const LABEL = 'Anthropic'

  let subscriptionType: SubscriptionType | null = null
  let accountInfo: AccountInfo | undefined
  let billingAccess = false
  const spies: Array<{ mockRestore: () => void }> = []

  const at = (resetsAt: number): string => {
    const time = formatResetTime(resetsAt)
    if (time === undefined) throw new Error('formatResetTime returned undefined')
    return time
  }

  const limits = (fields: Partial<ClaudeAILimits>): ClaudeAILimits => ({
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
    ...fields,
  })

  const account = (hasExtraUsageEnabled: boolean): AccountInfo => ({
    accountUuid: 'acct',
    emailAddress: 'user@example.com',
    hasExtraUsageEnabled,
  })

  beforeAll(() => {
    spies.push(
      spyOn(auth, 'getSubscriptionType').mockImplementation(() => subscriptionType),
      spyOn(auth, 'getOauthAccountInfo').mockImplementation(() => accountInfo),
      spyOn(billing, 'hasClaudeAiBillingAccess').mockImplementation(
        () => billingAccess,
      ),
    )
  })

  afterAll(() => {
    for (const spy of spies) spy.mockRestore()
  })

  beforeEach(() => {
    setSystemTime(new Date(CLOCK_MS))
    subscriptionType = null
    accountInfo = undefined
    billingAccess = false
  })

  afterEach(() => {
    setSystemTime()
  })

  describe('claudeWindowLabel', () => {
    test.each([
      ['five_hour', null, 'session'],
      ['seven_day', null, 'weekly'],
      ['seven_day_opus', null, 'weekly Opus'],
      ['seven_day_sonnet', 'max', 'weekly Sonnet'],
      ['seven_day_sonnet', 'pro', 'weekly'],
      ['seven_day_sonnet', 'enterprise', 'weekly'],
      ['overage', null, 'extra usage'],
      [undefined, null, undefined],
    ] as const)('%s (%s) → %s', (type, plan, label) => {
      subscriptionType = plan
      expect(claudeWindowLabel(type)).toBe(label)
    })
  })

  describe('limit reached (rejected)', () => {
    test.each([
      ['five_hour', null, 'session limit'],
      ['seven_day', null, 'weekly limit'],
      ['seven_day_opus', null, 'weekly Opus limit'],
      ['seven_day_sonnet', 'max', 'weekly Sonnet limit'],
      ['seven_day_sonnet', 'team', 'weekly Sonnet limit'],
      ['seven_day_sonnet', 'pro', 'weekly limit'],
      ['seven_day_sonnet', 'enterprise', 'weekly limit'],
      [undefined, null, 'usage limit'],
      ['overage', null, 'usage limit'],
    ] as const)('%s (%s) → %s', (rateLimitType, plan, name) => {
      subscriptionType = plan
      const message = getRateLimitMessage(
        limits({ status: 'rejected', rateLimitType, resetsAt: IN_2H14M }),
        LABEL,
      )
      expect(message).toEqual({
        message: `Anthropic · ${name} reached · resets ${at(IN_2H14M)} (in 2h 14m)`,
        severity: 'error',
      })
    })

    test('a reset more than a day away counts down in days', () => {
      expect(
        getRateLimitErrorMessage(
          limits({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: IN_3D }),
          LABEL,
        ),
      ).toBe(`Anthropic · weekly limit reached · resets ${at(IN_3D)} (in 3d)`)
    })

    test('overage rejected for another reason is the usage limit, with the earlier reset', () => {
      expect(
        getRateLimitErrorMessage(
          limits({
            status: 'rejected',
            rateLimitType: 'five_hour',
            overageStatus: 'rejected',
            overageDisabledReason: 'org_level_disabled',
            resetsAt: IN_3D,
            overageResetsAt: IN_2H14M,
          }),
          LABEL,
        ),
      ).toBe(`Anthropic · usage limit reached · resets ${at(IN_2H14M)} (in 2h 14m)`)
    })

    test('overage rejected with only the subscription reset uses that reset', () => {
      expect(
        getRateLimitErrorMessage(
          limits({ status: 'rejected', overageStatus: 'rejected', resetsAt: IN_2H14M }),
          LABEL,
        ),
      ).toBe(`Anthropic · usage limit reached · resets ${at(IN_2H14M)} (in 2h 14m)`)
    })

    test('out of credits with no reset at all', () => {
      expect(
        getRateLimitErrorMessage(
          limits({
            status: 'rejected',
            overageStatus: 'rejected',
            overageDisabledReason: 'out_of_credits',
          }),
          LABEL,
        ),
      ).toBe('Anthropic · out of extra usage')
    })

    test('getRateLimitWarning never returns the error text', () => {
      expect(
        getRateLimitWarning(limits({ status: 'rejected', rateLimitType: 'five_hour' }), LABEL),
      ).toBeNull()
    })
  })

  describe('overage in use', () => {
    test('approaching the spending limit is a warning', () => {
      const overage = limits({
        status: 'rejected',
        isUsingOverage: true,
        overageStatus: 'allowed_warning',
      })
      expect(getRateLimitMessage(overage, LABEL)).toEqual({
        message: 'Anthropic · close to your extra usage spending limit',
        severity: 'warning',
      })
      expect(getRateLimitWarning(overage, LABEL)).toBe(
        'Anthropic · close to your extra usage spending limit',
      )
      expect(getRateLimitErrorMessage(overage, LABEL)).toBeNull()
    })

    test('overage allowed with no warning shows nothing, even though status is rejected', () => {
      expect(
        getRateLimitMessage(
          limits({ status: 'rejected', isUsingOverage: true, overageStatus: 'allowed' }),
          LABEL,
        ),
      ).toBeNull()
    })
  })

  describe('early warning (allowed_warning)', () => {
    test.each([
      ['five_hour', 'session'],
      ['seven_day', 'weekly'],
      ['seven_day_opus', 'weekly Opus'],
      ['seven_day_sonnet', 'weekly Sonnet'],
      ['overage', 'extra usage'],
    ] as const)('%s with utilization and reset draws the bar', (rateLimitType, name) => {
      expect(
        getRateLimitWarning(
          limits({
            status: 'allowed_warning',
            rateLimitType,
            utilization: 0.929,
            resetsAt: IN_2H14M,
          }),
          LABEL,
        ),
      ).toBe(`Anthropic · ${name} ▰▰▰▰▰▰▰▰▰▱ 92% · resets ${at(IN_2H14M)} (in 2h 14m)`)
    })

    test('utilization without a reset', () => {
      expect(
        getRateLimitWarning(
          limits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 }),
          LABEL,
        ),
      ).toBe('Anthropic · weekly ▰▰▰▰▰▰▰▰▱▱ 80%')
    })

    test('a reset without utilization says "approaching"', () => {
      expect(
        getRateLimitWarning(
          limits({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: IN_3D }),
          LABEL,
        ),
      ).toBe(`Anthropic · approaching session limit · resets ${at(IN_3D)} (in 3d)`)
    })

    test('overage without utilization reads "extra usage limit"', () => {
      expect(
        getRateLimitWarning(
          limits({ status: 'allowed_warning', rateLimitType: 'overage', resetsAt: IN_2H14M }),
          LABEL,
        ),
      ).toBe(`Anthropic · approaching extra usage limit · resets ${at(IN_2H14M)} (in 2h 14m)`)
      expect(
        getRateLimitWarning(
          limits({ status: 'allowed_warning', rateLimitType: 'overage' }),
          LABEL,
        ),
      ).toBe('Anthropic · approaching extra usage limit')
    })

    test('neither utilization nor reset', () => {
      expect(
        getRateLimitWarning(
          limits({ status: 'allowed_warning', rateLimitType: 'seven_day_opus' }),
          LABEL,
        ),
      ).toBe('Anthropic · approaching weekly Opus limit')
    })

    test('no limit type gives no warning', () => {
      expect(
        getRateLimitMessage(limits({ status: 'allowed_warning', utilization: 0.95 }), LABEL),
      ).toBeNull()
    })

    test('below 70% utilization is suppressed, 70% exactly is not', () => {
      expect(
        getRateLimitWarning(
          limits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.69 }),
          LABEL,
        ),
      ).toBeNull()
      expect(
        getRateLimitWarning(
          limits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.7 }),
          LABEL,
        ),
      ).toBe('Anthropic · weekly ▰▰▰▰▰▰▰▱▱▱ 70%')
    })

    test('getRateLimitErrorMessage never returns the warning text', () => {
      expect(
        getRateLimitErrorMessage(
          limits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9 }),
          LABEL,
        ),
      ).toBeNull()
    })

    test('a plain allowed status shows nothing', () => {
      expect(getRateLimitMessage(limits({ rateLimitType: 'seven_day', utilization: 0.99 }), LABEL)).toBeNull()
    })

    test.each([
      ['team', true, false, null],
      ['enterprise', true, false, null],
      ['team', true, true, 'Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 90%'],
      ['team', false, false, 'Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 90%'],
      ['max', true, false, 'Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 90%'],
    ] as const)(
      '%s, extra usage %s, billing access %s → %s',
      (plan, extraUsage, billing, expected) => {
        subscriptionType = plan
        accountInfo = account(extraUsage)
        billingAccess = billing
        expect(
          getRateLimitWarning(
            limits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9 }),
            LABEL,
          ),
        ).toBe(expected)
      },
    )
  })

  describe('getClaudeWarningWindow', () => {
    test('the window a shown warning is about, in percent and ms', () => {
      expect(
        getClaudeWarningWindow(
          limits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.92, resetsAt: IN_3D }),
        ),
      ).toEqual({ key: 'seven_day', label: 'weekly', usedPercent: 92, resetsAtMs: IN_3D * 1000 })
    })

    test('nothing to draw without utilization, below the floor, or outside a warning', () => {
      expect(getClaudeWarningWindow(limits({ status: 'allowed_warning', rateLimitType: 'seven_day' }))).toBeNull()
      expect(
        getClaudeWarningWindow(limits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.5 })),
      ).toBeNull()
      expect(getClaudeWarningWindow(limits({ status: 'rejected', rateLimitType: 'seven_day', utilization: 1 }))).toBeNull()
      expect(
        getClaudeWarningWindow(
          limits({ status: 'allowed_warning', isUsingOverage: true, rateLimitType: 'seven_day', utilization: 0.9 }),
        ),
      ).toBeNull()
    })
  })

  describe('getUsingOverageText', () => {
    test.each([
      ['five_hour', null, 'session'],
      ['seven_day', null, 'weekly'],
      ['seven_day_opus', null, 'weekly Opus'],
      ['seven_day_sonnet', 'max', 'weekly Sonnet'],
      ['seven_day_sonnet', 'pro', 'weekly'],
      ['seven_day_sonnet', 'enterprise', 'weekly'],
    ] as const)('%s (%s) names the %s limit and its reset', (rateLimitType, plan, name) => {
      subscriptionType = plan
      expect(getUsingOverageText(limits({ rateLimitType, resetsAt: IN_2H14M }), LABEL)).toBe(
        `Anthropic · now using extra usage · your ${name} limit · resets ${at(IN_2H14M)} (in 2h 14m)`,
      )
    })

    test('a known limit without a reset drops the suffix', () => {
      expect(getUsingOverageText(limits({ rateLimitType: 'five_hour' }), LABEL)).toBe(
        'Anthropic · now using extra usage',
      )
    })

    test('no limit type, or the overage type, is the short form', () => {
      expect(getUsingOverageText(limits({ resetsAt: IN_2H14M }), LABEL)).toBe(
        'Anthropic · now using extra usage',
      )
      expect(getUsingOverageText(limits({ rateLimitType: 'overage' }), LABEL)).toBe(
        'Anthropic · now using extra usage',
      )
    })
  })

  describe('every Claude message routes to the rate-limit renderer', () => {
    test.each([
      'Anthropic · session limit reached · resets 3pm (in 2h)',
      'Anthropic · weekly Sonnet limit reached',
      'Anthropic · now using extra usage · your weekly limit · resets 3pm',
      'Anthropic · close to your extra usage spending limit',
      'Anthropic · out of extra usage',
      'My Claude Max · usage limit reached',
    ])('%s', text => {
      expect(isRateLimitErrorMessage(text)).toBe(true)
    })

    test.each([
      `You've hit your session limit · resets 3pm (in 2h)`,
      "You've used 92% of your weekly limit",
      "You're now using extra usage",
      "You're close to your extra usage spending limit",
      "You're out of extra usage",
      'Rate limit reached · OpenAI · resets in 2h 14m',
      'Quota exhausted · OpenAI · enable billing for this provider, or switch with /provider',
    ])('a message from before the provider came first still routes: %s', text => {
      expect(isRateLimitErrorMessage(text)).toBe(true)
    })

    test('ordinary text does not', () => {
      expect(isRateLimitErrorMessage('Approaching weekly limit')).toBe(false)
      expect(isRateLimitErrorMessage('Now using extra usage')).toBe(false)
      expect(isRateLimitErrorMessage('I have hit your limit')).toBe(false)
      expect(isRateLimitErrorMessage('Note · the rate limit reached its peak at noon')).toBe(false)
      expect(isRateLimitErrorMessage('Two lines\nAnthropic · weekly limit reached')).toBe(false)
      expect(isRateLimitErrorMessage('Anthropic · weekly limit reached by the team, as planned')).toBe(false)
    })

    test('a profile name is free text: a middle dot or a long name still routes', () => {
      const burst: RateLimitInfo = { kind: 'burst', source: 'none' }
      const dotted = formatProviderLimitMessage(burst, 'OpenRouter · work', NOW)
      expect(dotted).toBe('OpenRouter · work · rate limit reached · no reset time reported')
      expect(isRateLimitErrorMessage(dotted)).toBe(true)
      expect(isRateLimitErrorMessage(formatProviderLimitMessage(burst, 'x'.repeat(81), NOW))).toBe(true)
    })

    test('prose that only looks like one does not', () => {
      expect(isRateLimitErrorMessage('Step 2 · token limit reached')).toBe(false)
      expect(isRateLimitErrorMessage("You've used the wrong flag; try --force")).toBe(false)
    })
  })
})
