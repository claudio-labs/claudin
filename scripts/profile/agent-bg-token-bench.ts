#!/usr/bin/env bun
// Background-agent token bench: claudin (auto-background) vs claude (inline).
//
// Goal: compare read/write token cost of the SAME workload — an orchestrator
// that spawns N sub-agents, each reading the SAME fixed set of files and
// reporting back — under two regimes:
//
//   claudin   → auto-background agents ON (sub-agents run async, parent gets
//               "async launched" stubs instead of the full inline reports)
//   claude    → Claude Code, sub-agents run inline (parent ingests each full
//               report into its own context)
//
// We read the final `usage` from `-p --output-format json` for each run:
//   input_tokens, output_tokens, cache_read_input_tokens,
//   cache_creation_input_tokens, plus total_cost_usd / num_turns when present.
//
// FAIRNESS CAVEAT (read this): in headless `-p`, claudin does not explicitly
// drain background tasks before exit. If the parent returns before its async
// sub-agents finish, their token usage is NOT in the parent's reported usage
// and the work is not equivalent. This harness DETECTS that: with --probe it
// runs a single 1-file/1-agent job and checks whether the agent's report text
// shows up before exit. Always run --probe first and trust the table only if
// the probe says background agents are drained.
//
// Usage:
//   bun run scripts/profile/agent-bg-token-bench.ts --probe         # validate harness + drain
//   bun run scripts/profile/agent-bg-token-bench.ts --agents=2      # full run
//   bun run scripts/profile/agent-bg-token-bench.ts --only=claudin  # one side only
//   bun run scripts/profile/agent-bg-token-bench.ts --json
//
// Pin the model on BOTH sides for an apples-to-apples price comparison:
//   bun run scripts/profile/agent-bg-token-bench.ts --model=claude-sonnet-5 --reps=3
// Without --model each CLI uses its own default, which can differ (claudin
// follows the active /provider profile, claude follows its own setting) and
// then the cost column compares two different price tiers.

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const TEN_FILES = [
  'src/shared/errors.ts',
  'src/shared/log.ts',
  'src/shared/fs/path.ts',
  'src/shared/envUtils.ts',
  'src/shared/proc/Shell.ts',
  'src/platform/config/config.ts',
  'src/platform/bootstrap/state.ts',
  'src/tools/Tool.ts',
  'src/utils/model/model.ts',
  'src/providers/presets/providerModels.ts',
]

const SENTINEL = 'BENCH_AGENT_REPORT'

type Args = {
  agents: number
  files: number
  only: 'a' | 'b' | 'claudin' | 'claude' | null
  a: string
  b: string
  reps: number
  probe: boolean
  json: boolean
  help: boolean
  stream: boolean
  timeoutMs: number
  model: string
}

function parseArgs(argv: string[]): Args {
  const a: Args = { agents: 2, files: 10, only: null, a: '', b: '', reps: 1, probe: false, json: false, help: false, stream: false, timeoutMs: 600_000, model: '' }
  for (const x of argv) {
    if (x === '--stream') a.stream = true
    else if (x.startsWith('--a=')) a.a = x.slice('--a='.length)
    else if (x.startsWith('--b=')) a.b = x.slice('--b='.length)
    if (x === '--help' || x === '-h') a.help = true
    else if (x === '--json') a.json = true
    else if (x === '--probe') { a.probe = true; a.agents = 1; a.files = 1 }
    else if (x.startsWith('--reps=')) a.reps = Number(x.slice('--reps='.length))
    else if (x.startsWith('--agents=')) a.agents = Number(x.slice('--agents='.length))
    else if (x.startsWith('--files=')) a.files = Number(x.slice('--files='.length))
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Args['only']
  }
  return a
}

