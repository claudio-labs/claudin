// Reconstructed from its use sites — the original module was not carried into
// this fork. The members are the arms of the `SpinnerModeGlyph` switch in
// `SpinnerAnimationRow.tsx`, plus the `'responding'` initial state in REPL.tsx.

/**
 * Which phase of a turn the spinner is reporting.
 *
 * `requesting` renders an up-arrow (waiting on the API); the rest render a
 * down-arrow (receiving or working).
 */
export type SpinnerMode =
  | 'requesting'
  | 'responding'
  | 'thinking'
  | 'tool-input'
  | 'tool-use'
