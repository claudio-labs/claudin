#!/usr/bin/env bun
// Cache A/B bench: claudin vs claude (Claude Code), SAME prompt, SAME 12 files,
// SAME model (claude-sonnet-4-6 by default — cheap), main-loop only (no subagents).
//
// WHY: in real sessions claudin shows cache_write ≈ cache_read (the cached prefix
// is being REWRITTEN every turn) while Claude Code shows cache_read ≫ cache_write
// (the prefix is REUSED). cache_write costs 1.25× input; cache_read costs 0.1× —
// so rewriting instead of reading is ~12× more expensive per token. This harness
// runs an identical multi-turn workload against both CLIs and prints the per-turn
// cache timeline + the write:read ratio so we can see WHERE the cache breaks.
//
// Workload: read 12 files across 3 sequential rounds (4 files/round, one round per
// turn). Each turn re-sends the growing context; a healthy cache READS the prior
// prefix instead of re-CREATING it. 3 turns is enough to expose a per-turn rewrite.
//
// Auth: uses your ACTIVE claudin profile, just pinning the model via ANTHROPIC_MODEL
// + --model (does NOT touch ~/.claudin/settings.json). Claude Code uses its own auth.
//
// Harness fixes (2026-06-08):
//   1. Per-turn rows are DELTAS, not cumulative. We dedupe assistant `usage` events
//      by message-id (stream-json emits the same id repeatedly during streaming, only
//      the last carries the final per-request totals) and treat each unique
//      assistant message as one row. cR/cW/out are reported as the value of THAT
//      message's `usage` block — that IS the per-turn delta because Anthropic emits
//      one `usage` per API request, not cumulative.
//   2. Totals are derived from the same per-message stream (sum of per-row deltas)
//      instead of recursively walking every `usage`-shaped object. The previous
//      walker double-counted because stream-json emits multiple partial assistant
//      events PLUS a final `result` event that itself contains a `usage` summary
//      of the last request only — summing them produced inflated cR/cW.
//   3. When a side exits non-zero, the script now prints `BLOCKED — exit=N` + the
//      captured stderr (truncated) instead of silently rendering a fake table.
//   4. --runs=N runs each side N times sequentially; median + min/max of cR/cW/
//      r:w/$ are printed. The per-turn delta table uses the MEDIAN run only.
//   5. --skip-claude lets you run claudin-only N≥3 without manually flipping flags.
//
// Usage:
//   bun run scripts/profile/cache-ab-bench.ts                 # full A/B
//   bun run scripts/profile/cache-ab-bench.ts --only=claudin  # one side
//   bun run scripts/profile/cache-ab-bench.ts --runs=3        # median over 3 runs
//   bun run scripts/profile/cache-ab-bench.ts --skip-claude   # claudin only
//   bun run scripts/profile/cache-ab-bench.ts --model=claude-opus-4-7
//   bun run scripts/profile/cache-ab-bench.ts --a=claude --b=claudindev
//   bun run scripts/profile/cache-ab-bench.ts --json

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'

// 30 files, mixed sizes (small <500B, medium 5-30KB, large 50KB+) to exercise
// both small-pair walk-back and fat-tail short-circuit branches.
const TWELVE_FILES = [
  // large (provider/runtime guts)
  'src/services/api/client.ts',
  'src/services/api/providerConfig.ts',
  'src/QueryEngine.ts',
  'src/commands.ts',
  'src/Tool.ts',
  // medium
  'src/utils/messages.ts',
  'src/utils/config.ts',
  'src/services/api/withRetry.ts',
  'src/services/api/errors.ts',
  'src/services/mcp/client.ts',
  'src/utils/model/model.ts',
  'src/utils/providerModels.ts',
  'src/context.ts',
  'src/query.ts',
  'src/utils/errors.ts',
  'src/utils/log.ts',
  'src/utils/path.ts',
  'src/utils/envUtils.ts',
  'src/utils/Shell.ts',
  'src/bootstrap/state.ts',
  // small (constants / tiny utils)
  'src/constants/messages.ts',
  'src/constants/keys.ts',
  'src/ink/constants.ts',
  'src/utils/protectedNamespace.ts',
  'src/utils/array.ts',
  'src/utils/withResolvers.ts',
  'src/utils/lazySchema.ts',
  'src/utils/yaml.ts',
  'src/services/compact/snipCompact.ts',
  'src/utils/objectGroupBy.ts',
]

const SENTINEL = 'BENCH_DONE'

