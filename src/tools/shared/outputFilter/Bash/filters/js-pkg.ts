// JS package manager filters — Phase 12 / rtk gap-fill.
//
// npm/pnpm/yarn install and run scripts print a lot of ceremonial noise:
// progress bars, update banners, dependency trees, funding solicitations.
// We strip the ceremony, preserve warnings/deprecations/errors and the
// final "what happened" line (added N packages / Done in Xs).
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.
// Fail-open: all rules are line-level strips; a malformed sample falls
// back to raw passthrough via safeApply (no throws).

import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'

// --- npm install / npm ci / npm i / npm add ----------------------------------

const NPM_INSTALL_MATCH = /^npm\s+(install|i|ci|add)\b/
// Honor user requests for machine-readable output.
const NPM_INSTALL_PASSTHROUGH = /(?:^|\s)(?:--json|--parseable)\b/
// Funding solicitation: two adjacent lines we can strip without losing signal.
const NPM_FUNDING_HEADER = /^\d+ packages? (?:is|are) looking for funding$/
const NPM_FUNDING_HINT = /^\s+run [`'"]npm fund[`'"]/
// `npm http fetch` lines from `--loglevel verbose` — pure noise.
const NPM_HTTP_FETCH = /^npm\s+http\s+fetch\s/
// `npm notice` is exclusively release/update chatter, never an error.
const NPM_NOTICE = /^npm\s+notice\b/

export const npmInstall: FilterSpec = {
  name: 'npm-install',
  matchCommand: NPM_INSTALL_MATCH,
  matchCommandReject: NPM_INSTALL_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [
    NPM_FUNDING_HEADER,
    NPM_FUNDING_HINT,
    NPM_HTTP_FETCH,
    NPM_NOTICE,
  ],
  collapseRuns: true,
}

// --- npm test / npm run <script> --------------------------------------------

// `npm test` and `npm run <script>` both print a two-line header that just
// echoes the script. We strip those and let the underlying tool's output
// flow through (jest/vitest/mocha already have their own filters).
const NPM_RUN_MATCH = /^npm\s+(test|t|run|run-script|start)\b/
const NPM_RUN_PASSTHROUGH = /(?:^|\s)--silent\b/
// `> pkg@version script` (sometimes with leading `> `).
const NPM_SCRIPT_HEADER = /^>\s+\S+@\S+\s+\S+/
// The script body itself echoed by npm (e.g. `> jest --coverage`).
const NPM_SCRIPT_BODY = /^>\s+\S/

export const npmRun: FilterSpec = {
  name: 'npm-run',
  matchCommand: NPM_RUN_MATCH,
  matchCommandReject: NPM_RUN_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [NPM_SCRIPT_HEADER, NPM_SCRIPT_BODY],
  collapseRuns: true,
}

// --- bun run <script> --------------------------------------------------------

// Bun echoes the script it is about to run as `$ <command>`, once per nesting
// level — `bun run smoke` prints `$ bun run build && …` and then
// `$ bun run scripts/build/build.ts`. Same ceremony as npm's `> `, same
// treatment: strip the echo and let the underlying tool's own filter work on
// what follows.
//
// A script NAME is required, so this never claims bare `bun run` (which lists
// the scripts rather than running one). `bun test` and `bun install` are
// different verbs and are not matched at all — `bunTest` owns the first.
//
// KNOWN GAP, shared with `npm-run` above: a script whose OWN output begins with
// `$ ` loses that line. The stages are stateless per line, so "only the echo at
// the top" is not expressible; `js-pkg.test.ts` pins the behaviour rather than
// pretending it does not exist.
const BUN_RUN_MATCH = /^bun\s+run\s+[\w:@./-]+/
const BUN_RUN_PASSTHROUGH = /(?:^|\s)--silent\b/
// `$ tsc --noEmit`, `$ bun run scripts/build/build.ts`.
const BUN_SCRIPT_ECHO = /^\$\s+\S/
// The version banner some bun versions print before the echo.
const BUN_RUN_BANNER = /^bun run v\d+\.\d+/

export const bunRun: FilterSpec = {
  name: 'bun-run',
  matchCommand: BUN_RUN_MATCH,
  matchCommandReject: BUN_RUN_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [BUN_RUN_BANNER, BUN_SCRIPT_ECHO],
  collapseRuns: true,
}

// --- pnpm install / add / i --------------------------------------------------

const PNPM_INSTALL_MATCH = /^pnpm\s+(install|i|add)\b/
const PNPM_INSTALL_PASSTHROUGH = /(?:^|\s)(?:--json|--reporter(?:=|\s+)(?:silent|json|ndjson))\b/
// Update-available box drawing — three line shapes cover the whole banner.
const PNPM_BOX_TOP = /^\s+╭─+╮\s*$/
const PNPM_BOX_BOTTOM = /^\s+╰─+╯\s*$/
const PNPM_BOX_BODY = /^\s+│.*│\s*$/
// `Progress: resolved N, reused N, downloaded N, added N`
const PNPM_PROGRESS = /^Progress:\s+resolved\s/
// Bar of plus signs that animates the download counter.
const PNPM_PROGRESS_BAR = /^\++\s*$/

export const pnpmInstall: FilterSpec = {
  name: 'pnpm-install',
  matchCommand: PNPM_INSTALL_MATCH,
  matchCommandReject: PNPM_INSTALL_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [
    PNPM_BOX_TOP,
    PNPM_BOX_BOTTOM,
    PNPM_BOX_BODY,
    PNPM_PROGRESS,
    PNPM_PROGRESS_BAR,
  ],
  collapseRuns: true,
}

// --- pnpm run ----------------------------------------------------------------
// `pnpm exec <tool>` is consumed by RUNNER_PREFIX_RE canonicalization (the
// inner tool's own filter matches), so it never reaches this spec.

const PNPM_RUN_MATCH = /^pnpm\s+run\b/
const PNPM_RUN_PASSTHROUGH = /(?:^|\s)--silent\b/
// `> pkg@version script /path` (pnpm includes cwd, npm does not).
const PNPM_SCRIPT_HEADER = /^>\s+\S+@\S+\s+\S+/
const PNPM_SCRIPT_BODY = /^>\s+\S/

export const pnpmRun: FilterSpec = {
  name: 'pnpm-run',
  matchCommand: PNPM_RUN_MATCH,
  matchCommandReject: PNPM_RUN_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [PNPM_SCRIPT_HEADER, PNPM_SCRIPT_BODY],
  collapseRuns: true,
}

// --- yarn install / add (v1 classic) ----------------------------------------

// We match the bare `yarn` (defaults to install) and `yarn install|add|upgrade|remove`.
// The tail used to be optional — `(?:\s+(install|…))?\b` — which matched
// `yarn <anything>`: `yarn jest`, `yarn build` and `yarn tsc` all resolved here.
// Nothing broke only because jest/vitest/tsc are registered EARLIER in
// `builtInFilters`, so registration order was silently load-bearing for
// correctness while the registry comment claimed no spec overlaps.
//
// Tightening `matchCommand` alone does NOT fix it: `matchesAtomicCommand` tests
// the pattern against the bare VERB as well as against the whole command
// (`pipeline.ts`), so any spec that accepts a bare `yarn` accepts `yarn
// <anything>` with it. Bare `yarn` IS install, so the subcommand test has to
// live where the whole command is read — the reject. `yarn <script>` now
// reaches no spec, the same place `npm run <script>` deliberately lands, and
// gets the generic floor.
const YARN_INSTALL_MATCH = /^yarn\b/
const YARN_INSTALL_PASSTHROUGH =
  /(?:^|\s)(?:--json|--silent)\b|^yarn\s+(?!(?:install|add|upgrade|remove|i)\b)/
// `[1/4] Resolving packages...` through `[4/4] Building fresh packages...`
const YARN_PHASE = /^\[\d+\/\d+\]\s/
// `info ...` lines: noisy hints, not user signal.
const YARN_INFO = /^info\s/
// Dependency tree entries: `├─ pkg@1.2`, `└─ pkg@1.2`, possibly nested.
const YARN_TREE_ENTRY = /^[│ ]*[├└]─\s/

export const yarnInstall: FilterSpec = {
  name: 'yarn-install',
  matchCommand: YARN_INSTALL_MATCH,
  matchCommandReject: YARN_INSTALL_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [YARN_PHASE, YARN_INFO, YARN_TREE_ENTRY],
  collapseRuns: true,
}

// --- eslint -----------------------------------------------------------------

// eslint output on a clean run is empty; on a dirty run it prints
// `<path>\n  L:C  level  message  rule\n\n✖ N problems (X errors, Y warnings)`.
// The signal is the diagnostics + the final summary; the blank line separator
// is the only ceremony we strip.
const ESLINT_MATCH = /^(?:npx\s+)?eslint\b/
const ESLINT_PASSTHROUGH = /(?:^|\s)(?:--format(?:=|\s+)(?:json|junit|compact|checkstyle|tap|html))\b/

export const eslint: FilterSpec = {
  name: 'eslint',
  matchCommand: ESLINT_MATCH,
  matchCommandReject: ESLINT_PASSTHROUGH,
  stripAnsi: true,
  collapseRuns: true,
}

// --- prettier ---------------------------------------------------------------

// On `prettier --check`, two flavors of output exist:
//   - clean: `Checking formatting...\nAll matched files use Prettier code style!`
//   - dirty: many `[warn] path` lines + `[warn] Code style issues found...`
// On `prettier --write`, every file printed is signal.
// We strip the `Checking formatting...` preamble line only and collapse blanks.
const PRETTIER_MATCH = /^(?:npx\s+)?prettier\b/
const PRETTIER_PASSTHROUGH = /(?:^|\s)--loglevel(?:=|\s+)(?:silent|debug)\b/
const PRETTIER_PREAMBLE = /^Checking formatting\.\.\.$/

export const prettier: FilterSpec = {
  name: 'prettier',
  matchCommand: PRETTIER_MATCH,
  matchCommandReject: PRETTIER_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [PRETTIER_PREAMBLE],
  collapseRuns: true,
}

// --- prisma generate --------------------------------------------------------

const PRISMA_GENERATE_MATCH = /^(?:npx\s+)?prisma\s+generate\b/
// Three lines of harmless context that print before the real signal.
const PRISMA_LOADED_CONFIG = /^Loaded Prisma config from /
const PRISMA_SCHEMA_LOADED = /^Prisma schema loaded from /
const PRISMA_START_IMPORT = /^Start by importing your Prisma Client/

export const prismaGenerate: FilterSpec = {
  name: 'prisma-generate',
  matchCommand: PRISMA_GENERATE_MATCH,
  stripAnsi: true,
  stripLinesMatching: [
    PRISMA_LOADED_CONFIG,
    PRISMA_SCHEMA_LOADED,
    PRISMA_START_IMPORT,
  ],
  collapseRuns: true,
}

// --- prisma migrate ---------------------------------------------------------

const PRISMA_MIGRATE_MATCH = /^(?:npx\s+)?prisma\s+migrate\b/
// `You can now edit it and apply it by running prisma migrate dev.` — pure hint.
const PRISMA_MIGRATE_HINT = /^You can now edit it and apply it/

export const prismaMigrate: FilterSpec = {
  name: 'prisma-migrate',
  matchCommand: PRISMA_MIGRATE_MATCH,
  stripAnsi: true,
  stripLinesMatching: [
    PRISMA_LOADED_CONFIG,
    PRISMA_SCHEMA_LOADED,
    PRISMA_MIGRATE_HINT,
  ],
  collapseRuns: true,
}

// ===========================================================================
// Phase 13 — JS/TS extras (rtk gap-fill): next, biome, oxlint, turbo, nx.
// ===========================================================================

// --- next build / next lint -------------------------------------------------
// Scoped to `build`/`lint` only — `next dev`/`next start` are long-running
// servers whose streaming output must never be buffered/short-circuited. A
// clean build collapses to a sentinel; a type-check or webpack failure (which
// carries "Failed to compile.") passes through after the banner strip.
// `npx next …` is canonicalized to `next …` before matching (registry strips
// runner prefixes), so no `(?:npx\s+)?` is needed here.
const NEXT_MATCH = /^next\s+(?:build|lint)\b/
const NEXT_BANNER = /^\s*▲\s+Next\.js/
const NEXT_CREATING = /^\s*Creating an optimized production build/
const NEXT_OK = /Compiled successfully/
// Any compile/type/module failure OR a warning suppresses the sentinel: a
// `next build` can compile successfully (exit 0) yet print ESLint/Next warnings
// that the model needs to see — collapsing to the sentinel would hide them.
const NEXT_HAS_PROBLEM = /Failed to compile|Type error:|Build failed|Build error|Module not found|SyntaxError|\bwarning\b/i

export const nextBuild: FilterSpec = {
  name: 'next-build',
  matchCommand: NEXT_MATCH,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: NEXT_OK,
      unless: NEXT_HAS_PROBLEM,
      message: '✓ next build: compiled successfully',
    },
  ],
  stripLinesMatching: [NEXT_BANNER, NEXT_CREATING],
  collapseRuns: true,
  maxLines: 50,
}

