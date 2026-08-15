/**
 * Pure layout math for the horizontal `/effort` slider. Kept React-free so the
 * column alignment (header, rule with the ▲ marker, and per-label offsets) is
 * unit-testable without rendering Ink.
 *
 * Each option is laid out in a fixed cell of width `label.length`, separated by
 * a constant GAP. Because every line (header, rule, labels) is built from the
 * same offsets, the columns align without measuring glyph widths.
 */

/** Default spaces between adjacent labels on the slider. Wider = the bar spans
 * more of the row instead of bunching up in the corner. Narrowed automatically
 * by fitSliderLayout when the terminal is too narrow to fit this. */
export const SLIDER_GAP = 5

/** Smallest gap fitSliderLayout will shrink to before giving up (labels still
 * need at least one space between them to stay readable). */
export const SLIDER_GAP_MIN = 1

/**
 * Marker painted under the focused label. Must be a true ASCII, unambiguous-
 * width glyph: the marker sits inside the full-width rule and aligns column-for-
 * column with the labels below, so an East-Asian-ambiguous glyph (e.g. ▲ U+25B2,
 * which Ghostty/Nerd Fonts can render 2 cells wide) would drift the rule out of
 * alignment. See team memory `ghostty-main-screen-carveouts.md` for the ✳ case.
 */
export const SLIDER_MARKER = '^'

/** Rule character drawn across the full slider width. */
export const SLIDER_RULE = '─'

export const FASTER_LABEL = 'Faster'
export const SMARTER_LABEL = 'Smarter'

export type SliderLayout = {
  /** Total printable width of the slider (last label end column). */
  totalWidth: number
  /** Gap (spaces) used between labels — the LabelsLine must space with this so
   * its columns line up with the rule/marker built from the same gap. */
  gap: number
  /** Start column of each label, in input order. */
  labelStarts: number[]
  /** Column of the ▲ marker, centered on the focused label. */
  markerColumn: number
  /** The rule line with the marker already placed. */
  ruleLine: string
  /** The header line: "Faster" flush left, "Smarter" right-aligned. */
  headerLine: string
}

/**
 * Compute the slider layout for the given labels and focused index.
 *
 * @param labels Option labels in display order (left → right).
 * @param focusedIndex Index of the currently focused label.
 * @param gap Spaces between adjacent labels. Defaults to SLIDER_GAP.
 */
export function computeSliderLayout(
  labels: string[],
  focusedIndex: number,
  gap: number = SLIDER_GAP,
): SliderLayout {
  const labelStarts: number[] = []
  let cursor = 0
  for (let i = 0; i < labels.length; i++) {
    labelStarts.push(cursor)
    cursor += labels[i]!.length
    if (i < labels.length - 1) {
      cursor += gap
    }
  }
  const totalWidth = cursor

  const safeIndex = Math.max(0, Math.min(focusedIndex, labels.length - 1))
  const focusLabel = labels[safeIndex] ?? ''
  const markerColumn =
    (labelStarts[safeIndex] ?? 0) + Math.floor(focusLabel.length / 2)

  const ruleChars = Array.from({ length: totalWidth }, () => SLIDER_RULE)
  if (markerColumn >= 0 && markerColumn < totalWidth) {
    ruleChars[markerColumn] = SLIDER_MARKER
  }
  const ruleLine = ruleChars.join('')

  const headerLine = buildHeaderLine(labels, labelStarts, totalWidth)

  return { totalWidth, gap, labelStarts, markerColumn, ruleLine, headerLine }
}

/**
 * Like computeSliderLayout, but shrinks the inter-label gap (down to
 * SLIDER_GAP_MIN) so the slider fits within `maxWidth` columns. The rule,
 * marker, header, and labels are all derived from the same gap, so they stay
 * column-aligned at whatever gap is chosen. If even the minimum gap overflows
 * (extremely narrow terminal), returns the minimum-gap layout — Ink will wrap,
 * but that's the least-bad option and the gap can't shrink further without the
 * labels touching.
 */
export function fitSliderLayout(
  labels: string[],
  focusedIndex: number,
  maxWidth: number,
): SliderLayout {
  for (let gap = SLIDER_GAP; gap > SLIDER_GAP_MIN; gap--) {
    const layout = computeSliderLayout(labels, focusedIndex, gap)
    if (layout.totalWidth <= maxWidth) {
      return layout
    }
  }
  return computeSliderLayout(labels, focusedIndex, SLIDER_GAP_MIN)
}

/**
 * Header row: "Faster" is flush left and "Smarter" is flush right, framing the
 * speed gradient. No "Auto" cell or zone divider.
 */
function buildHeaderLine(
  _labels: string[],
  _labelStarts: number[],
  totalWidth: number,
): string {
  const pad = Math.max(1, totalWidth - FASTER_LABEL.length - SMARTER_LABEL.length)
  return FASTER_LABEL + ' '.repeat(pad) + SMARTER_LABEL
}
