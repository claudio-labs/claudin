import { isFullscreenEnvEnabled } from 'src/terminal/render/fullscreen.js'
import {
  openSidePanel,
  type SidePanelComponent,
} from 'src/terminal/sidePanelStore.js'

/**
 * Show the `/diff` reviewer in the side panel.
 *
 * The single opener behind both entry points — `ctrl+g` (`PromptInput`) and the
 * typed `/diff` (`src/commands/diff/diff.tsx`) — so the two can never drift.
 * Neither of them goes through the submit pipeline for it: opening a view is
 * not a turn, so there is no history entry, no `/diff` row in the transcript,
 * no spinner, and nothing to queue behind a streaming response.
 *
 * Returns false when there is no panel surface (inline / non-fullscreen), which
 * is the caller's signal to fall back to the local-jsx dialog.
 */
export async function openDiffPanel(): Promise<boolean> {
  if (!isFullscreenEnvEnabled()) return false
  const { DiffDialog } = await import('src/vcs/diff/ui/DiffDialog.js')
  openSidePanel(DiffDialog as SidePanelComponent)
  return true
}
