// Cargo filters: cargo build, cargo check, cargo test, cargo clippy.
//
// Cold builds print "Compiling <dep> v1.2.3" once per transitive dependency;
// for a non-trivial project this can run to hundreds of lines of pure noise.
// We strip those but keep the main-crate line intact because it carries the
// project path (`Compiling foo v0.1 (/abs/path)`).
//
// For build / check, on a clean success we collapse to a one-line sentinel.
// For clippy we never collapse: warnings are the whole signal.
//
// Regex are declared at module level — see .claude/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// Shared strip patterns ---------------------------------------------------

// `Compiling <crate> v1.2.3` (no trailing path → a transitive dep)
const CARGO_COMPILING_DEP = /^\s*Compiling\s+\S+\s+v\d+[^\s]*\s*$/
// `Checking <crate> v1.2.3` (same shape)
const CARGO_CHECKING_DEP = /^\s*Checking\s+\S+\s+v\d+[^\s]*\s*$/
// Download/update chatter from cargo fetch
const CARGO_DOWNLOADING = /^\s*(?:Downloading|Downloaded|Updating|Fetching)\s/

const CARGO_STRIP_BASE = [
  CARGO_COMPILING_DEP,
  CARGO_CHECKING_DEP,
  CARGO_DOWNLOADING,
]

// Shared sentinels --------------------------------------------------------

// `Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.05s`
// (cargo 1.76+) or the older `Finished dev [unoptimized...]` form.
// Matching on just the prefix + tail avoids the nested-optional heuristic
// (REDOS_PATTERNS #5). `Finished ...\s+in [\d.]+s` is unambiguous in cargo output.
const CARGO_FINISHED = /^\s*Finished\s.*\s+in\s+[\d.]+s\s*$/m
// `error[E0308]: ...`, `error: ...`, or the summary `error: could not compile`
const CARGO_HAS_ERROR = /^(?:error(?:\[E\d+\])?:|warning:\s+unused)/m

// --- cargo build ---------------------------------------------------------

const CARGO_BUILD_MATCH = /^cargo\s+build\b/
const CARGO_BUILD_PASSTHROUGH = /--message-format(?:=|\s+)(?:json|short)\b/

export const cargoBuild: FilterSpec = {
  name: 'cargo-build',
  matchCommand: CARGO_BUILD_MATCH,
  matchCommandReject: CARGO_BUILD_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: CARGO_STRIP_BASE,
  matchOutput: [
    {
      pattern: CARGO_FINISHED,
      unless: CARGO_HAS_ERROR,
      message: '✓ cargo build: ok',
    },
  ],
}

// --- cargo check ---------------------------------------------------------

const CARGO_CHECK_MATCH = /^cargo\s+check\b/
const CARGO_CHECK_PASSTHROUGH = /--message-format(?:=|\s+)(?:json|short)\b/

export const cargoCheck: FilterSpec = {
  name: 'cargo-check',
  matchCommand: CARGO_CHECK_MATCH,
  matchCommandReject: CARGO_CHECK_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: CARGO_STRIP_BASE,
  matchOutput: [
    {
      pattern: CARGO_FINISHED,
      unless: CARGO_HAS_ERROR,
      message: '✓ cargo check: ok',
    },
  ],
}

// --- cargo test ----------------------------------------------------------

const CARGO_TEST_MATCH = /^cargo\s+test\b/
// Passthrough for any mode that either renders JSON or suppresses output:
// --no-run (0% ROI on norun samples), --quiet, --message-format=json.
const CARGO_TEST_PASSTHROUGH =
  /(?:^|\s)(?:--no-run|-q|--quiet|--message-format(?:=|\s+)(?:json|short))\b/
// Two-alternation form avoids REDOS_PATTERNS #5 (nested optional with quantifier).
const CARGO_TEST_STRIP_RUNNING = /^\s*Running\s+\S+|^\s*Running\s+unittests\s+\S+/
const CARGO_TEST_STRIP_INDIVIDUAL = /^test\s+\S+\s+\.\.\.\s+ok\s*$/
const CARGO_TEST_STRIP_START = /^running\s+\d+\s+tests?$/
const CARGO_TEST_OK = /^test result: ok\. \d+ passed; 0 failed(?:; \d+ ignored)?(?:; \d+ measured)?(?:; \d+ filtered out)?/m
const CARGO_TEST_HAS_PROBLEM = /\bFAILED\b|failures:|^panicked/m

export const cargoTest: FilterSpec = {
  name: 'cargo-test',
  matchCommand: CARGO_TEST_MATCH,
  matchCommandReject: CARGO_TEST_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [
    ...CARGO_STRIP_BASE,
    CARGO_TEST_STRIP_RUNNING,
    CARGO_TEST_STRIP_INDIVIDUAL,
    CARGO_TEST_STRIP_START,
  ],
  matchOutput: [
    {
      pattern: CARGO_TEST_OK,
      unless: CARGO_TEST_HAS_PROBLEM,
      message: '✓ cargo test: all tests passed',
    },
  ],
}

// --- cargo clippy --------------------------------------------------------

const CARGO_CLIPPY_MATCH = /^cargo\s+clippy\b/
// Clippy warnings *are* the signal — never collapse via matchOutput.
// We still strip the "Compiling <dep>" noise and the download preamble.
export const cargoClippy: FilterSpec = {
  name: 'cargo-clippy',
  matchCommand: CARGO_CLIPPY_MATCH,
  stripAnsi: true,
  stripLinesMatching: CARGO_STRIP_BASE,
  collapseRuns: true,
}
