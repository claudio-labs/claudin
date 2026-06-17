import { describe, expect, it } from 'bun:test'
import type { ModelFamily } from './familyAddendums/index.js'
import { isLeanFamily } from './toolPromptTier.js'

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
