import { describe, expect, test } from 'bun:test'

// A fresh copy of the module: another suite mocks src/shared/fs/file.js, and
// Bun applies that mock process-wide.
async function importFileModule() {
  return import(`./file.js?ts=${Date.now()}-${Math.random()}`)
}

describe('addLineNumbers', () => {
  test('uses unambiguous arrow compact prefix and preserves leading tabs', async () => {
    const { addLineNumbers } = await importFileModule()

    const result = addLineNumbers({
      content: '\tfirst\n\t\tsecond',
      startLine: 41,
    })

    expect(result).toBe('41→\tfirst\n42→\t\tsecond')
  })
})

describe('stripLineNumberPrefix', () => {
  test('strips compact arrow, padded arrow, and legacy tab prefixes', async () => {
    const { stripLineNumberPrefix } = await importFileModule()

    expect(stripLineNumberPrefix('41→\tfirst')).toBe('\tfirst')
    expect(stripLineNumberPrefix('     2→beta')).toBe('beta')
    expect(stripLineNumberPrefix('7\t\tlegacy-tab')).toBe('\tlegacy-tab')
  })
})
