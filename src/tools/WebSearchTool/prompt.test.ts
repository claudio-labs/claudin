import { describe, expect, test } from 'bun:test'
import { getCompactWebSearchPrompt, getWebSearchPrompt } from './prompt.js'

const MONTH_YEAR_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/

describe('WebSearch prompt', () => {
  const texts = {
    full: getWebSearchPrompt(),
    compact: getCompactWebSearchPrompt(true),
    compactNoRegion: getCompactWebSearchPrompt(false),
  }

  for (const [name, text] of Object.entries(texts)) {
    test(`${name}: points at the conversation's date, never a baked-in month`, () => {
      expect(text).toContain("Today's date is given in the conversation")
      expect(text).not.toMatch(MONTH_YEAR_RE)
    })
  }

  test('the region note follows usOnly', () => {
    expect(texts.compact).toContain('US-only.')
    expect(texts.compactNoRegion).not.toContain('US-only')
  })
})
