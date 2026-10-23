import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import * as auth from 'src/providers/auth/auth.js'
import { emitStatusChange, type ClaudeAILimits } from 'src/providers/claudeAiLimits.js'
import { recordCodexLimits, resetCodexLimitsForTesting } from 'src/providers/codexLimits.js'
import type { OAuthTokens } from 'src/providers/oauth/types.js'
import type { ResolvedProvider } from 'src/providers/presets/activeProvider.js'
import { DEFAULT_CODEX_BASE_URL, DEFAULT_OPENAI_BASE_URL } from 'src/providers/presets/providerConfig.js'
import * as billing from 'src/providers/usage/billing.js'
import * as codexUsage from 'src/providers/usage/codexUsage.js'
import * as minimaxUsage from 'src/providers/usage/minimaxUsage.js'
import {
  buildClaudeLimitRows,
  SUBSCRIPTION_LIMITS_UNAVAILABLE,
  SUBSCRIPTION_LOGIN_EXPIRED,
  getLimitsFetcher,
  getLiveLimits,
} from 'src/providers/usage/providerLimits.js'
import * as usage from 'src/providers/usage/usage.js'

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function tokensWith(subscriptionType: string | null): OAuthTokens {
  return {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: null,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType,
    rateLimitTier: null,
  } as OAuthTokens
}

function profile(partial: Partial<ResolvedProvider>): ResolvedProvider {
  return { transport: 'openai_compat', baseUrl: '', model: 'm', name: 'P', ...partial }
}

describe('buildClaudeLimitRows', () => {
  const util: usage.Utilization = {
    five_hour: { utilization: 6, resets_at: '2026-10-22T16:00:00Z' },
    seven_day: { utilization: 29, resets_at: null },
    seven_day_sonnet: { utilization: 12, resets_at: null },
  }

  test.each([
    ['max', true],
    ['team', true],
    [null, true],
    ['pro', false],
    ['enterprise', false],
  ] as const)('%s plan shows the Sonnet week: %s', (plan, sonnet) => {
    const labels = buildClaudeLimitRows(util, plan).map(r => r.label)
    expect(labels).toEqual([
      'Current session',
      'Current week (all models)',
      ...(sonnet ? ['Current week (Sonnet only)'] : []),
    ])
  })

  test('a window without utilization is skipped; resets_at becomes resetsAt', () => {
    const rows = buildClaudeLimitRows(
      { five_hour: { utilization: null, resets_at: null }, seven_day: util.five_hour },
      'pro',
    )
    expect(rows).toEqual([
      { kind: 'window', label: 'Current week (all models)', usedPercent: 6, resetsAt: '2026-10-22T16:00:00Z' },
    ])
  })

  test('extra usage, when enabled with a limit, is a row with what was spent', () => {
    const rows = buildClaudeLimitRows(
      { extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 550, utilization: 27.5 } },
      'max',
    )
    expect(rows).toEqual([
      { kind: 'window', label: 'Extra usage', usedPercent: 27.5, extraSubtext: '$5.50 / $20.00 spent' },
    ])
  })

  test('extra usage that is disabled or unlimited is not shown', () => {
    expect(
      buildClaudeLimitRows({ extra_usage: { is_enabled: false, monthly_limit: 1, used_credits: 1, utilization: 1 } }, 'max'),
    ).toEqual([])
    expect(
      buildClaudeLimitRows({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 1, utilization: 1 } }, 'max'),
    ).toEqual([])
  })
})