type Args = {
  model: string
  only: 'a' | 'b' | 'claudin' | 'claude' | null
  a: string
  b: string
  json: boolean
  help: boolean
  timeoutMs: number
  sequential: boolean
  turns: number
  runs: number
  skipClaude: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    model: 'claude-sonnet-4-6',
    only: null,
    a: 'claude',
    b: 'claudindev',
    json: false,
    help: false,
    timeoutMs: 600_000,
    sequential: false,
    turns: 8,
    runs: 1,
    skipClaude: false,
  }
  for (const x of argv) {
    if (x === '--help' || x === '-h') a.help = true
    else if (x === '--json') a.json = true
    else if (x === '--sequential') a.sequential = true
    else if (x === '--skip-claude') a.skipClaude = true
    else if (x.startsWith('--runs=')) a.runs = Math.max(1, Number(x.slice('--runs='.length)))
    else if (x.startsWith('--turns=')) a.turns = Number(x.slice('--turns='.length))
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--a=')) a.a = x.slice('--a='.length)
    else if (x.startsWith('--b=')) a.b = x.slice('--b='.length)
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Args['only']
  }
  return a
}

// Sequential mode forces ONE Read per turn over N files → both CLIs do ~N turns,
// so per-turn cache_write is directly comparable (the original 3-round prompt let
// claude batch to 5 turns and claudin to 13, which is apples-to-oranges).
function buildSequentialPrompt(files: string[], turns: number): string {
  const picked = files.slice(0, turns)
  return [
    `Read these ${picked.length} files using the Read tool, ONE FILE PER MESSAGE TURN.`,
    `CRITICAL: issue exactly ONE Read tool call per turn — do NOT batch multiple Reads,`,
    `do NOT read ahead. After each Read, print a one-line summary of that file, then`,
    `read the next one on the next turn. Process them strictly in this order:`,
    ...picked.map((f, i) => `  ${i + 1}. ${f}`),
    ``,
    `After the last file, end your final message with the exact token ${SENTINEL}.`,
  ].join('\n')
}

function buildPrompt(files: string[]): string {
  const lines: string[] = [
    `Read these ${files.length} files using the Read tool, then print a one-line summary for each.`,
    `Pace yourself however you want — no specific number of turns or rounds.`,
    ``,
    `Files:`,
    ...files.map(f => `- ${f}`),
    ``,
    `When you're done summarizing all ${files.length}, end your final message with the exact token ${SENTINEL}.`,
  ]
  return lines.join('\n')
}

type TimelineRow = { in: number; out: number; cR: number; cW: number; role: string }

type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number | null
  numTurns: number | null
  wallMs: number
  exitCode: number
  rawLen: number
  stderr: string
  timeline: TimelineRow[]
}

// Stream-json shape (verified against both binaries on 2026-06-08):
//   - `assistant` events carry `message.usage` for one API request. The same
//     `message.id` can appear in multiple consecutive `assistant` events while
//     content streams in; the FINAL event for that id carries the request's
//     final `usage` block. We dedupe by id and keep the last seen usage.
//   - `result` events contain a summary `usage` that mirrors the last request
//     only (NOT the cumulative across turns), plus `total_cost_usd` and
//     `num_turns` — we use those scalars but NOT the result.usage tokens.
//   - `usage` on per-message is per-request: cache_read_input_tokens is what was
//     re-read this request, cache_creation_input_tokens is what was newly cached
//     this request. Each row IS the per-turn delta; we do not subtract anything.
function extractTimeline(text: string): TimelineRow[] {
  const lastUsageByMsgId = new Map<string, TimelineRow & { order: number }>()
  let order = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const u = msg.usage as Record<string, unknown> | undefined
    if (!u) continue
    const id = String(msg.id ?? `__anon_${order}`)
    const row: TimelineRow & { order: number } = {
      in: Number(u.input_tokens ?? 0),
      out: Number(u.output_tokens ?? 0),
      cR: Number(u.cache_read_input_tokens ?? 0),
      cW: Number(u.cache_creation_input_tokens ?? 0),
      role: String(v.type),
      order: lastUsageByMsgId.get(id)?.order ?? order++,
    }
    lastUsageByMsgId.set(id, row)
  }
  return [...lastUsageByMsgId.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _o, ...r }) => r)
}

// Totals: sum the deduped per-message timeline, then pull cost / num_turns from
// the `result` event (those are emitted exactly once per run).
function extractScalars(text: string): { costUsd: number | null; numTurns: number | null } {
  let costUsd: number | null = null
  let numTurns: number | null = null
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type !== 'result') continue
    if (typeof v.total_cost_usd === 'number') costUsd = v.total_cost_usd as number
    if (typeof v.num_turns === 'number') numTurns = v.num_turns as number
  }
  return { costUsd, numTurns }
}

