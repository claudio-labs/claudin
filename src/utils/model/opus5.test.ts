import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

// Provider isolation — see sonnet5.test.ts for the full rationale. Pin
// getAPIProvider to 'firstParty' so a cross-file mock.module leak can't collapse
// the effort ladder to the OpenAI tiers.
const realProviders = { ...(await import('src/utils/model/providers.js')) }
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
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isNative1mModel,
  isNonCustomOpusModel,
  modelRejectsSamplingParams,
  parseUserSpecifiedModel,
} from 'src/utils/model/model.js'
import { getModelMaxOutputTokens, modelSupports1M } from 'src/agent/context/context.js'
import { isFastModeSupportedByModel } from 'src/utils/fastMode.js'
import {
  modelRequiresAdaptiveThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from 'src/agent/context/thinking.js'
import {
  getAvailableEffortLevels,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} from 'src/utils/effort.js'
import { COST_TIER_5_25, MODEL_COSTS } from 'src/services/api/modelCost.js'
import { CLAUDE_OPUS_5_CONFIG } from 'src/utils/model/configs.js'

// Opus 5 shares Fable 5 / Sonnet 5's request-shaping profile (adaptive thinking
// always on, budget_tokens/sampling params rejected, 1M-native) but is the new
// default Opus tier. The native-1M *context window* resolution
// (getContextWindowForModel) is provider-gated, so that regression lives in
// context.test.ts; here we cover the provider-independent capability + metadata.

test('canonicalizes to claude-opus-5 across provider forms', () => {
  expect(firstPartyNameToCanonical('claude-opus-5')).toBe('claude-opus-5')
  expect(firstPartyNameToCanonical('anthropic.claude-opus-5')).toBe(
    'claude-opus-5',
  )
  // Must not be confused with a dated Opus 4.x id.
  expect(firstPartyNameToCanonical('claude-opus-4-8')).not.toBe('claude-opus-5')
})

test('config uses the dateless pinned-snapshot IDs', () => {
  expect(CLAUDE_OPUS_5_CONFIG.firstParty).toBe('claude-opus-5')
  // Bedrock uses the Messages-API id, not a legacy us.…-v1:0 ARN.
  expect(CLAUDE_OPUS_5_CONFIG.bedrock).toBe('anthropic.claude-opus-5')
})

test('supports 1M context natively', () => {
  expect(modelSupports1M('claude-opus-5')).toBe(true)
})

test('requires adaptive thinking (budget_tokens 400s)', () => {
  expect(modelRequiresAdaptiveThinking('claude-opus-5')).toBe(true)
  expect(modelSupportsAdaptiveThinking('claude-opus-5')).toBe(true)
  // Must be recognized as thinking-capable, otherwise streaming.ts skips the
  // thinking block entirely (hasThinking && modelSupportsThinking gate).
  expect(modelSupportsThinking('claude-opus-5')).toBe(true)
})

test('rejects non-default sampling params', () => {
  expect(modelRejectsSamplingParams('claude-opus-5')).toBe(true)
})

test('supports the effort parameter', () => {
  expect(modelSupportsEffort('claude-opus-5')).toBe(true)
})

test('supports the xhigh and max effort tiers (like Opus 4.8 / Fable 5)', () => {
  expect(modelSupportsXhighEffort('claude-opus-5')).toBe(true)
  expect(modelSupportsMaxEffort('claude-opus-5')).toBe(true)
  // The /effort picker should surface the full ladder, not stop at 'high'.
  expect(getAvailableEffortLevels('claude-opus-5')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('uses the provisional Opus-4.8-tier $5/$25 pricing placeholder', () => {
  const canonical = firstPartyNameToCanonical(CLAUDE_OPUS_5_CONFIG.firstParty)
  expect(MODEL_COSTS[canonical]).toEqual(COST_TIER_5_25)
})

test('reports the public marketing name', () => {
  expect(getMarketingNameForModel('claude-opus-5')).toBe('Opus 5')
})

// The config documents "128K max output". Without an explicit branch in
// getModelMaxOutputTokens, claude-opus-5 matches no `else if` and silently
// falls through to the 32k/64k default — halving the output budget of the
// model it replaces and clamping CLAUDE_CODE_MAX_OUTPUT_TOKENS.
test('gets the 64k/128k max-output tier, not the 32k fallthrough default', () => {
  expect(getModelMaxOutputTokens('claude-opus-5')).toEqual({
    default: 64_000,
    upperLimit: 128_000,
  })
})

// Opus 5 is native-1M, so a [1m] tag on the alias must be dropped rather than
// producing a phantom 'claude-opus-5[1m]' — which would push a context-1m beta
// header the model never needs and has no display-name case (renders raw).
test('strips the meaningless [1m] tag from the opus alias', () => {
  expect(isNative1mModel('claude-opus-5')).toBe(true)
  const parsed = parseUserSpecifiedModel('opus[1m]')
  expect(parsed).toBe('claude-opus-5')
  expect(parsed).not.toContain('[1m]')
  // A resolvable display name is what keeps the raw ID out of the footer.
  expect(getPublicModelDisplayName(parsed)).toBe('Opus 5')
})

// The picker renders the lightning bolt + fast-mode pricing for Opus 5, so the
// support check must agree — otherwise /fast silently self-disables on the
// first-party default model.
test('is eligible for fast mode', () => {
  expect(isFastModeSupportedByModel('claude-opus-5')).toBe(true)
})

// Gates the "Opus is not available with the Claude Pro plan" hint (errors.ts)
// and the 529 Opus-fallback path (withRetry.ts).
test('counts as a non-custom Opus model', () => {
  expect(isNonCustomOpusModel('claude-opus-5')).toBe(true)
})