// --- biome ------------------------------------------------------------------
// Diagnostics are the signal; the `Checked N files` / `Fixed N files` tallies
// and the "run it with --write" hint are ceremony. A fully clean run strips to
// nothing → `biome: ok`.
const BIOME_MATCH = /^biome\b/
const BIOME_REJECT = /(?:^|\s)--reporter(?:=|\s+)(?:json|github|junit|gitlab|summary)\b/
const BIOME_CHECKED = /^Checked \d+ files?\b/
const BIOME_FIXED = /^Fixed \d+ files?\b/
const BIOME_CMD_HINT = /^The following command/
const BIOME_RUN_IT = /^Run it with/

export const biome: FilterSpec = {
  name: 'biome',
  matchCommand: BIOME_MATCH,
  matchCommandReject: BIOME_REJECT,
  stripAnsi: true,
  stripLinesMatching: [BIOME_CHECKED, BIOME_FIXED, BIOME_CMD_HINT, BIOME_RUN_IT],
  collapseRuns: true,
  maxLines: 50,
  onEmpty: 'biome: ok',
}

// --- oxlint -----------------------------------------------------------------
const OXLINT_MATCH = /^oxlint\b/
const OXLINT_REJECT = /(?:^|\s)(?:-f|--format)(?:=|\s+)(?:json|github|checkstyle|unix)\b/
const OXLINT_FINISHED = /^Finished in \d+/
const OXLINT_FOUND = /^Found \d+ warning/

