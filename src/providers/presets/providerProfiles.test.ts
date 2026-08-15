import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { ProviderProfile } from 'src/platform/config/config.js'

// Spread into a plain object so afterAll restores the original bindings, not
// the live ESM namespace (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/platform/config/config.js')) }

async function importFreshProvidersModule() {
  return import(`src/providers/model/providers.js?ts=${Date.now()}-${Math.random()}`)
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

  mockConfigState = createMockConfigState()
  process.chdir(originalCwd)
})

afterAll(() => {
  mock.module('src/platform/config/config.js', () => realConfig)
  realConfig.resetGlobalConfigForTests?.()
})

type MockProjectConfigState = {
  activeProviderProfileId?: string
  activeModelForProject?: string
  activeModelForProjectProfileId?: string
}

let mockProjectConfigState: MockProjectConfigState = {}

beforeEach(() => {
  mockProjectConfigState = {}
})
afterEach(() => {
  mockProjectConfigState = {}
})

async function importFreshProviderProfileModules() {
  mock.module('src/platform/config/config.js', () => ({
    ...realConfig,
    getGlobalConfig: () => mockConfigState,
    saveGlobalConfig: (
      updater: (current: MockConfigState) => MockConfigState,
    ) => {
      mockConfigState = updater(mockConfigState)
    },
    getCurrentProjectConfig: () => mockProjectConfigState,
    saveCurrentProjectConfig: (
      updater: (current: MockProjectConfigState) => MockProjectConfigState,
    ) => {
      mockProjectConfigState = updater(mockProjectConfigState)
    },
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const providers = await import(`src/providers/model/providers.js?ts=${nonce}`)
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

  test('invalidates the derived model-options cache when the model changes', async () => {
    const { persistActiveProviderProfileModel } =
      await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      baseUrl: 'http://192.168.33.108:11434/v1',
      model: 'kimi-k2.5:cloud',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
      openaiAdditionalModelOptionsCache: [{ value: 'kimi-k2.5:cloud' }],
      openaiAdditionalModelOptionsCacheByProfile: {
        [activeProfile.id]: [{ value: 'kimi-k2.5:cloud' }],
      },
    }))

    persistActiveProviderProfileModel('minimax-m2.5:cloud')

    // Stale cache must be dropped so /model re-derives from the new model list.
    expect(
      mockConfigState.openaiAdditionalModelOptionsCacheByProfile[
        activeProfile.id
      ],
    ).toBeUndefined()
    expect(mockConfigState.openaiAdditionalModelOptionsCache).toEqual([])
  })
})

