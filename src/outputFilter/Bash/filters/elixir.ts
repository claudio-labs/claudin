// Elixir toolchain filters — Phase 13 (rtk gap-fill).
//
//   - mix compile : strip the `Compiling N files` / `Generated <app> app`
//     ceremony; a clean compile (only ceremony) → `mix compile: ok`; warnings
//     and errors pass through.
//   - mix format  : near-passthrough (a clean run is silent); strip ANSI and
//     keep the `--check-formatted` file list intact.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- mix compile -----------------------------------------------------------

const MIX_COMPILE_MATCH = /^mix\s+compile(?:\s|$)/
const MIX_COMPILING = /^Compiling \d+ files?\b/
const MIX_GENERATED = /^Generated\s/
const MIX_BLANK = /^\s*$/

export const mixCompile: FilterSpec = {
  name: 'mix-compile',
  matchCommand: MIX_COMPILE_MATCH,
  stripAnsi: true,
  stripLinesMatching: [MIX_COMPILING, MIX_GENERATED, MIX_BLANK],
  collapseRuns: true,
  maxLines: 40,
  onEmpty: 'mix compile: ok',
}

// --- mix format ------------------------------------------------------------

const MIX_FORMAT_MATCH = /^mix\s+format(?:\s|$)/

export const mixFormat: FilterSpec = {
  name: 'mix-format',
  matchCommand: MIX_FORMAT_MATCH,
  stripAnsi: true,
  collapseRuns: true,
  maxLines: 20,
  onEmpty: 'mix format: ok',
}
