/**
 * User-Agent for Kimi Code OAuth + coding API requests.
 *
 * The Kimi Code backend inspects the User-Agent (and the `X-Msh-*` headers in
 * `kimiDeviceHeaders.ts`); it must match the official CLI shape
 * `kimi-code-cli/<version>` or requests are rejected. Kept separate from
 * `getClaudinUserAgent()` because that helper reads the build-time
 * `MACRO.DISPLAY_VERSION` constant which is undefined under `bun test`.
 */

import { getKimiCliVersion } from '../services/api/kimiOAuthShared.js'

export function getKimiUserAgent(): string {
  return `kimi-code-cli/${getKimiCliVersion()}`
}
