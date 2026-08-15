import { afterAll, afterEach, expect, mock, test } from 'bun:test'

// providerConfig consumes tryGetActiveProvider() for transport routing.
// Synthesize a profile from the legacy CLAUDE_CODE_USE_*/OPENAI_* envs the
// existing test sets up. Spread + restore in afterAll to avoid mock-leaks
// into later test files (Bun's discovery is process-global).
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) }
const realActiveProviderSnapshot = { ...realActiveProvider }
// The discovery mock further down replaces this module with a ONE-export
// object, so anything else reading it afterwards loses every other export.
// `openaiContextWindows.ts` reads `getDiscoveredContextWindow` from it and
// silently fell back to the hardcoded table for the rest of the run.
const realOpenaiModelDiscovery = {
  ...(await import('src/providers/model/openaiModelDiscovery.js')),
}

mock.module('src/providers/presets/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => {
    const env = process.env
    if (env.CLAUDIN_USE_OPENAI === '1' || env.CLAUDIN_USE_OPENAI === 'true') {
      return {
        transport: 'openai_compat' as const,
        baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: env.OPENAI_MODEL ?? 'gpt-4o',
        apiKey: env.OPENAI_API_KEY,
      }
    }
    return null
  },
}))

afterAll(() => {
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProviderSnapshot)
  mock.module(
    'src/providers/model/openaiModelDiscovery.js',
    () => realOpenaiModelDiscovery,
  )
})

const { getAdditionalModelOptionsCacheScope } = await import('src/providers/presets/providerConfig.js')
const { getAPIProvider } = await import('src/providers/model/providers.js')
void getAPIProvider

const originalEnv = {
  CLAUDIN_USE_OPENAI: process.env.CLAUDIN_USE_OPENAI,
  CLAUDIN_USE_GEMINI: process.env.CLAUDIN_USE_GEMINI,
  CLAUDIN_USE_GITHUB: process.env.CLAUDIN_USE_GITHUB,
  CLAUDIN_USE_MISTRAL: process.env.CLAUDIN_USE_MISTRAL,
  CLAUDIN_USE_BEDROCK: process.env.CLAUDIN_USE_BEDROCK,
  CLAUDIN_USE_VERTEX: process.env.CLAUDIN_USE_VERTEX,
  CLAUDIN_USE_FOUNDRY: process.env.CLAUDIN_USE_FOUNDRY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

afterEach(() => {
  mock.restore()
  process.env.CLAUDIN_USE_OPENAI = originalEnv.CLAUDIN_USE_OPENAI
  process.env.CLAUDIN_USE_GEMINI = originalEnv.CLAUDIN_USE_GEMINI
  process.env.CLAUDIN_USE_GITHUB = originalEnv.CLAUDIN_USE_GITHUB
  process.env.CLAUDIN_USE_MISTRAL = originalEnv.CLAUDIN_USE_MISTRAL
  process.env.CLAUDIN_USE_BEDROCK = originalEnv.CLAUDIN_USE_BEDROCK
  process.env.CLAUDIN_USE_VERTEX = originalEnv.CLAUDIN_USE_VERTEX
  process.env.CLAUDIN_USE_FOUNDRY = originalEnv.CLAUDIN_USE_FOUNDRY
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.OPENAI_API_BASE = originalEnv.OPENAI_API_BASE
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
})

test('opens the model picker without awaiting local model discovery refresh', async () => {
  process.env.CLAUDIN_USE_OPENAI = '1'
  delete process.env.CLAUDIN_USE_GEMINI
  delete process.env.CLAUDIN_USE_GITHUB
  delete process.env.CLAUDIN_USE_MISTRAL
  delete process.env.CLAUDIN_USE_BEDROCK
  delete process.env.CLAUDIN_USE_VERTEX
  delete process.env.CLAUDIN_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'qwen2.5-coder-7b-instruct'

  let resolveDiscovery: (() => void) | undefined
  const discoverOpenAICompatibleModelOptions = mock(
    () =>
      new Promise<void>(resolve => {
        resolveDiscovery = resolve
      }),
  )

  mock.module('src/providers/model/openaiModelDiscovery.js', () => ({
    ...realOpenaiModelDiscovery,
    discoverOpenAICompatibleModelOptions,
  }))

  expect(getAdditionalModelOptionsCacheScope()).toBe('openai:http://127.0.0.1:8080/v1')

  const { call } = await import('src/commands/model/model.js')
  const result = await Promise.race([
    call(() => {}, {} as never, ''),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 50)),
  ])

  resolveDiscovery?.()

  expect(result).not.toBe('timeout')
})