function buildPrompt(agents: number, fileList: string[]): string {
  const files = fileList.map(f => `  - ${f}`).join('\n')
  return [
    `Spawn exactly ${agents} sub-agents using the Task/Agent tool, in parallel.`,
    `Give EACH of the ${agents} agents the identical instruction below:`,
    ``,
    `"Read these ${fileList.length} files in full and report a one-line summary per file:`,
    files,
    `Begin your final message with the exact token ${SENTINEL} so it can be located."`,
    ``,
    `Wait for all ${agents} agents to finish. Then output a combined report and`,
    `begin your own final message with the exact token ${SENTINEL}_PARENT.`,
  ].join('\n')
}

type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  cacheCreation1h: number
  costUsd: number | null
  numTurns: number | null
  wallMs: number
  exitCode: number
  sawAgentReport: boolean
  sawParentReport: boolean
  rawLen: number
  raw: string
}

// Walk an arbitrary JSON value and accumulate any usage-shaped objects we find.
// claude/claudin stream-json and json modes nest usage differently, so we sum
// every `usage` object (input_tokens/output_tokens/...) we encounter plus any
// top-level total_cost_usd / num_turns.
function extractUsage(text: string): Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'cacheCreation1h' | 'costUsd' | 'numTurns'> {
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, cacheCreation1h = 0
  let costUsd: number | null = null
  let numTurns: number | null = null

  const consider = (o: Record<string, unknown>) => {
    const u = o.usage as Record<string, unknown> | undefined
    if (u && typeof u === 'object') {
      input += Number(u.input_tokens ?? 0)
      output += Number(u.output_tokens ?? 0)
      cacheRead += Number(u.cache_read_input_tokens ?? 0)
      cacheCreation += Number(u.cache_creation_input_tokens ?? 0)
      // Cache writes are billed by TTL: 5m costs 1.25x base input, 1h costs 2x.
      // Claudin writes 1h by default, Claude Code writes 5m — pricing them at a
      // single rate misreports the gap by ~1.6x on the cache-write column.
      const byTtl = u.cache_creation as Record<string, unknown> | undefined
      if (byTtl && typeof byTtl === 'object') cacheCreation1h += Number(byTtl.ephemeral_1h_input_tokens ?? 0)
    }
    if (typeof o.total_cost_usd === 'number') costUsd = o.total_cost_usd as number
    if (typeof o.num_turns === 'number') numTurns = o.num_turns as number
  }

  // `usage` is the PARENT session's own accounting — sub-agent turns are separate
  // API calls and are absent from it, which is why total_cost_usd can be ~2.7x what
  // the `usage` numbers price out to. `modelUsage` IS the whole-session aggregate
  // (it reconciles with total_cost_usd), so prefer it whenever both CLIs emit it.
  let mIn = 0, mOut = 0, mRead = 0, mWrite = 0
  const considerModelUsage = (o: Record<string, unknown>) => {
    const mu = o.modelUsage as Record<string, unknown> | undefined
    if (!mu || typeof mu !== 'object') return
    for (const v of Object.values(mu)) {
      const e = v as Record<string, unknown>
      if (!e || typeof e !== 'object') continue
      mIn += Number(e.inputTokens ?? 0)
      mOut += Number(e.outputTokens ?? 0)
      mRead += Number(e.cacheReadInputTokens ?? 0)
      mWrite += Number(e.cacheCreationInputTokens ?? 0)
    }
  }

  // Try whole-document parse first (json mode), then line-by-line (stream-json).
  const tryParse = (s: string) => { try { return JSON.parse(s) as unknown } catch { return undefined } }
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const e of v) walk(e); return }
    if (v && typeof v === 'object') {
      consider(v as Record<string, unknown>)
      considerModelUsage(v as Record<string, unknown>)
      for (const e of Object.values(v as Record<string, unknown>)) walk(e)
    }
  }
  const whole = tryParse(text)
  if (whole !== undefined) walk(whole)
  else for (const line of text.split('\n')) { const v = tryParse(line.trim()); if (v !== undefined) walk(v) }

  if (mIn + mOut + mRead + mWrite > 0) {
    // Scale the observed 1h share across to the session total; modelUsage has no
    // TTL breakdown, and a CLI's TTL choice is uniform across its own requests.
    const share = cacheCreation > 0 ? Math.min(cacheCreation1h, cacheCreation) / cacheCreation : 0
    return { input: mIn, output: mOut, cacheRead: mRead, cacheCreation: mWrite, cacheCreation1h: Math.round(mWrite * share), costUsd, numTurns }
  }
  return { input, output, cacheRead, cacheCreation, cacheCreation1h, costUsd, numTurns }
}

