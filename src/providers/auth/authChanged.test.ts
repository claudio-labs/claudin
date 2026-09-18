import { describe, expect, test } from 'bun:test'
import {
  emitAuthChanged,
  getAuthVersion,
  onAuthChange,
} from 'src/providers/auth/authChanged.js'

describe('authChanged', () => {
  test('emitting bumps the version and notifies subscribers', () => {
    const before = getAuthVersion()
    let calls = 0
    const unsubscribe = onAuthChange(() => {
      calls++
    })

    emitAuthChanged()
    expect(calls).toBe(1)
    expect(getAuthVersion()).toBe(before + 1)

    unsubscribe()
    emitAuthChanged()
    expect(calls).toBe(1)
    expect(getAuthVersion()).toBe(before + 2)
  })

  test('clearAuthRelatedCaches announces the change', async () => {
    // The wiring, pinned where the damage was: nothing incremented the old
    // AppState.authVersion, so useManageMCPConnections' effect — which takes it
    // as a dependency specifically to refetch the claude.ai connector list —
    // never re-ran after a login or logout.
    const { clearAuthRelatedCaches } = await import(
      'src/platform/headless/handlers/auth.js'
    )
    const before = getAuthVersion()
    await clearAuthRelatedCaches()
    expect(getAuthVersion()).toBe(before + 1)
  })
})
