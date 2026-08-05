/**
 * The vocabulary every diagnostic parser in this directory speaks.
 *
 * Deliberately smaller than what either consumer stores: a parser returns
 * position + text and nothing derived, so fingerprinting (Typecheck),
 * excerpts, grouping and baseline classification can all be added downstream
 * without a parser knowing which tool called it.
 */

/**
 * What a parser produces: position + text, nothing derived.
 */
export type RawDiagnostic = {
  /** Path as the checker printed it — resolved against cwd downstream. */
  file: string
  /** 1-based line. Checkers that omit it report 0, which never resolves an excerpt. */
  line: number
  /** 1-based column when the checker gives one. */
  column?: number
  severity: 'error' | 'warning'
  /** Checker-native rule id: TS2322, E0308, reportGeneralTypeIssues, CS0103… */
  code?: string
  /**
   * Full message including any indented continuation lines (tsc chains
   * "Types of parameters … are incompatible" under the head line). Kept whole
   * because Typecheck's fingerprint hashes it: a chain that changes IS a
   * different error.
   */
  message: string
}

/**
 * Raw output handed to the parse chain. Parsers must be pure and never throw —
 * on unrecognized input they return null so the chain can fall through.
 */
export type ParseInput = {
  stdout: string
  stderr: string
  exitCode: number
}

/** What a parser returns: diagnostics, or null when the shape is not its own. */
export type ParsedDiagnostics = {
  diagnostics: RawDiagnostic[]
} | null

/** A pure function from raw output to diagnostics, or null if it does not apply. */
export type DiagnosticParser = (input: ParseInput) => ParsedDiagnostics
