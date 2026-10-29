import { afterEach, describe, expect, test } from 'bun:test'
import { listOpenAICompatibleModelsDetailed } from 'src/providers/presets/providerDiscovery.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { getActiveOpenAIModelOptionsCache } from 'src/providers/presets/providerProfiles.js'
import {
  geminiModelOptions,
  listGeminiModelsDetailed,
  parseGeminiModelList,
  refreshGeminiModelOptions,
  type GeminiModelInfo,
} from 'src/providers/shims/gemini/models.js'

const NATIVE = 'https://generativelanguage.googleapis.com/v1beta'
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

const LIST = {
  models: [
    {
      name: 'models/gemini-3-flash-preview',
      displayName: 'Gemini 3 Flash Preview',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
    },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
  ],
}

function captureFetch(respond: () => Response): Array<{ url: string; headers: Record<string, string> }> {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> })
    return respond()
  }) as typeof fetch
  return calls
}

describe('parseGeminiModelList', () => {
  test('ids without the models/ prefix, generateContent models only, no duplicates', () => {
    expect(parseGeminiModelList(LIST)).toEqual([
      { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
      { id: 'gemini-2.5-pro', inputTokenLimit: 1048576 },
    ])
  })

  test('anything that is not a list is empty', () => {
    expect(parseGeminiModelList(null)).toEqual([])
    expect(parseGeminiModelList({ data: [] })).toEqual([])
  })
})

describe('listGeminiModelsDetailed', () => {
  test('the API key as x-goog-api-key; context windows recorded', async () => {
    const calls = captureFetch(() => Response.json(LIST))
    const recorded: GeminiModelInfo[] = []
    const result = await listGeminiModelsDetailed({
      baseUrl: `${NATIVE}/`,
      apiKey: 'AIza-test',
      recordLimits: model => recorded.push(model),
    })
    expect(result).toEqual({ ok: true, ids: ['gemini-3-flash-preview', 'gemini-2.5-pro'] })
    expect(calls[0]!.url).toBe(`${NATIVE}/models?pageSize=1000`)
    expect(calls[0]!.headers).toEqual({ 'x-goog-api-key': 'AIza-test' })
    expect(recorded.map(model => [model.id, model.inputTokenLimit, model.outputTokenLimit])).toEqual([
      ['gemini-3-flash-preview', 1048576, 65536],
      ['gemini-2.5-pro', 1048576, undefined],
    ])
  })

  test('no key: ADC as a Bearer with the quota project', async () => {
    const calls = captureFetch(() => Response.json(LIST))
    await listGeminiModelsDetailed({
      baseUrl: NATIVE,
      resolveCredential: async () => ({ kind: 'adc', credential: 'ya29.t', projectId: 'p1' }),
    })
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer ya29.t', 'x-goog-user-project': 'p1' })
  })

  test('no key and no ADC: unauthorized, without a request', async () => {
    const calls = captureFetch(() => Response.json(LIST))
    expect(await listGeminiModelsDetailed({ baseUrl: NATIVE, resolveCredential: async () => ({ kind: 'none' }) })).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
    expect(calls).toHaveLength(0)
  })

  test.each([
    [400, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [503, 'server_error'],
  ])('HTTP %i: %s', async (status, reason) => {
    captureFetch(() => new Response('{}', { status }))
    expect(await listGeminiModelsDetailed({ baseUrl: NATIVE, apiKey: 'k' })).toMatchObject({ ok: false, reason, status })
  })

  test('an empty list is an invalid response; a thrown fetch a network failure', async () => {
    captureFetch(() => Response.json({ models: [] }))
    expect(await listGeminiModelsDetailed({ baseUrl: NATIVE, apiKey: 'k' })).toEqual({ ok: false, reason: 'invalid_response' })
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await listGeminiModelsDetailed({ baseUrl: NATIVE, apiKey: 'k' })).toEqual({ ok: false, reason: 'network' })
  })
})

describe('the /provider wizard discovery', () => {
  test('a native Gemini base URL reads the native list', async () => {
    const calls = captureFetch(() => Response.json(LIST))
    const result = await listOpenAICompatibleModelsDetailed({ baseUrl: NATIVE, apiKey: 'k' })
    expect(result).toEqual({ ok: true, ids: ['gemini-3-flash-preview', 'gemini-2.5-pro'] })
    expect(calls[0]!.url).toBe(`${NATIVE}/models?pageSize=1000`)
  })

  test('the OpenAI-compatible endpoint keeps the OpenAI list', async () => {
    const calls = captureFetch(() => Response.json({ data: [{ id: 'models/gemini-3-flash-preview' }] }))
    const result = await listOpenAICompatibleModelsDetailed({ baseUrl: `${NATIVE}/openai`, apiKey: 'k' })
    expect(result).toEqual({ ok: true, ids: ['models/gemini-3-flash-preview'] })
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer k' })
  })
})

describe('geminiModelOptions', () => {
  test('chat models only, newest family first, with the window', () => {
    const options = geminiModelOptions([
      { id: 'gemini-2.5-pro', inputTokenLimit: 1048576 },
      { id: 'gemini-3.8-flash-tts' },
      { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', inputTokenLimit: 1048576 },
      { id: 'gemini-3.1-flash-image' },
      { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576 },
      { id: 'gemma-4-31b-it', inputTokenLimit: 131072 },
    ])
    expect(options).toEqual([
      { value: 'gemini-4-argon', label: 'Gemini 4 Argon', description: 'gemini-4-argon · 1M ctx' },
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'gemini-3.8-flash · 1M ctx' },
      { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro', description: 'gemini-2.5-pro · 1M ctx' },
      { value: 'gemma-4-31b-it', label: 'gemma-4-31b-it', description: 'gemma-4-31b-it · 131K ctx' },
    ])
  })
})

describe('refreshGeminiModelOptions', () => {
  const GEMINI: ProviderProfile = {
    id: 'refresh-gemini',
    name: 'Google Gemini',
    provider: 'gemini',
    baseUrl: NATIVE,
    model: 'gemini-3-flash-preview',
    apiKey: 'AIza-k',
  }
  function useProfile(profile: ProviderProfile): void {
    saveGlobalConfig(current => ({ ...current, providerProfiles: [profile], activeProviderProfileId: profile.id }))
    invalidateActiveProviderCache()
  }

  test('a native Gemini profile caches Google’s chat models as its /model options', async () => {
    useProfile(GEMINI)
    captureFetch(() => Response.json(LIST))
    await refreshGeminiModelOptions({ recordLimits: () => {} })
    expect(getActiveOpenAIModelOptionsCache().map(option => option.value)).toEqual([
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
    ])
  })

  test('Vertex, the compat endpoint and another provider fetch nothing', async () => {
    for (const profile of [
      { ...GEMINI, baseUrl: 'https://aiplatform.googleapis.com' },
      { ...GEMINI, baseUrl: `${NATIVE}/openai` },
      { ...GEMINI, provider: 'openai' as const },
    ]) {
      useProfile(profile)
      const calls = captureFetch(() => Response.json(LIST))
      await refreshGeminiModelOptions({ recordLimits: () => {} })
      expect(calls).toHaveLength(0)
    }
  })

  test('a failed list keeps the cache as it was', async () => {
    useProfile(GEMINI)
    captureFetch(() => Response.json(LIST))
    await refreshGeminiModelOptions({ recordLimits: () => {} })
    captureFetch(() => new Response('{}', { status: 503 }))
    await refreshGeminiModelOptions({ recordLimits: () => {} })
    expect(getActiveOpenAIModelOptionsCache()).toHaveLength(2)
  })
})
