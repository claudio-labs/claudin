// Reconstructed from its use sites: the original module was not carried into
// this fork. The shape comes from the construction in
// `generateFileSuggestions` (`src/terminal/prompt-suggestion/fileSuggestions.ts`) and is consumed by
// `executeFileSuggestionCommand` (`src/services/lifecycleHooks/replHooks.ts`).
//
// Like the statusLine payload this is JSON-serialised onto a user command's
// stdin, so the snake_case names from `createBaseHookInput()` are part of the
// public contract.

/**
 * Fields every hook payload carries, produced by `createBaseHookInput()`
 * in `src/services/lifecycleHooks/shared.ts`.
 */
type BaseHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
}

export type FileSuggestionCommandInput = BaseHookInput & {
  /** The partial path typed so far. Empty when triggered by a bare `@`. */
  query: string
}
