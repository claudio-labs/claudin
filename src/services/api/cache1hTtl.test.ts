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
  const state = await import('../../bootstrap/state.js')
  state.setLargeSystemPromptDetected(null)
  const claude = await import('./claude.js')
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
