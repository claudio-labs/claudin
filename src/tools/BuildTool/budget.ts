import type { BuildDiagnostic, BuildResult, StallReport } from 'src/tools/BuildTool/types.js'

/**
 * Token-economy formatter. Turns a BuildResult into the model-facing string,
 * failures first.
 *
 * The hard rule is that the OUTPUT SIZE IS BOUNDED regardless of input. A cold
 * Gradle or CMake build prints thousands of lines, and a formatter that could
 * ever fall through to "print them all" would be worse than the raw command it
 * replaces.
 */

const MAX_DIAGNOSTICS_SHOWN = 10
const MAX_MESSAGE_CHARS = 600
const MAX_SITES_SHOWN = 3
const MAX_FAILURE_BLOCK_CHARS = 2000
const MAX_DEGRADED_TAIL_CHARS = 1500
const MAX_ARTIFACTS_SHOWN = 5

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}\n… (truncated)` : t
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

function position(d: BuildDiagnostic): string {
  if (!d.file) return ''
  return d.line > 0 ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}` : d.file
}

function renderDiagnostic(d: BuildDiagnostic): string {
  const where = position(d)
  const code = d.code ? `${d.code}: ` : ''
  const lines = [`✗ ${where ? `${where} — ` : ''}${code}${truncate(d.message, MAX_MESSAGE_CHARS)}`]
  if (d.excerpt) lines.push(d.excerpt)
  if (d.otherSites?.length) {
    const sites = d.otherSites.slice(0, MAX_SITES_SHOWN).map(s => `${s.file}:${s.line}`)
    const rest = d.otherSites.length - sites.length
    lines.push(`  same diagnostic at ${sites.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`)
  }
  return lines.join('\n')
}

function renderList(result: BuildResult): string[] {
  const shown = result.diagnostics.slice(0, MAX_DIAGNOSTICS_SHOWN)
  const blocks = shown.map(renderDiagnostic)
  const remaining = result.diagnostics.length - shown.length
  if (remaining > 0) {
    blocks.push(`\n+${remaining} more distinct diagnostic${remaining === 1 ? '' : 's'}`)
  }
  return blocks
}

function counts(result: BuildResult): string {
  const parts = [`${result.errors} error${result.errors === 1 ? '' : 's'}`]
  if (result.warnings > 0) parts.push(`${result.warnings} warnings`)
  return parts.join(', ')
}

/**
 * Warnings are counted even when they are not listed, so the reader knows they
 * exist and how to see them — a CI running `-D warnings` fails on exactly the
 * lines this tool would otherwise have hidden without a word.
 */
function warningNote(result: BuildResult): string {
  const listed = result.diagnostics.some(d => d.severity === 'warning')
  if (result.warnings === 0 || listed) return ''
  return `${result.warnings} warning${result.warnings === 1 ? '' : 's'} not listed — pass severity:"all" to see them.`
}

function artifactNote(result: BuildResult): string {
  if (result.artifacts.length === 0) return ''
  const shown = result.artifacts.slice(0, MAX_ARTIFACTS_SHOWN)
  const rest = result.artifacts.length - shown.length
  return `Produced ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
}

/**
 * What the build was doing when it was stopped — stated as observations.
 *
 * Deliberately not "the build is stuck": linking a large binary, a cold Gradle
 * daemon and a javac pass over a big module are all legitimately silent for
 * minutes. The reader is given how long it ran, how long it had been quiet and
 * the last thing it said, which is what actually identifies the phase.
 */
function stallNote(stall: StallReport): string {
  const where = stall.lastLine ? ` Last output: ${truncate(stall.lastLine, 200)}` : ''
  if (stall.reason === 'idle') {
    return `Stopped after ${formatDuration(stall.ranMs)} with no output for the last ${formatDuration(stall.silentMs)}. That is silence, not proof of a hang — linking and a cold daemon are both quiet for a long time.${where} Raise idleTimeout to wait longer.`
  }
  return `Stopped at the ${formatDuration(stall.ranMs)} ceiling while it was still running.${where} Raise timeout to wait longer.`
}

function alsoDetectedNote(result: BuildResult): string {
  const others = result.alsoDetected.filter(s => s !== result.system)
  if (others.length === 0) return ''
  return `Also configured here: ${others.join(', ')} — pass system:"${others[0]}" to build one of those instead.`
}

/**
 * A `path` filter scopes the counts, so without this line a filter matching
 * nothing renders as a clean build in a project that is failing elsewhere.
 */
function pathFilterNote(result: BuildResult): string {
  const hidden = result.hiddenByPathFilter ?? 0
  const scope = result.pathFilter ?? []
  if (scope.length === 0 || hidden === 0) return ''
  return `Scoped to ${scope.join(', ')}: ${hidden} diagnostic${hidden === 1 ? '' : 's'} elsewhere in the project ${hidden === 1 ? 'is' : 'are'} not counted here.`
}

function failureBlockNote(result: BuildResult): string {
  return result.failureBlock ? `Why it failed:\n${truncate(result.failureBlock, MAX_FAILURE_BLOCK_CHARS)}` : ''
}

export function formatBuildResult(result: BuildResult): string {
  if (result.runError) {
    return `Build could not run: ${result.runError}${result.command ? `\ncommand: ${result.command}` : ''}`
  }

  const took = formatDuration(result.durationMs)

  if (result.stall) {
    return [
      `⚠ ${result.system} · stopped before finishing`,
      stallNote(result.stall),
      ...(result.diagnostics.length > 0 ? ['', ...renderList(result)] : []),
      failureBlockNote(result),
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (result.degraded) {
    return [
      `⚠ ${result.system} · could not parse the build output; ~${counts(result)} scraped from text (exit ${result.exitCode})`,
      failureBlockNote(result),
      result.stdoutTail ? `Raw tail:\n${truncate(result.stdoutTail, MAX_DEGRADED_TAIL_CHARS)}` : '',
      alsoDetectedNote(result),
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (result.exitCode === 0) {
    // The up-to-date case must not read as a clean build: nothing was compiled,
    // so there are no warnings and no artifacts BECAUSE there was no work, not
    // because the code is clean.
    const header = result.upToDate
      ? `✓ ${result.system} · up to date, nothing rebuilt${took ? ` (${took})` : ''}`
      : // "succeeded", not "built": the tool runs whatever command it is given,
        // and `make lint` or a codegen target compiles nothing. It also pairs
        // with the failing header below, which already reads "build failed".
        `✓ ${result.system} · build succeeded${took ? ` in ${took}` : ''}`
    return [
      header,
      result.upToDate ? '' : artifactNote(result),
      result.upToDate ? '' : warningNote(result),
      result.upToDate
        ? ''
        : result.diagnostics.length > 0
          ? ['', ...renderList(result)].join('\n')
          : '',
      pathFilterNote(result),
      alsoDetectedNote(result),
    ]
      .filter(Boolean)
      .join('\n')
  }

  return [
    `✗ ${result.system} · build failed${took ? ` after ${took}` : ''} · ${counts(result)} · exit ${result.exitCode}`,
    warningNote(result),
    ...(result.diagnostics.length > 0 ? ['', ...renderList(result)] : []),
    failureBlockNote(result),
    pathFilterNote(result),
    alsoDetectedNote(result),
  ]
    .filter(Boolean)
    .join('\n')
}
