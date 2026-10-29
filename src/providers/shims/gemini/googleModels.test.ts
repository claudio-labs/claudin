/**
 * The Gemini model data Claudin holds against what Google serves
 * (ai.google.dev/gemini-api/docs/models, updated 2026-10-22): context windows
 * for the models in use, no Claude tier or fallback pointing at a model Google
 * shut down, and a /model picker that lists Gemini models under their own
 * names. Profiles are switched through the real resolver; no module is mocked.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { getContextWindowForModel } from 'src/agent/context/context.js'
import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import * as configs from 'src/providers/model/configs.js'
import {
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
} from 'src/providers/model/model.js'
import { getModelOptions } from 'src/providers/model/modelOptions.js'
import { getOpenAIMaxOutputTokens } from 'src/providers/model/openaiContextWindows.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { DEFAULT_GEMINI_MODEL } from 'src/providers/presets/providerProfile.js'
import {
  clearActiveOpenAIModelOptionsCache,
  setActiveOpenAIModelOptionsCache,
} from 'src/providers/presets/providerProfiles.js'

/** "Shut down" on Google's models page, 2026-10-22. */
const SHUT_DOWN = new Set([
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3.1-flash-lite-preview',
])

const GEMINI: ProviderProfile = {
  id: 'gm-native',
  name: 'Google Gemini',
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-3-flash-preview',
  apiKey: 'k',
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
  resetModelStringsForTestingOnly()
}

afterEach(() => {
  // resetGlobalConfigForTests keeps the legacy picker cache (see models.test.ts).
  clearActiveOpenAIModelOptionsCache()
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  resetModelStringsForTestingOnly()
})

describe('context windows', () => {
  test.each(['gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon'])(
    '%s gets Gemini’s 1M window, not the 128k fallback',
    model => {
      useProfile(GEMINI)
      expect(getContextWindowForModel(model)).toBe(1_048_576)
    },
  )

  test('a current Flash gets the 65,536-token output limit of its family', () => {
    expect(getOpenAIMaxOutputTokens('gemini-3.8-flash')).toBe(65_536)
  })
})

describe('no model Google shut down', () => {
  test('no Claude tier maps to one', () => {
    const geminiTiers = Object.entries(configs)
      .filter(([, value]) => value && typeof value === 'object' && 'gemini' in value)
      .map(([name, value]) => [name, (value as { gemini: string }).gemini] as const)
    expect(geminiTiers.length).toBeGreaterThan(0)
    expect(geminiTiers.filter(([, model]) => SHUT_DOWN.has(model))).toEqual([])
  })

  test('the fallbacks for a profile with no model name live ones', () => {
    useProfile({ ...GEMINI, model: '' })
    const fallbacks = [
      getSmallFastModel(),
      getDefaultOpusModel(),
      getDefaultSonnetModel(),
      getDefaultHaikuModel(),
      getDefaultMainLoopModelSetting(),
      DEFAULT_GEMINI_MODEL,
    ]
    expect(fallbacks.filter(model => SHUT_DOWN.has(String(model)))).toEqual([])
  })
})

describe('the /model picker on Gemini', () => {
  test('lists Google’s models under their own names, not Claude tiers', () => {
    useProfile(GEMINI)
    setActiveOpenAIModelOptionsCache([
      { value: 'gemini-4-argon', label: 'Gemini 4 Argon', description: 'gemini-4-argon · 1M ctx' },
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'gemini-3.8-flash · 1M ctx' },
    ])
    const options = getModelOptions()
    const values = options.map(option => option.value)
    expect(values).toContain('gemini-4-argon')
    expect(values).toContain('gemini-3.8-flash')
    expect(values).toContain('gemini-3-flash-preview')
    expect(values.filter(value => SHUT_DOWN.has(String(value)))).toEqual([])
    expect(options.filter(option => /\b(Opus|Sonnet|Haiku|Fable)\b/.test(option.label))).toEqual([])
  })
})
