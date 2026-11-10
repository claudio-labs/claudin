import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'

// Provider isolation — see sonnet5.test.ts for the full rationale, and
// opus55.test.ts for why the model-string cache is cleared with it. The 3P
// fallback tests flip the provider to Vertex (no inference-profile fetch, bare
// first-party ids), so the pin reads a variable instead of a constant.
const realProviders = { ...(await import('src/providers/model/providers.js')) }
let provider = 'firstParty'
const pinProvider = () => {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => provider,
  }))
  resetModelStringsForTestingOnly()
}
pinProvider()

beforeEach(() => {
  provider = 'firstParty'
  pinProvider()
})

afterEach(() => {
  provider = 'firstParty'
  resetModelStringsForTestingOnly()
})

afterAll(() => {
  mock.module('./providers.js', () => realProviders)
  resetModelStringsForTestingOnly()
})

import {
  firstPartyNameToCanonical,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isNative1mModel,
  modelRejectsSamplingParams,
  parseUserSpecifiedModel,
} from 'src/providers/model/model.js'
import { getModelMaxOutputTokens, modelSupports1M } from 'src/agent/context/context.js'
import {
  modelRequiresAdaptiveThinking,
  modelSupportsAdaptiveThinking,
} from 'src/agent/context/thinking.js'
import {
  getAvailableEffortLevels,
  getDefaultEffortForModel,
} from 'src/providers/effort/effort.js'
import { MODEL_COSTS } from 'src/providers/usage/modelCost.js'
import { modelSupportsThinkingBlockBinding } from 'src/providers/transport/betas.js'
import { getKnowledgeCutoff } from 'src/agent/prompts/prompts.js'
import { isMitigationExemptModel } from 'src/tools/FileReadTool/resultContent.js'
import { sanitizeModelName } from 'src/vcs/git/commitAttribution.js'

// Claude Fable 5.2 (2026-11-09, Claude Code 2.1.322) is the latest Fable. Its
// id CONTAINS 'claude-fable-5', so every capability predicate matches it for
// free and every site that RESOLVES a version gave the retired Fable 5's
// answer: name, cutoff, price, commit trailer. What Claude Code sends for it is
// pinned in claudeCodeParity.test.ts; this file pins the rest, and that 5.1
// keeps its own answers now that a newer id sits next to it.

test('canonicalizes to claude-fable-5-2, not to claude-fable-5', () => {
  expect(firstPartyNameToCanonical('claude-fable-5-2')).toBe('claude-fable-5-2')
  expect(firstPartyNameToCanonical('anthropic.claude-fable-5-2')).toBe('claude-fable-5-2')
  expect(firstPartyNameToCanonical('us.anthropic.claude-fable-5-2')).toBe('claude-fable-5-2')
  expect(firstPartyNameToCanonical('claude-fable-5-1')).toBe('claude-fable-5-1')
  expect(firstPartyNameToCanonical('claude-fable-5')).toBe('claude-fable-5')
})

// OpenRouter and GitHub Copilot write the version with a dot. Those contain
// 'claude-fable-5' but neither hyphenated id, so both fell to the retired
// Fable 5 — 5.1 included, before 5.2 existed.
test('dotted gateway ids resolve to Fable 5.1, not to Fable 5', () => {
  expect(firstPartyNameToCanonical('anthropic/claude-fable-5.1')).toBe('claude-fable-5-1')
  expect(firstPartyNameToCanonical('claude-fable-5.1')).toBe('claude-fable-5-1')
})

test('dotted gateway ids resolve to Fable 5.2', () => {
  expect(firstPartyNameToCanonical('anthropic/claude-fable-5.2')).toBe('claude-fable-5-2')
  expect(firstPartyNameToCanonical('claude-fable-5.2')).toBe('claude-fable-5-2')
})

