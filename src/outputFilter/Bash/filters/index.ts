// Built-in filter registry.
// Phase 6.1.2 — batch 1 (14 specs). Phase 6.1.4 — rewrite specs (5).
// Phase 6.1.5 — batch 2 (11 specs): git pipeline-only, containers, network, journalctl.
// Phase 6.2   — JS/TS toolchain + git diff/show (8 specs).
// Phase 9     — system utilities (ping/rsync/tree/ssh/df/du/dmesg/stat/jq) + curl-plain.
// Phase 10    — wget + find.
// Phase 11    — Java build tools (gradle, mvn) + IAC (terraform).
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
  find,
} from './system.js'
import {
  rubocop,
  ruffCheck,
  shellcheck,
  yamllint,
  markdownlint,
  hadolint,
  preCommit,
  mypy,
  pipInstall,
  ruffFormat,
} from './linters.js'
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
  gitFetch,
  gitBranch,
  gitStash,
  gitWorktree,
} from './git.js'
import { glabList, gt, jj } from './vcs.js'
import { ghPrList, ghIssueList, ghRunList } from './gh.js'
import { gradle, mvn } from './java-build.js'
import { terraform } from './iac.js'
import { cargoBuild, cargoCheck, cargoTest, cargoClippy, cargoRun, cargoFmt } from './cargo.js'
import { goBuild, goVet, golangciLint } from './go.js'
import { dockerPs, dockerImages, dockerLogs } from './containers.js'
import { curlV, dig, curlPlain, wget } from './network.js'
import {
  npmInstall,
  npmRun,
  pnpmInstall,
  pnpmRun,
  yarnInstall,
  eslint,
  prettier,
  prismaGenerate,
  prismaMigrate,
} from './js-pkg.js'

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
  find,
  curlPlain,
  wget,
  gradle,
  mvn,
  terraform,
  // Cargo (Rust) — specific variants first so matchCommandReject fires
  // before a more general one could claim the command.
  cargoTest,
  cargoClippy,
  cargoCheck,
  cargoBuild,
  // Phase 12 — JS package managers (rtk gap-fill).
  // `pnpm`/`yarn` come before `npm` only to keep the registry grouped by
  // family; matchCommand regex are disjoint so order is not load-bearing.
  npmInstall,
  npmRun,
  pnpmInstall,
  pnpmRun,
  yarnInstall,
  eslint,
  prettier,
  prismaGenerate,
  prismaMigrate,
  // Phase 12.2 — universal linters (rtk gap-fill).
  shellcheck,
  yamllint,
  markdownlint,
  hadolint,
  preCommit,
  // Phase 12.3 — Git extras + alternative VCS (rtk gap-fill).
  gitFetch,
  gitBranch,
  gitStash,
  gitWorktree,
  glabList,
  gt,
  jj,
  // Phase 12.4 — Go toolchain + Rust extras (rtk gap-fill).
  // cargoRun must come before cargoBuild's siblings? No — they're disjoint
  // (build/check/test/clippy/run/fmt all distinct subcommands). Keep
  // grouped by family.
  cargoRun,
  cargoFmt,
  goBuild,
  goVet,
  golangciLint,
  // Phase 12.5 — Python extras (rtk gap-fill).
  mypy,
  pipInstall,
  ruffFormat,
]
