import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { describe, expect, it } from 'bun:test'

import {
  COST_TIER_3_15,
  COST_TIER_5_25,
  calculateUSDCost,
  getModelCosts,
  getModelPricingString,
} from 'src/services/api/modelCost.js'

const usageOneM: Usage = {
  input_tokens: 1_000_000,
  output_tokens: 0,
} as Usage

describe('getModelCosts — non-Claude families', () => {
  it('returns DeepSeek pricing instead of Opus default', () => {
    const cost = getModelCosts('deepseek-chat', usageOneM)
    expect(cost.inputTokens).toBe(0.14)
    expect(cost.outputTokens).toBe(0.28)
    // Cache hit ratio matters: shims populate cache_read_input_tokens.
    expect(cost.promptCacheReadTokens).toBe(0.0028)
  })

  it('returns DeepSeek pricing for reasoner variant', () => {
    expect(getModelCosts('deepseek-reasoner', usageOneM).inputTokens).toBe(0.14)
  })

  it('returns Gemini Flash 2.5 pricing', () => {
    const cost = getModelCosts('gemini-2.5-flash', usageOneM)
    expect(cost.inputTokens).toBe(0.30)
    expect(cost.outputTokens).toBe(2.50)
  })

  it('returns Gemini Pro 2.5 pricing', () => {
    expect(getModelCosts('gemini-2.5-pro', usageOneM).inputTokens).toBe(1.25)
  })

  it('returns Gemini 2.0 Flash pricing', () => {
    expect(getModelCosts('gemini-2.0-flash', usageOneM).inputTokens).toBe(0.10)
  })

  it('returns GPT-5 pricing with 90% cache discount', () => {
    const cost = getModelCosts('gpt-5', usageOneM)
    expect(cost.inputTokens).toBe(1.25)
    expect(cost.outputTokens).toBe(10)
    expect(cost.promptCacheReadTokens).toBe(0.125)
  })

  it('returns GPT-5 mini pricing', () => {
    expect(getModelCosts('gpt-5-mini', usageOneM).inputTokens).toBe(0.25)
  })

  it('returns GPT-4o pricing with 50% cache discount', () => {
    const cost = getModelCosts('gpt-4o-2024-08-06', usageOneM)
    expect(cost.inputTokens).toBe(2.50)
    expect(cost.promptCacheReadTokens).toBe(1.25)
  })

  it('returns GPT-4o mini pricing', () => {
    expect(getModelCosts('gpt-4o-mini', usageOneM).inputTokens).toBe(0.15)
  })

  it('returns o3 pricing', () => {
    expect(getModelCosts('o3-2025-04-16', usageOneM).inputTokens).toBe(15)
  })

  it('returns Mistral Large 3 pricing', () => {
    expect(getModelCosts('mistral-large-3-2512', usageOneM).inputTokens).toBe(0.50)
  })

  it('returns Llama 3.3 70B pricing', () => {
    expect(getModelCosts('llama-3.3-70b-instruct', usageOneM).inputTokens).toBe(0.59)
  })

  it('returns Qwen pricing', () => {
    expect(getModelCosts('qwen-2.5-coder-32b', usageOneM).inputTokens).toBe(0.50)
  })

  it('returns kimi-for-coding pricing (Moonshot Anthropic-compat)', () => {
    expect(getModelCosts('kimi-for-coding', usageOneM).inputTokens).toBe(1)
  })

  it('returns Kimi K2 generic pricing', () => {
    expect(getModelCosts('kimi-k2.5', usageOneM).inputTokens).toBe(0.60)
  })

  it('returns Moonshot pricing', () => {
    expect(getModelCosts('moonshot-v1-8k', usageOneM).inputTokens).toBe(0.60)
  })

  it('returns Devstral pricing (Mistral coding model)', () => {
    expect(getModelCosts('devstral-latest', usageOneM).inputTokens).toBe(0.10)
  })

  it('returns Grok 4 pricing', () => {
    expect(getModelCosts('x-ai/grok-4', usageOneM).inputTokens).toBe(3)
  })

  it('returns Grok 4 Fast pricing (cheaper variant)', () => {
    expect(getModelCosts('grok-4-fast-reasoning', usageOneM).inputTokens).toBe(0.20)
  })

  it('returns Cohere Command R+ pricing', () => {
    expect(getModelCosts('cohere/command-r-plus', usageOneM).inputTokens).toBe(2.50)
  })

  it('returns Cohere Command R7B pricing (cheap variant)', () => {
    expect(getModelCosts('command-r7b', usageOneM).inputTokens).toBe(0.0375)
  })

  it('returns Gemma 3 27B pricing', () => {
    expect(getModelCosts('google/gemma-3-27b-it', usageOneM).inputTokens).toBe(0.08)
  })

  it('returns Phi-4 pricing', () => {
    expect(getModelCosts('microsoft/phi-4', usageOneM).inputTokens).toBe(0.13)
  })

  it('falls back to default tier for genuinely unknown model', () => {
    const cost = getModelCosts('totally-novel-model-xyz', usageOneM)
    // Falls through to default-main-loop / DEFAULT_UNKNOWN; will be Claude-tier.
    expect(cost).toBeDefined()
    expect(cost.inputTokens).toBeGreaterThan(0)
  })

  it('Claude pricing still wins (priority over family lookup)', () => {
    const cost = getModelCosts('claude-sonnet-4-5-20250514', usageOneM)
    // Sonnet 4.5 → COST_TIER_3_15
    expect(cost).toBe(COST_TIER_3_15)
  })

  it('claude-* never accidentally matches a non-Claude pattern', () => {
    // Defensive regression: confirm none of the regex patterns
    // (\bo1\b, \bo3\b, gpt-, gemini, etc.) accidentally fire on Claude names.
    // Stringified to read as docs if this ever fails.
    const claudeNames = [
      'claude-opus-4-7-20260115',
      'claude-sonnet-4-6-20251210',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20240620',
    ]
    for (const name of claudeNames) {
      const cost = getModelCosts(name, usageOneM)
      // Must be a known Claude tier — i.e. shortName resolved correctly.
      // None of these should fall through to family-table-only matches.
      expect(cost).toBeDefined()
      expect(cost.inputTokens).toBeGreaterThan(0)
      // Sanity: input rate must be one of the published Claude tiers.
      expect([0.8, 1, 3, 5, 15]).toContain(cost.inputTokens)
    }
  })

  it('gpt-5-codex falls through to gpt-5 pricing (same rate, documented)', () => {
    // OpenAI publishes gpt-5-codex at $1.25/$10 input/output — identical
    // to gpt-5. The generic /gpt-5/i pattern handles both. If OpenAI ever
    // diverges the rate, add a dedicated `gpt-5-codex` row above the generic.
    const cost = getModelCosts('gpt-5-codex', usageOneM)
    expect(cost.inputTokens).toBe(1.25)
    expect(cost.outputTokens).toBe(10)
  })
})

