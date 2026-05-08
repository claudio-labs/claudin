// Built-in filter registry.
// Phase 6.1.2 — batch 1 (14 specs). Phase 6.1.4 — rewrite specs (5).
// Phase 6.1.5 — batch 2 (11 specs): git pipeline-only, containers, network, journalctl.
//
// Order matters only insofar as more specific specs must come before
// less specific ones when their matchCommand regex could overlap. We
// keep the list grouped by family for readability; no specs currently
// overlap after `matchCommandReject` is applied.

import type { FilterSpec } from '../types.js'

import { bundleInstall } from './pkg.js'
import { pytest, rspec, goTest } from './tests.js'
import { psAux, top, journalctl } from './system.js'
import { rubocop, ruffCheck } from './linters.js'
import { lsLa } from './ls.js'
import { grepRg } from './grep-rg.js'
import { gitLog, gitStatus, gitBlame, gitPull, gitAdd, gitCommit, gitPush } from './git.js'
import { ghPrList, ghIssueList, ghRunList } from './gh.js'
import { cargoBuild, cargoCheck, cargoTest, cargoClippy } from './cargo.js'
import { dockerPs, dockerImages, dockerLogs } from './containers.js'
import { curlV, dig } from './network.js'

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
  // Git — Phase 6.1.4 (rewrite specs)
  gitLog,
  gitStatus,
  // GitHub CLI — Phase 6.1.4
  ghPrList,
  ghIssueList,
  ghRunList,
  // Git — Phase 6.1.5 (pipeline-only specs)
  gitBlame,
  gitPull,
  gitAdd,
  gitCommit,
  gitPush,
  // Containers — Phase 6.1.5
  dockerPs,
  dockerImages,
  dockerLogs,
  // Network — Phase 6.1.5
  curlV,
  dig,
  // System extend — Phase 6.1.5
  journalctl,
  // Cargo (Rust) — specific variants first so matchCommandReject fires
  // before a more general one could claim the command.
  cargoTest,
  cargoClippy,
  cargoCheck,
  cargoBuild,
]
