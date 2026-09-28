/**
 * The inline prompt-history search. While the user types a query in the
 * footer, the prompt box shows the newest earlier prompt that contains it, and
 * Ctrl+R steps back through older ones. The hook renders nothing: it acts on
 * the caller's prompt through the setters it is handed, and reports the query,
 * the match and a failed match back. src/sessions/historySearch/inlineSearch.ts
 * holds the search itself. docs/tech/rewrite/sessions/historySearch.md
 * (section 2) is the spec.
 */
import { feature } from 'bun:bundle'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { makeHistoryReader } from 'src/agent/history.js'
import type { HistoryEntry } from 'src/platform/config/config.js'
import { createInlineSearch, IDLE_VIEW, type InlineSearch, type SearchView } from 'src/sessions/historySearch/inlineSearch.js'
import type { PromptSnapshot } from 'src/sessions/historySearch/promptSnapshot.js'
import { EMPTY_QUERY_BACKSPACE, SEARCH_KEY_OPERATIONS } from 'src/sessions/historySearch/searchKeys.js'
import type { PromptInputMode } from 'src/shared/types/textInputTypes.js'
import { KeyboardEvent } from 'src/terminal/ink/events/keyboard-event.js'
import { useInput } from 'src/terminal/ink.js'
import { useKeybinding, useKeybindings } from 'src/terminal/keybindings/useKeybinding.js'

type PastedContents = HistoryEntry['pastedContents']

type HistorySearchResult = {
  historyQuery: string
  setHistoryQuery: (query: string) => void
  historyMatch: HistoryEntry | undefined
  historyFailedMatch: boolean
  /**
   * Ends the search when a Backspace arrives on an empty query, and marks that
   * event handled. The hook already listens for this Backspace itself, so a
   * caller that wired this as well would see the search cancelled twice.
   */
  handleKeyDown: (e: KeyboardEvent) => void
}

/** What the caller hands in on each render: its prompt, and the setters that change it. */
type Caller = {
  prompt: PromptSnapshot
  onAcceptHistory: (entry: HistoryEntry) => void
  onInputChange: (input: string) => void
  onCursorChange: (cursorOffset: number) => void
  onModeChange: (mode: PromptInputMode) => void
  setIsSearching: (isSearching: boolean) => void
  setPastedContents: (pastedContents: PastedContents) => void
}

export function useHistorySearch(
  onAcceptHistory: (entry: HistoryEntry) => void,
  currentInput: string,
  onInputChange: (input: string) => void,
  onCursorChange: (cursorOffset: number) => void,
  currentCursorOffset: number,
  onModeChange: (mode: PromptInputMode) => void,
  currentMode: PromptInputMode,
  isSearching: boolean,
  setIsSearching: (isSearching: boolean) => void,
  setPastedContents: (pastedContents: PastedContents) => void,
  currentPastedContents: PastedContents,
): HistorySearchResult {
  const caller: Caller = {
    prompt: { input: currentInput, cursorOffset: currentCursorOffset, mode: currentMode, pastedContents: currentPastedContents },
    onAcceptHistory,
    onInputChange,
    onCursorChange,
    onModeChange,
    setIsSearching,
    setPastedContents,
  }
  // Keys and history reads land after a commit, so they act on the latest
  // committed prompt and setters rather than on those of an older render.
  const latest = useRef(caller)
  useLayoutEffect(() => {
    latest.current = caller
  })

  const [view, setView] = useState<SearchView>(IDLE_VIEW)
  const [search] = useState(() =>
    createInlineSearch({
      readHistory: makeHistoryReader,
      currentPrompt: () => latest.current.prompt,
      writePrompt: prompt => writePrompt(latest.current, prompt),
      setSearching: searching => latest.current.setIsSearching(searching),
      submit: entry => latest.current.onAcceptHistory(entry),
      onViewChange: setView,
    }),
  )
  useEffect(() => search.dispose, [search])

  const start = useCallback(() => search.start(), [search])
  // With the picker built in, Ctrl+R opens the picker instead, so the inline search cannot start.
  useKeybinding('history:search', start, {
    context: 'Global',
    isActive: feature('HISTORY_PICKER') ? false : !isSearching,
  })

  const keyHandlers = useMemo(() => searchKeyHandlers(search), [search])
  useKeybindings(keyHandlers, { context: 'HistorySearch', isActive: isSearching })

  // The query as rendered: a Backspace that the query box turns into an empty
  // query is an edit, and only the next one ends the search.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isSearching || view.query !== '' || e.key !== 'backspace') return
      e.preventDefault()
      search[EMPTY_QUERY_BACKSPACE]()
    },
    [isSearching, view.query, search],
  )
  useInput((_input, _key, event) => handleKeyDown(new KeyboardEvent(event.keypress)), { isActive: isSearching })

  return {
    historyQuery: view.query,
    setHistoryQuery: search.setQuery,
    historyMatch: view.match,
    historyFailedMatch: view.failed,
    handleKeyDown,
  }
}

function writePrompt(caller: Caller, prompt: Partial<PromptSnapshot>): void {
  if (prompt.input !== undefined) caller.onInputChange(prompt.input)
  if (prompt.cursorOffset !== undefined) caller.onCursorChange(prompt.cursorOffset)
  if (prompt.mode !== undefined) caller.onModeChange(prompt.mode)
  if (prompt.pastedContents !== undefined) caller.setPastedContents(prompt.pastedContents)
}

function searchKeyHandlers(search: InlineSearch): Record<string, () => void> {
  return Object.fromEntries(Object.entries(SEARCH_KEY_OPERATIONS).map(([action, operation]) => [action, () => search[operation]()]))
}
