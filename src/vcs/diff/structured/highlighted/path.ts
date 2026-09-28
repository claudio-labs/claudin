import type { ColorModuleUnavailableReason } from 'src/vcs/diff/structured/colorDiff.js'

/** Who draws a hunk: the syntax renderer, or the plain fallback. */
type DiffPath = 'highlighted' | 'fallback'

type DiffPathInputs = {
  /** The component's `skipHighlighting` prop. */
  skipHighlighting: boolean
  /** The `syntaxHighlightingDisabled` setting. */
  highlightingDisabled: boolean
  /** Why the switch in colorDiff.ts reports highlighting unavailable, if it does. */
  unavailableReason: ColorModuleUnavailableReason | null
}

/** Any one of the three turns highlighting off for the hunk. */
export function chooseDiffPath({ skipHighlighting, highlightingDisabled, unavailableReason }: DiffPathInputs): DiffPath {
  return skipHighlighting || highlightingDisabled || unavailableReason !== null ? 'fallback' : 'highlighted'
}
