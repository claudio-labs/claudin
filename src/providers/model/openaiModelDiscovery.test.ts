/**
 * Characterization of the OpenAI-compatible /models discovery behind the
 * /model picker and the startup prefetch, pinned before the parser learns
 * more context-window field names (today it reads only `context_length`).
 *
 * The network is `axios.get` (what the module calls), spied and restored;
 * the active provider is switched through the real resolver (the global
 * config lives in memory under `bun test`); nothing is `mock.module`d.
 *
 * The module keeps two state cells nobody can reset: the
 * `discoveredContextWindows` map (never cleared, so every test uses its own
 * model ids) and the `prefetchPromise` latch. The latch is the reason the
 * non-openai prefetch test is the LAST one in this file — see there.
 */
import axios from 'axios'
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  getGlobalConfig,
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import type { ModelOption } from 'src/providers/model/modelOptions.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import * as providerProfiles from 'src/providers/presets/providerProfiles.js'

// A private instance, not the shared one: openaiContextWindows.test.ts
// mock.module()s this module with a `getDiscoveredContextWindow` that reads its
// own variable and never puts the real one back, and under a directory or full
// run that stub is live in this file too, so every read of the map came back
// undefined. The query string makes Bun load an instance the mock does not
// cover. It is the ONLY instance this file uses, so its map is the one fed.
const PRIVATE_INSTANCE = './openaiModelDiscovery.ts?characterization'
const mod = (await import(PRIVATE_INSTANCE)) as typeof import('src/providers/model/openaiModelDiscovery.js')

type AxiosCall = { url: string; config: { headers?: Record<string, string>; timeout?: number } }
type Answer = { data?: unknown } | Error

const originalApiVersion = process.env.OPENAI_API_VERSION
const originalLegacyCache = getGlobalConfig().openaiAdditionalModelOptionsCache

