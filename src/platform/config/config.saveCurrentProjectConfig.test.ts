import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  onGlobalConfigChange,
  resetProjectConfigForTests,
  saveCurrentProjectConfig,
  type ProjectConfig,
} from 'src/platform/config/config.js'

// In NODE_ENV=test, saveCurrentProjectConfig writes into the in-memory
// TEST_PROJECT_CONFIG_FOR_TESTING object. This file verifies the contract
// that callers (most importantly activeProvider.ts) can rely on: every
// successful project-config write fires global config listeners so caches
// keyed on the effective project state get invalidated.

const unsubs: Array<() => void> = []

beforeEach(() => {
  resetProjectConfigForTests()
})

afterEach(() => {
  while (unsubs.length > 0) {
    unsubs.pop()?.()
  }
  resetProjectConfigForTests()
})

afterAll(() => {
  resetProjectConfigForTests()
})

describe('saveCurrentProjectConfig listener notification', () => {
  test('fires global config listeners after a successful write', () => {
    let calls = 0
    unsubs.push(onGlobalConfigChange(() => { calls += 1 }))

    saveCurrentProjectConfig(
      (current: ProjectConfig): ProjectConfig => ({
        ...current,
        activeProviderProfileId: 'profile_test_listener',
      }),
    )

    expect(calls).toBeGreaterThan(0)
  })

  test('does not fire listeners when updater returns the same reference', () => {
    // Prime project config so the next write would be a no-op.
    saveCurrentProjectConfig(current => ({
      ...current,
      activeProviderProfileId: 'profile_unchanged',
    }))

    let calls = 0
    unsubs.push(onGlobalConfigChange(() => { calls += 1 }))

    // Returning the same reference signals "no change" and should skip
    // both the write and the listener notification.
    saveCurrentProjectConfig(current => current)

    expect(calls).toBe(0)
  })
})