describe('getLimitsFetcher', () => {
  test('only the providers that report a limit have one', () => {
    expect(getLimitsFetcher('firstParty')).toBeDefined()
    expect(getLimitsFetcher('codex')).toBeDefined()
    expect(getLimitsFetcher('minimax')).toBeDefined()
    for (const kind of ['openai', 'gemini', 'github', 'mistral', 'nvidia-nim', 'bedrock', 'vertex', 'foundry'] as const) {
      expect(getLimitsFetcher(kind)).toBeUndefined()
    }
  })

  test('Claude: the stored login plan, capitalized, with its rows', async () => {
    spies.push(
      spyOn(usage, 'fetchUtilization').mockResolvedValue({ five_hour: { utilization: 6, resets_at: null } }),
      spyOn(auth, 'getClaudeAIOAuthTokens').mockImplementation((() => tokensWith('max')) as typeof auth.getClaudeAIOAuthTokens),
    )
    const limits = await getLimitsFetcher('firstParty')!(profile({ transport: 'anthropic' }))
    expect(limits.plan).toBe('Max')
    expect(limits.rows.map(r => r.label)).toEqual(['Current session'])
    expect(limits.message).toBeUndefined()
  })

  test('Claude: no subscription login → the explanation instead of rows', async () => {
    spies.push(
      spyOn(usage, 'fetchUtilization').mockResolvedValue({}),
      spyOn(auth, 'getClaudeAIOAuthTokens').mockImplementation((() => null) as typeof auth.getClaudeAIOAuthTokens),
    )
    const limits = await getLimitsFetcher('firstParty')!(profile({ transport: 'anthropic' }))
    expect(limits).toEqual({ plan: undefined, rows: [], message: SUBSCRIPTION_LIMITS_UNAVAILABLE })
  })

  test('Claude: an expired login that would not refresh says so', async () => {
    spies.push(spyOn(usage, 'fetchUtilization').mockResolvedValue(null))
    const limits = await getLimitsFetcher('firstParty')!(profile({ transport: 'anthropic' }))
    expect(limits).toEqual({ rows: [], message: SUBSCRIPTION_LOGIN_EXPIRED })
  })

  test("Codex: asks with the profile's own base URL", async () => {
    const fetchSpy = spyOn(codexUsage, 'fetchCodexUsage').mockResolvedValue({
      planType: 'plus',
      snapshots: [{ limitName: 'codex', primary: { usedPercent: 40, windowMinutes: 300 } }],
    })
    spies.push(fetchSpy)
    const codexProfile = profile({ transport: 'codex_responses', baseUrl: 'https://chatgpt.com/backend-api/codex' })
    const limits = await getLimitsFetcher('codex')!(codexProfile)
    // The profile goes too: its credentials are the ones that ask.
    expect(fetchSpy).toHaveBeenCalledWith({ baseUrl: 'https://chatgpt.com/backend-api/codex', profile: codexProfile })
    expect(limits.plan).toBe('Plus')
    expect(limits.rows[0]).toMatchObject({ kind: 'window', usedPercent: 40 })
  })

  test.each([DEFAULT_OPENAI_BASE_URL, `${DEFAULT_OPENAI_BASE_URL}/`, ''])(
    'Codex: a codexplan profile left on %j asks the Codex backend, where its requests go',
    async baseUrl => {
      const fetchSpy = spyOn(codexUsage, 'fetchCodexUsage').mockResolvedValue({ snapshots: [] })
      spies.push(fetchSpy)
      await getLimitsFetcher('codex')!(profile({ transport: 'codex_responses', baseUrl, model: 'codexplan' }))
      expect(fetchSpy.mock.calls[0]?.[0]).toMatchObject({ baseUrl: DEFAULT_CODEX_BASE_URL })
    },
  )

  test("MiniMax: asks with the profile's own key and base URL; unavailable keeps its message", async () => {
    const fetchSpy = spyOn(minimaxUsage, 'fetchMiniMaxUsage').mockResolvedValue({
      availability: 'unknown',
      snapshots: [],
      message: 'not on this plan',
    })
    spies.push(fetchSpy)
    const limits = await getLimitsFetcher('minimax')!(
      profile({ apiKey: 'k', baseUrl: 'https://api.minimax.io/v1' }),
    )
    expect(fetchSpy).toHaveBeenCalledWith({ apiKey: 'k', baseUrl: 'https://api.minimax.io/v1' })
    expect(limits).toEqual({ plan: undefined, rows: [], message: 'not on this plan' })
  })
})

