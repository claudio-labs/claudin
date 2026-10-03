/**
 * The one "latest entry" rule of the resume unit.
 *
 * The CLI often writes several entries in the same millisecond (the blocks of
 * one streamed reply, a reply and the prompt after it). When stamps tie, the
 * entry met later wins: over a transcript map that is the order the entries
 * were written, so a tie never drops the replies that came after it.
 */

/** The entry a "latest" question settles on, or `undefined` when none qualifies. */
type TipChoice<T> = T | undefined

/**
 * The accepted entry with the greatest `timestamp`. A stamp that does not
 * parse never wins, and neither does one at or before `notAfter` (an epoch
 * time in ms).
 */
export function latestByTimestamp<T extends { timestamp: string }>(
  entries: Iterable<T>,
  accept: (entry: T) => boolean,
  notAfter: number = Number.NEGATIVE_INFINITY,
): TipChoice<T> {
  let chosen: T | undefined
  let chosenAt = notAfter
  for (const entry of entries) {
    if (!accept(entry)) continue
    const at = Date.parse(entry.timestamp)
    if (Number.isNaN(at) || at <= notAfter) continue
    if (chosen === undefined || at >= chosenAt) {
      chosen = entry
      chosenAt = at
    }
  }
  return chosen
}
