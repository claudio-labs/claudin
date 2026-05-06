/**
 * Build-time ReDoS safety scan for bash-output-filter regex patterns.
 *
 * Scans all RegExp literals in src/outputFilter/Bash/filters/ and validates
 * them against isSafeRegex heuristics. Passes vacuously in Phase 1 (no filters).
 */
import { describe, expect, test } from 'bun:test'
import { isSafeRegex } from 'src/outputFilter/Bash/userFilters.js'

describe('regex-redos-scan', () => {
  test('isSafeRegex rejects nested quantifiers', () => {
    expect(isSafeRegex('(a+)+')).toBe(false)
    expect(isSafeRegex('(a*)*')).toBe(false)
    expect(isSafeRegex('(a+)*')).toBe(false)
  })

  test('isSafeRegex rejects quantified overlapping alternation', () => {
    expect(isSafeRegex('(a|a)+')).toBe(false)
    expect(isSafeRegex('(x|x)*')).toBe(false)
  })

  test('isSafeRegex accepts safe patterns', () => {
    expect(isSafeRegex('^npm$')).toBe(true)
    expect(isSafeRegex('\\d+')).toBe(true)
    expect(isSafeRegex('[a-z]+\\s*=\\s*')).toBe(true)
  })

  test('isSafeRegex rejects star-of-star', () => {
    expect(isSafeRegex('.*\\s*.*')).toBe(false)
    expect(isSafeRegex('.*.*')).toBe(false)
  })

  test('builtInFilters regexes are all safe', async () => {
    // Dynamic import to get the current filter set
    const { builtInFilters } = await import('src/outputFilter/Bash/filters/index.js')
    for (const filter of builtInFilters) {
      expect(isSafeRegex(filter.matchCommand.source), `filter "${filter.name}" matchCommand`).toBe(true)
      if (filter.matchCommandReject) {
        expect(isSafeRegex(filter.matchCommandReject.source), `filter "${filter.name}" matchCommandReject`).toBe(true)
      }
      for (const rule of filter.replace ?? []) {
        expect(isSafeRegex(rule.pattern.source), `filter "${filter.name}" replace`).toBe(true)
      }
      for (const rule of filter.matchOutput ?? []) {
        expect(isSafeRegex(rule.pattern.source), `filter "${filter.name}" matchOutput`).toBe(true)
        if (rule.unless) {
          expect(isSafeRegex(rule.unless.source), `filter "${filter.name}" matchOutput.unless`).toBe(true)
        }
      }
      for (const re of filter.stripLinesMatching ?? []) {
        expect(isSafeRegex(re.source), `filter "${filter.name}" stripLinesMatching`).toBe(true)
      }
      for (const re of filter.keepLinesMatching ?? []) {
        expect(isSafeRegex(re.source), `filter "${filter.name}" keepLinesMatching`).toBe(true)
      }
    }
  })
})
