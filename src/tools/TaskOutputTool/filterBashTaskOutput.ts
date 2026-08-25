import {
  applyBashFilterToStdout,
  planBashFilter,
} from 'src/tools/shared/outputFilter/Bash/index.js'

/**
 * Runs the Bash output filter over a backgrounded shell task's output, on its
 * way to the model.
 *
 * ## Why this lane needs its own call
 *
 * A foreground Bash run is filtered inside `BashTool.applyBashOutputFilter`. A
 * backgrounded one is not: `shouldFilterOutput` (`BashTool.tsx`) returns false
 * as soon as there is a `backgroundTaskId`, because the output goes to disk
 * where the user may inspect it and the command they asked for should be the
 * command that ran. That reasoning covers the WRITE. It does not cover the
 * read: `TaskOutputTool` later hands the whole file to the model, and the only
 * budget between them was `formatTaskOutput`, which is a blind tail-truncate at
 * `getMaxTaskOutputLength()`. So the one lane where a command's output is
 * unbounded by construction was also the one lane with no filter on it.
 *
 * ## Noise removal only, deliberately
 *
 * `callerBudgets: true` — the same flag `GitTool` uses — stops the pipeline at
 * the lossless stages: `stripAnsi`, `collapseRuns`, the matched spec's own
 * rules. No head/tail cap, no `groupMatchLines`. Two reasons, and only the
 * second is about ownership:
 *
 * - `formatTaskOutput` already owns the budget, and a cut spent twice is a cut
 *   the caller cannot account for.
 * - A monitor task is read by POLLING. Its output only grows, and each read
 *   returns the whole accumulation, so a cap that removes the middle removes a
 *   different middle every time — including lines the model has never seen.
 *   That is not a smaller answer, it is an unstable one.
 *
 * `allowRewrite: false` is not a preference: the command already ran. A rewrite
 * marker names the command that was EXECUTED, and claiming one here would
 * describe a run that never happened.
 *
 * Fail-open by construction — both callees wrap themselves in `safeApply` and
 * return the raw string on any throw.
 */
export function filterBashTaskOutput(
  output: string,
  command: string | undefined,
  exitCode: number | null | undefined,
): string {
  if (!command || output === '') return output
  const plan = planBashFilter(command, {
    allowRewrite: false,
    callerBudgets: true,
  })
  // A task still running has no exit code yet; that is not a failure.
  const isError = typeof exitCode === 'number' && exitCode !== 0
  return applyBashFilterToStdout(output, isError, plan, exitCode ?? undefined)
}
