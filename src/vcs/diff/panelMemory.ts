import type { SelectedFileKey } from 'src/vcs/diff/ui/reselect.js'

/**
 * What the reviewer remembers between opens, for the length of the session.
 *
 * `ctrl+g` is a toggle now, so closing and reopening is a normal thing to do
 * mid-review — and remounting the dialog would otherwise drop the reader back
 * on the first file of the working tree every time. Scroll and expansions are
 * deliberately NOT here: they are offsets into a diff that may have changed
 * shape while the panel was closed, and restoring them would land somewhere
 * arbitrary rather than where the reader left off.
 *
 * In-memory and process-local: a new session starts fresh.
 */

export type DiffPanelMemory = {
  tab: 'local' | 'log'
  /** Index into the source list; the dialog clamps it into range. */
  sourceIndex: number
  /** The file that was selected, re-found by path on the next open. */
  selected: SelectedFileKey | null
}

const INITIAL: DiffPanelMemory = { tab: 'local', sourceIndex: 0, selected: null }

let memory: DiffPanelMemory = INITIAL

export function readDiffPanelMemory(): DiffPanelMemory {
  return memory
}

export function writeDiffPanelMemory(next: DiffPanelMemory): void {
  memory = next
}
