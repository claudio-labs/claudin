import {
  acquireFullscreenLease,
  canLeaseFullscreen,
  isFullscreenEnvEnabled,
} from 'src/terminal/render/fullscreen.js'
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
 * An inline session gets the panel too, by taking a fullscreen lease for as
 * long as it is open (the store hands it back on close). The lease is taken in
 * fullscreen as well, where it changes nothing, so the panel keeps the screen
 * even if another lease holder closes first.
 *
 * Returns false when there is no panel surface and no lease to be had
 * (`CLAUDIN_TEMP_FULLSCREEN=0`, `CLAUDIN_NO_FLICKER=0`, tmux -CC), which is
 * the caller's signal to fall back to the local-jsx dialog.
 */
export async function openDiffPanel(): Promise<boolean> {
  const canLease = canLeaseFullscreen()
  if (!isFullscreenEnvEnabled() && !canLease) return false
  const { DiffDialog } = await import('src/vcs/diff/ui/DiffDialog.js')
  openSidePanel(
    DiffDialog as SidePanelComponent,
    canLease ? acquireFullscreenLease : undefined,
  )
  return true
}
