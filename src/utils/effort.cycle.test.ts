import { afterAll, afterEach, expect, mock, test } from 'bun:test'

const realSettings = { ...(await import('src/platform/settings/settings.js')) }
const realAuth = { ...(await import('src/services/auth/auth.js')) }
const realThinking = { ...(await import('src/services/context/thinking.js')) }
const realGrowthbook = { ...(await import('src/platform/analytics/growthbook.js')) }
const realProviders = { ...(await import('src/utils/model/providers.js')) }

afterAll(() => {
  mock.module('src/platform/settings/settings.js', () => realSettings)
  mock.module('src/services/auth/auth.js', () => realAuth)
  mock.module('src/services/context/thinking.js', () => realThinking)
  mock.module('src/platform/analytics/growthbook.js', () => realGrowthbook)
  mock.module('src/utils/model/providers.js', () => realProviders)
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
})

async function importFreshEffortModule(options: {
  provider?: string
} = {}) {
  mock.module('src/platform/settings/settings.js', () => ({
    getInitialSettings: () => ({}),
  }))
  mock.module('src/services/auth/auth.js', () => ({
    isProSubscriber: () => false,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
  }))
  mock.module('src/services/context/thinking.js', () => ({
    isUltrathinkEnabled: () => false,
  }))
  mock.module('src/platform/analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: () => ({ enabled: false }),
  }))
  mock.module('src/utils/model/providers.js', () => ({
    getAPIProvider: () => options.provider ?? 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => true,
  }))

  return import(`./effort.js?ts=${Date.now()}-${Math.random()}`)
}

test('Opus 4.8 steps high → xhigh (xhigh is in the cycle)', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  expect(cycleEffortForModel('high', 'claude-opus-4-8', 'right')).toBe('xhigh')
})

test('Opus 4.8 steps xhigh → max', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  expect(cycleEffortForModel('xhigh', 'claude-opus-4-8', 'right')).toBe('max')
})

test('non-xhigh model (Sonnet 4.6) wraps high → low going right', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  expect(cycleEffortForModel('high', 'claude-sonnet-4-6', 'right')).toBe('low')
})

test('non-xhigh model (Sonnet 4.6) wraps low → high going left', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  expect(cycleEffortForModel('low', 'claude-sonnet-4-6', 'left')).toBe('high')
})

test('undefined current starts from the model default (Opus 4.8 → high), right → xhigh', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  expect(cycleEffortForModel(undefined, 'claude-opus-4-8', 'right')).toBe('xhigh')
})

test('adaptive current leaves adaptive, starting from the default level', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  // default is high → left → medium (a concrete level, not adaptive)
  expect(cycleEffortForModel('adaptive', 'claude-opus-4-8', 'left')).toBe('medium')
})

test('out-of-range current (max on a non-max model) starts from default', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  // sonnet has no 'max'; current 'max' is ignored → firstParty default medium → right → high
  expect(cycleEffortForModel('max', 'claude-sonnet-4-6', 'right')).toBe('high')
})

test('numeric session effort is bucketed, so cycling steps from that bucket', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  // 30 buckets to 'low' on Opus 4.8 (low/medium/high/xhigh/max) → right → medium
  expect(cycleEffortForModel(30, 'claude-opus-4-8', 'right')).toBe('medium')
  // 30 → 'low' → left wraps to the top of the range (max)
  expect(cycleEffortForModel(30, 'claude-opus-4-8', 'left')).toBe('max')
})

test('numeric session effort respects the model-specific level list', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  // 95 buckets to 'high'; Sonnet has only low/medium/high → right wraps to low
  expect(cycleEffortForModel(95, 'claude-sonnet-4-6', 'right')).toBe('low')
})

test('model without effort support returns undefined (no-op signal)', async () => {
  const { cycleEffortForModel } = await importFreshEffortModule()
  expect(cycleEffortForModel('high', 'claude-haiku-4-5', 'right')).toBeUndefined()
})

test('OpenAI provider cycles the OpenAI effort family, wrapping at xhigh', async () => {
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  const { cycleEffortForModel } = await importFreshEffortModule({ provider: 'openai' })
  expect(cycleEffortForModel('high', 'gpt-5', 'right')).toBe('xhigh')
  expect(cycleEffortForModel('xhigh', 'gpt-5', 'right')).toBe('low')
})

test('effortEnvOverrideConflictsWith: unset env never conflicts', async () => {
  const { effortEnvOverrideConflictsWith } = await importFreshEffortModule()
  expect(effortEnvOverrideConflictsWith('high')).toBe(false)
})

test('effortEnvOverrideConflictsWith: auto/unset env overrides any concrete pick', async () => {
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
  const { effortEnvOverrideConflictsWith } = await importFreshEffortModule()
  // env=auto forces adaptive at resolve time, so it overrides the user's level.
  expect(effortEnvOverrideConflictsWith('high')).toBe(true)
})

test('effortEnvOverrideConflictsWith: pinned env matching the bucket is not a conflict', async () => {
  process.env.CLAUDE_CODE_EFFORT_LEVEL = '30' // buckets to 'low'
  const { effortEnvOverrideConflictsWith } = await importFreshEffortModule()
  expect(effortEnvOverrideConflictsWith('low')).toBe(false)
  expect(effortEnvOverrideConflictsWith('high')).toBe(true)
})

test('effortEnvOverrideConflictsWith: pinned level env conflicts only on a different level', async () => {
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'low'
  const { effortEnvOverrideConflictsWith } = await importFreshEffortModule()
  expect(effortEnvOverrideConflictsWith('low')).toBe(false)
  expect(effortEnvOverrideConflictsWith('high')).toBe(true)
})
