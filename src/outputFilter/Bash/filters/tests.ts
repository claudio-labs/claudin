// Test-runner filters: pytest, rspec, go test.
//
// All three follow the same pattern: strip per-test noise (P), then match a
// success sentinel (M). An `unless` guard keeps errors/failures intact.
//
// Regex are declared at module level — see .claudio/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- pytest --------------------------------------------------------------

const PYTEST_MATCH = /^(pytest|python\s+-m\s+pytest|py\.test)\b/
// Passthrough for compact output modes the user explicitly asked for.
const PYTEST_PASSTHROUGH = /(?:^|\s)(?:--tb=(?:line|no)|--co|--collect-only|--lf|--last-failed|-x|--json-report)\b/
const PYTEST_STRIP_WARNINGS = /^=+\s*warnings summary\s*=+$/
const PYTEST_STRIP_DEPRECATION = /^PytestDeprecationWarning/
const PYTEST_STRIP_UNRAISABLE = /^PytestUnraisableExceptionWarning/
// Clean-run sentinel: the final "=== N passed in T.Ts ===" summary line.
const PYTEST_OK = /^=+\s*\d+\s+passed(?:,\s*\d+\s+(?:deselected|skipped|xfailed|xpassed|warnings?))*\s+in\s+[\d.]+s\s*=+$/m
// Safety guard — any signal of failure/error must block the collapse.
const PYTEST_HAS_PROBLEM = /\b(failed|error|FAILED|ERROR)\b/

export const pytest: FilterSpec = {
  name: 'pytest',
  matchCommand: PYTEST_MATCH,
  matchCommandReject: PYTEST_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [
    PYTEST_STRIP_WARNINGS,
    PYTEST_STRIP_DEPRECATION,
    PYTEST_STRIP_UNRAISABLE,
  ],
  maxLines: 100,
  matchOutput: [
    {
      pattern: PYTEST_OK,
      unless: PYTEST_HAS_PROBLEM,
      message: '✓ pytest: all tests passed',
    },
  ],
}

// --- rspec ---------------------------------------------------------------

// Two-alternation form avoids the heuristic's "nested optional with quantifier"
// flag (see REDOS_PATTERNS #5 in userFilters.ts). Semantically identical to
// `^(?:bundle\s+exec\s+)?rspec\b`.
const RSPEC_MATCH = /^rspec\b|^bundle\s+exec\s+rspec\b/
// Passthrough — JSON or documentation formatters.
const RSPEC_PASSTHROUGH = /--format(?:=|\s+)(?:json|j|documentation|doc|d)\b/
// Strip per-test progress dots on the first non-empty line (e.g. "....F..")
// and strip the "Randomized with seed …" footer noise.
const RSPEC_STRIP_SEED = /^Randomized with seed \d+/
// Clean-run sentinel: "N examples, 0 failures[, M pending]".
const RSPEC_OK = /^\d+\s+examples?,\s*0\s+failures(?:,\s*\d+\s+pending)?(?:,\s*\d+\s+errors?\s+outside\s+of\s+examples)?$/m
const RSPEC_HAS_PROBLEM = /\b(?:failure|failed|error|ERROR|pending)\b/

export const rspec: FilterSpec = {
  name: 'rspec',
  matchCommand: RSPEC_MATCH,
  matchCommandReject: RSPEC_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [RSPEC_STRIP_SEED],
  matchOutput: [
    {
      pattern: RSPEC_OK,
      // Note: RSPEC_OK already requires "0 failures" so the guard only has to
      // catch the explicit-failure prose ("1 failure", "failed", panic lines).
      unless: /\b(?:failed|failure[s]?:|FAIL|error[s]?:|Exception)\b/,
      message: '✓ rspec: all tests passed',
    },
  ],
}

// --- go test -------------------------------------------------------------

const GO_TEST_MATCH = /^go\s+test\b/
// Passthrough — JSON output or benchmark-only.
const GO_TEST_PASSTHROUGH = /(?:^|\s)(?:-json\b|--json\b|-bench\b)/
// Strip verbose per-test progress lines.
const GO_TEST_STRIP_RUN = /^=== (?:RUN|PAUSE|CONT)\s/
const GO_TEST_STRIP_PASS = /^\s*--- PASS:\s/
const GO_TEST_STRIP_BARE_PASS = /^PASS$/
// Clean-run sentinel: the final "ok <pkg> <time>" summary.
// Two-alternation form avoids REDOS_PATTERNS #5 (nested optional with quantifier).
const GO_TEST_OK = /^ok\s+\S+\s+[\d.]+s$|^ok\s+\S+\s+[\d.]+s\s+coverage:.*$/m
const GO_TEST_HAS_PROBLEM = /^(?:--- FAIL:|FAIL\b|panic:|--- SKIP:)/m

export const goTest: FilterSpec = {
  name: 'go-test',
  matchCommand: GO_TEST_MATCH,
  matchCommandReject: GO_TEST_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [
    GO_TEST_STRIP_RUN,
    GO_TEST_STRIP_PASS,
    GO_TEST_STRIP_BARE_PASS,
  ],
  matchOutput: [
    {
      pattern: GO_TEST_OK,
      unless: GO_TEST_HAS_PROBLEM,
      message: '✓ go test: all tests passed',
    },
  ],
}
