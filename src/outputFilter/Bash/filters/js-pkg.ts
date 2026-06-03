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

import type { FilterSpec } from '../types.js'

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

// --- pnpm run / exec --------------------------------------------------------

const PNPM_RUN_MATCH = /^pnpm\s+(run|exec)\b/
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
const YARN_INSTALL_MATCH = /^yarn(?:\s+(install|add|upgrade|remove|i))?\b/
const YARN_INSTALL_PASSTHROUGH = /(?:^|\s)(?:--json|--silent)\b/
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
