import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

// Provider isolation — see sonnet5.test.ts for the full rationale. Pin
// getAPIProvider to 'firstParty' so a cross-file mock.module leak can't collapse
// the effort ladder to the OpenAI tiers.
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
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isNative1mModel,
  isNonCustomOpusModel,
  modelRejectsSamplingParams,
  parseUserSpecifiedModel,
} from 'src/providers/model/model.js'
import {
  getModelMaxOutputTokens,
  modelSupports1M,
} from 'src/agent/context/context.js'
import { isFastModeSupportedByModel } from 'src/providers/fastMode.js'
import {
  modelRequiresAdaptiveThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from 'src/agent/context/thinking.js'
import {
  getAvailableEffortLevels,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} from 'src/providers/effort/effort.js'
import { COST_TIER_4_20, MODEL_COSTS } from 'src/providers/usage/modelCost.js'
import { CLAUDE_OPUS_5_5_CONFIG } from 'src/providers/model/configs.js'
import { modelSupportsThinkingBlockBinding } from 'src/providers/transport/betas.js'
import {
  clearBetasCaches,
  getAllModelBetas,
} from 'src/providers/transport/betas.js'
import { THINKING_BINDING_CONTROLS_BETA_HEADER } from 'src/shared/constants/betas.js'
import { isMitigationExemptModel } from 'src/tools/FileReadTool/resultContent.js'
import { sanitizeModelName } from 'src/vcs/git/commitAttribution.js'

// Opus 5.5 is the default Opus tier from 2026-09-22. It inherits Opus 5's
// request-shaping profile (adaptive thinking always on, budget_tokens and
// sampling params rejected, 1M-native), so most capability predicates match it
// for free through the `opus-5` substring. What this file is really for is the
// other half: every site that RESOLVES a version rather than testing one, where
// 'claude-opus-5-5' containing 'claude-opus-5' silently yields Opus 5's answer.
// The wire shape those resolutions produce is captured in
// docs/tech/opus-5-5/wire-capture.md.

// THE load-bearing one. The canonical name is the MODEL_COSTS key and what
// every display path reads, so a 5.5 branch placed after the Opus 5 branch in
// firstPartyNameToCanonical bills at $5/$25 and renders as "Opus 5".
test('canonicalizes to claude-opus-5-5, not to claude-opus-5', () => {
  expect(firstPartyNameToCanonical('claude-opus-5-5')).toBe('claude-opus-5-5')
  expect(firstPartyNameToCanonical('anthropic.claude-opus-5-5')).toBe(
    'claude-opus-5-5',
  )
  // And the older model must not be dragged forward by the new branch.
  expect(firstPartyNameToCanonical('claude-opus-5')).toBe('claude-opus-5')
})

test('config uses the dateless pinned-snapshot IDs', () => {
  expect(CLAUDE_OPUS_5_5_CONFIG.firstParty).toBe('claude-opus-5-5')
  // Bedrock uses the Messages-API id, not a legacy us.…-v1:0 ARN.
  expect(CLAUDE_OPUS_5_5_CONFIG.bedrock).toBe('anthropic.claude-opus-5-5')
  expect(CLAUDE_OPUS_5_5_CONFIG.vertex).toBe('claude-opus-5-5')
  expect(CLAUDE_OPUS_5_5_CONFIG.foundry).toBe('claude-opus-5-5')
})

test('supports 1M context natively', () => {
  expect(modelSupports1M('claude-opus-5-5')).toBe(true)
})

test('requires adaptive thinking (budget_tokens 400s)', () => {
  expect(modelRequiresAdaptiveThinking('claude-opus-5-5')).toBe(true)
  expect(modelSupportsAdaptiveThinking('claude-opus-5-5')).toBe(true)
  expect(modelSupportsThinking('claude-opus-5-5')).toBe(true)
})

test('rejects non-default sampling params', () => {
  expect(modelRejectsSamplingParams('claude-opus-5-5')).toBe(true)
})

test('supports the full low→max effort ladder', () => {
  expect(modelSupportsEffort('claude-opus-5-5')).toBe(true)
  expect(modelSupportsXhighEffort('claude-opus-5-5')).toBe(true)
  expect(modelSupportsMaxEffort('claude-opus-5-5')).toBe(true)
  expect(getAvailableEffortLevels('claude-opus-5-5')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

// Anthropic documents `medium` as Opus 5.5's own default; Claudin deliberately
// overrides that to `high` for first-party flagships, and 'claude-opus-5-5'
// reaches that branch only because it contains 'opus-5'. Pin it: a future
// refactor that tightens the flagship branch to an exact match would drop 5.5
// to medium with nothing else going red.
test('keeps the first-party flagship high effort default', () => {
  expect(getDefaultEffortForModel('claude-opus-5-5')).toBe('high')
})

// $4/$20 with a 0.05x cache read ($0.20) — the second irregular multiplier in
// the table. Inheriting Opus 5's entry would overcharge cache reads 2.5x.
test('bills at the $4/$20 tier with the irregular 0.05x cache read', () => {
  const canonical = firstPartyNameToCanonical(CLAUDE_OPUS_5_5_CONFIG.firstParty)
  expect(MODEL_COSTS[canonical]).toEqual(COST_TIER_4_20)
  expect(COST_TIER_4_20.promptCacheReadTokens).toBe(0.2)
  expect(COST_TIER_4_20.promptCacheReadTokens).not.toBe(
    COST_TIER_4_20.inputTokens * 0.1,
  )
})

test('reports its own public marketing name', () => {
  expect(getMarketingNameForModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(getMarketingNameForModel('claude-opus-5')).toBe('Opus 5')
})

// Claude Code sends max_tokens: 128000 for this model
// (docs/tech/opus-5-5/wire-capture.md). The opus-5 branch it matches by
// substring would cap the DEFAULT at 64k — half the output budget, silently.
test('gets the full 128k max-output default, not Opus 5’s 64k', () => {
  expect(getModelMaxOutputTokens('claude-opus-5-5')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

// Native-1M, so a [1m] tag on the alias must be dropped rather than producing a
// phantom 'claude-opus-5-5[1m]' — which would push a context-1m beta header the
// model never needs and has no display-name case (renders raw).
test('resolves the opus alias and strips the meaningless [1m] tag', () => {
  expect(isNative1mModel('claude-opus-5-5')).toBe(true)
  const parsed = parseUserSpecifiedModel('opus[1m]')
  expect(parsed).toBe('claude-opus-5-5')
  expect(parsed).not.toContain('[1m]')
  expect(getPublicModelDisplayName(parsed)).toBe('Opus 5.5')
})

test('is eligible for fast mode', () => {
  expect(isFastModeSupportedByModel('claude-opus-5-5')).toBe(true)
})

// Gates the "Opus is not available with the Claude Pro plan" hint (errors.ts)
// and the 529 Opus-fallback path (withRetry.ts). An exact-equality list, so it
// inherits nothing from the substring.
test('counts as a non-custom Opus model', () => {
  expect(isNonCustomOpusModel('claude-opus-5-5')).toBe(true)
})

// MITIGATION_EXEMPT_MODELS is a Set of exact canonical names. Without an entry
// every file read on Opus 5.5 carries a cyber-risk system-reminder that the
// model it replaces does not get.
test('is exempt from the cyber-risk read reminder, like Opus 5', () => {
  expect(isMitigationExemptModel('claude-opus-5-5')).toBe(true)
  expect(isMitigationExemptModel('claude-opus-5')).toBe(true)
})

// Git commit trailers show the public model id; the opus-5 branch would put
// "claude-opus-5" in every trailer written by a 5.5 session.
test('sanitizes to its own id for commit trailers', () => {
  expect(sanitizeModelName('claude-opus-5-5')).toBe('claude-opus-5-5')
  expect(sanitizeModelName('claude-opus-5')).toBe('claude-opus-5')
})

// Preserved thinking: Claudin rewrites its own prefix (clip restubs plus
// stripOldThinkingBlocks), so it needs the block-binding escape hatch that
// Claude Code does not send. Scoped to the two models Anthropic documents as
// enforcing it — a substring match on 'opus-5' would send the header to Opus 5,
// which does not enforce the check and gains nothing from it.
test('opts into thinking block-binding, together with Fable 5.1 only', () => {
  expect(modelSupportsThinkingBlockBinding('claude-opus-5-5')).toBe(true)
  expect(modelSupportsThinkingBlockBinding('claude-fable-5-1')).toBe(true)
  expect(modelSupportsThinkingBlockBinding('claude-opus-5')).toBe(false)
  expect(modelSupportsThinkingBlockBinding('claude-sonnet-5')).toBe(false)
  // The retired Fable 5 predates preserved thinking, and its id is a prefix of
  // 5.1's — the same containment trap, one tier over.
  expect(modelSupportsThinkingBlockBinding('claude-fable-5')).toBe(false)
})

// And the predicate is actually wired into the header list — a true predicate
// nothing reads would ship the block_binding field with no beta to accept it.
//
// The env var is what makes this worth its own test rather than trusting the
// predicate: cli.tsx sets CLAUDIN_DISABLE_EXPERIMENTAL_BETAS to 'true' unless
// the user opts out, so a header gated on shouldIncludeFirstPartyOnlyBetas()
// ships to nobody. Asserting WITH the switch on is the whole point — it fails
// the moment someone moves this header behind that gate.
test('emits the block-binding beta header for 5.5 only, even with experimental betas off', () => {
  const saved = process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS
  process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = 'true'
  clearBetasCaches()
  try {
    expect(getAllModelBetas('claude-opus-5-5')).toContain(
      THINKING_BINDING_CONTROLS_BETA_HEADER,
    )
    expect(getAllModelBetas('claude-fable-5-1')).toContain(
      THINKING_BINDING_CONTROLS_BETA_HEADER,
    )
    expect(getAllModelBetas('claude-opus-5')).not.toContain(
      THINKING_BINDING_CONTROLS_BETA_HEADER,
    )
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS
    } else {
      process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = saved
    }
    clearBetasCaches()
  }
})
