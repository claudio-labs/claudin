import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaOutputConfig } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  SYSTEM_PROMPT_SESSION_MARKER,
} from 'src/agent/prompts/prompts.js'
import {
  getLargeSystemPromptDetected,
  setLargeSystemPromptDetected,
} from 'src/platform/bootstrap/state.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { getModelMaxOutputTokens } from 'src/agent/context/context.js'
import {
  _setCopilotCatalogForTesting,
  type CopilotCatalogEntry,
} from 'src/providers/model/copilotModelCatalog.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { getDefaultOpusModel, getDefaultSonnetModel } from 'src/providers/model/model.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import {
  adjustParamsForNonStreaming,
  buildSystemPromptBlocks,
  configureEffortParams,
  configureTaskBudgetParams,
  detectLargeSystemPromptOnce,
  getExtraBodyParams,
  getMaxOutputTokensForModel,
  getPromptCachingEnabled,
} from 'src/providers/shims/claude/paramBuilders.js'
import type { TaskBudgetParam } from 'src/providers/shims/claude/types.js'
import { EFFORT_BETA_HEADER, TASK_BUDGETS_BETA_HEADER } from 'src/shared/constants/betas.js'

// Every env var a function under test (or a resolver it calls) reads. Each
// test starts with all of them unset, so the developer's shell cannot steer a
// result, and the originals are put back afterwards.
const TOUCHED_ENV = [
  'CLAUDIN_EXTRA_BODY',
  'DISABLE_PROMPT_CACHING',
  'DISABLE_PROMPT_CACHING_HAIKU',
  'DISABLE_PROMPT_CACHING_SONNET',
  'DISABLE_PROMPT_CACHING_OPUS',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDIN_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE',
  'CLAUDIN_MAX_OUTPUT_TOKENS',
  'CLAUDIN_ALWAYS_ENABLE_EFFORT',
  'CLAUDIN_MAIN_CACHE_TTL',
  'ENABLE_PROMPT_CACHING_1H_BEDROCK',
] as const
const originalEnv = Object.fromEntries(TOUCHED_ENV.map(k => [k, process.env[k]]))
const originalLatch = getLargeSystemPromptDetected()

function restoreEnv(): void {
  for (const k of TOUCHED_ENV) {
    const v = originalEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  for (const k of TOUCHED_ENV) delete process.env[k]
})

afterEach(() => {
  restoreEnv()
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  _setCopilotCatalogForTesting(null)
  setLargeSystemPromptDetected(originalLatch)
})

afterAll(() => {
  restoreEnv()
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  _setCopilotCatalogForTesting(null)
  setLargeSystemPromptDetected(originalLatch)
})

// Real config resolution: the profile goes into the (test-mode, in-memory)
// global config and tryGetActiveProvider() resolves it like it does at runtime.
function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

const ANTHROPIC: ProviderProfile = {
  id: 'pb-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-6',
}
const BEDROCK: ProviderProfile = {
  id: 'pb-bedrock',
  name: 'Bedrock',
  provider: 'bedrock',
  baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
}
const VERTEX: ProviderProfile = {
  id: 'pb-vertex',
  name: 'Vertex',
  provider: 'vertex',
  baseUrl: 'https://us-east5-aiplatform.googleapis.com',
  model: 'claude-sonnet-4-5@20250929',
}
const FOUNDRY: ProviderProfile = {
  id: 'pb-foundry',
  name: 'Foundry',
  provider: 'foundry',
  baseUrl: 'https://example.services.ai.azure.com',
  model: 'claude-sonnet-4-5',
}
const OPENAI: ProviderProfile = {
  id: 'pb-openai',
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.4',
}
const GEMINI: ProviderProfile = {
  id: 'pb-gemini',
  name: 'Gemini',
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-3-flash-preview',
}
const MINIMAX: ProviderProfile = {
  id: 'pb-minimax',
  name: 'MiniMax',
  provider: 'openai',
  baseUrl: 'https://api.minimax.io/v1',
  model: 'MiniMax-M3',
}
const COPILOT_CLAUDE: ProviderProfile = {
  id: 'pb-copilot',
  name: 'Copilot',
  provider: 'openai',
  baseUrl: 'https://api.githubcopilot.com',
  model: 'claude-sonnet-4.6',
  extras: { githubToken: 'gh-test' },
}

