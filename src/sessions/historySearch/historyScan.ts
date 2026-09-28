/**
 * One pass of the inline search over the prompt history, for one query: it
 * walks the history newest first and hands out, one per call, the prompts
 * whose text contains the query. Each text is handed out once per scan.
 */
import type { HistoryEntry } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'

export type HistoryScan = {
  readonly query: string
  /**
   * The next older prompt that contains the query and that this scan has not
   * handed out yet, or undefined once none is left. Calls are answered in
   * order, each one after the previous has settled.
   */
  next: () => Promise<HistoryEntry | undefined>
  /** Stops reading the history. A call pending or made afterwards finds nothing. */
  close: () => void
}

export function createHistoryScan(source: AsyncIterable<HistoryEntry>, query: string): HistoryScan {
  const entries = source[Symbol.asyncIterator]()
  const handedOut = new Set<string>()
  let finished = false
  let previousCall: Promise<unknown> = Promise.resolve()

  async function findNext(): Promise<HistoryEntry | undefined> {
    while (!finished) {
      const step = await readNext()
      if (finished) break
      if (step.done) {
        finished = true
        break
      }
      const entry = step.value
      if (!hasText(entry)) {
        logForDebugging('history search: skipped a history entry that has no text')
        continue
      }
      if (!entry.display.includes(query) || handedOut.has(entry.display)) continue
      handedOut.add(entry.display)
      return entry
    }
    return undefined
  }

  async function readNext(): Promise<IteratorResult<HistoryEntry>> {
    try {
      return await entries.next()
    } catch (error) {
      finished = true
      throw error
    }
  }

  return {
    query,
    next: () => {
      const call = previousCall.then(findNext, findNext)
      previousCall = call
      return call
    },
    close: () => {
      if (finished) return
      finished = true
      void entries.return?.().catch(logError)
    },
  }
}

/** History lines are parsed JSON, so an entry can lack the text its type promises. */
function hasText(entry: HistoryEntry): boolean {
  return typeof entry.display === 'string'
}
