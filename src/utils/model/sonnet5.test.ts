import { expect, test } from 'bun:test'

import {
  firstPartyNameToCanonical,
  getMarketingNameForModel,
} from './model.js'
import { modelSupports1M } from '../context.js'
import {
  modelRequiresAdaptiveThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from '../thinking.js'
import { modelSupportsEffort } from '../effort.js'
import { COST_TIER_3_15, MODEL_COSTS } from '../modelCost.js'
import { CLAUDE_SONNET_5_CONFIG } from './configs.js'

// Sonnet 5 shares Fable 5's request-shaping profile (adaptive thinking always on,
// budget_tokens/sampling params rejected, 1M-native) but is the new Sonnet tier.
// The native-1M *context window* resolution (getContextWindowForModel) is
// provider-gated (isOpenAIShimTransport), so that regression lives in
// context.test.ts where the active provider is controlled; here we cover the
// provider-independent capability + metadata.

test('canonicalizes to claude-sonnet-5 across provider forms', () => {
  expect(firstPartyNameToCanonical('claude-sonnet-5')).toBe('claude-sonnet-5')
  expect(firstPartyNameToCanonical('anthropic.claude-sonnet-5')).toBe(
    'claude-sonnet-5',
  )
  // Must not fall through to the generic regex (→ 'claude-sonnet').
  expect(firstPartyNameToCanonical('claude-sonnet-5')).not.toBe('claude-sonnet')
})

test('config uses the dateless pinned-snapshot IDs', () => {
  expect(CLAUDE_SONNET_5_CONFIG.firstParty).toBe('claude-sonnet-5')
  // Bedrock uses the Messages-API id, not the legacy us.…-v1:0 ARN.
  expect(CLAUDE_SONNET_5_CONFIG.bedrock).toBe('anthropic.claude-sonnet-5')
})

test('supports 1M context natively', () => {
  expect(modelSupports1M('claude-sonnet-5')).toBe(true)
})

test('requires adaptive thinking (budget_tokens 400s)', () => {
  expect(modelRequiresAdaptiveThinking('claude-sonnet-5')).toBe(true)
  expect(modelSupportsAdaptiveThinking('claude-sonnet-5')).toBe(true)
  // Must be recognized as thinking-capable, otherwise streaming.ts skips the
  // thinking block entirely (hasThinking && modelSupportsThinking gate).
  expect(modelSupportsThinking('claude-sonnet-5')).toBe(true)
})

test('supports the effort parameter', () => {
  expect(modelSupportsEffort('claude-sonnet-5')).toBe(true)
})

test('uses the standard $3/$15 Sonnet pricing tier', () => {
  const canonical = firstPartyNameToCanonical(CLAUDE_SONNET_5_CONFIG.firstParty)
  expect(MODEL_COSTS[canonical]).toEqual(COST_TIER_3_15)
})

test('reports the public marketing name', () => {
  expect(getMarketingNameForModel('claude-sonnet-5')).toBe('Sonnet 5')
})
