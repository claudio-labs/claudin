/**
 * `gh` watch collapsing.
 *
 * `gh pr checks --watch` and `gh run watch` poll until CI finishes, and outside
 * a TTY each refresh APPENDS its whole block (see `__fixtures__/watchPolls.ts`
 * for the captured shape). The model wants the state, which is the LAST block;
 * everything before it is the same table with older numbers.
 *
 * The collapse anchors on ONE line rather than trying to match blocks
 * line-for-line, because too much of a block legitimately changes between
 * refreshes: the status glyph flips `*` → `✓`, elapsed columns grow, and
 * `gh run watch` even re-words its age line from "about 1 minute ago" to
 * "about 2 minutes ago". The first non-empty line of a block is the one thing
 * that survives all of that once digits and the leading glyph are masked — it
 * is the first check's name for `pr checks`, and the run header for
 * `run watch`.
 *
 * Fails closed: anything that does not look like several evenly-spaced repeats
 * of that anchor comes back `null` and is returned unchanged. A single poll —
 * `gh pr checks` without `--watch` — is exactly that case.
 */

/** A leading status glyph is state, not identity: `*` becomes `✓` mid-watch. */
const STATUS_GLYPH_RE = /^[*\-•✓✗×✘X]+\s+/
const DIGITS_RE = /\d+/g
/**
 * How uneven the gaps between anchors may be before this stops believing they
 * are poll boundaries. Refreshes produce blocks of the same height; a repeated
 * word inside prose does not.
 */
const MAX_GAP_RATIO = 3

/**
 * What identifies a line across refreshes: its first tab-field (the whole line
 * when there is no tab), with the status glyph dropped and every number masked.
 */
function anchorSignature(line: string): string {
  const tab = line.indexOf('\t')
  const head = tab === -1 ? line : line.slice(0, tab)
  return head.trim().replace(STATUS_GLYPH_RE, '').replace(DIGITS_RE, '#').trim()
}

/**
 * @returns the last refresh plus a line naming how many were dropped, or `null`
 * when the text is not several refreshes of one command.
 */
export function renderWatchPolls(text: string): string | null {
  const lines = text.split('\n')
  const first = lines.findIndex(line => line.trim() !== '')
  if (first === -1) return null

  // Non-empty is the only length requirement, and it is deliberately not a
  // minimum: `CI` is a real check name, and a three-char floor silently turned
  // the collapse off for every PR whose first check is named that way. What
  // keeps a junk anchor out is the spacing check below, not its length.
  const anchor = anchorSignature(lines[first] as string)
  if (anchor === '') return null

  const starts: number[] = []
  for (let i = first; i < lines.length; i++) {
    if (anchorSignature(lines[i] as string) === anchor) starts.push(i)
  }
  if (starts.length < 2) return null

  // Evenly spaced, or this is a repeated phrase rather than a repeated block.
  const gaps = starts.slice(1).map((s, i) => s - (starts[i] as number))
  const min = Math.min(...gaps)
  const max = Math.max(...gaps)
  if (min < 1 || max > min * MAX_GAP_RATIO) return null

  const last = starts[starts.length - 1] as number
  return [
    `… ${starts.length - 1} earlier refresh${starts.length === 2 ? '' : 'es'} omitted — this is the final state.`,
    ...lines.slice(last),
  ].join('\n')
}
