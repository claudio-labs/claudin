import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ResolvedProvider } from 'src/providers/presets/activeProvider.js'

const realActiveProviderNS = { ...(await import('src/providers/presets/activeProvider.js')) }
const realModelNS = { ...(await import('src/providers/model/model.js')) }
const realBetasNS = { ...(await import('src/providers/transport/betas.js')) }

const state: { provider: ResolvedProvider | null; model: string } = {
  provider: null,
  model: 'gpt-5.4',
}

mock.module('src/providers/presets/activeProvider.js', () => ({
  ...realActiveProviderNS,
  tryGetActiveProvider: () => state.provider,
}))
mock.module('src/providers/presets/activeProvider.js', () => ({
  ...realActiveProviderNS,
  tryGetActiveProvider: () => state.provider,
}))
mock.module('src/providers/model/model.js', () => ({
  ...realModelNS,
  getMainLoopModel: () => state.model,
}))
mock.module('src/providers/model/model.js', () => ({
  ...realModelNS,
  getMainLoopModel: () => state.model,
}))

afterAll(() => {
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProviderNS)
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProviderNS)
  mock.module('src/providers/model/model.js', () => realModelNS)
  mock.module('src/providers/model/model.js', () => realModelNS)
})

const { __setAutoModeEnabledForTests } = await import('src/providers/transport/betas.js')
const {
  __autoModeAllowedForModelForTests,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  verifyAutoModeGateAccess,
} = await import('src/permissions/permissionSetup.js')
const { getEmptyToolPermissionContext } = await import('src/tools/Tool.js')
const { setNeedsAutoModeExitAttachment } = await import(
  'src/platform/bootstrap/state.js'
)
const { getClassifierProbeKey } = await import('src/permissions/classifierProbe.js')
const {
  __setClassifierProbeStoreDirForTests,
  writeClassifierProbe,
} = await import('src/permissions/classifierProbeStore.js')

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

// ── The rest of the auto-mode availability group ─────────────────────────

describe('getAutoModeUnavailableNotification', () => {
  test('names settings as the reason', () => {
    expect(getAutoModeUnavailableNotification('settings')).toBe(
      'auto mode disabled by settings',
    )
  })

  test('names the plan when the circuit breaker fired', () => {
    expect(getAutoModeUnavailableNotification('circuit-breaker')).toBe(
      'auto mode is unavailable for your plan',
    )
  })

  test('names the model when the model is unsupported', () => {
    expect(getAutoModeUnavailableNotification('model')).toBe(
      'auto mode unavailable for this model',
    )
  })

  test('the three reasons produce three distinct messages', () => {
    const messages = (['settings', 'circuit-breaker', 'model'] as const).map(
      getAutoModeUnavailableNotification,
    )
    expect(new Set(messages).size).toBe(3)
  })
})

// ── The surface that survives the gate removal ───────────────────────────
//
// What a stock install sees, asserted through the check the REPL runs rather
// than through the config reader, so it holds whether the answer comes from a
// flag or from a constant.

describe('verifyAutoModeGateAccess — a stock install', () => {
  afterEach(() => {
    setNeedsAutoModeExitAttachment(false)
  })

  test('a supported model makes auto reachable from the carousel', async () => {
    state.model = 'claude-sonnet-4-6'
    const { updateContext, notification } = await verifyAutoModeGateAccess(
      getEmptyToolPermissionContext(),
    )
    expect(updateContext(getEmptyToolPermissionContext()).isAutoModeAvailable).toBe(
      true,
    )
    expect(notification).toBeUndefined()
  })

  test('an unsupported model kicks a session out of auto and says why', async () => {
    writeClassifierProbe(
      getClassifierProbeKey({
        provider: 'openai_compat',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-5.4',
      }),
      { ok: false, at: 't', detail: 'no tool_use' },
    )
    const inAuto = { ...getEmptyToolPermissionContext(), mode: 'auto' as const }
    const { updateContext, notification } =
      await verifyAutoModeGateAccess(inAuto)
    expect(notification).toBe('auto mode unavailable for this model')
    const after = updateContext(inAuto)
    expect(after.mode).toBe('default')
    expect(after.isAutoModeAvailable).toBe(false)
  })
})

describe('isAutoModeGateEnabled / getAutoModeUnavailableReason', () => {
  // Both also consult disableAutoMode in the merged settings; a checkout that
  // sets it would see 'settings' below. Neither this repo nor CI does.
  test('an unsupported model closes the gate', () => {
    expect(isAutoModeGateEnabled()).toBe(false)
  })

  test('the reason for an unsupported model is the model', () => {
    expect(getAutoModeUnavailableReason()).toBe('model')
  })

  test('a passing classifier probe opens the gate for that model', () => {
    writeClassifierProbe(
      getClassifierProbeKey({
        provider: 'openai_compat',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-5.4',
      }),
      { ok: true, at: 't' },
    )
    expect(isAutoModeGateEnabled()).toBe(true)
    expect(getAutoModeUnavailableReason()).toBeNull()
  })

  test('a failing classifier probe keeps the gate closed', () => {
    writeClassifierProbe(
      getClassifierProbeKey({
        provider: 'openai_compat',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-5.4',
      }),
      { ok: false, at: 't', detail: 'no tool_use' },
    )
    expect(isAutoModeGateEnabled()).toBe(false)
    expect(getAutoModeUnavailableReason()).toBe('model')
  })
})
