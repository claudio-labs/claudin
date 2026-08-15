import { existsSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { logError } from 'src/shared/log.js'
import { exec } from 'src/shared/proc/Shell.js'
import { readFullShellOutput } from 'src/services/shell/fullOutput.js'
import { TaskOutput } from 'src/tasks/TaskOutput.js'
import { readSourceExcerpt } from 'src/tools/shared/sourceExcerpt.js'
import { tailLabel } from 'src/tools/shared/progressTail.js'
import { resolveBaseline, type BaselineMode } from 'src/tools/TypecheckTool/baseline.js'
import { fingerprintDiagnostic, normalizeDiagnosticPath } from 'src/tools/TypecheckTool/fingerprint.js'
import { parseCheckerOutput } from 'src/tools/TypecheckTool/parseChain.js'
import type { Checker, CheckProgress, CheckResult, Diagnostic, RawDiagnostic } from 'src/tools/TypecheckTool/types.js'

/**
 * Execution orchestrator: run the checker, read its FULL output, parse it,
 * classify each diagnostic against the recorded baseline, then attach source
 * excerpts and collapse duplicate messages.
 *
 * A non-zero exit is the normal shape of a failing check and is never treated
 * as a tool error.
 */

const STDOUT_TAIL_CHARS = 4000
/**
 * A timed-out command comes back as SIGTERM with `interrupted` FALSE (that flag
 * is only set for SIGKILL), so a kill has to be recognised by exit code. It
 * matters far beyond the wording of the message: a checker killed halfway
 * through printing has produced a PARTIAL diagnostic set, and recording that as
 * the project's baseline on a clean tree would mark every diagnostic it never
 * got to print as newly introduced on the next run.
 */
const SIGTERM_EXIT = 143
/**
 * Excerpts are read from disk, one file open per diagnostic. New diagnostics
 * are capped long before this, but a run with no baseline can legitimately have
 * thousands, and the formatter shows a handful — so bound the I/O to roughly
 * what can be displayed.
 */
const MAX_EXCERPTS = 20
/** MSBuild's own error codes — NETSDK1004 (no restore), MSB3073 (target failed). */
const MSBUILD_INFRA_CODE_RE = /^(?:NETSDK|MSB)\d+$/

export type RunOptions = {
  command: string
  checker: Checker
  cwd: string
  /**
   * See `DetectedChecker.toolchainDir`. Absent for a caller-supplied `command`,
   * where nothing knows whether a relative path in it is a borrowed binary or a
   * tracked wrapper — so such a run is left exactly as written, and a baseline
   * reconstruction that cannot find its checker is discarded rather than
   * guessed at.
   */
  toolchainDir?: string
  abortSignal: AbortSignal
  timeoutMs: number
  baselineMode: BaselineMode
  /** Display filter only — never narrows what is checked or baselined. */
  severity: 'errors' | 'all'
  /** One path, or several — a change touching N files needs ONE call, not N. */
  pathFilter?: string | string[]
  alsoDetected: Checker[]
  /** TUI only — never serialized, so it cannot affect what the model reads. */
  onProgress?: (progress: CheckProgress) => void
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text
}

/** POSIX single-quoting, so a path with spaces or quotes survives the shell. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function emptyResult(opts: RunOptions, runError: string, exitCode = 1): CheckResult {
  return {
    checker: opts.checker,
    command: opts.command,
    errors: 0,
    warnings: 0,
    newCount: 0,
    preExistingCount: 0,
    fixedCount: 0,
    diagnostics: [],
    baseline: { kind: 'absent', reason: 'ignored' },
    alsoDetected: opts.alsoDetected,
    degraded: true,
    exitCode,
    runError,
  }
}

/**
 * Collapse diagnostics that share a (code, message) pair into one entry with
 * its extra sites listed. One bad type signature produces the identical error
 * at every call site; showing forty copies of it costs forty excerpts and tells
 * the reader nothing the first one did not.
 *
 * This is grouping by identity, NOT root-cause analysis — the entry is still a
 * real diagnostic at a real position, just the first of its kind.
 */
function groupByIdentity(diagnostics: Diagnostic[]): Diagnostic[] {
  const grouped = new Map<string, Diagnostic>()
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code ?? ''}\u0000${diagnostic.message}`
    const head = grouped.get(key)
    if (!head) {
      grouped.set(key, diagnostic)
      continue
    }
    head.otherSites = [...(head.otherSites ?? []), { file: diagnostic.file, line: diagnostic.line }]
  }
  return [...grouped.values()]
}

function matchesPathFilter(file: string, filters: string[]): boolean {
  return filters.some(filter => {
    const normalized = filter.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
    return file === normalized || file.startsWith(`${normalized}/`)
  })
}

/**
 * One path or many, normalised to a list. An empty list means NO filter rather
 * than a filter matching nothing — `path: []` hiding every diagnostic would
 * render as a clean project, which is the exact failure `hiddenByPathFilter`
 * exists to prevent.
 */
function pathFilters(filter: string | string[] | undefined): string[] | undefined {
  const list = filter === undefined ? [] : Array.isArray(filter) ? filter : [filter]
  const kept = list.filter(entry => entry.trim() !== '')
  return kept.length > 0 ? kept : undefined
}

function attachExcerpts(diagnostics: Diagnostic[], cwd: string): void {
  let budget = MAX_EXCERPTS
  for (const diagnostic of diagnostics) {
    if (budget <= 0) return
    if (!diagnostic.file || diagnostic.line < 1) continue
    const abs = isAbsolute(diagnostic.file) ? diagnostic.file : resolve(cwd, diagnostic.file)
    if (!existsSync(abs)) continue
    const excerpt = readSourceExcerpt(abs, diagnostic.line)
    if (excerpt) {
      diagnostic.excerpt = excerpt
      budget--
    }
  }
}

/**
 * Re-point a project-local toolchain when the checker runs somewhere other than
 * the project itself — which happens exactly once, inside the checkout of HEAD
 * used to reconstruct a baseline.
 *
 * That checkout holds tracked sources and nothing else, so every project-local
 * binary (`node_modules/.bin/tsc`, `.venv/bin/mypy`, `vendor/bin/phpstan`) is
 * missing and the run exits 127. That is not a harmless failure: 127 prints no
 * diagnostics, no diagnostics reads as a CLEAN HEAD, and a clean HEAD is an
 * ACCEPTED baseline — the project's entire backlog would come back reported as
 * newly introduced.
 *
 * Only the toolchain is borrowed. Module resolution already works, because the
 * checkout is nested inside the project and lookups walk upwards into the real
 * tree. Symlinking the dependency directory into the checkout would cover the
 * same ground while leaving the user's real `node_modules` one `rm -rf` from
 * deletion.
 *
 * `dir` comes from detection rather than from a pattern match on the command,
 * because the two cannot be told apart here: `./gradlew` and `./mvnw` are
 * tracked files that DO exist in the checkout and must keep resolving there.
 */
function borrowToolchain(command: string, dir: string, projectRoot: string): string {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return command.replace(
    new RegExp(`(^|\\s)(?:\\./)?${escaped}/`, 'g'),
    `$1${join(projectRoot, dir)}/`,
  )
}

type ExecOutcome =
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; message: string; exitCode?: number }

/**
 * Run the checker in `dir` and read its full output.
 *
 * `dir` is a parameter rather than `opts.cwd` because baseline reconstruction
 * runs the identical command against a detached checkout of HEAD.
 *
 * `startedAt` is the whole CALL's clock, not this exec's, so the live counter
 * keeps climbing across the check and the reconstruction instead of restarting
 * halfway through.
 */
async function execChecker(
  opts: RunOptions,
  dir: string,
  startedAt: number,
): Promise<ExecOutcome> {
  const { abortSignal, timeoutMs } = opts
  const phase: CheckProgress['phase'] = dir === opts.cwd ? 'check' : 'baseline'
  // Only when checking somewhere other than the project itself; the main run
  // must execute exactly the command that was detected. The PATH entry covers
  // the `npm run <script>` shape, where the binary is resolved by the package
  // manager and never appears in the command text.
  const borrow = dir === opts.cwd ? undefined : opts.toolchainDir
  const command = borrow ? borrowToolchain(opts.command, borrow, opts.cwd) : opts.command
  const binPath = borrow ? `export PATH=${singleQuote(join(opts.cwd, borrow))}:"$PATH"\n` : ''

  // Three things happen in this wrapper, and each one is load-bearing.
  //
  // `cd` first: exec() has NO cwd option — it runs in the session's persistent
  // shell, which is not necessarily `opts.cwd`. They agree for a plain REPL
  // turn, but a sub-agent under a cwd override (worktree isolation) would
  // otherwise check the MAIN checkout and file the results under the
  // worktree's path. `&&` so a bad path fails instead of silently checking
  // whatever directory the shell happened to be in.
  //
  // The braces keep a compound `command` intact: `A=1 B=2 cmd` only composes
  // with a SIMPLE command, so `(cd sub && tsc)` died on a bash syntax error
  // before the checker ever ran. The command sits on its own line so a trailing
  // `;` in it cannot collide with the closing brace.
  //
  // CI=true stops checkers prompting or watching; NO_COLOR keeps ANSI escapes
  // out of the text parsers, which match on line shape.
  //
  // FORCE_COLOR is UNSET rather than set to 0: deno (and anything else that
  // tests only whether the variable is present) treats `FORCE_COLOR=0` as a
  // request to colourise, which defeats NO_COLOR and hands the parser escape
  // sequences. Unsetting also drops one inherited from the user's environment,
  // and every tool that reads it falls back to isatty — false here, since the
  // output is written to a file.
  const execCommand = `cd ${singleQuote(dir)} && {
export CI=true NO_COLOR=1
unset FORCE_COLOR
${binPath}${command}
}`

  // Captured so the `finally` can stop the poller even when `exec` throws after
  // the task was registered.
  let taskId: string | null = null
  try {
    const shellCommand = await exec(execCommand, abortSignal, 'bash', {
      timeout: timeoutMs,
      // The `cd` above is ours, not the user's — it must not move the session's
      // shell out from under the next Bash call.
      preventCwdChanges: true,
      // Purely a TUI signal, and `onProgress` rather than `onStdout`: the latter
      // pipes stdout instead of writing the file, which would break
      // `readFullShellOutput` below. Two things have to be true for a tick to
      // arrive and neither is automatic — the callback registers the task, and
      // `startPolling` is what drives it (see BuildTool/run.ts).
      onProgress: opts.onProgress
        ? (lastLines: string) =>
            opts.onProgress?.({
              type: 'check_progress',
              checker: opts.checker,
              phase,
              label: tailLabel(lastLines) ?? '',
              elapsedMs: Date.now() - startedAt,
            })
        : undefined,
    })
    taskId = shellCommand.taskOutput.taskId
    TaskOutput.startPolling(taskId)
    const result = await shellCommand.result
    if (result.interrupted) {
      return { ok: false, message: 'The check was interrupted before completing.' }
    }
    if (result.code === SIGTERM_EXIT) {
      return {
        ok: false,
        message: `The check did not finish within ${timeoutMs} ms and was terminated, so its output is partial and no baseline was recorded. Re-run with a larger \`timeout\`.`,
        exitCode: result.code,
      }
    }
    // NOT result.stdout: it is capped at BASH_MAX_OUTPUT_LENGTH, and a project
    // with a large backlog prints far more than that. Summarising from the
    // first 30 000 characters would record a baseline missing 90% of its
    // entries, and every later run would then report those as newly introduced.
    return {
      ok: true,
      stdout: await readFullShellOutput(result),
      stderr: result.stderr,
      exitCode: result.code,
    }
  } catch (e) {
    logError(`Typecheck: exec failed — ${String(e)}`)
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    if (taskId) TaskOutput.stopPolling(taskId)
  }
}

