import { afterEach, describe, expect, it } from 'bun:test'
import type { ModelFamily } from 'src/agent/prompts/familyAddendums/index.js'
import {
  getForcedToolPromptTier,
  isLeanFamily,
  isLeanToolPromptFamily,
} from 'src/agent/prompts/toolPromptTier.js'

describe('isLeanFamily', () => {
  const lean: ModelFamily[] = ['anthropic', 'openai-reasoning', 'gemini', 'codex']
  const verbose: ModelFamily[] = ['glm', 'kimi', 'default']

  it('treats capable families as lean', () => {
    for (const family of lean) {
      expect(isLeanFamily(family)).toBe(true)
    }
  })

  it('keeps weak/unknown families verbose', () => {
    for (const family of verbose) {
      expect(isLeanFamily(family)).toBe(false)
    }
  })

  // Exhaustiveness is enforced at COMPILE time by the FAMILY_TIER Record in
  // toolPromptTier.ts (a new ModelFamily breaks the build there). This runtime
  // test only documents/regresses the current tier mapping.
  it('classifies every known family explicitly', () => {
    expect([...lean, ...verbose].sort()).toEqual(
      ['anthropic', 'codex', 'default', 'gemini', 'glm', 'kimi', 'openai-reasoning'],
    )
  })
})

describe('CLAUDIN_TOOL_PROMPT_TIER override', () => {
  const KEY = 'CLAUDIN_TOOL_PROMPT_TIER'

  afterEach(() => {
    delete process.env[KEY]
  })

  it('is absent by default', () => {
    delete process.env[KEY]
    expect(getForcedToolPromptTier()).toBeNull()
  })

  it('accepts both tiers, case-insensitively and with surrounding space', () => {
    process.env[KEY] = 'lean'
    expect(getForcedToolPromptTier()).toBe('lean')
    process.env[KEY] = '  VERBOSE '
    expect(getForcedToolPromptTier()).toBe('verbose')
  })

  // A typo must not get a vote. `CLAUDIN_TOOL_PROMPT_TIER=leen` falling back to
  // the family is the safe outcome; treating any non-empty value as "lean"
  // would silently strip guardrails from a glm/kimi run.
  it('ignores anything that is not exactly one of the two tiers', () => {
    for (const bad of ['', ' ', '1', 'true', 'leen', 'verbos', 'lean,verbose']) {
      process.env[KEY] = bad
      expect(getForcedToolPromptTier()).toBeNull()
    }
  })

  // The point of the override: the A/B bench pins ONE model across both arms,
  // so the tier decision must stop before the family lookup rather than merely
  // agreeing with it. Asserted in both directions — an override that only ever
  // returned `true` would pass a one-sided test while making the bench measure
  // nothing.
  it('decides the tier without consulting the active model', () => {
    process.env[KEY] = 'lean'
    expect(isLeanToolPromptFamily()).toBe(true)
    process.env[KEY] = 'verbose'
    expect(isLeanToolPromptFamily()).toBe(false)
  })
})
