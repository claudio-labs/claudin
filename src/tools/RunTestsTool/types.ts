/**
 * Normalized, framework-agnostic test-run model produced by every parser and
 * consumed by the formatter / dossier. Keeping one shape here is what lets the
 * tool speak the same structured language for pytest, go test, vitest, JUnit
 * XML, TAP, etc.
 */

/** The kind of runner we detected/ran, used to pick a parser + reporter flag. */
export type Framework =
  | 'vitest'
  | 'jest'
  | 'bun'
  | 'mocha'
  | 'node-test'
  | 'pytest'
  | 'go'
  | 'cargo'
  | 'nextest'
  | 'rspec'
  | 'phpunit'
  | 'dotnet'
  | 'maven'
  | 'gradle'
  | 'deno'
  | 'dart'
  | 'ctest'
  | 'catch2'
  | 'doctest'
  | 'playwright'
  | 'pest'
  | 'elixir'
  | 'minitest'
  | 'unknown'

/** A single failing (or errored) test case. */
export type TestFailure = {
  /** Fully-qualified test name (suite › case) when available. */
  name: string
  /** Absolute or repo-relative source file the failure points at, if resolved. */
  file?: string
  /** 1-based line within `file`, if resolved. */
  line?: number
  /** Raw failure/assertion message from the reporter. */
  message: string
  /** Expected-vs-actual or stack body, when the reporter provides one. */
  diff?: string
  /** Dossier: a few source lines around `file:line`, filled post-parse. */
  excerpt?: string
  /** Dossier: one-line distilled summary of what went wrong. */
  summary?: string
}

/** The normalized result of a whole run. */
export type TestResult = {
  framework: Framework
  /** The exact command that was executed (after any reporter injection). */
  command: string
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs?: number
  failures: TestFailure[]
  /**
   * True when we could not parse structured results and fell back to returning
   * a raw text tail. `failures` may then be empty even if `failed > 0`.
   */
  degraded: boolean
  /** Process exit code (non-zero is normal on failure, never a tool error). */
  exitCode: number
  /** Set when the run itself could not start (bad command, timeout, etc.). */
  runError?: string
  /** A short tail of raw output, attached only on degraded (text-scraped) runs. */
  stdoutTail?: string
}

/**
 * Raw runner output (+ any reporter file it wrote) handed to the parse chain.
 * Parsers must be pure and never throw — on unrecognized input they return null
 * so the fallback chain can try the next one.
 */
export type ParseInput = {
  stdout: string
  stderr: string
  exitCode: number
  /** Contents of a reporter file (JUnit XML / TAP / JSON) when one was written. */
  reportContent?: string
}
