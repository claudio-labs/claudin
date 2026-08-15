import {
  applyBashFilterToStdout,
  planBashFilter,
} from 'src/outputFilter/Bash/index.js'
import { stripOutputMarkers } from 'src/outputFilter/Bash/markers.js'
import { exec } from 'src/shared/proc/Shell.js'
import { formatDuration } from 'src/shared/text/format.js'
import { GIT_NO_PROMPT_ENV } from 'src/services/git/noPromptEnv.js'
import { logError } from 'src/shared/log.js'
import { readFullShellOutput } from 'src/platform/shell/fullOutput.js'
import { TaskOutput } from 'src/tasks/TaskOutput.js'
import { trimShellStdout } from 'src/tools/shellToolResultMappers.js'
import { trackGitOperations } from 'src/tools/shared/gitOperationTracking.js'
import { summarizeGitOutput } from 'src/tools/GitTool/budget.js'
import { applyGitDelta } from 'src/tools/GitTool/delta.js'
import { oneLineCommand } from 'src/tools/GitTool/display.js'
import { diagnoseGitFailure } from 'src/tools/GitTool/errors.js'
import { ghCommandPair, isWatchGitCommand } from 'src/tools/GitTool/grammar.js'
import type {
  GitBatchResult,
  GitCommandOutcome,
  GitProgress,
  GitStall,
} from 'src/tools/GitTool/types.js'

/**
 * Sequential batch execution.
 *
 * Runs through `exec()` — the same primitive BashTool uses — rather than
 * `runShellCommand`, which would drag in ~400 lines of backgrounding
 * lifecycle the Git tool has no use for. Going through `exec()` is what
 * inherits cwd resolution via `pwd()`, the abort wiring and the timeout, so a
 * sub-agent working in a worktree commits in ITS tree and not the main
 * checkout.
 *
 * Sequential, never parallel: `git status` refreshes `.git/index`, so
 * concurrent commands contend on the index lock.
 *
 * The child gets `GIT_NO_PROMPT_ENV` on top of the shell's own environment, so
 * a command that would ask for a credential fails instead of blocking on
 * /dev/tty. The forms that read from stdin or an editor never get this far —
 * `grammar.ts` declines them at validate time.
 */

/** Per-command wall ceiling for an ordinary git command. */
export const DEFAULT_TIMEOUT_MS = 120_000
/**
 * A watch (`gh run watch`, `gh pr checks --watch`) polls until CI finishes, so
 * the ordinary ceiling would kill nearly every one of them a couple of minutes
 * in. Ten minutes covers a normal CI run; past that the model gets a stall
 * report and can re-run, which is cheaper than pretending it can wait forever.
 */
export const WATCH_DEFAULT_TIMEOUT_MS = 600_000
/**
 * A watch that has written NOTHING for this long is wedged rather than
 * working: both watch commands print a full block every refresh, at 3s and 10s
 * intervals respectively. Ordinary commands get no watchdog — `git push` is
 * legitimately silent for a long time.
 */
const WATCH_IDLE_TIMEOUT_MS = 120_000
/** SIGTERM comes back with `interrupted` FALSE — that flag is only set for SIGKILL. */
const SIGTERM_EXIT = 143
/** Documented by `gh pr checks`: it finished a pass, the checks are pending. */
const GH_CHECKS_PENDING_EXIT = 8

export type RunGitBatchOptions = {
  commands: readonly string[]
  abortSignal: AbortSignal
  /**
   * Explicit per-command ceiling. Absent means the default for the command's
   * shape, which is not one number — see `WATCH_DEFAULT_TIMEOUT_MS`.
   */
  timeoutMs?: number
  /**
   * `full: true` on the tool input means the whole body: it opts out of the
   * delta lane, out of the summarizers, AND out of the Bash filter's command
   * rewrites, so the command runs as written. Without that last part
   * `full: true` on `git log` would still return the `--oneline` rewrite
   * capped at 50 lines, which is not what the flag says.
   */
  full?: boolean
  /**
   * The `tool_use_id` this batch's result will be delivered under. The delta
   * lane needs it to ask whether the body it wants to elide is still visible
   * to the model; absent, the lane declines and returns everything.
   */
  toolUseId?: string
  /** TUI-only; see `GitProgress`. */
  onProgress?: (progress: GitProgress) => void
  /**
   * Overrides `WATCH_IDLE_TIMEOUT_MS`. Not on the tool's input schema — the
   * model has no use for it and the two minutes are not a judgement call — but
   * a test cannot wait two minutes to prove the watchdog fires.
   */
  idleTimeoutMs?: number
}

