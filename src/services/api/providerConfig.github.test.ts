import { afterAll, afterEach, expect, mock, test } from 'bun:test'

// GitHub mode is driven by `transport === 'github_copilot'` from the active
// profile (not CLAUDE_CODE_USE_GITHUB). Spread the real activeProvider
// module + restore in afterAll to avoid Bun mock leaks.
const realActiveProvider = { ...(await import('./activeProvider.js')) }
const realActiveProviderSnapshot = { ...realActiveProvider }

type ResolvedProvider = ReturnType<typeof realActiveProvider.getActiveProvider> | null

let resolvedOverride: ResolvedProvider = null

mock.module('./activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

afterAll(() => {
  mock.module('./activeProvider.js', () => realActiveProviderSnapshot)
})

const {
  DEFAULT_GITHUB_MODELS_API_MODEL,
  normalizeGithubModelsApiModel,
  resolveProviderRequest,
} = await import('./providerConfig.js')

afterEach(() => {
  resolvedOverride = null
})

function setGithubProfile(): void {
  resolvedOverride = {
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
  }
}

test.each([
  ['copilot', DEFAULT_GITHUB_MODELS_API_MODEL],
  ['github:copilot', DEFAULT_GITHUB_MODELS_API_MODEL],
  ['', DEFAULT_GITHUB_MODELS_API_MODEL],
  ['github:gpt-4o', 'gpt-4o'],
  ['gpt-4o', 'gpt-4o'],
  ['github:copilot?reasoning=high', DEFAULT_GITHUB_MODELS_API_MODEL],
  // normalizeGithubModelsApiModel preserves provider prefix for models.github.ai compatibility
  ['github:openai/gpt-4.1', 'openai/gpt-4.1'],
  ['openai/gpt-4.1', 'openai/gpt-4.1'],
] as const)('normalizeGithubModelsApiModel(%s) -> %s', (input, expected) => {
  expect(normalizeGithubModelsApiModel(input)).toBe(expected)
})

test('resolveProviderRequest applies GitHub normalization when active profile is github_copilot', () => {
  setGithubProfile()
  const r = resolveProviderRequest({ model: 'github:gpt-4o' })
  expect(r.resolvedModel).toBe('gpt-4o')
  expect(r.transport).toBe('chat_completions')
})

test('resolveProviderRequest routes GitHub GPT-5 codex models to responses transport', () => {
  setGithubProfile()
  const r = resolveProviderRequest({ model: 'gpt-5.3-codex' })
  expect(r.resolvedModel).toBe('gpt-5.3-codex')
  expect(r.transport).toBe('codex_responses')
})

test('resolveProviderRequest keeps gpt-5-mini on chat_completions for GitHub', () => {
  setGithubProfile()
  const r = resolveProviderRequest({ model: 'gpt-5-mini' })
  expect(r.resolvedModel).toBe('gpt-5-mini')
  expect(r.transport).toBe('chat_completions')
})

test('resolveProviderRequest leaves model unchanged without GitHub flag', () => {
  resolvedOverride = null
  const r = resolveProviderRequest({ model: 'github:gpt-4o' })
  expect(r.resolvedModel).toBe('github:gpt-4o')
})
