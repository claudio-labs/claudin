import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

import type { ProviderProfile } from './config.js'

// Spread into a plain object so afterAll restores the original bindings, not
// the live ESM namespace (which mock.module mutates after the fact).
const realConfig = { ...(await import('./config.js')) }

async function importFreshProvidersModule() {
  return import(`./model/providers.js?ts=${Date.now()}-${Math.random()}`)
}

const originalEnv = { ...process.env }
const originalCwd = process.cwd()

const RESTORED_KEYS = [
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_AUTH_MODE',
  'GEMINI_ACCESS_TOKEN',
  'GOOGLE_API_KEY',
  'MISTRAL_BASE_URL',
  'MISTRAL_MODEL',
  'MISTRAL_API_KEY',
] as const

type MockConfigState = {
  providerProfiles: ProviderProfile[]
  activeProviderProfileId?: string
  openaiAdditionalModelOptionsCache: unknown[]
  openaiAdditionalModelOptionsCacheByProfile: Record<string, unknown[]>
  additionalModelOptionsCache?: unknown[]
  additionalModelOptionsCacheScope?: string
}

function createMockConfigState(): MockConfigState {
  return {
    providerProfiles: [],
    activeProviderProfileId: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
  }
}

let mockConfigState: MockConfigState = createMockConfigState()

function saveMockGlobalConfig(
  updater: (current: MockConfigState) => MockConfigState,
): void {
  mockConfigState = updater(mockConfigState)
}

afterEach(() => {
  for (const key of RESTORED_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }

  mock.restore()
  mockConfigState = createMockConfigState()
  process.chdir(originalCwd)
})

afterAll(() => {
  mock.module('./config.js', () => realConfig)
  realConfig.resetGlobalConfigForTests?.()
})

async function importFreshProviderProfileModules() {
  mock.restore()
  mock.module('./config.js', () => ({
    ...realConfig,
    getGlobalConfig: () => mockConfigState,
    saveGlobalConfig: (
      updater: (current: MockConfigState) => MockConfigState,
    ) => {
      mockConfigState = updater(mockConfigState)
    },
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const providers = await import(`./model/providers.js?ts=${nonce}`)
  const providerProfiles = await import(`./providerProfiles.js?ts=${nonce}`)

  return {
    ...providers,
    ...providerProfiles,
  }
}

function buildProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider_test',
    name: 'Test Provider',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    ...overrides,
  }
}

function buildMistralProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'devstral-latest',
    ...overrides,
  })
}

function buildGeminiProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3-flash-preview',
    ...overrides,
  })
}


describe('persistActiveProviderProfileModel', () => {
  test('updates active profile model in saved config', async () => {
    const {
      getProviderProfiles,
      persistActiveProviderProfileModel,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      baseUrl: 'http://192.168.33.108:11434/v1',
      model: 'kimi-k2.5:cloud',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))

    const updated = persistActiveProviderProfileModel('minimax-m2.5:cloud')

    expect(updated?.id).toBe(activeProfile.id)
    expect(updated?.model).toBe('minimax-m2.5:cloud')

    const saved = getProviderProfiles().find(
      (profile: ProviderProfile) => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe('minimax-m2.5:cloud')
  })
})

describe('getProviderPresetDefaults', () => {
  test('ollama preset defaults to a local Ollama model', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('ollama')

    expect(defaults.baseUrl).toBe('http://localhost:11434/v1')
    expect(defaults.model).toBe('llama3.1:8b')
  })

  test('atomic-chat preset defaults to a local Atomic Chat endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('atomic-chat')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('Atomic Chat')
    expect(defaults.baseUrl).toBe('http://127.0.0.1:1337/v1')
    expect(defaults.requiresApiKey).toBe(false)
  })

  test('kimi-code preset defaults to the Kimi Code coding endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('kimi-code')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('Moonshot AI - Kimi Code')
    expect(defaults.baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect(defaults.model).toBe('kimi-for-coding')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('moonshotai preset keeps the direct API under the renamed display label', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('moonshotai')

    expect(defaults.name).toBe('Moonshot AI - API')
    expect(defaults.baseUrl).toBe('https://api.moonshot.ai/v1')
    expect(defaults.model).toBe('kimi-k2.5')
  })
  test('deepseek preset defaults to DeepSeek V4 flash and exposes flash/pro aliases', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('deepseek')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('DeepSeek')
    expect(defaults.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(defaults.model).toBe(
      'deepseek-v4-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner',
    )
    expect(defaults.requiresApiKey).toBe(true)
  })
})


describe('deleteProviderProfile', () => {
  test('deletes the only profile and reports no remaining active id', async () => {
    const { deleteProviderProfile } = await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'only_profile' })],
      activeProviderProfileId: 'only_profile',
    }))

    const result = deleteProviderProfile('only_profile')

    expect(result.removed).toBe(true)
    expect(result.activeProfileId).toBeUndefined()
  })
})

describe('getProfileModelOptions', () => {
  test('generates options for multi-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Test Provider',
        model: 'glm-4.7, glm-4.7-flash, glm-4.7-plus',
      }),
    )

    expect(options).toEqual([
      { value: 'glm-4.7', label: 'glm-4.7', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-flash', label: 'glm-4.7-flash', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-plus', label: 'glm-4.7-plus', description: 'Provider: Test Provider' },
    ])
  })

  test('generates options for semicolon-separated multi-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Test Provider',
        model: 'glm-4.7; glm-4.7-flash; glm-4.7-plus',
      }),
    )

    expect(options).toEqual([
      { value: 'glm-4.7', label: 'glm-4.7', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-flash', label: 'glm-4.7-flash', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-plus', label: 'glm-4.7-plus', description: 'Provider: Test Provider' },
    ])
  })

  test('returns single option for single-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Single Model',
        model: 'llama3.1:8b',
      }),
    )

    expect(options).toEqual([
      { value: 'llama3.1:8b', label: 'llama3.1:8b', description: 'Provider: Single Model' },
    ])
  })

  test('returns empty array for empty model field', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Empty',
        model: '',
      }),
    )

    expect(options).toEqual([])
  })
})

describe('setActiveProviderProfile model cache', () => {
  test('populates model cache with all models from multi-model profile on activation', async () => {
    const {
      setActiveProviderProfile,
      getActiveOpenAIModelOptionsCache,
    } = await importFreshProviderProfileModules()

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [
        buildProfile({
          id: 'multi_provider',
          name: 'Multi Provider',
          model: 'glm-4.7, glm-4.7-flash, glm-4.7-plus',
          baseUrl: 'https://api.example.com/v1',
        }),
      ],
    }

    setActiveProviderProfile('multi_provider')

    const cache = getActiveOpenAIModelOptionsCache()
    const cacheValues = cache.map(opt => opt.value)
    expect(cacheValues).toContain('glm-4.7')
    expect(cacheValues).toContain('glm-4.7-flash')
    expect(cacheValues).toContain('glm-4.7-plus')
  })
})
