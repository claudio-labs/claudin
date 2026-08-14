// JS/TS test-runner filters: jest, vitest, bun test, mocha, playwright.
//
// All five share the same shape as pytest/rspec/go-test (filters/tests.ts):
// strip per-test progress lines (P), collapse on success (M). An `unless`
// guard keeps real failures intact so the agent still sees stack traces.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from 'src/outputFilter/Bash/types.js'

// --- jest ----------------------------------------------------------------

const JEST_MATCH = /^(?:npx jest|yarn jest|pnpm jest|bunx jest|jest)\b/
// Passthrough for interactive / introspection modes whose output is the signal.
const JEST_PASSTHROUGH = /(?:^|\s)(?:--watch\b|--listTests\b|--showSeed\b|--ci=false\b|--debug\b)/
// Carousel "RUNS  ..." while tests execute — pure noise after the run finishes.
const JEST_STRIP_RUNS = /^\s*RUNS\s/
// Individual indented `✓ test name (Nms)` lines under each describe block.
const JEST_STRIP_TEST_OK = /^\s+✓\s/
// Two-alternation form avoids REDOS_PATTERNS #5 (nested optional with quantifier).
const JEST_OK = /^Tests:\s+\d+\s+passed,\s+\d+\s+total\s*$/m
const JEST_HAS_PROBLEM = /\b(?:failed|FAIL\b|errors?\s+\d|Test Suites:\s+\d+\s+failed)/

export const jest: FilterSpec = {
  name: 'jest',
  matchCommand: JEST_MATCH,
  matchCommandReject: JEST_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [JEST_STRIP_RUNS, JEST_STRIP_TEST_OK],
  matchOutput: [
    {
      pattern: JEST_OK,
      unless: JEST_HAS_PROBLEM,
      message: '✓ jest: all tests passed',
    },
  ],
}

// --- vitest --------------------------------------------------------------

const VITEST_MATCH = /^(?:npx vitest|yarn vitest|pnpm vitest|bunx vitest|vitest)\b/
const VITEST_PASSTHROUGH = /(?:^|\s)(?:--watch\b|--ui\b|--inspect\b|--reporter=(?:verbose|json|junit))/
// Indented per-test `✓ describe > it Nms` lines.
const VITEST_STRIP_TEST_OK = /^\s+✓\s/
// Header banner.
const VITEST_STRIP_RUN = /^\s*RUN\s+v\d/
// Clean-run sentinels: prefer the explicit "Tests" line which carries the count.
const VITEST_OK = /^\s*Tests\s+\d+\s+passed\s+\(\d+\)\s*$/m
const VITEST_HAS_PROBLEM = /\b(?:failed|FAIL\b|error)\b/i

export const vitest: FilterSpec = {
  name: 'vitest',
  matchCommand: VITEST_MATCH,
  matchCommandReject: VITEST_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [VITEST_STRIP_RUN, VITEST_STRIP_TEST_OK],
  matchOutput: [
    {
      pattern: VITEST_OK,
      unless: VITEST_HAS_PROBLEM,
      message: '✓ vitest: all tests passed',
    },
  ],
}

// --- bun test ------------------------------------------------------------

const BUN_TEST_MATCH = /^bun\s+test\b/
const BUN_TEST_PASSTHROUGH = /(?:^|\s)(?:--watch\b|--reporter=junit\b|--inspect-brk?\b)/
// Per-test `✓ name [Nms]` lines (bun emits these unindented under each file).
const BUN_TEST_STRIP_TEST_OK = /^✓\s/
// Header banner.
const BUN_TEST_STRIP_BANNER = /^bun\s+test\s+v[\d.]+/
// Clean-run sentinel: "N pass\n 0 fail" pair.
// Two-alternation form avoids REDOS_PATTERNS #5.
const BUN_TEST_OK = /^\s*\d+\s+pass\s*$/m
const BUN_TEST_HAS_PROBLEM = /^\s*[1-9]\d*\s+fail\s*$|\bFAIL\b|\bpanic\b|\berror\b/m

export const bunTest: FilterSpec = {
  name: 'bun-test',
  matchCommand: BUN_TEST_MATCH,
  matchCommandReject: BUN_TEST_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [BUN_TEST_STRIP_BANNER, BUN_TEST_STRIP_TEST_OK],
  matchOutput: [
    {
      pattern: BUN_TEST_OK,
      unless: BUN_TEST_HAS_PROBLEM,
      message: '✓ bun test: all tests passed',
    },
  ],
}

// --- mocha ---------------------------------------------------------------

const MOCHA_MATCH = /^(?:npx mocha|yarn mocha|pnpm mocha|mocha)\b/
const MOCHA_PASSTHROUGH = /(?:^|\s)(?:--reporter=(?:json|tap|xunit)|--watch\b|--inspect\b)/
// Indented `✓ name (Nms)` lines (mocha 2-space-indent default reporter).
const MOCHA_STRIP_TEST_OK = /^\s+✓\s/
// Two-alternation form avoids REDOS_PATTERNS #5.
const MOCHA_OK = /^\s*\d+\s+passing\s+\([\dms.\s]+\)\s*$/m
const MOCHA_HAS_PROBLEM = /\b(?:failing|pending|error)\b/i

export const mocha: FilterSpec = {
  name: 'mocha',
  matchCommand: MOCHA_MATCH,
  matchCommandReject: MOCHA_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [MOCHA_STRIP_TEST_OK],
  matchOutput: [
    {
      pattern: MOCHA_OK,
      unless: MOCHA_HAS_PROBLEM,
      message: '✓ mocha: all tests passed',
    },
  ],
}

// --- playwright ----------------------------------------------------------

// Two-word verb: requires command-form match.
const PLAYWRIGHT_MATCH = /^(?:npx playwright|playwright)\s+test\b/
const PLAYWRIGHT_PASSTHROUGH =
  /(?:^|\s)(?:--ui\b|--debug\b|--reporter=(?:json|junit|line|null))/
// Indented `✓  N [project] › file.spec.ts:L:C › title (Ns)` lines — one per test.
const PLAYWRIGHT_STRIP_TEST_OK = /^\s+✓\s/
const PLAYWRIGHT_OK = /^\s*\d+\s+passed\s+\([\dhms.\s]+\)\s*$/m
const PLAYWRIGHT_HAS_PROBLEM = /\b(?:failed|flaky|timed\s+out|interrupted|did\s+not\s+run)\b/i

export const playwright: FilterSpec = {
  name: 'playwright',
  matchCommand: PLAYWRIGHT_MATCH,
  matchCommandReject: PLAYWRIGHT_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [PLAYWRIGHT_STRIP_TEST_OK],
  matchOutput: [
    {
      pattern: PLAYWRIGHT_OK,
      unless: PLAYWRIGHT_HAS_PROBLEM,
      message: '✓ playwright: all tests passed',
    },
  ],
}
