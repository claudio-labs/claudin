// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getInitialSettings } from 'src/platform/settings/settings.js'

/**
 * Whether background memory consolidation should run: only when the user
 * setting `autoDreamEnabled` in settings.json is true. Off by default.
 */
export function isAutoDreamEnabled(): boolean {
  return getInitialSettings().autoDreamEnabled === true
}
