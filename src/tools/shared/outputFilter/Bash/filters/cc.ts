// C/C++ / native build filters — Phase 13 (rtk gap-fill).
//
//   - gcc / g++ : strip the `In file included from …` include chain and the
//     `N warnings/errors generated` tallies; keep the diagnostics + carets.
//   - make      : strip recursive `Entering/Leaving directory` markers and the
//     `Nothing to be done` / `is up to date` no-ops; keep recipe echoes and any
//     `*** Error` line. A failed make exits non-zero → the whole filter is
//     bypassed upstream (index.ts:101), so maxLines only ever clips a *successful*
//     build.
//   - pio run   : strip the PlatformIO build ceremony (Compiling/Linking/…) but
//     preserve the RAM/Flash usage table (it matches no strip rule) and errors.
//
// Conservative by design (user decision): we never collapse a build to a
// sentinel — only strip known-noise lines and fall back to `onEmpty` when
// nothing but noise remained.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'

// --- gcc / g++ -------------------------------------------------------------

// `gcc`, `g++`, and versioned forms `gcc-13` / `g++-14`. A `\b` after `++`
// would not match (`+` is non-word, so there's no boundary before a space), so
// we anchor the end with a literal `(?:\s|$)`. `[\d.-]*` absorbs a version
// suffix without a nested-optional quantifier (keeps the ReDoS scan happy).
//
// `clang`/`clang++` (and `clang-18`) share the arm because they share the
// output: the `In file included from`, caret-row and `N warnings generated.`
// shapes stripped below are clang's own — the tally line was copied from clang
// in the first place.
const GCC_MATCH = /^(?:g(?:cc|\+\+)|clang(?:\+\+)?)[\d.-]*(?:\s|$)/
// `gcc -M`/`-MM` emit makefile dependency rules — machine-readable, keep raw.
const GCC_REJECT = /(?:^|\s)-M{1,2}\b/
// `In file included from a.h:1:` and its `                 from b.h:2:` continuations.
const GCC_INCLUDE_FROM = /^In file included from /
const GCC_INCLUDE_CONT = /^\s+from\s/
// New-style caret separator rows: `    |` with nothing else.
const GCC_CARET_SEP = /^\s+\|\s*$/
// `2 warnings generated.` / `1 error generated.` tallies (clang/gcc).
const GCC_TALLY = /^\d+ (?:warnings?|errors?) generated\.?\s*$/

export const gccCompile: FilterSpec = {
  name: 'gcc',
  matchCommand: GCC_MATCH,
  matchCommandReject: GCC_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    GCC_INCLUDE_FROM,
    GCC_INCLUDE_CONT,
    GCC_CARET_SEP,
    GCC_TALLY,
  ],
  collapseRuns: true,
  maxLines: 50,
  onEmpty: 'gcc: ok',
}

// --- make ------------------------------------------------------------------

const MAKE_MATCH = /^make\b/
// Recursive build markers — pure noise. We match the numbered (`make[1]:`) and
// unnumbered forms but ONLY for the specific no-op phrases, so a real
// `make[1]: *** [target] Error 1` line is never stripped.
const MAKE_ENTERING = /^make(?:\[\d+\])?:\s+Entering directory\b/
const MAKE_LEAVING = /^make(?:\[\d+\])?:\s+Leaving directory\b/
const MAKE_NOTHING = /^make(?:\[\d+\])?:\s+Nothing to be done\b/
const MAKE_UP_TO_DATE = /^make(?:\[\d+\])?:\s+.*\bis up to date\b/

export const make: FilterSpec = {
  name: 'make',
  matchCommand: MAKE_MATCH,
  stripAnsi: true,
  stripLinesMatching: [MAKE_ENTERING, MAKE_LEAVING, MAKE_NOTHING, MAKE_UP_TO_DATE],
  collapseRuns: true,
  maxLines: 50,
  onEmpty: 'make: ok',
}

// --- pio run (PlatformIO) --------------------------------------------------

const PIO_MATCH = /^pio\s+run\b/
const PIO_VERBOSE_HINT = /^Verbose mode can be enabled/
const PIO_CONFIGURATION = /^CONFIGURATION:\s/
const PIO_LDF = /^LDF:\s/
const PIO_COMPILING = /^Compiling\s/
const PIO_BUILDING = /^Building\s/
const PIO_LINKING = /^Linking\s/
const PIO_CHECKING_SIZE = /^Checking size\b/

export const pioRun: FilterSpec = {
  name: 'pio-run',
  matchCommand: PIO_MATCH,
  stripAnsi: true,
  stripLinesMatching: [
    PIO_VERBOSE_HINT,
    PIO_CONFIGURATION,
    PIO_LDF,
    PIO_COMPILING,
    PIO_BUILDING,
    PIO_LINKING,
    PIO_CHECKING_SIZE,
  ],
  collapseRuns: true,
  maxLines: 30,
  onEmpty: 'pio run: ok',
}
