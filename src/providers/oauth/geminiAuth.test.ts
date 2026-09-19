import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { GlobalConfig, ProviderProfile } from 'src/platform/config/config.js'

let mockProviderProfile: ProviderProfile | null = null
// Spread into plain objects so afterAll restores the original bindings, not
// the live ESM namespaces (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/platform/config/config.js')) }
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }

mock.module('src/platform/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    providerProfiles: mockProviderProfile ? [mockProviderProfile] : [],
    activeProviderProfileId: mockProviderProfile?.id,
  } as unknown as GlobalConfig),
}))

mock.module('src/providers/presets/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => mockProviderProfile ?? undefined,
}))

afterAll(() => {
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
})

import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'

import {
  getGeminiProjectIdHint,
  mayHaveGeminiAdcCredentials,
  resolveGeminiCredential,
} from 'src/providers/oauth/geminiAuth.js'

const existingFilePath = import.meta.path

const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
  GOOGLE_PROJECT_ID: process.env.GOOGLE_PROJECT_ID,
  APPDATA: process.env.APPDATA,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

afterEach(() => {
  restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
  restoreEnv('GOOGLE_API_KEY', originalEnv.GOOGLE_API_KEY)
  restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
  restoreEnv(
    'GOOGLE_APPLICATION_CREDENTIALS',
    originalEnv.GOOGLE_APPLICATION_CREDENTIALS,
  )
  restoreEnv('GOOGLE_CLOUD_PROJECT', originalEnv.GOOGLE_CLOUD_PROJECT)
  restoreEnv('GCLOUD_PROJECT', originalEnv.GCLOUD_PROJECT)
  restoreEnv('GOOGLE_PROJECT_ID', originalEnv.GOOGLE_PROJECT_ID)
  restoreEnv('APPDATA', originalEnv.APPDATA)
  mockProviderProfile = null
  invalidateActiveProviderCache()
})

describe('resolveGeminiCredential', () => {
  test('uses the active profile API key for Gemini auth', async () => {
    mockProviderProfile = {
      id: 'gem',
      name: 'Gemini',
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash',
      apiKey: 'gem-key',
    } as ProviderProfile
    invalidateActiveProviderCache()
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY

    await expect(resolveGeminiCredential(process.env)).resolves.toEqual({
      kind: 'api-key',
      credential: 'gem-key',
    })
  })

  test('falls back to ADC when available', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    process.env.GEMINI_AUTH_MODE = 'adc'
    process.env.GOOGLE_APPLICATION_CREDENTIALS = existingFilePath

    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
      async getProjectId() {
        return 'adc-project'
      },
    }

    await expect(
      resolveGeminiCredential(process.env, {
        createGoogleAuth: async () => fakeAuth,
      }),
    ).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
    })
  })

  test('returns none when no Gemini auth source is configured', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS

    await expect(resolveGeminiCredential(process.env)).resolves.toEqual({
      kind: 'none',
    })
  })

  test('api-key mode does not silently fall back to ADC', async () => {
    // Naming a source is a statement about which one to use. Falling through to
    // ADC would authenticate as whatever gcloud account is on the machine and
    // report success, so the missing key would never surface.
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    process.env.GEMINI_AUTH_MODE = 'api-key'
    process.env.GOOGLE_APPLICATION_CREDENTIALS = existingFilePath

    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
    }

    await expect(
      resolveGeminiCredential(process.env, {
        createGoogleAuth: async () => fakeAuth,
      }),
    ).resolves.toEqual({
      kind: 'none',
    })
  })
})

describe('Gemini auth helpers', () => {
  test('detects explicit project id hints', () => {
    process.env.GOOGLE_PROJECT_ID = 'project-a'
    expect(getGeminiProjectIdHint(process.env)).toBe('project-a')
  })

  test('only treats existing ADC paths as valid hints', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = existingFilePath
    expect(mayHaveGeminiAdcCredentials(process.env)).toBe(true)

    process.env.GOOGLE_APPLICATION_CREDENTIALS = `${existingFilePath}.missing`
    process.env.APPDATA = undefined
    expect(mayHaveGeminiAdcCredentials(process.env)).toBe(false)
  })
})
