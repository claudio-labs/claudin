import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const ORIGINAL_ENV = { ...process.env }

const realProviders = { ...(await import('src/utils/model/providers.js')) }

type Provider =
  | 'firstParty'
  | 'vertex'
  | 'bedrock'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'github'
  | 'codex'
  | 'nvidia-nim'
  | 'minimax'
  | 'mistral'

let mockedProvider: Provider = 'firstParty'

function setProvider(p: Provider) {
  mockedProvider = p
}

async function importFresh() {
  mock.module('src/utils/model/providers.js', () => ({
    getAPIProvider: () => mockedProvider,
    isFirstPartyAnthropicBaseUrl: () => mockedProvider === 'firstParty',
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => false,
    getAPIProviderForStatsig: () => mockedProvider,
  }))
  // Use the unstamped state module so we share the singleton STATE that
  // claude.ts uses internally. Reset the latch manually.
  const state = await import('src/platform/bootstrap/state.js')
  state.setLargeSystemPromptDetected(null)
  const claude = await import('src/providers/shims/claude.js')
  return { claude, state }
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK
  mockedProvider = 'firstParty'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

afterAll(() => {
  mock.module('src/utils/model/providers.js', () => realProviders)
})

describe('getCacheControl — 1h TTL gating', () => {
  test('firstParty + large-system-prompt latch true → ttl=1h', async () => {
    setProvider('firstParty')
    const { claude, state } = await importFresh()
    state.setLargeSystemPromptDetected(true)
    expect(claude.getCacheControl()).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('firstParty → ttl=1h regardless of latch false', async () => {
    // The large-system-prompt latch no longer gates getCacheControl: as of
    // "always use 1h cache TTL on first-party/vertex" the old >8k gate was
    // removed (it measured the system prompt, ~3.4k, so 1h was effectively
    // dead). first-party always gets 1h now.
    setProvider('firstParty')
    const { claude, state } = await importFresh()
    state.setLargeSystemPromptDetected(false)
    expect(claude.getCacheControl()).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('firstParty → ttl=1h regardless of latch null (not yet detected)', async () => {
    setProvider('firstParty')
    const { claude } = await importFresh()
    // No setLargeSystemPromptDetected call — latch starts null; ttl still applies.
    expect(claude.getCacheControl()).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('vertex + latch true → ttl=1h', async () => {
    setProvider('vertex')
    const { claude, state } = await importFresh()
    state.setLargeSystemPromptDetected(true)
    expect(claude.getCacheControl()).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('bedrock + latch true but no env var → no ttl (+25% surcharge gate)', async () => {
    setProvider('bedrock')
    const { claude, state } = await importFresh()
    state.setLargeSystemPromptDetected(true)
    expect(claude.getCacheControl()).toEqual({ type: 'ephemeral' })
  })

  test('bedrock + ENABLE_PROMPT_CACHING_1H_BEDROCK=1 → ttl=1h regardless of latch', async () => {
    process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK = '1'
    setProvider('bedrock')
    const { claude } = await importFresh()
    // Latch left null intentionally — bedrock path doesn't read it.
    expect(claude.getCacheControl()).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('openai + latch true → no ttl (provider not in whitelist)', async () => {
    setProvider('openai')
    const { claude, state } = await importFresh()
    state.setLargeSystemPromptDetected(true)
    expect(claude.getCacheControl()).toEqual({ type: 'ephemeral' })
  })

  test('firstParty + subagent querySource (agent:builtin:Explore) → no ttl (5m tier)', async () => {
    setProvider('firstParty')
    const { claude } = await importFresh()
    expect(
      claude.getCacheControl({ querySource: 'agent:builtin:Explore' }),
    ).toEqual({ type: 'ephemeral' })
  })

  test('firstParty + agent:custom → no ttl (5m tier)', async () => {
    setProvider('firstParty')
    const { claude } = await importFresh()
    expect(claude.getCacheControl({ querySource: 'agent:custom' })).toEqual({
      type: 'ephemeral',
    })
  })

  test('firstParty + fork child (agent:builtin:fork) keeps ttl=1h (shares parent prefix)', async () => {
    setProvider('firstParty')
    const { claude } = await importFresh()
    expect(
      claude.getCacheControl({ querySource: 'agent:builtin:fork' }),
    ).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('fork exemption stays derived from the real fork agentType', async () => {
    // cacheControl.ts hardcodes FORK_QUERY_SOURCE; if the fork agentType is
    // ever renamed, the composed querySource would silently fall through to
    // the agent:* 5m branch and re-cache the main thread's 1h line at 5m.
    // Composing from the source constant here turns that drift into a
    // test failure.
    setProvider('firstParty')
    const { claude } = await importFresh()
    const { FORK_SUBAGENT_TYPE } = await import(
      'src/tools/AgentTool/forkSubagent.js'
    )
    expect(
      claude.getCacheControl({
        querySource: `agent:builtin:${FORK_SUBAGENT_TYPE}`,
      }),
    ).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('firstParty + repl_main_thread keeps ttl=1h', async () => {
    setProvider('firstParty')
    const { claude } = await importFresh()
    expect(
      claude.getCacheControl({ querySource: 'repl_main_thread' }),
    ).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('firstParty + short-lived utility sources (agent_summary, web_search_tool) → no ttl', async () => {
    setProvider('firstParty')
    const { claude } = await importFresh()
    for (const querySource of ['agent_summary', 'web_search_tool'] as const) {
      expect(claude.getCacheControl({ querySource })).toEqual({
        type: 'ephemeral',
      })
    }
  })

  test('firstParty + parent-prefix forks and session-long sources keep ttl=1h', async () => {
    // auto_mode is deliberately 1h: the classifier caches a transcript-sized
    // prefix that grows for the whole session and must survive >5min pauses.
    setProvider('firstParty')
    const { claude } = await importFresh()
    for (const querySource of [
      'compact',
      'session_memory',
      'speculation',
      'auto_mode',
    ] as const) {
      expect(claude.getCacheControl({ querySource })).toEqual({
        type: 'ephemeral',
        ttl: '1h',
      })
    }
  })

  test('global scope is preserved alongside ttl', async () => {
    setProvider('firstParty')
    const { claude, state } = await importFresh()
    state.setLargeSystemPromptDetected(true)
    expect(claude.getCacheControl({ scope: 'global' })).toEqual({
      type: 'ephemeral',
      ttl: '1h',
      scope: 'global',
    })
  })
})

describe('detectLargeSystemPromptOnce — latch behavior', () => {
  test('large prompt (>32k chars ≈ >8k tokens) → latch true', async () => {
    const { claude, state } = await importFresh()
    const big = 'x'.repeat(40_000) // 40k chars >> 2 = 10k > 8k
    claude.detectLargeSystemPromptOnce([big])
    expect(state.getLargeSystemPromptDetected()).toBe(true)
  })

  test('small prompt → latch false', async () => {
    const { claude, state } = await importFresh()
    claude.detectLargeSystemPromptOnce(['short prompt'])
    expect(state.getLargeSystemPromptDetected()).toBe(false)
  })

  test('multiple short blocks summed correctly', async () => {
    const { claude, state } = await importFresh()
    // 5 blocks × 7000 chars = 35000 chars >> 2 = 8750 > 8k
    const blocks = Array.from({ length: 5 }, () => 'x'.repeat(7_000))
    claude.detectLargeSystemPromptOnce(blocks)
    expect(state.getLargeSystemPromptDetected()).toBe(true)
  })

  test('once latched true, subsequent small prompts do not flip back', async () => {
    const { claude, state } = await importFresh()
    claude.detectLargeSystemPromptOnce(['x'.repeat(40_000)]) // sets true
    expect(state.getLargeSystemPromptDetected()).toBe(true)
    claude.detectLargeSystemPromptOnce(['short']) // would compute false, but latched
    expect(state.getLargeSystemPromptDetected()).toBe(true)
  })

  test('Haiku-first regression: small prompt then large upgrades to true', async () => {
    // Repro: queryHaiku (sessionTitle/generateSessionName) often fires
    // before the main agent. With first-call-wins, the session would be
    // poisoned to false. High-water mark must allow upgrade.
    const { claude, state } = await importFresh()
    claude.detectLargeSystemPromptOnce(['short haiku prompt'])
    expect(state.getLargeSystemPromptDetected()).toBe(false)
    claude.detectLargeSystemPromptOnce(['x'.repeat(40_000)]) // main agent
    expect(state.getLargeSystemPromptDetected()).toBe(true)
  })
})

describe('buildSystemPromptBlocks integration — large prompt → cache_control ttl', () => {
  test('firstParty large prompt produces blocks with ttl=1h', async () => {
    setProvider('firstParty')
    const { claude } = await importFresh()
    const sysPrompt = ['x'.repeat(40_000)] as unknown as readonly string[] & {
      readonly __brand: 'SystemPrompt'
    }
    const blocks = claude.buildSystemPromptBlocks(sysPrompt, true)
    // At least one block must carry the 1h TTL marker.
    const has1hBlock = blocks.some(
      (b: { cache_control?: { ttl?: string } | null }) =>
        b.cache_control?.ttl === '1h',
    )
    expect(has1hBlock).toBe(true)
  })

  test('non-whitelisted provider (openai) produces blocks without ttl', async () => {
    // The 1h marker is gated on provider, not prompt size. A non-whitelisted
    // provider never carries the 1h TTL even for a large prompt.
    setProvider('openai')
    const { claude } = await importFresh()
    const sysPrompt = ['x'.repeat(40_000)] as unknown as readonly string[] & {
      readonly __brand: 'SystemPrompt'
    }
    const blocks = claude.buildSystemPromptBlocks(sysPrompt, true)
    const has1hBlock = blocks.some(
      (b: { cache_control?: { ttl?: string } | null }) =>
        b.cache_control?.ttl === '1h',
    )
    expect(has1hBlock).toBe(false)
  })
})