function useProfile(baseUrl: string, apiKey?: string): void {
  const profile: ProviderProfile = {
    id: 'discovery-test',
    name: 'Discovery',
    provider: 'openai',
    baseUrl,
    model: 'local-model',
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

/** Answers each URL from `answers` (an Error is thrown); unknown URLs throw. */
function stubAxios(answers: Record<string, Answer>): AxiosCall[] {
  const calls: AxiosCall[] = []
  spyOn(axios, 'get').mockImplementation((async (url: string, config: AxiosCall['config']) => {
    calls.push({ url, config })
    const answer = answers[url]
    if (answer === undefined) throw new Error(`unexpected GET ${url}`)
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as typeof axios.get)
  return calls
}

function resetState(): void {
  delete process.env.OPENAI_API_VERSION
  // Not a default key, so resetGlobalConfigForTests leaves it behind.
  saveGlobalConfig(current => ({ ...current, openaiAdditionalModelOptionsCache: undefined }))
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
}

beforeEach(resetState)

afterEach(() => {
  ;(axios.get as unknown as { mockRestore?: () => void }).mockRestore?.()
  resetState()
})

afterAll(() => {
  if (originalApiVersion === undefined) delete process.env.OPENAI_API_VERSION
  else process.env.OPENAI_API_VERSION = originalApiVersion
  saveGlobalConfig(current => ({ ...current, openaiAdditionalModelOptionsCache: originalLegacyCache }))
})

describe('discovered context windows and max output tokens (plain maps)', () => {
  test('record → get round-trips; an unknown model is undefined', () => {
    mod.recordDiscoveredContextWindow('rt-model', 200_000)
    expect(mod.getDiscoveredContextWindow('rt-model')).toBe(200_000)
    expect(mod.getDiscoveredContextWindow('rt-never-seen')).toBeUndefined()
  })

  test('a later record overwrites the earlier one', () => {
    mod.recordDiscoveredContextWindow('rt-over', 1)
    mod.recordDiscoveredContextWindow('rt-over', 2)
    expect(mod.getDiscoveredContextWindow('rt-over')).toBe(2)
  })

  test('max output tokens is a separate map', () => {
    mod.recordDiscoveredMaxOutputTokens('rt-out', 65_536)
    expect(mod.getDiscoveredMaxOutputTokens('rt-out')).toBe(65_536)
    expect(mod.getDiscoveredContextWindow('rt-out')).toBeUndefined()
    expect(mod.getDiscoveredMaxOutputTokens('rt-never-seen')).toBeUndefined()
  })
})

describe('discoverOpenAICompatibleModelOptions — provider gate', () => {
  test('no active profile (firstParty) returns [] without a request', async () => {
    const calls = stubAxios({})
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('an openai_compat profile tagged nvidia-nim (not "openai") returns [] without a request', async () => {
    useProfile('https://integrate.api.nvidia.com/v1')
    const calls = stubAxios({})
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('an anthropic profile returns [] without a request', async () => {
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        { id: 'a', name: 'A', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x' },
      ],
      activeProviderProfileId: 'a',
    }))
    invalidateActiveProviderCache()
    const calls = stubAxios({})
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('discoverOpenAICompatibleModelOptions — URLs, headers, timeout', () => {
  test('a base ending in /v1 asks only {base}/models, with a 5s timeout and no auth when there is no key', async () => {
    useProfile('http://llm.test/v1')
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'url-a' }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual(['http://llm.test/v1/models'])
    expect(calls[0]!.config).toEqual({ headers: {}, timeout: 5000 })
  })

  test('trailing slashes on the base are dropped', async () => {
    useProfile('http://llm.test/v1///')
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'url-b' }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual(['http://llm.test/v1/models'])
  })

  test('a base without /v1 tries {base}/v1/models first, then {base}/models', async () => {
    useProfile('http://llm.test')
    const calls = stubAxios({
      'http://llm.test/v1/models': new Error('404'),
      'http://llm.test/models': { data: { data: [{ id: 'url-c' }] } },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual(['http://llm.test/v1/models', 'http://llm.test/models'])
    expect(options.map(o => o.value)).toEqual(['url-c'])
  })

  test('an empty first answer also falls through to the second URL', async () => {
    useProfile('http://llm.test')
    const calls = stubAxios({
      'http://llm.test/v1/models': { data: { data: [] } },
      'http://llm.test/models': { data: { data: [{ id: 'url-d' }] } },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(calls).toHaveLength(2)
    expect(options.map(o => o.value)).toEqual(['url-d'])
  })

  test('the first non-empty answer wins; the second URL is not asked', async () => {
    useProfile('http://llm.test')
    const calls = stubAxios({
      'http://llm.test/v1/models': { data: { data: [{ id: 'url-e' }] } },
      'http://llm.test/models': { data: { data: [{ id: 'url-never' }] } },
    })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual(['http://llm.test/v1/models'])
  })

  test('an API key is sent as a trimmed Bearer token', async () => {
    useProfile('http://llm.test/v1', '  sk-test  ')
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'hdr-a' }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls[0]!.config.headers).toEqual({ Authorization: 'Bearer sk-test' })
  })

  test('a whitespace-only API key sends no auth', async () => {
    useProfile('http://llm.test/v1', '   ')
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'hdr-b' }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls[0]!.config.headers).toEqual({})
  })

  test('a host containing "bankr" gets X-API-Key instead of Authorization', async () => {
    useProfile('https://llm.bankr.bot/v1', 'bk-key')
    const calls = stubAxios({ 'https://llm.bankr.bot/v1/models': { data: { data: [{ id: 'hdr-c' }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls[0]!.config.headers).toEqual({ 'X-API-Key': 'bk-key' })
  })

  test('an Azure host gets both Authorization and api-key', async () => {
    useProfile('https://res.openai.azure.com/openai/v1', 'az-key')
    const calls = stubAxios({
      'https://res.openai.azure.com/openai/v1/models': { data: { data: [{ id: 'hdr-d' }] } },
    })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls[0]!.config.headers).toEqual({ Authorization: 'Bearer az-key', 'api-key': 'az-key' })
  })

  test('a cognitiveservices.azure.com host counts as Azure too', async () => {
    useProfile('https://res.cognitiveservices.azure.com/openai/v1', 'az-key')
    const calls = stubAxios({
      'https://res.cognitiveservices.azure.com/openai/v1/models': { data: { data: [{ id: 'hdr-e' }] } },
    })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls[0]!.config.headers?.['api-key']).toBe('az-key')
  })

  test('OPENAI_API_VERSION is appended as api-version on an Azure host, to both URLs', async () => {
    process.env.OPENAI_API_VERSION = ' 2024-10-21 '
    useProfile('https://res.openai.azure.com/openai')
    const calls = stubAxios({
      'https://res.openai.azure.com/openai/v1/models?api-version=2024-10-21': new Error('404'),
      'https://res.openai.azure.com/openai/models?api-version=2024-10-21': {
        data: { data: [{ id: 'ver-a' }] },
      },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual([
      'https://res.openai.azure.com/openai/v1/models?api-version=2024-10-21',
      'https://res.openai.azure.com/openai/models?api-version=2024-10-21',
    ])
    expect(options.map(o => o.value)).toEqual(['ver-a'])
  })

  test('OPENAI_API_VERSION is ignored on a non-Azure host', async () => {
    process.env.OPENAI_API_VERSION = '2024-10-21'
    useProfile('http://llm.test/v1')
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'ver-b' }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual(['http://llm.test/v1/models'])
  })
})

describe('discoverOpenAICompatibleModelOptions — parsing /models', () => {
  test('builds value/label/description, trims ids and names, drops blank and duplicate ids', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': {
        data: {
          data: [
            { id: '  parse-a  ', name: '  Parse A  ' },
            { id: 'parse-b', name: '   ' },
            { id: 'parse-c', name: null },
            { id: 'parse-a', name: 'duplicate is dropped' },
            { id: '' },
            { id: '   ' },
            { id: null },
            { name: 'no id' },
          ],
        },
      },
    })
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([
      { value: 'parse-a', label: 'Parse A', description: 'parse-a' },
      { value: 'parse-b', label: 'parse-b', description: 'parse-b' },
      { value: 'parse-c', label: 'parse-c', description: 'parse-c' },
    ])
  })

  test('sorts by the provider prefix before the first "/", then by the whole id', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': {
        data: {
          data: [
            { id: 'z-sort' },
            { id: 'openai/sort-b' },
            { id: 'anthropic/sort-z' },
            { id: 'openai/sort-a' },
            { id: 'meta/sort-m' },
          ],
        },
      },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(options.map(o => o.value)).toEqual([
      'anthropic/sort-z',
      'meta/sort-m',
      'openai/sort-a',
      'openai/sort-b',
      'z-sort',
    ])
  })

  test('context_length is recorded and rendered in the description (M / K / raw)', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': {
        data: {
          data: [
            { id: 'ctx-1m', context_length: 1_000_000 },
            { id: 'ctx-frac-m', context_length: 1_048_576 },
            { id: 'ctx-128k', context_length: 131_072 },
            { id: 'ctx-round', context_length: 1_500 },
            { id: 'ctx-small', context_length: 512 },
          ],
        },
      },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    const byId = Object.fromEntries(options.map(o => [o.value, o.description]))
    expect(byId).toEqual({
      'ctx-1m': 'ctx-1m · 1M ctx',
      'ctx-frac-m': 'ctx-frac-m · 1.048576M ctx',
      'ctx-128k': 'ctx-128k · 131K ctx',
      'ctx-round': 'ctx-round · 2K ctx',
      'ctx-small': 'ctx-small · 512 ctx',
    })
    expect(mod.getDiscoveredContextWindow('ctx-1m')).toBe(1_000_000)
    expect(mod.getDiscoveredContextWindow('ctx-frac-m')).toBe(1_048_576)
    expect(mod.getDiscoveredContextWindow('ctx-128k')).toBe(131_072)
    expect(mod.getDiscoveredContextWindow('ctx-round')).toBe(1_500)
    expect(mod.getDiscoveredContextWindow('ctx-small')).toBe(512)
  })

  test('a zero, null or missing context_length is neither recorded nor rendered', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': {
        data: {
          data: [
            { id: 'ctx-zero', context_length: 0 },
            { id: 'ctx-null', context_length: null },
            { id: 'ctx-missing' },
          ],
        },
      },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(options.map(o => o.description)).toEqual(['ctx-missing', 'ctx-null', 'ctx-zero'])
    expect(mod.getDiscoveredContextWindow('ctx-zero')).toBeUndefined()
    expect(mod.getDiscoveredContextWindow('ctx-null')).toBeUndefined()
    expect(mod.getDiscoveredContextWindow('ctx-missing')).toBeUndefined()
  })

  test('a negative context_length is neither recorded nor rendered in the description', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'ctx-neg', context_length: -5 }] } } })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(options[0]!.description).toBe('ctx-neg')
    expect(mod.getDiscoveredContextWindow('ctx-neg')).toBeUndefined()
  })

  // Groq, LM Studio, vLLM and llama.cpp name the field differently; reading
  // only context_length left them on the 128k fallback, so autocompact fired
  // late or never and the server rejected the prompt first.
  test('reads context_window, max_context_length and max_model_len', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': {
        data: {
          data: [
            { id: 'field-groq', context_window: 131_072 },
            { id: 'field-lmstudio', max_context_length: 32_768 },
            { id: 'field-vllm', max_model_len: 65_536 },
            { id: 'field-llamacpp', meta: { n_ctx_train: 262_144 } },
          ],
        },
      },
    })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(mod.getDiscoveredContextWindow('field-groq')).toBe(131_072)
    expect(mod.getDiscoveredContextWindow('field-lmstudio')).toBe(32_768)
    expect(mod.getDiscoveredContextWindow('field-vllm')).toBe(65_536)
    // llama.cpp's n_ctx_train is the context the model was TRAINED with, not
    // the -c the server runs with; taken as the window, it overstates it.
    expect(mod.getDiscoveredContextWindow('field-llamacpp')).toBeUndefined()
  })

  // The first POSITIVE number wins: a 0 or -1 placeholder must not hide a real
  // window behind it, and a string is not a window.
  test('skips a placeholder or a string for the next field', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': {
        data: {
          data: [
            { id: 'pos-zero', context_length: 0, max_model_len: 32_768 },
            { id: 'pos-neg', context_length: -1, max_context_length: 16_384 },
            { id: 'pos-str', max_model_len: '32768' },
          ],
        },
      },
    })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(mod.getDiscoveredContextWindow('pos-zero')).toBe(32_768)
    expect(mod.getDiscoveredContextWindow('pos-neg')).toBe(16_384)
    expect(mod.getDiscoveredContextWindow('pos-str')).toBeUndefined()
  })

  test('context_length wins even when other fields are present', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': {
        data: { data: [{ id: 'field-both', context_length: 8_192, max_model_len: 65_536 }] },
      },
    })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(mod.getDiscoveredContextWindow('field-both')).toBe(8_192)
  })

  test('the map is never cleared: a later listing without the field keeps the old window', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'stale-a', context_length: 4_096 }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    ;(axios.get as unknown as { mockRestore: () => void }).mockRestore()
    stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'stale-a' }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(mod.getDiscoveredContextWindow('stale-a')).toBe(4_096)
  })

  test('a later listing with a new context_length overwrites the window', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'over-a', context_length: 4_096 }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    ;(axios.get as unknown as { mockRestore: () => void }).mockRestore()
    stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'over-a', context_length: 8_192 }] } } })
    await mod.discoverOpenAICompatibleModelOptions()
    expect(mod.getDiscoveredContextWindow('over-a')).toBe(8_192)
  })

  test('a body without data (or without data.data) counts as empty', async () => {
    useProfile('http://llm.test')
    const calls = stubAxios({
      'http://llm.test/v1/models': {},
      'http://llm.test/models': { data: {} },
      'http://llm.test/api/tags': { data: {} },
    })
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([])
    expect(calls).toHaveLength(3)
  })

  test('a non-string id throws inside the loop and discards the whole page', async () => {
    useProfile('http://llm.test')
    const calls = stubAxios({
      'http://llm.test/v1/models': { data: { data: [{ id: 'page-ok', context_length: 1_000 }, { id: 42 }] } },
      'http://llm.test/models': { data: { data: [{ id: 'page-second' }] } },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(calls).toHaveLength(2)
    expect(options.map(o => o.value)).toEqual(['page-second'])
    // The rows before the bad one were already recorded before the throw.
    expect(mod.getDiscoveredContextWindow('page-ok')).toBe(1_000)
  })
})

