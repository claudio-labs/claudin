import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

// Provider isolation. Same reason as sonnet5.test.ts: getAvailableEffortLevels()
// → modelUsesOpenAIEffort() → getAPIProvider(), and Bun's mock.module is
// process-global, so a leaked non-firstParty provider from any other file
// collapses the effort ladder to the OpenAI tiers. Pin the single decision
// point and re-assert it before each test.
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
  isNative1mModel,
  modelRejectsSamplingParams,
} from 'src/providers/model/model.js'
import { modelSupports1M } from 'src/agent/context/context.js'
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
} from 'src/providers/effort/effort.js'
import { MODEL_COSTS } from 'src/providers/usage/modelCost.js'
import { CLAUDE_FABLE_5_1_CONFIG } from 'src/providers/model/configs.js'
import { sanitizeModelName } from 'src/vcs/git/commitAttribution.js'

// Claude Fable 5.1 replaced Fable 5 on 2026-09-01. It keeps Fable 5's
// request-shaping profile wholesale (adaptive thinking always on, budget_tokens
// and sampling params rejected, 1M-native), so most capability predicates match
// it for free — 'claude-fable-5-1' CONTAINS 'claude-fable-5'. That substring is
// also the hazard: anything returning a Fable 5 VALUE has to test for 5.1
// first. These tests pin both halves.
//
// The native-1M *context window* resolution (getContextWindowForModel) is
// provider-gated (isOpenAIShimTransport), so that regression lives in
// context.test.ts where the active provider is controlled.

test('canonicalizes to claude-fable-5-1, not to claude-fable-5', () => {
  expect(firstPartyNameToCanonical('claude-fable-5-1')).toBe('claude-fable-5-1')
  expect(firstPartyNameToCanonical('anthropic.claude-fable-5-1')).toBe(
    'claude-fable-5-1',
  )
  // The whole point of the branch ordering: without it this returns
  // 'claude-fable-5' and every price and label below silently regresses.
  expect(firstPartyNameToCanonical('claude-fable-5-1')).not.toBe(
    'claude-fable-5',
  )
})

test('the retired Fable 5 string still canonicalizes to itself', () => {
  // Kept reachable for agent `model:` frontmatter pins, which live on disk and
  // migrateFable5ToFable51 cannot rewrite. Dropping this branch sends them to
  // the generic regex ('claude-fable') and thus to the default model's price.
  expect(firstPartyNameToCanonical('claude-fable-5')).toBe('claude-fable-5')
})

test('config uses the dateless pinned-snapshot IDs', () => {
  expect(CLAUDE_FABLE_5_1_CONFIG.firstParty).toBe('claude-fable-5-1')
  // Bedrock uses the Messages-API id, not the legacy us.…-v1:0 ARN.
  expect(CLAUDE_FABLE_5_1_CONFIG.bedrock).toBe('anthropic.claude-fable-5-1')
  expect(CLAUDE_FABLE_5_1_CONFIG.vertex).toBe('claude-fable-5-1')
  expect(CLAUDE_FABLE_5_1_CONFIG.foundry).toBe('claude-fable-5-1')
})

test('supports 1M context natively', () => {
  expect(modelSupports1M('claude-fable-5-1')).toBe(true)
  expect(isNative1mModel('claude-fable-5-1')).toBe(true)
})

test('requires adaptive thinking (budget_tokens 400s)', () => {
  expect(modelRequiresAdaptiveThinking('claude-fable-5-1')).toBe(true)
  expect(modelSupportsAdaptiveThinking('claude-fable-5-1')).toBe(true)
  // Must be recognized as thinking-capable, otherwise streaming.ts skips the
  // thinking block entirely (hasThinking && modelSupportsThinking gate).
  expect(modelSupportsThinking('claude-fable-5-1')).toBe(true)
})

test('rejects non-default sampling params', () => {
  expect(modelRejectsSamplingParams('claude-fable-5-1')).toBe(true)
})

test('supports the full effort ladder through max', () => {
  expect(modelSupportsEffort('claude-fable-5-1')).toBe(true)
  expect(modelSupportsXhighEffort('claude-fable-5-1')).toBe(true)
  expect(modelSupportsMaxEffort('claude-fable-5-1')).toBe(true)
  expect(getAvailableEffortLevels('claude-fable-5-1')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('prices cache reads at the irregular 0.025x multiplier', () => {
  const costs = MODEL_COSTS['claude-fable-5-1']
  expect(costs).toBeDefined()
  expect(costs?.inputTokens).toBe(10)
  expect(costs?.outputTokens).toBe(50)
  expect(costs?.promptCacheWriteTokens).toBe(12.5)
  expect(costs?.promptCacheWrite1hTokens).toBe(20)
  // 0.025x of the $10 base input, not the standard 0.1x every other model uses.
  // Getting this wrong overstates a cache-heavy session's cost by 4x.
  expect(costs?.promptCacheReadTokens).toBe(0.25)
})

test('the retired Fable 5 keeps its own, higher cache-read price', () => {
  expect(MODEL_COSTS['claude-fable-5']?.promptCacheReadTokens).toBe(1)
})

test('reports the public marketing name', () => {
  expect(getMarketingNameForModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(getMarketingNameForModel('claude-fable-5')).toBe('Fable 5')
})

test('commit trailers name 5.1, not 5', () => {
  expect(sanitizeModelName('claude-fable-5-1')).toBe('claude-fable-5-1')
  expect(sanitizeModelName('claude-fable-5')).toBe('claude-fable-5')
})
