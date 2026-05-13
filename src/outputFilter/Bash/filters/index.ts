// Built-in filter registry.
// Phase 6.1.2 — batch 1 (14 specs). Phase 6.1.4 — rewrite specs (5).
// Phase 6.1.5 — batch 2 (11 specs): git pipeline-only, containers, network, journalctl.
// Phase 6.2   — JS/TS toolchain + git diff/show (8 specs).
//
// Order matters only insofar as more specific specs must come before
// less specific ones when their matchCommand regex could overlap. We
// keep the list grouped by family for readability; no specs currently
// overlap after `matchCommandReject` is applied.

import type { FilterSpec } from '../types.js'

import { bundleInstall } from './pkg.js'
import { pytest, rspec, goTest } from './tests.js'
import { jest, vitest, bunTest, mocha, playwright } from './tests-js.js'
import { tsc } from './tsc.js'
import {
  psAux,
  top,
  journalctl,
  ping,
  rsync,
  tree,
  ssh,
  df,
  du,
  dmesg,
  stat,
  jq,
} from './system.js'
import { rubocop, ruffCheck } from './linters.js'
import { lsLa } from './ls.js'
import { grepRg } from './grep-rg.js'
import {
  gitLog,
  gitStatus,
  gitBlame,
  gitPull,
  gitAdd,
  gitCommit,
  gitPush,
  gitDiff,
  gitShow,
} from './git.js'
import { ghPrList, ghIssueList, ghRunList } from './gh.js'
import { cargoBuild, cargoCheck, cargoTest, cargoClippy } from './cargo.js'
import { dockerPs, dockerImages, dockerLogs } from './containers.js'
import { curlV, dig, curlPlain } from './network.js'

export const builtInFilters: FilterSpec[] = [
  // Package managers
  bundleInstall,
  // Test runners
  pytest,
  rspec,
  goTest,
  // Test runners — JS/TS (Phase 6.2). Two-word matches (`bun test`,
  // `playwright test`) come before single-word ones so the more specific
  // form wins when both could plausibly match.
  bunTest,
  playwright,
  jest,
  vitest,
  mocha,
  // TypeScript compiler (Phase 6.2)
  tsc,
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
  // Git — Phase 6.2 (diff/show)
  gitDiff,
  gitShow,
  // Containers — Phase 6.1.5
  dockerPs,
  dockerImages,
  dockerLogs,
  // Network — Phase 6.1.5
  curlV,
  dig,
  // System extend — Phase 6.1.5
  journalctl,
  // Phase 9 — system utilities (filesystem / network / process).
  // curl-plain is after curlV so `curl -v` is claimed by the verbose
  // spec first; the matchCommandReject on -v makes the order redundant
  // for correctness but it keeps the intent obvious.
  ping,
  rsync,
  tree,
  ssh,
  df,
  du,
  dmesg,
  stat,
  jq,
  curlPlain,
  // Cargo (Rust) — specific variants first so matchCommandReject fires
  // before a more general one could claim the command.
  cargoTest,
  cargoClippy,
  cargoCheck,
  cargoBuild,
]
