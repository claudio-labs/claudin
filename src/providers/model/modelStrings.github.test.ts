import { afterEach, expect, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'
import { parseUserSpecifiedModel } from 'src/providers/model/model.js'
import { getModelStrings } from 'src/providers/model/modelStrings.js'

const originalEnv = {
  CLAUDIN_USE_GITHUB: process.env.CLAUDIN_USE_GITHUB,
  CLAUDIN_USE_OPENAI: process.env.CLAUDIN_USE_OPENAI,
  CLAUDIN_USE_GEMINI: process.env.CLAUDIN_USE_GEMINI,
  CLAUDIN_USE_BEDROCK: process.env.CLAUDIN_USE_BEDROCK,
  CLAUDIN_USE_VERTEX: process.env.CLAUDIN_USE_VERTEX,
  CLAUDIN_USE_FOUNDRY: process.env.CLAUDIN_USE_FOUNDRY,
}

function clearProviderFlags(): void {
  delete process.env.CLAUDIN_USE_GITHUB
  delete process.env.CLAUDIN_USE_OPENAI
  delete process.env.CLAUDIN_USE_GEMINI
  delete process.env.CLAUDIN_USE_BEDROCK
  delete process.env.CLAUDIN_USE_VERTEX
  delete process.env.CLAUDIN_USE_FOUNDRY
}

afterEach(() => {
  process.env.CLAUDIN_USE_GITHUB = originalEnv.CLAUDIN_USE_GITHUB
  process.env.CLAUDIN_USE_OPENAI = originalEnv.CLAUDIN_USE_OPENAI
  process.env.CLAUDIN_USE_GEMINI = originalEnv.CLAUDIN_USE_GEMINI
  process.env.CLAUDIN_USE_BEDROCK = originalEnv.CLAUDIN_USE_BEDROCK
  process.env.CLAUDIN_USE_VERTEX = originalEnv.CLAUDIN_USE_VERTEX
  process.env.CLAUDIN_USE_FOUNDRY = originalEnv.CLAUDIN_USE_FOUNDRY
  resetModelStringsForTestingOnly()
})

test('GitHub provider model strings are concrete IDs', () => {
  clearProviderFlags()
  process.env.CLAUDIN_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  for (const value of Object.values(modelStrings)) {
    expect(typeof value).toBe('string')
    expect(value.trim().length).toBeGreaterThan(0)
  }
})

test('GitHub provider model strings are safe to parse', () => {
  clearProviderFlags()
  process.env.CLAUDIN_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  expect(() => parseUserSpecifiedModel(modelStrings.sonnet46 as any)).not.toThrow()
})
