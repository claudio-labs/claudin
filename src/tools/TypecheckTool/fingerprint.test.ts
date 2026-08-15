import { describe, expect, test } from 'bun:test'
import {
  fingerprintDiagnostic,
  normalizeDiagnosticPath,
  partitionAgainstBaseline,
} from 'src/tools/TypecheckTool/fingerprint.js'
import type { RawDiagnostic } from 'src/tools/TypecheckTool/types.js'

const CWD = '/home/dev/project'

function diag(overrides: Partial<RawDiagnostic> = {}): RawDiagnostic {
  return {
    file: 'src/a.ts',
    line: 23,
    column: 5,
    severity: 'error',
    code: 'TS2322',
    message: "Type 'string' is not assignable to type 'number'.",
    ...overrides,
  }
}

describe('fingerprintDiagnostic', () => {
  test('survives the arbitrary export name tsc puts in TS2460', () => {
    // Measured, not hypothetical: two back-to-back `tsc --noEmit` runs over an
    // untouched tree disagreed on 23 of this repo's 27 TS2460 messages, because
    // tsc names an arbitrary sibling export of the broken module. Hashing that
    // reported 63 new AND 63 fixed on a tree nobody had touched.
    const message = (exportedAs: string) =>
      `Module '"src/entrypoints/agentSdkTypes.js"' declares 'SDKMessage' locally, but it is exported as '${exportedAs}'.`
    const first = fingerprintDiagnostic(
      diag({ code: 'TS2460', message: message('ForkSessionOptions') }),
      CWD,
    )
    const second = fingerprintDiagnostic(
      diag({ code: 'TS2460', message: message('SDKControlResponse') }),
      CWD,
    )
    expect(second).toBe(first)
  })

  test('still separates two stable messages sharing a file and a code', () => {
    // The normalisation must not become "hash the code and give up": a new
    // error in a file that already has one of the same kind has to stay visible.
    const a = fingerprintDiagnostic(
      diag({ message: "Type 'string' is not assignable to type 'number'." }),
      CWD,
    )
    const b = fingerprintDiagnostic(
      diag({ message: "Type 'boolean' is not assignable to type 'number'." }),
      CWD,
    )
    expect(b).not.toBe(a)
  })

  test('a different local symbol still fingerprints apart under the same code', () => {
    const a = fingerprintDiagnostic(
      diag({ code: 'TS2460', message: "declares 'A' locally, but it is exported as 'X'." }),
      CWD,
    )
    const b = fingerprintDiagnostic(
      diag({ code: 'TS2460', message: "declares 'B' locally, but it is exported as 'X'." }),
      CWD,
    )
    expect(b).not.toBe(a)
  })

  test('ignores line and column so an inserted line does not resurface errors', () => {
    // The whole feature rests on this: in a project with thousands of baselined
    // errors, a one-line insertion must not report them all as newly introduced.
    const before = fingerprintDiagnostic(diag({ line: 23, column: 5 }), CWD)
    const after = fingerprintDiagnostic(diag({ line: 43, column: 9 }), CWD)
    expect(after).toBe(before)
  })

  test('distinguishes file, code and message', () => {
    const base = fingerprintDiagnostic(diag(), CWD)
    expect(fingerprintDiagnostic(diag({ file: 'src/b.ts' }), CWD)).not.toBe(base)
    expect(fingerprintDiagnostic(diag({ code: 'TS2345' }), CWD)).not.toBe(base)
    expect(fingerprintDiagnostic(diag({ message: 'Something else.' }), CWD)).not.toBe(base)
  })

  test('an absolute path fingerprints the same as its relative form', () => {
    // pyright reports absolute paths, tsc relative ones. Without normalisation
    // a baseline recorded by one shape never matches the other.
    const relative = fingerprintDiagnostic(diag({ file: 'src/a.ts' }), CWD)
    const absolute = fingerprintDiagnostic(diag({ file: `${CWD}/src/a.ts` }), CWD)
    expect(absolute).toBe(relative)
  })

  test('collapses whitespace differences in chained messages', () => {
    const single = fingerprintDiagnostic(diag({ message: 'a b' }), CWD)
    const wrapped = fingerprintDiagnostic(diag({ message: 'a\n   b' }), CWD)
    expect(wrapped).toBe(single)
  })

  test('survives tsc picking a different representative of a truncated union', () => {
    // Reproduced by adding a two-line file that imports SDKMessage: tsc expands
    // one arbitrary member of a union it cannot print in full, and the pick
    // moves when anything else enters the program. Same file, same line, same
    // code — a different story about a different member.
    const message = (member: string, property: string, propertyType: string) =>
      [
        `Argument of type '{ type: "${member}"; session_id: string; } | ... 17 more ... | { ...; }' is not assignable to parameter of type 'SDKMessage'.`,
        `  Type '{ type: "${member}"; session_id: string; }' is not assignable to type 'SDKMessage'.`,
        `    Types of property '${property}' are incompatible.`,
        `      Type 'unknown' is not assignable to type '${propertyType}'.`,
      ].join('\n')
    const first = fingerprintDiagnostic(
      diag({ code: 'TS2345', message: message('assistant', 'message', 'Message') }),
      CWD,
    )
    const second = fingerprintDiagnostic(
      diag({ code: 'TS2345', message: message('result', 'usage', 'NonNullableUsage') }),
      CWD,
    )
    expect(second).toBe(first)
  })

  test('the union member COUNT still distinguishes two truncated diagnostics', () => {
    // Which member gets expanded is arbitrary; how many were elided is not. It
    // is the one part of the printed union worth keeping, and it is what stops
    // this normalisation from collapsing genuinely different unions.
    const message = (count: number) =>
      `Argument of type '{ a: 1; } | ... ${count} more ... | { ...; }' is not assignable to parameter of type 'X'.`
    const seventeen = fingerprintDiagnostic(diag({ message: message(17) }), CWD)
    const four = fingerprintDiagnostic(diag({ message: message(4) }), CWD)
    expect(four).not.toBe(seventeen)
  })

  test('a diagnostic with no truncated union keeps its whole chain', () => {
    // The elision must not leak into ordinary diagnostics: dropping every
    // chain would collapse the two below, and the chain is the only thing
    // telling them apart.
    const message = (property: string) =>
      `Type 'A' is not assignable to type 'B'.\n  Types of property '${property}' are incompatible.`
    const one = fingerprintDiagnostic(diag({ message: message('alpha') }), CWD)
    const other = fingerprintDiagnostic(diag({ message: message('beta') }), CWD)
    expect(other).not.toBe(one)
  })
})

describe('normalizeDiagnosticPath', () => {
  test('strips a leading ./ and keeps paths outside cwd usable', () => {
    expect(normalizeDiagnosticPath('./src/a.ts', CWD)).toBe('src/a.ts')
    expect(normalizeDiagnosticPath('', CWD)).toBe('')
  })
})

describe('partitionAgainstBaseline', () => {
  test('classifies against the recorded set', () => {
    const { isNew, fixedCount } = partitionAgainstBaseline(['a', 'b'], ['a', 'c'])
    expect(isNew).toEqual([false, true])
    // 'c' was baselined and no longer reproduces.
    expect(fixedCount).toBe(1)
  })

  test('compares as a multiset, so an extra copy of a known error is new', () => {
    // Set semantics would call all three pre-existing and hide two regressions.
    const { isNew } = partitionAgainstBaseline(['a', 'a', 'a'], ['a'])
    expect(isNew).toEqual([false, true, true])
  })

  test('an empty baseline makes everything new', () => {
    const { isNew, fixedCount } = partitionAgainstBaseline(['a', 'b'], [])
    expect(isNew).toEqual([true, true])
    expect(fixedCount).toBe(0)
  })
})
