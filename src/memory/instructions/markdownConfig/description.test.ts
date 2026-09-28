import { describe, expect, test } from 'bun:test'

import { extractDescriptionFromMarkdown } from 'src/memory/instructions/markdownConfig/description.js'

// Two UTF-16 units, as every character outside the basic plane.
const GRINNING_FACE = '\u{1F600}'

describe('a description cut to length', () => {
  test('goes back one unit rather than split a character that straddles the cut', () => {
    const described = extractDescriptionFromMarkdown(`${'a'.repeat(96)}${GRINNING_FACE}${'b'.repeat(10)}`)
    expect(described).toBe(`${'a'.repeat(96)}...`)
    expect(described.isWellFormed()).toBe(true)
  })

  test('keeps a character that ends exactly at the cut', () => {
    const described = extractDescriptionFromMarkdown(`${'a'.repeat(95)}${GRINNING_FACE}${'b'.repeat(10)}`)
    expect(described).toBe(`${'a'.repeat(95)}${GRINNING_FACE}...`)
  })

  test('measures the length in UTF-16 units, so 100 of them stay whole', () => {
    const text = `${'a'.repeat(98)}${GRINNING_FACE}`
    expect(extractDescriptionFromMarkdown(text)).toBe(text)
  })
})
