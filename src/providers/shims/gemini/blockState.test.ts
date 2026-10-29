import { afterEach, describe, expect, test } from 'bun:test'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { geminiStateToKeep } from 'src/providers/shims/gemini/blockState.js'

const GEMINI: ProviderProfile = {
  id: 'state-gemini',
  name: 'Google Gemini',
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-3-flash-preview',
}
const ANTHROPIC: ProviderProfile = {
  id: 'state-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
}

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

const CALL = {
  type: 'tool_use',
  id: 'call_1',
  name: 'Read',
  input: {},
  signature: 'sig-real',
  extra_content: { google: { thought_signature: 'sig-real' } },
}

describe('geminiStateToKeep', () => {
  test('under Gemini: the signature and extra_content', () => {
    useProfile(GEMINI)
    expect(geminiStateToKeep(CALL)).toEqual({
      signature: 'sig-real',
      extra_content: { google: { thought_signature: 'sig-real' } },
    })
  })

  test('under Gemini, absent or empty fields add nothing', () => {
    useProfile(GEMINI)
    expect(geminiStateToKeep({ ...CALL, signature: '', extra_content: undefined })).toEqual({})
    expect(geminiStateToKeep(null)).toEqual({})
  })

  test('under any other provider: nothing', () => {
    useProfile(ANTHROPIC)
    expect(geminiStateToKeep(CALL)).toEqual({})
  })
})
