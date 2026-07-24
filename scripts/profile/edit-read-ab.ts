#!/usr/bin/env bun
// Edit+Read token/cost A/B: claudindev vs claude (Claude Code), same model.
//
// Workload (identical for both): in a throwaway sandbox, READ 20 files in full
// and EDIT 10 files by inserting one deterministic marker line at the top of
// each. We then read the final `usage` from `-p --output-format json` and price
// it with Sonnet rates. Because the edit is deterministic and verifiable, we can
// confirm both sides actually did the work (edits=10/10) before trusting a row.
//
// Why a sandbox: edits mutate files, so each binary must start from a byte-
// identical tree. We regenerate a fresh sandbox before every run and run each
// binary with that sandbox as its cwd.
//
// FAIRNESS NOTES:
//   * Both run --permission-mode bypassPermissions so no approval prompt stalls
//     the headless run (sandbox is disposable, no network work in the prompt).
//   * Trust a row only if edits=10/10 and reads confirmed (sentinel present).
//     A run that skipped files reads/edits fewer tokens and is NOT comparable.
//   * --model defaults to claude-sonnet-5 for BOTH; override per side if needed.
//   * N>=3 reps + median is strongly recommended — single runs are noisy.
//
// Usage:
//   bun run scripts/profile/edit-read-ab.ts --probe            # 2 read / 1 edit smoke both bins
//   bun run scripts/profile/edit-read-ab.ts --reps=3           # full A/B, median of 3
//   bun run scripts/profile/edit-read-ab.ts --only=claudin     # one side only
//   bun run scripts/profile/edit-read-ab.ts --model=claude-sonnet-4-5
//   bun run scripts/profile/edit-read-ab.ts --claude-model=sonnet --claudin-model=claude-sonnet-5
//   bun run scripts/profile/edit-read-ab.ts --json

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MARKER = '// BENCH_EDIT_APPLIED'
const READ_SENTINEL = 'BENCH_READ_DONE'

type Args = {
  reads: number
  edits: number
  only: 'claudin' | 'claude' | null
  reps: number
  model: string
  claudinModel: string
  claudeModel: string
  probe: boolean
  json: boolean
  keep: boolean
  timeoutMs: number
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    reads: 20, edits: 10, only: null, reps: 1,
    model: 'claude-sonnet-5', claudinModel: '', claudeModel: '',
    probe: false, json: false, keep: false, timeoutMs: 600_000, help: false,
  }
  for (const x of argv) {
    if (x === '--help' || x === '-h') a.help = true
    else if (x === '--json') a.json = true
    else if (x === '--keep') a.keep = true
    else if (x === '--probe') { a.probe = true; a.reads = 2; a.edits = 1 }
    else if (x.startsWith('--reps=')) a.reps = Number(x.slice('--reps='.length))
    else if (x.startsWith('--reads=')) a.reads = Number(x.slice('--reads='.length))
    else if (x.startsWith('--edits=')) a.edits = Number(x.slice('--edits='.length))
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--claudin-model=')) a.claudinModel = x.slice('--claudin-model='.length)
    else if (x.startsWith('--claude-model=')) a.claudeModel = x.slice('--claude-model='.length)
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Args['only']
  }
  return a
}

// A plausible ~45-line TS module so each read costs real tokens but stays well
// under the outline cap (both tools read it in full, not as an outline).
function fixtureContent(kind: 'read' | 'edit', n: number): string {
  const lines: string[] = [
    `// fixture ${kind}_${String(n).padStart(2, '0')}.ts — disposable bench file`,
    `import { performance } from 'node:perf_hooks'`,
    ``,
    `export interface Record${n} {`,
    `  id: number`,
    `  label: string`,
    `  weight: number`,
    `  tags: string[]`,
    `}`,
    ``,
    `const SEED_${n} = ${n * 7 + 13}`,
    ``,
    `export function build${n}(count: number): Record${n}[] {`,
    `  const out: Record${n}[] = []`,
    `  for (let i = 0; i < count; i++) {`,
    `    out.push({`,
    `      id: SEED_${n} + i,`,
    `      label: 'item-' + i + '-of-${kind}${n}',`,
    `      weight: (i * SEED_${n}) % 97,`,
    `      tags: ['${kind}', 'n${n}', 'i' + i],`,
    `    })`,
    `  }`,
    `  return out`,
    `}`,
    ``,
    `export function score${n}(rows: Record${n}[]): number {`,
    `  let acc = 0`,
    `  for (const r of rows) acc += r.weight * (r.tags.length + 1)`,
    `  return acc / Math.max(1, rows.length)`,
    `}`,
    ``,
    `export function summarize${n}(rows: Record${n}[]): string {`,
    `  const t0 = performance.now()`,
    `  const s = score${n}(rows)`,
    `  const ms = performance.now() - t0`,
    `  return 'kind=${kind} n=${n} rows=' + rows.length + ' score=' + s.toFixed(2) + ' ms=' + ms.toFixed(3)`,
    `}`,
    ``,
    `export default { build${n}, score${n}, summarize${n} }`,
  ]
  return lines.join('\n') + '\n'
}

