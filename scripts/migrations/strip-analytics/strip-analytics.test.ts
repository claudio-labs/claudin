import { describe, expect, test } from 'bun:test'
import { transform } from './strip-analytics'

/** Run the codemod on a synthetic file and return its rewritten text. */
function run(source: string, name = '/repo/src/sample.ts') {
  return transform(name, source)
}

describe('call-site removal', () => {
  test('removes a plain statement call and its import', () => {
    const out = run(
      [
        "import { logEvent } from 'src/platform/analytics/index.js'",
        "import { other } from 'src/other.js'",
        '',
        'export function f() {',
        "  logEvent('tengu_x', { a: 1 })",
        '  return other()',
        '}',
      ].join('\n'),
    )
    expect(out.calls).toBe(1)
    expect(out.specifiers).toBe(1)
    expect(out.text).not.toContain('logEvent')
    expect(out.text).toContain('return other()')
    expect(out.text).toContain("import { other }")
  })

  test('removes the await and void forms', () => {
    const out = run(
      [
        "import { logEventAsync, logOTelEvent } from 'src/x.js'",
        'export async function f() {',
        "  await logEventAsync('tengu_a', {})",
        "  void logOTelEvent('tengu_b', {})",
        '  return 1',
        '}',
      ].join('\n'),
    )
    expect(out.calls).toBe(2)
    expect(out.text).toContain('return 1')
    expect(out.text).not.toContain('logEventAsync')
    expect(out.text).not.toContain('logOTelEvent')
  })

  test('takes the call\u2019s own leading comment with it', () => {
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f() {',
        '  const n = 1',
        '  // Track the thing for analytics',
        "  logEvent('tengu_x', { n })",
        '  return n',
        '}',
      ].join('\n'),
    )
    expect(out.text).not.toContain('Track the thing')
    expect(out.text).toContain('const n = 1')
    expect(out.text).toContain('return n')
  })

  test('keeps a marker-type import that something else still uses', () => {
    // The cast survives on a non-analytics call, so dropping the import would
    // break the file — the prune decision is made against the REWRITTEN text.
    const out = run(
      [
        "import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/x.js'",
        'export function f(s: string) {',
        "  logEvent('tengu_x', {})",
        '  return other(s as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)',
        '}',
      ].join('\n'),
    )
    expect(out.calls).toBe(1)
    expect(out.text).toContain(
      'AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS',
    )
    expect(out.text).not.toContain('logEvent(')
  })

  test('leaves a file with no sink call untouched', () => {
    const out = run("export const x = 1\n")
    expect(out.text).toBeNull()
    expect(out.refusals).toEqual([])
  })
})