/**
 * Erase the temporary checkout from a reconstruction's output.
 *
 * Diagnostics quote absolute paths inside their MESSAGE as well as in their
 * file field ("Could not find a declaration file for module '/abs/x.js'"), so a
 * baseline built in a checkout of HEAD disagreed with the live run about 38 of
 * this repo's diagnostics — each one reported as newly introduced, and the one
 * it replaced reported as fixed, from an identical source tree.
 *
 * Done here, on the raw text, rather than inside the fingerprint: the checkout
 * is this module's implementation detail, and the checkout path CONTAINS the
 * project path, so a fingerprint-level substitution is not symmetric between
 * the two runs — messages naming the project's own `node_modules` would be
 * rewritten in one run and left alone in the other. Rewriting at the boundary
 * makes the reconstruction's output identical to what a live run would print.
 */
export function eraseCheckoutPath(text: string, from: string, to: string): string {
  return text.split(from).join(to)
}

/**
 * The fingerprints the checker produces in `dir`, or null if the run cannot be
 * trusted to describe it. Used to rebuild a baseline from a detached checkout
 * of HEAD, so every "cannot be trusted" case has to return null rather than an
 * empty list: a silent empty baseline would mark the whole backlog as newly
 * introduced.
 */
async function collectFingerprintsAt(
  opts: RunOptions,
  dir: string,
  startedAt: number,
): Promise<string[] | null> {
  const raw = await execChecker(opts, dir, startedAt)
  if (!raw.ok) return null
  const parsed = parseCheckerOutput(opts.checker, {
    stdout: eraseCheckoutPath(raw.stdout, dir, opts.cwd),
    stderr: eraseCheckoutPath(raw.stderr, dir, opts.cwd),
    exitCode: raw.exitCode,
  })
  if (parsed.degraded) return null
  if (parsed.diagnostics.some(d => d.code && MSBUILD_INFRA_CODE_RE.test(d.code))) return null
  return parsed.diagnostics.map(d =>
    fingerprintDiagnostic({ ...d, file: normalizeDiagnosticPath(d.file, opts.cwd) }, opts.cwd),
  )
}

