import { type Change, diffWordsWithSpace } from 'diff'
import type { HunkLine } from 'src/vcs/diff/structured/hunk/lines.js'
import type { Span } from 'src/vcs/diff/structured/layout/wrap.js'

/** Whether a piece of a paired line is what changed in it. */
export type Emphasis = 'plain' | 'changed'

type LinePair = [removed: number, added: number]

// Past this share of the two lines, marking the changed words would mark most
// of the text, and the pair reads better drawn whole.
const WORD_BY_WORD_LIMIT = 0.4

/**
 * Pairs the lines of a removal run with those of the addition run right after
 * it, in order: first with first, second with second. Lines left over are not
 * paired, and a context line ends both runs. Notes are not code, so they sit
 * between the runs without separating them.
 */
export function pairChangedLines(lines: readonly HunkLine[]): LinePair[] {
  const pairs: LinePair[] = []
  let removed: number[] = []
  let added: number[] = []
  const closeRuns = (): void => {
    for (let at = 0; at < Math.min(removed.length, added.length); at++) pairs.push([removed[at]!, added[at]!])
    removed = []
    added = []
  }
  lines.forEach((line, index) => {
    if (line.kind === 'removed') {
      if (added.length > 0) closeRuns()
      removed.push(index)
    } else if (line.kind === 'added') {
      added.push(index)
    } else if (line.kind === 'context') {
      closeRuns()
    }
  })
  closeRuns()
  return pairs
}

/**
 * The spans of each line drawn word by word, by line index. The two lines of
 * a pair are compared word by word, whitespace and case included, and drawn
 * that way when the changed share of their text is at most 40%. A removed
 * line shows its kept and removed words, an added line its kept and added ones.
 */
export function wordByWordSpans(lines: readonly HunkLine[]): Map<number, Span<Emphasis>[]> {
  const spans = new Map<number, Span<Emphasis>[]>()
  for (const [removedAt, addedAt] of pairChangedLines(lines)) {
    const before = lines[removedAt]!.code
    const after = lines[addedAt]!.code
    const changes = diffWordsWithSpace(before, after)
    if (changedShare(changes, before.length + after.length) > WORD_BY_WORD_LIMIT) continue
    spans.set(removedAt, sideOf(changes, 'removed'))
    spans.set(addedAt, sideOf(changes, 'added'))
  }
  return spans
}

/** The changed share of two lines, in UTF-16 code units. */
function changedShare(changes: readonly Change[], total: number): number {
  if (total === 0) return 0
  const changed = changes.reduce((sum, change) => (change.added || change.removed ? sum + change.value.length : sum), 0)
  return changed / total
}

function sideOf(changes: readonly Change[], side: 'removed' | 'added'): Span<Emphasis>[] {
  const otherSide = side === 'removed' ? 'added' : 'removed'
  return changes
    .filter(change => !change[otherSide])
    .map((change): Span<Emphasis> => ({ text: change.value, tag: change[side] ? 'changed' : 'plain' }))
}
