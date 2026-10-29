/**
 * What the native Gemini transport must leave alone, pinned.
 *
 * The transport hooks into points every provider shares: the shim client's
 * dispatch (isGeminiNativeRequest), the effort default
 * (getDefaultEffortForModel) and the effort levels the picker and the wire
 * read (resolveShimEffortValues). Each case asks one of them under a profile
 * that is not native Gemini — another provider, or a Gemini profile on the
 * OpenAI-compatible endpoint — and expects the answer it gave before the
 * transport existed.
 *
 * Providers are switched through the real resolver (the global config lives
 * in memory under `bun test`). No module is mocked.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { getDefaultEffortForModel } from 'src/providers/effort/effort.js'
import { resolveShimEffortValues } from 'src/providers/model/reasoningCatalog.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { isGeminiNativeRequest } from 'src/providers/shims/gemini/endpoints.js'

const GEMINI_NATIVE: ProviderProfile = {
  id: 'gn-native',
  name: 'Google Gemini',
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-3-flash-preview',
  apiKey: 'k',
}
const GEMINI_COMPAT: ProviderProfile = {
  ...GEMINI_NATIVE,
  id: 'gn-compat',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
}
const OTHERS: ProviderProfile[] = [
  { id: 'gn-anthropic', name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  { id: 'gn-openai', name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKey: 'k' },
  // A router serving Gemini under the openai transport is not the Gemini provider.
  { id: 'gn-router', name: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-pro', apiKey: 'k' },
  { id: 'gn-vertex-claude', name: 'Vertex', provider: 'vertex', baseUrl: 'https://us-east5-aiplatform.googleapis.com', model: 'claude-opus-5-5' },
]

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

afterEach(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

describe('the native gate opens for native Gemini only', () => {
  test.each(OTHERS.map(p => [p.name, p] as const))('%s: never native', (_name, profile) => {
    useProfile(profile)
    expect(isGeminiNativeRequest(profile.baseUrl)).toBe(false)
    expect(isGeminiNativeRequest('https://generativelanguage.googleapis.com/v1beta')).toBe(false)
  })

  test('Gemini on the OpenAI-compatible endpoint: not native', () => {
    useProfile(GEMINI_COMPAT)
    expect(isGeminiNativeRequest(GEMINI_COMPAT.baseUrl)).toBe(false)
  })

  test('control: native Gemini is native', () => {
    useProfile(GEMINI_NATIVE)
    expect(isGeminiNativeRequest(GEMINI_NATIVE.baseUrl)).toBe(true)
  })
})

describe('the effort default', () => {
  test('Opus 5.5 on Anthropic keeps medium', () => {
    useProfile(OTHERS[0]!)
    expect(getDefaultEffortForModel('claude-opus-5-5')).toBe('medium')
  })

  test('a Gemini model off the native transport keeps no default', () => {
    for (const profile of [GEMINI_COMPAT, OTHERS[2]!]) {
      useProfile(profile)
      expect(getDefaultEffortForModel('gemini-3-flash-preview')).toBeUndefined()
      expect(getDefaultEffortForModel('gemini-2.5-pro')).toBeUndefined()
    }
  })

  test('control: native Gemini starts where gemini-cli does', () => {
    useProfile(GEMINI_NATIVE)
    expect(getDefaultEffortForModel('gemini-3-flash-preview')).toBe('high')
    expect(getDefaultEffortForModel('gemini-2.5-pro')).toBe('medium')
    expect(getDefaultEffortForModel('gemini-2.0-flash')).toBeUndefined()
  })
})

describe('the effort levels off the native endpoint', () => {
  test('a router or the compat endpoint: 2.5 has none, as before', () => {
    expect(resolveShimEffortValues('https://openrouter.ai/api/v1', 'gemini-2.5-pro')).toBeUndefined()
    expect(resolveShimEffortValues(GEMINI_COMPAT.baseUrl, 'gemini-2.5-pro')).toBeUndefined()
  })

  test('Claude on Vertex keeps the google-vertex rows', () => {
    expect(resolveShimEffortValues('https://us-east5-aiplatform.googleapis.com', 'claude-opus-4-5@20251101')).toEqual([
      'low',
      'medium',
      'high',
    ])
  })
})