describe('clearActiveProviderProfileModel', () => {
  test('clears the model field and invalidates the derived cache', async () => {
    const { getProviderProfiles, clearActiveProviderProfileModel } =
      await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      baseUrl: 'http://192.168.33.108:11434/v1',
      model: 'kimi-k2.5:cloud',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
      openaiAdditionalModelOptionsCache: [{ value: 'kimi-k2.5:cloud' }],
      openaiAdditionalModelOptionsCacheByProfile: {
        [activeProfile.id]: [{ value: 'kimi-k2.5:cloud' }],
      },
    }))

    clearActiveProviderProfileModel()

    const saved = getProviderProfiles().find(
      (profile: ProviderProfile) => profile.id === activeProfile.id,
    )
    // sanitize normalizes a blank model to undefined — the point is it's cleared.
    expect(saved?.model).toBeFalsy()
    expect(
      mockConfigState.openaiAdditionalModelOptionsCacheByProfile[
        activeProfile.id
      ],
    ).toBeUndefined()
    expect(mockConfigState.openaiAdditionalModelOptionsCache).toEqual([])
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
  test('opencode-zen preset defaults to OpenCode Zen endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('opencode-zen')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('OpenCode Zen')
    expect(defaults.baseUrl).toBe('https://opencode.ai/zen/v1')
    expect(defaults.model).toBe('glm-5.1')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('opencode-go preset defaults to OpenCode GO endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('opencode-go')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('OpenCode GO')
    expect(defaults.baseUrl).toBe('https://opencode.ai/zen/go/v1')
    expect(defaults.model).toBe('glm-5.1')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('zai preset defaults to Z.AI GLM Coding Plan endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('zai')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('Z.AI (GLM Coding Plan)')
    expect(defaults.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(defaults.model).toBe('glm-5.2')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('cloudflare-workers-ai preset defaults to Workers AI endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('cloudflare-workers-ai')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('Cloudflare Workers AI')
    expect(defaults.baseUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/YOUR-ACCOUNT-ID/ai/v1',
    )
    expect(defaults.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('cloudflare-ai-gateway preset defaults to AI Gateway compat endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('cloudflare-ai-gateway')

    expect(defaults.provider).toBe('openai')
    expect(defaults.name).toBe('Cloudflare AI Gateway')
    expect(defaults.baseUrl).toBe(
      'https://gateway.ai.cloudflare.com/v1/YOUR-ACCOUNT-ID/default/compat',
    )
    expect(defaults.model).toBe('workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast')
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
    const cacheValues = cache.map((opt: { value: string }) => opt.value)
    expect(cacheValues).toContain('glm-4.7')
    expect(cacheValues).toContain('glm-4.7-flash')
    expect(cacheValues).toContain('glm-4.7-plus')
  })
})

describe('project-scoped active provider override', () => {
  test('project override takes precedence over global default', async () => {
    const {
      getActiveProviderProfile,
      setActiveProviderProfileForProject,
    } = await importFreshProviderProfileModules()

    const globalProfile = buildProfile({ id: 'global', name: 'Global' })
    const projectProfile = buildProfile({ id: 'project', name: 'Project' })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [globalProfile, projectProfile],
      activeProviderProfileId: 'global',
    }))

    expect(getActiveProviderProfile()?.id).toBe('global')

    const set = setActiveProviderProfileForProject('project')
    expect(set?.id).toBe('project')
    expect(getActiveProviderProfile()?.id).toBe('project')
  })

  test('missing project profile id falls back silently to global', async () => {
    const { getActiveProviderProfile } = await importFreshProviderProfileModules()

    const globalProfile = buildProfile({ id: 'global', name: 'Global' })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [globalProfile],
      activeProviderProfileId: 'global',
    }))

    // Simulate a stale project override pointing at a deleted profile.
    mockProjectConfigState = { activeProviderProfileId: 'deleted_id' }

    expect(getActiveProviderProfile()?.id).toBe('global')
  })

  test('setActiveProviderProfileForProject(null) clears override', async () => {
    const {
      getActiveProviderProfile,
      setActiveProviderProfileForProject,
    } = await importFreshProviderProfileModules()

    const globalProfile = buildProfile({ id: 'global', name: 'Global' })
    const projectProfile = buildProfile({ id: 'project', name: 'Project' })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [globalProfile, projectProfile],
      activeProviderProfileId: 'global',
    }))

    setActiveProviderProfileForProject('project')
    expect(getActiveProviderProfile()?.id).toBe('project')

    setActiveProviderProfileForProject(null)
    expect(getActiveProviderProfile()?.id).toBe('global')
    expect(mockProjectConfigState.activeProviderProfileId).toBeUndefined()
  })

  test('full lifecycle: set project override updates model cache, clear restores global cache', async () => {
    const {
      getActiveProviderProfile,
      setActiveProviderProfileForProject,
    } = await importFreshProviderProfileModules()

    const globalProfile = buildProfile({
      id: 'global_openai',
      name: 'Global OpenAI',
      model: 'gpt-global-a, gpt-global-b',
    })
    const projectProfile = buildProfile({
      id: 'project_openai',
      name: 'Project OpenAI',
      model: 'gpt-proj-a, gpt-proj-b',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [globalProfile, projectProfile],
      activeProviderProfileId: 'global_openai',
      openaiAdditionalModelOptionsCache: [],
      openaiAdditionalModelOptionsCacheByProfile: {},
    }))

    expect(getActiveProviderProfile()?.id).toBe('global_openai')

    setActiveProviderProfileForProject('project_openai')
    expect(getActiveProviderProfile()?.id).toBe('project_openai')
    // Project profile's model cache should be populated.
    expect(
      mockConfigState.openaiAdditionalModelOptionsCacheByProfile[
        'project_openai'
      ]?.length ?? 0,
    ).toBeGreaterThan(0)

    setActiveProviderProfileForProject(null)
    expect(getActiveProviderProfile()?.id).toBe('global_openai')
    // After clearing, global profile's cache should be populated.
    expect(
      mockConfigState.openaiAdditionalModelOptionsCacheByProfile[
        'global_openai'
      ]?.length ?? 0,
    ).toBeGreaterThan(0)
  })

  test('setActiveProviderProfileForProject returns null for unknown profile', async () => {
    const { setActiveProviderProfileForProject } =
      await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'p1' })],
      activeProviderProfileId: 'p1',
    }))

    const result = setActiveProviderProfileForProject('does_not_exist')
    expect(result).toBeNull()
  })

  test('re-selecting the same project profile preserves activeModelForProject', async () => {
    const { setActiveProviderProfileForProject } =
      await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        buildProfile({ id: 'p_a', name: 'A' }),
        buildProfile({ id: 'p_b', name: 'B' }),
      ],
      activeProviderProfileId: 'p_a',
    }))

    setActiveProviderProfileForProject('p_b')
    mockProjectConfigState.activeModelForProject = 'user-chosen-model'
    mockProjectConfigState.activeModelForProjectProfileId = 'p_b'

    setActiveProviderProfileForProject('p_b')

    expect(mockProjectConfigState.activeProviderProfileId).toBe('p_b')
    expect(mockProjectConfigState.activeModelForProject).toBe(
      'user-chosen-model',
    )
    expect(mockProjectConfigState.activeModelForProjectProfileId).toBe('p_b')
  })

  test('switching project profile id clears activeModelForProject', async () => {
    const { setActiveProviderProfileForProject } =
      await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        buildProfile({ id: 'p_a', name: 'A' }),
        buildProfile({ id: 'p_b', name: 'B' }),
      ],
      activeProviderProfileId: 'p_a',
    }))

    setActiveProviderProfileForProject('p_a')
    mockProjectConfigState.activeModelForProject = 'stale-model-from-a'
    mockProjectConfigState.activeModelForProjectProfileId = 'p_a'

    setActiveProviderProfileForProject('p_b')

    expect(mockProjectConfigState.activeProviderProfileId).toBe('p_b')
    expect(mockProjectConfigState.activeModelForProject).toBeUndefined()
    expect(
      mockProjectConfigState.activeModelForProjectProfileId,
    ).toBeUndefined()
  })

  test('deleteProviderProfile strips activeModelForProject from affected projects', async () => {
    const { addProviderProfile, deleteProviderProfile } =
      await importFreshProviderProfileModules()

    const a = addProviderProfile({
      provider: 'openai',
      name: 'A',
      baseUrl: 'https://a.example.com/v1',
      model: 'm-a',
      apiKey: 'k',
    })
    const b = addProviderProfile({
      provider: 'openai',
      name: 'B',
      baseUrl: 'https://b.example.com/v1',
      model: 'm-b',
      apiKey: 'k',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      activeProviderProfileId: b!.id,
      projects: {
        '/some/project': {
          activeProviderProfileId: a!.id,
          activeModelForProject: 'project-chosen-model',
          activeModelForProjectProfileId: a!.id,
        },
        '/other/project': {
          activeProviderProfileId: b!.id,
          activeModelForProject: 'unaffected',
          activeModelForProjectProfileId: b!.id,
        },
      },
    }) as never)

    deleteProviderProfile(a!.id)

    const projects = (mockConfigState as { projects?: Record<string, { activeProviderProfileId?: string; activeModelForProject?: string; activeModelForProjectProfileId?: string }> }).projects
    expect(projects?.['/some/project']?.activeProviderProfileId).toBeUndefined()
    expect(projects?.['/some/project']?.activeModelForProject).toBeUndefined()
    expect(
      projects?.['/some/project']?.activeModelForProjectProfileId,
    ).toBeUndefined()
    expect(projects?.['/other/project']?.activeProviderProfileId).toBe(b!.id)
    expect(projects?.['/other/project']?.activeModelForProject).toBe(
      'unaffected',
    )
    expect(projects?.['/other/project']?.activeModelForProjectProfileId).toBe(
      b!.id,
    )
  })

})
