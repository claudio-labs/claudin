/**
 * What the Ctrl+R picker lists: this project's prompts as the history module
 * hands them out (newest first, one per distinct text), narrowed by the query.
 */
import type { TimestampedHistoryEntry } from 'src/agent/history.js'
import type { HistoryEntry } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'

export type ListedPrompt = {
  /** Unique among the listed prompts, whatever their texts and timestamps. */
  readonly key: string
  readonly display: string
  readonly timestamp: number
  /** Reads the prompt's pastes, from the paste store when they were moved there. */
  readonly resolve: () => Promise<HistoryEntry>
}

/**
 * Reads the history once, in its order, until it ends or `signal` aborts. A
 * read that fails is logged, and the prompts read before it are kept.
 */
export async function readListedPrompts(
  source: AsyncIterable<TimestampedHistoryEntry>,
  signal: AbortSignal,
): Promise<ListedPrompt[]> {
  const listed: ListedPrompt[] = []
  try {
    for await (const entry of source) {
      if (signal.aborted) break
      if (typeof entry.display !== 'string') {
        logForDebugging('history picker: skipped a history entry that has no text')
        continue
      }
      listed.push({ key: String(listed.length), display: entry.display, timestamp: entry.timestamp, resolve: entry.resolve })
    }
  } catch (error) {
    logError(error)
  }
  return listed
}

/**
 * The prompts whose text contains the query, then those that hold its
 * characters in order with gaps; each group keeps the order it was given.
 * Case is ignored, and so are spaces around the query. An empty query keeps all.
 */
export function filterPrompts<T extends { readonly display: string }>(prompts: readonly T[], query: string): readonly T[] {
  const wanted = normalizeQuery(query)
  if (wanted === '') return prompts
  const containing: T[] = []
  const scattered: T[] = []
  for (const prompt of prompts) {
    const text = prompt.display.toLowerCase()
    if (text.includes(wanted)) containing.push(prompt)
    else if (holdsInOrder(text, wanted)) scattered.push(prompt)
  }
  return [...containing, ...scattered]
}

/** What the list area says when nothing is listed. */
export function emptyListNotice(loading: boolean, query: string): string {
  if (loading) return 'Loading…'
  // A query of spaces filters nothing out, so an empty list then means an empty history.
  return normalizeQuery(query) === '' ? 'No history yet' : 'No matching prompts'
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

function holdsInOrder(text: string, characters: string): boolean {
  let from = 0
  for (const character of characters) {
    const at = text.indexOf(character, from)
    if (at === -1) return false
    from = at + character.length
  }
  return true
}
