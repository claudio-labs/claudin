import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

// Provider isolation — see sonnet5.test.ts for the full rationale. Pin
// getAPIProvider to 'firstParty' so a cross-file mock.module leak can't collapse
// the effort ladder to the OpenAI tiers or the Haiku default to the 3P one.
const realProviders = { ...(await import('src/providers/model/providers.js')) }
const pinFirstParty = () =>
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'firstParty',
  }))
pinFirstParty()

beforeEach(pinFirstParty)

afterAll(() => {
  mock.module('./providers.js', () => realProviders)
})

import {
  firstPartyNameToCanonical,
  getDefaultHaikuModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isNative1mModel,
  modelRejectsSamplingParams,
  parseUserSpecifiedModel,
} from 'src/providers/model/model.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
} from 'src/agent/context/context.js'
import { modelRequiresAdaptiveThinking } from 'src/agent/context/thinking.js'
import {
  getAvailableEffortLevels,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} from 'src/providers/effort/effort.js'
import { CLAUDE_HAIKU_5_5_CONFIG } from 'src/providers/model/configs.js'
import { getKnowledgeCutoff } from 'src/agent/prompts/prompts.js'
import {
  modelSupportsStructuredOutputs,
  modelSupportsThinkingBlockBinding,
  vertexModelSupportsWebSearch,
} from 'src/providers/transport/betas.js'
import { modelDefaultsToOmittedThinking } from 'src/providers/shims/claude/thinkingDisplay.js'
import { modelSupportsToolReference } from 'src/agent/tools/toolSearch.js'
import { sanitizeModelName } from 'src/vcs/git/commitAttribution.js'
import { getVertexRegionForModel } from 'src/shared/envUtils.js'
import {
  COST_HAIKU_45,
  calculateUSDCost,
  getModelPricingString,
} from 'src/providers/usage/modelCost.js'

// Haiku 5.5 is the default Haiku tier from 2026-10-07. What it shares with
// Claude Code is pinned in claudeCodeParity.test.ts, against the capture in
// __fixtures__/claude-code-wire/. This file covers the rest: the id forms other
// providers use, the tiered price, and every predicate that reads `haiku` as
// "small legacy model" — Haiku 5.5 must not match them, and Haiku 4.5 must keep
// doing so.

test('canonicalizes every provider form to claude-haiku-5-5', () => {
  expect(firstPartyNameToCanonical('claude-haiku-5-5')).toBe('claude-haiku-5-5')
  // Bedrock, with and without a cross-region profile prefix.
  expect(firstPartyNameToCanonical('anthropic.claude-haiku-5-5')).toBe('claude-haiku-5-5')
  expect(firstPartyNameToCanonical('us.anthropic.claude-haiku-5-5')).toBe('claude-haiku-5-5')
  // GitHub Copilot and OpenRouter write the version with a dot.
  expect(firstPartyNameToCanonical('claude-haiku-5.5')).toBe('claude-haiku-5-5')
  expect(firstPartyNameToCanonical('anthropic/claude-haiku-5.5')).toBe('claude-haiku-5-5')
})

