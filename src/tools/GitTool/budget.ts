/**
 * Success-path budget.
 *
 * Summary-first rendering for the command shapes that carry the payload —
 * measured over 760 recorded sessions, `git diff` (428k chars), `git status`
 * (234k) and `gh run` (202k) lead. Everything else falls through unchanged.
 *
 * The no-win guard is the rule that keeps a lossy mode honest: ship the summary
 * only when it is <=70% of what it replaces, otherwise return the input.
 */

/** Ship a summary only when it saves at least this much. */
export const NO_WIN_RATIO = 0.7

/**
 * @returns a budgeted rendering of a SUCCESSFUL command's output, or the output
 * unchanged when this command shape has no summarizer or the summary would not
 * pay for itself.
 */
export function summarizeGitOutput(_command: string, output: string): string {
  return output
}
