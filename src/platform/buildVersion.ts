/**
 * The real package version, as the build inlined it.
 *
 * `scripts/build/build.ts` defines `MACRO.*` member by member and never `MACRO`
 * itself, so a `typeof MACRO` guard is false in the bundle and every shipped
 * binary took its fallback: transcripts said `"version":"unknown"` and the xAI
 * user agent `claudin/dev` (`src/__tests__/macroGuard.test.ts`). The member
 * read below is what the build replaces with a literal; under `bun test` and
 * direct `bun` runs nothing defines `MACRO`, and the read throws.
 */
export function getDisplayVersion(): string | undefined {
  try {
    return MACRO.DISPLAY_VERSION
  } catch (e) {
    if (e instanceof ReferenceError) return undefined
    throw e
  }
}