describe('statement boundaries that are not semicolons', () => {
  test('a call opening a switch case is a statement, not a ternary arm', () => {
    // The `:` of `case 'a':` ends a label and a statement begins after it. The
    // `:` of a ternary does not. Confusing the two refused six real sites in
    // sessionFileAccessHooks.ts.
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f(kind: string) {',
        '  switch (kind) {',
        "    case 'read':",
        "      logEvent('tengu_read', {})",
        '      break',
        '    default:',
        "      logEvent('tengu_other', {})",
        '      break',
        '  }',
        '}',
      ].join('\n'),
    )
    expect(out.refusals).toEqual([])
    expect(out.calls).toBe(2)
    expect(out.text).toContain("case 'read':")
    expect(out.text).toContain('break')
  })

  test('a ternary arm is still refused', () => {
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        "export const f = (b: boolean) => b ? logEvent('tengu_x', {}) : undefined",
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.refusals.map(r => r.kind)).toEqual(['expression-position'])
  })

  test('a comment ending in a period is not a property access', () => {
    // `prevNonSpace` has to skip the comment; stopping on its final `.` made
    // the codemod report a plain call as `m.logEvent(…)`.
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f() {',
        '  // Counted per host, see tengu_web_fetch_host.',
        "  logEvent('tengu_x', {})",
        '  return 1',
        '}',
      ].join('\n'),
    )
    expect(out.refusals).toEqual([])
    expect(out.calls).toBe(1)
  })

  test('a real property access is still refused', () => {
    const out = run(
      [
        'export function f(sink: { logEvent: (n: string) => void }) {',
        "  sink.logEvent('tengu_x')",
        '}',
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.refusals.map(r => r.kind)).toEqual(['member-call'])
  })

  test('a statement ending in a string literal still ends a statement', () => {
    // The closing quote lives in the STRING region, so reading "not code" as
    // "not a boundary" refused the ordinary call beneath it — the shape found
    // in compact.ts and FileReadTool.
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f(cleared: boolean) {',
        "  const arm = cleared ? 'cleared' : 'clipped'",
        "  logEvent('tengu_x', { arm })",
        '  return arm',
        '}',
      ].join('\n'),
    )
    expect(out.refusals).toEqual([])
    expect(out.calls).toBe(1)
    expect(out.text).toContain("const arm = cleared ? 'cleared' : 'clipped'")
  })

  test('a call on the same line as a string is still refused', () => {
    // No newline means no ASI boundary: this one is an argument.
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        "export const f = () => wrap('a', logEvent('tengu_x', {}))",
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.refusals.map(r => r.kind)).toEqual(['expression-position'])
  })

  test('a function declaration is not a call site', () => {
    const out = run(
      [
        'export function logEvent(name: string): void {',
        '  void name',
        '}',
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.refusals).toEqual([])
  })

  test('a promise chain\u2019s .catch() is not a catch clause', () => {
    // The unbraced-head check looks for `catch` before the paren. Without
    // excluding a leading dot it matched `.catch(`, refusing every call that
    // sat under a promise chain.
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f() {',
        '  void save().catch(e => {',
        '    logError(e)',
        '  })',
        "  logEvent('tengu_x', {})",
        '  return 1',
        '}',
      ].join('\n'),
    )
    expect(out.refusals).toEqual([])
    expect(out.calls).toBe(1)
    expect(out.text).toContain('logError(e)')
  })

  test('an unbraced if body is still refused', () => {
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f(x: boolean) {',
        '  if (x)',
        "    logEvent('tengu_x', {})",
        '}',
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.refusals.map(r => r.kind)).toEqual(['expression-position'])
  })

  test('a postfix increment ends the statement above a call', () => {
    // `n++` terminates; a bare `+` would not. Reading only the last character
    // refused the call under every counter bump.
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f(t: { n: number }) {',
        '  t.n++',
        "  logEvent('tengu_x', { n: t.n })",
        '  return t.n',
        '}',
      ].join('\n'),
    )
    expect(out.refusals).toEqual([])
    expect(out.calls).toBe(1)
    expect(out.text).toContain('t.n++')
  })
})

describe('refusals', () => {
  test('refuses a call used as a value', () => {
    // `const p = logEventAsync(...)` is a value: deleting it changes what the
    // binding holds. The whole file is left alone, not partially rewritten.
    const out = run(
      [
        "import { logEventAsync } from 'src/x.js'",
        'export async function f() {',
        "  const p = logEventAsync('tengu_x', {})",
        '  await p',
        '}',
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.refusals.map(r => r.kind)).toEqual(['expression-position'])
  })

  test('refuses when the call is the only statement in a catch', () => {
    // An emptied catch is `catch {}`, which the repo's own TypeScript rule
    // bans outright — so this must reach a human, not be written silently.
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f() {',
        '  try {',
        '    risky()',
        '  } catch (e) {',
        "    logEvent('tengu_failed', {})",
        '  }',
        '}',
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.refusals.map(r => r.kind)).toEqual(['empties-block'])
  })

  test('a refusal blocks the whole file, including its other call sites', () => {
    // Partial rewrites are the dangerous outcome: half-removed analytics with a
    // dangling import is harder to spot than an untouched file.
    const out = run(
      [
        "import { logEvent, logEventAsync } from 'src/x.js'",
        'export async function f() {',
        "  logEvent('tengu_ok', {})",
        "  const p = logEventAsync('tengu_bad', {})",
        '  return p',
        '}',
      ].join('\n'),
    )
    expect(out.text).toBeNull()
    expect(out.calls).toBe(0)
  })

  test('does not refuse when a sibling statement survives the block', () => {
    const out = run(
      [
        "import { logEvent } from 'src/x.js'",
        'export function f() {',
        '  try {',
        '    risky()',
        '  } catch (e) {',
        "    logEvent('tengu_failed', {})",
        '    logError(e)',
        '  }',
        '}',
      ].join('\n'),
    )
    expect(out.refusals).toEqual([])
    expect(out.calls).toBe(1)
    expect(out.text).toContain('logError(e)')
  })
})
