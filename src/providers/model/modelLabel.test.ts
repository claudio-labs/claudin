import { afterEach, beforeEach, expect, test, mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'

// Regression: the picker offers both 200k and 1M flavors of each Opus/Sonnet
// generation, so labels (the "Set model to X" confirmation and the status chip,
// both via renderModelName) must annotate "(1M context)" on the [1m] variant
// and show the plain name on the 200k variant — even when the Opus 1M merge is
// on (previously the merge suppressed the annotation, making the two flavors
// indistinguishable).

const realProviders = await import('src/providers/model/providers.js')
const realModel = await import('src/providers/model/model.js')

async function importRenderer(mergeEnabled: boolean) {
  mock.module('./providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'firstParty',
  }))
  mock.module('./model.js', () => ({
    ...realModel,
    isOpus1mMergeEnabled: () => mergeEnabled,
  }))
  resetModelStringsForTestingOnly()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./model.js?ts=${nonce}`)
}

const CASES: Array<[string, string]> = [
  // Opus 5 is 1M-native — single label, no "(1M context)" variant (like Sonnet 5).
  ['claude-opus-5', 'Opus 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-8[1m]', 'Opus 4.8 (1M context)'],
  ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-7[1m]', 'Opus 4.7 (1M context)'],
  ['claude-opus-4-6', 'Opus 4.6'],
  ['claude-opus-4-6[1m]', 'Opus 4.6 (1M context)'],
  // Sonnet 5 is 1M-native — single label, no "(1M context)" variant (like Fable 5).
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-sonnet-4-6[1m]', 'Sonnet 4.6 (1M context)'],
]

beforeEach(() => {
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  mock.restore()
  resetModelStringsForTestingOnly()
})

test('renderModelName annotates 1M and stays plain for 200k (merge OFF)', async () => {
  const { renderModelName } = await importRenderer(false)
  for (const [model, label] of CASES) {
    expect(renderModelName(model)).toBe(label)
  }
})

test('renderModelName still annotates 1M when the Opus merge is ON', async () => {
  const { renderModelName } = await importRenderer(true)
  for (const [model, label] of CASES) {
    expect(renderModelName(model)).toBe(label)
  }
})
