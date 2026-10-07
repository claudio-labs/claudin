import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Provider isolation — see sonnet5.test.ts for the full rationale. Every
// resolver below reads getAPIProvider(), and a cross-file mock.module leak can
// leave a non-firstParty provider active.
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
} from 'src/providers/model/model.js'
import { getModelMaxOutputTokens } from 'src/agent/context/context.js'
import { modelRequiresAdaptiveThinking } from 'src/agent/context/thinking.js'
import { getDefaultEffortForModel } from 'src/providers/effort/effort.js'
import { getKnowledgeCutoff } from 'src/agent/prompts/prompts.js'
import {
  clearBetasCaches,
  getAllModelBetas,
  modelSupportsThinkingBlockBinding,
} from 'src/providers/transport/betas.js'
import { THINKING_BINDING_CONTROLS_BETA_HEADER } from 'src/shared/constants/betas.js'
import {
  COST_HAIKU_55,
  COST_TIER_2_10,
  COST_TIER_4_20,
  MODEL_COSTS,
  type ModelCosts,
} from 'src/providers/usage/modelCost.js'

// What Claude Code sends for a model, captured on the real API through
// wire-proxy by scripts/bench/ab/model-launch-capture.ts (--fixtures), next to
// the model's entry in Claude Code's baked catalog. Each fixture is one model
// Claudin should shape the same way; a delta Claudin keeps ON PURPOSE does not
// belong in a fixture, it belongs in that model's own test with the reason.
//
// Written before Sonnet 5.5 was registered, so it went red on Sonnet 5.5 and
// stayed green on Opus 5.5 — the control that shows the harness can pass.
// Haiku 5.5 (Claude Code 2.1.293) took the same route.

type Fixture = {
  model: string
  catalog: {
    display_name: string
    knowledge_cutoff: string
    default_effort: string
    pricing: string
  }
  request: {
    max_tokens: number
    thinking: { type: string }
    betas: string[]
  }
}

const FIXTURE_ROOT = join(import.meta.dir, '__fixtures__', 'claude-code-wire')
const fixtures: Fixture[] = readdirSync(FIXTURE_ROOT).flatMap(version =>
  readdirSync(join(FIXTURE_ROOT, version))
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(FIXTURE_ROOT, version, f), 'utf8')) as Fixture),
)

// Claude Code's tier names, as its catalog spells them.
const TIERS: Record<string, ModelCosts> = {
  haiku_55: COST_HAIKU_55,
  tier_2_10: COST_TIER_2_10,
  tier_4_20_cache_read_0_20: COST_TIER_4_20,
}

test('the capture is on disk (an empty fixture dir would pass every check below)', () => {
  expect(fixtures.map(f => f.model).sort()).toEqual([
    'claude-haiku-5-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ])
})

describe.each(fixtures.map(f => [f.model, f] as const))('%s matches Claude Code', (model, f) => {
  test('canonicalizes to itself (the MODEL_COSTS key and every display path)', () => {
    expect(firstPartyNameToCanonical(model)).toBe(model)
  })

  test(`defaults to max_tokens ${f.request.max_tokens}`, () => {
    expect(getModelMaxOutputTokens(model).default).toBe(f.request.max_tokens)
  })

  test('requires adaptive thinking', () => {
    expect(f.request.thinking.type).toBe('adaptive')
    expect(modelRequiresAdaptiveThinking(model)).toBe(true)
  })

  test(`defaults to ${f.catalog.default_effort} effort`, () => {
    expect<unknown>(getDefaultEffortForModel(model)).toBe(f.catalog.default_effort)
  })

  test(`is named ${f.catalog.display_name}`, () => {
    expect(getMarketingNameForModel(model)).toBe(f.catalog.display_name)
  })

  test(`has the ${f.catalog.knowledge_cutoff} knowledge cutoff`, () => {
    expect(getKnowledgeCutoff(model)).toBe(f.catalog.knowledge_cutoff)
  })

  test(`bills at ${f.catalog.pricing}`, () => {
    expect(TIERS[f.catalog.pricing]).toBeDefined()
    expect(MODEL_COSTS[firstPartyNameToCanonical(model)]).toEqual(TIERS[f.catalog.pricing]!)
  })

  // Claude Code sends thinking-binding-controls and echoes thinking verbatim.
  // Claudin rewrites its own prefix (stripOldThinkingBlocks), so on a model
  // that enforces preserved thinking it must send the header AND the
  // block_binding field — with the experimental-betas switch on, as cli.tsx
  // ships it.
  test('sends thinking-binding-controls, even with experimental betas off', () => {
    expect(f.request.betas).toContain(THINKING_BINDING_CONTROLS_BETA_HEADER)
    expect(modelSupportsThinkingBlockBinding(model)).toBe(true)
    const saved = process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = 'true'
    clearBetasCaches()
    try {
      expect(getAllModelBetas(model)).toContain(THINKING_BINDING_CONTROLS_BETA_HEADER)
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS
      else process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = saved
      clearBetasCaches()
    }
  })
})
