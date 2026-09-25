import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ResolvedProvider } from 'src/providers/presets/activeProvider.js'
import { resetGrowthBook } from 'src/platform/analytics/growthbook.js'

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
  getAutoModeEnabledState,
  getAutoModeEnabledStateIfCached,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  hasAutoModeOptInAnySource,
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
//
// `tengu_auto_mode_config` resolves through the local flag file, so pointing
// CLAUDE_FEATURE_FLAGS_FILE at a temp file is a real injection seam — no
// module mock, and therefore nothing that can leak into another test file.

const REAL_FLAGS_FILE = process.env.CLAUDE_FEATURE_FLAGS_FILE
let flagsDir: string | undefined

function withFlags(flags: Record<string, unknown>): void {
  flagsDir ??= mkdtempSync(join(tmpdir(), 'auto-mode-flags-'))
  const file = join(flagsDir, 'feature-flags.json')
  writeFileSync(file, JSON.stringify(flags))
  process.env.CLAUDE_FEATURE_FLAGS_FILE = file
  resetGrowthBook()
}

afterEach(() => {
  if (REAL_FLAGS_FILE === undefined) {
    delete process.env.CLAUDE_FEATURE_FLAGS_FILE
  } else {
    process.env.CLAUDE_FEATURE_FLAGS_FILE = REAL_FLAGS_FILE
  }
  resetGrowthBook()
})

afterAll(() => {
  if (flagsDir) rmSync(flagsDir, { recursive: true, force: true })
})

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

describe('getAutoModeEnabledState', () => {
  test('defaults to enabled when the config is absent', () => {
    // Claudin flips upstream's default: GrowthBook is stubbed here, so
    // anything else would leave the shift+tab carousel unable to reach auto.
    withFlags({})
    expect(getAutoModeEnabledState()).toBe('enabled')
  })

  test('accepts the disabled spelling — the incident circuit breaker', () => {
    withFlags({ tengu_auto_mode_config: { enabled: 'disabled' } })
    expect(getAutoModeEnabledState()).toBe('disabled')
  })

  test('accepts the opt-in spelling', () => {
    withFlags({ tengu_auto_mode_config: { enabled: 'opt-in' } })
    expect(getAutoModeEnabledState()).toBe('opt-in')
  })

  test('accepts the enabled spelling', () => {
    withFlags({ tengu_auto_mode_config: { enabled: 'enabled' } })
    expect(getAutoModeEnabledState()).toBe('enabled')
  })

  test.each([
    ['an unknown string', 'maybe'],
    ['a boolean', true],
    ['a number', 1],
    ['null', null],
    ['an object', { enabled: 'disabled' }],
  ])('%s falls back to the default rather than passing through', (_l, value) => {
    withFlags({ tengu_auto_mode_config: { enabled: value } })
    expect(getAutoModeEnabledState()).toBe('enabled')
  })

  test('a config object with no enabled field falls back to the default', () => {
    withFlags({ tengu_auto_mode_config: { disableFastMode: true } })
    expect(getAutoModeEnabledState()).toBe('enabled')
  })
})

describe('getAutoModeEnabledStateIfCached', () => {
  test('returns undefined when nothing has been fetched', () => {
    // "not yet fetched" must not be conflated with "fetched and disabled":
    // the former defers to verifyAutoModeGateAccess, the latter blocks now.
    withFlags({})
    expect(getAutoModeEnabledStateIfCached()).toBeUndefined()
  })

  test('a cached config with no enabled field is NOT undefined', () => {
    // This is the sentinel's whole job — an empty object is a real answer.
    withFlags({ tengu_auto_mode_config: {} })
    expect(getAutoModeEnabledStateIfCached()).toBe('enabled')
  })

  test('reports the cached disabled state', () => {
    withFlags({ tengu_auto_mode_config: { enabled: 'disabled' } })
    expect(getAutoModeEnabledStateIfCached()).toBe('disabled')
  })

  test('reports the cached opt-in state', () => {
    withFlags({ tengu_auto_mode_config: { enabled: 'opt-in' } })
    expect(getAutoModeEnabledStateIfCached()).toBe('opt-in')
  })

  test('a cached garbage value falls back to the default, not to undefined', () => {
    withFlags({ tengu_auto_mode_config: { enabled: 'maybe' } })
    expect(getAutoModeEnabledStateIfCached()).toBe('enabled')
  })
})

describe('hasAutoModeOptInAnySource', () => {
  test('fails closed when no source has opted in', () => {
    expect(hasAutoModeOptInAnySource()).toBe(false)
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