describe('discoverOpenAICompatibleModelOptions — Ollama /api/tags fallback', () => {
  test('when every /models URL is empty or fails, asks /api/tags on the origin (dropping /v1), with the same headers', async () => {
    useProfile('http://localhost:11434/v1', 'ol-key')
    const calls = stubAxios({
      'http://localhost:11434/v1/models': new Error('ECONNREFUSED'),
      'http://localhost:11434/api/tags': {
        data: {
          models: [
            { name: ' qwen3:8b ' },
            { name: 'qwen3:8b' },
            { name: '' },
            { name: null },
            {},
            { name: 'llama3:latest' },
          ],
        },
      },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual([
      'http://localhost:11434/v1/models',
      'http://localhost:11434/api/tags',
    ])
    expect(calls[1]!.config).toEqual({ headers: { Authorization: 'Bearer ol-key' }, timeout: 5000 })
    // Ollama names keep the server's order: no sort on this path.
    expect(options).toEqual([
      { value: 'qwen3:8b', label: 'qwen3:8b', description: 'Ollama model' },
      { value: 'llama3:latest', label: 'llama3:latest', description: 'Ollama model' },
    ])
  })

  test('a path prefix before /v1 is kept in the tags URL', async () => {
    useProfile('http://gpu.test/proxy/v1')
    const calls = stubAxios({
      'http://gpu.test/proxy/v1/models': { data: { data: [] } },
      'http://gpu.test/proxy/api/tags': { data: { models: [{ name: 'tag-a' }] } },
    })
    const options = await mod.discoverOpenAICompatibleModelOptions()
    expect(calls.map(c => c.url)).toEqual([
      'http://gpu.test/proxy/v1/models',
      'http://gpu.test/proxy/api/tags',
    ])
    expect(options.map(o => o.value)).toEqual(['tag-a'])
  })

  test('a base at the root (no /v1) asks /api/tags at the origin', async () => {
    useProfile('http://gpu.test')
    const calls = stubAxios({
      'http://gpu.test/v1/models': new Error('404'),
      'http://gpu.test/models': new Error('404'),
      'http://gpu.test/api/tags': { data: { models: [] } },
    })
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([])
    expect(calls.at(-1)!.url).toBe('http://gpu.test/api/tags')
  })

  test('a failing /api/tags returns []', async () => {
    useProfile('http://gpu.test/v1')
    stubAxios({
      'http://gpu.test/v1/models': new Error('500'),
      'http://gpu.test/api/tags': new Error('500'),
    })
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([])
  })

  test('an unparseable base URL fails both /models URLs and skips /api/tags', async () => {
    useProfile('not a url')
    const calls = stubAxios({})
    expect(await mod.discoverOpenAICompatibleModelOptions()).toEqual([])
    expect(calls.map(c => c.url)).toEqual(['not a url/v1/models', 'not a url/models'])
  })

  test('an unparseable base URL is neither Bankr nor Azure: plain Bearer, no api-version', async () => {
    process.env.OPENAI_API_VERSION = '2024-10-21'
    useProfile('not a url', 'k')
    const calls = stubAxios({})
    await mod.discoverOpenAICompatibleModelOptions()
    expect(calls[0]!.url).toBe('not a url/v1/models')
    expect(calls[0]!.config.headers).toEqual({ Authorization: 'Bearer k' })
  })
})

describe('prefetchOpenAICompatibleModels', () => {
  test('on an openai: scope, discovered options are written to the active profile cache', async () => {
    useProfile('http://llm.test/v1')
    stubAxios({
      'http://llm.test/v1/models': { data: { data: [{ id: 'pre-b' }, { id: 'pre-a', context_length: 2_000 }] } },
    })
    await mod.prefetchOpenAICompatibleModels()
    expect(providerProfiles.getActiveOpenAIModelOptionsCache()).toEqual([
      { value: 'pre-a', label: 'pre-a', description: 'pre-a · 2K ctx' },
      { value: 'pre-b', label: 'pre-b', description: 'pre-b' },
    ])
    expect(mod.getDiscoveredContextWindow('pre-a')).toBe(2_000)
  })

  test('concurrent calls share one in-flight promise and one request; the next call starts a new one', async () => {
    useProfile('http://llm.test/v1')
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'pre-c' }] } } })
    const first = mod.prefetchOpenAICompatibleModels()
    const second = mod.prefetchOpenAICompatibleModels()
    expect(second).toBe(first)
    await first
    expect(calls).toHaveLength(1)
    const third = mod.prefetchOpenAICompatibleModels()
    expect(third).not.toBe(first)
    await third
    expect(calls).toHaveLength(2)
  })

  test('an empty discovery leaves the existing cache untouched', async () => {
    useProfile('http://llm.test/v1')
    const seeded: ModelOption[] = [{ value: 'seeded', label: 'seeded', description: 'seeded' }]
    providerProfiles.setActiveOpenAIModelOptionsCache(seeded)
    stubAxios({
      'http://llm.test/v1/models': new Error('timeout of 5000ms exceeded'),
      'http://llm.test/api/tags': new Error('timeout of 5000ms exceeded'),
    })
    await mod.prefetchOpenAICompatibleModels()
    expect(providerProfiles.getActiveOpenAIModelOptionsCache()).toEqual(seeded)
  })

  test('a throw while writing the cache is swallowed and the latch is released', async () => {
    useProfile('http://llm.test/v1')
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'pre-d' }] } } })
    const setSpy = spyOn(providerProfiles, 'setActiveOpenAIModelOptionsCache').mockImplementation(() => {
      throw new Error('disk full')
    })
    try {
      await expect(mod.prefetchOpenAICompatibleModels()).resolves.toBeUndefined()
      expect(setSpy).toHaveBeenCalledTimes(1)
    } finally {
      setSpy.mockRestore()
    }
    await mod.prefetchOpenAICompatibleModels()
    expect(calls).toHaveLength(2)
  })

  // MUST stay last: the early return below sits OUTSIDE the try/finally that
  // clears `prefetchPromise`, so after it every later call in this process
  // gets the same settled promise and never fetches again.
  test('a non-openai scope returns early, and that early return latches the promise for good', async () => {
    const calls = stubAxios({ 'http://llm.test/v1/models': { data: { data: [{ id: 'pre-latched' }] } } })
    // No profile → scope 'firstParty'.
    const latched = mod.prefetchOpenAICompatibleModels()
    await latched
    expect(calls).toHaveLength(0)

    useProfile('http://llm.test/v1')
    const again = mod.prefetchOpenAICompatibleModels()
    expect(again).toBe(latched)
    await again
    expect(calls).toHaveLength(0)
    expect(providerProfiles.getActiveOpenAIModelOptionsCache()).toEqual([])
  })
})
