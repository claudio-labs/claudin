import { afterEach, describe, expect, test } from 'bun:test'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import type { ResolvedProviderRequest } from 'src/providers/presets/providerConfig.js'
import { buildGeminiUrl, performGeminiRequest } from 'src/providers/shims/gemini/backend.js'
import {
  geminiVersion,
  isGeminiCompatBaseUrl,
  isGeminiNativeRequest,
  isVertexGeminiBaseUrl,
} from 'src/providers/shims/gemini/endpoints.js'

const originalFetch = globalThis.fetch
const originalNative = process.env.CLAUDIN_GEMINI_NATIVE

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalNative === undefined) delete process.env.CLAUDIN_GEMINI_NATIVE
  else process.env.CLAUDIN_GEMINI_NATIVE = originalNative
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

describe('endpoints', () => {
  test('the OpenAI-compatible base URL, with or without a trailing slash', () => {
    expect(isGeminiCompatBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(true)
    expect(isGeminiCompatBaseUrl('https://proxy.example/v1beta/openai/')).toBe(true)
    expect(isGeminiCompatBaseUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(false)
    expect(isGeminiCompatBaseUrl('not a url')).toBe(false)
    expect(isGeminiCompatBaseUrl(undefined)).toBe(false)
  })

  test('Vertex hosts, global and regional, and nothing that only ends like one', () => {
    expect(isVertexGeminiBaseUrl('https://aiplatform.googleapis.com')).toBe(true)
    expect(isVertexGeminiBaseUrl('https://europe-west4-aiplatform.googleapis.com/v1')).toBe(true)
    expect(isVertexGeminiBaseUrl('https://evil.com.aiplatform.googleapis.com')).toBe(false)
    expect(isVertexGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(false)
    expect(isVertexGeminiBaseUrl(undefined)).toBe(false)
  })

  test('geminiVersion', () => {
    expect(geminiVersion('gemini-3.1-pro-preview')).toBe(3.1)
    expect(geminiVersion('models/gemini-3-flash-preview')).toBe(3)
    expect(geminiVersion('gemini-2.5-flash-lite')).toBe(2.5)
    expect(geminiVersion('gemma-4-31b-it')).toBeUndefined()
  })

  test('isGeminiNativeRequest: the gemini transport off the compat URL, unless switched off', () => {
    useProfile({ id: 'g', name: 'Gemini', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3-flash-preview' })
    expect(isGeminiNativeRequest('https://generativelanguage.googleapis.com/v1beta')).toBe(true)
    expect(isGeminiNativeRequest('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(false)
    expect(isGeminiNativeRequest('https://us-central1-aiplatform.googleapis.com')).toBe(true)
    // A proxy on a Gemini profile was set up for the OpenAI-compatible wire.
    expect(isGeminiNativeRequest('http://localhost:4000/v1')).toBe(false)
    process.env.CLAUDIN_GEMINI_NATIVE = '0'
    expect(isGeminiNativeRequest('https://generativelanguage.googleapis.com/v1beta')).toBe(false)
  })

  test('isGeminiNativeRequest: never for another transport', () => {
    useProfile({ id: 'o', name: 'OpenAI', provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3-flash-preview' })
    expect(isGeminiNativeRequest('https://generativelanguage.googleapis.com/v1beta')).toBe(false)
  })
})

describe('buildGeminiUrl', () => {
  test('the Gemini API: models/{m}, a models/ prefix tolerated', () => {
    expect(buildGeminiUrl({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', model: 'models/gemini-2.5-pro', stream: false })).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    )
  })

  test('Vertex: regional and global hosts', () => {
    expect(
      buildGeminiUrl({ baseUrl: 'https://aiplatform.googleapis.com', model: 'gemini-3-flash-preview', stream: true, vertex: { project: 'p1', region: 'us-central1' } }),
    ).toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse')
    expect(
      buildGeminiUrl({ baseUrl: 'https://aiplatform.googleapis.com', model: 'gemini-3-flash-preview', stream: false, vertex: { project: 'p1', region: 'global' } }),
    ).toBe('https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent')
  })
})

describe('performGeminiRequest auth', () => {
  const request: ResolvedProviderRequest = {
    transport: 'chat_completions',
    requestedModel: 'gemini-3-flash-preview',
    resolvedModel: 'gemini-3-flash-preview',
    baseUrl: 'https://aiplatform.googleapis.com',
  }
  const params = { model: 'gemini-3-flash-preview', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, stream: true }

  function captureFetch(): Array<{ url: string; headers: Record<string, string> }> {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> })
      return new Response('', { status: 200 })
    }) as typeof fetch
    return calls
  }

  test('Vertex with ADC: Bearer, the profile project for quota and in the path, its region', async () => {
    useProfile({
      id: 'v',
      name: 'Gemini Vertex',
      provider: 'gemini',
      baseUrl: 'https://aiplatform.googleapis.com',
      model: 'gemini-3-flash-preview',
      extras: { gcpProject: 'my-proj', gcpRegion: 'europe-west4' },
    })
    const calls = captureFetch()
    await performGeminiRequest({
      request,
      params,
      defaultHeaders: {},
      resolveCredential: async () => ({ kind: 'adc', credential: 'ya29.token', projectId: 'adc-proj' }),
    })
    expect(calls[0]!.url).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/my-proj/locations/europe-west4/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse',
    )
    expect(calls[0]!.headers.Authorization).toBe('Bearer ya29.token')
    expect(calls[0]!.headers['x-goog-user-project']).toBe('my-proj')
    expect(calls[0]!.headers['x-goog-api-key']).toBeUndefined()
  })

  test('Vertex without a profile project falls back to the ADC one and the global region', async () => {
    useProfile({ id: 'v2', name: 'Gemini Vertex', provider: 'gemini', baseUrl: 'https://aiplatform.googleapis.com', model: 'gemini-3-flash-preview' })
    const calls = captureFetch()
    const originalProject = process.env.GOOGLE_CLOUD_PROJECT
    const originalLocation = process.env.GOOGLE_CLOUD_LOCATION
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_CLOUD_LOCATION
    try {
      await performGeminiRequest({
        request,
        params,
        defaultHeaders: {},
        resolveCredential: async () => ({ kind: 'adc', credential: 'ya29.token', projectId: 'adc-proj' }),
      })
    } finally {
      if (originalProject !== undefined) process.env.GOOGLE_CLOUD_PROJECT = originalProject
      if (originalLocation !== undefined) process.env.GOOGLE_CLOUD_LOCATION = originalLocation
    }
    expect(calls[0]!.url).toContain('aiplatform.googleapis.com/v1/projects/adc-proj/locations/global/')
  })

  test('no credential at all is a 401 that says how to sign in', async () => {
    useProfile({ id: 'g', name: 'Gemini', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3-flash-preview' })
    captureFetch()
    const error = await performGeminiRequest({
      request: { ...request, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      params,
      defaultHeaders: {},
      resolveCredential: async () => ({ kind: 'none' }),
    }).catch((e: unknown) => e)
    expect((error as { status?: number }).status).toBe(401)
    expect(String((error as Error).message)).toContain('gcloud auth application-default login')
  })
})
