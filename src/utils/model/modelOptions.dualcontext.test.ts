import { afterEach, beforeEach, expect, test, mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'

const realProviders = await import('./providers.js')
const realAuth = await import('../auth.js')
const realAccess = await import('./check1mAccess.js')
const realModel = await import('./model.js')

const BASES = [
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
]

// Simulate a first-party Max subscriber and load a fresh copy of the picker.
async function importMaxPicker(opts: {
  mergeEnabled: boolean
  opusAccess: boolean
  sonnetAccess: boolean
}) {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'firstParty',
  }))
  mock.module('../auth.js', () => ({
    ...realAuth,
    isClaudeAISubscriber: () => true,
    isMaxSubscriber: () => true,
    isTeamPremiumSubscriber: () => false,
    isProSubscriber: () => false,
  }))
  mock.module('./check1mAccess.js', () => ({
    ...realAccess,
    checkOpus1mAccess: () => opts.opusAccess,
    checkSonnet1mAccess: () => opts.sonnetAccess,
  }))
  mock.module('./model.js', () => ({
    ...realModel,
    isOpus1mMergeEnabled: () => opts.mergeEnabled,
  }))
  resetModelStringsForTestingOnly()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

beforeEach(() => {
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  mock.restore()
  resetModelStringsForTestingOnly()
})

test('Max picker lists 200k + 1M for every model when access checks pass', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: true,
    sonnetAccess: true,
  })
  const values = getModelOptions().map((o: { value: string | null }) => o.value)
  for (const base of BASES) {
    expect(values).toContain(base) // 200k flavor
    expect(values).toContain(`${base}[1m]`) // 1M flavor
  }
})

// Regression for the empty-picker screenshot: checkOpus1mAccess/checkSonnet1mAccess
// return false when the extra-usage reason isn't cached, but the merge being on
// means the Default already runs opus[1m], so 1M variants must still be listed.
test('merge enabled surfaces 1M variants even when access checks are false', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: false,
    sonnetAccess: false,
  })
  const values = getModelOptions().map((o: { value: string | null }) => o.value)
  for (const base of BASES) {
    expect(values).toContain(base)
    expect(values).toContain(`${base}[1m]`)
  }
})

// When the account genuinely has no 1M (merge off + access false), the 1M
// variants are suppressed so the picker never offers a model the API rejects.
test('no merge and no access suppresses 1M variants', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: false,
    opusAccess: false,
    sonnetAccess: false,
  })
  const values = getModelOptions().map((o: { value: string | null }) => o.value)
  for (const base of BASES) {
    expect(values).toContain(base) // 200k flavor still present
    expect(values).not.toContain(`${base}[1m]`) // 1M flavor hidden
  }
})
