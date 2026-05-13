// Per-command gain report for the Bash output filter (Roadmap 6.1).
//
// Loads each fixture in src/outputFilter/Bash/__fixtures__/samples,
// runs it through the public pipeline, and prints byte/token reduction
// per filter — same shape as `rtk gain --history`.
//
// Implemented as a bun test (not a plain script) because bunfig.toml's
// `[test]` preload is what stubs `@growthbook/growthbook` for source-mode
// runs; `bun run` does not apply that preload.
//
// Default behaviour: skipped on `bun test`. Run explicitly with:
//   CLAUDIO_BENCH=1 bun test scripts/profile/bash-filter-gain.test.ts
//   CLAUDIO_BENCH=1 CLAUDIO_BENCH_DIFF=git-blame bun test scripts/profile/bash-filter-gain.test.ts
//   CLAUDIO_BENCH=1 CLAUDIO_BENCH_JSON=1 bun test scripts/profile/bash-filter-gain.test.ts

import { describe, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  applyBashFilterToStdout,
  planBashFilter,
} from '../../src/outputFilter/Bash/index.js'

const SAMPLES_DIR = resolve(
  import.meta.dir,
  '../../src/outputFilter/Bash/__fixtures__/samples',
)

const WRAPPER_RE =
  /^<bash-output-filtered\s[^>]*>([\s\S]*)<\/bash-output-filtered>$/

type Scenario = {
  filter: string
  command: string
  sample: string
  predicted?: number
  postSample?: string
}

// Source of truth: bashFilter.test.ts assertReduction(...) calls + rewrite tests.
const SCENARIOS: Scenario[] = [
  // pipeline filters with documented predicted %
  { filter: 'bundle-install', command: 'bundle install', sample: 'bundle-install', predicted: 91 },
  { filter: 'pytest', command: 'pytest', sample: 'pytest-clean', predicted: 90 },
  { filter: 'rspec', command: 'rspec', sample: 'rspec', predicted: 68 },
  { filter: 'go-test', command: 'go test ./...', sample: 'go-test', predicted: 77 },
  { filter: 'ps-aux', command: 'ps aux', sample: 'ps-aux', predicted: 88 },
  { filter: 'top', command: 'top -bn1', sample: 'top-bn1', predicted: 47 },
  { filter: 'rubocop', command: 'rubocop', sample: 'rubocop', predicted: 78 },
  { filter: 'ls-la', command: 'ls -la', sample: 'ls-la', predicted: 76 },
  { filter: 'grep-rg', command: 'grep -rn isAbortError .', sample: 'grep', predicted: 28 },
  { filter: 'cargo-build', command: 'cargo build', sample: 'cargo-build', predicted: 50 },
  { filter: 'cargo-check', command: 'cargo check', sample: 'cargo-check', predicted: 59 },
  { filter: 'git-blame', command: 'git blame README.md', sample: 'git-blame', predicted: 20 },
  { filter: 'git-pull', command: 'git pull', sample: 'git-pull-synthetic', predicted: 40 },
  { filter: 'docker-ps', command: 'docker ps -a', sample: 'docker-ps', predicted: 20 },
  { filter: 'docker-images', command: 'docker images', sample: 'docker-images', predicted: 30 },
  { filter: 'docker-logs', command: 'docker logs postgres', sample: 'docker-logs', predicted: 15 },
  { filter: 'curl', command: 'curl -v https://httpbin.org/get', sample: 'curl-v', predicted: 50 },
  { filter: 'dig', command: 'dig httpbin.org', sample: 'dig', predicted: 40 },
  { filter: 'journalctl', command: 'journalctl -u systemd-logind', sample: 'journalctl', predicted: 10 },
  // pipeline filters measured but without a documented target
  // cargo-clippy: warnings ARE the signal — only "Compiling <dep>" is
  // strippable and the fixture has just the main-crate line (kept by design),
  // so ~0% on this fixture is correct, not a regression.
  { filter: 'cargo-clippy', command: 'cargo clippy', sample: 'cargo-clippy' },
  // ruff-check: the all-passed collapse fires only on a clean run.
  { filter: 'ruff-check', command: 'ruff check .', sample: 'ruff-clean' },
  // rewrite filters: compare pre-rewrite vs post-rewrite sample (same repo state).
  { filter: 'git-status', command: 'git status', sample: 'git-status', postSample: 'git-status-porcelain' },
  { filter: 'git-log', command: 'git log', sample: 'git-log-default', postSample: 'git-log-oneline' },
  // ---- Phase 6.2 — JS/TS toolchain + git diff/show -----------------------
  { filter: 'jest', command: 'jest', sample: 'jest-clean', predicted: 90 },
  { filter: 'vitest', command: 'vitest', sample: 'vitest-clean', predicted: 90 },
  { filter: 'bun-test', command: 'bun test', sample: 'bun-test-clean', predicted: 90 },
  { filter: 'mocha', command: 'mocha', sample: 'mocha-clean', predicted: 80 },
  { filter: 'playwright', command: 'playwright test', sample: 'playwright-clean', predicted: 80 },
  { filter: 'tsc', command: 'tsc --noEmit', sample: 'tsc-errors', predicted: 10 },
  { filter: 'git-diff', command: 'git diff', sample: 'git-diff', predicted: 5 },
  // git-show: ceiling is the metadata + per-file headers — diff bodies
  // (the bulk of the fixture) are intentionally untouched.
  { filter: 'git-show', command: 'git show HEAD', sample: 'git-show-full', predicted: 5 },
  // ---- Phase 9 — system utilities ----------------------------------------
  { filter: 'ping', command: 'ping -c 20 8.8.8.8', sample: 'ping-google', predicted: 55 },
  { filter: 'rsync', command: 'rsync -av src/ dst/', sample: 'rsync-incremental', predicted: 70 },
  { filter: 'tree', command: 'tree', sample: 'tree-deep', predicted: 30 },
  { filter: 'ssh', command: 'ssh -vvv example.com echo ok', sample: 'ssh-vvv', predicted: 70 },
  { filter: 'df', command: 'df -h', sample: 'df-h', predicted: 40 },
  // du: structural strip + cap; no "predicted %" target because the savings
  // depend heavily on the tree shape. The safety tests cover correctness.
  { filter: 'du', command: 'du -h', sample: 'du-noisy' },
  { filter: 'dmesg', command: 'dmesg', sample: 'dmesg-long', predicted: 25 },
  // stat / jq: short fixtures, the cap rarely fires — gain table reports
  // the actual reduction without a target.
  { filter: 'stat', command: 'stat package.json', sample: 'stat-file' },
  { filter: 'jq', command: "jq '.'", sample: 'jq-pretty-deep' },
  { filter: 'curl-plain', command: 'curl http://example.com', sample: 'curl-plain', predicted: 40 },
]

