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
// Usage:
//   bun run scripts/profile/cache-ab-bench.ts                 # full A/B
//   bun run scripts/profile/cache-ab-bench.ts --only=claudin  # one side
//   bun run scripts/profile/cache-ab-bench.ts --model=claude-opus-4-7
//   bun run scripts/profile/cache-ab-bench.ts --a=claude --b=claudindev
//   bun run scripts/profile/cache-ab-bench.ts --json

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'

const TWELVE_FILES = [
  'src/utils/errors.ts',
  'src/utils/log.ts',
  'src/utils/path.ts',
  'src/utils/envUtils.ts',
  'src/utils/Shell.ts',
  'src/utils/config.ts',
  'src/bootstrap/state.ts',
  'src/Tool.ts',
  'src/utils/model/model.ts',
  'src/utils/providerModels.ts',
  'src/context.ts',
  'src/query.ts',
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
  }
  for (const x of argv) {
    if (x === '--help' || x === '-h') a.help = true
    else if (x === '--json') a.json = true
    else if (x === '--sequential') a.sequential = true
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
  timeline: Array<{ in: number; out: number; cR: number; cW: number; role: string }>
}

// Sum every `usage`-shaped object in the JSON (json + stream-json nest differently).
function extractTotals(text: string) {
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0
  let costUsd: number | null = null
  let numTurns: number | null = null
  const consider = (o: Record<string, unknown>) => {
    const u = o.usage as Record<string, unknown> | undefined
    if (u && typeof u === 'object') {
      input += Number(u.input_tokens ?? 0)
      output += Number(u.output_tokens ?? 0)
      cacheRead += Number(u.cache_read_input_tokens ?? 0)
      cacheCreation += Number(u.cache_creation_input_tokens ?? 0)
    }
    if (typeof o.total_cost_usd === 'number') costUsd = o.total_cost_usd as number
    if (typeof o.num_turns === 'number') numTurns = o.num_turns as number
  }
  const tryParse = (s: string) => { try { return JSON.parse(s) as unknown } catch { return undefined } }
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const e of v) walk(e); return }
    if (v && typeof v === 'object') {
      consider(v as Record<string, unknown>)
      for (const e of Object.values(v as Record<string, unknown>)) walk(e)
    }
  }
  const whole = tryParse(text)
  if (whole !== undefined) walk(whole)
  else for (const line of text.split('\n')) { const v = tryParse(line.trim()); if (v !== undefined) walk(v) }
  return { input, output, cacheRead, cacheCreation, costUsd, numTurns }
}

// Per-turn cache breakdown from stream-json: each assistant message carries its own
// usage. This is where you SEE the rewrite — high cW + low cR every turn = broken reuse.
function extractTimeline(text: string): Usage['timeline'] {
  const rows: Usage['timeline'] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type !== 'assistant' && v.type !== 'user') continue
    const msg = (v.message ?? v) as Record<string, unknown>
    const u = msg.usage as Record<string, unknown> | undefined
    if (!u) continue
    rows.push({
      in: Number(u.input_tokens ?? 0),
      out: Number(u.output_tokens ?? 0),
      cR: Number(u.cache_read_input_tokens ?? 0),
      cW: Number(u.cache_creation_input_tokens ?? 0),
      role: String(v.type),
    })
  }
  return rows
}

function run(bin: string, model: string, prompt: string, timeoutMs: number): Usage {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'Read',
  ]
  const t0 = performance.now()
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, ANTHROPIC_MODEL: model },
  })
  const wallMs = performance.now() - t0
  const out = (res.stdout ?? '') + '\n' + (res.stderr ?? '')
  const totals = extractTotals(out)
  return {
    ...totals,
    wallMs,
    exitCode: res.status ?? -1,
    rawLen: out.length,
    timeline: extractTimeline(out),
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
  console.log(`\n  ${label} — per-turn cache (cR=read, cW=write):`)
  console.log(`    ${'turn'.padEnd(5)} ${'role'.padEnd(10)} ${'in'.padStart(8)} ${'cR(read)'.padStart(10)} ${'cW(write)'.padStart(11)} ${'out'.padStart(7)}`)
  u.timeline.forEach((r, i) => {
    console.log(`    ${String(i + 1).padEnd(5)} ${r.role.padEnd(10)} ${fmt(r.in).padStart(8)} ${fmt(r.cR).padStart(10)} ${fmt(r.cW).padStart(11)} ${fmt(r.out).padStart(7)}`)
  })
}

function ratio(u: Usage): string {
  if (u.cacheCreation === 0) return u.cacheRead > 0 ? '∞:1 (all read)' : 'n/a'
  return (u.cacheRead / u.cacheCreation).toFixed(2) + ':1'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('cache-ab-bench: claudin vs claude, same prompt/files/model, main-loop cache reuse.')
    console.log('  --model=<id> (default claude-sonnet-4-6)  --only=claude|claudin  --a=<bin> --b=<bin>  --json')
    return
  }

  const prompt = args.sequential
    ? buildSequentialPrompt(TWELVE_FILES, args.turns)
    : buildPrompt(TWELVE_FILES)
  if (args.sequential) console.log(`(sequential mode: 1 Read/turn, targeting ~${args.turns} turns for a fair per-turn cache comparison)`)
  const sides: Array<{ label: string; bin: string }> = []
  const wantA = args.only === null || args.only === 'a' || args.only === 'claude'
  const wantB = args.only === null || args.only === 'b' || args.only === 'claudin'
  if (wantA) sides.push({ label: `claude (${args.a})`, bin: resolveBin(args.a) })
  if (wantB) sides.push({ label: `claudin (${args.b})`, bin: resolveBin(args.b) })

  console.log(`\nCache A/B bench — model=${args.model}, 12 files, 3 rounds, main-loop only`)
  console.log(`(auth: active profiles; model pinned via --model + ANTHROPIC_MODEL)\n`)

  const results: Array<{ label: string; u: Usage }> = []
  for (const s of sides) {
    process.stdout.write(`▶ running ${s.label} ... `)
    const u = run(s.bin, args.model, prompt, args.timeoutMs)
    console.log(`done (exit ${u.exitCode}, ${(u.wallMs / 1000).toFixed(1)}s)`)
    if (u.exitCode !== 0) {
      console.log(`  ⚠ non-zero exit — check binary "${s.bin}" exists on PATH and the model is reachable.`)
    }
    results.push({ label: s.label, u })
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  console.log('\n' + '─'.repeat(72))
  console.log('TOTALS')
  console.log(`  ${'side'.padEnd(20)} ${'cR(read)'.padStart(10)} ${'cW(write)'.padStart(11)} ${'read:write'.padStart(14)} ${'$'.padStart(8)} ${'turns'.padStart(6)}`)
  for (const { label, u } of results) {
    console.log(`  ${label.padEnd(20)} ${fmt(u.cacheRead).padStart(10)} ${fmt(u.cacheCreation).padStart(11)} ${ratio(u).padStart(14)} ${(u.costUsd != null ? '$' + u.costUsd.toFixed(4) : '?').padStart(8)} ${String(u.numTurns ?? '?').padStart(6)}`)
  }
  console.log('─'.repeat(72))
  console.log('  read:write — higher is better. >5:1 = healthy reuse; ~1:1 = prefix rewritten each turn.')

  for (const { label, u } of results) printTimeline(label, u)
  console.log()
}

main()
