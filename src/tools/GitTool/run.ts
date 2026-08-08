import {
  applyBashFilterToStdout,
  planBashFilter,
} from '../../outputFilter/Bash/index.js'
import { stripOutputMarkers } from '../../outputFilter/Bash/markers.js'
import { exec } from '../../utils/Shell.js'
import { GIT_NO_PROMPT_ENV } from '../../utils/git/noPromptEnv.js'
import { logError } from '../../utils/log.js'
import { trimShellStdout } from '../shellToolResultMappers.js'
import { trackGitOperations } from '../shared/gitOperationTracking.js'
import { summarizeGitOutput } from './budget.js'
import { applyGitDelta } from './delta.js'
import { oneLineCommand } from './display.js'
import { diagnoseGitFailure } from './errors.js'
import type { GitBatchResult, GitCommandOutcome } from './types.js'

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

export type RunGitBatchOptions = {
  commands: readonly string[]
  abortSignal: AbortSignal
  timeoutMs: number
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

export async function runGitBatch(
  opts: RunGitBatchOptions,
): Promise<GitBatchResult> {
  const outcomes: GitCommandOutcome[] = []
  const full = opts.full === true

  for (const [index, command] of opts.commands.entries()) {
    // Tier B: keep the existing command-aware Bash filter, which already knows
    // how to strip git noise and rewrite `git log` → `git log --oneline`.
    const plan = planBashFilter(command, full ? { allowRewrite: false } : undefined)

    let outcome: GitCommandOutcome
    try {
      const shellCommand = await exec(
        plan.effectiveCommand,
        opts.abortSignal,
        'bash',
        // A credential prompt opens /dev/tty and blocks until the timeout;
        // GIT_NO_PROMPT_ENV makes `git push` to an unauthenticated remote fail
        // in milliseconds with a message instead.
        { timeout: opts.timeoutMs, env: GIT_NO_PROMPT_ENV },
      )
      const result = await shellCommand.result
      const rawStdout = result.stdout || ''

      // Track BEFORE filtering: the tracker parses commit ids and PR urls out
      // of the raw text, which marker-wrapped or condensed output would hide.
      trackGitOperations(command, result.code, rawStdout)

      const isError = result.code !== 0 || result.interrupted
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
        ? diagnoseGitFailure(command, result.code, filtered)
        : applyGitDelta(
            command,
            full ? filtered : budgetFilteredOutput(command, filtered),
            { full, toolUseId: opts.toolUseId },
          )
      outcome = {
        command,
        effectiveCommand: plan.effectiveCommand,
        exitCode: result.code,
        output: rendered,
        interrupted: result.interrupted,
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
    // commit` after `git add` failed is worse than stopping.
    if (outcome.exitCode !== 0 || outcome.interrupted) {
      return { outcomes, notRun: opts.commands.slice(index + 1).map(String) }
    }
  }

  return { outcomes, notRun: [] }
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
    if (outcome.interrupted) {
      parts.push('<error>Command was aborted before completion</error>')
    } else if (outcome.exitCode !== 0) {
      parts.push(`Exit code ${outcome.exitCode}`)
    }
    if (!body && outcome.exitCode === 0 && !multi) {
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
    result.outcomes.some(o => o.exitCode !== 0 || o.interrupted)
  )
}
