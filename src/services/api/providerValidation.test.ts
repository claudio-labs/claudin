import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import type { GlobalConfig, ProviderProfile } from 'src/platform/config/config.js'

let mockProviderProfile: ProviderProfile | null = null
// Spread into plain objects so afterAll restores the original bindings, not
// the live ESM namespaces (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/platform/config/config.js')) }
const realProviderProfiles = { ...(await import('src/services/api/providerProfiles.js')) }

mock.module('src/platform/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    providerProfiles: mockProviderProfile ? [mockProviderProfile] : [],
    activeProviderProfileId: mockProviderProfile?.id,
  } as unknown as GlobalConfig),
}))

mock.module('./providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => mockProviderProfile ?? undefined,
}))

afterAll(() => {
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('./providerProfiles.js', () => realProviderProfiles)
})

import { invalidateActiveProviderCache } from 'src/services/api/activeProvider.js'
import {
  getProviderValidationError,
  shouldExitForStartupProviderValidationError,
} from 'src/services/api/providerValidation.js'

afterEach(() => {
  mockProviderProfile = null
  invalidateActiveProviderCache()
})

test('accepts API-key Gemini profile', async () => {
  mockProviderProfile = {
    id: 'g',
    name: 'Gemini',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    apiKey: 'gem-key',
  }
  invalidateActiveProviderCache()

  await expect(getProviderValidationError()).resolves.toBeNull()
})

test('accepts ADC credentials for Gemini auth', async () => {
  mockProviderProfile = {
    id: 'g',
    name: 'Gemini',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
  }
  invalidateActiveProviderCache()

  await expect(
    getProviderValidationError(process.env, {
      resolveGeminiCredential: async () => ({
        kind: 'adc',
        credential: 'adc-token',
        projectId: 'adc-project',
      }),
    }),
  ).resolves.toBeNull()
})

test('errors when Gemini profile has no resolvable credential', async () => {
  mockProviderProfile = {
    id: 'g',
    name: 'Gemini',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
  }
  invalidateActiveProviderCache()

  await expect(
    getProviderValidationError(process.env, {
      resolveGeminiCredential: async () => ({ kind: 'none' }),
    }),
  ).resolves.toBe(
    'Configure Gemini auth via /provider — pick API key, access token, or rely on Google ADC.',
  )
})

test('reports missing API key for non-local OpenAI-compat profile', async () => {
  mockProviderProfile = {
    id: 'o',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  }
  invalidateActiveProviderCache()

  const message = await getProviderValidationError()
  expect(message).toContain('API key required for the active /provider profile')
})

test('startup provider validation allows interactive recovery', () => {
  expect(
    shouldExitForStartupProviderValidationError({
      args: [],
      stdoutIsTTY: true,
    }),
  ).toBe(false)
})

test('startup provider validation stays strict for non-interactive launches', () => {
  expect(
    shouldExitForStartupProviderValidationError({
      args: ['-p', 'hello'],
      stdoutIsTTY: true,
    }),
  ).toBe(true)
  expect(
    shouldExitForStartupProviderValidationError({
      args: ['--print', 'hello'],
      stdoutIsTTY: true,
    }),
  ).toBe(true)
  expect(
    shouldExitForStartupProviderValidationError({
      args: [],
      stdoutIsTTY: false,
    }),
  ).toBe(true)
  expect(
    shouldExitForStartupProviderValidationError({
      args: ['--sdk-url', 'ws://127.0.0.1:3000'],
      stdoutIsTTY: true,
    }),
  ).toBe(true)
  expect(
    shouldExitForStartupProviderValidationError({
      args: ['--sdk-url=ws://127.0.0.1:3000'],
      stdoutIsTTY: true,
    }),
  ).toBe(true)
})