test('keeps the Fable request shape: 1M native, adaptive only, no sampling params', () => {
  expect(modelSupports1M('claude-fable-5-2')).toBe(true)
  expect(isNative1mModel('claude-fable-5-2')).toBe(true)
  expect(modelRequiresAdaptiveThinking('claude-fable-5-2')).toBe(true)
  expect(modelSupportsAdaptiveThinking('claude-fable-5-2')).toBe(true)
  expect(modelRejectsSamplingParams('claude-fable-5-2')).toBe(true)
  expect(getAvailableEffortLevels('claude-fable-5-2')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

// Claude Code's catalog moved the default from 5.1's `high` to `medium`; the
// 'fable-5' flagship branch would hand 5.2 `high` with nothing else going red.
test('defaults to medium effort on first party, while Fable 5.1 keeps high', () => {
  expect(getDefaultEffortForModel('claude-fable-5-2')).toBe('medium')
  expect(getDefaultEffortForModel('claude-fable-5-1')).toBe('high')
})

test('gets the 128k max-output default; Fable 5.1 keeps 64k', () => {
  expect(getModelMaxOutputTokens('claude-fable-5-2')).toEqual({ default: 128_000, upperLimit: 128_000 })
  expect(getModelMaxOutputTokens('claude-fable-5-1')).toEqual({ default: 64_000, upperLimit: 128_000 })
})

// $8/$40 with a $0.20 cache read — 0.025x the base input, like 5.1's ratio.
// Not the private Opus 5.5 fast tier, which shares $8/$40 but reads at $0.40.
test('bills at the $8/$40 tier with the $0.20 cache read', () => {
  expect(MODEL_COSTS['claude-fable-5-2']).toEqual({
    inputTokens: 8,
    outputTokens: 40,
    promptCacheWriteTokens: 10,
    promptCacheWrite1hTokens: 16,
    promptCacheReadTokens: 0.2,
    webSearchRequests: 0.01,
  })
  expect(MODEL_COSTS['claude-fable-5-1']?.promptCacheReadTokens).toBe(0.25)
})

test('names itself Fable 5.2 on every display path', () => {
  expect(getMarketingNameForModel('claude-fable-5-2')).toBe('Fable 5.2')
  expect(getPublicModelDisplayName('claude-fable-5-2')).toBe('Fable 5.2')
  expect(getMarketingNameForModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(getKnowledgeCutoff('claude-fable-5-2')).toBe('June 2026')
})

// Claude Code's `fable` alias moved to 5.2. `fable5` has pointed at the newest
// Fable since Fable 5 retired; `fable51` is the way to stay on 5.1.
test('the fable aliases resolve to 5.2, and fable51 stays on 5.1', () => {
  expect(parseUserSpecifiedModel('fable')).toBe('claude-fable-5-2')
  expect(parseUserSpecifiedModel('fable52')).toBe('claude-fable-5-2')
  expect(parseUserSpecifiedModel('fable5')).toBe('claude-fable-5-2')
  // Native 1M: the tag is dropped, never a phantom claude-fable-5-2[1m].
  expect(parseUserSpecifiedModel('fable[1m]')).toBe('claude-fable-5-2')
  expect(parseUserSpecifiedModel('fable51')).toBe('claude-fable-5-1')
})

test('opts into thinking block-binding (all four replays returned 200)', () => {
  expect(modelSupportsThinkingBlockBinding('claude-fable-5-2')).toBe(true)
  expect(modelSupportsThinkingBlockBinding('claude-fable-5')).toBe(false)
})

// Claude Code 2.1.322 has no cyber-risk read reminder at all.
test('is exempt from the cyber-risk read reminder, like Fable 5.1', () => {
  expect(isMitigationExemptModel('claude-fable-5-2')).toBe(true)
})

test('commit trailers name 5.2', () => {
  expect(sanitizeModelName('claude-fable-5-2')).toBe('claude-fable-5-2')
  expect(sanitizeModelName('claude-fable-5-1')).toBe('claude-fable-5-1')
})