// Per-message cache breakdown: each assistant message in stream-json carries a
// `usage` showing how many tokens that turn READ from cache vs CREATED as new
// cache vs uncached input. This reveals *why* cost differs — poor cache reuse
// shows up as high cache_creation with low cache_read across turns.
function printCacheTimeline(label: string, text: string) {
  const rows: Array<{ in: number; out: number; cR: number; cW: number; role: string }> = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    const msg = (v.message ?? v) as Record<string, unknown>
    const u = msg.usage as Record<string, unknown> | undefined
    if (!u) continue
    rows.push({
      in: Number(u.input_tokens ?? 0),
      out: Number(u.output_tokens ?? 0),
      cR: Number(u.cache_read_input_tokens ?? 0),
      cW: Number(u.cache_creation_input_tokens ?? 0),
      role: String((v.type as string) ?? msg.role ?? '?'),
    })
  }
  console.log(`\n  ${label} — per-message cache timeline (in / out / cacheR / cacheW):`)
  let tcR = 0, tcW = 0
  rows.forEach((r, i) => {
    tcR += r.cR; tcW += r.cW
    const reuse = r.cR + r.cW > 0 ? ((r.cR / (r.cR + r.cW)) * 100).toFixed(0) : '—'
    console.log(`    #${String(i + 1).padStart(2)} ${r.role.padEnd(10)} in=${fmt(r.in).padStart(7)} out=${fmt(r.out).padStart(6)} cacheR=${fmt(r.cR).padStart(8)} cacheW=${fmt(r.cW).padStart(8)}  reuse=${reuse}%`)
  })
  const totReuse = tcR + tcW > 0 ? ((tcR / (tcR + tcW)) * 100).toFixed(1) : '—'
  console.log(`    cache reuse ratio = cacheR/(cacheR+cacheW) = ${totReuse}%  (higher = better; low = re-creating cache it never reads)`)
}

function run(bin: string, prompt: string, cwd: string, timeoutMs: number, stream = false, model = ''): Usage {
  const t0 = performance.now()
  const fmtArg = stream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']
  const modelArg = model ? ['--model', model] : []
  const res = spawnSync(bin, ['-p', prompt, ...fmtArg, ...modelArg], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  })
  const wallMs = performance.now() - t0
  const out = (res.stdout ?? '') + '\n' + (res.stderr ?? '')
  const u = extractUsage(out)
  return {
    ...u,
    wallMs,
    exitCode: res.status ?? -1,
    sawAgentReport: out.includes(SENTINEL),
    sawParentReport: out.includes(`${SENTINEL}_PARENT`),
    rawLen: out.length,
    raw: out,
  }
}

function fmt(n: number): string { return n.toLocaleString('en-US') }

// Public list price, USD per 1M tokens: [input, output, base-input, cache-read].
// Cache writes derive from base input: 5m = 1.25x, 1h = 2x.
// Keyed by a substring of the model id; first match wins, Opus is the fallback so
// an unpinned run keeps the historical numbers this bench was calibrated on.
const PRICES: Array<[string, [number, number, number, number]]> = [
  ['haiku', [1, 5, 1, 0.1]],
  ['sonnet', [3, 15, 3, 0.3]],
  ['opus', [15, 75, 15, 1.5]],
]

function priceFor(model: string) {
  const m = model.toLowerCase()
  const [, rate] = PRICES.find(([k]) => m.includes(k)) ?? PRICES[PRICES.length - 1]
  const [pIn, pOut, pBase, pRead] = rate
  return (u: Usage) => {
    const w1h = Math.min(u.cacheCreation1h, u.cacheCreation)
    const w5m = u.cacheCreation - w1h
    return u.input / 1e6 * pIn + u.output / 1e6 * pOut
      + w5m / 1e6 * (pBase * 1.25) + w1h / 1e6 * (pBase * 2) + u.cacheRead / 1e6 * pRead
  }
}

