import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  _resetOllamaModelInfoForTesting,
  _setOllamaModelInfoForTesting,
  getCachedOllamaModelInfo,
  isOllamaBaseUrl,
  loadOllamaModelInfo,
  ollamaThinkingIsToggleOnly,
  parseModelfileParameters,
  parseOllamaModelInfo,
  refreshOllamaLoadedContext,
} from 'src/providers/model/ollamaModelInfo.js'

type FetchType = typeof globalThis.fetch
type Call = { url: string; init?: RequestInit }

const BASE = 'http://localhost:11434/v1'
const originalFetch = globalThis.fetch

// The discovered-window map is process-wide with no reset: unique model ids.
let uniq = 0
function model(base: string): string {
  uniq += 1
  return `${base}-mi-${uniq}:latest`
}

function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    return respond(call)
  }) as FetchType
  return calls
}

const QWEN_SHOW = {
  capabilities: ['completion', 'vision', 'tools', 'thinking'],
  parameters: 'top_k                          20\ntop_p                          0.95\nnum_ctx                        262144\ntemperature                    0.6\nstop                           "<|im_end|>"',
  details: { family: 'qwen35moe' },
}

beforeEach(() => {
  _resetOllamaModelInfoForTesting()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _resetOllamaModelInfoForTesting()
})

describe('isOllamaBaseUrl', () => {
  test('Ollama\'s port on any host', () => {
    expect(isOllamaBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isOllamaBaseUrl('http://192.168.1.20:11434')).toBe(true)
    expect(isOllamaBaseUrl('https://ollama.example.com:11434/v1')).toBe(true)
  })

  test('anything else, or nothing', () => {
    expect(isOllamaBaseUrl('http://localhost:8080/v1')).toBe(false)
    expect(isOllamaBaseUrl('https://example.com/11434')).toBe(false)
    expect(isOllamaBaseUrl(undefined)).toBe(false)
    expect(isOllamaBaseUrl('not a url')).toBe(false)
  })
})

describe('parseModelfileParameters', () => {
  test('numeric parameters, one per line; strings ignored', () => {
    expect(parseModelfileParameters(QWEN_SHOW.parameters)).toEqual({
      top_k: 20,
      top_p: 0.95,
      num_ctx: 262144,
      temperature: 0.6,
    })
  })

  test('no parameters', () => {
    expect(parseModelfileParameters(undefined)).toEqual({})
    expect(parseModelfileParameters(42)).toEqual({})
  })
})

describe('parseOllamaModelInfo', () => {
  test('a thinking qwen: on/off only, Modelfile sampling and num_ctx', () => {
    expect(parseOllamaModelInfo(QWEN_SHOW)).toEqual({
      thinking: true,
      thinkingLevels: false,
      contextWindow: 262144,
      temperature: 0.6,
      topP: 0.95,
    })
  })

  test('gpt-oss thinks in levels', () => {
    const info = parseOllamaModelInfo({ capabilities: ['completion', 'thinking'], details: { family: 'gptoss' } })
    expect(info.thinkingLevels).toBe(true)
  })

  test('a family with levels but no thinking capability has none', () => {
    const info = parseOllamaModelInfo({ capabilities: ['completion'], details: { family: 'gptoss' } })
    expect(info).toEqual({ thinking: false, thinkingLevels: false, contextWindow: undefined, temperature: undefined, topP: undefined })
  })

  test('the loaded runner\'s context wins over the Modelfile', () => {
    expect(parseOllamaModelInfo(QWEN_SHOW, 65536).contextWindow).toBe(65536)
  })

  test('malformed fields are ignored', () => {
    expect(parseOllamaModelInfo({ capabilities: 'thinking', details: { family: 7 } })).toEqual({
      thinking: false,
      thinkingLevels: false,
      contextWindow: undefined,
      temperature: undefined,
      topP: undefined,
    })
  })
})

