import { afterAll, expect, mock, test } from 'bun:test'

const realSettings = { ...(await import('src/platform/settings/settings.js')) }
const realAuth = { ...(await import('src/providers/auth/auth.js')) }
const realThinking = { ...(await import('src/agent/context/thinking.js')) }
const realGrowthbook = { ...(await import('src/platform/analytics/growthbook.js')) }
const realProviders = { ...(await import('src/utils/model/providers.js')) }

afterAll(() => {
  mock.module('src/platform/settings/settings.js', () => realSettings)
  mock.module('src/providers/auth/auth.js', () => realAuth)
  mock.module('src/agent/context/thinking.js', () => realThinking)
  mock.module('src/platform/analytics/growthbook.js', () => realGrowthbook)
  mock.module('src/utils/model/providers.js', () => realProviders)
})

async function importFreshEffortModule(options: {
  codingLoopXhighDefault?: boolean
  isPro?: boolean
  isMax?: boolean
  isTeam?: boolean
  greyStep2Enabled?: boolean
  ultrathink?: boolean
  provider?: string
}) {
  mock.module('src/platform/settings/settings.js', () => ({
    getInitialSettings: () => ({
      codingLoopXhighDefault: options.codingLoopXhighDefault,
    }),
  }))
  mock.module('src/providers/auth/auth.js', () => ({
    isProSubscriber: () => options.isPro ?? false,
    isMaxSubscriber: () => options.isMax ?? false,
    isTeamSubscriber: () => options.isTeam ?? false,
  }))
  mock.module('src/agent/context/thinking.js', () => ({
    isUltrathinkEnabled: () => options.ultrathink ?? false,
  }))
  mock.module('src/platform/analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: () => ({
      enabled: options.greyStep2Enabled ?? false,
    }),
  }))
  mock.module('src/utils/model/providers.js', () => ({
    getAPIProvider: () => options.provider ?? 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => true,
  }))

  return import(`./effort.js?ts=${Date.now()}-${Math.random()}`)
}

test('Opus 4.8 with setting on returns xhigh, overriding the Pro medium default', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isPro: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('xhigh')
})

test('Opus 4.8 with setting on overrides the Max/Team medium default', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isMax: true,
    greyStep2Enabled: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('xhigh')
})

test('Opus 4.8 with setting on overrides the ultrathink medium default', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    ultrathink: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('xhigh')
})

test('Opus 4.8 with setting off defaults to high on Anthropic, overriding the Pro medium', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: false,
    isPro: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('high')
})

test('Opus 4.8 with setting absent defaults to high on Anthropic for non-subscriber', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({})
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('high')
})

test('Opus 4.8 off the Anthropic provider keeps the upstream medium for Pro', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    isPro: true,
    provider: 'bedrock',
  })
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('medium')
})

test('Fable 5 defaults to high on Anthropic', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({})
  expect(getDefaultEffortForModel('claude-fable-5')).toBe('high')
})

test('Fable 5 high default overrides the ultrathink medium fallback', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    ultrathink: true,
  })
  expect(getDefaultEffortForModel('claude-fable-5')).toBe('high')
})

test('Fable 5 off the Anthropic provider keeps the ultrathink medium fallback', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    ultrathink: true,
    provider: 'bedrock',
  })
  expect(getDefaultEffortForModel('claude-fable-5')).toBe('medium')
})

test('Opus 4.7 with setting on is unchanged (never xhigh)', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isPro: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-7')).toBe('medium')
})

test('Opus 4.7 with no subscription defaults to medium on Anthropic', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-7')).toBe('medium')
})

test('Sonnet 4.6 defaults to medium on Anthropic regardless of subscription', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isPro: true,
  })
  expect(getDefaultEffortForModel('claude-sonnet-4-6')).toBe('medium')
})

test('Opus 4.7 off the Anthropic provider keeps the upstream undefined for non-subscribers', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    provider: 'bedrock',
  })
  expect(getDefaultEffortForModel('claude-opus-4-7')).toBeUndefined()
})

test('Sonnet 4.6 off the Anthropic provider stays undefined without ultrathink', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    provider: 'bedrock',
  })
  expect(getDefaultEffortForModel('claude-sonnet-4-6')).toBeUndefined()
})

test('unknown/future first-party model keeps undefined (→high), not medium', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({})
  // modelSupportsEffort is true for unknown 1P strings; the medium branch must
  // match by explicit name so a future flagship is not silently lowered to
  // medium (DRI-protected default).
  expect(getDefaultEffortForModel('claude-future-9')).toBeUndefined()
})

test('resolveAppliedEffort keeps xhigh for Opus 4.8 (no clamp to high)', async () => {
  const { resolveAppliedEffort } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isPro: true,
  })
  expect(resolveAppliedEffort('claude-opus-4-8', undefined)).toBe('xhigh')
})
