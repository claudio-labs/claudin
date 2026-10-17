/**
 * The model surface a Codex session sees: which model each tier resolves to,
 * what `codexplan` becomes, what /model lists, and the context window and
 * effort levels each Codex model gets.
 *
 * It spans model.ts, modelOptions.ts, providerConfig.ts, configs.ts,
 * reasoningCatalog.ts and the context-window tables, so it lives as one suite
 * beside the Codex catalog. Providers are switched through the real resolver:
 * under `bun test` the global config lives in memory, so the profile written
 * here is the one tryGetActiveProvider resolves. No module is mocked.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { getCacheProfile, _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'
import { getContextWindowForModel } from 'src/agent/context/context.js'
import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { ALL_MODEL_CONFIGS } from 'src/providers/model/configs.js'
import {
  getDefaultHaikuModel,
  getDefaultMainLoopModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  parseUserSpecifiedModel,
  renderModelName,
} from 'src/providers/model/model.js'
import { getModelOptions } from 'src/providers/model/modelOptions.js'
import { getOpenAIContextWindow, getOpenAIMaxOutputTokens } from 'src/providers/model/openaiContextWindows.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { resolveActiveShimEffortValues, resolveShimEffortValues } from 'src/providers/model/reasoningCatalog.js'
import { invalidateActiveProviderCache, tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { resolveProviderRequest } from 'src/providers/presets/providerConfig.js'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** What /provider writes for a Codex OAuth login. */
const CODEX_OAUTH: ProviderProfile = {
  id: 'surface-codex',
  name: 'Codex OAuth',
  provider: 'openai',
  baseUrl: CODEX_BASE_URL,
  model: 'codexplan',
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
  _resetCacheProfileForTesting()
  resetModelStringsForTestingOnly()
}

afterEach(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

describe('a Codex OAuth profile', () => {
  test('resolves to the Codex transport, provider tag and retain cache profile', () => {
    useProfile(CODEX_OAUTH)
    expect(tryGetActiveProvider()?.transport).toBe('codex_responses')
    expect(getAPIProvider()).toBe('codex')
    expect(getCacheProfile().name).toBe('retain')
  })

  test('every tier resolves to the profile model, and the main loop to what codexplan names', () => {
    useProfile(CODEX_OAUTH)
    expect(getDefaultOpusModel()).toBe('codexplan')
    expect(getDefaultSonnetModel()).toBe('codexplan')
    expect(getDefaultHaikuModel()).toBe('codexplan')
    expect(getSmallFastModel()).toBe('codexplan')
    expect(getDefaultMainLoopModel()).toBe('gpt-5.5')
  })

  test('the /model picker lists the whole Codex catalog plus the Claude aliases mapped onto it', () => {
    useProfile(CODEX_OAUTH)
    expect(getModelOptions(false).map(option => option.value)).toEqual([
      null,
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'codexspark',
      'gpt-5.2-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5.5-mini',
      'gpt-5.4-mini',
      'gpt-4o',
      'gpt-4o[1m]',
      'opus',
      'gpt-4o-mini',
      'haiku',
      'codexplan',
    ])
  })

  test('model names: the shared display table, else the id', () => {
    useProfile(CODEX_OAUTH)
    expect(renderModelName('gpt-5.5')).toBe('GPT-5.5')
    expect(renderModelName('gpt-6-luna')).toBe('gpt-6-luna')
  })

  test('context windows: the catalog for known models, the shim fallback for unknown ones', () => {
    useProfile(CODEX_OAUTH)
    expect(getOpenAIContextWindow('gpt-5.6-terra')).toBe(1_050_000)
    expect(getOpenAIContextWindow('gpt-6-luna')).toBeUndefined()
    expect(getOpenAIMaxOutputTokens('gpt-6-luna')).toBeUndefined()
    expect(getContextWindowForModel('gpt-5.6-terra')).toBe(1_050_000)
  })

  test('effort levels: the GPT-5 family list, nothing for gpt-6', () => {
    useProfile(CODEX_OAUTH)
    expect(resolveShimEffortValues(CODEX_BASE_URL, 'gpt-5.6-terra')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(resolveShimEffortValues(CODEX_BASE_URL, 'gpt-6-luna')).toBeUndefined()
    expect(resolveActiveShimEffortValues('gpt-5.6-terra')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})

// /provider writes `codexplan`, but a profile on the Codex backend can name a
// model directly (edited, imported, or written by hand). Its requests already
// go to the Codex backend (resolveProviderRequest reads the base URL); the
// profile has to resolve as Codex too, or it gets the OpenAI tag, the
// aggressive cache profile and its thinking-history strip.
describe('a Codex backend profile whose model is not an alias', () => {
  test('resolves to the Codex transport, provider tag and retain cache profile', () => {
    useProfile({ ...CODEX_OAUTH, id: 'surface-codex-model', model: 'gpt-5.6-terra' })
    expect(tryGetActiveProvider()?.transport).toBe('codex_responses')
    expect(getAPIProvider()).toBe('codex')
    expect(getCacheProfile().name).toBe('retain')
  })
})

describe('Codex model resolution, provider-independent', () => {
  test('the Codex aliases name concrete models', () => {
    expect(parseUserSpecifiedModel('codexplan')).toBe('gpt-5.5')
    expect(parseUserSpecifiedModel('codexspark')).toBe('gpt-5.3-codex-spark')
  })

  test.each([
    ['codexplan', 'gpt-5.5', { effort: 'high' }],
    ['gpt-5.6-terra', 'gpt-5.6-terra', { effort: 'high' }],
    ['gpt-6-luna', 'gpt-6-luna', undefined],
  ] as const)('%s on the Codex backend resolves to %s with %o', (model, resolved, reasoning) => {
    const request = resolveProviderRequest({ model, baseUrl: CODEX_BASE_URL })
    expect(request.transport).toBe('codex_responses')
    expect(request.resolvedModel).toBe(resolved)
    expect(request.reasoning).toEqual(reasoning as never)
  })

  test('every Claude tier maps to the same Codex model', () => {
    const codexColumn = new Set(Object.values(ALL_MODEL_CONFIGS).map(config => config.codex))
    expect([...codexColumn]).toEqual(['gpt-5.5'])
  })
})
