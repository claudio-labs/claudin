/**
 * The inline prompt-history search, without React: what starting, querying,
 * stepping and each way of ending a search do to the caller's prompt.
 * src/sessions/hooks/useHistorySearch.ts wires it to keys and React state.
 */
import type { HistoryEntry } from 'src/platform/config/config.js'
import { createHistoryScan, type HistoryScan } from 'src/sessions/historySearch/historyScan.js'
import {
  entrySubmittingMatch,
  type PromptSnapshot,
  promptAcceptingMatch,
  promptShowingMatch,
} from 'src/sessions/historySearch/promptSnapshot.js'
import type { SearchOperation } from 'src/sessions/historySearch/searchKeys.js'
import { logError } from 'src/shared/log.js'
import { getModeFromInput } from 'src/terminal/prompt-input/inputModes.js'

/** What the footer and the prompt box show about the search. */
export type SearchView = {
  readonly query: string
  readonly match: HistoryEntry | undefined
  /** The query matched nothing (more): the footer says so, and the last match stays. */
  readonly failed: boolean
}

export const IDLE_VIEW: SearchView = { query: '', match: undefined, failed: false }

type InlineSearchDeps = {
  /** A fresh read of the whole history, newest first. Every query reads it anew. */
  readHistory: () => AsyncIterable<HistoryEntry>
  /** The prompt as the caller holds it now. */
  currentPrompt: () => PromptSnapshot
  /** Sets the given parts of the caller's prompt and leaves the rest. */
  writePrompt: (prompt: Partial<PromptSnapshot>) => void
  setSearching: (searching: boolean) => void
  submit: (entry: HistoryEntry) => void
  onViewChange: (view: SearchView) => void
}

export type InlineSearch = Record<SearchOperation, () => void> & {
  start: () => void
  /** The caller's query box reports every edit here. Each change starts a new scan from the newest prompt. */
  setQuery: (query: string) => void
  /** Stops a read in flight; its result is dropped. */
  dispose: () => void
}

export function createInlineSearch(deps: InlineSearchDeps): InlineSearch {
  let view = IDLE_VIEW
  let remembered: PromptSnapshot | undefined
  // Only the scan of the current query may touch the prompt. A result that
  // lands after the query changed belongs to an older query and is dropped.
  let scan: HistoryScan | undefined

  function publish(next: SearchView): void {
    if (next.query === view.query && next.match === view.match && next.failed === view.failed) return
    view = next
    deps.onViewChange(next)
  }

  /** Taken at start; taken now if the search was already running when this instance came up. */
  function rememberedPrompt(): PromptSnapshot {
    remembered ??= deps.currentPrompt()
    return remembered
  }

  function closeScan(): void {
    scan?.close()
    scan = undefined
  }

  /** An empty query shows the prompt from before the search, and the search goes on. */
  function showRemembered(): void {
    deps.writePrompt(rememberedPrompt())
    publish(IDLE_VIEW)
  }

  function end(): void {
    closeScan()
    remembered = undefined
    publish(IDLE_VIEW)
    deps.setSearching(false)
  }

  /** Shows the scan's next match once it is read, unless the query changed or the search ended meanwhile. */
  function advance(target: HistoryScan): void {
    showNextMatch(target).catch(logError)
  }

  async function showNextMatch(target: HistoryScan): Promise<void> {
    const match = await nextMatch(target)
    if (target !== scan) return
    if (match === undefined) {
      publish({ ...view, failed: true })
      return
    }
    deps.writePrompt(promptShowingMatch(match, target.query))
    publish({ query: view.query, match, failed: false })
  }

  return {
    start() {
      closeScan()
      remembered = deps.currentPrompt()
      publish(IDLE_VIEW)
      deps.setSearching(true)
    },

    setQuery(query) {
      if (query === view.query) return
      closeScan()
      if (query === '') {
        showRemembered()
        return
      }
      rememberedPrompt()
      publish({ ...view, query })
      scan = createHistoryScan(deps.readHistory(), query)
      advance(scan)
    },

    step() {
      if (view.query === '') {
        showRemembered()
        return
      }
      if (scan) advance(scan)
    },

    accept() {
      const { match } = view
      deps.writePrompt(match ? promptAcceptingMatch(match) : { pastedContents: rememberedPrompt().pastedContents })
      end()
    },

    cancel() {
      deps.writePrompt(rememberedPrompt())
      end()
    },

    submit() {
      const { query, match } = view
      const before = rememberedPrompt()
      if (query !== '' && match) deps.writePrompt({ mode: getModeFromInput(match.display) })
      end()
      if (query === '') deps.submit({ display: before.input, pastedContents: before.pastedContents })
      else if (match) deps.submit(entrySubmittingMatch(match))
    },

    dispose: closeScan,
  }
}

async function nextMatch(target: HistoryScan): Promise<HistoryEntry | undefined> {
  try {
    return await target.next()
  } catch (error) {
    // A history that cannot be read has no more matches to offer.
    logError(error)
    return undefined
  }
}
