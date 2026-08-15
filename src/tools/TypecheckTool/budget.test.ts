import { describe, expect, test } from 'bun:test'
import { formatCheckResult } from 'src/tools/TypecheckTool/budget.js'
import type { CheckResult, Diagnostic } from 'src/tools/TypecheckTool/types.js'

function diagnostic(i: number): Diagnostic {
  return {
    file: `src/f${i}.ts`,
    line: i + 1,
    column: 5,
    severity: 'error',
    code: `TS${2000 + i}`,
    message: `Problem number ${i}.`,
    source: 'typecheck',
    fingerprint: `fp${i}`,
    status: 'new',
  }
}

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    checker: 'tsc',
    command: 'tsc --noEmit --pretty false',
    errors: 0,
    warnings: 0,
    newCount: 0,
    preExistingCount: 0,
    fixedCount: 0,
    diagnostics: [],
    baseline: { kind: 'matched', sha: 'abc1234def5678' },
    alsoDetected: [],
    degraded: false,
    exitCode: 0,
    ...overrides,
  }
}

describe('formatCheckResult — a reconstructed baseline', () => {
  const reconstructed = { kind: 'reconstructed', sha: 'abc1234def5678', recordedCount: 41 } as const

  test('explains the extra checkout and says the tree was untouched', () => {
    const output = formatCheckResult(
      result({ baseline: reconstructed, preExistingCount: 41, newCount: 1, errors: 42,
        exitCode: 1, diagnostics: [diagnostic(1)] }),
    )
    expect(output).toContain('HEAD was checked out to a temporary worktree')
    expect(output).toContain('41 diagnostics recorded as the backlog')
    expect(output).toContain('Your working tree was not touched.')
  })

  test('reads as an ordinary baseline in the header, because it is one', () => {
    const output = formatCheckResult(result({ baseline: reconstructed, preExistingCount: 41 }))
    expect(output).toStartWith('✓ tsc · 0 new · 41 pre-existing (baseline @ abc1234')
    expect(output).not.toContain('behind HEAD')
    expect(output).not.toContain('provenance unknown')
  })

  test('a matched baseline explains nothing, having cost nothing', () => {
    expect(formatCheckResult(result({ preExistingCount: 41 }))).not.toContain('temporary worktree')
  })
})

describe('formatCheckResult — a refused capture', () => {
  test('says the re-record did not happen', () => {
    const output = formatCheckResult(
      result({
        baseline: { kind: 'absent', reason: 'dirty-tree-no-baseline' },
        errors: 2,
        captureRefused: true,
        diagnostics: [diagnostic(1)],
      }),
    )
    expect(output).toContain('baseline: "capture" was ignored')
    expect(output).toContain('Commit first, then capture.')
  })

  test('says it even when the run is otherwise clean', () => {
    // The silent case is the dangerous one: a caller that asked to re-record
    // and sees a tidy ✓ walks away believing its backlog was rewritten.
    const output = formatCheckResult(
      result({ baseline: { kind: 'absent', reason: 'dirty-tree-no-baseline' }, captureRefused: true }),
    )
    expect(output).toContain('baseline: "capture" was ignored')
  })

  test('an ordinary run says nothing about capture', () => {
    expect(formatCheckResult(result())).not.toContain('capture')
  })
})

describe('formatCheckResult — a capture', () => {
  test('counts what it recorded, not what it displayed', () => {
    // With a path filter the visible count understates the baseline: capture
    // records every diagnostic, so quoting the filtered number would misstate
    // what was just made permanent.
    const output = formatCheckResult(
      result({
        baseline: { kind: 'captured', sha: 'abc1234def5678', recordedCount: 47 },
        errors: 2,
        pathFilter: ['src/money.ts'],
        hiddenByPathFilter: 45,
      }),
    )
    expect(output).toContain('47 diagnostics treated as this project')
    expect(output).not.toContain('2 errors treated')
  })

  test('a re-capture at the same commit blames the toolchain, not a commit', () => {
    const output = formatCheckResult(
      result({
        baseline: {
          kind: 'captured',
          sha: 'abc1234def5678',
          recordedCount: 3,
          introducedSincePrev: { count: 2, prevSha: 'abc1234def5678' },
        },
      }),
    )
    expect(output).toContain('absent from the previous baseline at this same commit')
    expect(output).not.toContain('introduced by a commit')
  })

  test('a capture at a new commit still blames the commit', () => {
    const output = formatCheckResult(
      result({
        baseline: {
          kind: 'captured',
          sha: 'abc1234def5678',
          recordedCount: 3,
          introducedSincePrev: { count: 2, prevSha: 'fed9876cba4321' },
        },
      }),
    )
    expect(output).toContain('new since fed9876')
    expect(output).toContain('introduced by a commit')
  })
})

describe('formatCheckResult — an inherited baseline', () => {
  const inherited = { kind: 'inherited', sha: 'abc1234def5678', behind: 2 } as const

  test('names the commit it borrowed and how far behind it is', () => {
    const output = formatCheckResult(
      result({ baseline: inherited, errors: 5, preExistingCount: 4, newCount: 1, exitCode: 1,
        diagnostics: [diagnostic(1)] }),
    )
    expect(output).toContain('4 pre-existing (baseline @ abc1234, 2 commits behind HEAD')
  })

  test('warns that the intervening commits inflate the new count', () => {
    // Without this the reader attributes everything those commits introduced to
    // their own uncommitted work — the misreading that sends an agent to
    // `git stash`.
    const output = formatCheckResult(result({ baseline: inherited, preExistingCount: 4 }))
    expect(output).toContain('Anything the last 2 commits introduced counts as new here')
    expect(output).toContain('Check on a clean tree')
  })

  test('a matched baseline says none of that', () => {
    const output = formatCheckResult(result({ preExistingCount: 4 }))
    expect(output).toContain('baseline @ abc1234)')
    expect(output).not.toContain('behind HEAD')
    expect(output).not.toContain('counts as new here')
  })
})