function catalogEntry(id: string, supportedEndpoints: string[] | null): CopilotCatalogEntry {
  return {
    model: {
      id,
      name: id,
      family: id,
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
    supportedEndpoints,
    pickerEnabled: true,
  } as CopilotCatalogEntry
}

describe('getPromptCachingEnabled — which providers get cache_control', () => {
  test.each([
    ['firstParty', ANTHROPIC],
    ['bedrock', BEDROCK],
    ['vertex', VERTEX],
  ] as const)('%s (native Anthropic wire) caches', (provider, profile) => {
    useProfile(profile)
    expect(getAPIProvider()).toBe(provider)
    expect(getPromptCachingEnabled(profile.model)).toBe(true)
  })

  test('no profile configured resolves to firstParty and caches', () => {
    expect(getAPIProvider()).toBe('firstParty')
    expect(getPromptCachingEnabled('claude-opus-4-6')).toBe(true)
  })

  // Foundry is a native Anthropic transport too, but the gate leaves it out:
  // the comment says strict backends (Azure Foundry) reject cache_control.
  test.each([
    ['foundry', FOUNDRY],
    ['openai', OPENAI],
    ['gemini', GEMINI],
  ] as const)('%s never caches, even for a Claude model name', (provider, profile) => {
    useProfile(profile)
    expect(getAPIProvider()).toBe(provider)
    expect(getPromptCachingEnabled(profile.model)).toBe(false)
    expect(getPromptCachingEnabled('claude-sonnet-4-5')).toBe(false)
  })

  // Its models go to MiniMax's own Anthropic endpoint (compatWires.ts); a
  // model the table does not list there stays on chat, without markers.
  test('minimax caches its own models on its Anthropic endpoint, and nothing else', () => {
    useProfile(MINIMAX)
    expect(getAPIProvider()).toBe('minimax')
    expect(getPromptCachingEnabled(MINIMAX.model)).toBe(true)
    expect(getPromptCachingEnabled('claude-sonnet-4-5')).toBe(false)
  })

  test('github in native Anthropic mode (Claude model) caches', () => {
    useProfile(COPILOT_CLAUDE)
    expect(getAPIProvider()).toBe('github')
    expect(getPromptCachingEnabled('claude-sonnet-4.6')).toBe(true)
  })

  test('github with a non-Claude model goes through the shim and does not cache', () => {
    useProfile(COPILOT_CLAUDE)
    // The model argument wins over the profile model.
    expect(getPromptCachingEnabled('gpt-5.4')).toBe(false)
  })

  test('github with a Claude model the account catalog serves only over chat does not cache', () => {
    useProfile(COPILOT_CLAUDE)
    _setCopilotCatalogForTesting([catalogEntry('claude-sonnet-4.6', ['/chat/completions'])])
    expect(getPromptCachingEnabled('claude-sonnet-4.6')).toBe(false)
  })

  test('github with a catalog confirming /v1/messages caches', () => {
    useProfile(COPILOT_CLAUDE)
    _setCopilotCatalogForTesting([
      catalogEntry('claude-sonnet-4.6', ['/chat/completions', '/v1/messages']),
    ])
    expect(getPromptCachingEnabled('claude-sonnet-4.6')).toBe(true)
  })
})

describe('getPromptCachingEnabled — DISABLE_PROMPT_CACHING* envs', () => {
  test.each([
    ['firstParty', ANTHROPIC, ANTHROPIC.model],
    ['bedrock', BEDROCK, BEDROCK.model],
    ['github native', COPILOT_CLAUDE, COPILOT_CLAUDE.model],
  ] as const)('DISABLE_PROMPT_CACHING turns it off on %s', (_label, profile, model) => {
    useProfile(profile)
    expect(getPromptCachingEnabled(model)).toBe(true)
    process.env.DISABLE_PROMPT_CACHING = '1'
    expect(getPromptCachingEnabled(model)).toBe(false)
  })

  test('DISABLE_PROMPT_CACHING=0 is not truthy and leaves caching on', () => {
    useProfile(ANTHROPIC)
    process.env.DISABLE_PROMPT_CACHING = '0'
    expect(getPromptCachingEnabled(ANTHROPIC.model)).toBe(true)
  })

  test('DISABLE_PROMPT_CACHING_HAIKU disables only the small/fast model', () => {
    useProfile(ANTHROPIC)
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-haiku-pb-test'
    // Without the switch the small model caches like any other.
    expect(getPromptCachingEnabled('claude-haiku-pb-test')).toBe(true)
    process.env.DISABLE_PROMPT_CACHING_HAIKU = 'true'
    expect(getPromptCachingEnabled('claude-haiku-pb-test')).toBe(false)
    expect(getPromptCachingEnabled('claude-opus-4-6')).toBe(true)
  })

  test('DISABLE_PROMPT_CACHING_SONNET disables only the default Sonnet', () => {
    useProfile(ANTHROPIC)
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-pb-test'
    expect(getPromptCachingEnabled('claude-sonnet-pb-test')).toBe(true)
    process.env.DISABLE_PROMPT_CACHING_SONNET = '1'
    expect(getPromptCachingEnabled('claude-sonnet-pb-test')).toBe(false)
    expect(getPromptCachingEnabled('claude-sonnet-4-5')).toBe(true)
  })

  test('DISABLE_PROMPT_CACHING_OPUS disables only the default Opus', () => {
    useProfile(ANTHROPIC)
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-pb-test'
    expect(getPromptCachingEnabled('claude-opus-pb-test')).toBe(true)
    process.env.DISABLE_PROMPT_CACHING_OPUS = '1'
    expect(getPromptCachingEnabled('claude-opus-pb-test')).toBe(false)
    expect(getPromptCachingEnabled('claude-opus-4-6')).toBe(true)
  })

  test('the per-tier switches compare against the provider-resolved defaults', () => {
    // No env override: the default Sonnet is the one the active provider
    // resolves (Bedrock keeps its own 3P default), not a hardcoded id.
    useProfile(BEDROCK)
    process.env.DISABLE_PROMPT_CACHING_SONNET = '1'
    const sonnet = getDefaultSonnetModel()
    expect(sonnet).not.toBe(getDefaultOpusModel())
    expect(getPromptCachingEnabled(sonnet)).toBe(false)
    expect(getPromptCachingEnabled(getDefaultOpusModel())).toBe(true)
  })

  test('a third-party provider stays off whatever the per-tier envs say', () => {
    useProfile(OPENAI)
    process.env.DISABLE_PROMPT_CACHING_HAIKU = '0'
    expect(getPromptCachingEnabled(OPENAI.model)).toBe(false)
  })
})

describe('getExtraBodyParams', () => {
  test('no env and no betas → empty object', () => {
    expect(getExtraBodyParams()).toEqual({})
    expect(getExtraBodyParams([])).toEqual({})
  })

  test('CLAUDIN_EXTRA_BODY object is spread into the result', () => {
    process.env.CLAUDIN_EXTRA_BODY = '{"top_k":5,"metadata":{"a":1}}'
    expect(getExtraBodyParams()).toEqual({ top_k: 5, metadata: { a: 1 } })
  })

  test('mutating one result does not poison the next (the parse is cached)', () => {
    process.env.CLAUDIN_EXTRA_BODY = '{"anthropic_beta":["user-beta"]}'
    const first = getExtraBodyParams(['beta-a'])
    expect(first).toEqual({ anthropic_beta: ['user-beta', 'beta-a'] })
    first.injected = true
    const second = getExtraBodyParams()
    expect(second).toEqual({ anthropic_beta: ['user-beta'] })
  })

  test.each([
    ['an array', '[1,2]'],
    ['a string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
    ['invalid JSON', '{not json'],
  ])('CLAUDIN_EXTRA_BODY that is %s is ignored', (_label, raw) => {
    process.env.CLAUDIN_EXTRA_BODY = raw
    expect(getExtraBodyParams()).toEqual({})
    expect(getExtraBodyParams(['beta-a'])).toEqual({ anthropic_beta: ['beta-a'] })
  })

  test('betas merge into a user anthropic_beta array without duplicates, user order first', () => {
    process.env.CLAUDIN_EXTRA_BODY = '{"anthropic_beta":["b","a"],"x":1}'
    expect(getExtraBodyParams(['a', 'c'])).toEqual({ anthropic_beta: ['b', 'a', 'c'], x: 1 })
  })

  test('a non-array user anthropic_beta is replaced by the betas', () => {
    process.env.CLAUDIN_EXTRA_BODY = '{"anthropic_beta":"user-beta"}'
    expect(getExtraBodyParams(['a'])).toEqual({ anthropic_beta: ['a'] })
  })

  test('empty betas leave the user anthropic_beta untouched', () => {
    process.env.CLAUDIN_EXTRA_BODY = '{"anthropic_beta":"user-beta"}'
    expect(getExtraBodyParams([])).toEqual({ anthropic_beta: 'user-beta' })
  })
})

describe('configureEffortParams', () => {
  const SUPPORTED = 'claude-opus-4-6'
  const UNSUPPORTED = 'claude-3-5-haiku-20241022'

  beforeEach(() => useProfile(ANTHROPIC))

  test('a model without effort support gets nothing', () => {
    const outputConfig: BetaOutputConfig = {}
    const betas: string[] = []
    configureEffortParams('high', outputConfig, {}, betas, UNSUPPORTED)
    expect(outputConfig).toEqual({})
    expect(betas).toEqual([])
  })

  test('an effort already in output_config is left alone and adds no beta', () => {
    const outputConfig: BetaOutputConfig = { effort: 'low' }
    const betas: string[] = []
    configureEffortParams('high', outputConfig, {}, betas, SUPPORTED)
    expect(outputConfig).toEqual({ effort: 'low' })
    expect(betas).toEqual([])
  })

  test.each([
    ['unset', undefined],
    ['adaptive', 'adaptive'],
  ] as const)('%s effort sends the beta but no effort field', (_label, value) => {
    const outputConfig: BetaOutputConfig = {}
    const betas: string[] = []
    configureEffortParams(value, outputConfig, {}, betas, SUPPORTED)
    expect(outputConfig).toEqual({})
    expect(betas).toEqual([EFFORT_BETA_HEADER])
  })

  test('a string level is sent as is, with the beta', () => {
    const outputConfig: BetaOutputConfig = {}
    const betas: string[] = ['other-beta']
    configureEffortParams('high', outputConfig, {}, betas, SUPPORTED)
    expect(outputConfig).toEqual({ effort: 'high' })
    expect(betas).toEqual(['other-beta', EFFORT_BETA_HEADER])
  })

  test('a numeric effort is dropped entirely (no field, no beta)', () => {
    const outputConfig: BetaOutputConfig = {}
    const betas: string[] = []
    configureEffortParams(42, outputConfig, {}, betas, SUPPORTED)
    expect(outputConfig).toEqual({})
    expect(betas).toEqual([])
  })
})

describe('configureTaskBudgetParams', () => {
  type OutputConfig = BetaOutputConfig & { task_budget?: TaskBudgetParam }

  test('firstParty: writes the budget and the beta', () => {
    useProfile(ANTHROPIC)
    const outputConfig: OutputConfig = {}
    const betas: string[] = []
    configureTaskBudgetParams({ total: 1000, remaining: 400 }, outputConfig, betas)
    expect(outputConfig).toEqual({ task_budget: { type: 'tokens', total: 1000, remaining: 400 } })
    expect(betas).toEqual([TASK_BUDGETS_BETA_HEADER])
  })

  test('without remaining the key is absent, and the beta is not duplicated', () => {
    useProfile(FOUNDRY)
    const outputConfig: OutputConfig = {}
    const betas: string[] = [TASK_BUDGETS_BETA_HEADER]
    configureTaskBudgetParams({ total: 500 }, outputConfig, betas)
    expect(outputConfig.task_budget).toEqual({ type: 'tokens', total: 500 })
    expect('remaining' in outputConfig.task_budget!).toBe(false)
    expect(betas).toEqual([TASK_BUDGETS_BETA_HEADER])
  })

  test('no budget → nothing', () => {
    useProfile(ANTHROPIC)
    const outputConfig: OutputConfig = {}
    const betas: string[] = []
    configureTaskBudgetParams(undefined, outputConfig, betas)
    expect(outputConfig).toEqual({})
    expect(betas).toEqual([])
  })

  test('an existing task_budget is kept', () => {
    useProfile(ANTHROPIC)
    const existing = { type: 'tokens', total: 7 } as TaskBudgetParam
    const outputConfig: OutputConfig = { task_budget: existing }
    const betas: string[] = []
    configureTaskBudgetParams({ total: 1000 }, outputConfig, betas)
    expect(outputConfig.task_budget).toBe(existing)
    expect(betas).toEqual([])
  })

  test.each([
    ['bedrock', BEDROCK],
    ['vertex', VERTEX],
    ['openai', OPENAI],
  ] as const)('%s is not a first-party-betas provider → nothing', (_label, profile) => {
    useProfile(profile)
    const outputConfig: OutputConfig = {}
    const betas: string[] = []
    configureTaskBudgetParams({ total: 1000 }, outputConfig, betas)
    expect(outputConfig).toEqual({})
    expect(betas).toEqual([])
  })

  test('CLAUDIN_DISABLE_EXPERIMENTAL_BETAS turns it off on firstParty', () => {
    useProfile(ANTHROPIC)
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = '1'
    const outputConfig: OutputConfig = {}
    const betas: string[] = []
    configureTaskBudgetParams({ total: 1000 }, outputConfig, betas)
    expect(outputConfig).toEqual({})
    expect(betas).toEqual([])
  })
})

describe('detectLargeSystemPromptOnce', () => {
  test('latches false under the threshold and true over it (8k tokens ≈ 32k chars)', () => {
    setLargeSystemPromptDetected(null)
    detectLargeSystemPromptOnce(['a'.repeat(16_000), 'b'.repeat(16_000)])
    // 32_000 chars >> 2 = 8000, not > 8000
    expect(getLargeSystemPromptDetected()).toBe(false)
    detectLargeSystemPromptOnce(['a'.repeat(16_000), 'b'.repeat(16_004)])
    expect(getLargeSystemPromptDetected()).toBe(true)
  })

  test('is a high-water mark: a small prompt after a large one keeps true', () => {
    setLargeSystemPromptDetected(null)
    detectLargeSystemPromptOnce(['x'.repeat(40_000)])
    expect(getLargeSystemPromptDetected()).toBe(true)
    detectLargeSystemPromptOnce(['tiny'])
    expect(getLargeSystemPromptDetected()).toBe(true)
  })
})

describe('buildSystemPromptBlocks', () => {
  const BILLING = 'x-anthropic-billing-header: cc_version=test'

  test('bedrock: org-scoped blocks get a plain ephemeral marker; billing and session blocks none', () => {
    useProfile(BEDROCK)
    setLargeSystemPromptDetected(null)
    const blocks = buildSystemPromptBlocks(
      [BILLING, 'rules A', 'rules B', SYSTEM_PROMPT_SESSION_MARKER, 'scratchpad /tmp/s1'] as never,
      true,
    )
    expect(blocks).toEqual([
      { type: 'text', text: BILLING },
      { type: 'text', text: 'rules A\n\nrules B', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'scratchpad /tmp/s1' },
    ])
    // It also feeds the large-prompt latch.
    expect(getLargeSystemPromptDetected()).toBe(false)
  })

  test('caching disabled: same split, no cache_control anywhere', () => {
    useProfile(BEDROCK)
    const blocks = buildSystemPromptBlocks([BILLING, 'rules A'] as never, false)
    expect(blocks).toEqual([
      { type: 'text', text: BILLING },
      { type: 'text', text: 'rules A' },
    ])
  })

  test('bedrock with ENABLE_PROMPT_CACHING_1H_BEDROCK gets the 1h tier', () => {
    useProfile(BEDROCK)
    process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK = '1'
    const blocks = buildSystemPromptBlocks(['rules A'] as never, true)
    expect(blocks).toEqual([
      { type: 'text', text: 'rules A', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
  })

  test('firstParty: the static half before the boundary carries scope global', () => {
    useProfile(ANTHROPIC)
    process.env.CLAUDIN_MAIN_CACHE_TTL = '1h'
    const blocks = buildSystemPromptBlocks(
      ['static', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'dynamic'] as never,
      true,
      { querySource: 'repl_main_thread' as never },
    )
    // `scope` is a beta field the stable TextBlockParam type does not declare.
    expect(blocks as unknown).toEqual([
      { type: 'text', text: 'static', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
      { type: 'text', text: 'dynamic' },
    ])
  })

  test('firstParty with skipGlobalCacheForSystemPrompt: one org block, marker without scope', () => {
    useProfile(ANTHROPIC)
    process.env.CLAUDIN_MAIN_CACHE_TTL = '1h'
    const blocks = buildSystemPromptBlocks(
      ['static', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'dynamic'] as never,
      true,
      { skipGlobalCacheForSystemPrompt: true },
    )
    expect(blocks).toEqual([
      { type: 'text', text: 'static\n\ndynamic', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
  })

  test('a short-lived query source drops to the 5m tier', () => {
    useProfile(ANTHROPIC)
    process.env.CLAUDIN_MAIN_CACHE_TTL = '1h'
    process.env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE = '1'
    const blocks = buildSystemPromptBlocks(['rules'] as never, true, {
      querySource: 'web_search_tool' as never,
    })
    expect(blocks).toEqual([
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } },
    ])
  })
})

describe('adjustParamsForNonStreaming', () => {
  test('caps max_tokens and pulls an enabled thinking budget under it', () => {
    const params = {
      max_tokens: 128_000,
      thinking: { type: 'enabled' as const, budget_tokens: 100_000 },
      model: 'm',
    }
    const out = adjustParamsForNonStreaming(params, 64_000)
    expect(out).toEqual({
      max_tokens: 64_000,
      thinking: { type: 'enabled', budget_tokens: 63_999 },
      model: 'm',
    })
    // The input is not mutated.
    expect(params.max_tokens).toBe(128_000)
    expect(params.thinking.budget_tokens).toBe(100_000)
  })

  test('a budget already under the cap is kept', () => {
    const out = adjustParamsForNonStreaming(
      { max_tokens: 128_000, thinking: { type: 'enabled' as const, budget_tokens: 10_000 } },
      64_000,
    )
    expect(out).toEqual({ max_tokens: 64_000, thinking: { type: 'enabled', budget_tokens: 10_000 } })
  })

  test('max_tokens under the cap stays, and the budget is held below max_tokens', () => {
    const out = adjustParamsForNonStreaming(
      { max_tokens: 8_000, thinking: { type: 'enabled' as const, budget_tokens: 8_000 } },
      64_000,
    )
    expect(out).toEqual({ max_tokens: 8_000, thinking: { type: 'enabled', budget_tokens: 7_999 } })
  })

  test('disabled or adaptive thinking is passed through untouched', () => {
    const disabled = { type: 'disabled' as const }
    const out = adjustParamsForNonStreaming({ max_tokens: 100_000, thinking: disabled }, 64_000)
    expect(out).toEqual({ max_tokens: 64_000, thinking: { type: 'disabled' } })
    expect(out.thinking).toBe(disabled)

    const adaptive = { type: 'adaptive' as const }
    const out2 = adjustParamsForNonStreaming({ max_tokens: 100_000, thinking: adaptive } as never, 64_000)
    expect(out2 as unknown).toEqual({ max_tokens: 64_000, thinking: { type: 'adaptive' } })
  })

  test('no thinking at all', () => {
    expect(adjustParamsForNonStreaming({ max_tokens: 100 }, 64_000)).toEqual({ max_tokens: 100 })
  })
})

describe('getMaxOutputTokensForModel', () => {
  const MODEL = 'claude-opus-4-6'

  beforeEach(() => useProfile(ANTHROPIC))

  test('no env → the model default', () => {
    const limits = getModelMaxOutputTokens(MODEL)
    expect(limits.default).toBeLessThan(limits.upperLimit)
    expect(getMaxOutputTokensForModel(MODEL)).toBe(limits.default)
  })

  test('a valid override inside the limit wins', () => {
    const limits = getModelMaxOutputTokens(MODEL)
    const wanted = limits.default + 1
    process.env.CLAUDIN_MAX_OUTPUT_TOKENS = String(wanted)
    expect(getMaxOutputTokensForModel(MODEL)).toBe(wanted)
  })

  test('an override above the limit is capped to the model upper limit', () => {
    const limits = getModelMaxOutputTokens(MODEL)
    process.env.CLAUDIN_MAX_OUTPUT_TOKENS = String(limits.upperLimit * 10)
    expect(getMaxOutputTokensForModel(MODEL)).toBe(limits.upperLimit)
  })

  test.each(['abc', '0', '-5'])('an invalid override (%s) falls back to the default', raw => {
    process.env.CLAUDIN_MAX_OUTPUT_TOKENS = raw
    expect(getMaxOutputTokensForModel(MODEL)).toBe(getModelMaxOutputTokens(MODEL).default)
  })
})
