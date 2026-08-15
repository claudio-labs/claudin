import { afterEach, beforeEach, expect, test, mock } from 'bun:test'

// Regression: a per-project model selection must round-trip through the saved
// project config WITHOUT losing the `[1m]` suffix, otherwise a saved 1M pick
// silently reloads as a 200k window. Drives the real load path
// (getUserSpecifiedModelSetting → project branch) and the window resolution.

// Spread into plain objects: mock.restore() does NOT revert mock.module(), and a
// bare `await import(...)` binding is the live ESM namespace that mock.module
// mutates in place — so without a snapshot + explicit re-install these mocks leak
// (getCurrentProjectConfig / providerProfiles / state) into every later test file
// (e.g. modelOptions.dualcontext). See CLAUDE.md mock.module rules.
const realState = { ...(await import('src/platform/bootstrap/state.js')) }
const realProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }
const realConfig = { ...(await import('src/platform/config/config.js')) }
const realAllowlist = { ...(await import('src/providers/model/modelAllowlist.js')) }

const origDisable1m = process.env.CLAUDIN_DISABLE_1M_CONTEXT

// Load model.ts fresh with the project branch forced: a per-project pin with no
// pinned profile id (matches an env with no provider profiles → guard passes).
async function importWithProjectModel(activeModelForProject: string | undefined) {
  mock.module('src/platform/bootstrap/state.js', () => ({
    ...realState,
    getMainLoopModelOverride: () => undefined, // no session/CLI override → read project config
  }))
  mock.module('src/providers/presets/providerProfiles.js', () => ({
    ...realProfiles,
    getActiveProviderProfile: () => undefined, // effective id undefined → matches undefined pin
  }))
  mock.module('src/platform/config/config.js', () => ({
    ...realConfig,
    getCurrentProjectConfig: () => ({ activeModelForProject }),
  }))
  mock.module('./modelAllowlist.js', () => ({
    ...realAllowlist,
    isModelAllowed: () => true,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./model.js?ts=${nonce}`)
}

beforeEach(() => {
  delete process.env.CLAUDIN_DISABLE_1M_CONTEXT
})

afterEach(() => {
  mock.restore()
  // Re-install the real modules — mock.restore() leaves mock.module() overrides
  // in place, which would otherwise leak into later test files.
  mock.module('src/platform/bootstrap/state.js', () => realState)
  mock.module('src/providers/presets/providerProfiles.js', () => realProfiles)
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('./modelAllowlist.js', () => realAllowlist)
  if (origDisable1m === undefined) delete process.env.CLAUDIN_DISABLE_1M_CONTEXT
  else process.env.CLAUDIN_DISABLE_1M_CONTEXT = origDisable1m
})

test('per-project [1m] selection round-trips with its suffix intact', async () => {
  for (const saved of [
    'claude-opus-4-8[1m]',
    'claude-opus-4-7[1m]',
    'claude-sonnet-4-6[1m]',
    'claude-opus-4-6', // 200k flavor stays 200k
  ]) {
    const { getUserSpecifiedModelSetting } = await importWithProjectModel(saved)
    expect(getUserSpecifiedModelSetting()).toBe(saved)
    mock.restore()
  }
})

test('surrounding whitespace is trimmed but the [1m] suffix survives', async () => {
  const { getUserSpecifiedModelSetting } = await importWithProjectModel(
    '  claude-sonnet-4-6[1m]  ',
  )
  expect(getUserSpecifiedModelSetting()).toBe('claude-sonnet-4-6[1m]')
})

test('a resolved [1m] model maps to a 1M window; the plain flavor stays 200k', async () => {
  const { getContextWindowForModel } = await import('src/agent/context/context.js')
  expect(getContextWindowForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
  expect(getContextWindowForModel('claude-opus-4-7[1m]')).toBe(1_000_000)
  expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1_000_000)
  expect(getContextWindowForModel('claude-opus-4-8')).toBe(200_000)
})