describe('calculateUSDCost — non-Claude end-to-end', () => {
  it('charges DeepSeek correctly (1M input ≈ $0.14)', () => {
    const cost = calculateUSDCost('deepseek-chat', usageOneM)
    expect(cost).toBeCloseTo(0.14, 5)
  })

  it('charges Gemini Flash correctly', () => {
    const cost = calculateUSDCost('gemini-2.5-flash', usageOneM)
    expect(cost).toBeCloseTo(0.30, 5)
  })

  it('previously-broken DeepSeek now reports correctly (was $5/Mtok)', () => {
    const cost = calculateUSDCost('deepseek-chat', usageOneM)
    // Pre-fix this returned 5 (DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25).
    expect(cost).toBeLessThan(1)
    expect(cost).not.toBe(COST_TIER_5_25.inputTokens)
  })
})

describe('calculateUSDCost — TTL cache breakdown (1h vs 5m)', () => {
  // Sonnet 4.5 → COST_TIER_3_15: 5m write = $3.75/Mtok, 1h write = $6/Mtok
  const sonnet = 'claude-sonnet-4-5-20250514'

  it('bills 1h-only cache_creation at the 2× rate', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 1_000_000,
        ephemeral_5m_input_tokens: 0,
      },
    } as unknown as Usage
    const cost = calculateUSDCost(sonnet, usage)
    expect(cost).toBeCloseTo(6, 5)
  })

  it('bills 5m-only cache_creation at the 1.25× rate (regression)', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 1_000_000,
      },
    } as unknown as Usage
    const cost = calculateUSDCost(sonnet, usage)
    expect(cost).toBeCloseTo(3.75, 5)
  })

  it('bills mixed 1h+5m at the sum of both buckets', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 500_000,
        ephemeral_5m_input_tokens: 500_000,
      },
    } as unknown as Usage
    const cost = calculateUSDCost(sonnet, usage)
    // 0.5 * 6 + 0.5 * 3.75 = 3 + 1.875 = 4.875
    expect(cost).toBeCloseTo(4.875, 5)
  })

  it('falls back to scalar cache_creation_input_tokens at 5m rate when split absent', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    } as unknown as Usage
    const cost = calculateUSDCost(sonnet, usage)
    // Pre-fix behavior preserved for shims/replay paths without TTL split.
    expect(cost).toBeCloseTo(3.75, 5)
  })

  it('non-Anthropic models bill 1h bucket at the 5m fallback price (no 1h product)', () => {
    // DeepSeek has no 1h ephemeral concept; the bucket still bills at the
    // model's only cache-write rate (here equal to input: $0.14/Mtok).
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 1_000_000,
        ephemeral_5m_input_tokens: 0,
      },
    } as unknown as Usage
    const cost = calculateUSDCost('deepseek-chat', usage)
    expect(cost).toBeCloseTo(0.14, 5)
  })
})

describe('getModelPricingString — non-Claude', () => {
  it('formats DeepSeek pricing', () => {
    expect(getModelPricingString('deepseek-chat')).toBe('$0.14/$0.28 per Mtok')
  })

  it('formats Gemini Flash pricing', () => {
    expect(getModelPricingString('gemini-2.5-flash')).toBe('$0.30/$2.50 per Mtok')
  })

  it('returns undefined for genuinely unknown model', () => {
    expect(getModelPricingString('completely-made-up-name')).toBeUndefined()
  })
})
