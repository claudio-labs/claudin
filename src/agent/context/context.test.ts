import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { ProviderProfile } from 'src/platform/config/config.js'

// Mock only `getActiveProviderProfile` and rely on the real config module.
// Capturing `realProviderProfiles` here is safe because no earlier test file
// mocks `providerProfiles.js`. (Bun's `mock.module` is process-global, so
// spreading captured real exports across files is the standard mitigation —
// see CLAUDE.md.)
// Spread into a plain object: `mock.module` mutates the live ESM namespace in
// place, so a bare `await import(...)` binding would already hold the mocked
// getActiveProviderProfile by the time afterAll restores it — leaking the
// OpenAI provider into every later test file (cacheProfile, contextManagement,
// modelProjectPersistence). The snapshot preserves the original bindings.
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }

let mockProviderProfile: ProviderProfile | null = {
  id: 'test-openai',
  name: 'Test OpenAI',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
}

mock.module('src/providers/presets/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => mockProviderProfile ?? undefined,
}))

afterAll(() => {
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
})

import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'

invalidateActiveProviderCache()

beforeEach(() => {
  invalidateActiveProviderCache()
})

afterEach(() => {
  invalidateActiveProviderCache()
})

import { getMaxOutputTokensForModel } from 'src/providers/shims/claude.js'
import {
  calculateContextPercentages,
  getContextWindowForModel,
  getMaxThinkingTokensForModel,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
  has1mContext,
  modelSupports1M,
} from 'src/agent/context/context.js'
import { recordDiscoveredContextWindow } from 'src/providers/model/openaiModelDiscovery.js'
import { CONTEXT_1M_BETA_HEADER } from 'src/shared/constants/betas.js'

const originalEnv = {
  CLAUDIN_USE_OPENAI: process.env.CLAUDIN_USE_OPENAI,
  CLAUDIN_MAX_OUTPUT_TOKENS: process.env.CLAUDIN_MAX_OUTPUT_TOKENS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

afterEach(() => {
  if (originalEnv.CLAUDIN_USE_OPENAI === undefined) {
    delete process.env.CLAUDIN_USE_OPENAI
  } else {
    process.env.CLAUDIN_USE_OPENAI = originalEnv.CLAUDIN_USE_OPENAI
  }
  if (originalEnv.CLAUDIN_MAX_OUTPUT_TOKENS === undefined) {
    delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  } else {
    process.env.CLAUDIN_MAX_OUTPUT_TOKENS =
      originalEnv.CLAUDIN_MAX_OUTPUT_TOKENS
  }
  if (originalEnv.OPENAI_MODEL === undefined) {
    delete process.env.OPENAI_MODEL
  } else {
    process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  }
})

test('Sonnet 5 resolves to native 1M on first party (no [1m] suffix, no beta header)', () => {
  // Regression: Sonnet 5 is native-1M like Fable 5. Without the native branch in
  // getContextWindowForModel it falls through to the 200k default while the
  // picker advertises 1M (auto-compact would fire at 200k). Force first party by
  // clearing the active profile + OpenAI env so isOpenAIShimTransport() is false.
  const prevProfile = mockProviderProfile
  mockProviderProfile = null
  delete process.env.CLAUDIN_USE_OPENAI
  invalidateActiveProviderCache()
  try {
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(1_000_000)
  } finally {
    mockProviderProfile = prevProfile
    invalidateActiveProviderCache()
  }
})

test('Opus 5 resolves to native 1M on first party (no [1m] suffix, no beta header)', () => {
  // Regression: Opus 5 is native-1M like Sonnet 5 / Fable 5. Without the native
  // branch in getContextWindowForModel it falls through to the 200k default
  // while the picker advertises 1M (auto-compact would fire at 200k). Force
  // first party so isOpenAIShimTransport() is false.
  const prevProfile = mockProviderProfile
  mockProviderProfile = null
  delete process.env.CLAUDIN_USE_OPENAI
  invalidateActiveProviderCache()
  try {
    expect(getContextWindowForModel('claude-opus-5')).toBe(1_000_000)
  } finally {
    mockProviderProfile = prevProfile
    invalidateActiveProviderCache()
  }
})

test('Fable 5.1 resolves to native 1M on first party (no [1m] suffix, no beta header)', () => {
  // Fable 5.1 is 1M-native like Fable 5, and reaches the native branch through
  // the same includes('fable-5') substring. Without it the window falls back to
  // the 200k default and auto-compact fires while the picker advertises 1M.
  const prevProfile = mockProviderProfile
  mockProviderProfile = null
  delete process.env.CLAUDIN_USE_OPENAI
  invalidateActiveProviderCache()
  try {
    expect(getContextWindowForModel('claude-fable-5-1')).toBe(1_000_000)
  } finally {
    mockProviderProfile = prevProfile
    invalidateActiveProviderCache()
  }
})

test('deepseek-v4-flash uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-flash')).toEqual({
    default: 262_144,
    upperLimit: 262_144,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-flash')).toBe(262_144)
})

