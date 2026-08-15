import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { GlobalConfig, ProviderProfile } from 'src/services/config/config.js'

// Capture real modules first so we can spread them and restore at teardown.
// Following CLAUDE.md mock.module rules — never narrow the namespace shape.
// Spread into plain objects so afterAll restores the original bindings, not
// the live ESM namespaces (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/services/config/config.js')) }
const realProviderProfiles = { ...(await import('src/services/api/providerProfiles.js')) }
const realActiveProvider = { ...(await import('src/services/api/activeProvider.js')) }

// Defensive restore: another test file running earlier in the same process
// may have left a partial mock of `activeProvider.js` (e.g. context.test.ts
// stubs `tryGetActiveProvider`). Re-install the real module under both the
// relative and the absolute specifier so this file's `getActiveProvider()`
// resolves to the real implementation regardless of import shape.
const ACTIVE_PROVIDER_ABS_PATH = new URL(
  './activeProvider.ts',
  import.meta.url,
).pathname
mock.module(ACTIVE_PROVIDER_ABS_PATH, () => realActiveProvider)

type ConfigState = {
  globalConfig: GlobalConfig
  activeProfile: ProviderProfile | undefined
}

const state: ConfigState = {
  globalConfig: {} as GlobalConfig,
  activeProfile: undefined,
}

mock.module('src/services/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => state.globalConfig,
}))

// Override `getActiveProviderProfile` directly so we don't depend on the real
// implementation reading providerProfiles[] off the cloned config. Bun's
// `mock.module` is process-global, so other test files running in the same
// process may leak a partial mock of `providerProfiles.js` that drops or
// shadows the real `getActiveProviderProfile` — explicit control here makes
// this file order-independent.
mock.module('src/services/api/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => state.activeProfile,
}))

afterAll(() => {
  mock.module('src/services/config/config.js', () => realConfig)
  mock.module('src/services/api/providerProfiles.js', () => realProviderProfiles)
})

const {
  getActiveProvider,
  invalidateActiveProviderCache,
  ActiveProviderNotConfiguredError,
} = await import('src/services/api/activeProvider.js')
const { transportSendsStrictToolSchemas } = await import('src/services/api/providerConfig.js')

function setProfileState(profiles: ProviderProfile[], activeId?: string): void {
  const id = activeId ?? profiles[0]?.id
  state.globalConfig = {
    providerProfiles: profiles,
    activeProviderProfileId: id,
  } as unknown as GlobalConfig
  state.activeProfile = profiles.find(p => p.id === id) ?? profiles[0]
}

function profile(overrides: Partial<ProviderProfile>): ProviderProfile {
  return {
    id: overrides.id ?? 'p_test',
    name: overrides.name ?? 'Test',
    provider: overrides.provider ?? 'openai',
    baseUrl: overrides.baseUrl ?? 'https://api.example.com/v1',
    model: overrides.model ?? 'gpt-5.4',
    apiKey: overrides.apiKey,
    extras: overrides.extras,
  }
}

beforeEach(() => {
  invalidateActiveProviderCache()
  state.globalConfig = {} as GlobalConfig
})

afterEach(() => {
  invalidateActiveProviderCache()
})

describe('getActiveProvider — transport mapping', () => {
  test('anthropic preset → anthropic transport', () => {
    setProfileState([
      profile({
        id: 'p1',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        apiKey: 'sk-ant',
      }),
    ])
    const r = getActiveProvider()
    expect(r.transport).toBe('anthropic')
    expect(r.baseUrl).toBe('https://api.anthropic.com')
    expect(r.model).toBe('claude-sonnet-4-6')
    expect(r.apiKey).toBe('sk-ant')
  })

  test('gemini preset → gemini transport', () => {
    setProfileState([
      profile({ provider: 'gemini', model: 'gemini-3-flash-preview' }),
    ])
    expect(getActiveProvider().transport).toBe('gemini')
  })

  test('mistral preset → mistral transport', () => {
    setProfileState([
      profile({ provider: 'mistral', model: 'devstral-latest' }),
    ])
    expect(getActiveProvider().transport).toBe('mistral')
  })

  test('bedrock preset → bedrock transport, awsRegion preserved in extras', () => {
    setProfileState([
      profile({
        provider: 'bedrock',
        baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
        model: 'claude-sonnet-4-6',
        extras: { awsRegion: 'us-west-2' },
      }),
    ])
    const r = getActiveProvider()
    expect(r.transport).toBe('bedrock')
    expect(r.extras?.awsRegion).toBe('us-west-2')
  })

  test('vertex preset → vertex transport, gcp metadata preserved', () => {
    setProfileState([
      profile({
        provider: 'vertex',
        model: 'claude-sonnet-4-6',
        extras: { gcpProject: 'my-proj', gcpRegion: 'us-central1' },
      }),
    ])
    const r = getActiveProvider()
    expect(r.transport).toBe('vertex')
    expect(r.extras?.gcpProject).toBe('my-proj')
    expect(r.extras?.gcpRegion).toBe('us-central1')
  })

  test('foundry preset → foundry transport, azureResource preserved', () => {
    setProfileState([
      profile({
        provider: 'foundry',
        model: 'claude-sonnet-4-6',
        extras: { azureResource: 'my-foundry-rg' },
      }),
    ])
    const r = getActiveProvider()
    expect(r.transport).toBe('foundry')
    expect(r.extras?.azureResource).toBe('my-foundry-rg')
  })

  test('openai preset → openai_compat transport (default)', () => {
    setProfileState([
      profile({ provider: 'openai', model: 'gpt-5.4' }),
    ])
    expect(getActiveProvider().transport).toBe('openai_compat')
  })

  test('openai-compat preset (deepseek) → openai_compat transport', () => {
    setProfileState([
      profile({
        provider: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash, deepseek-v4-pro',
      }),
    ])
    const r = getActiveProvider()
    expect(r.transport).toBe('openai_compat')
    // Multi-model field — primary is the first entry.
    expect(r.model).toBe('deepseek-v4-flash')
  })

  test('codex alias model on openai preset → codex_responses transport', () => {
    setProfileState([
      profile({ provider: 'openai', model: 'codexplan' }),
    ])
    expect(getActiveProvider().transport).toBe('codex_responses')
  })

  test('codex alias model (codexspark) → codex_responses transport', () => {
    setProfileState([
      profile({ provider: 'openai', model: 'codexspark' }),
    ])
    expect(getActiveProvider().transport).toBe('codex_responses')
  })

  test('openai preset with extras.githubToken → github_copilot transport', () => {
    setProfileState([
      profile({
        provider: 'openai',
        baseUrl: 'https://models.github.ai/inference',
        model: 'github:copilot',
        extras: { githubToken: 'ghp_xxx' },
      }),
    ])
    expect(getActiveProvider().transport).toBe('github_copilot')
  })

  test('githubToken takes precedence over codex alias on openai provider', () => {
    setProfileState([
      profile({
        provider: 'openai',
        model: 'codexplan',
        extras: { githubToken: 'ghp_xxx' },
      }),
    ])
    expect(getActiveProvider().transport).toBe('github_copilot')
  })
})