/**
 * Run the summarizers over the filtered output.
 *
 * The filter wraps its result in `<bash-output-filtered …>` markers, glued to
 * the first line, and every summarizer here parses a line-anchored format. That
 * one line was enough to make a wide diff lose its FIRST file from the stat
 * table, silently — a stat table that lies is worse than no summary. So parse
 * the bare body.
 *
 * When the summarizer declines, the marker-wrapped text is what goes back, not
 * the bare body: the markers are how the model learns the filter already
 * trimmed this output, and dropping them would invite a `| head` on top.
 */
function budgetFilteredOutput(command: string, filtered: string): string {
  const body = stripOutputMarkers(filtered)
  const summarized = summarizeGitOutput(command, body)
  return summarized === body ? filtered : summarized
}

type CommandRun = {
  code: number
  interrupted: boolean
  /** Filtered later; this is the raw text the command produced. */
  text: string
  ranMs: number
  stall: GitStall | null
}

/**
 * Run one command, with a live tick and — for a watch — an idle watchdog.
 *
 * Both ride `ExecOptions.onProgress`, which the shared `TaskOutput` poller
 * drives once a second. Two things have to be true for a tick to arrive and
 * neither is automatic: the callback must be passed to `exec` (that is what
 * registers the task) and `startPolling` must be called. The interval is
 * `unref()`d, so this works headless and with the tool block collapsed.
 *
 * `onProgress` and not `onStdout` (`Shell.ts:170`): the latter pipes stdout
 * instead of writing the file, which would break `readFullShellOutput`.
 */
async function runOneCommand(params: {
  effectiveCommand: string
  watch: boolean
  timeoutMs: number
  idleTimeoutMs: number
  abortSignal: AbortSignal
  onTick?: (elapsedMs: number, silentMs: number) => void
}): Promise<CommandRun> {
  const { effectiveCommand, watch, timeoutMs, idleTimeoutMs, abortSignal, onTick } = params

  // A second controller, so the watchdog can stop the command without touching
  // the caller's signal: an abort of OURS is a stall report, an abort of THEIRS
  // is an interruption, and the two must stay distinguishable downstream.
  const internal = new AbortController()
  const forwardAbort = () => internal.abort()
  if (abortSignal.aborted) internal.abort()
  else abortSignal.addEventListener('abort', forwardAbort, { once: true })

  const startedAt = Date.now()
  let lastBytes = -1
  let lastChangeAt = startedAt
  let idleStall: { silentMs: number } | null = null
  // Captured so the `finally` can stop the poller even when `exec` throws after
  // the task was registered.
  let taskId: string | null = null

  try {
    // Fires ~1s apart, and fires even when the file has not grown — that empty
    // tick is what lets a silent command be noticed at all.
    const tick = (_lastLines: string, _all: string, _lines: number, totalBytes: number) => {
      const now = Date.now()
      if (totalBytes !== lastBytes) {
        lastBytes = totalBytes
        lastChangeAt = now
      }
      const silentMs = now - lastChangeAt
      if (watch && silentMs >= idleTimeoutMs) {
        idleStall = { silentMs }
        internal.abort()
        return
      }
      onTick?.(now - startedAt, silentMs)
    }

    const shellCommand = await exec(effectiveCommand, internal.signal, 'bash', {
      // A credential prompt opens /dev/tty and blocks until the timeout;
      // GIT_NO_PROMPT_ENV makes `git push` to an unauthenticated remote fail
      // in milliseconds with a message instead.
      timeout: timeoutMs,
      env: GIT_NO_PROMPT_ENV,
      onProgress: tick,
    })

    taskId = shellCommand.taskOutput.taskId
    TaskOutput.startPolling(taskId)

    const result = await shellCommand.result
    const ranMs = Date.now() - startedAt
    // A watch prints one whole block per refresh, so its answer is the LAST
    // thing it wrote — exactly what `result.stdout` drops when it caps at
    // BASH_MAX_OUTPUT_LENGTH (it keeps the first 30k chars, not the last).
    const text = watch ? await readFullShellOutput(result) : result.stdout || ''

    if (idleStall) {
      return {
        code: result.code,
        interrupted: false,
        text,
        ranMs,
        stall: {
          reason: 'idle',
          ranMs,
          silentMs: (idleStall as { silentMs: number }).silentMs,
        },
      }
    }
    // Only for a watch: an ordinary command that hit the ceiling really did
    // fail to do its job, and `errors.ts` explains the 143.
    if (watch && result.code === SIGTERM_EXIT && !result.interrupted) {
      return {
        code: result.code,
        interrupted: false,
        text,
        ranMs,
        stall: { reason: 'ceiling', ranMs, silentMs: 0 },
      }
    }
    return { code: result.code, interrupted: result.interrupted, text, ranMs, stall: null }
  } finally {
    if (taskId) TaskOutput.stopPolling(taskId)
    abortSignal.removeEventListener('abort', forwardAbort)
  }
}

