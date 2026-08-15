import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'

import { resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'
import { getDefaultMainLoopModelSetting, getUserSpecifiedModelSetting } from 'src/providers/model/model.js'

const env = {
  CLAUDIN_USE_GITHUB: process.env.CLAUDIN_USE_GITHUB,
  CLAUDIN_USE_OPENAI: process.env.CLAUDIN_USE_OPENAI,
  CLAUDIN_USE_GEMINI: process.env.CLAUDIN_USE_GEMINI,
  CLAUDIN_USE_BEDROCK: process.env.CLAUDIN_USE_BEDROCK,
  CLAUDIN_USE_VERTEX: process.env.CLAUDIN_USE_VERTEX,
  CLAUDIN_USE_FOUNDRY: process.env.CLAUDIN_USE_FOUNDRY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

beforeEach(() => {
  process.env.CLAUDIN_USE_GITHUB = '1'
  delete process.env.CLAUDIN_USE_OPENAI
  delete process.env.CLAUDIN_USE_GEMINI
  delete process.env.CLAUDIN_USE_BEDROCK
  delete process.env.CLAUDIN_USE_VERTEX
  delete process.env.CLAUDIN_USE_FOUNDRY
  delete process.env.OPENAI_MODEL
  saveGlobalConfig(current => ({
    ...current,
    model: ({ bad: true } as unknown) as string,
  }))
})

afterEach(() => {
  process.env.CLAUDIN_USE_GITHUB = env.CLAUDIN_USE_GITHUB
  process.env.CLAUDIN_USE_OPENAI = env.CLAUDIN_USE_OPENAI
  process.env.CLAUDIN_USE_GEMINI = env.CLAUDIN_USE_GEMINI
  process.env.CLAUDIN_USE_BEDROCK = env.CLAUDIN_USE_BEDROCK
  process.env.CLAUDIN_USE_VERTEX = env.CLAUDIN_USE_VERTEX
  process.env.CLAUDIN_USE_FOUNDRY = env.CLAUDIN_USE_FOUNDRY
  process.env.OPENAI_MODEL = env.OPENAI_MODEL
  saveGlobalConfig(current => ({
    ...current,
    model: undefined,
  }))
})

test('github default model setting ignores non-string saved model', () => {
  const model = getDefaultMainLoopModelSetting()
  expect(typeof model).toBe('string')
  expect(model).not.toBe('[object Object]')
  expect(model.length).toBeGreaterThan(0)
})

test('user specified model ignores non-string saved model', () => {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    expect(typeof model).toBe('string')
    expect(model).not.toBe('[object Object]')
  }
})

afterAll(() => {
  resetGlobalConfigForTests()
})