test('deepseek legacy aliases keep their documented provider caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-chat')).toBe(128_000)
  expect(getContextWindowForModel('deepseek-reasoner')).toBe(128_000)
  expect(getMaxOutputTokensForModel('deepseek-chat')).toBe(8_192)
  expect(getMaxOutputTokensForModel('deepseek-reasoner')).toBe(65_536)
})

test('deepseek-v4-flash clamps oversized max output overrides to the provider limit', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  process.env.CLAUDIN_MAX_OUTPUT_TOKENS = '500000'
  delete process.env.OPENAI_MODEL

  expect(getMaxOutputTokensForModel('deepseek-v4-flash')).toBe(262_144)
})

test('gpt-4o uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-4o clamps oversized max output overrides to the provider limit', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  process.env.CLAUDIN_MAX_OUTPUT_TOKENS = '32000'
  delete process.env.OPENAI_MODEL

  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-5.4 family uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-5.4')).toBe(1_050_000)
  expect(getModelMaxOutputTokens('gpt-5.4')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-mini')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-mini')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-nano')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-nano')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

test('gpt-5.4 family keeps large max output overrides within provider limits', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  process.env.CLAUDIN_MAX_OUTPUT_TOKENS = '200000'

  expect(getMaxOutputTokensForModel('gpt-5.4')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-mini')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-nano')).toBe(128_000)
})

test('MiniMax-M2.7 uses explicit provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.7')).toBe(204_800)
  expect(getModelMaxOutputTokens('MiniMax-M2.7')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getMaxOutputTokensForModel('MiniMax-M2.7')).toBe(131_072)
})

test('unknown openai-compatible models use the 128k fallback window (not 8k, see #635)', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('some-unknown-3p-model')).toBe(128_000)
})

test('MiniMax-M2.5 and M2.1 use explicit provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.5')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.5-highspeed')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.1')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.1-highspeed')).toBe(204_800)
  expect(getModelMaxOutputTokens('MiniMax-M2.5')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
})

test('DashScope qwen3.6-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.6-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.6-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('qwen3.6-plus')).toBe(65_536)
})

test('DashScope qwen3.5-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.5-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.5-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('qwen3.5-plus')).toBe(65_536)
})

