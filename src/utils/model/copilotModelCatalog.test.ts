import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const realActiveProvider = {
  ...(await import('src/providers/presets/activeProvider.js')),
}
const realActiveProviderSnapshot = { ...realActiveProvider }

type ResolvedProvider =
  | ReturnType<typeof realActiveProvider.getActiveProvider>
  | null

let resolvedOverride: ResolvedProvider = null

mock.module('src/providers/presets/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

afterAll(() => {
  mock.module(
    'src/providers/presets/activeProvider.js',
    () => realActiveProviderSnapshot,
  )
})

const {
  _setCopilotCatalogForTesting,
  copilotModelSupportsAnthropicMessages,
  fetchCopilotModelCatalog,
  getCatalogCopilotContextWindow,
  getCatalogCopilotMaxOutputTokens,
  getCopilotDisplayName,
  getEffectiveCopilotModels,
  normalizeBareCopilotModelId,
  prefetchCopilotModelCatalog,
} = await import('src/utils/model/copilotModelCatalog.js')
const { getAllCopilotModels } = await import('src/utils/model/copilotModels.js')

function setGithubProfile(): void {
  resolvedOverride = {
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
    extras: { githubToken: 'tid=x;exp=9999999999' },
    name: 'GitHub Copilot',
  } as ResolvedProvider
}

afterEach(() => {
  resolvedOverride = null
  _setCopilotCatalogForTesting(null)
})

const API_PAYLOAD = {
  data: [
    {
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6 (live)',
      model_picker_enabled: true,
      supported_endpoints: ['/chat/completions', '/v1/messages'],
      capabilities: {
        family: 'claude-sonnet',
        type: 'chat',
        limits: {
          max_context_window_tokens: 200000,
          max_output_tokens: 32000,
          vision: { max_prompt_images: 5 },
        },
        supports: { tool_calls: true, vision: true, adaptive_thinking: true },
      },
    },
    {
      id: 'gpt-6-preview',
      name: 'GPT-6 Preview',
      model_picker_enabled: true,
      capabilities: {
        family: 'gpt',
        type: 'chat',
        limits: { max_context_window_tokens: 500000, max_output_tokens: 200000 },
        supports: { tool_calls: true, reasoning_effort: ['low', 'high'] },
      },
    },
    {
      id: 'gpt-4o-2024-11-20',
      name: 'GPT-4o (dated)',
      model_picker_enabled: false,
      capabilities: {
        family: 'gpt',
        type: 'chat',
        limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
        supports: { tool_calls: true },
      },
    },
    {
      id: 'text-embedding-3-small',
      name: 'Embeddings',
      capabilities: { type: 'embeddings' },
    },
  ],
}

describe('normalizeBareCopilotModelId', () => {
  test.each([
    ['github:copilot:claude-sonnet-4.6', 'claude-sonnet-4.6'],
    ['github:gpt-4o', 'gpt-4o'],
    ['openai/gpt-4.1', 'gpt-4.1'],
    ['claude-opus-4.7', 'claude-opus-4.7'],
    ['github:copilot:gpt-5.5?reasoning=high', 'gpt-5.5'],
  ] as const)('%s -> %s', (input, expected) => {
    expect(normalizeBareCopilotModelId(input)).toBe(expected)
  })
})

describe('fetchCopilotModelCatalog', () => {
  test('parses /models payload, filters embeddings, keeps dated snapshots out of picker', async () => {
    setGithubProfile()
    const originalFetch = globalThis.fetch
    const seen: { url?: string; auth?: string | null } = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.url = String(input)
      seen.auth = new Headers(init?.headers).get('authorization')
      return new Response(JSON.stringify(API_PAYLOAD), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    try {
      const entries = await fetchCopilotModelCatalog()
      expect(seen.url).toBe('https://api.githubcopilot.com/models')
      expect(seen.auth).toBe('Bearer tid=x;exp=9999999999')
      expect(entries).not.toBeNull()
      const ids = entries!.map(e => e.model.id)
      expect(ids).toEqual([
        'claude-sonnet-4.6',
        'gpt-6-preview',
        'gpt-4o-2024-11-20',
      ])
      const sonnet = entries!.find(e => e.model.id === 'claude-sonnet-4.6')!
      expect(sonnet.supportedEndpoints).toEqual([
        '/chat/completions',
        '/v1/messages',
      ])
      expect(sonnet.model.attachment).toBe(true)
      expect(sonnet.model.reasoning).toBe(true)
      const gpt6 = entries!.find(e => e.model.id === 'gpt-6-preview')!
      expect(gpt6.model.reasoning).toBe(true)
      expect(gpt6.model.limit.context).toBe(500000)
      const dated = entries!.find(e => e.model.id === 'gpt-4o-2024-11-20')!
      expect(dated.pickerEnabled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('returns null when provider is not github_copilot', async () => {
    resolvedOverride = {
      transport: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      name: 'OpenAI',
    } as ResolvedProvider
    expect(await fetchCopilotModelCatalog()).toBeNull()
  })

  test('returns null on HTTP error', async () => {
    setGithubProfile()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('nope', { status: 403 })) as unknown as typeof fetch
    try {
      expect(await fetchCopilotModelCatalog()).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('prefetchCopilotModelCatalog', () => {
  test('in-flight fetch for a previous endpoint cannot poison the cache after a switch', async () => {
    setGithubProfile() // endpoint A: api.githubcopilot.com
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    const resolvers: Array<(r: Response) => void> = []
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Promise<Response>(resolve => {
        resolvers.push(resolve)
      })
    }) as unknown as typeof fetch
    const waitFor = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !cond(); i++) {
        await new Promise(r => setTimeout(r, 1))
      }
    }
    try {
      prefetchCopilotModelCatalog() // fetch #1 in flight, targeting A
      await waitFor(() => urls.length === 1)

      // Sign-in switches to a GHE endpoint while fetch #1 is still in flight.
      resolvedOverride = {
        transport: 'github_copilot',
        baseUrl: 'https://copilot-api.github.acme.com',
        model: 'github:copilot',
        extras: { githubToken: 't' },
        name: 'GHE Copilot',
      } as ResolvedProvider
      prefetchCopilotModelCatalog() // chains a refetch for B behind fetch #1

      // Fetch #1 resolves with endpoint A's models.
      resolvers[0]!(
        new Response(JSON.stringify(API_PAYLOAD), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      await waitFor(() => urls.length === 2)

      // A's payload must have been discarded, and a refetch targets B.
      expect(getCatalogCopilotContextWindow('gpt-6-preview')).toBeUndefined()
      expect(urls[1]).toBe('https://copilot-api.github.acme.com/models')

      // Fetch #2 (endpoint B) resolves → catalog becomes usable for B.
      resolvers[1]!(
        new Response(JSON.stringify(API_PAYLOAD), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      await waitFor(
        () => getCatalogCopilotContextWindow('gpt-6-preview') !== undefined,
      )
      expect(getCatalogCopilotContextWindow('gpt-6-preview')).toBe(500000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('catalog accessors', () => {
  function seedCatalog(): void {
    // Accessors are gated on the active transport being github_copilot.
    setGithubProfile()
    _setCopilotCatalogForTesting([
      {
        model: {
          id: 'claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6 (live)',
          family: 'claude-sonnet',
          attachment: true,
          reasoning: true,
          tool_call: true,
          temperature: true,
          knowledge: '',
          release_date: '',
          last_updated: '',
          modalities: { input: ['text', 'image'], output: ['text'] },
          open_weights: false,
          cost: { input: 0, output: 0 },
          limit: { context: 200000, output: 32000 },
        },
        supportedEndpoints: ['/chat/completions', '/v1/messages'],
        pickerEnabled: true,
      },
      {
        model: {
          id: 'gpt-6-preview',
          name: 'GPT-6 Preview',
          family: 'gpt',
          attachment: false,
          reasoning: true,
          tool_call: true,
          temperature: true,
          knowledge: '',
          release_date: '',
          last_updated: '',
          modalities: { input: ['text'], output: ['text'] },
          open_weights: false,
          cost: { input: 0, output: 0 },
          limit: { context: 500000, output: 200000 },
        },
        supportedEndpoints: ['/chat/completions', '/responses'],
        pickerEnabled: true,
      },
      {
        model: {
          id: 'gpt-4o-2024-11-20',
          name: 'GPT-4o (dated)',
          family: 'gpt',
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
        supportedEndpoints: null,
        pickerEnabled: false,
      },
    ])
  }

  test('getEffectiveCopilotModels falls back to hardcoded registry without catalog', () => {
    expect(getEffectiveCopilotModels()).toEqual(getAllCopilotModels())
  })

  test('getEffectiveCopilotModels uses picker-enabled live models when cached', () => {
    seedCatalog()
    const ids = getEffectiveCopilotModels().map(m => m.id)
    expect(ids).toEqual(['claude-sonnet-4.6', 'gpt-6-preview'])
  })

  test('copilotModelSupportsAnthropicMessages answers from supported_endpoints', () => {
    seedCatalog()
    expect(
      copilotModelSupportsAnthropicMessages('github:copilot:claude-sonnet-4.6'),
    ).toBe(true)
    expect(copilotModelSupportsAnthropicMessages('gpt-6-preview')).toBe(false)
    // supported_endpoints absent → unknown
    expect(copilotModelSupportsAnthropicMessages('gpt-4o-2024-11-20')).toBeNull()
    // model not in catalog → unknown
    expect(copilotModelSupportsAnthropicMessages('claude-opus-4.7')).toBeNull()
  })

  test('copilotModelSupportsAnthropicMessages is null without catalog', () => {
    expect(
      copilotModelSupportsAnthropicMessages('claude-sonnet-4.6'),
    ).toBeNull()
  })

  test('context window / max output resolve via bare id', () => {
    seedCatalog()
    expect(getCatalogCopilotContextWindow('github:copilot:gpt-6-preview')).toBe(
      500000,
    )
    expect(getCatalogCopilotMaxOutputTokens('gpt-6-preview')).toBe(200000)
    expect(getCatalogCopilotContextWindow('unknown-model')).toBeUndefined()
  })

  test('display name prefers catalog, falls back to hardcoded registry', () => {
    seedCatalog()
    expect(getCopilotDisplayName('claude-sonnet-4.6')).toBe(
      'Claude Sonnet 4.6 (live)',
    )
    expect(getCopilotDisplayName('claude-opus-4.7')).toBe('Claude Opus 4.7')
    expect(getCopilotDisplayName('nope')).toBeUndefined()
  })

  test('cached catalog does not answer for a different Copilot endpoint (profile switch)', () => {
    seedCatalog() // tagged to api.githubcopilot.com
    resolvedOverride = {
      transport: 'github_copilot',
      baseUrl: 'https://copilot-api.github.acme.com',
      model: 'github:copilot',
      extras: { githubToken: 't' },
      name: 'GHE Copilot',
    } as ResolvedProvider
    expect(getCatalogCopilotContextWindow('gpt-6-preview')).toBeUndefined()
    expect(copilotModelSupportsAnthropicMessages('claude-sonnet-4.6')).toBeNull()
    expect(getEffectiveCopilotModels().map(m => m.id)).toEqual(
      getAllCopilotModels().map(m => m.id),
    )
  })

  test('cached catalog does not answer when another provider is active', () => {
    seedCatalog()
    // Switch the active profile away from Copilot: the stale catalog must not
    // resolve same-named models for the new provider.
    resolvedOverride = {
      transport: 'openai_compat',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'gpt-6-preview',
      name: 'OpenRouter',
    } as ResolvedProvider
    expect(getCatalogCopilotContextWindow('gpt-6-preview')).toBeUndefined()
    expect(getCatalogCopilotMaxOutputTokens('gpt-6-preview')).toBeUndefined()
    expect(copilotModelSupportsAnthropicMessages('claude-sonnet-4.6')).toBeNull()
    const ids = getEffectiveCopilotModels().map(m => m.id)
    expect(ids).toEqual(getAllCopilotModels().map(m => m.id))
  })
})
