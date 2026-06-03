// Linter filters: rubocop, ruff check + Phase 12 (shellcheck, yamllint,
// markdownlint, hadolint, pre-commit).
//
// Rubocop's output is dominated by a long "new cops available" preamble that
// repeats verbatim on every run and has nothing to do with the user's code.
// Stripping it recovers most of the signal.
//
// Ruff on a clean run prints a single line, so for the clean case we just
// collapse with match_output; on dirty runs the diagnostics are the signal.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

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

// --- shellcheck ----------------------------------------------------------

const SHELLCHECK_MATCH = /^shellcheck\b/
const SHELLCHECK_PASSTHROUGH = /(?:^|\s)(?:-f|--format)(?:=|\s+)(?:json|json1|gcc|checkstyle|diff|quiet)\b/
// "For more information:" + the two indented URL lines that follow. The
// URLs are reproducible (https://www.shellcheck.net/wiki/SCxxxx) and carry
// no diagnostic signal beyond the SCxxxx code already on the issue line.
const SHELLCHECK_INFO_HEADER = /^For more information:\s*$/
const SHELLCHECK_INFO_URL = /^\s+https:\/\/www\.shellcheck\.net\/wiki\/SC\d+/

export const shellcheck: FilterSpec = {
  name: 'shellcheck',
  matchCommand: SHELLCHECK_MATCH,
  matchCommandReject: SHELLCHECK_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [SHELLCHECK_INFO_HEADER, SHELLCHECK_INFO_URL],
  collapseRuns: true,
}

// --- yamllint ------------------------------------------------------------

const YAMLLINT_MATCH = /^yamllint\b/
const YAMLLINT_PASSTHROUGH = /(?:^|\s)-f(?:=|\s+)(?:parsable|github|colored|standard|auto|json)\b|--format(?:=|\s+)(?:parsable|github|colored|standard|auto|json)\b/
// yamllint's "standard" format collapses whitespace runs; trimming blank
// separators between files keeps the per-file diagnostic groups tight.
export const yamllint: FilterSpec = {
  name: 'yamllint',
  matchCommand: YAMLLINT_MATCH,
  matchCommandReject: YAMLLINT_PASSTHROUGH,
  stripAnsi: true,
  collapseRuns: true,
}

// --- markdownlint --------------------------------------------------------

const MARKDOWNLINT_MATCH = /^(?:markdownlint|mdl)\b/
const MARKDOWNLINT_PASSTHROUGH = /(?:^|\s)(?:-j|--json|--config(?:=|\s+)json)\b/
export const markdownlint: FilterSpec = {
  name: 'markdownlint',
  matchCommand: MARKDOWNLINT_MATCH,
  matchCommandReject: MARKDOWNLINT_PASSTHROUGH,
  stripAnsi: true,
  collapseRuns: true,
}

// --- hadolint ------------------------------------------------------------

const HADOLINT_MATCH = /^hadolint\b/
const HADOLINT_PASSTHROUGH = /(?:^|\s)(?:-f|--format)(?:=|\s+)(?:json|sonarqube|gitlab_codeclimate|codeclimate|checkstyle|sarif)\b/
export const hadolint: FilterSpec = {
  name: 'hadolint',
  matchCommand: HADOLINT_MATCH,
  matchCommandReject: HADOLINT_PASSTHROUGH,
  stripAnsi: true,
  collapseRuns: true,
}

// --- pre-commit ----------------------------------------------------------

// pre-commit's `run` output: one line per hook with `.....Passed` or
// `.....Failed`, followed (on failure only) by diagnostic blocks. The
// Passed lines are 100% noise once we're triaging a failed run; we strip
// them but keep Failed lines, hook headers ("- hook id:", "- exit code:"),
// and the diagnostic blocks themselves.
const PRECOMMIT_MATCH = /^pre-commit\s+run\b/
const PRECOMMIT_PASSTHROUGH = /(?:^|\s)(?:--color(?:=|\s+)never)\b/
const PRECOMMIT_PASSED_LINE = /^[^\n]+\.{3,}\s*Passed\s*$/

export const preCommit: FilterSpec = {
  name: 'pre-commit',
  matchCommand: PRECOMMIT_MATCH,
  matchCommandReject: PRECOMMIT_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [PRECOMMIT_PASSED_LINE],
  collapseRuns: true,
}

// --- mypy ----------------------------------------------------------------

const MYPY_MATCH = /^mypy\b|^python3?\s+-m\s+mypy\b/
// `--no-pretty` is already terse; structured formats keep raw.
const MYPY_REJECT = /(?:^|\s)(?:--output(?:=|\s+)json|--junit-xml)\b/

export const mypy: FilterSpec = {
  name: 'mypy',
  matchCommand: MYPY_MATCH,
  matchCommandReject: MYPY_REJECT,
  stripAnsi: true,
  collapseRuns: true,
}

// --- pip install --------------------------------------------------------

// pip install's progress section dominates the output. We strip:
//   - `Downloading <pkg>-<v>-<wheel>.whl (NkB)`
//   - `Using cached <pkg>-<v>-<wheel>.whl (NkB)`
//   - `Collecting <pkg>(==v)` (one per dep) — kept iff it's the *direct* dep
//     would require parsing; cheaper to just strip and keep the final summary
//   - `WARNING: Cache entry deserialization failed, entry ignored`
//   - `[notice] A new release of pip is available...` / `[notice] To update`
// We preserve `ERROR:`, `Successfully installed`, and any line with "error".
const PIP_INSTALL_MATCH = /^(?:pip3?|python3?\s+-m\s+pip)\s+install\b/
// `--dry-run` and `--quiet` already drop progress; `--report` is JSON.
const PIP_INSTALL_REJECT = /(?:^|\s)(?:--quiet|-q|--dry-run|--report)\b/
const PIP_DOWNLOADING = /^(?:\s+)?(?:Downloading|Using cached)\s+\S+\.whl/
const PIP_COLLECTING = /^Collecting\s/
const PIP_CACHE_WARN = /^WARNING:\s+Cache entry deserialization failed/
const PIP_NOTICE = /^\[notice\]\s/
const PIP_BUILDING_WHEEL = /^\s*Building wheel for\s/
const PIP_REQ_SATISFIED = /^Requirement already satisfied:/

export const pipInstall: FilterSpec = {
  name: 'pip-install',
  matchCommand: PIP_INSTALL_MATCH,
  matchCommandReject: PIP_INSTALL_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    PIP_DOWNLOADING,
    PIP_COLLECTING,
    PIP_CACHE_WARN,
    PIP_NOTICE,
    PIP_BUILDING_WHEEL,
    PIP_REQ_SATISFIED,
  ],
  collapseRuns: true,
}

// --- ruff format --------------------------------------------------------

const RUFF_FORMAT_MATCH = /^ruff\s+format\b/
const RUFF_FORMAT_REJECT = /(?:^|\s)(?:--check\s+--diff|--diff)\b/

export const ruffFormat: FilterSpec = {
  name: 'ruff-format',
  matchCommand: RUFF_FORMAT_MATCH,
  matchCommandReject: RUFF_FORMAT_REJECT,
  stripAnsi: true,
  collapseRuns: true,
}
