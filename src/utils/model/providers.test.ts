import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import type { GlobalConfig, ProviderProfile } from '../config.js'
import type { ResolvedProvider } from '../../services/api/activeProvider.js'

let mockProviderProfile: ProviderProfile | null = null

// Spread into plain objects so afterAll restores the original bindings, not
// the live ESM namespaces (which mock.module mutates after the fact).
const realConfig = { ...(await import('../config.js')) }
const realProviderProfiles = { ...(await import('../providerProfiles.js')) }

mock.module('../config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    providerProfiles: mockProviderProfile ? [mockProviderProfile] : [],
    activeProviderProfileId: mockProviderProfile?.id,
  } as unknown as GlobalConfig),
}))

mock.module('../providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => mockProviderProfile ?? undefined,
}))

afterAll(() => {
  mock.module('../config.js', () => realConfig)
  mock.module('../providerProfiles.js', () => realProviderProfiles)
})

import { invalidateActiveProviderCache } from '../../services/api/activeProvider.js'

afterEach(() => {
  mockProviderProfile = null
  invalidateActiveProviderCache()
})

async function importFreshProvidersModule() {
  return import(`./providers.js?ts=${Date.now()}-${Math.random()}`)
}

function setProfile(profile: Partial<ResolvedProvider>): void {
  // Convert ResolvedProvider-shape input to ProviderProfile shape that
  // getActiveProviderProfile would return. github_copilot/codex_responses
  // resolve from provider:'openai' + extras.githubToken (or codex alias).
  const transport = profile.transport ?? 'anthropic'
  const providerKind: ProviderProfile['provider'] =
    transport === 'gemini'
      ? 'gemini'
      : transport === 'mistral'
        ? 'mistral'
        : transport === 'bedrock'
          ? 'bedrock'
          : transport === 'vertex'
            ? 'vertex'
            : transport === 'foundry'
              ? 'foundry'
              : transport === 'anthropic'
                ? 'anthropic'
                : 'openai'
  const extras: ProviderProfile['extras'] = {
    ...(profile.extras ?? {}),
    ...(transport === 'github_copilot' ? { githubToken: 'gh-test' } : {}),
  }
  mockProviderProfile = {
    id: 'test-profile',
    name: 'Test',
    provider: providerKind,
    baseUrl: profile.baseUrl ?? 'https://api.anthropic.com',
    model: profile.model ?? 'claude-sonnet-4-6',
    apiKey: profile.apiKey,
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  } as ProviderProfile
  invalidateActiveProviderCache()
}

test('first-party provider keeps Anthropic account setup flow enabled', async () => {
  setProfile({ transport: 'anthropic' })
  const { getAPIProvider, usesAnthropicAccountFlow } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('firstParty')
  expect(usesAnthropicAccountFlow()).toBe(true)
})

test.each([
  ['openai_compat', 'https://api.openai.com/v1', 'openai'],
  ['github_copilot', 'https://api.githubcopilot.com', 'github'],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini'],
  ['bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'bedrock'],
  ['vertex', 'https://us-central1-aiplatform.googleapis.com', 'vertex'],
  ['foundry', 'https://example.services.ai.azure.com', 'foundry'],
] as const)(
  '%s transport disables Anthropic account setup flow',
  async (transport, baseUrl, expected) => {
    setProfile({ transport, baseUrl })
    const { getAPIProvider, usesAnthropicAccountFlow } =
      await importFreshProvidersModule()

    expect(getAPIProvider()).toBe(expected)
    expect(usesAnthropicAccountFlow()).toBe(false)
  },
)

test('explicit local openai-compatible base URLs stay on the openai provider', async () => {
  setProfile({
    transport: 'openai_compat',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'gpt-5.4',
  })

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('openai')
})

test('codex transport resolves to the codex provider', async () => {
  setProfile({
    transport: 'codex_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
  })

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('codex')
})

test('official OpenAI base URLs keep provider detection on openai for aliases', async () => {
  setProfile({
    transport: 'openai_compat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
  })

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('openai')
})

test('isGithubNativeAnthropicMode: false when transport is not github_copilot', async () => {
  setProfile({ transport: 'anthropic' })
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: true for bare claude- model via profile', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'claude-sonnet-4-5',
  })
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true for github:copilot:claude- compound format', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot:claude-sonnet-4',
  })
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true when resolvedModel is a claude- model', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
  })
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode('claude-haiku-4-5')).toBe(true)
})

test('isGithubNativeAnthropicMode: false for generic github:copilot alias', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
  })
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for non-Claude model', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'gpt-4o',
  })
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for github:copilot:gpt- model', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot:gpt-4o',
  })
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})
