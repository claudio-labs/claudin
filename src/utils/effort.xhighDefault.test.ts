import { afterAll, expect, mock, test } from 'bun:test'

const realSettings = { ...(await import('./settings/settings.js')) }
const realAuth = { ...(await import('./auth.js')) }
const realThinking = { ...(await import('./thinking.js')) }
const realGrowthbook = { ...(await import('../services/analytics/growthbook.js')) }
const realProviders = { ...(await import('./model/providers.js')) }

afterAll(() => {
  mock.module('./settings/settings.js', () => realSettings)
  mock.module('./auth.js', () => realAuth)
  mock.module('./thinking.js', () => realThinking)
  mock.module('../services/analytics/growthbook.js', () => realGrowthbook)
  mock.module('./model/providers.js', () => realProviders)
})

async function importFreshEffortModule(options: {
  codingLoopXhighDefault?: boolean
  isPro?: boolean
  isMax?: boolean
  isTeam?: boolean
  greyStep2Enabled?: boolean
  ultrathink?: boolean
}) {
  mock.module('./settings/settings.js', () => ({
    getInitialSettings: () => ({
      codingLoopXhighDefault: options.codingLoopXhighDefault,
    }),
  }))
  mock.module('./auth.js', () => ({
    isProSubscriber: () => options.isPro ?? false,
    isMaxSubscriber: () => options.isMax ?? false,
    isTeamSubscriber: () => options.isTeam ?? false,
  }))
  mock.module('./thinking.js', () => ({
    isUltrathinkEnabled: () => options.ultrathink ?? false,
  }))
  mock.module('../services/analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: () => ({
      enabled: options.greyStep2Enabled ?? false,
    }),
  }))
  mock.module('./model/providers.js', () => ({
    getAPIProvider: () => 'anthropic',
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

test('Opus 4.8 with setting off keeps current behavior (medium for Pro)', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: false,
    isPro: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('medium')
})

test('Opus 4.8 with setting absent keeps current behavior (undefined for non-subscriber)', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({})
  expect(getDefaultEffortForModel('claude-opus-4-8')).toBeUndefined()
})

test('Opus 4.7 with setting on is unchanged (never xhigh)', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isPro: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-7')).toBe('medium')
})

test('Opus 4.7 with setting on and no subscription stays undefined', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
  })
  expect(getDefaultEffortForModel('claude-opus-4-7')).toBeUndefined()
})

test('non-Opus model with setting on is unaffected', async () => {
  const { getDefaultEffortForModel } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isPro: true,
  })
  expect(getDefaultEffortForModel('claude-sonnet-4-6')).toBeUndefined()
})

test('resolveAppliedEffort keeps xhigh for Opus 4.8 (no clamp to high)', async () => {
  const { resolveAppliedEffort } = await importFreshEffortModule({
    codingLoopXhighDefault: true,
    isPro: true,
  })
  expect(resolveAppliedEffort('claude-opus-4-8', undefined)).toBe('xhigh')
})
