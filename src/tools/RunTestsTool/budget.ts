import type { TestResult } from './types.js'

/**
 * Token-economy formatter. Turns a normalized TestResult into the model-facing
 * string, failures-first:
 *   - green run  → a single count line (no passing noise, no raw stdout)
 *   - failing run → the dossier (name → file:line → summary → excerpt → diff),
 *     capped to the first K failures with a `+N more` tail, each diff truncated.
 */

const MAX_FAILURES_SHOWN = 10
const MAX_DIFF_CHARS = 800
const MAX_DEGRADED_TAIL_CHARS = 1500

function countLine(r: TestResult): string {
  const parts = [`${r.passed} passed`]
  if (r.failed > 0) parts.push(`${r.failed} failed`)
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`)
  const dur = r.durationMs ? ` in ${(r.durationMs / 1000).toFixed(2)}s` : ''
  return `${parts.join(', ')} (${r.total} total)${dur}`
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}\n… (truncated)` : t
}

/**
 * A reporter `<error>` (as opposed to `<failure>`) means the case never ran —
 * pytest records an import/collection failure that way. When nothing passed AND
 * every entry is one of those, "N failed" is actively misleading: the suite did
 * not run, and the usual cause is the runner being invoked outside the
 * project's environment (a bare `pytest` against a uv/poetry venv). Say so, or
 * the reader debugs phantom test failures.
 */
function suiteNeverRan(r: TestResult): boolean {
  return r.passed === 0 && r.failures.length > 0 && r.failures.every(f => f.kind === 'error')
}

export function formatTestResult(r: TestResult): string {
  if (r.runError) {
    return `Test run could not start: ${r.runError}\ncommand: ${r.command}`
  }

  const header = `${r.framework} · ${countLine(r)}`

  if (r.failed === 0 && r.failures.length === 0) {
    if (r.exitCode === 0) return `✓ ${header}`
    // Assertions passed but the runner process failed (build/setup/teardown
    // error, crash, or a post-suite gate like coverage). Not a green run.
    return [
      `⚠ ${header} — but the runner exited ${r.exitCode} with no failing tests`,
      '(likely a build/setup/teardown error or a post-suite gate such as coverage).',
      r.stdoutTail ? `Raw tail:\n${truncate(r.stdoutTail, MAX_DEGRADED_TAIL_CHARS)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const shown = r.failures.slice(0, MAX_FAILURES_SHOWN)
  const blocks = shown.map(f => {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
    const lines = [`✗ ${f.name}${loc}`]
    if (f.summary && f.summary !== f.name) lines.push(`  ${f.summary}`)
    if (f.excerpt) lines.push(f.excerpt)
    if (f.diff && f.diff !== f.summary) {
      lines.push(truncate(f.diff, MAX_DIFF_CHARS))
    }
    return lines.join('\n')
  })

  const remaining = r.failed - shown.length
  const moreTail =
    remaining > 0 ? [`\n+${remaining} more failing test${remaining === 1 ? '' : 's'}`] : []

  const neverRanNote = suiteNeverRan(r)
    ? [
        'The suite never ran: every entry below is a collection/setup error, not a failing assertion.',
        "Check the runner ran inside the project's environment (e.g. `uv run pytest`, `poetry run pytest`)",
        'before treating these as test failures.',
      ].join(' ')
    : ''

  const degradedNote = r.degraded
    ? [
        '\nNote: no machine-readable reporter was available, so this summary was',
        'scraped from text output and may be incomplete. Raw tail:',
        truncate(`${r.stdoutTail ?? ''}`, MAX_DEGRADED_TAIL_CHARS),
      ].join('\n')
    : ''

  return [`✗ ${header}`, neverRanNote, '', ...blocks, ...moreTail, degradedNote]
    .filter(Boolean)
    .join('\n')
}