export async function runTypecheck(opts: RunOptions): Promise<CheckResult> {
  const { checker, cwd } = opts
  const startedAt = Date.now()

  const raw = await execChecker(opts, cwd, startedAt)
  if (!raw.ok) return emptyResult(opts, raw.message, raw.exitCode)
  const { stdout, stderr, exitCode } = raw

  const parsed = parseCheckerOutput(checker, { stdout, stderr, exitCode })

  // MSBuild reports its OWN failures — a missing restore, a broken target — in
  // exactly the shape of a compiler diagnostic, positioned inside the .NET SDK.
  // Reporting one would be bad enough; baselining it is worse, since the next
  // run would then call a real error "pre-existing". Compilation never happened,
  // so there is nothing to compare: fail the run and say why.
  const infra = parsed.diagnostics.find(d => d.code && MSBUILD_INFRA_CODE_RE.test(d.code))
  if (infra) {
    return emptyResult(opts, `the build failed before type-checking — ${infra.code}: ${infra.message}`, exitCode)
  }

  // Normalise paths ONCE, before fingerprinting: a baseline recorded from
  // absolute paths would not match one recorded from relative ones.
  const normalized: RawDiagnostic[] = parsed.diagnostics.map(d => ({
    ...d,
    file: normalizeDiagnosticPath(d.file, cwd),
  }))

  // Baseline over EVERY diagnostic, including warnings the caller chose not to
  // see. Fingerprinting only the displayed subset would make the recorded set
  // depend on the `severity` argument, so flipping it once would report every
  // warning as newly introduced.
  const fingerprints = normalized.map(d => fingerprintDiagnostic(d, cwd))
  const baseline = await resolveBaseline({
    cwd,
    checker,
    mode: opts.baselineMode,
    fingerprints,
    // Withheld when our own parse failed: reconstruction is only meaningful as
    // a comparison against this run, and there is nothing to compare against.
    reconstruct: parsed.degraded ? undefined : dir => collectFingerprintsAt(opts, dir, startedAt),
  })

  const classified: Diagnostic[] = normalized.map((d, i) => ({
    ...d,
    source: 'typecheck',
    fingerprint: fingerprints[i]!,
    status: baseline.isNew[i] ? 'new' : 'preexisting',
  }))

  const bySeverity = classified.filter(d => opts.severity === 'all' || d.severity === 'error')
  const filters = pathFilters(opts.pathFilter)
  const visible = filters ? bySeverity.filter(d => matchesPathFilter(d.file, filters)) : bySeverity
  const shown = groupByIdentity(visible.filter(d => d.status === 'new'))
  attachExcerpts(shown, cwd)

  // Counted over the REPORTED scope, not everything parsed: a `path` filter that
  // matches nothing would otherwise print "4624 errors" above an empty list.
  // The baseline counts below describe the same scope, so the header and the
  // body always agree.
  const errors = visible.filter(d => d.severity === 'error').length
  const warnings = visible.length - errors

  return {
    checker,
    command: opts.command,
    errors: parsed.degraded ? (parsed.estimatedErrors ?? 0) : errors,
    warnings: parsed.degraded ? (parsed.estimatedWarnings ?? 0) : warnings,
    newCount: visible.filter(d => d.status === 'new').length,
    preExistingCount: visible.filter(d => d.status === 'preexisting').length,
    fixedCount: baseline.fixedCount,
    diagnostics: shown,
    baseline: baseline.state,
    alsoDetected: opts.alsoDetected,
    pathFilter: filters,
    hiddenByPathFilter: bySeverity.length - visible.length,
    captureRefused: baseline.captureRefused,
    durationMs: Date.now() - startedAt,
    degraded: parsed.degraded,
    exitCode,
    stdoutTail: parsed.degraded ? tail(`${stdout}\n${stderr}`.trim(), STDOUT_TAIL_CHARS) : undefined,
  }
}
