/**
 * What each key does to a running inline search. The keys themselves are the
 * `HistorySearch` context's bindings in src/terminal/keybindings/defaultBindings.ts.
 */

/** The operations a key can run on a search. Each ends the search except `step`. */
export type SearchOperation = 'step' | 'accept' | 'cancel' | 'submit'

export const SEARCH_KEY_OPERATIONS: Readonly<Record<string, SearchOperation>> = {
  'historySearch:next': 'step',
  'historySearch:accept': 'accept',
  'historySearch:cancel': 'cancel',
  'historySearch:execute': 'submit',
}

/** Backspace on an empty query. It has no binding, since what it does depends on the query. */
export const EMPTY_QUERY_BACKSPACE: SearchOperation = 'cancel'
