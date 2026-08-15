import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import * as path from 'path'
import { exec } from 'src/utils/proc/Shell.js'
import { logError } from 'src/utils/log.js'
import { readFullShellOutput } from 'src/services/shell/fullOutput.js'
import { TaskOutput } from 'src/tasks/TaskOutput.js'
import { tailLabel } from 'src/tools/shared/progressTail.js'
import { buildDossier } from 'src/tools/RunTestsTool/dossier.js'
import { parseTestOutput } from 'src/tools/RunTestsTool/parsers/index.js'
import { hasWatchFlag, planReporter } from 'src/tools/RunTestsTool/reporters.js'
import { enrichFailuresWithStackLocation, refineFailureLinesFromStdout } from 'src/tools/RunTestsTool/stackTrace.js'
import type { Framework, ParseInput, TestProgress, TestResult } from 'src/tools/RunTestsTool/types.js'

/**
 * Execution orchestrator: strip watch flags, inject a reporter, run the command
 * via the shared shell `exec`, read any reporter file, parse → enrich → dossier.
 * A non-zero exit is normal for a failing suite and never treated as an error.
 */

const WATCH_STRIP_RE = /(?:^|\s)(?:--watch(?:All)?|-w|--ui|--watch-path)\b/g
const STDOUT_TAIL_CHARS = 4000

export type RunOptions = {
  command: string
  framework: Framework
  cwd: string
  abortSignal: AbortSignal
  timeoutMs: number
  /** TUI only — never serialized, so it cannot affect what the model reads. */
  onProgress?: (progress: TestProgress) => void
}

function readReportFile(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined
    return readFileSync(file, 'utf8')
  } catch (e) {
    logError(`RunTests: failed to read report file ${file} — ${String(e)}`)
    return undefined
  }
}

export function readReportDir(cwd: string, dir: string, minMtimeMs = 0): string | undefined {
  try {
    const abs = path.isAbsolute(dir) ? dir : path.join(cwd, dir)
    if (!existsSync(abs)) return undefined
    // maven/gradle never clear their report dir, so a prior run's XML lingers.
    // Only trust files written by THIS run (mtime at/after run start) to avoid
    // counting stale suites — especially when a filter ran a subset.
    const xml = readdirSync(abs)
      .filter(f => f.endsWith('.xml'))
      .map(f => path.join(abs, f))
      .filter(p => {
        try {
          return statSync(p).mtimeMs >= minMtimeMs
        } catch {
          return false
        }
      })
      .map(p => readReportFile(p) ?? '')
      .join('\n')
    return xml || undefined
  } catch (e) {
    logError(`RunTests: failed to scan report dir ${dir} — ${String(e)}`)
    return undefined
  }
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text
}

export async function runTests(opts: RunOptions): Promise<TestResult> {
  const { framework, cwd, abortSignal, timeoutMs } = opts

  // Watch guard: a --watch/--ui run never exits and would hang the tool.
  const cleaned = opts.command.replace(WATCH_STRIP_RE, ' ').replace(/\s+/g, ' ').trim()
  const strippedWatch = hasWatchFlag(opts.command)

  const plan = planReporter(framework, cleaned)

  // Force non-interactive mode: CI=true stops runners from watching/prompting
  // and FORCE_COLOR=0 keeps ANSI escapes out of the text-scrape fallback. The
  // shell provider already redirects stdin from /dev/null, so a TUI-loading
  // suite (e.g. Ink) won't try setRawMode on a non-TTY stdin.
  const execCommand = `CI=true FORCE_COLOR=0 ${plan.command}`

  // Recorded before exec so a report-dir scan can reject pre-existing stale XML
  // (surefire/gradle dirs are not cleared between runs). 2s grace absorbs coarse
  // filesystem mtime resolution.
  const runStartedMs = Date.now() - 2000
  const startedAt = Date.now()

  let stdout = ''
  let stderr = ''
  let exitCode = 0
  // Captured so the `finally` can stop the poller even when `exec` throws after
  // the task was registered.
  let taskId: string | null = null
  try {
    const shellCommand = await exec(execCommand, abortSignal, 'bash', {
      timeout: timeoutMs,
      // Purely a TUI signal, and `onProgress` rather than `onStdout`: the latter
      // pipes stdout instead of writing the file, which would break
      // `readFullShellOutput` below. Two things have to be true for a tick to
      // arrive and neither is automatic — the callback registers the task, and
      // `startPolling` is what drives it (see BuildTool/run.ts).
      onProgress: opts.onProgress
        ? (lastLines: string) =>
            opts.onProgress?.({
              type: 'test_progress',
              framework,
              label: tailLabel(lastLines) ?? '',
              elapsedMs: Date.now() - startedAt,
            })
        : undefined,
    })
    taskId = shellCommand.taskOutput.taskId
    TaskOutput.startPolling(taskId)
    const result = await shellCommand.result
    // NOT `result.stdout` — that is capped at BASH_MAX_OUTPUT_LENGTH, so a
    // verbose suite would be summarised from its first few hundred lines with
    // counts that look plausible. See utils/shell/fullOutput.ts.
    stdout = await readFullShellOutput(result)
    stderr = result.stderr
    exitCode = result.code
    if (result.interrupted) {
      return {
        framework,
        command: plan.command,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        failures: [],
        degraded: true,
        exitCode,
        runError: 'Test run was interrupted before completing.',
      }
    }
  } catch (e) {
    logError(`RunTests: exec failed — ${String(e)}`)
    return {
      framework,
      command: plan.command,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      degraded: true,
      exitCode: 1,
      runError: e instanceof Error ? e.message : String(e),
    }
  } finally {
    if (taskId) TaskOutput.stopPolling(taskId)
  }

  // Gather any machine report the reporter wrote.
  let reportContent: string | undefined
  try {
    if (plan.reportFile) reportContent = readReportFile(plan.reportFile)
    else if (plan.reportDir) reportContent = readReportDir(cwd, plan.reportDir, runStartedMs)
  } finally {
    if (plan.reportFile && existsSync(plan.reportFile)) {
      try {
        rmSync(plan.reportFile, { force: true })
      } catch (e) {
        logError(`RunTests: failed to clean up ${plan.reportFile} — ${String(e)}`)
      }
    }
  }

  const parseInput: ParseInput = { stdout, stderr, exitCode, reportContent }
  const result = parseTestOutput(framework, plan.command, parseInput)

  enrichFailuresWithStackLocation(result.failures)
  refineFailureLinesFromStdout(result.failures, stdout, framework)
  buildDossier(result.failures, cwd)

  // Reconcile a non-zero exit with a clean parse: if the assertions all passed
  // (structured, zero failures) but the runner process still exited non-zero,
  // the failure is outside the test cases — a compile/setup/teardown error, a
  // crash, or a post-suite gate (e.g. a coverage threshold). Attach a tail so
  // the formatter flags it instead of showing a green check on a failed run.
  if (
    !result.degraded &&
    !result.runError &&
    result.failed === 0 &&
    result.failures.length === 0 &&
    result.exitCode !== 0
  ) {
    result.stdoutTail = tail(`${stdout}\n${stderr}`.trim(), STDOUT_TAIL_CHARS)
  }

  if (result.degraded) {
    result.stdoutTail = tail(`${stdout}\n${stderr}`.trim(), STDOUT_TAIL_CHARS)
  }
  if (strippedWatch) {
    result.command = plan.command
  }

  return result
}
