import { describe, expect, test } from 'bun:test'
import { formatBuildResult, formatDuration } from './budget.js'
import type { BuildDiagnostic, BuildResult } from './types.js'

function diagnostic(overrides: Partial<BuildDiagnostic> = {}): BuildDiagnostic {
  return {
    file: 'src/main.rs',
    line: 4,
    column: 9,
    severity: 'error',
    message: 'mismatched types',
    ...overrides,
  }
}

function result(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    system: 'cargo',
    command: 'cargo build --message-format=json',
    upToDate: false,
    errors: 0,
    warnings: 0,
    diagnostics: [],
    artifacts: [],
    alsoDetected: [],
    degraded: false,
    exitCode: 0,
    durationMs: 12_300,
    ...overrides,
  }
}

describe('formatDuration', () => {
  test.each([
    [412, '412ms'],
    [12_300, '12.3s'],
    [134_000, '2m14s'],
  ])('%d ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe('formatBuildResult', () => {
  test('a successful build names its duration and what it produced', () => {
    const rendered = formatBuildResult(result({ artifacts: ['/p/target/debug/app'] }))
    expect(rendered).toStartWith('✓ cargo · built in 12.3s')
    expect(rendered).toContain('Produced /p/target/debug/app')
  })

  test('an up-to-date build claims nothing about warnings or artifacts', () => {
    // A cached run recompiles nothing, so it emits no warnings and links no
    // artifact BECAUSE there was no work — reporting either as a result of this
    // build would be a claim about a compilation that never happened.
    const rendered = formatBuildResult(
      result({ upToDate: true, warnings: 7, artifacts: ['/p/target/debug/app'] }),
    )
    expect(rendered).toContain('up to date, nothing rebuilt')
    expect(rendered).not.toContain('warning')
    expect(rendered).not.toContain('Produced')
  })

  test('warnings are counted even when they are not listed', () => {
    const rendered = formatBuildResult(result({ warnings: 12 }))
    expect(rendered).toContain('12 warnings not listed')
    expect(rendered).toContain('severity:"all"')
  })

  test('the diagnostic list is bounded however many there are', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      diagnostic({ line: i + 1, message: `error number ${i}` }),
    )
    const rendered = formatBuildResult(
      result({ exitCode: 1, errors: 50, diagnostics: many }),
    )
    expect(rendered.split('✗ src/main.rs')).toHaveLength(11)
    expect(rendered).toContain('+40 more distinct diagnostics')
  })

  test('a failure with no diagnostics still explains itself', () => {
    const rendered = formatBuildResult(
      result({
        system: 'gradle',
        exitCode: 1,
        failureBlock: 'FAILURE: Build failed with an exception.\n> Could not find com:missing:1.0.',
      }),
    )
    expect(rendered).toStartWith('✗ gradle · build failed')
    expect(rendered).toContain('Why it failed:')
    expect(rendered).toContain('Could not find com:missing:1.0.')
  })

  test('a stall is reported as an observation, not as a diagnosis', () => {
    const rendered = formatBuildResult(
      result({
        stall: {
          reason: 'idle',
          ranMs: 200_000,
          silentMs: 180_000,
          lastLine: '> Task :app:compileKotlin',
        },
      }),
    )
    expect(rendered).toContain('no output for the last 3m00s')
    expect(rendered).toContain('That is silence, not proof of a hang')
    expect(rendered).toContain('> Task :app:compileKotlin')
    expect(rendered).not.toContain('stuck')
  })

  test('a path filter that hides everything cannot read as a clean build', () => {
    const rendered = formatBuildResult(
      result({ pathFilter: ['src/other'], hiddenByPathFilter: 31 }),
    )
    expect(rendered).toContain('31 diagnostics elsewhere in the project are not counted here')
  })

  test('a degraded run says so and hands back a bounded tail', () => {
    const rendered = formatBuildResult(
      result({ degraded: true, exitCode: 2, errors: 3, stdoutTail: 'x'.repeat(9000) }),
    )
    expect(rendered).toStartWith('⚠ cargo · could not parse the build output')
    expect(rendered).toContain('… (truncated)')
    expect(rendered.length).toBeLessThan(2000)
  })

  test('names the other systems configured here so the override is discoverable', () => {
    const rendered = formatBuildResult(result({ alsoDetected: ['cargo', 'go', 'make'] }))
    expect(rendered).toContain('Also configured here: go, make')
    expect(rendered).toContain('system:"go"')
  })
})