function summarizeTimeline(timeline: TimelineRow[]) {
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0
  for (const r of timeline) {
    input += r.in
    output += r.out
    cacheRead += r.cR
    cacheCreation += r.cW
  }
  return { input, output, cacheRead, cacheCreation }
}

function run(bin: string, model: string, prompt: string, timeoutMs: number): Usage {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    // Comma-separated form works for both `claude` and `claudin` (claude also
    // accepts space-separated via variadic, but with `-p` everything after a
    // bare `--allowedTools Read` may grab the next positional ambiguously).
    '--allowedTools', 'Read',
  ]
  const t0 = performance.now()
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, ANTHROPIC_MODEL: model },
    // Explicitly close stdin. Without this, both `claude` and `claudin -p`
    // wait ~3s for stdin data on the open pipe before proceeding.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  const stderrText = res.stderr ?? ''
  const timeline = extractTimeline(stdout)
  const sums = summarizeTimeline(timeline)
  const scalars = extractScalars(stdout)
  return {
    ...sums,
    ...scalars,
    wallMs,
    exitCode: res.status ?? -1,
    rawLen: stdout.length + stderrText.length,
    stderr: stderrText,
    timeline,
  }
}

function resolveBin(name: string): string {
  // 'claude' / 'claudin' / 'claudindev' on PATH, or an absolute path.
  if (name.includes('/')) return name
  return name
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'm'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function printTimeline(label: string, u: Usage) {
  console.log(`\n  ${label} — per-turn cache (cR=read, cW=write, each row = one assistant request):`)
  console.log(`    ${'turn'.padEnd(5)} ${'role'.padEnd(10)} ${'in'.padStart(8)} ${'cR(read)'.padStart(10)} ${'cW(write)'.padStart(11)} ${'out'.padStart(7)}`)
  u.timeline.forEach((r, i) => {
    console.log(`    ${String(i + 1).padEnd(5)} ${r.role.padEnd(10)} ${fmt(r.in).padStart(8)} ${fmt(r.cR).padStart(10)} ${fmt(r.cW).padStart(11)} ${fmt(r.out).padStart(7)}`)
  })
  // Sanity check: sum of per-row deltas must equal the printed totals.
  const sCR = u.timeline.reduce((a, r) => a + r.cR, 0)
  const sCW = u.timeline.reduce((a, r) => a + r.cW, 0)
  const sOut = u.timeline.reduce((a, r) => a + r.out, 0)
  if (sCR !== u.cacheRead || sCW !== u.cacheCreation || sOut !== u.output) {
    console.log(`    ! row-sum mismatch: rows cR=${sCR}/cW=${sCW}/out=${sOut} vs totals cR=${u.cacheRead}/cW=${u.cacheCreation}/out=${u.output}`)
  } else {
    console.log(`    (sum cR=${fmt(sCR)} cW=${fmt(sCW)} out=${fmt(sOut)} matches totals)`)
  }
}

function ratioOf(cacheRead: number, cacheCreation: number): string {
  if (cacheCreation === 0) return cacheRead > 0 ? '∞:1 (all read)' : 'n/a'
  return (cacheRead / cacheCreation).toFixed(2) + ':1'
}

function ratio(u: Usage): string {
  return ratioOf(u.cacheRead, u.cacheCreation)
}

function printBlocked(label: string, u: Usage) {
  console.log(`\n  ${label} — BLOCKED — exit=${u.exitCode}, see stderr below:`)
  const lines = (u.stderr || '(no stderr captured)').split('\n')
  const head = lines.slice(0, 30)
  for (const l of head) console.log(`    | ${l}`)
  if (lines.length > 30) console.log(`    | ... (${lines.length - 30} more lines truncated)`)
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

function pickMedianRun(runs: Usage[]): Usage {
  // Pick the run whose cacheRead is closest to the median cacheRead — that run's
  // timeline is then the one we render.
  const med = median(runs.map(r => r.cacheRead))
  let best = runs[0]
  let bestDist = Math.abs(best.cacheRead - med)
  for (const r of runs.slice(1)) {
    const d = Math.abs(r.cacheRead - med)
    if (d < bestDist) { best = r; bestDist = d }
  }
  return best
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('cache-ab-bench: claudin vs claude, same prompt/files/model, main-loop cache reuse.')
    console.log('  --model=<id> (default claude-sonnet-4-6)  --only=claude|claudin  --a=<bin> --b=<bin>  --json')
    console.log('  --runs=N (default 1; recommend 3 — reports median+min+max)  --skip-claude')
    return
  }

  const prompt = args.sequential
    ? buildSequentialPrompt(TWELVE_FILES, args.turns)
    : buildPrompt(TWELVE_FILES)
  if (args.sequential) console.log(`(sequential mode: 1 Read/turn, targeting ~${args.turns} turns for a fair per-turn cache comparison)`)
  const sides: Array<{ label: string; bin: string }> = []
  const wantA = !args.skipClaude && (args.only === null || args.only === 'a' || args.only === 'claude')
  const wantB = args.only === null || args.only === 'b' || args.only === 'claudin'
  if (wantA) sides.push({ label: `claude (${args.a})`, bin: resolveBin(args.a) })
  if (wantB) sides.push({ label: `claudin (${args.b})`, bin: resolveBin(args.b) })

  console.log(`\nCache A/B bench — model=${args.model}, ${TWELVE_FILES.length} files, main-loop only, runs=${args.runs}`)
  console.log(`(auth: active profiles; model pinned via --model + ANTHROPIC_MODEL)\n`)

  type SideResult = { label: string; bin: string; runs: Usage[] }
  const results: SideResult[] = []
  for (const s of sides) {
    const sideRuns: Usage[] = []
    for (let i = 0; i < args.runs; i++) {
      process.stdout.write(`▶ running ${s.label} [${i + 1}/${args.runs}] ... `)
      const u = run(s.bin, args.model, prompt, args.timeoutMs)
      console.log(`done (exit ${u.exitCode}, ${(u.wallMs / 1000).toFixed(1)}s, cR=${fmt(u.cacheRead)} cW=${fmt(u.cacheCreation)})`)
      sideRuns.push(u)
    }
    results.push({ label: s.label, bin: s.bin, runs: sideRuns })
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  console.log('\n' + '─'.repeat(96))
  console.log(`TOTALS (median of ${args.runs} run${args.runs === 1 ? '' : 's'}, min/max in brackets)`)
  console.log(`  ${'side'.padEnd(22)} ${'cR(med)'.padStart(12)} ${'cW(med)'.padStart(12)} ${'r:w(med)'.padStart(14)} ${'$(med)'.padStart(10)} ${'turns'.padStart(6)}  ok/total`)
  for (const { label, runs } of results) {
    const ok = runs.filter(r => r.exitCode === 0)
    const allFailed = ok.length === 0
    const pool = allFailed ? runs : ok
    const cRs = pool.map(r => r.cacheRead)
    const cWs = pool.map(r => r.cacheCreation)
    const costs = pool.map(r => r.costUsd ?? 0)
    const turns = pool.map(r => r.numTurns ?? 0)
    const cRmed = median(cRs), cWmed = median(cWs), costMed = median(costs), turnsMed = median(turns)
    const cRmin = Math.min(...cRs), cRmax = Math.max(...cRs)
    const cWmin = Math.min(...cWs), cWmax = Math.max(...cWs)
    const costMin = Math.min(...costs), costMax = Math.max(...costs)
    const rw = ratioOf(cRmed, cWmed)
    const okN = ok.length
    console.log(`  ${label.padEnd(22)} ${fmt(cRmed).padStart(12)} ${fmt(cWmed).padStart(12)} ${rw.padStart(14)} ${('$' + costMed.toFixed(4)).padStart(10)} ${String(turnsMed).padStart(6)}  ${okN}/${runs.length}`)
    if (runs.length > 1) {
      console.log(`  ${' '.repeat(22)} ${(`[${fmt(cRmin)}..${fmt(cRmax)}]`).padStart(12)} ${(`[${fmt(cWmin)}..${fmt(cWmax)}]`).padStart(12)} ${''.padStart(14)} ${(`[$${costMin.toFixed(2)}..$${costMax.toFixed(2)}]`).padStart(10)}`)
    }
  }
  console.log('─'.repeat(96))
  console.log('  read:write — higher is better. >5:1 = healthy reuse; ~1:1 = prefix rewritten each turn.')

  for (const { label, runs } of results) {
    const ok = runs.filter(r => r.exitCode === 0)
    if (ok.length === 0) {
      // ALL runs failed. Show the failure mode loudly (first failed run's stderr).
      printBlocked(label, runs[0])
      continue
    }
    const medianRun = pickMedianRun(ok)
    printTimeline(`${label} (median run)`, medianRun)
    // If any other runs failed, still surface that fact so we don't silently hide
    // partial breakage.
    const failed = runs.filter(r => r.exitCode !== 0)
    if (failed.length > 0) {
      console.log(`    note: ${failed.length}/${runs.length} run(s) failed; first failure stderr:`)
      const lines = (failed[0].stderr || '(no stderr)').split('\n').slice(0, 10)
      for (const l of lines) console.log(`      | ${l}`)
    }
  }
  console.log()
}

main()
