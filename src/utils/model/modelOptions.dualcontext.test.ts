import { afterEach, beforeEach, expect, test, mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'

const realProviders = await import('src/utils/model/providers.js')
const realAuth = await import('src/services/auth/auth.js')
const realAccess = await import('src/utils/model/check1mAccess.js')
const realModel = await import('src/utils/model/model.js')

// Opus 5, Sonnet 5 and Fable 5 are all 1M-native: each is a single picker entry
// with no separate [1m] variant (asserted below). Legacy generations were
// removed from the first-party picker (still resolvable by explicit string).
const REMOVED_LEGACY = [
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
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
  mock.module('src/services/auth/auth.js', () => ({
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

// Opus 5 is the new default and is 1M-native (like Sonnet 5): it must appear as
// a SINGLE picker entry pinned to the 'opus' alias on first party, with no
// separate [1m] variant and no 200k duplicate.
test('Opus 5 is a single 1M-native entry (value "opus", no [1m] pair)', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: true,
    sonnetAccess: true,
  })
  const options = getModelOptions()
  const values = options.map((o: { value: string | null }) => o.value)
  expect(values).toContain('opus')
  expect(values).not.toContain('opus[1m]')
  // Exactly one Opus entry, and it advertises 1M context.
  const opus = options.filter((o: { value: string | null }) => o.value === 'opus')
  expect(opus).toHaveLength(1)
  expect(opus[0].label).toBe('Opus 5')
  expect(opus[0].description).toContain('1M context')
  // Legacy Opus/Sonnet generations are no longer listed.
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
  // The legacy Sonnet 4.6 pair and older Opus generations are gone.
  expect(values).not.toContain('claude-sonnet-4-6')
  expect(values).not.toContain('claude-sonnet-4-6[1m]')
  expect(values).not.toContain('claude-opus-4-8')
  expect(values).not.toContain('claude-opus-4-7')
  expect(values).not.toContain('claude-opus-4-6')
})

// Opus 5 is 1M by default (native), so unlike the old Opus 4.8 200k/[1m] pair it
// is NOT gated by the 1M-access / merge checks — it always shows as the single
// 'opus' entry, even when both access checks are false and merge is off.
test('Opus 5 entry is present regardless of 1M access checks', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: false,
    opusAccess: false,
    sonnetAccess: false,
  })
  const options = getModelOptions()
  const values = options.map((o: { value: string | null }) => o.value)
  expect(values).toContain('opus')
  expect(values).not.toContain('opus[1m]')
  const opus = options.find((o: { value: string | null }) => o.value === 'opus')
  expect(opus?.label).toBe('Opus 5')
  expect(opus?.description).toContain('1M context')
})
