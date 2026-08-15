import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'

// Plain-object copy, not the live namespace: `mock.module()` rewrites a
// namespace in place, so a bare `await import` would leave this variable
// pointing at the `getAPIProvider: () => 'github'` stub installed below — and
// the `afterAll` restore would then re-install that stub instead of undoing it.
// It pinned the whole run to the github provider, which is how
// `renderModelName` stopped mapping Claude ids and broke
// `ProviderModelIndicator.test.ts` two directories away.
const realProvidersModule = { ...(await import('src/providers/model/providers.js')) }

async function importFreshModelOptionsModule() {
  mock.module('./providers.js', () => ({
    ...realProvidersModule,
    getAPIProvider: () => 'github',
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

const originalEnv = {
  CLAUDIN_USE_GITHUB: process.env.CLAUDIN_USE_GITHUB,
  CLAUDIN_USE_OPENAI: process.env.CLAUDIN_USE_OPENAI,
  CLAUDIN_USE_GEMINI: process.env.CLAUDIN_USE_GEMINI,
  CLAUDIN_USE_BEDROCK: process.env.CLAUDIN_USE_BEDROCK,
  CLAUDIN_USE_VERTEX: process.env.CLAUDIN_USE_VERTEX,
  CLAUDIN_USE_FOUNDRY: process.env.CLAUDIN_USE_FOUNDRY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  ANTHROPIC_CUSTOM_MODEL_OPTION: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
}

beforeEach(() => {
  delete process.env.CLAUDIN_USE_GITHUB
  delete process.env.CLAUDIN_USE_OPENAI
  delete process.env.CLAUDIN_USE_GEMINI
  delete process.env.CLAUDIN_USE_BEDROCK
  delete process.env.CLAUDIN_USE_VERTEX
  delete process.env.CLAUDIN_USE_FOUNDRY
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  process.env.CLAUDIN_USE_GITHUB = originalEnv.CLAUDIN_USE_GITHUB
  process.env.CLAUDIN_USE_OPENAI = originalEnv.CLAUDIN_USE_OPENAI
  process.env.CLAUDIN_USE_GEMINI = originalEnv.CLAUDIN_USE_GEMINI
  process.env.CLAUDIN_USE_BEDROCK = originalEnv.CLAUDIN_USE_BEDROCK
  process.env.CLAUDIN_USE_VERTEX = originalEnv.CLAUDIN_USE_VERTEX
  process.env.CLAUDIN_USE_FOUNDRY = originalEnv.CLAUDIN_USE_FOUNDRY
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION =
    originalEnv.ANTHROPIC_CUSTOM_MODEL_OPTION
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    providerProfiles: [],
    activeProviderProfileId: undefined,
  }))
  resetModelStringsForTestingOnly()
})

test('GitHub provider exposes default + all Copilot models in /model options', async () => {
  process.env.CLAUDIN_USE_GITHUB = '1'
  delete process.env.CLAUDIN_USE_OPENAI
  delete process.env.CLAUDIN_USE_GEMINI
  delete process.env.CLAUDIN_USE_BEDROCK
  delete process.env.CLAUDIN_USE_VERTEX
  delete process.env.CLAUDIN_USE_FOUNDRY

  process.env.OPENAI_MODEL = 'gpt-4o'
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const nonDefault = options.filter(
    (option: { value: unknown }) => option.value !== null,
  )

  expect(nonDefault.length).toBeGreaterThan(1)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-4o')).toBe(true)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-5.2-codex')).toBe(true)
})

afterAll(() => {
  mock.module('./providers.js', () => realProvidersModule)
  resetGlobalConfigForTests()
})
