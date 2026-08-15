import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

// Pin getAPIProvider to 'openai' so the effort functions see a Kimi provider as
// an OpenAI-compatible transport, not the first-party fallback. This matches
// the real runtime when a Kimi Code profile is active.
//
// Two things here are load-bearing together, and neither works alone:
//
//  - the pin is installed from `beforeEach`, NEVER at module scope. Bun applies
//    every module-scope `mock.module()` during the load phase, for the whole
//    run, so a bare call would pin `providers.js` to 'openai' for every other
//    file too — and `effort.xhighDefault.test.ts`, which needs 'firstParty',
//    cannot out-mock that from inside a test (it fails six assertions).
//  - `effort.js` is therefore imported FRESH inside each test rather than at the
//    top. A statically imported copy is bound during the load phase, before any
//    `beforeEach` has run, and keeps reading the unmocked `providers.js`.
//
// This is the "single cooperative owner" the reorg manifest asks for: nobody
// pins a shared module globally, and every file re-imports what it is testing.
const realProviders = { ...(await import('src/providers/model/providers.js')) }

beforeEach(() => {
  mock.module('src/providers/model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'openai' as const,
  }))
})

afterAll(() => {
  mock.module('src/providers/model/providers.js', () => realProviders)
})

async function importFreshEffortModule() {
  return import(`src/providers/effort/effort.js?ts=${Date.now()}-${Math.random()}`)
}

test('K3 supports effort', async () => {
  const { modelSupportsEffort } = await importFreshEffortModule()
  expect(modelSupportsEffort('k3')).toBe(true)
  expect(modelSupportsEffort('kimi-code/k3')).toBe(true)
})

test('other Kimi models do not support granular effort under an openai provider', async () => {
  const { modelSupportsEffort } = await importFreshEffortModule()
  expect(modelSupportsEffort('kimi-for-coding')).toBe(false)
  expect(modelSupportsEffort('kimi-for-coding-highspeed')).toBe(false)
})

test('K3 supports max effort', async () => {
  const { modelSupportsMaxEffort } = await importFreshEffortModule()
  expect(modelSupportsMaxEffort('k3')).toBe(true)
})

test('K3 exposes Low/High/Max levels only', async () => {
  const { getAvailableEffortLevels } = await importFreshEffortModule()
  expect(getAvailableEffortLevels('k3')).toEqual(['low', 'high', 'max'])
})

test('K3 defaults to max effort', async () => {
  const { resolveAppliedEffort } = await importFreshEffortModule()
  expect(resolveAppliedEffort('k3', undefined)).toBe('max')
})

test('K3 normalizes non-Kimi levels', async () => {
  const { resolveAppliedEffort } = await importFreshEffortModule()
  expect(resolveAppliedEffort('k3', 'medium')).toBe('low')
  expect(resolveAppliedEffort('k3', 'xhigh')).toBe('max')
})

test('K3 passes through its native levels', async () => {
  const { resolveAppliedEffort } = await importFreshEffortModule()
  expect(resolveAppliedEffort('k3', 'low')).toBe('low')
  expect(resolveAppliedEffort('k3', 'high')).toBe('high')
  expect(resolveAppliedEffort('k3', 'max')).toBe('max')
})