// Build a fresh, byte-identical sandbox tree; return its path.
function makeSandbox(reads: number, edits: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudin-edit-ab-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (let i = 1; i <= reads; i++) writeFileSync(join(dir, 'src', `read_${String(i).padStart(2, '0')}.ts`), fixtureContent('read', i))
  for (let i = 1; i <= edits; i++) writeFileSync(join(dir, 'src', `edit_${String(i).padStart(2, '0')}.ts`), fixtureContent('edit', i))
  return dir
}

// How many edit_*.ts actually received the marker line.
function countApplied(dir: string): number {
  let n = 0
  for (const f of readdirSync(join(dir, 'src'))) {
    if (!f.startsWith('edit_')) continue
    if (readFileSync(join(dir, 'src', f), 'utf8').includes(MARKER)) n++
  }
  return n
}

function buildPrompt(reads: number, edits: number): string {
  return [
    `You are in a disposable sandbox. Do exactly this, no more:`,
    ``,
    `1. Read these ${reads} files IN FULL: src/read_01.ts through src/read_${String(reads).padStart(2, '0')}.ts.`,
    `2. Edit these ${edits} files: src/edit_01.ts through src/edit_${String(edits).padStart(2, '0')}.ts.`,
    `   In each edited file, insert this EXACT line as the new first line of the file:`,
    `   ${MARKER}`,
    `   Do not change anything else in those files.`,
    ``,
    `When both steps are done, output one line beginning with the exact token`,
    `${READ_SENTINEL} followed by how many files you read and edited.`,
  ].join('\n')
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
  editsApplied: number
  sawSentinel: boolean
  rawLen: number
}

