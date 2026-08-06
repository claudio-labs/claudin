/**
 * Normalized, checker-agnostic diagnostic model consumed by the baseline, the
 * dossier and the formatter. One shape here is what lets the tool speak the
 * same structured language for tsc, cargo check, pyright, go build, dart
 * analyze and the rest.
 *
 * The parser-facing half (`RawDiagnostic`, `ParseInput`, `ParsedDiagnostics`)
 * moved to `../shared/diagnostics/types.js` when `Build` began sharing the same
 * parsers, and is re-exported here so this file stays the one import site for
 * everything inside this tool.
 */

export type {
  ParseInput,
  ParsedDiagnostics,
  RawDiagnostic,
} from '../shared/diagnostics/types.js'

import type { RawDiagnostic } from '../shared/diagnostics/types.js'

/** The static checker we detected/ran, used to pick a flag plan + parser. */
export type Checker =
  | 'tsc'
  | 'deno'
  | 'cargo'
  | 'pyright'
  | 'mypy'
  | 'go'
  | 'dart'
  | 'dotnet'
  | 'maven'
  | 'gradle'
  | 'phpstan'
  | 'psalm'
  | 'unknown'

/**
 * Checkers that genuinely BUILD: they write artifacts to disk, run project
 * plugins and cost what a build costs. The other checkers only analyze. Callers
 * surface this so a "cheap check" never silently turns into a multi-minute
 * packaging run.
 */
export const BUILDING_CHECKERS: ReadonlySet<Checker> = new Set([
  'dotnet',
  'maven',
  'gradle',
])

/** Whether a diagnostic was already in the project's recorded backlog. */
export type DiagnosticStatus = 'new' | 'preexisting'

/** One more site collapsed into a diagnostic by (code, message) grouping. */
export type DiagnosticSite = {
  file: string
  line: number
}

export type Diagnostic = RawDiagnostic & {
  /**
   * Reserved for a second lane (lint) that can land without reshaping this
   * model. v1 only ever emits 'typecheck'.
   */
  source: 'typecheck'
  /**
   * Stable hash of file + code + message, deliberately EXCLUDING line/column:
   * inserting a line above an error must not resurface it as new.
   */
  fingerprint: string
  status: DiagnosticStatus
  /** A few source lines around file:line, attached by the dossier. */
  excerpt?: string
  /** Further sites folded in by (code, message) grouping. */
  otherSites?: DiagnosticSite[]
}

/**
 * How this run relates to the project's recorded backlog. `absent` is not a
 * failure — it is the honest answer when nothing can be claimed about
 * provenance, and the formatter says so rather than calling everything new.
 */
export type BaselineState =
  | { kind: 'matched'; sha: string }
  | {
      kind: 'captured'
      sha: string
      /**
       * How many diagnostics went into the baseline. NOT the displayed count:
       * capture records every diagnostic, including warnings the caller filtered
       * out and files outside a `path` scope, so a header quoting the visible
       * number would understate what it just made permanent.
       */
      recordedCount: number
      /**
       * Set when this capture replaced an earlier baseline that lacked some of
       * these diagnostics. Without it, committing broken code on a clean tree —
       * or forcing a re-capture at the same commit — would launder those errors
       * into the backlog and hide them forever. `prevSha === sha` means the
       * source did not move, so a toolchain or config change produced them.
       */
      introducedSincePrev?: { count: number; prevSha: string }
    }
  /**
   * Recorded by running the checker against a clean checkout of HEAD in a
   * detached worktree, because the live tree was dirty and no baseline existed.
   * Exact for HEAD — unlike `inherited` — and paid for once per commit.
   */
  | { kind: 'reconstructed'; sha: string; recordedCount: number }
  | {
      /**
       * No baseline for HEAD and the tree is too dirty to record one, so this
       * run was classified against the backlog recorded at an EARLIER commit.
       * Usable because a fingerprint is (path, code, message) and carries no
       * line number, so it survives the intervening edits — but diagnostics
       * those commits added are absent from it and therefore count as new,
       * which is why `behind` has to be shown.
       */
      kind: 'inherited'
      sha: string
      /** Commits between the recorded baseline and HEAD. */
      behind: number
    }
  | {
      kind: 'absent'
      reason: 'dirty-tree-no-baseline' | 'not-a-git-repo' | 'ignored'
    }

/**
 * What the TUI shows while the check is still running.
 *
 * Declared here rather than added to the `ToolProgressData` union in
 * `src/types/tools.js` for the same reason as `BuildProgress`: that module does
 * not exist in this fork and is stubbed at bundle time. Nothing needs the
 * membership — the only type-based dispatch on progress is
 * `!== 'hook_progress'`.
 *
 * Never reaches the model: `normalizeMessagesForAPI` drops every `progress`
 * message before serialization, so this costs nothing in tokens and cannot undo
 * what the tool trims.
 */
export type CheckProgress = {
  type: 'check_progress'
  checker: Checker
  /**
   * Which run is on screen. Reconstructing a baseline re-runs the same checker
   * against a detached checkout of HEAD, which can take as long again — without
   * naming that phase the clock just looks like it kept going after the check
   * was done.
   */
  phase: 'check' | 'baseline'
  /** What the checker last printed, reduced to one line. Empty until it prints. */
  label: string
  elapsedMs: number
}

/** The normalized result of a whole check. */
export type CheckResult = {
  checker: Checker
  /** The exact command that ran, after flag injection. */
  command: string
  /**
   * Counts over the REPORTED scope — after the `severity` and `path` filters,
   * before baseline classification. They agree with the list below by
   * construction, so a filter can never print a total the body contradicts.
   */
  errors: number
  warnings: number
  newCount: number
  preExistingCount: number
  /** Baseline entries that no longer reproduce — progress, worth one line. */
  fixedCount: number
  /** Diagnostics the formatter may print: the new ones, grouped and capped. */
  diagnostics: Diagnostic[]
  baseline: BaselineState
  /** Other checkers whose marker files are present but that we did not run. */
  alsoDetected: Checker[]
  /** The `path` argument, echoed so the reader knows the counts are scoped. */
  pathFilter?: string[]
  /**
   * Diagnostics the path filter removed. Without this a filter that matches
   * nothing renders as `✓ 0 new · 0 pre-existing` in a project with thousands
   * of errors — technically true of the filtered scope, and read as "clean".
   */
  hiddenByPathFilter?: number
  durationMs?: number
  /**
   * `baseline: "capture"` was asked for on a dirty tree and downgraded to
   * `auto`. Surfaced so the caller learns its re-record did not happen instead
   * of assuming a fresh backlog was written.
   */
  captureRefused?: boolean
  /**
   * True when no machine-readable form was available and counts were scraped
   * from text. `diagnostics` may then be empty even with a non-zero exit.
   */
  degraded: boolean
  exitCode: number
  /** Set when the check could not start (no checker, missing binary, timeout). */
  runError?: string
  /** A short tail of raw output, attached only on degraded runs. */
  stdoutTail?: string
}
