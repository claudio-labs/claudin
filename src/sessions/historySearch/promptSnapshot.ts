/**
 * The prompt box as the inline search sees it: the four things a search
 * changes, as one value. A search remembers one when it starts and puts all
 * of it back when it is cancelled.
 */
import type { HistoryEntry } from 'src/platform/config/config.js'
import type { PromptInputMode } from 'src/shared/types/textInputTypes.js'
import { getModeFromInput, getValueFromInput } from 'src/terminal/prompt-input/inputModes.js'

export type PromptSnapshot = {
  readonly input: string
  readonly cursorOffset: number
  readonly mode: PromptInputMode
  readonly pastedContents: HistoryEntry['pastedContents']
}

/** The prompt while `match` is shown for `query`: the stored text, `!` included, in its mode, with its pastes. */
export function promptShowingMatch(match: HistoryEntry, query: string): PromptSnapshot {
  return {
    input: match.display,
    cursorOffset: queryOffset(match.display, query),
    mode: getModeFromInput(match.display),
    pastedContents: match.pastedContents,
  }
}

/** What accepting a match leaves in the prompt. The cursor stays where the search put it. */
export function promptAcceptingMatch(match: HistoryEntry): Omit<PromptSnapshot, 'cursorOffset'> {
  return {
    input: getValueFromInput(match.display),
    mode: getModeFromInput(match.display),
    pastedContents: match.pastedContents,
  }
}

/** What submitting a match sends: its text without the mode character, with its pastes. */
export function entrySubmittingMatch(match: HistoryEntry): HistoryEntry {
  return { display: getValueFromInput(match.display), pastedContents: match.pastedContents }
}

/**
 * The last occurrence of the query in the text as the prompt shows it (without
 * the `!`). A query that only occurs through the `!` keeps its offset in the
 * stored text instead. The prompt input's highlight then starts one character
 * late, and fixing that means changing the highlight too, so it stays.
 */
function queryOffset(display: string, query: string): number {
  const shown = getValueFromInput(display).lastIndexOf(query)
  return shown === -1 ? display.lastIndexOf(query) : shown
}
