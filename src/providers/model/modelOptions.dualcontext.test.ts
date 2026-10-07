import { afterEach, beforeEach, expect, test, mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'

const realProviders = await import('src/providers/model/providers.js')
const realAuth = await import('src/providers/auth/auth.js')
const realAccess = await import('src/providers/model/check1mAccess.js')
const realModel = await import('src/providers/model/model.js')

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
  mock.module('src/providers/auth/auth.js', () => ({
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

// Opus 5.5 is the default and is 1M-native (like Sonnet 5): it must appear as a
// SINGLE picker entry pinned to the 'opus' alias on first party, with no
// separate [1m] variant and no 200k duplicate. Opus 5 is still listed beside it
// as the previous generation, pinned to its explicit model string.
test('Opus 5.5 is a single 1M-native entry (value "opus", no [1m] pair)', async () => {
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
  expect(opus[0].label).toBe('Opus 5.5')
  expect(opus[0].description).toContain('1M context')
  // The previous generation stays selectable, and never as the alias.
  expect(values).toContain('claude-opus-5')
  expect(values).not.toContain('claude-opus-5[1m]')
  // Legacy Opus/Sonnet generations are no longer listed.
  for (const legacy of REMOVED_LEGACY) {
    expect(values).not.toContain(legacy)
  }
})

// Sonnet 5.5 is the default Sonnet and is 1M-native: it must appear as a SINGLE
// picker entry pinned to the 'sonnet' alias on first party, with no separate
// [1m] variant. Sonnet 5 is still listed beside it as the previous generation,
// pinned to its explicit model string, and the legacy Sonnet 4.6 pair is gone.
test('Sonnet 5.5 is a single 1M-native entry (value "sonnet"), Sonnet 5 stays listed', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: true,
    sonnetAccess: true,
  })
  const options = getModelOptions()
  const values = options.map((o: { value: string | null }) => o.value)
  const sonnet = options.filter((o: { value: string | null }) => o.value === 'sonnet')
  expect(sonnet).toHaveLength(1)
  expect(sonnet[0].label).toBe('Sonnet 5.5')
  expect(sonnet[0].description).toContain('1M context')
  expect(values).not.toContain('sonnet[1m]')
  expect(values).not.toContain('claude-sonnet-5-5')
  // The previous generation stays selectable, and never as the alias.
  expect(values).toContain('claude-sonnet-5')
  expect(values).not.toContain('claude-sonnet-5[1m]')
  expect(values.filter((v: string | null) => v === 'claude-sonnet-5')).toHaveLength(1)
  // The legacy Sonnet 4.6 pair and older Opus generations are gone.
  expect(values).not.toContain('claude-sonnet-4-6')
  expect(values).not.toContain('claude-sonnet-4-6[1m]')
  expect(values).not.toContain('claude-opus-4-8')
  expect(values).not.toContain('claude-opus-4-7')
  expect(values).not.toContain('claude-opus-4-6')
})

// Haiku 5.5 replaced Haiku 4.5 as the 'haiku' alias on first party: one entry,
// named for 5.5, and Haiku 4.5 is not listed beside it.
test('the haiku entry is Haiku 5.5, and Haiku 4.5 is gone', async () => {
  const { getModelOptions } = await importMaxPicker({
    mergeEnabled: true,
    opusAccess: true,
    sonnetAccess: true,
  })
  const options = getModelOptions()
  const values = options.map((o: { value: string | null }) => o.value)
  const haiku = options.filter((o: { value: string | null }) => o.value === 'haiku')
  expect(haiku).toHaveLength(1)
  expect(haiku[0].description).toContain('Haiku 5.5')
  expect(haiku[0].description).toContain('1M context')
  expect(values).not.toContain('claude-haiku-4-5-20251001')
  expect(options.some((o: { description: string }) => o.description.includes('Haiku 4.5'))).toBe(false)
})

// A Vertex PAYG picker: Haiku 4.5 stays the 'haiku' default there, with Haiku
// 5.5 as an explicit opt-in. `haikuDefault` stands in for a future 3P default.
async function import3PPicker(haikuDefault?: string) {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'vertex',
  }))
  mock.module('src/providers/auth/auth.js', () => ({
    ...realAuth,
    isClaudeAISubscriber: () => false,
  }))
  mock.module('./check1mAccess.js', () => ({
    ...realAccess,
    checkOpus1mAccess: () => false,
    checkSonnet1mAccess: () => false,
  }))
  mock.module('./model.js', () => ({
    ...realModel,
    ...(haikuDefault ? { getDefaultHaikuModel: () => haikuDefault } : {}),
  }))
  resetModelStringsForTestingOnly()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

const haikuEntries = (options: { value: string | null; description: string }[]) =>
  options.filter(o => o.description.startsWith('Haiku') || o.description.includes(' Haiku '))

test('3P lists Haiku 5.5 as an opt-in beside the Haiku 4.5 default', async () => {
  const { getModelOptions } = await import3PPicker()
  const haiku = haikuEntries(getModelOptions())
  expect(haiku.map(o => o.value)).toEqual(['claude-haiku-5-5', 'haiku'])
  expect(haiku[0]!.description).toContain('Haiku 5.5')
  expect(haiku[1]!.description).toContain('Haiku 4.5')
})

test('a 3P Haiku default of 5.5 is listed once, as Haiku 5.5 — not as Haiku 3.5', async () => {
  const { getModelOptions } = await import3PPicker('claude-haiku-5-5')
  const haiku = haikuEntries(getModelOptions())
  expect(haiku).toHaveLength(1)
  expect(haiku[0]!.description).toContain('Haiku 5.5')
})

// Opus 5.5 is 1M by default (native), so unlike the old Opus 4.8 200k/[1m] pair
// it is NOT gated by the 1M-access / merge checks — it always shows as the
// single 'opus' entry, even when both access checks are false and merge is off.
test('Opus 5.5 entry is present regardless of 1M access checks', async () => {
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
  expect(opus?.label).toBe('Opus 5.5')
  expect(opus?.description).toContain('1M context')
})