function extractUsage(text: string) {
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

function run(bin: string, model: string, prompt: string, sandbox: string, timeoutMs: number): Usage {
  const t0 = performance.now()
  const res = spawnSync(bin, [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  ], {
    cwd: sandbox,
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
    editsApplied: countApplied(sandbox),
    sawSentinel: out.includes(READ_SENTINEL),
    rawLen: out.length,
  }
}

const fmt = (n: number) => n.toLocaleString('en-US')

// Sonnet pricing (USD / 1M tokens): input 3, output 15, cache-create 3.75, cache-read 0.30.
const price = (u: Usage) =>
  u.input / 1e6 * 3 + u.output / 1e6 * 15 + u.cacheCreation / 1e6 * 3.75 + u.cacheRead / 1e6 * 0.30
const totalTok = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheCreation
const readTok = (u: Usage) => u.input + u.cacheRead
const reusePct = (u: Usage) => u.cacheRead + u.cacheCreation > 0
  ? (u.cacheRead / (u.cacheRead + u.cacheCreation) * 100).toFixed(0) + '%' : '—'

function printRow(label: string, edits: number, u: Usage) {
  console.log(
    `  ${label.padEnd(9)} ` +
    `read=${fmt(readTok(u)).padStart(9)}  out=${fmt(u.output).padStart(7)}  ` +
    `cacheW=${fmt(u.cacheCreation).padStart(9)}  reuse=${reusePct(u).padStart(4)}  ` +
    `cost=${u.costUsd == null ? '$' + price(u).toFixed(4) + '*' : '$' + u.costUsd.toFixed(4)}  ` +
    `turns=${u.numTurns ?? '?'}  ${(u.wallMs / 1000).toFixed(1)}s  exit=${u.exitCode}  ` +
    `edits=${u.editsApplied}/${edits}  sentinel=${u.sawSentinel ? 'Y' : 'N'}`,
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('edit-read-ab — claudindev vs claude, edit N + read M, token/cache/cost. See header for flags.')
    return
  }
  const prompt = buildPrompt(args.reads, args.edits)
  const bins: Array<{ key: string; bin: string; model: string }> = []
  if (args.only !== 'claude') bins.push({ key: 'claudin', bin: 'claudindev', model: args.claudinModel || args.model })
  if (args.only !== 'claudin') bins.push({ key: 'claude', bin: 'claude', model: args.claudeModel || args.model })

  console.log(`\nedit-read-ab  (read ${args.reads}, edit ${args.edits}, reps=${args.reps}${args.probe ? ', PROBE' : ''})`)
  console.log(`models: ${bins.map(b => `${b.key}=${b.model}`).join('  ')}`)
  console.log(`cost column: $N = tool-reported total_cost_usd; $N* = estimated from usage at Sonnet rates\n`)

  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
  const results: Record<string, Usage> = {}
  const good: Record<string, Usage[]> = {}

  for (const { key, bin, model } of bins) {
    good[key] = []
    for (let r = 0; r < args.reps; r++) {
      const sandbox = makeSandbox(args.reads, args.edits)
      process.stdout.write(`  running ${key} (${bin}, ${model})${args.reps > 1 ? ` rep ${r + 1}/${args.reps}` : ''} ...\n`)
      const u = run(bin, model, prompt, sandbox, args.timeoutMs)
      printRow(key, args.edits, u)
      const fair = u.editsApplied === args.edits && u.sawSentinel && u.input + u.cacheRead > 0
      if (fair) good[key].push(u)
      results[key] = u
      if (!args.keep) rmSync(sandbox, { recursive: true, force: true })
      else console.log(`    sandbox kept: ${sandbox}`)
    }
    if (args.reps > 1) {
      const d = good[key]
      if (d.length === 0) { console.log(`  ${key}: 0/${args.reps} fair runs (edits/sentinel incomplete) — no trustworthy data`); continue }
      console.log(`  ${key}: ${d.length}/${args.reps} fair → median read=${fmt(median(d.map(readTok)))}, out=${fmt(median(d.map(u => u.output)))}, cacheW=${fmt(median(d.map(u => u.cacheCreation)))}, total=${fmt(median(d.map(totalTok)))}, cost=$${median(d.map(u => u.costUsd ?? price(u))).toFixed(4)}`)
      results[key] = d[Math.floor(d.length / 2)]
    }
  }

  if (args.probe) {
    console.log(`\n  PROBE verdict:`)
    for (const { key } of bins) {
      const u = results[key]
      const ok = u.editsApplied > 0 && u.sawSentinel && u.input + u.cacheRead > 0
      console.log(`    ${key}: edits=${u.editsApplied}, sentinel=${u.sawSentinel ? 'Y' : 'N'}, usage=${u.input + u.cacheRead > 0 ? 'Y' : 'N'} → ${ok ? 'WORKS (fair)' : 'BROKEN (check auth/model/flags before full run)'}`)
    }
  }

  if (bins.length === 2 && results[bins[0].key] && results[bins[1].key]) {
    const [ka, kb] = bins.map(b => b.key)
    const c = results[ka], k = results[kb]
    const cost = (u: Usage) => u.costUsd ?? price(u)
    const pc = cost(c), pk = cost(k), tc = totalTok(c), tk = totalTok(k)
    console.log(`\n  ── ${ka} vs ${kb} ──`)
    console.log(`  read tokens (input+cacheR):  ${ka}=${fmt(readTok(c))}  ${kb}=${fmt(readTok(k))}`)
    console.log(`  write tokens (output):       ${ka}=${fmt(c.output)}  ${kb}=${fmt(k.output)}`)
    console.log(`  cache write (creation):      ${ka}=${fmt(c.cacheCreation)}  ${kb}=${fmt(k.cacheCreation)}`)
    console.log(`  cache reuse R/(R+W):         ${ka}=${reusePct(c)}  ${kb}=${reusePct(k)}`)
    console.log(`  total tokens:                ${ka}=${fmt(tc)}  ${kb}=${fmt(tk)}  (${ka} ${tk ? (((tc - tk) / tk) * 100).toFixed(0) : '0'}% vs ${kb})`)
    console.log(`  est. cost (Sonnet):          ${ka}=$${pc.toFixed(4)}  ${kb}=$${pk.toFixed(4)}  (${ka} ${pk ? (((pc - pk) / pk) * 100).toFixed(0) : '0'}% vs ${kb})`)
    console.log(`  work done (edits/sentinel):  ${ka}=${c.editsApplied}/${args.edits} ${c.sawSentinel ? 'Y' : 'N'}  ${kb}=${k.editsApplied}/${args.edits} ${k.sawSentinel ? 'Y' : 'N'}  ← both must be complete to compare`)
  }

  if (args.json) console.log('\n' + JSON.stringify(results, null, 2))
}

main()
