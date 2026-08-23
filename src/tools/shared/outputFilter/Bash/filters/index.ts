// Built-in filter registry.
// Phase 6.1.2 — batch 1 (14 specs). Phase 6.1.4 — rewrite specs (5).
// Phase 6.1.5 — batch 2 (11 specs): git pipeline-only, containers, network, journalctl.
// Phase 6.2   — JS/TS toolchain + git diff/show (8 specs).
// Phase 9     — system utilities (ping/rsync/tree/ssh/df/du/dmesg/stat/jq) + curl-plain.
// Phase 10    — wget + find.
// Phase 11    — Java build tools (gradle, mvn) + IAC (terraform).
// Phase 12    — JS extras + python packaging.
// Phase 13    — language toolchains (cc/make/pio) + python extras.
// Phase 14    — measured command gaps: docker compose, bun run.
//
// Order matters only insofar as more specific specs must come before
// less specific ones when their matchCommand regex could overlap. We
// keep the list grouped by family for readability; no specs currently
// overlap after `matchCommandReject` is applied.

import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'

import { bundleInstall } from 'src/tools/shared/outputFilter/Bash/filters/pkg.js'
import { pytest, rspec, goTest } from 'src/tools/shared/outputFilter/Bash/filters/tests.js'
import { jest, vitest, bunTest, mocha, playwright } from 'src/tools/shared/outputFilter/Bash/filters/tests-js.js'
import { tsc } from 'src/tools/shared/outputFilter/Bash/filters/tsc.js'
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
} from 'src/tools/shared/outputFilter/Bash/filters/system.js'
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
  // Phase 13 — Python extras
  uv,
  poetry,
  basedpyright,
  ty,
} from 'src/tools/shared/outputFilter/Bash/filters/linters.js'
import { lsLa } from 'src/tools/shared/outputFilter/Bash/filters/ls.js'
import { grepRg } from 'src/tools/shared/outputFilter/Bash/filters/grep-rg.js'
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
} from 'src/tools/shared/outputFilter/Bash/filters/git.js'
import { glabList, gt, jj } from 'src/tools/shared/outputFilter/Bash/filters/vcs.js'
import { ghPrList, ghIssueList, ghRunList } from 'src/tools/shared/outputFilter/Bash/filters/gh.js'
import { gradle, mvn } from 'src/tools/shared/outputFilter/Bash/filters/java-build.js'
// Phase 13 — Java extras (spring-boot). The gradle/mvn specs above now reject
// bootRun/spring-boot:run, so spring-boot claims those without an order
// dependency; it is registered in the T9 block below.
import { springBoot } from 'src/tools/shared/outputFilter/Bash/filters/java-build.js'
import { terraform } from 'src/tools/shared/outputFilter/Bash/filters/iac.js'
import { cargoBuild, cargoCheck, cargoTest, cargoClippy, cargoRun, cargoFmt } from 'src/tools/shared/outputFilter/Bash/filters/cargo.js'
import { goBuild, goVet, golangciLint } from 'src/tools/shared/outputFilter/Bash/filters/go.js'
import { dockerPs, dockerImages, dockerLogs, dockerCompose } from 'src/tools/shared/outputFilter/Bash/filters/containers.js'
import { curlV, dig, curlPlain, wget } from 'src/tools/shared/outputFilter/Bash/filters/network.js'
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
  // Phase 13 — JS/TS extras
  nextBuild,
  biome,
  oxlint,
  turbo,
  nx,
  bunRun,
} from 'src/tools/shared/outputFilter/Bash/filters/js-pkg.js'
// Phase 13 — language toolchains (rtk gap-fill).
import { gccCompile, make, pioRun } from 'src/tools/shared/outputFilter/Bash/filters/cc.js'
import { dotnetBuild, dotnetTest, dotnetFormat } from 'src/tools/shared/outputFilter/Bash/filters/dotnet.js'
import { composer } from 'src/tools/shared/outputFilter/Bash/filters/php.js'
import { rake } from 'src/tools/shared/outputFilter/Bash/filters/ruby.js'
import { mixCompile, mixFormat } from 'src/tools/shared/outputFilter/Bash/filters/elixir.js'
import { swiftBuild, xcodebuild } from 'src/tools/shared/outputFilter/Bash/filters/swift.js'

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
  // ======================================================================
  // Phase 13 — language toolchains (rtk gap-fill). Grouped by family; all
  // matchCommand regex are disjoint from each other and from Phase ≤12, so
  // registration order is not load-bearing — EXCEPT spring-boot, which must
  // precede gradle/mvn (it claims `gradle …bootRun` / `mvn spring-boot:run`,
  // and those specs now reject the overlap). See java-build.ts.
  // ======================================================================
  // T1 — C/C++/native: gcc, make, pio
  gccCompile,
  make,
  pioRun,
  // T2 — .NET: dotnet build / test / format
  dotnetBuild,
  dotnetTest,
  dotnetFormat,
  // T3 — PHP: composer
  composer,
  // T4 — Ruby: rake
  rake,
  // T5 — Elixir: mix compile / format
  mixCompile,
  mixFormat,
  // T6 — Swift/Apple: swift build / xcodebuild
  swiftBuild,
  xcodebuild,
  // T7 — JS/TS extras: next, biome, oxlint, turbo, nx
  nextBuild,
  biome,
  oxlint,
  turbo,
  nx,
  // T8 — Python extras: uv, poetry, basedpyright, ty
  uv,
  poetry,
  basedpyright,
  ty,
  // T9 — Java extras: spring-boot (overlap with gradle/mvn resolved via their
  // matchCommandReject of bootRun/spring-boot:run).
  springBoot,
  // ======================================================================
  // Phase 14 — the command gaps the session-corpus census actually found.
  // All three regex are disjoint from every earlier spec, so registration
  // order is not load-bearing here: `docker compose` / `docker exec` cannot
  // be confused with `docker ps|images|logs`, and `bun run` is a different
  // verb from `bun test` (claimed by `bunTest` above).
  // ======================================================================
  dockerCompose,
  bunRun,
]
