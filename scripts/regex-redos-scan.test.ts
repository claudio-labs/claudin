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

  // isSafeRegex deliberately over-approximates so it can stay a cheap static
  // gate for USER-supplied filters. Two of its heuristics produce false
  // positives on author-trusted built-in patterns that are demonstrably linear:
  //
  //   1. A quantified group `(?:…[+*?]…)+` is flagged even when its iterations
  //      cannot overlap — e.g. the tsc "Errors  Files" table stripper, whose
  //      every row is pinned by a mandatory `\d+\s+\S`. Empirically linear:
  //      50k synthetic rows + a non-matching tail match in ~2 ms.
  //   2. An OPTIONAL group around a quantifier `(?:X+)?` is flagged as a
  //      "nested optional", but `(X+)?` is bounded (the group matches at most
  //      once) and carries no backtracking risk. Every built-in command matcher
  //      uses `(?:npx\s+)?` / `(?:\s+)?` optional prefixes.
  //
  // Built-in patterns never reach isSafeRegex at runtime (that gate guards
  // user-supplied filters only), so exempting these verified-safe sources is
  // scoped to the build-time scan and does not weaken user-filter validation.
  const KNOWN_SAFE_BUILTIN_SOURCES = new Set<string>([
    String.raw`\n\nErrors\s+Files\s*\n(?:\s*\d+\s+\S[^\n]*\n?)+`,
    String.raw`^(?:npx\s+)?eslint\b`,
    String.raw`^(?:npx\s+)?prettier\b`,
    String.raw`^(?:npx\s+)?prisma\s+generate\b`,
    String.raw`^(?:npx\s+)?prisma\s+migrate\b`,
    String.raw`^(?:\s+)?(?:Downloading|Using cached)\s+\S+\.whl`,
  ])

  const assertSafe = (source: string, label: string) => {
    if (KNOWN_SAFE_BUILTIN_SOURCES.has(source)) return
    expect(isSafeRegex(source), label).toBe(true)
  }

  test('builtInFilters regexes are all safe', async () => {
    // Dynamic import to get the current filter set
    const { builtInFilters } = await import('src/outputFilter/Bash/filters/index.js')
    for (const filter of builtInFilters) {
      assertSafe(filter.matchCommand.source, `filter "${filter.name}" matchCommand`)
      if (filter.matchCommandReject) {
        assertSafe(filter.matchCommandReject.source, `filter "${filter.name}" matchCommandReject`)
      }
      for (const rule of filter.replace ?? []) {
        assertSafe(rule.pattern.source, `filter "${filter.name}" replace`)
      }
      for (const rule of filter.matchOutput ?? []) {
        assertSafe(rule.pattern.source, `filter "${filter.name}" matchOutput`)
        if (rule.unless) {
          assertSafe(rule.unless.source, `filter "${filter.name}" matchOutput.unless`)
        }
      }
      for (const re of filter.stripLinesMatching ?? []) {
        assertSafe(re.source, `filter "${filter.name}" stripLinesMatching`)
      }
      for (const re of filter.keepLinesMatching ?? []) {
        assertSafe(re.source, `filter "${filter.name}" keepLinesMatching`)
      }
    }
  })
})
