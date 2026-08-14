import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'

// Regression: getDefaultMainLoopModelSetting() appends the Opus 1M-merge [1m]
// suffix for first-party Max / Team-Premium subscribers. Now that the 1P Opus
// default is Opus 5 (native-1M, no [1m] variant), that suffix must be
// suppressed — otherwise the default model becomes `claude-opus-5[1m]`, which
// pushes a context-1m beta header for a model that never needs one and returns
// a null public display name.
//
// isOpus1mMergeEnabled() lives in model.js and is driven by its boundary deps
// (auth / providers / context), so we mock those — never model.js itself — and
// exercise the REAL getDefaultMainLoopModelSetting + isOpus1mMergeEnabled.

const realProviders = { ...(await import('./providers.js')) }
const realAuth = { ...(await import('src/services/auth/auth.js')) }
const realContext = { ...(await import('src/services/context/context.js')) }

async function importSetting(opts: {
  max: boolean
  teamPremium: boolean
}) {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'firstParty',
  }))
  mock.module('src/services/auth/auth.js', () => ({
    ...realAuth,
    isMaxSubscriber: () => opts.max,
    isTeamPremiumSubscriber: () => opts.teamPremium,
    isProSubscriber: () => false,
    isClaudeAISubscriber: () => true,
    // Non-null subscription type so isOpus1mMergeEnabled doesn't fail closed.
    getSubscriptionType: () => 'max',
  }))
  mock.module('src/services/context/context.js', () => ({
    ...realContext,
    is1mContextDisabled: () => false,
  }))
  resetModelStringsForTestingOnly()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./model.js?ts=${nonce}`)
}

beforeEach(() => {
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  mock.restore()
  resetModelStringsForTestingOnly()
})

afterAll(() => {
  mock.module('./providers.js', () => realProviders)
  mock.module('src/services/auth/auth.js', () => realAuth)
  mock.module('src/services/context/context.js', () => realContext)
})

test('Max subscriber default is native-1M Opus 5 with no [1m] suffix (merge enabled)', async () => {
  const { getDefaultMainLoopModelSetting, isOpus1mMergeEnabled } =
    await importSetting({ max: true, teamPremium: false })
  // Guard: the merge really is on for this mocked account, so the old code
  // would have appended [1m].
  expect(isOpus1mMergeEnabled()).toBe(true)
  const setting = getDefaultMainLoopModelSetting()
  expect(setting).toBe('claude-opus-5')
  expect(setting).not.toContain('[1m]')
})

test('Team Premium subscriber default is native-1M Opus 5 with no [1m] suffix', async () => {
  const { getDefaultMainLoopModelSetting } = await importSetting({
    max: false,
    teamPremium: true,
  })
  const setting = getDefaultMainLoopModelSetting()
  expect(setting).toBe('claude-opus-5')
  expect(setting).not.toContain('[1m]')
})