describe('getActiveProvider — fallback', () => {
  test('throws ActiveProviderNotConfiguredError when no profile', () => {
    setProfileState([])
    expect(() => getActiveProvider()).toThrow(ActiveProviderNotConfiguredError)
  })
})

describe('getActiveProvider — caching', () => {
  test('returns cached value on repeated calls without invalidation', () => {
    setProfileState([
      profile({ id: 'p1', provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    ])
    const a = getActiveProvider()
    const b = getActiveProvider()
    expect(a).toBe(b)
  })

  test('invalidateActiveProviderCache forces re-resolution', () => {
    setProfileState([
      profile({ id: 'p1', provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    ])
    const a = getActiveProvider()
    setProfileState([
      profile({ id: 'p2', provider: 'gemini', model: 'gemini-3-flash-preview' }),
    ])
    // Without invalidation we still see the cached anthropic resolution.
    expect(getActiveProvider()).toBe(a)
    invalidateActiveProviderCache()
    const b = getActiveProvider()
    expect(b.transport).toBe('gemini')
    expect(b).not.toBe(a)
  })
})

// Lives here rather than beside `resolveProviderRequest` because the answer
// depends on the ACTIVE PROFILE, and this file owns the profile-state fixtures.
describe('transportSendsStrictToolSchemas', () => {
  test('a codex alias sends strict tools', () => {
    setProfileState([
      profile({ id: 'p1', provider: 'openai', model: 'codexplan', baseUrl: '' }),
    ])
    expect(transportSendsStrictToolSchemas('codexplan')).toBe(true)
  })

  test('anthropic and plain OpenAI-compatible profiles do not', () => {
    setProfileState([
      profile({ id: 'p1', provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    ])
    expect(transportSendsStrictToolSchemas('claude-sonnet-4-6')).toBe(false)

    invalidateActiveProviderCache()
    setProfileState([profile({ id: 'p2', provider: 'openai', model: 'gpt-4o' })])
    expect(transportSendsStrictToolSchemas('gpt-4o')).toBe(false)
  })

  test('a GitHub profile counts even on a model that resolves to chat_completions', () => {
    // The 400-fallback in openaiShim's messagesClient re-sends the SAME tools
    // through /responses — with the strict conversion — when Copilot answers
    // "/chat/completions not accessible". That retry never reaches the
    // resolver, so gating on `transport === 'codex_responses'` alone would let
    // the model's legal `null` through to zod on every GitHub endpoint type.
    setProfileState([
      profile({
        id: 'p1',
        provider: 'openai',
        baseUrl: 'https://models.github.ai/inference',
        model: 'gpt-4o',
        extras: { githubToken: 'ghp_xxx' },
      }),
    ])
    expect(transportSendsStrictToolSchemas('gpt-4o')).toBe(true)
  })

  test('the request model wins over the profile model', () => {
    // `/model`, a sub-agent override and --fallback-model all change the model
    // without touching the profile.
    setProfileState([
      profile({ id: 'p1', provider: 'openai', model: 'gpt-4o', baseUrl: '' }),
    ])
    expect(transportSendsStrictToolSchemas('gpt-4o')).toBe(false)
    expect(transportSendsStrictToolSchemas('codexplan')).toBe(true)
  })

  test('no configured profile → false', () => {
    state.globalConfig = {} as GlobalConfig
    state.activeProfile = undefined
    invalidateActiveProviderCache()
    expect(transportSendsStrictToolSchemas('gpt-4o')).toBe(false)
  })
})
