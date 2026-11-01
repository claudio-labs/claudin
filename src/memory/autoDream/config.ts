// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getInitialSettings } from 'src/platform/settings/settings.js'

/**
 * Whether background memory consolidation should run: unless the setting
 * `autoDreamEnabled` in settings.json is false. On by default since memory
 * hygiene (memoryHygiene.ts, 2026-10-31): the dream is the one pass that
 * merges and retires memories without being asked, and left opt-in, nothing
 * cleaned memory for anyone who never turned it on. At most once a day
 * after five sessions, and never in a `-p` run (autoDream.ts).
 */
export function isAutoDreamEnabled(): boolean {
  return getInitialSettings().autoDreamEnabled !== false
}
