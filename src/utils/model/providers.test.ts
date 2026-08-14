import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import type { GlobalConfig, ProviderProfile } from 'src/services/config/config.js'
import type { ResolvedProvider } from 'src/services/api/activeProvider.js'

let mockProviderProfile: ProviderProfile | null = null

// Spread into plain objects so afterAll restores the original bindings, not
// the live ESM namespaces (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/services/config/config.js')) }
const realProviderProfiles = { ...(await import('src/services/api/providerProfiles.js')) }

mock.module('src/services/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    providerProfiles: mockProviderProfile ? [mockProviderProfile] : [],
    activeProviderProfileId: mockProviderProfile?.id,
  } as unknown as GlobalConfig),
}))

mock.module('src/services/api/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => mockProviderProfile ?? undefined,
}))

afterAll(() => {
  mock.module('src/services/config/config.js', () => realConfig)
  mock.module('src/services/api/providerProfiles.js', () => realProviderProfiles)
})

import { invalidateActiveProviderCache } from 'src/services/api/activeProvider.js'
import {
  _setCopilotCatalogForTesting,
  type CopilotCatalogEntry,
} from './copilotModelCatalog.js'

afterEach(() => {
  mockProviderProfile = null
  invalidateActiveProviderCache()
  _setCopilotCatalogForTesting(null)
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

function catalogEntry(
  id: string,
  supportedEndpoints: string[] | null,
): CopilotCatalogEntry {
  return {
    model: {
      id,
      name: id,
      family: id,
      attachment: false,
      reasoning: false,
      tool_call: true,
      temperature: true,
      knowledge: '',
      release_date: '',
      last_updated: '',
      modalities: { input: ['text'], output: ['text'] },
      open_weights: false,
      cost: { input: 0, output: 0 },
      limit: { context: 128000, output: 16384 },
    },
    supportedEndpoints,
    pickerEnabled: true,
  }
}

test('isGithubNativeAnthropicMode: catalog vetoes a claude model served only via /chat/completions', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'claude-sonnet-4.6',
  })
  _setCopilotCatalogForTesting([
    catalogEntry('claude-sonnet-4.6', ['/chat/completions']),
  ])
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: catalog confirming /v1/messages keeps the native route', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'claude-sonnet-4.6',
  })
  _setCopilotCatalogForTesting([
    catalogEntry('claude-sonnet-4.6', ['/chat/completions', '/v1/messages']),
  ])
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: false for non-claude model even if catalog lists /v1/messages', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'gpt-6-preview',
  })
  _setCopilotCatalogForTesting([
    catalogEntry('gpt-6-preview', ['/v1/messages']),
  ])
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
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

test.each([
  ['openai_compat', 'https://api.openai.com/v1', 'gpt-5.4'],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-flash-preview'],
  ['mistral', 'https://api.mistral.ai/v1', 'devstral-latest'],
  ['codex_responses', 'https://chatgpt.com/backend-api/codex', 'codexplan'],
] as const)(
  'activeTransportUsesOpenAiShim: %s routes through the shim',
  async (transport, baseUrl, model) => {
    setProfile({ transport, baseUrl, model })
    const { activeTransportUsesOpenAiShim } = await importFreshProvidersModule()
    expect(activeTransportUsesOpenAiShim(model)).toBe(true)
  },
)

test.each([
  ['anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-6'],
  ['bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'claude-sonnet-4-6'],
  ['vertex', 'https://us-central1-aiplatform.googleapis.com', 'claude-sonnet-4-6'],
  ['foundry', 'https://example.services.ai.azure.com', 'claude-sonnet-4-6'],
] as const)(
  'activeTransportUsesOpenAiShim: native transport %s does NOT use the shim',
  async (transport, baseUrl, model) => {
    setProfile({ transport, baseUrl, model })
    const { activeTransportUsesOpenAiShim } = await importFreshProvidersModule()
    expect(activeTransportUsesOpenAiShim(model)).toBe(false)
  },
)

test('activeTransportUsesOpenAiShim: no configured profile → false (native default)', async () => {
  mockProviderProfile = null
  invalidateActiveProviderCache()
  const { activeTransportUsesOpenAiShim } = await importFreshProvidersModule()
  expect(activeTransportUsesOpenAiShim()).toBe(false)
})

test('activeTransportUsesOpenAiShim: github_copilot + non-Claude model uses the shim', async () => {
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'gpt-4o',
  })
  const { activeTransportUsesOpenAiShim } = await importFreshProvidersModule()
  expect(activeTransportUsesOpenAiShim('gpt-4o')).toBe(true)
})

test('activeTransportUsesOpenAiShim: github_copilot + Claude model is NATIVE (not shim)', async () => {
  // Regression guard: client.ts routes github_copilot + a Claude model through
  // the native Anthropic SDK (isGithubNativeAnthropicMode), which rejects
  // shim-only body fields like effortValue. The gate must return false here.
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'claude-sonnet-4-5',
  })
  const { activeTransportUsesOpenAiShim } = await importFreshProvidersModule()
  expect(activeTransportUsesOpenAiShim('claude-sonnet-4-5')).toBe(false)
})

test('activeTransportUsesOpenAiShim: github_copilot + catalog-vetoed Claude model uses the shim', async () => {
  // A Claude model the account serves only via /chat/completions takes the shim
  // route in client.ts, so shim-only fields ARE valid — the gate returns true.
  setProfile({
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'claude-sonnet-4.6',
  })
  _setCopilotCatalogForTesting([
    catalogEntry('claude-sonnet-4.6', ['/chat/completions']),
  ])
  const { activeTransportUsesOpenAiShim } = await importFreshProvidersModule()
  expect(activeTransportUsesOpenAiShim('claude-sonnet-4.6')).toBe(true)
})
