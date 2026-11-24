/**
 * The ChatGPT account's model list: what is asked, what is kept, and when the
 * catalog takes it. Profiles go through the real resolver (the global config
 * lives in memory under `bun test`); the network is the injected fetch, or a
 * stubbed globalThis.fetch for the default dependencies. No module is mocked.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import {
  getCodexAccountCatalog,
  getCodexAccountLimits,
} from 'src/providers/model/codexModelCatalog.js'
import {
  CODEX_MODELS_CLIENT_VERSION,
  _resetCodexAccountModelsForTesting,
  fetchCodexAccountModels,
  prefetchCodexAccountModels,
  toCodexAccountModels,
  type CodexModelsDeps,
} from 'src/providers/model/codexModelRefresh.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'

const CODEX: ProviderProfile = {
  id: 'refresh-codex',
  name: 'Codex OAuth',
  provider: 'openai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'codexplan',
  apiKey: 'sk-refresh',
}
const OTHER_CODEX: ProviderProfile = { ...CODEX, id: 'refresh-codex-2', name: 'Codex OAuth 2' }
const OPENAI: ProviderProfile = {
  id: 'refresh-openai',
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-terra',
  apiKey: 'sk-openai',
}

// What the backend answered a free plan on 2026-11-24 (~/.codex/models_cache.json),
// trimmed to the fields read, plus one it ignores.
const FREE_PLAN_RESPONSE = {
  models: [
    {
      slug: 'gpt-reserve',
      visibility: 'hide',
      priority: 1,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
      context_window: 272000,
    },
    {
      slug: 'gpt-5.6-terra',
      description: 'Legacy balanced model for agentic coding.',
      visibility: 'list',
      priority: 3,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({
        effort,
        description: `${effort} reasoning`,
      })),
      context_window: 272000,
      max_context_window: 872000,
    },
    {
      slug: 'gpt-6-luna',
      description: 'Fast and affordable model for easier tasks.',
      visibility: 'list',
      priority: 2,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })),
      context_window: 272000,
    },
    {
      slug: 'gpt-5.6-luna',
      description: 'Legacy fast model for simpler tasks.',
      visibility: 'list',
      priority: 4,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })),
      context_window: 272000,
    },
    {
      slug: 'codex-auto-review',
      visibility: 'hide',
      priority: 5,
      context_window: 272000,
    },
  ],
}

type Call = { url: string; init?: RequestInit }

function stubDeps(
  respond: () => Response | Promise<Response>,
  credentials: { apiKey: string; accountId?: string } = { apiKey: 'access-token', accountId: 'acct-1' },
): CodexModelsDeps & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return respond()
    },
    credentials: async () => credentials,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [CODEX, OTHER_CODEX, OPENAI],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

const savedEnv = {
  fetch: process.env.CLAUDIN_CODEX_MODELS_FETCH,
  apiKey: process.env.CODEX_API_KEY,
  accountId: process.env.CODEX_ACCOUNT_ID,
}
const originalFetch = globalThis.fetch

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(() => {
  // The preload turns the fetch off for every other suite.
  process.env.CLAUDIN_CODEX_MODELS_FETCH = '1'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreEnv('CODEX_API_KEY', savedEnv.apiKey)
  restoreEnv('CODEX_ACCOUNT_ID', savedEnv.accountId)
  process.env.CLAUDIN_CODEX_MODELS_FETCH = '1'
  _resetCodexAccountModelsForTesting()
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  restoreEnv('CLAUDIN_CODEX_MODELS_FETCH', savedEnv.fetch)
})

describe('toCodexAccountModels', () => {
  test('keeps what the account shows, in priority order, low to max', () => {
    const entries = toCodexAccountModels(FREE_PLAN_RESPONSE.models)
    expect(entries.map(entry => entry.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(entries[1]).toEqual({
      id: 'gpt-5.6-terra',
      label: 'gpt-5.6-terra',
      description: 'Legacy balanced model for agentic coding.',
      account: {
        contextWindow: 272_000,
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
      },
    })
  })

  test('a model without a window is left out, and the id stands in for a missing description', () => {
    const entries = toCodexAccountModels([
      { slug: 'gpt-no-window', visibility: 'list', priority: 1 },
      { slug: 'gpt-bare', visibility: 'list', context_window: 100_000 },
    ])
    expect(entries).toEqual([
      { id: 'gpt-bare', label: 'gpt-bare', description: 'gpt-bare', account: { contextWindow: 100_000, effortLevels: [] } },
    ])
  })

  test('a default the account cannot send is dropped', () => {
    const [entry] = toCodexAccountModels([
      {
        slug: 'gpt-ultra',
        visibility: 'list',
        default_reasoning_level: 'ultra',
        supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 'high' }],
        context_window: 500_000,
      },
    ])
    expect(entry?.account).toEqual({ contextWindow: 500_000, effortLevels: ['high'] })
  })
})

describe('fetchCodexAccountModels', () => {
  test('asks the backend the way the Codex CLI does, with the account bearer', async () => {
    useProfile(CODEX)
    const deps = stubDeps(() => json(FREE_PLAN_RESPONSE))
    const entries = await fetchCodexAccountModels(deps)
    expect(entries?.map(entry => entry.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0]?.url).toBe(
      `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`,
    )
    expect(deps.calls[0]?.init?.method).toBe('GET')
    expect(deps.calls[0]?.init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer access-token',
      'chatgpt-account-id': 'acct-1',
      originator: 'claudin',
    })
  })

  test('off the Codex backend it asks nothing', async () => {
    useProfile(OPENAI)
    const deps = stubDeps(() => json(FREE_PLAN_RESPONSE))
    expect(await fetchCodexAccountModels(deps)).toBeNull()
    expect(deps.calls).toHaveLength(0)
  })

  test('without an account id it asks nothing', async () => {
    useProfile(CODEX)
    const deps = stubDeps(() => json(FREE_PLAN_RESPONSE), { apiKey: 'access-token' })
    expect(await fetchCodexAccountModels(deps)).toBeNull()
    expect(deps.calls).toHaveLength(0)
  })

  test.each([
    // A list body on purpose: only the status says not to take it.
    ['an error status', () => json(FREE_PLAN_RESPONSE, 500)],
    ['a body that is not the list', () => json({ data: [] })],
    ['an empty list', () => json({ models: [] })],
    ['a failed request', () => Promise.reject(new Error('offline'))],
  ] as const)('%s leaves the snapshot in place', async (_name, respond) => {
    useProfile(CODEX)
    expect(await fetchCodexAccountModels(stubDeps(respond))).toBeNull()
  })

  test('by default, with the profile credentials and the global fetch', async () => {
    useProfile(CODEX)
    process.env.CODEX_API_KEY = 'env-token'
    process.env.CODEX_ACCOUNT_ID = 'acct-env'
    const calls: Call[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return json(FREE_PLAN_RESPONSE)
    }) as typeof fetch
    const entries = await fetchCodexAccountModels()
    expect(entries).toHaveLength(3)
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer env-token',
      'chatgpt-account-id': 'acct-env',
    })
  })
})

describe('prefetchCodexAccountModels', () => {
  function stubGlobalFetch(respond: () => Response | Promise<Response>): Call[] {
    process.env.CODEX_API_KEY = 'env-token'
    process.env.CODEX_ACCOUNT_ID = 'acct-env'
    const calls: Call[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return respond()
    }) as typeof fetch
    return calls
  }

  test('puts the account list in the catalog', async () => {
    useProfile(CODEX)
    stubGlobalFetch(() => json(FREE_PLAN_RESPONSE))
    await prefetchCodexAccountModels()
    expect(getCodexAccountCatalog().map(entry => entry.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(getCodexAccountLimits('gpt-6.2-sol')).toBeUndefined()
  })

  test('asks once per profile, and again when forced', async () => {
    useProfile(CODEX)
    const calls = stubGlobalFetch(() => json(FREE_PLAN_RESPONSE))
    await prefetchCodexAccountModels()
    await prefetchCodexAccountModels()
    expect(calls).toHaveLength(1)
    await prefetchCodexAccountModels({ force: true })
    expect(calls).toHaveLength(2)
  })

  test('the killswitch keeps the snapshot and asks nothing', async () => {
    process.env.CLAUDIN_CODEX_MODELS_FETCH = '0'
    useProfile(CODEX)
    const calls = stubGlobalFetch(() => json(FREE_PLAN_RESPONSE))
    await prefetchCodexAccountModels()
    expect(calls).toHaveLength(0)
    expect(getCodexAccountCatalog()).toHaveLength(11)
  })

  test('a switch to another profile drops the list and asks for the new one', async () => {
    useProfile(CODEX)
    const calls = stubGlobalFetch(() => json(FREE_PLAN_RESPONSE))
    await prefetchCodexAccountModels()
    expect(getCodexAccountCatalog()).toHaveLength(3)

    // The config listener sees the switch: off the backend the list goes.
    useProfile(OPENAI)
    expect(getCodexAccountCatalog()).toHaveLength(11)

    // And back on another Codex profile, its own list is asked for.
    useProfile(OTHER_CODEX)
    await Bun.sleep(0)
    await prefetchCodexAccountModels()
    expect(calls).toHaveLength(2)
    expect(getCodexAccountCatalog()).toHaveLength(3)
  })

  test('a list that arrives after a profile switch is dropped', async () => {
    useProfile(CODEX)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    stubGlobalFetch(async () => {
      await gate
      return json(FREE_PLAN_RESPONSE)
    })
    const inFlight = prefetchCodexAccountModels()
    useProfile(OPENAI)
    release()
    await inFlight
    expect(getCodexAccountCatalog()).toHaveLength(11)
  })

  test('a failed fetch is not retried on every config save', async () => {
    useProfile(CODEX)
    const calls = stubGlobalFetch(() => json({ detail: 'no' }, 500))
    await prefetchCodexAccountModels()
    expect(calls).toHaveLength(1)
    // A config save that does not change the profile.
    saveGlobalConfig(current => ({ ...current, numStartups: (current.numStartups ?? 0) + 1 }))
    await Bun.sleep(0)
    expect(calls).toHaveLength(1)
  })
})

describe('wiring', () => {
  test('startup asks for the list, beside the Copilot catalog', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../platform/main/action/startupSequence.ts'),
      'utf8',
    )
    expect(source).toContain('void prefetchCodexAccountModels();')
  })
})
