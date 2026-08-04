import {
  applyBashFilterToStdout,
  planBashFilter,
} from '../../outputFilter/Bash/index.js'
import { exec } from '../../utils/Shell.js'
import { logError } from '../../utils/log.js'
import { trimShellStdout } from '../shellToolResultMappers.js'
import { trackGitOperations } from '../shared/gitOperationTracking.js'
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
 */

export type RunGitBatchOptions = {
  commands: readonly string[]
  abortSignal: AbortSignal
  timeoutMs: number
}

export async function runGitBatch(
  opts: RunGitBatchOptions,
): Promise<GitBatchResult> {
  const outcomes: GitCommandOutcome[] = []

  for (const [index, command] of opts.commands.entries()) {
    // Tier B: keep the existing command-aware Bash filter, which already knows
    // how to strip git noise and rewrite `git log` → `git log --oneline`.
    const plan = planBashFilter(command)

    let outcome: GitCommandOutcome
    try {
      const shellCommand = await exec(
        plan.effectiveCommand,
        opts.abortSignal,
        'bash',
        { timeout: opts.timeoutMs },
      )
      const result = await shellCommand.result
      const rawStdout = result.stdout || ''

      // Track BEFORE filtering: the tracker parses commit ids and PR urls out
      // of the raw text, which marker-wrapped or condensed output would hide.
      trackGitOperations(command, result.code, rawStdout)

      const isError = result.code !== 0 || result.interrupted
      outcome = {
        command,
        effectiveCommand: plan.effectiveCommand,
        exitCode: result.code,
        output: applyBashFilterToStdout(rawStdout, isError, plan),
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
    if (multi) parts.push(`$ ${outcome.command}`)
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
    const because = failed ? `\`${failed.command}\` failed` : 'the run failed'
    sections.push(
      `Stopped because ${because} — not run: ${result.notRun
        .map(c => `\`${c}\``)
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