/**
 * `gh pr checks` exits 8 when it ends a pass with checks still pending. That is
 * not a failure of the command, and routing it into the error lane made the
 * most common CI read come back marked `is_error` with a diagnosis attached.
 * It applies with or without `--watch`: a plain `gh pr checks` on a PR whose CI
 * is still running exits 8 too.
 */
function pendingChecksStall(command: string, code: number, ranMs: number): GitStall | null {
  if (code !== GH_CHECKS_PENDING_EXIT) return null
  if (ghCommandPair(command) !== 'pr checks') return null
  return { reason: 'pending', ranMs, silentMs: 0 }
}

export async function runGitBatch(
  opts: RunGitBatchOptions,
): Promise<GitBatchResult> {
  const outcomes: GitCommandOutcome[] = []
  const full = opts.full === true

  for (const [index, command] of opts.commands.entries()) {
    const watch = isWatchGitCommand(command)
    // Tier B: keep the existing command-aware Bash filter, which already knows
    // how to strip git noise and rewrite `git log` → `git log --oneline`.
    const plan = planBashFilter(command, full ? { allowRewrite: false } : undefined)

    let outcome: GitCommandOutcome
    try {
      const onProgress = opts.onProgress
      const run = await runOneCommand({
        effectiveCommand: plan.effectiveCommand,
        watch,
        timeoutMs:
          opts.timeoutMs ?? (watch ? WATCH_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
        idleTimeoutMs: opts.idleTimeoutMs ?? WATCH_IDLE_TIMEOUT_MS,
        abortSignal: opts.abortSignal,
        onTick: onProgress
          ? (elapsedMs, silentMs) =>
              onProgress({
                type: 'git_progress',
                command,
                index: index + 1,
                total: opts.commands.length,
                elapsedMs,
                silentMs,
              })
          : undefined,
      })
      const rawStdout = run.text
      const stall = run.stall ?? pendingChecksStall(command, run.code, run.ranMs)

      // Track BEFORE filtering: the tracker parses commit ids and PR urls out
      // of the raw text, which marker-wrapped or condensed output would hide.
      trackGitOperations(command, run.code, rawStdout)

      // A stall is the one way a non-zero exit is NOT an error: the command was
      // stopped mid-poll, or reported pending checks. Its output still goes
      // through the summarizer, which is what collapses the stack of refreshes.
      const isError = !stall && (run.code !== 0 || run.interrupted)
      const filtered = full
        ? rawStdout
        : applyBashFilterToStdout(rawStdout, isError, plan)
      // This branch IS the guarantee that errors are never budgeted and never
      // delta'd — both lanes are unreachable from a non-zero exit.
      // `full` skips the summarizer but still goes THROUGH the delta lane,
      // which returns the body unchanged for a full run and is also where a
      // history-touching command drops the remembered baselines. Skipping it
      // would leave a stale diff baseline alive across a `full: true` commit.
      const rendered = isError
        ? diagnoseGitFailure(command, run.code, filtered)
        : applyGitDelta(
            command,
            full ? filtered : budgetFilteredOutput(command, filtered),
            { full, toolUseId: opts.toolUseId },
          )
      outcome = {
        command,
        effectiveCommand: plan.effectiveCommand,
        exitCode: run.code,
        output: rendered,
        interrupted: run.interrupted,
        ...(stall ? { stall } : {}),
      }
    } catch (e) {
      logError(`Git: exec failed for \`${command}\` — ${String(e)}`)
      return {
        outcomes,
        notRun: opts.commands.slice(index + 1).map(String),
        runError: e instanceof Error ? e.message : String(e),
      }
    }

    outcomes.push(outcome)

    // `&&` semantics — a burst is what the model meant, and running `git
    // commit` after `git add` failed is worse than stopping. A stall is not a
    // failure, so it does not stop the rest: `["gh pr checks --watch",
    // "gh pr view"]` still delivers the second one.
    if (!outcome.stall && (outcome.exitCode !== 0 || outcome.interrupted)) {
      return { outcomes, notRun: opts.commands.slice(index + 1).map(String) }
    }
  }

  return { outcomes, notRun: [] }
}

/**
 * The one line that explains a stopped-but-not-failed command. It has to name
 * the way forward, because this is where the model learns that re-running the
 * watch is what continues it — nothing in the tool description says so.
 */
function stallNote(stall: GitStall): string {
  const ran = formatDuration(stall.ranMs, { hideTrailingZeros: true })
  switch (stall.reason) {
    case 'ceiling':
      return `Still running after ${ran} — stopped at the timeout, nothing failed. Re-run to keep watching, or pass a larger \`timeout\`.`
    case 'idle':
      return `No new output for ${formatDuration(stall.silentMs, { hideTrailingZeros: true })} — stopped after ${ran}, nothing failed. Re-run to keep watching.`
    case 'pending':
      return 'The checks are still pending — that is what `gh` exit 8 means, not a failure. Re-run to keep watching.'
  }
}

/**
 * Fold a batch into the model-facing text.
 *
 * A single command renders exactly like a Bash result — bare output — so the
 * common case costs nothing extra. Only a real batch pays for `$ command`
 * headers, and only a failure pays for the exit-code and not-run lines.
 */
export function formatGitBatchResult(result: GitBatchResult): string {
  const sections: string[] = []
  const multi = result.outcomes.length + result.notRun.length > 1

  for (const outcome of result.outcomes) {
    const parts: string[] = []
    // One line, whatever the command carries: a commit body in the header
    // would make a three-command batch look like nine.
    if (multi) parts.push(`$ ${oneLineCommand(outcome.command)}`)
    const body = trimShellStdout(outcome.output)
    if (body) parts.push(body)
    if (outcome.stall) {
      parts.push(stallNote(outcome.stall))
    } else if (outcome.interrupted) {
      parts.push('<error>Command was aborted before completion</error>')
    } else if (outcome.exitCode !== 0) {
      parts.push(`Exit code ${outcome.exitCode}`)
    }
    if (!body && outcome.exitCode === 0 && !outcome.stall && !multi) {
      // Bash renders an empty successful run as empty; keep that, but a batch
      // needs the header to stay meaningful.
      continue
    }
    sections.push(parts.join('\n'))
  }

  if (result.runError) {
    sections.push(`<error>${result.runError}</error>`)
  }

  if (result.notRun.length > 0) {
    const failed = result.outcomes[result.outcomes.length - 1]
    const because = failed
      ? `\`${oneLineCommand(failed.command)}\` failed`
      : 'the run failed'
    sections.push(
      `Stopped because ${because} — not run: ${result.notRun
        .map(c => `\`${oneLineCommand(c)}\``)
        .join(', ')}.`,
    )
  }

  return sections.join('\n\n')
}

/** True when anything in the batch failed, aborted, or never ran. */
export function batchFailed(result: GitBatchResult): boolean {
  return (
    result.runError !== undefined ||
    result.notRun.length > 0 ||
    // A stalled watch exits non-zero (143, or 8 for pending checks) and is not
    // a failure; marking the result `is_error` for it would teach the model
    // that watching CI is something that goes wrong.
    result.outcomes.some(o => !o.stall && (o.exitCode !== 0 || o.interrupted))
  )
}
