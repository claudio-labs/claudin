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
  getDefaultSonnetModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isNative1mModel,
  modelRejectsSamplingParams,
  parseUserSpecifiedModel,
} from 'src/providers/model/model.js'
import { getModelMaxOutputTokens, modelSupports1M } from 'src/agent/context/context.js'
import {
  getAvailableEffortLevels,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} from 'src/providers/effort/effort.js'
import { CLAUDE_SONNET_5_5_CONFIG } from 'src/providers/model/configs.js'
import { getKnowledgeCutoff } from 'src/agent/prompts/prompts.js'
import { modelSupportsThinkingBlockBinding } from 'src/providers/transport/betas.js'
import { sanitizeModelName } from 'src/vcs/git/commitAttribution.js'
import { getVertexRegionForModel } from 'src/shared/envUtils.js'

// Sonnet 5.5 is the default Sonnet tier from 2026-09-28. What it shares with
// Claude Code is pinned in claudeCodeParity.test.ts, against the capture in
// __fixtures__/claude-code-wire/. This file covers the rest: the id forms other
// providers use, and every resolver where 'claude-sonnet-5-5' containing
// 'claude-sonnet-5' would silently yield Sonnet 5's answer — or the reverse,
// where the new branch drags Sonnet 5 forward.

test('canonicalizes every provider form to claude-sonnet-5-5', () => {
  expect(firstPartyNameToCanonical('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  // Bedrock, with and without a cross-region profile prefix.
  expect(firstPartyNameToCanonical('anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  expect(firstPartyNameToCanonical('global.anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  // GitHub Copilot and OpenRouter write the version with a dot.
  expect(firstPartyNameToCanonical('claude-sonnet-5.5')).toBe('claude-sonnet-5-5')
  expect(firstPartyNameToCanonical('anthropic/claude-sonnet-5.5')).toBe('claude-sonnet-5-5')
})

test('Sonnet 5 is not dragged forward by the 5.5 branch', () => {
  expect(firstPartyNameToCanonical('claude-sonnet-5')).toBe('claude-sonnet-5')
  expect(firstPartyNameToCanonical('anthropic.claude-sonnet-5')).toBe('claude-sonnet-5')
  expect(getMarketingNameForModel('claude-sonnet-5')).toBe('Sonnet 5')
  expect(getKnowledgeCutoff('claude-sonnet-5')).toBe('January 2026')
  expect(getModelMaxOutputTokens('claude-sonnet-5').default).toBe(64_000)
  // Sonnet 5 predates preserved thinking.
  expect(modelSupportsThinkingBlockBinding('claude-sonnet-5')).toBe(false)
})

test('a dotted gateway id gets the 5.5 name and cutoff, not Sonnet 5’s', () => {
  expect(getMarketingNameForModel('anthropic/claude-sonnet-5.5')).toBe('Sonnet 5.5')
  expect(getKnowledgeCutoff('anthropic/claude-sonnet-5.5')).toBe('June 2026')
})

test('config uses the dateless pinned-snapshot IDs', () => {
  expect(CLAUDE_SONNET_5_5_CONFIG.firstParty).toBe('claude-sonnet-5-5')
  // Bedrock uses the Messages-API id, not a legacy us.…-v1:0 ARN.
  expect(CLAUDE_SONNET_5_5_CONFIG.bedrock).toBe('anthropic.claude-sonnet-5-5')
  expect(CLAUDE_SONNET_5_5_CONFIG.vertex).toBe('claude-sonnet-5-5')
  expect(CLAUDE_SONNET_5_5_CONFIG.foundry).toBe('claude-sonnet-5-5')
})

test('is the first-party default Sonnet', () => {
  expect(getDefaultSonnetModel()).toBe('claude-sonnet-5-5')
})

// Native-1M, so a [1m] tag on the alias must be dropped rather than producing a
// phantom 'claude-sonnet-5-5[1m]' with no display-name case.
test('resolves the sonnet alias and strips the meaningless [1m] tag', () => {
  expect(modelSupports1M('claude-sonnet-5-5')).toBe(true)
  expect(isNative1mModel('claude-sonnet-5-5')).toBe(true)
  const parsed = parseUserSpecifiedModel('sonnet[1m]')
  expect(parsed).toBe('claude-sonnet-5-5')
  expect(getPublicModelDisplayName(parsed)).toBe('Sonnet 5.5')
})

test('rejects non-default sampling params', () => {
  expect(modelRejectsSamplingParams('claude-sonnet-5-5')).toBe(true)
})

test('supports the full low→max effort ladder', () => {
  expect(modelSupportsEffort('claude-sonnet-5-5')).toBe(true)
  expect(modelSupportsXhighEffort('claude-sonnet-5-5')).toBe(true)
  expect(modelSupportsMaxEffort('claude-sonnet-5-5')).toBe(true)
  expect(getAvailableEffortLevels('claude-sonnet-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

// Git commit trailers show the public model id; the sonnet-5 branch would put
// "claude-sonnet-5" in every trailer written by a 5.5 session.
test('sanitizes to its own id for commit trailers', () => {
  expect(sanitizeModelName('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  expect(sanitizeModelName('claude-sonnet-5')).toBe('claude-sonnet-5')
})

// VERTEX_REGION_OVERRIDES is an ordered startsWith list, so the 5.5 entry must
// come first or Sonnet 5.5 reads Sonnet 5's variable.
test('reads its own Vertex region variable, and Sonnet 5 reads its own', () => {
  const saved = {
    s55: process.env.VERTEX_REGION_CLAUDE_5_5_SONNET,
    s5: process.env.VERTEX_REGION_CLAUDE_5_SONNET,
  }
  process.env.VERTEX_REGION_CLAUDE_5_5_SONNET = 'europe-west4'
  process.env.VERTEX_REGION_CLAUDE_5_SONNET = 'us-east5'
  try {
    expect(getVertexRegionForModel('claude-sonnet-5-5')).toBe('europe-west4')
    expect(getVertexRegionForModel('claude-sonnet-5')).toBe('us-east5')
  } finally {
    for (const [key, value] of [
      ['VERTEX_REGION_CLAUDE_5_5_SONNET', saved.s55],
      ['VERTEX_REGION_CLAUDE_5_SONNET', saved.s5],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
