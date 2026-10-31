/**
 * Characterization of the Ollama /api/tags discovery behind the /model picker,
 * pinned before the module grows the /api/show reader.
 *
 * The network is a stubbed `globalThis.fetch` (saved and restored), the active
 * provider is switched through the real resolver (the global config lives in
 * memory under `bun test`), and nothing is `mock.module`d.
 *
 * The module keeps its cache in two module-level `let`s and exposes no reset,
 * and nothing else under `bun test` calls `prefetchOllamaModels` (its only
 * caller is the startup sequence). So the cache tests run as ONE ordered
 * lifecycle on the shared instance: empty → failure → empty answer → in flight
 * → filled → never refetched. Each step leaves the state the next one needs.
 *
 * Not a fresh `import('./ollamaModels.js?ts=…')` per test: Bun's coverage
 * reports only the last-loaded instance of a module, so per-test copies made
 * the percentage depend on which file of the run loaded the module last.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { _resetOllamaModelInfoForTesting } from 'src/providers/model/ollamaModelInfo.js'
import * as mod from 'src/providers/model/ollamaModels.js'

type FetchType = typeof globalThis.fetch
type FetchCall = { url: string; init: RequestInit | undefined }

const originalFetch = globalThis.fetch
const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL

function useProfile(baseUrl: string): void {
  const profile: ProviderProfile = {
    id: 'ollama-test',
    name: 'Ollama',
    provider: 'openai',
    baseUrl,
    model: 'qwen3:8b',
  }
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

/** Records every call and answers with `respond`. */
function stubFetch(respond: (call: FetchCall) => Promise<Response> | Response): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    return respond(call)
  }) as FetchType
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const TAGS = {
  models: [
    {
      name: 'qwen3:8b',
      size: 5_200_000_000,
      details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M', family: 'qwen3' },
    },
    // No details and no size: the generic description.
    { name: 'bare:latest' },
    // Only a size.
    { name: 'sized:latest', size: 1_000_000_000 },
    // Nameless rows are dropped.
    { size: 42 },
    { name: '' },
  ],
}

beforeEach(() => {
  delete process.env.OLLAMA_BASE_URL
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL
  else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

describe('isOllamaProvider', () => {
  test('OLLAMA_BASE_URL alone is enough, whatever the profile', () => {
    useProfile('https://api.openai.com/v1')
    process.env.OLLAMA_BASE_URL = 'http://gpu-box:9999'
    expect(mod.isOllamaProvider()).toBe(true)
  })

  test('a profile on port 11434 is Ollama, on any host and path', () => {
    useProfile('http://localhost:11434/v1')
    expect(mod.isOllamaProvider()).toBe(true)
    useProfile('http://192.168.1.20:11434')
    expect(mod.isOllamaProvider()).toBe(true)
  })

  test('any other port is not', () => {
    useProfile('http://localhost:1234/v1')
    expect(mod.isOllamaProvider()).toBe(false)
    useProfile('https://api.openai.com/v1')
    expect(mod.isOllamaProvider()).toBe(false)
  })

  test('no active profile is not Ollama', () => {
    expect(mod.isOllamaProvider()).toBe(false)
  })

  test('an unparseable base URL is not Ollama (and does not throw)', () => {
    useProfile('not a url')
    expect(mod.isOllamaProvider()).toBe(false)
  })
})

describe('fetchOllamaModels', () => {
  test('GETs /api/tags on the default local server when nothing is configured', async () => {
    const calls = stubFetch(() => jsonResponse({ models: [] }))
    await mod.fetchOllamaModels()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://localhost:11434/api/tags')
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('derives the API root from OLLAMA_BASE_URL, dropping a /v1 suffix, query and slash', async () => {
    const calls = stubFetch(() => jsonResponse({ models: [] }))
    process.env.OLLAMA_BASE_URL = 'http://gpu-box:11434/v1/?x=1#frag'
    await mod.fetchOllamaModels()
    process.env.OLLAMA_BASE_URL = 'http://gpu-box:11434/ollama/'
    await mod.fetchOllamaModels()
    expect(calls.map(c => c.url)).toEqual([
      'http://gpu-box:11434/api/tags',
      'http://gpu-box:11434/ollama/api/tags',
    ])
  })

  test('the profile base URL is NOT what it asks (only OLLAMA_BASE_URL or the default)', async () => {
    useProfile('http://192.168.1.20:11434/v1')
    const calls = stubFetch(() => jsonResponse({ models: [] }))
    await mod.fetchOllamaModels()
    expect(calls[0]!.url).toBe('http://localhost:11434/api/tags')
  })

  test('maps tags to picker options with size, quant and parameter count', async () => {
    stubFetch(() => jsonResponse(TAGS))
    expect(await mod.fetchOllamaModels()).toEqual([
      {
        value: 'qwen3:8b',
        label: 'qwen3:8b',
        description: 'Ollama · 8.2B · Q4_K_M · 5.2GB',
      },
      { value: 'bare:latest', label: 'bare:latest', description: 'Ollama model' },
      { value: 'sized:latest', label: 'sized:latest', description: 'Ollama · 1.0GB' },
    ])
  })

  test('a payload without `models` is an empty list', async () => {
    stubFetch(() => jsonResponse({}))
    expect(await mod.fetchOllamaModels()).toEqual([])
  })

  test('a non-OK status is an empty list, and the body is never read', async () => {
    let bodyRead = false
    stubFetch(() => {
      const res = new Response('nope', { status: 500 })
      const json = res.json.bind(res)
      res.json = () => {
        bodyRead = true
        return json()
      }
      return res
    })
    expect(await mod.fetchOllamaModels()).toEqual([])
    expect(bodyRead).toBe(false)
  })

  test('a network error is an empty list', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed: ECONNREFUSED')))
    expect(await mod.fetchOllamaModels()).toEqual([])
  })

  test('a body that is not JSON is an empty list', async () => {
    stubFetch(() => new Response('<html>', { status: 200 }))
    expect(await mod.fetchOllamaModels()).toEqual([])
  })

  test('an aborted request is an empty list', async () => {
    stubFetch(() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')))
    expect(await mod.fetchOllamaModels()).toEqual([])
  })

  test('the request is aborted by a 5s timer, which is cleared afterwards', async () => {
    // Compress the module's 5000ms timer to 0 instead of waiting it out, so
    // the abort wiring is exercised for real.
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const delays: number[] = []
    const cleared: unknown[] = []
    let handle: unknown
    const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      cb: () => void,
      ms?: number,
    ) => {
      if (ms === 5000) {
        delays.push(ms)
        handle = realSetTimeout(cb, 0)
        return handle
      }
      return realSetTimeout(cb, ms)
    }) as typeof setTimeout)
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((
      id: Parameters<typeof clearTimeout>[0],
    ) => {
      cleared.push(id)
      realClearTimeout(id)
    }) as typeof clearTimeout)

    let signal: AbortSignal | undefined
    try {
      stubFetch(
        ({ init }) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined
            signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            )
          }),
      )
      expect(await mod.fetchOllamaModels()).toEqual([])
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
    expect(delays).toEqual([5000])
    expect(signal?.aborted).toBe(true)
    expect(cleared).toContain(handle)
  })
})

