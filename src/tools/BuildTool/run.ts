import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { parseDiagnostics } from 'src/tools/shared/diagnostics/index.js'
import { readSourceExcerpt } from 'src/tools/shared/sourceExcerpt.js'
import { logError } from 'src/shared/log.js'
import { exec } from 'src/shared/proc/Shell.js'
import { readFullShellOutput } from 'src/platform/shell/fullOutput.js'
import { TaskOutput } from 'src/agent/tasks/TaskOutput.js'
import { extractFailureBlock } from 'src/tools/BuildTool/failureBlock.js'
import { isUpToDate } from 'src/tools/BuildTool/noOp.js'
import { parsersFor } from 'src/tools/BuildTool/parseChain.js'
import { lastNonEmptyLine, progressLabel } from 'src/tools/BuildTool/progressLine.js'
import type {
  BuildDiagnostic,
  BuildProgress,
  BuildResult,
  BuildSystem,
  StallReport,
} from 'src/tools/BuildTool/types.js'

/**
 * Execution orchestrator: run the build, watch it for silence, read its FULL
 * output, parse it, and attach source excerpts.
 *
 * A non-zero exit is the normal shape of a failing build and is never treated
 * as a tool error.
 */

const STDOUT_TAIL_CHARS = 4000
/** SIGTERM comes back with `interrupted` FALSE — that flag is only set for SIGKILL. */
const SIGTERM_EXIT = 143
/** Bounded because a build with no baseline can legitimately have thousands. */
const MAX_EXCERPTS = 20
/**
 * How long the output must be frozen before the live label says so. Below this
 * every build would flicker into "silent" between two ordinary lines.
 */
const SILENT_LABEL_MS = 10_000

export type RunOptions = {
  command: string
  system: BuildSystem
  cwd: string
  abortSignal: AbortSignal
  /** Wall ceiling: the build is stopped at this point however busy it is. */
  timeoutMs: number
  /** Idle threshold: the build is stopped after this long with no new output. */
  idleTimeoutMs: number
  /** Display filter only — never narrows what is built. */
  severity: 'errors' | 'all'
  pathFilter?: string | string[]
  alsoDetected: BuildSystem[]
  /** TUI only — never serialized, so it cannot affect what the model reads. */
  onProgress?: (progress: BuildProgress) => void
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text
}

/** POSIX single-quoting, so a path with spaces or quotes survives the shell. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Collapse the carriage-return rewrites a progress bar leaves behind.
 *
 * cargo, gradle and ninja all redraw one line hundreds of times with `\r`. Read
 * as text that is a single line megabytes long, which defeats every line-shaped
 * parser downstream and makes the degraded tail useless. Keeping only the final
 * segment of each line is exactly what a terminal would have shown.
 */
