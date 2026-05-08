// Built-in filter registry. Phase 6.1.2 — batch 1 (14 specs). Phase 6.1.4 — rewrite specs (5).
//
// Order matters only insofar as more specific specs must come before
// less specific ones when their matchCommand regex could overlap. We
// keep the list grouped by family for readability; no specs currently
// overlap after `matchCommandReject` is applied.

import type { FilterSpec } from '../types.js'

import { bundleInstall } from './pkg.js'
import { pytest, rspec, goTest } from './tests.js'
import { psAux, top } from './system.js'
import { rubocop, ruffCheck } from './linters.js'
import { lsLa } from './ls.js'
import { grepRg } from './grep-rg.js'
import { gitLog, gitStatus } from './git.js'
import { ghPrList, ghIssueList, ghRunList } from './gh.js'
import { cargoBuild, cargoCheck, cargoTest, cargoClippy } from './cargo.js'

export const builtInFilters: FilterSpec[] = [
  // Package managers
  bundleInstall,
  // Test runners
  pytest,
  rspec,
  goTest,
  // System inspection
  psAux,
  top,
  // Linters
  rubocop,
  ruffCheck,
  // File listing
  lsLa,
  // Code search
  grepRg,
  // Git — Phase 6.1.4
  gitLog,
  gitStatus,
  // GitHub CLI — Phase 6.1.4
  ghPrList,
  ghIssueList,
  ghRunList,
  // Cargo (Rust) — specific variants first so matchCommandReject fires
  // before a more general one could claim the command.
  cargoTest,
  cargoClippy,
  cargoCheck,
  cargoBuild,
]