const loadSample = (name: string): string => {
  const path = resolve(SAMPLES_DIR, `${name}.txt`)
  if (!existsSync(path)) throw new Error(`fixture not found: ${path}`)
  return readFileSync(path, 'utf8')
}

const stripWrapper = (s: string): string => {
  const m = s.match(WRAPPER_RE)
  return m ? m[1]! : s
}

const tokens = (s: string): number => Math.round(s.length / 4)

const pct = (rawLen: number, outLen: number): number =>
  100 * (1 - outLen / Math.max(1, rawLen))

type Row = {
  filter: string
  command: string
  mode: 'pipeline' | 'rewrite'
  rawBytes: number
  outBytes: number
  reductionPct: number
  rawTokens: number
  outTokens: number
  tokensSaved: number
  predicted?: number
  rewriteTo?: string
}

const evaluate = (s: Scenario): Row => {
  const raw = loadSample(s.sample)
  const plan = planBashFilter(s.command)

  if (s.postSample) {
    const post = loadSample(s.postSample)
    return {
      filter: s.filter,
      command: s.command,
      mode: 'rewrite',
      rawBytes: raw.length,
      outBytes: post.length,
      reductionPct: pct(raw.length, post.length),
      rawTokens: tokens(raw),
      outTokens: tokens(post),
      tokensSaved: tokens(raw) - tokens(post),
      predicted: s.predicted,
      rewriteTo: plan.rewrite?.to,
    }
  }

  const filtered = applyBashFilterToStdout(raw, false, plan)
  const body = stripWrapper(filtered)
  return {
    filter: s.filter,
    command: s.command,
    mode: 'pipeline',
    rawBytes: raw.length,
    outBytes: body.length,
    reductionPct: pct(raw.length, body.length),
    rawTokens: tokens(raw),
    outTokens: tokens(body),
    tokensSaved: tokens(raw) - tokens(body),
    predicted: s.predicted,
    rewriteTo: plan.rewrite?.to ?? undefined,
  }
}

