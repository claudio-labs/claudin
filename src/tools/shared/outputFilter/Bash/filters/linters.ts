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

import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'

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

// ===========================================================================
// Phase 13 — Python extras (rtk gap-fill): uv, poetry, basedpyright, ty.
// ===========================================================================

// --- uv sync / uv pip install ----------------------------------------------
const UV_MATCH = /^uv\s+(?:sync|pip\s+install)\b/
const UV_BLANK = /^\s*$/
const UV_DOWNLOADING = /^\s+Downloading\s/
const UV_USING_CACHED = /^\s+Using cached\s/
const UV_PREPARING = /^\s+Preparing\b/
// `Audited N packages` → nothing changed.
const UV_AUDITED = /Audited \d+ packages?/
// Errors AND warnings (yanked/deprecated package, etc.) both suppress the
// "up to date" sentinel — collapsing them would hide signal on an exit-0 sync.
const UV_HAS_PROBLEM = /\berror\b|\bwarning\b|could not|failed/i

export const uv: FilterSpec = {
  name: 'uv',
  matchCommand: UV_MATCH,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: UV_AUDITED,
      unless: UV_HAS_PROBLEM,
      message: '✓ uv: up to date',
    },
  ],
  stripLinesMatching: [UV_BLANK, UV_DOWNLOADING, UV_USING_CACHED, UV_PREPARING],
  maxLines: 20,
}

// --- poetry install / lock / update ----------------------------------------
const POETRY_MATCH = /^poetry\s+(?:install|lock|update)\b/
const POETRY_BLANK = /^\s*$/
const POETRY_DOWNLOADING = /^\s+[-•]\s+Downloading\s/
const POETRY_INSTALLING = /^\s+[-•]\s+Installing\s.*\(/
const POETRY_CREATING_VENV = /^Creating virtualenv/
const POETRY_USING_VENV = /^Using virtualenv/
const POETRY_NOCHANGE = /No dependencies to install or update|No changes\./
// Errors AND warnings both suppress the sentinel — a successful (exit-0) run
// can still print a warning we must not collapse away.
const POETRY_HAS_PROBLEM = /could not be resolved|\bSolverProblemError\b|\berror\b|\bwarning\b/i

export const poetry: FilterSpec = {
  name: 'poetry',
  matchCommand: POETRY_MATCH,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: POETRY_NOCHANGE,
      unless: POETRY_HAS_PROBLEM,
      message: '✓ poetry: up to date',
    },
  ],
  stripLinesMatching: [
    POETRY_BLANK,
    POETRY_DOWNLOADING,
    POETRY_INSTALLING,
    POETRY_CREATING_VENV,
    POETRY_USING_VENV,
  ],
  maxLines: 30,
}

// --- basedpyright ----------------------------------------------------------
// Both spellings: `basedpyright` is a fork of `pyright` and prints the same
// shape — `BASEDPYRIGHT_VERSION` below already accepted either banner, so the
// bare binary was a missing token rather than a design decision.
//
// The reach is small, and knowingly so: `pyright` as a Bash verb is claimed by
// the Typecheck redirect (`src/tools/TypecheckTool/detect.ts` maps
// /\bpyright\b/ to the pyright checker), so this spec only ever sees the
// one-shot escape past it. Measured over the whole recorded session corpus:
// two invocations, one of them refused.
const BASEDPYRIGHT_MATCH = /^(?:based)?pyright\b/
const BASEDPYRIGHT_REJECT = /(?:^|\s)--outputjson\b/
const BASEDPYRIGHT_BLANK = /^\s*$/
const BASEDPYRIGHT_SEARCHING = /^Searching for source files/
const BASEDPYRIGHT_FOUND = /^Found \d+ source file/
const BASEDPYRIGHT_VERSION = /^(?:Pyright|basedpyright) \d+\.\d+/

export const basedpyright: FilterSpec = {
  name: 'basedpyright',
  matchCommand: BASEDPYRIGHT_MATCH,
  matchCommandReject: BASEDPYRIGHT_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    BASEDPYRIGHT_BLANK,
    BASEDPYRIGHT_SEARCHING,
    BASEDPYRIGHT_FOUND,
    BASEDPYRIGHT_VERSION,
  ],
  collapseRuns: true,
  onEmpty: 'basedpyright: ok',
}

// No `maxLines` on either checker below, and it is not an omission. A matched
// spec's cap runs unconditionally — `withGenericFloor` returns early for a
// non-null spec, so `looksLikeDiagnostics` never gets to veto it — and the cut
// is to head+tail = 30 lines, not to `maxLines`. A 300-line diagnostic dump
// arrived as 31 lines. floor.ts calls a diagnostic list "precisely the output
// where the line that mattered is as likely to be the 40th", which is the case
// against capping it; these two specs print nothing else.

// --- ty (Astral type checker) ----------------------------------------------
const TY_MATCH = /^ty\b/
const TY_REJECT = /(?:^|\s)--output-format(?:=|\s+)(?:json|github)\b/
const TY_CHECKING = /^Checking \d+ file/
const TY_VERSION = /^ty \d+\.\d+/

export const ty: FilterSpec = {
  name: 'ty',
  matchCommand: TY_MATCH,
  matchCommandReject: TY_REJECT,
  stripAnsi: true,
  stripLinesMatching: [TY_CHECKING, TY_VERSION],
  collapseRuns: true,
  onEmpty: 'ty: ok',
}