test('Haiku 4.5 keeps its own name, cutoff and request shape', () => {
  expect(firstPartyNameToCanonical('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  expect(getMarketingNameForModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(getKnowledgeCutoff('claude-haiku-4-5-20251001')).toBe('February 2025')
  expect(modelRequiresAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false)
  expect(modelSupportsEffort('claude-haiku-4-5-20251001')).toBe(false)
  expect(modelSupportsThinkingBlockBinding('claude-haiku-4-5-20251001')).toBe(false)
  expect(isNative1mModel('claude-haiku-4-5-20251001')).toBe(false)
  expect(getModelMaxOutputTokens('claude-haiku-4-5-20251001')).toEqual({ default: 32_000, upperLimit: 64_000 })
  expect(modelSupportsToolReference('claude-haiku-4-5-20251001')).toBe(false)
  expect(modelSupportsToolReference('claude-3-5-haiku-20241022')).toBe(false)
})

test('a dotted gateway id gets the 5.5 name and cutoff', () => {
  expect(getMarketingNameForModel('anthropic/claude-haiku-5.5')).toBe('Haiku 5.5')
  expect(getKnowledgeCutoff('anthropic/claude-haiku-5.5')).toBe('June 2026')
})

test('config uses the dateless pinned-snapshot IDs', () => {
  expect(CLAUDE_HAIKU_5_5_CONFIG.firstParty).toBe('claude-haiku-5-5')
  // Bedrock uses the Messages-API id, not a legacy us.…-v1:0 ARN.
  expect(CLAUDE_HAIKU_5_5_CONFIG.bedrock).toBe('anthropic.claude-haiku-5-5')
  expect(CLAUDE_HAIKU_5_5_CONFIG.vertex).toBe('claude-haiku-5-5')
  expect(CLAUDE_HAIKU_5_5_CONFIG.foundry).toBe('claude-haiku-5-5')
})

test('is the first-party default Haiku', () => {
  expect(getDefaultHaikuModel()).toBe('claude-haiku-5-5')
})

// Native-1M, so a [1m] tag on the alias must be dropped rather than producing a
// phantom 'claude-haiku-5-5[1m]' with no display-name case.
test('resolves the haiku alias and strips the meaningless [1m] tag', () => {
  expect(modelSupports1M('claude-haiku-5-5')).toBe(true)
  expect(isNative1mModel('claude-haiku-5-5')).toBe(true)
  expect(getContextWindowForModel('claude-haiku-5-5')).toBe(1_000_000)
  const parsed = parseUserSpecifiedModel('haiku[1m]')
  expect(parsed).toBe('claude-haiku-5-5')
  expect(getPublicModelDisplayName(parsed)).toBe('Haiku 5.5')
})

test('defaults to 128K output with a 128K ceiling', () => {
  expect(getModelMaxOutputTokens('claude-haiku-5-5')).toEqual({ default: 128_000, upperLimit: 128_000 })
})

test('rejects non-default sampling params', () => {
  expect(modelRejectsSamplingParams('claude-haiku-5-5')).toBe(true)
})

// The generic `haiku` predicates these replace treated it as a legacy model:
// no tool search, no JSON side queries, the "summarized" display default.
test('gets tool search, structured outputs and the Claude 5 thinking display', () => {
  expect(modelSupportsToolReference('claude-haiku-5-5')).toBe(true)
  expect(modelSupportsStructuredOutputs('claude-haiku-5-5')).toBe(true)
  expect(modelDefaultsToOmittedThinking('claude-haiku-5-5')).toBe(true)
})

// WebSearchTool's Vertex check used its own list, which had stopped at the
// Claude 4 generations; it now reads this one.
test('Vertex web search covers Haiku 5.5 and the rest of the Claude 5 family', () => {
  expect(vertexModelSupportsWebSearch('claude-haiku-5-5')).toBe(true)
  expect(vertexModelSupportsWebSearch('claude-sonnet-5-5')).toBe(true)
  expect(vertexModelSupportsWebSearch('claude-opus-5-5')).toBe(true)
  expect(vertexModelSupportsWebSearch('claude-haiku-4-5@20251001')).toBe(true)
  expect(vertexModelSupportsWebSearch('claude-3-5-haiku@20241022')).toBe(false)
})

test('supports the full low→max effort ladder', () => {
  expect(modelSupportsEffort('claude-haiku-5-5')).toBe(true)
  expect(modelSupportsXhighEffort('claude-haiku-5-5')).toBe(true)
  expect(modelSupportsMaxEffort('claude-haiku-5-5')).toBe(true)
  expect(getAvailableEffortLevels('claude-haiku-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

test('sanitizes to its own id for commit trailers', () => {
  expect(sanitizeModelName('claude-haiku-5-5')).toBe('claude-haiku-5-5')
  expect(sanitizeModelName('claude-haiku-4-5')).toBe('claude-haiku-4-5')
})

test('reads its own Vertex region variable', () => {
  const saved = process.env.VERTEX_REGION_CLAUDE_HAIKU_5_5
  process.env.VERTEX_REGION_CLAUDE_HAIKU_5_5 = 'europe-west4'
  try {
    expect(getVertexRegionForModel('claude-haiku-5-5')).toBe('europe-west4')
  } finally {
    if (saved === undefined) delete process.env.VERTEX_REGION_CLAUDE_HAIKU_5_5
    else process.env.VERTEX_REGION_CLAUDE_HAIKU_5_5 = saved
  }
})

// The price switches on the size of ONE request's prompt — input, cache reads
// and cache writes together — and every rate switches with it, output included.
const usage = (u: Partial<Usage>): Usage =>
  ({ input_tokens: 0, output_tokens: 0, ...u }) as Usage

test('bills a prompt up to 100K at the base rates', () => {
  // 100K exactly is still "up to": 100_000 × $0.10 + 1M output × $0.50.
  expect(calculateUSDCost('claude-haiku-5-5', usage({ input_tokens: 100_000, output_tokens: 1_000_000 }))).toBeCloseTo(0.51, 10)
})

test('bills a prompt over 100K at the long-prompt rates, output included', () => {
  const cost = calculateUSDCost(
    'claude-haiku-5-5',
    usage({
      input_tokens: 1_000,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 10_000,
      output_tokens: 1_000_000,
    }),
  )
  // 101K prompt: 1K × $0.50 + 90K × $0.05 + 10K × $0.625 + 1M × $2.50.
  expect(cost).toBeCloseTo(0.0005 + 0.0045 + 0.00625 + 2.5, 10)
})

test('the long-prompt tier reaches the 1h cache-write rate too', () => {
  const cost = calculateUSDCost(
    'claude-haiku-5-5',
    usage({
      cache_creation_input_tokens: 200_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200_000 },
    } as Partial<Usage>),
  )
  expect(cost).toBeCloseTo(0.2, 10)
})

test('a model without a long-prompt tier bills the same at any size', () => {
  expect(calculateUSDCost('claude-haiku-4-5-20251001', usage({ input_tokens: 1_000_000 }))).toBe(COST_HAIKU_45.inputTokens)
})

test('the pricing string names both tiers', () => {
  expect(getModelPricingString('claude-haiku-5-5')).toBe('$0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)')
  expect(getModelPricingString('claude-haiku-4-5-20251001')).toBe('$1/$5 per Mtok')
})
