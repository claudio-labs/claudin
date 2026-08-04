/**
 * Re-run delta.
 *
 * The model re-runs `git diff` after every edit. Because the tool sees its own
 * previous output it can return only what changed since then — but only under
 * the rules in the plan, the first of which is the one that matters: never
 * elide text the model can no longer see.
 *
 * Disable with `CLAUDIN_DISABLE_GIT_DELTA=1`.
 */

export type DeltaOptions = {
  /** `full: true` on the tool input forces the whole body. */
  full: boolean
}

/**
 * @returns the output reduced to what changed since the previous identical
 * call, or the output unchanged when the delta lane declines.
 */
export function applyGitDelta(
  _command: string,
  output: string,
  _opts: DeltaOptions,
): string {
  return output
}

/** Drop remembered bodies — a history-touching command invalidates them. */
export function resetGitDelta(): void {}