describe('prefetchOllamaModels and the cache (one ordered lifecycle)', () => {
  test('1. the cache starts empty', () => {
    expect(mod.getCachedOllamaModelOptions()).toEqual([])
  })

  test('2. off Ollama it does nothing', async () => {
    useProfile('https://api.openai.com/v1')
    const calls = stubFetch(() => jsonResponse(TAGS))
    mod.prefetchOllamaModels()
    await Bun.sleep(0)
    expect(calls).toHaveLength(0)
    expect(mod.getCachedOllamaModelOptions()).toEqual([])
  })

  test('3. a failed fetch leaves the cache empty', async () => {
    useProfile('http://localhost:11434/v1')
    const calls = stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    mod.prefetchOllamaModels()
    await Bun.sleep(0)
    expect(calls.filter(c => c.url.endsWith('/api/tags'))).toHaveLength(1)
    expect(mod.getCachedOllamaModelOptions()).toEqual([])
  })

  test('3b. an Ollama profile also asks for its model\'s info (thinking, context)', async () => {
    useProfile('http://localhost:11434/v1')
    // Step 3 already asked (and failed); a failure is remembered per model.
    _resetOllamaModelInfoForTesting()
    const calls = stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    mod.prefetchOllamaModels()
    await Bun.sleep(0)
    const show = calls.find(c => c.url.endsWith('/api/show'))
    expect(show && JSON.parse(String(show.init?.body))).toEqual({ model: 'qwen3:8b' })
    _resetOllamaModelInfoForTesting()
  })

  test('4. so does an empty answer, and the next call asks again', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    const calls = stubFetch(() => jsonResponse({ models: [] }))
    mod.prefetchOllamaModels()
    await Bun.sleep(0)
    mod.prefetchOllamaModels()
    await Bun.sleep(0)
    expect(calls).toHaveLength(2)
    expect(mod.getCachedOllamaModelOptions()).toEqual([])
  })

  test('5. a second call while one is in flight does not fetch again; the answer fills the cache', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    let release: (res: Response) => void = () => {}
    const calls = stubFetch(
      () =>
        new Promise<Response>(resolve => {
          release = resolve
        }),
    )
    mod.prefetchOllamaModels()
    mod.prefetchOllamaModels()
    expect(calls).toHaveLength(1)
    expect(mod.getCachedOllamaModelOptions()).toEqual([])
    release(jsonResponse(TAGS))
    await Bun.sleep(0)
    expect(mod.getCachedOllamaModelOptions().map(o => o.value)).toEqual([
      'qwen3:8b',
      'bare:latest',
      'sized:latest',
    ])
  })

  test('6. a filled cache is never refetched', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    const calls = stubFetch(() => jsonResponse({ models: [] }))
    mod.prefetchOllamaModels()
    await Bun.sleep(0)
    expect(calls).toHaveLength(0)
    expect(mod.getCachedOllamaModelOptions()).toHaveLength(3)
  })
})
