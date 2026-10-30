/**
 * User-Agent for xAI / Grok OAuth + API requests.
 *
 * Kept separate from `getClaudinUserAgent()` because that helper reads the
 * build-time `MACRO.DISPLAY_VERSION` constant directly, which throws under
 * `bun test`. The xAI flow's UA is sent to xAI's servers, not Anthropic's —
 * there's no SDK contract to preserve, just an honest identifier, and `dev`
 * where no build inlined the version.
 */
import { getDisplayVersion } from 'src/platform/buildVersion.js'

export function getXaiUserAgent(): string {
  return `claudin/${getDisplayVersion() ?? 'dev'}`
}
