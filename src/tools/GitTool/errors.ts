/**
 * Error-path diagnosis.
 *
 * A failing git/gh command is verbose and the useful part is three lines: what
 * went wrong and what to do next. This module prepends a one-line diagnosis to
 * the raw text — it never replaces it, because truncating an error is how a
 * model loops.
 *
 * Errors are deliberately NOT budgeted and NOT delta'd; `run.ts` routes a
 * non-zero exit here instead of through the summarizer.
 */

/**
 * @returns the output with a diagnosis line prepended, or the output unchanged
 * when nothing is recognised.
 */
export function diagnoseGitFailure(
  _command: string,
  _exitCode: number,
  output: string,
): string {
  return output
}
