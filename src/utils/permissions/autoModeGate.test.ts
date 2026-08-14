import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ResolvedProvider } from 'src/services/api/activeProvider.js'

const realActiveProviderNS = { ...(await import('src/services/api/activeProvider.js')) }
const realModelNS = { ...(await import('src/utils/model/model.js')) }
const realBetasNS = { ...(await import('src/utils/betas.js')) }

const state: { provider: ResolvedProvider | null; model: string } = {
  provider: null,
  model: 'gpt-5.4',
}

mock.module('src/services/api/activeProvider.js', () => ({
  ...realActiveProviderNS,
  tryGetActiveProvider: () => state.provider,
}))
mock.module('src/services/api/activeProvider.js', () => ({
  ...realActiveProviderNS,
  tryGetActiveProvider: () => state.provider,
}))
mock.module('src/utils/model/model.js', () => ({
  ...realModelNS,
  getMainLoopModel: () => state.model,
}))
mock.module('src/utils/model/model.js', () => ({
  ...realModelNS,
  getMainLoopModel: () => state.model,
}))

afterAll(() => {
  mock.module('src/services/api/activeProvider.js', () => realActiveProviderNS)
  mock.module('src/services/api/activeProvider.js', () => realActiveProviderNS)
  mock.module('src/utils/model/model.js', () => realModelNS)
  mock.module('src/utils/model/model.js', () => realModelNS)
})

const { __setAutoModeEnabledForTests } = await import('src/utils/betas.js')
const { __autoModeAllowedForModelForTests } = await import('./permissionSetup.js')
const { getClassifierProbeKey } = await import('./classifierProbe.js')
const {
  __setClassifierProbeStoreDirForTests,
  writeClassifierProbe,
} = await import('./classifierProbeStore.js')

let fakeConfigDir: string

beforeEach(() => {
  fakeConfigDir = mkdtempSync(join(tmpdir(), 'auto-mode-gate-'))
  __setClassifierProbeStoreDirForTests(fakeConfigDir)
  state.provider = {
    transport: 'openai_compat',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-5.4',
    name: 'test',
  }
  state.model = 'gpt-5.4'
  __setAutoModeEnabledForTests(true)
})

afterEach(() => {
  __setAutoModeEnabledForTests(undefined)
  __setClassifierProbeStoreDirForTests(undefined)
  rmSync(fakeConfigDir, { recursive: true, force: true })
})

describe('autoModeAllowedForModel', () => {
  test('Claude auto-mode model passes by name, no probe needed', () => {
    expect(__autoModeAllowedForModelForTests('claude-sonnet-4-6')).toBe(true)
  })

  test('non-Claude model without a probe entry is denied', () => {
    expect(__autoModeAllowedForModelForTests('gpt-5.4')).toBe(false)
  })

  test('non-Claude model with a passing probe entry is allowed', () => {
    const key = getClassifierProbeKey({
      provider: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-5.4',
    })
    writeClassifierProbe(key, { ok: true, at: 't' })
    expect(__autoModeAllowedForModelForTests('gpt-5.4')).toBe(true)
  })

  test('non-Claude model with a failing probe entry stays denied', () => {
    const key = getClassifierProbeKey({
      provider: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-5.4',
    })
    writeClassifierProbe(key, { ok: false, at: 't', detail: 'no tool_use' })
    expect(__autoModeAllowedForModelForTests('gpt-5.4')).toBe(false)
  })

  test('probe entry keyed by model — another model is unaffected', () => {
    const key = getClassifierProbeKey({
      provider: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-5.4',
    })
    writeClassifierProbe(key, { ok: true, at: 't' })
    expect(__autoModeAllowedForModelForTests('other-model')).toBe(false)
  })

  test('no active provider denies non-Claude models', () => {
    state.provider = null
    expect(__autoModeAllowedForModelForTests('gpt-5.4')).toBe(false)
  })
})