describe('getLiveLimits', () => {
  const NOW = Date.UTC(2026, 9, 22, 12)
  const quiet: ClaudeAILimits = { status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }
  afterEach(() => {
    emitStatusChange(quiet)
    resetCodexLimitsForTesting()
  })

  test('only the providers whose responses carry their limits have a live source', () => {
    expect(getLiveLimits('firstParty')).toBeDefined()
    expect(getLiveLimits('codex')).toBeDefined()
    for (const kind of ['minimax', 'openai', 'gemini', 'github', 'bedrock'] as const) {
      expect(getLiveLimits(kind)).toBeUndefined()
    }
  })

  test('Claude: a shown warning is announced once per window and threshold, and stands', () => {
    spies.push(spyOn(auth, 'getSubscriptionType').mockReturnValue('max'))
    const live = getLiveLimits('firstParty')!
    let calls = 0
    const unsubscribe = live.subscribe(() => calls++)
    const resetsAt = NOW / 1000 + 3600
    emitStatusChange({ ...quiet, status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.92, resetsAt, surpassedThreshold: 0.9 })
    expect(calls).toBe(1)
    unsubscribe()

    const first = live.read('Anthropic', NOW)
    expect(first.announcement?.text).toStartWith('Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 92% · resets ')
    expect(first.standing).toBe('Anthropic weekly 92%')
    expect(first.overage).toBeUndefined()

    emitStatusChange({ ...quiet, status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.95, resetsAt, surpassedThreshold: 0.9 })
    const again = live.read('Anthropic', NOW)
    expect(again.announcement?.id).toBe(first.announcement?.id)
    expect(again.standing).toBe('Anthropic weekly 95%')

    // Past its reset the window no longer stands.
    expect(live.read('Anthropic', resetsAt * 1000 + 1).standing).toBeUndefined()
  })

  test('Claude: a reached limit keeps standing in the footer until it resets', () => {
    spies.push(spyOn(auth, 'getSubscriptionType').mockReturnValue('max'))
    const live = getLiveLimits('firstParty')!
    const resetsAt = NOW / 1000 + 3600
    emitStatusChange({ ...quiet, status: 'rejected', rateLimitType: 'seven_day', resetsAt })
    const reading = live.read('Anthropic', NOW)
    // The limit-reached line is the transcript's; no toast, but the footer stays.
    expect(reading.announcement).toBeUndefined()
    expect(reading.standing).toBe('Anthropic weekly 100%')
    expect(live.read('Anthropic', resetsAt * 1000 + 1).standing).toBeUndefined()

    // Rolled into extra usage: the footer's own "Now using extra usage" says it.
    emitStatusChange({ ...quiet, status: 'rejected', isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'seven_day', resetsAt })
    expect(live.read('Anthropic', NOW).standing).toBeUndefined()
  })

  test('Claude: overage is announced, except to non-billing Team/Enterprise', () => {
    const live = getLiveLimits('firstParty')!
    emitStatusChange({ ...quiet, status: 'rejected', isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'five_hour' })
    spies.push(spyOn(auth, 'getSubscriptionType').mockReturnValue('max'))
    expect(live.read('Anthropic', NOW).overage).toBe('Anthropic · now using extra usage')
    spies.splice(0).forEach(s => s.mockRestore())
    spies.push(
      spyOn(auth, 'getSubscriptionType').mockReturnValue('team'),
      spyOn(billing, 'hasClaudeAiBillingAccess').mockReturnValue(false),
    )
    expect(live.read('Anthropic', NOW).overage).toBeUndefined()
  })

  test('Codex: nothing before a response; a crossed threshold after', () => {
    const live = getLiveLimits('codex')!
    expect(live.read('Codex OAuth', NOW)).toEqual({})
    recordCodexLimits({
      snapshots: [{ limitName: 'codex', primary: { usedPercent: 78, windowMinutes: 300 } }],
    })
    const reading = live.read('Codex OAuth', NOW)
    expect(reading.announcement?.text).toBe('Codex OAuth · 5h ▰▰▰▰▰▰▰▰▱▱ 78%')
    expect(reading.standing).toBe('Codex OAuth 5h 78%')
  })
})
