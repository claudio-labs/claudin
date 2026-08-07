/**
 * User-Agent for xAI / Grok OAuth + API requests.
 *
 * Kept separate from `getClaudinUserAgent()` because that helper reads the
 * build-time `MACRO.DISPLAY_VERSION` constant which is not defined under
 * `bun test` (it's inlined by `scripts/build.ts`). The xAI flow's UA is
 * sent to xAI's servers, not Anthropic's — there's no SDK contract to
 * preserve, just an honest identifier.
 */

function readMacroDisplayVersion(): string | undefined {
  // `MACRO.DISPLAY_VERSION` is inlined at build time. Under tests / direct
  // bun runs the global is undefined, so guard with typeof + try/catch.
  try {
    if (typeof MACRO !== 'undefined' && typeof MACRO.DISPLAY_VERSION === 'string') {
      return MACRO.DISPLAY_VERSION
    }
  } catch {
    return undefined
  }
  return undefined
}

export function getXaiUserAgent(): string {
  const version = readMacroDisplayVersion() ?? 'dev'
  return `claudin/${version}`
}
