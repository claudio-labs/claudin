
import { getInitialSettings } from 'src/platform/settings/settings.js'

/**
 * Whether background memory consolidation should run: only when the user
 * setting `autoDreamEnabled` in settings.json is true. Off by default.
 */
export function isAutoDreamEnabled(): boolean {
  return getInitialSettings().autoDreamEnabled === true
}
