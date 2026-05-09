// Linter filters: rubocop, ruff check.
//
// Rubocop's output is dominated by a long "new cops available" preamble that
// repeats verbatim on every run and has nothing to do with the user's code.
// Stripping it recovers most of the signal.
//
// Ruff on a clean run prints a single line, so for the clean case we just
// collapse with match_output; on dirty runs the diagnostics are the signal.
//
// Regex are declared at module level — see .claudio/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- rubocop -------------------------------------------------------------

// Two-alternation form avoids REDOS_PATTERNS #5 (nested optional with quantifier).
const RUBOCOP_MATCH = /^rubocop\b|^bundle\s+exec\s+rubocop\b/
// Intro paragraph at the top of the preamble.
const RUBOCOP_PREAMBLE_HEAD = /^The following cops were added to RuboCop/
const RUBOCOP_PREAMBLE_GUIDE = /^Please also note that you can opt-in/
// Two-line fragment: `  AllCops:` + `    NewCops: enable`.
const RUBOCOP_ALLCOPS_HINT = /^\s*AllCops:\s*$/
const RUBOCOP_NEWCOPS_HINT = /^\s*NewCops:\s/
// Cop entry header line: `Namespace/CopName: # new in 1.2`.
const RUBOCOP_COP_HEADER = /^[A-Z][A-Za-z]+\/[A-Z][A-Za-z0-9]+:\s*#\s*new in\s+\d/
// Indented sub-line: `  Enabled: true|pending|false`.
const RUBOCOP_COP_ENABLED = /^\s+Enabled:\s+(?:true|false|pending)\s*$/
// Legacy bullet form: `  * Name/Cop (1.2.3)` (kept for older rubocop versions).
const RUBOCOP_COP_BULLET = /^\s*\*\s+\S+\/\S+\s*\(/
// Closing link.
const RUBOCOP_INFO_PROSE = /^For more information:/

export const rubocop: FilterSpec = {
  name: 'rubocop',
  matchCommand: RUBOCOP_MATCH,
  stripAnsi: true,
  stripLinesMatching: [
    RUBOCOP_PREAMBLE_HEAD,
    RUBOCOP_PREAMBLE_GUIDE,
    RUBOCOP_ALLCOPS_HINT,
    RUBOCOP_NEWCOPS_HINT,
    RUBOCOP_COP_HEADER,
    RUBOCOP_COP_ENABLED,
    RUBOCOP_COP_BULLET,
    RUBOCOP_INFO_PROSE,
  ],
  // Collapse runs of identical blank lines created by the preamble strip.
  collapseRuns: true,
}

// --- ruff check ----------------------------------------------------------

const RUFF_MATCH = /^ruff\s+(?:check|\.)\b/
// Passthrough when the user asked for machine-readable output.
const RUFF_PASSTHROUGH = /--output-format(?:=|\s+)(?:json|junit|github|gitlab|grouped|pylint)\b/
const RUFF_OK = /^All checks passed!$/m
// Any indicator of diagnostics — do not collapse.
const RUFF_HAS_PROBLEM = /\b(?:error|Found\s+\d+\s+error|warning)\b/i

export const ruffCheck: FilterSpec = {
  name: 'ruff-check',
  matchCommand: RUFF_MATCH,
  matchCommandReject: RUFF_PASSTHROUGH,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: RUFF_OK,
      unless: RUFF_HAS_PROBLEM,
      message: '✓ ruff: all checks passed',
    },
  ],
}
