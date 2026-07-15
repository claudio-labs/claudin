import { afterEach, beforeEach, expect, test, mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'

const realProviders = await import('./providers.js')
const realAuth = await import('../auth.js')
const realAccess = await import('./check1mAccess.js')
const realModel = await import('./model.js')

// Only the newest Opus generation is listed in the first-party picker, and only
// its 1M flavor when the account has 1M (200k fallback when it doesn't); Sonnet 5
// is a single 1M-native entry (asserted separately below).
const BASES = ['claude-opus-4-8']

// Legacy generations were removed from the first-party picker (still resolvable
// by explicit string, just not listed).
const REMOVED_LEGACY = [
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
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

test('Max picker lists only the 1M Opus entry when access checks pass', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: true,
    sonnetAccess: true,
  })
  const options = getModelOptions()
  const values = options.map((o: { value: string | null }) => o.value)
  for (const base of BASES) {
    expect(values).not.toContain(base) // no 200k duplicate
    expect(values).toContain(`${base}[1m]`) // only the 1M flavor
    // The surviving entry is labelled as the 1M flavor, not the bare 200k one.
    const opus = options.find(
      (o: { value: string | null }) => o.value === `${base}[1m]`,
    )
    expect(opus?.label).toBe('Opus 4.8 (1M context)')
    expect(opus?.description).toContain('1M context')
  }
  // Legacy generations are no longer listed.
  for (const legacy of REMOVED_LEGACY) {
    expect(values).not.toContain(legacy)
  }
})

// Sonnet 5 is the new default and is 1M-native: it must appear as a SINGLE
// picker entry with no separate [1m] variant, and the legacy Sonnet 4.6 pair is
// no longer listed.
test('Sonnet 5 is a single 1M-native entry (no [1m] pair, no legacy Sonnet)', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: true,
    sonnetAccess: true,
  })
  const values = getModelOptions().map((o: { value: string | null }) => o.value)
  expect(values).toContain('claude-sonnet-5')
  expect(values).not.toContain('claude-sonnet-5[1m]')
  // Exactly one Sonnet 5 entry.
  expect(values.filter((v: string | null) => v === 'claude-sonnet-5')).toHaveLength(1)
  // The legacy Sonnet 4.6 pair is gone; only the newest Opus generation remains.
  expect(values).not.toContain('claude-sonnet-4-6')
  expect(values).not.toContain('claude-sonnet-4-6[1m]')
  expect(values).not.toContain('claude-opus-4-7')
  expect(values).not.toContain('claude-opus-4-6')
})

// Regression for the empty-picker screenshot: checkOpus1mAccess/checkSonnet1mAccess
// return false when the extra-usage reason isn't cached, but the merge being on
// means the Default already runs opus[1m], so 1M variants must still be listed.
test('merge enabled surfaces the 1M variant even when access checks are false', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: false,
    sonnetAccess: false,
  })
  const values = getModelOptions().map((o: { value: string | null }) => o.value)
  for (const base of BASES) {
    expect(values).not.toContain(base) // no 200k duplicate
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
  const options = getModelOptions()
  const values = options.map((o: { value: string | null }) => o.value)
  for (const base of BASES) {
    expect(values).toContain(base) // 200k flavor still present
    expect(values).not.toContain(`${base}[1m]`) // 1M flavor hidden
    // The fallback entry is the plain 200k Opus, without the 1M label/suffix.
    const opus = options.find(
      (o: { value: string | null }) => o.value === base,
    )
    expect(opus?.label).toBe('Opus 4.8')
    expect(opus?.description).not.toContain('1M context')
  }
})
