import * as React from 'react'
import type { LocalJSXCommandCall } from 'src/shared/types/command.js'
import { openDiffPanel } from 'src/vcs/diff/openDiffPanel.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  // In fullscreen the reviewer is a side panel with its own slot and its own
  // lifetime, so `/diff` must not hold the local-jsx promise open: that is what
  // kept the query guard reserved and the chat frozen for as long as the panel
  // was up. Resolve straight away with `skip` (no transcript rows) and hand
  // back null so no toolJSX is set — the panel is already on screen.
  if (await openDiffPanel()) {
    onDone(undefined, { display: 'skip' })
    return null
  }
  // Inline: no panel surface, so the dialog renders the way it always has.
  const { DiffDialog } = await import('src/vcs/diff/ui/DiffDialog.js')
  return <DiffDialog messages={context.messages} onDone={onDone} />
}