const showDiff = (name: string): void => {
  const s = SCENARIOS.find((x) => x.filter === name)
  if (!s) {
    console.error(`unknown filter: ${name}`)
    console.error(`available: ${SCENARIOS.map((x) => x.filter).join(', ')}`)
    return
  }
  const raw = loadSample(s.sample)
  const plan = planBashFilter(s.command)
  const filtered = s.postSample
    ? loadSample(s.postSample)
    : stripWrapper(applyBashFilterToStdout(raw, false, plan))

  const head = (txt: string, n = 25): string =>
    txt.split('\n').slice(0, n).join('\n')

  console.log(`\n=== ${s.filter} (${s.command}) ===`)
  if (plan.rewrite) console.log(`rewrite: ${plan.rewrite.from} → ${plan.rewrite.to}`)
  console.log(
    `\n--- RAW (${raw.length.toLocaleString()} B, ~${tokens(raw).toLocaleString()} tok) ---`,
  )
  console.log(head(raw))
  if (raw.split('\n').length > 25)
    console.log(`... (${raw.split('\n').length - 25} more lines)`)
  console.log(
    `\n--- FILTERED (${filtered.length.toLocaleString()} B, ~${tokens(filtered).toLocaleString()} tok) ---`,
  )
  console.log(head(filtered))
  if (filtered.split('\n').length > 25)
    console.log(`... (${filtered.split('\n').length - 25} more lines)`)
  console.log(
    `\nreduction: ${pct(raw.length, filtered.length).toFixed(1)}%  (saved ~${(tokens(raw) - tokens(filtered)).toLocaleString()} tokens)\n`,
  )
}

const showTable = (rows: Row[]): void => {
  const header =
    'FILTER          MODE      RAW       OUT      RED%   PRED%   ~TOK SAVED'
  const sep = '-'.repeat(header.length)
  console.log(header)
  console.log(sep)
  let totalRaw = 0
  let totalOut = 0
  let totalSaved = 0
  for (const r of rows) {
    const pad = (s: string | number, n: number, right = false): string => {
      const v = String(s)
      return right ? v.padStart(n) : v.padEnd(n)
    }
    const fmtBytes = (n: number) =>
      n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}B`
    const flag =
      r.predicted == null
        ? ''
        : r.reductionPct >= r.predicted - 5
          ? '✓'
          : '✗'
    console.log(
      [
        pad(r.filter, 15),
        pad(r.mode, 9),
        pad(fmtBytes(r.rawBytes), 9, true),
        pad(fmtBytes(r.outBytes), 9, true),
        pad(`${r.reductionPct.toFixed(1)}%`, 6, true),
        pad(r.predicted == null ? '—' : `${r.predicted}%${flag}`, 8, true),
        pad(r.tokensSaved.toLocaleString(), 10, true),
      ].join(' '),
    )
    totalRaw += r.rawBytes
    totalOut += r.outBytes
    totalSaved += r.tokensSaved
  }
  console.log(sep)
  console.log(
    `TOTALS  ${rows.length} filters` +
      `   raw=${(totalRaw / 1024).toFixed(1)}K` +
      `  out=${(totalOut / 1024).toFixed(1)}K` +
      `  agg=${pct(totalRaw, totalOut).toFixed(1)}%` +
      `  saved≈${totalSaved.toLocaleString()} tok`,
  )
}

const ENABLED = process.env.CLAUDIO_BENCH === '1'
const DIFF_FOR = process.env.CLAUDIO_BENCH_DIFF
const AS_JSON = process.env.CLAUDIO_BENCH_JSON === '1'

describe('bash-filter-gain', () => {
  test.skipIf(!ENABLED)('per-command gain report', () => {
    const rows = SCENARIOS.map(evaluate)
    if (DIFF_FOR) {
      showDiff(DIFF_FOR)
      return
    }
    if (AS_JSON) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }
    showTable(rows)
    console.log(
      '\nLegend: PRED% = target from bashFilter.test.ts assertions.',
    )
    console.log('        ✓ = meets target (within −5pp); ✗ = misses target.')
    console.log(
      'Inspect a single filter:  CLAUDIO_BENCH=1 CLAUDIO_BENCH_DIFF=<filter> bun test scripts/profile/bash-filter-gain.test.ts',
    )
  })
})
