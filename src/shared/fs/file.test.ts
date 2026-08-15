import { afterEach, describe, expect, mock, test } from 'bun:test'

// Capture the genuine module BEFORE any mock so afterEach can restore the
// full export surface. Restoring `{}` (the previous behavior) left the
// module registry poisoned for every later test file in a full-suite run —
// any transitive named import from growthbook.js then failed with
// "Export named ... not found".
const realGrowthbook = {
  ...(await import('src/platform/analytics/growthbook.js')),
}

async function importFileModuleWithKillswitchEnabled(
  killswitchEnabled: boolean,
) {
  mock.module('src/platform/analytics/growthbook.js', () => ({
    ...realGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: () => killswitchEnabled,
  }))

  return import(`./file.js?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mock.module('src/platform/analytics/growthbook.js', () => realGrowthbook)
})

describe('addLineNumbers', () => {
  test('uses unambiguous arrow compact prefix and preserves leading tabs', async () => {
    const { addLineNumbers } = await importFileModuleWithKillswitchEnabled(false)

    const result = addLineNumbers({
      content: '\tfirst\n\t\tsecond',
      startLine: 41,
    })

    expect(result).toBe('41→\tfirst\n42→\t\tsecond')
  })

  test('keeps padded arrow format when compact mode is disabled', async () => {
    const { addLineNumbers } = await importFileModuleWithKillswitchEnabled(true)

    const result = addLineNumbers({
      content: 'alpha\nbeta',
      startLine: 1,
    })

    expect(result).toBe('     1→alpha\n     2→beta')
  })
})

describe('stripLineNumberPrefix', () => {
  test('strips compact arrow, padded arrow, and legacy tab prefixes', async () => {
    const { stripLineNumberPrefix } = await importFileModuleWithKillswitchEnabled(
      false,
    )

    expect(stripLineNumberPrefix('41→\tfirst')).toBe('\tfirst')
    expect(stripLineNumberPrefix('     2→beta')).toBe('beta')
    expect(stripLineNumberPrefix('7\t\tlegacy-tab')).toBe('\tlegacy-tab')
  })
})
