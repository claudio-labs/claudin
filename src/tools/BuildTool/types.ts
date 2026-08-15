import type { RawDiagnostic } from 'src/tools/shared/diagnostics/types.js'

/**
 * Normalized, toolchain-agnostic build model. One shape here is what lets the
 * tool speak the same structured language for cargo, gradle, maven, msbuild,
 * cmake, sbt, mix and the rest.
 *
 * Deliberately NOT the same model as `Typecheck`'s: there is no fingerprint and
 * no baseline. A build is incremental, so a second run prints nothing at all,
 * and recording that as the project's known backlog would mark the whole thing
 * as newly introduced on the next real build. The incremental case is reported
 * as `upToDate` instead of being explained away.
 */

/** The build system we detected/ran, used to pick a flag plan + parser list. */
export type BuildSystem =
  | 'cargo'
  | 'gradle'
  | 'maven'
  | 'sbt'
  | 'mill'
  | 'dotnet'
  | 'go'
  | 'cmake'
  | 'make'
  | 'ninja'
  | 'swift'
  | 'xcodebuild'
  | 'zig'
  | 'mix'
  | 'rebar3'
  | 'node'
  | 'flutter'
  | 'dart'
  | 'rake'
  | 'luarocks'
  | 'cabal'
  | 'stack'
  | 'unknown'

/** One more site collapsed into a diagnostic by (code, message) grouping. */
export type DiagnosticSite = {
  file: string
  line: number
}

export type BuildDiagnostic = RawDiagnostic & {
  /** A few source lines around file:line, attached by the runner. */
  excerpt?: string
  /** Further sites folded in by (code, message) grouping. */
  otherSites?: DiagnosticSite[]
}

/**
 * Why a run was stopped, and what it was doing at the time.
 *
 * Reported as observations, never as a verdict: linking a large binary and
 * javac on a cold daemon are both legitimately silent for minutes, so "no
 * output for 3m" is a fact the reader weighs, not a diagnosis of a hang.
 */
export type StallReport = {
  reason: 'idle' | 'ceiling'
  /** How long the command ran before it was stopped. */
  ranMs: number
  /** How long it had been silent when it was stopped. */
  silentMs: number
  /** The last non-empty line it printed, which is what names the phase. */
  lastLine?: string
}

/**
 * What the TUI shows while the build is still running.
 *
 * Declared here rather than added to the `ToolProgressData` union in
 * `src/shared/types/tools.js`, because that module does not exist in this fork — all
 * 19 imports of it are unresolved and stubbed at bundle time, so the union is
 * effectively `any`. Creating it to hold this one type would make every one of
 * those imports resolve at once against a partial file. Nothing needs the
 * membership: the only type-based dispatch on progress is `!== 'hook_progress'`
 * (`Tool.ts:348`, `AssistantToolUseMessage.tsx:348`).
 *
 * Never reaches the model — `normalizeMessagesForAPI` drops every `progress`
 * message before serialization (`utils/messages/normalize.ts:965`), so this
 * costs nothing in tokens and cannot undo what the tool trims.
 */
export type BuildProgress = {
  type: 'build_progress'
  system: BuildSystem
  /** What the build is doing, already reduced to one line. Empty until it prints. */
  label: string
  elapsedMs: number
  /** How long since the output last grew. Drives the "silent for Xs" state. */
  silentMs: number
  totalBytes: number
}

/** The normalized result of a whole build. */
export type BuildResult = {
  system: BuildSystem
  /** The exact command that ran, after flag injection. */
  command: string
  /**
   * Nothing was rebuilt — every target was already current. Reported instead of
   * a count, because a cached build prints no warnings and no artifacts, and
   * `0 warnings` would be a claim about compilation that never happened.
   */
  upToDate: boolean
  /**
   * Counts over the REPORTED scope — after the `severity` and `path` filters.
   * They agree with the list below by construction.
   */
  errors: number
  warnings: number
  /** Diagnostics the formatter may print, grouped by identity. */
  diagnostics: BuildDiagnostic[]
  /**
   * Artifacts the toolchain NAMED itself (cargo's `compiler-artifact`). Never
   * inferred from a directory listing: a stale binary from an earlier run looks
   * exactly like a fresh one, and reporting it as produced would be a lie about
   * the very thing the caller ran a build to confirm.
   */
  artifacts: string[]
  /**
   * The extracted "what went wrong" block for a failure that carries no
   * file:line — dependency resolution, a linker error, a failed task, an OOM.
   * This is the half of build failures no diagnostic parser can read.
   */
  failureBlock?: string
  /** Other build systems configured here that we did not run. */
  alsoDetected: BuildSystem[]
  /** The `path` argument, echoed so the reader knows the counts are scoped. */
  pathFilter?: string[]
  /** Diagnostics the path filter removed, so a filter matching nothing cannot read as clean. */
  hiddenByPathFilter?: number
  durationMs?: number
  /**
   * True when no machine-readable form was available and counts were scraped
   * from text. `diagnostics` may then be empty even with a non-zero exit.
   */
  degraded: boolean
  exitCode: number
  /** Set when the build could not start (no build system, missing binary). */
  runError?: string
  /** Set when the build was stopped by the idle watchdog or the wall ceiling. */
  stall?: StallReport
  /** A short tail of raw output, attached only on degraded runs. */
  stdoutTail?: string
}
