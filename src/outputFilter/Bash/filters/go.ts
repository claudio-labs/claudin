// Go toolchain filters — Phase 12.4.
//
// `go build`, `go vet`, `golangci-lint run`. On a cold cache, `go build`
// prints one `go: downloading ...` line per transitive module — pure noise.
// `go vet` and golangci-lint output is dominated by diagnostics; we keep
// them and just strip ANSI / collapse runs of blank lines.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- go build --------------------------------------------------------------

const GO_BUILD_MATCH = /^go\s+build\b/
// `-json` is structured output; keep raw.
const GO_BUILD_REJECT = /(?:^|\s)-json\b/
// `go: downloading <mod> v1.2.3`, `go: finding module ...`, `go: found ...`.
const GO_DOWNLOAD = /^go:\s+(?:downloading|finding|found|extracting)\s/
// Cold-cache success: output is entirely `go: downloading/finding/found` lines.
// Without a positive confirmation message, stripping leaves the body empty —
// ambiguous to the model (did the build succeed? did anything run?).
const GO_BUILD_DOWNLOAD_ONLY = /^(?:go:\s+(?:downloading|finding|found|extracting)[^\n]*\n?)+$/
// Anything that looks like a Go compile error or build failure — keep raw if present.
const GO_BUILD_HAS_ERROR = /(?:^|\n)(?:.*\b(?:error|undefined|cannot find|cannot use|no required module|build failed|FAIL)\b|.*:\d+:\d+:\s)/i

export const goBuild: FilterSpec = {
  name: 'go-build',
  matchCommand: GO_BUILD_MATCH,
  matchCommandReject: GO_BUILD_REJECT,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: GO_BUILD_DOWNLOAD_ONLY,
      unless: GO_BUILD_HAS_ERROR,
      message: '✓ go build: dependencies downloaded, build ok',
    },
  ],
  stripLinesMatching: [GO_DOWNLOAD],
  collapseRuns: true,
}

// --- go vet ----------------------------------------------------------------

const GO_VET_MATCH = /^go\s+vet\b/
const GO_VET_REJECT = /(?:^|\s)-json\b/

export const goVet: FilterSpec = {
  name: 'go-vet',
  matchCommand: GO_VET_MATCH,
  matchCommandReject: GO_VET_REJECT,
  stripAnsi: true,
  stripLinesMatching: [GO_DOWNLOAD],
  collapseRuns: true,
}

// --- golangci-lint run -----------------------------------------------------

const GOLANGCI_MATCH = /^golangci-lint\s+run\b/
const GOLANGCI_REJECT = /(?:^|\s)--out-format(?:=|\s+)(?:json|checkstyle|junit-xml|github-actions|sarif|teamcity|code-climate)\b/

export const golangciLint: FilterSpec = {
  name: 'golangci-lint',
  matchCommand: GOLANGCI_MATCH,
  matchCommandReject: GOLANGCI_REJECT,
  stripAnsi: true,
  collapseRuns: true,
}
