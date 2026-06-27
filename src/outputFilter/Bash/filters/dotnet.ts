// .NET CLI filters — Phase 13 (rtk gap-fill).
//
//   - dotnet build  : collapse a clean build (`0 Warning(s)` + `0 Error(s)`)
//     to a sentinel; warnings/errors pass through after the banner strip.
//   - dotnet test   : collapse an all-pass / no-skip VSTest run; any failure,
//     skip, or `Error Message:`/`Stack Trace:` block passes through.
//   - dotnet format : strip restore chatter; keep `error WHITESPACE/IMPORTS`
//     diagnostics; clean run → `dotnet format: ok`.
//
// Strict short-circuit (user decision): build collapses only on 0/0; test
// collapses only on `Failed: 0` AND `Skipped: 0` so any skip keeps the real
// summary line visible. trx/json/binlog loggers write structured artifacts and
// are rejected (keep raw).
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// Shared banner / restore noise --------------------------------------------
const DOTNET_MSBUILD_BANNER = /^Microsoft \(R\) Build Engine/
const DOTNET_COPYRIGHT = /^Copyright \(C\) Microsoft/
const DOTNET_DETERMINING = /^\s*Determining projects to restore/
const DOTNET_UP_TO_DATE = /^\s*All projects are up-to-date for restore/

// --- dotnet build ----------------------------------------------------------

const DOTNET_BUILD_MATCH = /^dotnet\s+build\b/
// `-bl`/`--binaryLogger` writes a binlog; `-getProperty`/`--getProperty` emits
// machine-readable values — keep raw.
const DOTNET_BUILD_REJECT = /(?:^|\s)(?:-bl\b|--binaryLogger\b|-getProperty\b|--getProperty\b)/
// `Build succeeded.` immediately followed by a 0/0 tally.
const DOTNET_BUILD_OK = /0 Warning\(s\)\s*\n\s*0 Error\(s\)/
// Any compile error or BUILD FAILED — suppress the sentinel.
const DOTNET_HAS_ERROR = /:\s*error\s|Build FAILED|\b[1-9]\d* Error\(s\)/

export const dotnetBuild: FilterSpec = {
  name: 'dotnet-build',
  matchCommand: DOTNET_BUILD_MATCH,
  matchCommandReject: DOTNET_BUILD_REJECT,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: DOTNET_BUILD_OK,
      unless: DOTNET_HAS_ERROR,
      message: '✓ dotnet build: succeeded',
    },
  ],
  stripLinesMatching: [
    DOTNET_MSBUILD_BANNER,
    DOTNET_COPYRIGHT,
    DOTNET_DETERMINING,
    DOTNET_UP_TO_DATE,
  ],
  collapseRuns: true,
  maxLines: 40,
}

// --- dotnet test -----------------------------------------------------------

const DOTNET_TEST_MATCH = /^dotnet\s+test\b/
// trx/json/html loggers write a file or structured output — keep raw.
const DOTNET_TEST_REJECT =
  /(?:^|\s)(?:--logger(?:[:=]|\s+)"?(?:trx|json|html|nunit|junit)|-l(?:[:=]|\s+)"?(?:trx|json|html))/i
// VSTest banner + ceremony.
const DOTNET_TEST_BANNER = /^Microsoft \(R\) Test Execution Command Line Tool/
const DOTNET_TEST_COPYRIGHT = /^Copyright \(c\) Microsoft/
const DOTNET_TEST_RUN_FOR = /^Test run for /
const DOTNET_TEST_STARTING = /^Starting test execution/
const DOTNET_TEST_TOTAL_FILES = /^A total of \d+ test files matched/
// The build artifact line: `  Project -> /path/Project.dll`.
const DOTNET_TEST_BUILD_DLL = /^\s+\S.* -> .*\.dll\s*$/
// Clean, no-skip pass — the only case we collapse (strict).
const DOTNET_TEST_OK =
  /^Passed!\s+-\s+Failed:\s+0,\s+Passed:\s+\d+,\s+Skipped:\s+0,/m
// Any failure / aborted run — suppress the sentinel.
const DOTNET_TEST_PROBLEM = /\bFailed!\b|^\s*Failed\s|Error Message:|Test Run Aborted/m

export const dotnetTest: FilterSpec = {
  name: 'dotnet-test',
  matchCommand: DOTNET_TEST_MATCH,
  matchCommandReject: DOTNET_TEST_REJECT,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: DOTNET_TEST_OK,
      unless: DOTNET_TEST_PROBLEM,
      message: '✓ dotnet test: all passed',
    },
  ],
  stripLinesMatching: [
    DOTNET_TEST_BANNER,
    DOTNET_TEST_COPYRIGHT,
    DOTNET_TEST_RUN_FOR,
    DOTNET_TEST_STARTING,
    DOTNET_TEST_TOTAL_FILES,
    DOTNET_TEST_BUILD_DLL,
    DOTNET_DETERMINING,
    DOTNET_UP_TO_DATE,
  ],
  collapseRuns: true,
  maxLines: 50,
}

// --- dotnet format ---------------------------------------------------------

const DOTNET_FORMAT_MATCH = /^dotnet\s+format\b/
// `--report <file>` writes JSON; keep raw.
const DOTNET_FORMAT_REJECT = /(?:^|\s)--report\b/
const DOTNET_FORMAT_RESTORED = /^\s*Restored\s/

export const dotnetFormat: FilterSpec = {
  name: 'dotnet-format',
  matchCommand: DOTNET_FORMAT_MATCH,
  matchCommandReject: DOTNET_FORMAT_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    DOTNET_MSBUILD_BANNER,
    DOTNET_COPYRIGHT,
    DOTNET_DETERMINING,
    DOTNET_FORMAT_RESTORED,
  ],
  collapseRuns: true,
  maxLines: 40,
  onEmpty: 'dotnet format: ok',
}