test('DashScope qwen3-coder-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3-coder-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('DashScope qwen3-coder-next uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-next')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-coder-next')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('DashScope qwen3-max uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope qwen3-max dated variant resolves to base entry via prefix match', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max-2026-01-23')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max-2026-01-23')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope kimi-k2.5 uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-k2.5')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-k2.5')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('Kimi Code kimi-for-coding uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-for-coding')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-for-coding')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('Kimi Code k3 uses 1M context window', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('k3')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('k3')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope glm-5 uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-5')).toBe(202_752)
  expect(getModelMaxOutputTokens('glm-5')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('DashScope glm-4.7 uses provider-specific context and output caps', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-4.7')).toBe(202_752)
  expect(getModelMaxOutputTokens('glm-4.7')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('DashScope models clamp oversized max output overrides to the provider limit', () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  process.env.CLAUDIN_MAX_OUTPUT_TOKENS = '100000'

  expect(getMaxOutputTokensForModel('qwen3.6-plus')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3.5-plus')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3-coder-next')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3-max')).toBe(32_768)
  expect(getMaxOutputTokensForModel('kimi-k2.5')).toBe(32_768)
  expect(getMaxOutputTokensForModel('glm-5')).toBe(16_384)
})

/** Run `fn` with no active profile and no OpenAI env: isOpenAIShimTransport() is false. */
function asFirstParty<T>(fn: () => T): T {
  const prevProfile = mockProviderProfile
  mockProviderProfile = null
  delete process.env.CLAUDIN_USE_OPENAI
  invalidateActiveProviderCache()
  try {
    return fn()
  } finally {
    mockProviderProfile = prevProfile
    invalidateActiveProviderCache()
  }
}

describe('getContextWindowForModel — OpenAI-shim branch (characterization)', () => {
  // Unique id: the discovered-window map has no reset helper, and a well-known
  // id here would override the table for every later file in the run.
  const DISCOVERED_MODEL = 'ctx-characterization-discovered-model'
  const UNKNOWN_MODEL = 'ctx-characterization-unknown-model'

  let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>
  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  const warningsFor = (model: string) =>
    errorSpy.mock.calls.filter(args => String(args[0]).includes(`model "${model}" not in context window table`))

  test('a model in the hardcoded table resolves without a warning', () => {
    expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
    expect(warningsFor('gpt-4o')).toHaveLength(0)
  })

  test('a window recorded by discovery (recordDiscoveredContextWindow) is used, without a warning', () => {
    recordDiscoveredContextWindow(DISCOVERED_MODEL, 262_144)
    expect(getContextWindowForModel(DISCOVERED_MODEL)).toBe(262_144)
    expect(warningsFor(DISCOVERED_MODEL)).toHaveLength(0)
  })

  test('an unknown model falls back to 128k and warns on console.error', () => {
    expect(getContextWindowForModel(UNKNOWN_MODEL)).toBe(128_000)
    const warnings = warningsFor(UNKNOWN_MODEL)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]![0])).toContain('using conservative 128k default')
    expect(String(warnings[0]![0])).toContain('src/providers/model/openaiContextWindows.ts')
  })

  test('the unknown-model warning is printed once per model, not on every call', () => {
    // Twelve callers ask on every turn; -p printed it four times per run.
    const model = 'ctx-characterization-unknown-once'
    getContextWindowForModel(model)
    getContextWindowForModel(model)
    getContextWindowForModel(model)
    expect(getContextWindowForModel(model)).toBe(128_000)
    expect(warningsFor(model)).toHaveLength(1)
  })

  test('the [1m] suffix wins over the shim table', () => {
    expect(getContextWindowForModel(`${UNKNOWN_MODEL}[1m]`)).toBe(1_000_000)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('an unknown model has no output cap in the shim table and falls to the 32k/64k default', () => {
    expect(getModelMaxOutputTokens(UNKNOWN_MODEL)).toEqual({ default: 32_000, upperLimit: 64_000 })
  })
})

describe('1M context helpers (characterization)', () => {
  const savedDisable = process.env.CLAUDIN_DISABLE_1M_CONTEXT
  afterEach(() => {
    if (savedDisable === undefined) delete process.env.CLAUDIN_DISABLE_1M_CONTEXT
    else process.env.CLAUDIN_DISABLE_1M_CONTEXT = savedDisable
  })

  test('has1mContext reads the [1m] suffix case-insensitively', () => {
    delete process.env.CLAUDIN_DISABLE_1M_CONTEXT
    expect(has1mContext('claude-sonnet-4-6[1m]')).toBe(true)
    expect(has1mContext('claude-sonnet-4-6[1M]')).toBe(true)
    expect(has1mContext('claude-sonnet-4-6')).toBe(false)
  })

  test('CLAUDIN_DISABLE_1M_CONTEXT turns every 1M path off', () => {
    process.env.CLAUDIN_DISABLE_1M_CONTEXT = '1'
    expect(has1mContext('claude-sonnet-4-6[1m]')).toBe(false)
    expect(modelSupports1M('claude-sonnet-4-6')).toBe(false)
    expect(getSonnet1mExpTreatmentEnabled('claude-sonnet-4-6')).toBe(false)
    asFirstParty(() => {
      expect(getContextWindowForModel('claude-sonnet-5')).toBe(200_000)
    })
  })

  test('modelSupports1M lists the 1M-capable families', () => {
    delete process.env.CLAUDIN_DISABLE_1M_CONTEXT
    expect(modelSupports1M('claude-sonnet-4-6')).toBe(true)
    expect(modelSupports1M('claude-opus-4-7')).toBe(true)
    expect(modelSupports1M('claude-opus-4-1')).toBe(false)
    expect(modelSupports1M('claude-3-5-haiku')).toBe(false)
  })

  test('first party: the 1M beta header lifts a 1M-capable model, not others', () => {
    delete process.env.CLAUDIN_DISABLE_1M_CONTEXT
    asFirstParty(() => {
      expect(getContextWindowForModel('claude-sonnet-4-6', [CONTEXT_1M_BETA_HEADER])).toBe(1_000_000)
      expect(getContextWindowForModel('claude-opus-4-1', [CONTEXT_1M_BETA_HEADER])).toBe(200_000)
      expect(getContextWindowForModel('claude-sonnet-4-6')).toBe(200_000)
    })
  })

  test('getSonnet1mExpTreatmentEnabled is off for an explicit [1m] or a non-4.6 model', () => {
    delete process.env.CLAUDIN_DISABLE_1M_CONTEXT
    expect(getSonnet1mExpTreatmentEnabled('claude-sonnet-4-6[1m]')).toBe(false)
    expect(getSonnet1mExpTreatmentEnabled('claude-opus-4-7')).toBe(false)
  })
})

describe('getModelMaxOutputTokens — first-party families (characterization)', () => {
  const cases: Array<[string, number, number]> = [
    ['claude-opus-5-5', 128_000, 128_000],
    ['claude-haiku-5-5', 128_000, 128_000],
    ['claude-opus-5', 64_000, 128_000],
    ['claude-sonnet-5', 64_000, 128_000],
    ['claude-opus-4-7', 64_000, 128_000],
    ['claude-sonnet-4-6', 32_000, 128_000],
    ['claude-sonnet-4-5', 32_000, 64_000],
    ['claude-haiku-4-5', 32_000, 64_000],
    ['claude-opus-4-1', 32_000, 32_000],
    ['claude-3-opus-20240229', 4_096, 4_096],
    ['claude-3-sonnet-20240229', 8_192, 8_192],
    ['claude-3-haiku-20240307', 4_096, 4_096],
    ['claude-3-5-sonnet-20241022', 8_192, 8_192],
    ['claude-3-7-sonnet-20250219', 32_000, 64_000],
    ['some-other-model', 32_000, 64_000],
  ]

  for (const [model, def, upper] of cases) {
    test(`${model} → ${def}/${upper}`, () => {
      asFirstParty(() => {
        expect(getModelMaxOutputTokens(model)).toEqual({ default: def, upperLimit: upper })
      })
    })
  }

  test('getMaxThinkingTokensForModel is the upper limit minus one', () => {
    asFirstParty(() => {
      expect(getMaxThinkingTokensForModel('claude-opus-4-1')).toBe(31_999)
    })
  })
})

describe('calculateContextPercentages', () => {
  const usage = (input: number, cacheRead: number) => ({
    input_tokens: input,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
    output_tokens: 0,
  })

  test('is null before the first response', () => {
    expect(calculateContextPercentages(null, 200_000)).toEqual({
      used: null,
      remaining: null,
    })
  })

  test('counts fresh and cached input against the window, rounded', () => {
    expect(calculateContextPercentages(usage(1_000, 49_100), 200_000)).toEqual({
      used: 25,
      remaining: 75,
    })
  })

  test('clamps a request past the window at 100', () => {
    expect(calculateContextPercentages(usage(0, 250_000), 200_000)).toEqual({
      used: 100,
      remaining: 0,
    })
  })
})