function printRow(label: string, u: Usage) {
  console.log(
    `  ${label.padEnd(9)} ` +
    `in=${fmt(u.input).padStart(9)}  out=${fmt(u.output).padStart(8)}  ` +
    `cacheR=${fmt(u.cacheRead).padStart(10)}  cacheW=${fmt(u.cacheCreation).padStart(9)}  ` +
    `1h=${u.cacheCreation ? Math.round(Math.min(u.cacheCreation1h, u.cacheCreation) / u.cacheCreation * 100) : 0}%  ` +
    `cost=${u.costUsd == null ? '   n/a' : '$' + u.costUsd.toFixed(4)}  ` +
    `turns=${u.numTurns ?? '?'}  ${(u.wallMs / 1000).toFixed(1)}s  exit=${u.exitCode}  ` +
    `report=${u.sawAgentReport ? 'Y' : 'N'}/${u.sawParentReport ? 'Y' : 'N'}`,
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('agent-bg-token-bench — claudin (bg agents) vs claude (inline). See header for flags.')
    return
  }

  const repo = resolve(import.meta.dir, '..', '..')
  if (!existsSync(resolve(repo, 'dist/cli.mjs'))) {
    console.error('dist/cli.mjs missing — run `bun run build` first.')
    process.exit(1)
  }

  const fileList = TEN_FILES.slice(0, args.files)
  const prompt = buildPrompt(args.agents, fileList)
  const price = priceFor(args.model)

  console.log(`\nagent-bg-token-bench  (agents=${args.agents}, files=${fileList.length}, model=${args.model || 'per-CLI default'}${args.probe ? ', PROBE' : ''})`)
  console.log(`workload: orchestrator spawns ${args.agents} agent(s), each reads ${fileList.length} file(s)\n`)

  const results: Record<string, Usage> = {}
  // bins are configurable via --a=label:cmd --b=label:cmd (default: claudindev vs claude).
  // Each "cmd" may include a leading env assignment, e.g. --b='stable:claudin'.
  const parsePair = (spec: string, fallbackKey: string, fallbackBin: string) => {
    if (!spec) return { key: fallbackKey, bin: fallbackBin }
    const i = spec.indexOf(':')
    return i === -1 ? { key: spec, bin: spec } : { key: spec.slice(0, i), bin: spec.slice(i + 1) }
  }
  const bins: Array<{ key: string; bin: string }> = []
  if (args.only !== 'claude' && args.only !== 'b') bins.push(parsePair(args.a, 'claudin', 'claudindev'))
  if (args.only !== 'claudin' && args.only !== 'a') bins.push(parsePair(args.b, 'claude', 'claude'))

  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
  const drainedRuns: Record<string, Usage[]> = {}
  for (const { key, bin } of bins) {
    drainedRuns[key] = []
    for (let r = 0; r < args.reps; r++) {
      process.stdout.write(`  running ${key} (${bin}${args.stream ? ', stream' : ''})${args.reps > 1 ? ` rep ${r + 1}/${args.reps}` : ''} ...\n`)
      const u = run(bin, prompt, repo, args.timeoutMs, args.stream, args.model)
      printRow(key, u)
      if (args.stream) printCacheTimeline(key, u.raw)
      if (u.sawAgentReport) drainedRuns[key].push(u)
      results[key] = u // last run, for the legacy summary below
    }
    if (args.reps > 1) {
      const d = drainedRuns[key]
      if (d.length === 0) { console.log(`  ${key}: 0/${args.reps} drained — all runs orphaned, no trustworthy data`); continue }
      const tot = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheCreation
      const reported = d.map(u => u.costUsd).filter((x): x is number => x != null)
      const medCost = reported.length === d.length ? median(reported) : median(d.map(price))
      console.log(`  ${key}: ${d.length}/${args.reps} drained → median total=${fmt(median(d.map(tot)))} tokens, median read=${fmt(median(d.map(u => u.input + u.cacheRead)))}, median out=${fmt(median(d.map(u => u.output)))}, median cost=$${medCost.toFixed(4)}${reported.length === d.length ? '' : ' (est)'}`)
      // Pick the rep sitting AT that median cost, so the comparison block below
      // describes the same run the median line just summarized.
      const byCost = [...d].sort((x, y) => (x.costUsd ?? price(x)) - (y.costUsd ?? price(y)))
      results[key] = byCost[Math.floor((byCost.length - 1) / 2)]
    }
  }

  if (args.probe) {
    console.log(`\n  PROBE verdict:`)
    for (const { key } of bins) {
      const u = results[key]
      const drained = u.sawAgentReport && u.input > 0
      console.log(`    ${key}: agent report present=${u.sawAgentReport ? 'Y' : 'N'}, usage captured=${u.input > 0 ? 'Y' : 'N'} → ${drained ? 'DRAINED (fair)' : 'NOT drained / no usage (UNFAIR — do not trust full run)'}`)
    }
  }

  if (bins.length === 2) {
    const [ka, kb] = bins.map(b => b.key)
    const c = results[ka], k = results[kb]
    const tok = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheCreation
    const reuse = (u: Usage) => u.cacheRead + u.cacheCreation > 0 ? (u.cacheRead / (u.cacheRead + u.cacheCreation) * 100).toFixed(0) + '%' : '—'
    const tc = tok(c), tk = tok(k), pc = price(c), pk = price(k)
    console.log(`\n  ── ${ka} vs ${kb} ──`)
    console.log(`  read tokens (input+cacheR):  ${ka}=${fmt(c.input + c.cacheRead)}  ${kb}=${fmt(k.input + k.cacheRead)}`)
    console.log(`  write tokens (output):       ${ka}=${fmt(c.output)}  ${kb}=${fmt(k.output)}`)
    console.log(`  cache write (creation):      ${ka}=${fmt(c.cacheCreation)}  ${kb}=${fmt(k.cacheCreation)}`)
    console.log(`  cache write @1h TTL (2x):    ${ka}=${fmt(Math.min(c.cacheCreation1h, c.cacheCreation))}  ${kb}=${fmt(Math.min(k.cacheCreation1h, k.cacheCreation))}`)
    console.log(`  total tokens:                ${ka}=${fmt(tc)}  ${kb}=${fmt(tk)}  (${ka} ${tk ? (((tk - tc) / tk) * 100).toFixed(0) : '0'}% vs ${kb})`)
    console.log(`  cache reuse R/(R+W):         ${ka}=${reuse(c)}  ${kb}=${reuse(k)}`)
    // The CLI-reported total_cost_usd is authoritative: it knows the real cache TTL
    // per request. The list estimate below infers the 1h share from the parent's
    // last usage block and scales it, so it drifts on a CLI that mixes TTLs.
    const dc = c.costUsd, dk = k.costUsd
    console.log(`  cost reported by the CLI:    ${ka}=${dc == null ? 'n/a' : '$' + dc.toFixed(4)}  ${kb}=${dk == null ? 'n/a' : '$' + dk.toFixed(4)}` +
      (dc != null && dk ? `  (${ka} ${(((dc - dk) / dk) * 100).toFixed(0)}% vs ${kb})` : ''))
    console.log(`  list-price estimate (approx):${ka}=$${pc.toFixed(4)}  ${kb}=$${pk.toFixed(4)}   ← TTL split inferred, cross-check only`)
    console.log(`  drained (agent report seen): ${ka}=${c.sawAgentReport ? 'Y' : 'N'}  ${kb}=${k.sawAgentReport ? 'Y' : 'N'}  ← N means bg agents orphaned (unfair)`)
  }

  if (args.json) console.log('\n' + JSON.stringify(results, null, 2))
}

main()