export function stripProgressRewrites(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map(line => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n')
}

/**
 * Artifacts the toolchain named itself. Only cargo does — its JSON message
 * stream carries a `compiler-artifact` event with the executable it linked.
 *
 * Nothing here looks at the filesystem. A binary left by an earlier run is
 * indistinguishable from one this run produced, and reporting a stale file as
 * freshly built would misinform the caller about the one thing they ran a build
 * to establish.
 */
export function collectArtifacts(system: BuildSystem, text: string): string[] {
  if (system !== 'cargo') return []
  const artifacts: string[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"compiler-artifact"')) continue
    try {
      const event: unknown = JSON.parse(line)
      if (typeof event !== 'object' || event === null) continue
      const executable = (event as { executable?: unknown }).executable
      if (typeof executable === 'string' && executable !== '' && !artifacts.includes(executable)) {
        artifacts.push(executable)
      }
    } catch {
      // A truncated JSON line is not a build failure — skip it.
    }
  }
  return artifacts
}

/**
 * Collapse diagnostics that share a (code, message) pair into one entry with
 * its extra sites listed. One bad signature produces the identical error at
 * every call site; showing forty copies costs forty excerpts and tells the
 * reader nothing the first one did not.
 */
function groupByIdentity(diagnostics: BuildDiagnostic[]): BuildDiagnostic[] {
  const grouped = new Map<string, BuildDiagnostic>()
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
 * render as a clean build.
 */
function pathFilters(filter: string | string[] | undefined): string[] | undefined {
  const list = filter === undefined ? [] : Array.isArray(filter) ? filter : [filter]
  const kept = list.filter(entry => entry.trim() !== '')
  return kept.length > 0 ? kept : undefined
}

function attachExcerpts(diagnostics: BuildDiagnostic[], cwd: string): void {
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

function emptyResult(opts: RunOptions, runError: string, exitCode = 1): BuildResult {
  return {
    system: opts.system,
    command: opts.command,
    upToDate: false,
    errors: 0,
    warnings: 0,
    diagnostics: [],
    artifacts: [],
    alsoDetected: opts.alsoDetected,
    degraded: true,
    exitCode,
    runError,
  }
}

type ExecOutcome =
  | { ok: true; text: string; exitCode: number; stall?: StallReport }
  | { ok: false; message: string; exitCode?: number }

/**
 * Run the build and watch it for silence.
 *
 * Both jobs — the idle watchdog and the live progress label — ride
 * `ExecOptions.onProgress`, which the shared `TaskOutput` poller drives once a
 * second. Two things have to be true for a tick to arrive, and neither is
 * automatic: the callback must be passed to `exec` (that is what registers the
 * task, `TaskOutput.ts:72`) and `startPolling` must be called (`:81`). Nothing
 * else starts it — despite the comment there, it has no React caller, and its
 * interval is `unref()`d, so this works headless and with the tool block
 * collapsed just as well.
 *
 * `onProgress` and not `onStdout` (`Shell.ts:170`): the latter pipes stdout
 * instead of writing the file, which would break `readFullShellOutput` below.
 *
 * The wall ceiling is left to `exec`'s own timeout, which arrives as SIGTERM.
 */
async function execBuild(opts: RunOptions): Promise<ExecOutcome> {
  const { abortSignal, timeoutMs, idleTimeoutMs } = opts

  // Three things happen in this wrapper, and each one is load-bearing.
  //
  // `cd` first: exec() has NO cwd option — it runs in the session's persistent
  // shell, which is not necessarily `opts.cwd`. They agree for a plain REPL
  // turn, but a sub-agent under a cwd override (worktree isolation) would
  // otherwise build the MAIN checkout. `&&` so a bad path fails instead of
  // silently building whatever directory the shell happened to be in.
  //
  // The braces keep a compound `command` intact: `A=1 B=2 cmd` only composes
  // with a SIMPLE command, so `(cd sub && make)` would die on a bash syntax
  // error before the build ever ran.
  //
  // CI=true stops build tools prompting, animating or watching; NO_COLOR keeps
  // ANSI escapes out of the text parsers, which match on line shape.
  // FORCE_COLOR is UNSET rather than set to 0, because anything testing only
  // for the variable's PRESENCE reads `FORCE_COLOR=0` as a request to
  // colourise.
  const execCommand = `cd ${singleQuote(opts.cwd)} && {
export CI=true NO_COLOR=1
unset FORCE_COLOR
${opts.command}
}`

  const internal = new AbortController()
  const forwardAbort = () => internal.abort()
  if (abortSignal.aborted) internal.abort()
  else abortSignal.addEventListener('abort', forwardAbort, { once: true })

  const startedAt = Date.now()
  let idleStall: { silentMs: number } | null = null
  let lastBytes = -1
  let lastChangeAt = Date.now()
  // Captured so the `finally` can stop the poller even when `exec` throws
  // after the task was registered.
  let taskId: string | null = null

  try {
    // Fires ~1s apart, and fires even when the file has not grown — that empty
    // tick is what lets a silent build be noticed at all (`TaskOutput.ts:122`).
    const onTick = (lastLines: string, _all: string, _lines: number, totalBytes: number) => {
      const now = Date.now()
      if (totalBytes !== lastBytes) {
        lastBytes = totalBytes
        lastChangeAt = now
      }
      const silentMs = now - lastChangeAt
      if (silentMs >= idleTimeoutMs) {
        idleStall = { silentMs }
        internal.abort()
        return
      }
      if (!opts.onProgress) return
      const tail = stripProgressRewrites(lastLines)
      opts.onProgress({
        type: 'build_progress',
        system: opts.system,
        label:
          silentMs >= SILENT_LABEL_MS
            ? `silent for ${Math.round(silentMs / 1000)}s`
            : (progressLabel(opts.system, tail) ?? ''),
        elapsedMs: now - startedAt,
        silentMs,
        totalBytes,
      })
    }

    const shellCommand = await exec(execCommand, internal.signal, 'bash', {
      timeout: timeoutMs,
      // The `cd` above is ours, not the user's — it must not move the session's
      // shell out from under the next Bash call.
      preventCwdChanges: true,
      onProgress: onTick,
    })

    taskId = shellCommand.taskOutput.taskId
    TaskOutput.startPolling(taskId)

    const result = await shellCommand.result
    // NOT result.stdout: it is capped at BASH_MAX_OUTPUT_LENGTH, and a build
    // prints far more than that. In file mode stderr is interleaved into the
    // same file, so this text is the whole log.
    const text = stripProgressRewrites(await readFullShellOutput(result))
    const ranMs = Date.now() - startedAt

    if (idleStall) {
      const stall: StallReport = {
        reason: 'idle',
        ranMs,
        silentMs: (idleStall as { silentMs: number }).silentMs,
        lastLine: lastNonEmptyLine(text),
      }
      return { ok: true, text, exitCode: result.code, stall }
    }

    if (result.interrupted) {
      return { ok: false, message: 'The build was interrupted before completing.' }
    }

    if (result.code === SIGTERM_EXIT) {
      const stall: StallReport = {
        reason: 'ceiling',
        ranMs,
        silentMs: 0,
        lastLine: lastNonEmptyLine(text),
      }
      return { ok: true, text, exitCode: result.code, stall }
    }

    return { ok: true, text, exitCode: result.code }
  } catch (e) {
    logError(`Build: exec failed — ${String(e)}`)
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    if (taskId) TaskOutput.stopPolling(taskId)
    abortSignal.removeEventListener('abort', forwardAbort)
  }
}

export async function runBuild(opts: RunOptions): Promise<BuildResult> {
  const { system, cwd } = opts
  const startedAt = Date.now()

  const raw = await execBuild(opts)
  if (!raw.ok) return emptyResult(opts, raw.message, raw.exitCode)
  const { text, exitCode, stall } = raw

  const parsed = parseDiagnostics(parsersFor(system), { stdout: text, stderr: '', exitCode })

  const all: BuildDiagnostic[] = parsed.diagnostics.map(d => ({ ...d }))
  const bySeverity = all.filter(d => opts.severity === 'all' || d.severity === 'error')
  const filters = pathFilters(opts.pathFilter)
  const visible = filters ? bySeverity.filter(d => matchesPathFilter(d.file, filters)) : bySeverity
  const shown = groupByIdentity(visible)
  attachExcerpts(shown, cwd)

  const errors = visible.filter(d => d.severity === 'error').length
  const warnings = visible.length - errors
  const failed = exitCode !== 0

  return {
    system,
    command: opts.command,
    upToDate: isUpToDate(system, text, exitCode),
    errors: parsed.degraded ? (parsed.estimatedErrors ?? 0) : errors,
    // Warnings are counted over EVERY parsed diagnostic, not the filtered view,
    // so `severity:"errors"` still reports how many there were.
    warnings: parsed.degraded
      ? (parsed.estimatedWarnings ?? 0)
      : opts.severity === 'all'
        ? warnings
        : all.filter(d => d.severity === 'warning').length,
    diagnostics: shown,
    artifacts: collectArtifacts(system, text),
    // Only for a failing build: a successful one has nothing to explain, and
    // the anchors would happily match a warning that says "error" in passing.
    failureBlock: failed ? extractFailureBlock(system, text) : undefined,
    alsoDetected: opts.alsoDetected,
    pathFilter: filters,
    hiddenByPathFilter: bySeverity.length - visible.length,
    durationMs: Date.now() - startedAt,
    degraded: parsed.degraded,
    exitCode,
    stall,
    stdoutTail: parsed.degraded ? tail(text.trim(), STDOUT_TAIL_CHARS) : undefined,
  }
}
