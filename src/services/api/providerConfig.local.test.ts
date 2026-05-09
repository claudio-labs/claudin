import { afterAll, afterEach, expect, mock, test } from 'bun:test'

// providerConfig reads its provider/transport/baseUrl/model from the active
// profile resolver, not from CLAUDE_CODE_USE_*/OPENAI_* envs. Spread the
// real activeProvider module so its non-mocked exports survive, and restore
// in afterAll to avoid leaking the mock to later test files.
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
  getAdditionalModelOptionsCacheScope,
  getLocalProviderRetryBaseUrls,
  isLocalProviderUrl,
  resolveProviderRequest,
  shouldAttemptLocalToollessRetry,
} = await import('./providerConfig.js')

afterEach(() => {
  resolvedOverride = null
})

test('treats localhost endpoints as local', () => {
  expect(isLocalProviderUrl('http://localhost:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.0.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://0.0.0.0:11434/v1')).toBe(true)
  // Full 127.0.0.0/8 loopback range should be treated as local
  expect(isLocalProviderUrl('http://127.0.0.2:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.1.2.3:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.255.255.255:11434/v1')).toBe(true)
})

test('treats private IPv4 endpoints as local', () => {
  expect(isLocalProviderUrl('http://10.0.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://172.16.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://192.168.0.1:11434/v1')).toBe(true)
})

test('treats .local hostnames as local', () => {
  expect(isLocalProviderUrl('http://ollama.local:11434/v1')).toBe(true)
})

test('treats private IPv6 endpoints as local', () => {
  expect(isLocalProviderUrl('http://[fd00::1]:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://[fe80::1]:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://[::1]:11434/v1')).toBe(true)
})

test('treats public hosts as remote', () => {
  expect(isLocalProviderUrl('http://203.0.113.1:11434/v1')).toBe(false)
  expect(isLocalProviderUrl('https://example.com/v1')).toBe(false)
  expect(isLocalProviderUrl('http://[2001:4860:4860::8888]:11434/v1')).toBe(false)
})

test('creates a cache scope for local openai-compatible providers', () => {
  resolvedOverride = {
    transport: 'openai_compat',
    baseUrl: 'http://localhost:1234/v1',
    model: 'llama-3.2-3b-instruct',
  }

  expect(getAdditionalModelOptionsCacheScope()).toBe(
    'openai:http://localhost:1234/v1',
  )
})

test('keeps codex alias models on chat completions for local openai-compatible providers', () => {
  resolvedOverride = {
    transport: 'openai_compat',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'gpt-5.4',
  }

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'http://127.0.0.1:8080/v1',
  })
  expect(getAdditionalModelOptionsCacheScope()).toBe(
    'openai:http://127.0.0.1:8080/v1',
  )
})

test('creates cache scope for remote openai-compatible providers', () => {
  resolvedOverride = {
    transport: 'openai_compat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  }

  expect(getAdditionalModelOptionsCacheScope()).toBe(
    'openai:https://api.openai.com/v1',
  )
})

test('derives local retry base URLs with /v1 and loopback fallback candidates', () => {
  expect(getLocalProviderRetryBaseUrls('http://localhost:11434')).toEqual([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/v1',
  ])
})

test('does not derive local retry base URLs for remote providers', () => {
  expect(getLocalProviderRetryBaseUrls('https://api.openai.com/v1')).toEqual([])
})

test('enables local toolless retry for likely Ollama endpoints with tools', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:11434/v1',
      hasTools: true,
    }),
  ).toBe(true)
})

test('disables local toolless retry when no tools are present', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:11434/v1',
      hasTools: false,
    }),
  ).toBe(false)
})

test('disables local toolless retry for non-Ollama local endpoints', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:1234/v1',
      hasTools: true,
    }),
  ).toBe(false)
})