describe('loadOllamaModelInfo', () => {
  test('reads /api/show and /api/ps once, and records the loaded context window', async () => {
    const name = model('qwen')
    const calls = stubFetch(call => {
      if (call.url.endsWith('/api/show')) return Response.json(QWEN_SHOW)
      return Response.json({ models: [{ name, model: name, context_length: 131072 }] })
    })

    const info = await loadOllamaModelInfo(BASE, name)

    expect(calls.map(c => c.url)).toEqual(['http://localhost:11434/api/show', 'http://localhost:11434/api/ps'])
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ model: name })
    expect(info?.contextWindow).toBe(131072)
    expect(await loadOllamaModelInfo(BASE, name)).toBe(info)
    expect(calls).toHaveLength(2)
  })

  test('/api/ps names the model without ":latest": still matched', async () => {
    const name = model('qwen')
    stubFetch(call =>
      call.url.endsWith('/api/show')
        ? Response.json(QWEN_SHOW)
        : Response.json({ models: [{ name: name.replace(':latest', ''), context_length: 40960 }] }),
    )
    expect((await loadOllamaModelInfo(BASE, name))?.contextWindow).toBe(40960)
  })

  test('a model /api/ps does not list keeps the Modelfile num_ctx', async () => {
    const name = model('qwen')
    stubFetch(call =>
      call.url.endsWith('/api/show')
        ? Response.json(QWEN_SHOW)
        : Response.json({ models: [{ name: 'other:latest', context_length: 4096 }, { name, context_length: 'big' }] }),
    )
    expect((await loadOllamaModelInfo(BASE, name))?.contextWindow).toBe(262144)
  })

  test('a failing /api/ps does not lose /api/show', async () => {
    const name = model('qwen')
    stubFetch(call =>
      call.url.endsWith('/api/show') ? Response.json(QWEN_SHOW) : Promise.reject(new TypeError('fetch failed')),
    )
    expect((await loadOllamaModelInfo(BASE, name))?.temperature).toBe(0.6)
  })

  test('concurrent callers share one read', async () => {
    const name = model('qwen')
    const calls = stubFetch(call =>
      call.url.endsWith('/api/show') ? Response.json(QWEN_SHOW) : Response.json({ models: [] }),
    )
    const [a, b] = await Promise.all([loadOllamaModelInfo(BASE, name), loadOllamaModelInfo(BASE, name)])
    expect(a).toBe(b)
    expect(calls.filter(c => c.url.endsWith('/api/show'))).toHaveLength(1)
  })

  test('a server that is not Ollama is asked once, then remembered', async () => {
    const name = model('nope')
    const calls = stubFetch(() => new Response('not found', { status: 404 }))
    expect(await loadOllamaModelInfo(BASE, name)).toBeUndefined()
    expect(await loadOllamaModelInfo(BASE, name)).toBeUndefined()
    expect(calls.filter(c => c.url.endsWith('/api/show'))).toHaveLength(1)
    expect(getCachedOllamaModelInfo(name)).toBeUndefined()
  })

  test('a network failure is remembered too', async () => {
    const name = model('down')
    const calls = stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    expect(await loadOllamaModelInfo(BASE, name)).toBeUndefined()
    expect(await loadOllamaModelInfo(BASE, name)).toBeUndefined()
    expect(calls.filter(c => c.url.endsWith('/api/show'))).toHaveLength(1)
  })
})

describe('refreshOllamaLoadedContext', () => {
  test('fills a window the Modelfile did not give, once the runner is loaded', async () => {
    const name = model('bare')
    _setOllamaModelInfoForTesting(name, { thinking: true, thinkingLevels: false })
    stubFetch(() => Response.json({ models: [{ name, context_length: 32768 }] }))

    await refreshOllamaLoadedContext(BASE, name)

    expect(getCachedOllamaModelInfo(name)?.contextWindow).toBe(32768)
  })

  test('nothing to do: no info, or a window already known', async () => {
    const calls = stubFetch(() => Response.json({ models: [] }))
    await refreshOllamaLoadedContext(BASE, model('unknown'))
    const known = model('known')
    _setOllamaModelInfoForTesting(known, { thinking: false, thinkingLevels: false, contextWindow: 8192 })
    await refreshOllamaLoadedContext(BASE, known)
    expect(calls).toHaveLength(0)
  })

  test('still not listed, or /api/ps unreachable: unchanged', async () => {
    const name = model('bare')
    _setOllamaModelInfoForTesting(name, { thinking: false, thinkingLevels: false })
    stubFetch(() => Response.json({ models: [] }))
    await refreshOllamaLoadedContext(BASE, name)
    stubFetch(() => new Response('', { status: 500 }))
    await refreshOllamaLoadedContext(BASE, name)
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    await refreshOllamaLoadedContext(BASE, name)
    expect(getCachedOllamaModelInfo(name)?.contextWindow).toBeUndefined()
  })
})

describe('ollamaThinkingIsToggleOnly', () => {
  test('thinking without levels', () => {
    _setOllamaModelInfoForTesting('a', { thinking: true, thinkingLevels: false })
    _setOllamaModelInfoForTesting('b', { thinking: true, thinkingLevels: true })
    _setOllamaModelInfoForTesting('c', { thinking: false, thinkingLevels: false })
    expect(ollamaThinkingIsToggleOnly('a')).toBe(true)
    expect(ollamaThinkingIsToggleOnly('b')).toBe(false)
    expect(ollamaThinkingIsToggleOnly('c')).toBe(false)
    expect(ollamaThinkingIsToggleOnly('never-read')).toBe(false)
  })
})

// openaiContextWindows.test.ts mock.modules openaiModelDiscovery for the whole
// run, so the hand-off to getContextWindowForModel is pinned on the source.
describe('the context window reaches getContextWindowForModel', () => {
  const source = readFileSync(join(import.meta.dir, 'ollamaModelInfo.ts'), 'utf8')

  test('both readers record what they found', () => {
    expect(source).toContain('if (info.contextWindow) recordDiscoveredContextWindow(model, info.contextWindow)')
    expect(source).toContain('recordDiscoveredContextWindow(model, loaded)')
  })
})