export const oxlint: FilterSpec = {
  name: 'oxlint',
  matchCommand: OXLINT_MATCH,
  matchCommandReject: OXLINT_REJECT,
  stripAnsi: true,
  stripLinesMatching: [OXLINT_FINISHED, OXLINT_FOUND],
  collapseRuns: true,
  maxLines: 50,
  onEmpty: 'oxlint: ok',
}

// --- turbo (Turborepo) ------------------------------------------------------
// The task output (`> pkg:task` + the tool's own lines) is signal; the cache
// status, scope, Tasks: and Duration: summary are noise. An all-cached run
// strips to nothing → `turbo: ok` (the decision's "collapse on all-cached").
const TURBO_MATCH = /^turbo\b/
const TURBO_REJECT = /(?:^|\s)(?:--dry-run|--dry|--graph)\b/
// Blank-line strip rather than collapseRuns: collapseRuns runs before
// stripLinesMatching and would turn a run of blanks into a `(×N)` marker.
const TURBO_BLANK = /^\s*$/
const TURBO_CACHE = /^\s*cache (?:hit|miss|bypass)\b/
const TURBO_PACKAGES = /^\s*\d+ packages in scope\b/
const TURBO_TASKS = /^\s*Tasks:\s+\d+/
const TURBO_DURATION = /^\s*Duration:\s+/
const TURBO_REMOTE = /^\s*Remote caching (?:enabled|disabled)\b/

