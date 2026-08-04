import type { CheckResult, Diagnostic } from './types.js'

/**
 * Token-economy formatter. Turns a CheckResult into the model-facing string,
 * new-diagnostics-first.
 *
 * The hard rule here is that the OUTPUT SIZE IS BOUNDED regardless of input.
 * The project this was built for carries roughly 4300 pre-existing tsc errors;
 * a formatter that could ever fall through to "print them all" would be worse
 * than the raw command it replaces. Pre-existing diagnostics are counted, never
 * listed, and even the unbaselined case is capped.
 */

const MAX_DIAGNOSTICS_SHOWN = 10
const MAX_MESSAGE_CHARS = 600
const MAX_SITES_SHOWN = 3
const MAX_DEGRADED_TAIL_CHARS = 1500
const SHORT_SHA_CHARS = 7

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}\n… (truncated)` : t
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_CHARS)
}

function position(d: Diagnostic): string {
  if (!d.file) return ''
  return d.line > 0 ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}` : d.file
}

function renderDiagnostic(d: Diagnostic): string {
  const where = position(d)
  const code = d.code ? `${d.code}: ` : ''
  const lines = [`✗ ${where ? `${where} — ` : ''}${code}${truncate(d.message, MAX_MESSAGE_CHARS)}`]
  if (d.excerpt) lines.push(d.excerpt)
  if (d.otherSites?.length) {
    const sites = d.otherSites.slice(0, MAX_SITES_SHOWN).map(s => `${s.file}:${s.line}`)
    const rest = d.otherSites.length - sites.length
    lines.push(
      `  same diagnostic at ${sites.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
    )
  }
  return lines.join('\n')
}

function renderList(result: CheckResult): string[] {
  const shown = result.diagnostics.slice(0, MAX_DIAGNOSTICS_SHOWN)
  const blocks = shown.map(renderDiagnostic)
  const remaining = result.diagnostics.length - shown.length
  if (remaining > 0) {
    blocks.push(`\n+${remaining} more distinct diagnostic${remaining === 1 ? '' : 's'}`)
  }
  return blocks
}

/**
 * A non-zero exit with zero new diagnostics is the NORMAL state of a project
 * with a known backlog, so it must not read as a fresh problem — but it must
 * also never read as "CI will pass". Naming the exit code and calling it the
 * project's known backlog does both.
 */
function exitNote(result: CheckResult): string {
  return result.exitCode === 0
    ? ''
    : `; exit ${result.exitCode} is the project's known backlog`
}

function alsoDetectedNote(result: CheckResult): string {
  const others = result.alsoDetected.filter(c => c !== result.checker)
  if (others.length === 0) return ''
  return `Also detected here: ${others.join(', ')} — pass checker:"${others[0]}" to run one of those instead.`
}

/**
 * A `path` filter scopes the counts, so without this line a filter matching
 * nothing renders as `✓ 0 new · 0 pre-existing` in a project with thousands of
 * errors elsewhere — true of the scope asked for, and read as "project clean".
 */
function pathFilterNote(result: CheckResult): string {
  const hidden = result.hiddenByPathFilter ?? 0
  const scope = result.pathFilter ?? []
  if (scope.length === 0 || hidden === 0) return ''
  return `Scoped to ${scope.join(', ')}: ${hidden} diagnostic${hidden === 1 ? '' : 's'} elsewhere in the project ${hidden === 1 ? 'is' : 'are'} not counted here.`
}

function fixedNote(result: CheckResult): string {
  return result.fixedCount > 0
    ? `${result.fixedCount} baselined diagnostic${result.fixedCount === 1 ? '' : 's'} no longer reproduce${result.fixedCount === 1 ? 's' : ''}.`
    : ''
}

/**
 * The caller asked to re-record the backlog and did not get it. Staying silent
 * would leave it believing its own uncommitted breakage is now "known", which
 * is the state this refusal exists to prevent.
 */
function captureRefusedNote(result: CheckResult): string {
  return result.captureRefused
    ? 'baseline: "capture" was ignored — the working tree has uncommitted changes, and recording now would file the errors in that uncommitted work under this commit and call them pre-existing from then on. Commit first, then capture.'
    : ''
}

/**
 * An inherited baseline predates the commits between it and HEAD, so anything
 * those commits introduced is missing from it and lands in the "new" column.
 * Without this line a long gap reads as though the uncommitted work caused all
 * of it, which is the misreading that sends an agent to `git stash`.
 */
function staleBaselineNote(inherited: { sha: string; behind: number } | null): string {
  if (!inherited || inherited.behind === 0) return ''
  const commits = inherited.behind === 1 ? 'commit' : `${inherited.behind} commits`
  return `No baseline for HEAD (the tree has uncommitted changes), so this is measured against ${shortSha(inherited.sha)}. Anything the last ${commits} introduced counts as new here. Check on a clean tree to record a baseline for HEAD.`
}

function unknownProvenanceReason(result: CheckResult): string {
  if (result.baseline.kind !== 'absent') return ''
  switch (result.baseline.reason) {
    case 'ignored':
      return 'baseline ignored by request'
    case 'not-a-git-repo':
      return 'not a git repository, so no baseline can be recorded'
    case 'dirty-tree-no-baseline':
      return 'no baseline recorded for this commit and the working tree has uncommitted changes, so which of these you introduced cannot be determined — call again on a clean tree to record one'
  }
}

/**
 * Said once, on the run that paid for it. The reader is owed the reason its
 * check took twice as long, and the reassurance that the extra checkout was not
 * its own working tree.
 */
function reconstructedNote(result: CheckResult): string {
  if (result.baseline.kind !== 'reconstructed') return ''
  const { recordedCount } = result.baseline
  return `No baseline existed and the tree is dirty, so HEAD was checked out to a temporary worktree and re-checked: ${recordedCount} diagnostic${recordedCount === 1 ? '' : 's'} recorded as the backlog. Your working tree was not touched.`
}

export function formatCheckResult(result: CheckResult): string {
  if (result.runError) {
    return `Typecheck could not run: ${result.runError}${result.command ? `\ncommand: ${result.command}` : ''}`
  }

  const counts = `${result.errors} error${result.errors === 1 ? '' : 's'}${
    result.warnings > 0 ? `, ${result.warnings} warnings` : ''
  }`

  if (result.degraded) {
    return [
      `⚠ ${result.checker} · could not parse the checker's output; ~${counts} scraped from text (exit ${result.exitCode})`,
      result.stdoutTail ? `Raw tail:\n${truncate(result.stdoutTail, MAX_DEGRADED_TAIL_CHARS)}` : '',
      alsoDetectedNote(result),
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (result.baseline.kind === 'absent') {
    if (result.errors === 0 && result.warnings === 0) {
      return [
        `✓ ${result.checker} · no diagnostics`,
        captureRefusedNote(result),
        pathFilterNote(result),
        alsoDetectedNote(result),
      ]
        .filter(Boolean)
        .join('\n')
    }
    return [
      `⚠ ${result.checker} · ${counts}, provenance unknown (${unknownProvenanceReason(result)})`,
      captureRefusedNote(result),
      '',
      ...renderList(result),
      pathFilterNote(result),
      alsoDetectedNote(result),
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (result.baseline.kind === 'captured') {
    const { sha, recordedCount, introducedSincePrev } = result.baseline
    // recordedCount, not `counts`: capture records every diagnostic, including
    // warnings the caller filtered out and files outside a `path` scope. The
    // visible number here would understate what was just made permanent.
    const header =
      recordedCount === 0
        ? `✓ ${result.checker} · no diagnostics · baseline recorded at ${shortSha(sha)}`
        : `✓ ${result.checker} · baseline recorded at ${shortSha(sha)}: ${recordedCount} diagnostic${recordedCount === 1 ? '' : 's'} treated as this project's known backlog from now on`
    const laundered = !introducedSincePrev
      ? ''
      : introducedSincePrev.prevSha === sha
        ? `⚠ ${introducedSincePrev.count} of them were absent from the previous baseline at this same commit — the source did not move, so a toolchain or config change produced them, and they are now part of the backlog.`
        : `⚠ ${introducedSincePrev.count} of them are new since ${shortSha(introducedSincePrev.prevSha)} — they were introduced by a commit, not by uncommitted work, and are now part of the backlog.`
    return [header, laundered, pathFilterNote(result), alsoDetectedNote(result)]
      .filter(Boolean)
      .join('\n')
  }

  const { sha } = result.baseline
  const inherited = result.baseline.kind === 'inherited' ? result.baseline : null
  const provenance = inherited
    ? `baseline @ ${shortSha(sha)}, ${inherited.behind} commit${inherited.behind === 1 ? '' : 's'} behind HEAD`
    : `baseline @ ${shortSha(sha)}`
  const backlog = `${result.preExistingCount} pre-existing (${provenance}${exitNote(result)})`

  if (result.newCount === 0) {
    return [
      `✓ ${result.checker} · 0 new · ${backlog}`,
      fixedNote(result),
      captureRefusedNote(result),
      reconstructedNote(result),
      staleBaselineNote(inherited),
      pathFilterNote(result),
      alsoDetectedNote(result),
    ]
      .filter(Boolean)
      .join('\n')
  }

  return [
    `⚠ ${result.checker} · ${result.newCount} new · ${backlog}`,
    fixedNote(result),
    captureRefusedNote(result),
    reconstructedNote(result),
    staleBaselineNote(inherited),
    '',
    ...renderList(result),
    pathFilterNote(result),
    alsoDetectedNote(result),
  ]
    .filter(Boolean)
    .join('\n')
}
