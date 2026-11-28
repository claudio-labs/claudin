/**
 * `get3PModelCapabilityOverride` lets a third-party deployment declare what a
 * pinned ANTHROPIC_DEFAULT_*_MODEL supports. The active provider is switched
 * through the real resolver: under `bun test` the global config lives in
 * memory, so the profile written here is the one tryGetActiveProvider
 * resolves. No module is mocked.
 *
 * The memo key is model + capability only, so every test clears it: a switch
 * of provider or env would otherwise be answered from the previous test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { get3PModelCapabilityOverride } from 'src/providers/model/modelSupportOverrides.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'

const ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

const BEDROCK: ProviderProfile = {
  id: 'overrides-bedrock',
  name: 'Bedrock',
  provider: 'bedrock',
  baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  model: 'us.anthropic.claude-opus-4-6-v1',
}

const ANTHROPIC: ProviderProfile = {
  id: 'overrides-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-6',
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  get3PModelCapabilityOverride.cache.clear?.()
  useProfile(BEDROCK)
})

afterEach(() => {
  get3PModelCapabilityOverride.cache.clear?.()
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('get3PModelCapabilityOverride', () => {
  test('the first-party API ignores the override env entirely', () => {
    useProfile(ANTHROPIC)
    expect(getAPIProvider()).toBe('firstParty')
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort,thinking'

    expect(get3PModelCapabilityOverride('claude-opus-4-6', 'effort')).toBeUndefined()
  })

  test('a pinned model reports the listed capabilities, case- and space-insensitively', () => {
    expect(getAPIProvider()).toBe('bedrock')
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'Us.Anthropic.Claude-Opus-4-6-v1'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = ' Effort , ADAPTIVE_THINKING'

    expect(get3PModelCapabilityOverride('us.anthropic.claude-opus-4-6-v1', 'effort')).toBe(true)
    expect(get3PModelCapabilityOverride('US.ANTHROPIC.CLAUDE-OPUS-4-6-V1', 'adaptive_thinking')).toBe(true)
  })

  test('a capability the pinned model does not list is false, not undefined', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'my-opus'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'

    expect(get3PModelCapabilityOverride('my-opus', 'max_effort')).toBe(false)
    expect(get3PModelCapabilityOverride('my-opus', 'interleaved_thinking')).toBe(false)
  })

  test('an empty capability list declares the model supports none of them', () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'my-haiku'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = ''

    expect(get3PModelCapabilityOverride('my-haiku', 'thinking')).toBe(false)
  })

  test('a pinned model without a capability list has no override', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'my-sonnet'

    expect(get3PModelCapabilityOverride('my-sonnet', 'thinking')).toBeUndefined()
  })

  test('a model no tier pins has no override', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'my-opus'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'

    expect(get3PModelCapabilityOverride('some-other-model', 'effort')).toBeUndefined()
  })

  test('each tier is consulted: sonnet and haiku pins answer for their own model', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'my-opus'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'my-sonnet'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'my-haiku'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = 'interleaved_thinking'

    expect(get3PModelCapabilityOverride('my-sonnet', 'thinking')).toBe(true)
    expect(get3PModelCapabilityOverride('my-sonnet', 'effort')).toBe(false)
    expect(get3PModelCapabilityOverride('my-haiku', 'interleaved_thinking')).toBe(true)
  })

  test('a capability list with no pinned model is skipped for the next tier', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'shared-model'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'thinking'

    expect(get3PModelCapabilityOverride('shared-model', 'effort')).toBe(false)
    expect(get3PModelCapabilityOverride('shared-model', 'thinking')).toBe(true)
  })

  test('when two tiers pin the same model, the first tier (opus) decides', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'shared-model'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'shared-model'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'thinking'

    expect(get3PModelCapabilityOverride('shared-model', 'effort')).toBe(true)
    expect(get3PModelCapabilityOverride('shared-model', 'thinking')).toBe(false)
  })
})