export const turbo: FilterSpec = {
  name: 'turbo',
  matchCommand: TURBO_MATCH,
  matchCommandReject: TURBO_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    TURBO_BLANK,
    TURBO_CACHE,
    TURBO_PACKAGES,
    TURBO_TASKS,
    TURBO_DURATION,
    TURBO_REMOTE,
  ],
  truncateLineAt: 150,
  maxLines: 50,
  onEmpty: 'turbo: ok',
}

// --- nx (Nx monorepo) -------------------------------------------------------
const NX_MATCH = /^(?:pnpm\s+)?nx\b/
// Blank-line strip (see turbo note) rather than collapseRuns.
const NX_BLANK = /^\s*$/
const NX_RUNNING = /^\s*>\s*NX\s+Running target/
const NX_READ_OUTPUT = /^\s*>\s*NX\s+Nx read the output/
const NX_VIEW_LOGS = /^\s*>\s*NX\s+View logs/
// `———…` em-dash separator bars.
const NX_SEPARATOR = /^\u2014{3,}/
const NX_POWERED = /^\s+Nx \(powered by/

export const nx: FilterSpec = {
  name: 'nx',
  matchCommand: NX_MATCH,
  stripAnsi: true,
  stripLinesMatching: [
    NX_BLANK,
    NX_RUNNING,
    NX_READ_OUTPUT,
    NX_VIEW_LOGS,
    NX_SEPARATOR,
    NX_POWERED,
  ],
  truncateLineAt: 150,
  maxLines: 60,
  onEmpty: 'nx: ok',
}
