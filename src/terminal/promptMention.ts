/**
 * Inserting an `@path#La-Lb` mention into the prompt on behalf of a side panel,
 * and rewriting it when the user adjusts the selection that produced it.
 *
 * The rewrite rule is the whole reason this is a module: dragging over the diff
 * a second time to fix the range should CORRECT the mention, not stack a second
 * one — but only while the prompt still reads exactly as the insert left it.
 * The moment the user types, the line is theirs and the next drag appends.
 *
 * Pure, so the rule is unit-testable and so the keyboard path (`v` + Enter) and
 * the mouse path cannot drift apart — both go through here.
 */

/** What the last insert left behind, so the next one can recognise it. */
export type TrackedMention = {
  /** Offset the mention was written at. */
  start: number
  /** The mention text, exactly as inserted (leading space included). */
  text: string
  /** The whole input immediately after the insert. */
  input: string
}

export type MentionEdit = {
  input: string
  cursor: number
  tracked: TrackedMention
}

const TRAILING_SPACE_RE = /\s$/

/**
 * @param input   the prompt buffer now
 * @param cursor  the caret offset now
 * @param mention the mention to write, without any separating space
 * @param tracked what the previous call left, or null
 */
export function applyMention(
  input: string,
  cursor: number,
  mention: string,
  tracked: TrackedMention | null,
): MentionEdit {
  // Untouched since the last insert — and the text really is still sitting
  // where we put it — so correct it in place.
  if (
    tracked &&
    input === tracked.input &&
    input.slice(tracked.start, tracked.start + tracked.text.length) ===
      tracked.text
  ) {
    // Keep whatever separator the original insert chose.
    const lead = TRAILING_SPACE_RE.test(tracked.text[0] ?? '') ? ' ' : ''
    const text = lead + mention + ' '
    const next =
      input.slice(0, tracked.start) +
      text +
      input.slice(tracked.start + tracked.text.length)
    return {
      input: next,
      cursor: tracked.start + text.length,
      tracked: { start: tracked.start, text, input: next },
    }
  }

  // Fresh insert at the caret. The leading-space rule mirrors PromptInput's own
  // `insert` (PromptInput.tsx) so a mention never fuses onto the word before it.
  const at = Math.max(0, Math.min(cursor, input.length))
  const needsSpace =
    at === input.length && input.length > 0 && !TRAILING_SPACE_RE.test(input)
  const text = (needsSpace ? ' ' : '') + mention + ' '
  const next = input.slice(0, at) + text + input.slice(at)
  return {
    input: next,
    cursor: at + text.length,
    tracked: { start: at, text, input: next },
  }
}
