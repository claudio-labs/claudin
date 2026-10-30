/**
 * The real package version, as the build inlined it.
 *
 * `scripts/build/build.ts` defines `MACRO.*` member by member and never `MACRO`
 * itself, so a guard asking whether `MACRO` is defined is false in the bundle
 * and every shipped binary took its fallback: transcripts said `"version":"unknown"` and the xAI
 * user agent `claudin/dev` (`src/__tests__/macroGuard.test.ts`). The member
 * read below is what the build replaces with a literal; under `bun test` and
 * direct `bun` runs nothing defines `MACRO`, and the read throws.
 */
export function getDisplayVersion(): string | undefined {
  try {
    return MACRO.DISPLAY_VERSION
  } catch (e) {
    // ReferenceError: nothing defines MACRO. TypeError: a suite left it holding
    // undefined (`globalThis.MACRO = original` with no original to put back).
    if (e instanceof ReferenceError || e instanceof TypeError) return undefined
    throw e
  }
}
