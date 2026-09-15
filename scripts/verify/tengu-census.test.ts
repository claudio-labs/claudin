import { describe, expect, test } from 'bun:test'
import {
  censusFile,
  REGION_CODE,
  REGION_COMMENT,
  REGION_REGEX,
  REGION_STRING,
  runCensus,
  scanRegions,
} from './tengu-census'

/** Region byte at the first occurrence of `needle` in `source`. */
function regionAt(source: string, needle: string): number {
  const regions = scanRegions(source)
  return regions[source.indexOf(needle)]!
}

/** Buckets keyed by token, for a synthetic file. */
function bucketsOf(source: string, name = '/repo/src/sample.ts') {
  return Object.fromEntries(
    censusFile(name, source).map(o => [`${o.token}@${o.line}`, o.bucket]),
  )
}

describe('scanRegions', () => {
  test('separates code, line comments, block comments, strings and regexes', () => {
    const source = [
      'const a = 1 // CMT',
      '/* BLOCK */',
      "const b = 'STR'",
      'const re = /RE/g',
      'const c = CODE',
    ].join('\n')

    expect(regionAt(source, 'CMT')).toBe(REGION_COMMENT)
    expect(regionAt(source, 'BLOCK')).toBe(REGION_COMMENT)
    expect(regionAt(source, 'STR')).toBe(REGION_STRING)
    expect(regionAt(source, 'RE')).toBe(REGION_REGEX)
    expect(regionAt(source, 'CODE')).toBe(REGION_CODE)
  })

  test('a division is not mistaken for a regex opener', () => {
    // Were `/` after an identifier treated as a regex start, everything to the
    // end of the line would be swallowed and `TAIL` would report as regex.
    const source = 'const x = total / count; const TAIL = 1'
    expect(regionAt(source, 'TAIL')).toBe(REGION_CODE)
  })

  test('an apostrophe in JSX text does not swallow the rest of the file', () => {
    // JSX text is code, not a string literal, so a bare apostrophe in it opens
    // a quote the scanner will never see closed. A single quote cannot span a
    // newline, so the scan has to bail at the \n — otherwise everything down to
    // the next apostrophe anywhere in the file reads as one string literal.
    //
    // Deliberately NOT written as `// it's fine`: an apostrophe inside a line
    // comment is consumed by the comment branch and never reaches the string
    // branch at all, so that shape passes with the bail deleted.
    const source = [
      "const el = <Text>don't stop</Text>",
      '// tengu_after_apostrophe',
      "const another = 'x'",
    ].join('\n')
    expect(regionAt(source, 'tengu_after_apostrophe')).toBe(REGION_COMMENT)
  })

  test('a character class hides the terminating slash of a regex', () => {
    // `/[/]won't/` ends at the FOURTH slash, not the second. Terminate it early
    // and the rest of the pattern is read as code, where the apostrophe opens a
    // string that runs to the next quote — which is the one meant to OPEN the
    // target literal. The token then lands outside any string.
    //
    // The token has to sit on the same line: a mis-parse that ends at the
    // newline is absorbed by the string scanner's own bail, and the assertion
    // passes with the class tracking deleted.
    const source = "const re = /[/]won't/g; const x = 'tengu_target'"
    expect(regionAt(source, 'tengu_target')).toBe(REGION_STRING)
  })
})

describe('censusFile', () => {
  test('separates an event name from a gate key', () => {
    const source = [
      "logEvent('tengu_event_one', {})",
      "await logEventAsync('tengu_event_two', {})",
      "if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_gate_one', false)) {}",
      "checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_gate_two')",
    ].join('\n')

    expect(bucketsOf(source)).toEqual({
      'tengu_event_one@1': 'event',
      'tengu_event_two@2': 'event',
      'tengu_gate_one@3': 'gate',
      'tengu_gate_two@4': 'gate',
    })
  })

  test('a template-literal event name still counts as an event', () => {
    // Five upstream call sites write the name as a backticked literal with no
    // interpolation; the build's rewrite handles them and so must the census.
    expect(bucketsOf('logEvent(`tengu_run_hook`, {})')).toEqual({
      'tengu_run_hook@1': 'event',
    })
  })

  test('a name reached indirectly is never reported as an event', () => {
    // This is the distinction the whole script exists for: the build refuses to
    // blank these because it cannot tell an event constant from a gate key.
    const source = [
      "const NAME = 'tengu_indirect_const'",
      "logEvent(NAME, {})",
      "const keys = ['tengu_in_array']",
      "const flags = { tengu_object_key: true }",
      "const re = /tengu_in_regex/g",
    ].join('\n')

    expect(bucketsOf(source)).toEqual({
      'tengu_indirect_const@1': 'indirect',
      'tengu_in_array@3': 'indirect',
      'tengu_object_key@4': 'indirect',
      'tengu_in_regex@5': 'indirect',
    })
  })

  test('a mention in a comment is documentation, not a call', () => {
    const source = [
      '// tengu_in_line_comment is documented here',
      '/* tengu_in_block_comment too */',
      "logEvent('tengu_real_event', {})",
    ].join('\n')

    expect(bucketsOf(source)).toEqual({
      'tengu_in_line_comment@1': 'doc',
      'tengu_in_block_comment@2': 'doc',
      // Line 3 is real code again — the block comment closed on line 2.
      'tengu_real_event@3': 'event',
    })
  })

  test('a commented-out call is documentation, not an event', () => {
    expect(bucketsOf("// logEvent('tengu_commented_out', {})")).toEqual({
      'tengu_commented_out@1': 'doc',
    })
  })

  test('every occurrence in a markdown file is documentation', () => {
    const source = "Run `logEvent('tengu_doc_example', {})` to log."
    expect(bucketsOf(source, '/repo/docs/x.md')).toEqual({
      'tengu_doc_example@1': 'doc',
    })
  })
})

describe('the tree itself', () => {
  test('no occurrence escapes classification', () => {
    // The invariant the census exists to hold: a non-zero count here means the
    // scanner has a blind spot, so a removal pass would miss whatever hid in it.
    const unclassified = runCensus().filter(o => o.bucket === 'unclassified')
    expect(unclassified.map(o => `${o.file}:${o.line} ${o.text}`)).toEqual([])
  })
})