describe('formatCheckResult — the size bound', () => {
  test('a large known backlog with nothing new stays a single short line', () => {
    // This is the guard the whole tool exists for. If this ever grows into a
    // listing, the tool costs more than the raw command it replaces.
    const output = formatCheckResult(
      result({ errors: 4623, preExistingCount: 4623, exitCode: 1 }),
    )
    expect(output.length).toBeLessThan(200)
    expect(output).toStartWith('✓')
    expect(output).toContain('4623 pre-existing')
    expect(output).not.toContain('✗')
  })

  test('caps the listing even with no baseline to filter against', () => {
    const diagnostics = Array.from({ length: 500 }, (_, i) => diagnostic(i))
    const output = formatCheckResult(
      result({
        errors: 500,
        newCount: 500,
        diagnostics,
        baseline: { kind: 'absent', reason: 'dirty-tree-no-baseline' },
        exitCode: 1,
      }),
    )
    expect(output.split('✗').length - 1).toBe(10)
    expect(output).toContain('+490 more distinct diagnostics')
  })
})

describe('formatCheckResult — the signal', () => {
  test('zero new against a known baseline is green but names the exit code', () => {
    // Green so the permanent backlog does not train the reader to ignore a
    // warning; the exit code is named so it never reads as "CI will pass".
    const output = formatCheckResult(
      result({ errors: 4623, preExistingCount: 4623, exitCode: 1 }),
    )
    expect(output).toContain("exit 1 is the project's known backlog")
  })

  test('a clean project with a clean exit says nothing about exit codes', () => {
    expect(formatCheckResult(result())).toBe('✓ tsc · 0 new · 0 pre-existing (baseline @ abc1234)')
  })

  test('new diagnostics warn and are listed with position and excerpt', () => {
    const one = { ...diagnostic(0), excerpt: '>  1 | const x: number = "a"' }
    const output = formatCheckResult(
      result({ errors: 1, newCount: 1, preExistingCount: 4623, diagnostics: [one], exitCode: 1 }),
    )
    expect(output).toStartWith('⚠')
    expect(output).toContain('1 new')
    expect(output).toContain('src/f0.ts:1:5 — TS2000: Problem number 0.')
    expect(output).toContain('const x: number = "a"')
  })

  test('an unbaselined run says so instead of claiming the diagnostics are new', () => {
    const output = formatCheckResult(
      result({
        errors: 2,
        newCount: 2,
        diagnostics: [diagnostic(0), diagnostic(1)],
        baseline: { kind: 'absent', reason: 'dirty-tree-no-baseline' },
        exitCode: 1,
      }),
    )
    expect(output).toContain('provenance unknown')
    expect(output).toContain('call again on a clean tree')
  })

  test('a capture that inherits errors from a commit says so', () => {
    // Otherwise committing broken code on a clean tree launders those errors
    // into the backlog and hides them permanently.
    const output = formatCheckResult(
      result({
        errors: 12,
        baseline: {
          kind: 'captured',
          sha: 'newsha0000',
          recordedCount: 12,
          introducedSincePrev: { count: 3, prevSha: 'oldsha1111' },
        },
        exitCode: 1,
      }),
    )
    expect(output).toContain('baseline recorded at newsha0')
    expect(output).toContain('3 of them are new since oldsha1')
  })

  test('reports progress when baselined diagnostics stop reproducing', () => {
    const output = formatCheckResult(result({ preExistingCount: 10, fixedCount: 2 }))
    expect(output).toContain('2 baselined diagnostics no longer reproduce')
  })

  test('a degraded run shows a raw tail rather than inventing counts', () => {
    const output = formatCheckResult(
      result({ degraded: true, errors: 3, exitCode: 2, stdoutTail: 'weird output' }),
    )
    expect(output).toContain('could not parse')
    expect(output).toContain('weird output')
  })

  test('a run error names the command', () => {
    const output = formatCheckResult(result({ runError: 'boom' }))
    expect(output).toContain('boom')
    expect(output).toContain('tsc --noEmit --pretty false')
  })
})

describe('formatCheckResult — discoverability', () => {
  test('names the other checkers present so the override is findable', () => {
    // The tool DESCRIPTION cannot mention them: it is shared prompt-cache text
    // and must not vary per project.
    const output = formatCheckResult(result({ alsoDetected: ['tsc', 'cargo', 'go'] }))
    expect(output).toContain('Also detected here: cargo, go')
    expect(output).toContain('checker:"cargo"')
  })

  test('groups repeated diagnostics into one entry with its other sites', () => {
    const head: Diagnostic = {
      ...diagnostic(0),
      otherSites: [
        { file: 'src/b.ts', line: 3 },
        { file: 'src/c.ts', line: 9 },
        { file: 'src/d.ts', line: 1 },
        { file: 'src/e.ts', line: 7 },
      ],
    }
    const output = formatCheckResult(
      result({ errors: 5, newCount: 5, diagnostics: [head], exitCode: 1 }),
    )
    expect(output).toContain('same diagnostic at src/b.ts:3, src/c.ts:9, src/d.ts:1 and 1 more')
  })
})
