// Ambient declarations for identifiers the bundler injects rather than the
// module graph. `scripts/build.ts` inlines every `MACRO.*` member through Bun's
// `define`, so nothing imports `MACRO` and `tsc` would otherwise report it as an
// undefined name at all ~140 use sites.
//
// Keep this in sync with the `MACRO.*` keys in `scripts/build.ts` — a member
// declared here but missing from `define` survives into the bundle verbatim and
// throws `ReferenceError: MACRO is not defined` when that line runs.
declare const MACRO: {
  /** Internal compatibility version, pinned to `99.0.0`. Never use for real version logic. */
  readonly VERSION: string
  /** The real package version — use this one for anything user-facing. */
  readonly DISPLAY_VERSION: string
  /** ISO timestamp of the build. */
  readonly BUILD_TIME: string
  /** Human-readable sentence telling the user where to report a problem. */
  readonly ISSUES_EXPLAINER: string
  /** Where to direct security/trust warnings that should never fire. */
  readonly FEEDBACK_CHANNEL: string
  /** npm package name of the JS distribution. */
  readonly PACKAGE_URL: string
  /** npm package name of the native binary distribution, if one exists. */
  readonly NATIVE_PACKAGE_URL: string | undefined
  /** Version of the bundled VS Code extension. */
  readonly IDE_EXTENSION_VERSION: string
}
