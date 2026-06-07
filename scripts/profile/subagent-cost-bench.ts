#!/usr/bin/env bun
// Subagent-cost bench: does fork-by-default (auto-background) make a
// subagent-heavy workload CHEAPER or MORE EXPENSIVE? Same prompt, same model
// (sonnet, cheap), claudin only, two regimes:
//
//   default                       → fork-by-default ON (subagent forks the parent,
//                                    inherits its warm prompt cache)
//   CLAUDE_AUTO_BACKGROUND_TASKS=0 → plain isolated subagents (cold prefix each)
//
// In headless -p, forks run INLINE (auto-background gate is masked), so their
// usage IS captured in the parent's reported totals — the comparison is fair.
// We also check a sentinel to confirm the subagents actually ran and reported.
//
//   bun run scripts/profile/subagent-cost-bench.ts
//   bun run scripts/profile/subagent-cost-bench.ts --agents=3

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const FILES = [
  'src/utils/errors.ts', 'src/utils/log.ts', 'src/utils/path.ts', 'src/utils/envUtils.ts',
  'src/utils/Shell.ts', 'src/utils/config.ts', 'src/bootstrap/state.ts', 'src/Tool.ts',
  'src/utils/model/model.ts', 'src/utils/providerModels.ts', 'src/context.ts', 'src/query.ts',
]
const MODEL = 'claude-sonnet-4-6'
const SENT = 'SUBAGENT_DONE'

function parseArgs(argv: string[]) {
  let agents = 3
  for (const x of argv) if (x.startsWith('--agents=')) agents = Number(x.slice(9))
  return { agents }
}

function buildPrompt(agents: number): string {
  const per = Math.ceil(FILES.length / agents)
  const groups = Array.from({ length: agents }, (_, i) => FILES.slice(i * per, (i + 1) * per))
  return [
    `Spawn exactly ${agents} sub-agents in parallel using the Agent tool.`,
    `Give each sub-agent one of these file groups and tell it to read every file in full`,
    `and reply with a one-line summary per file, beginning its final message with ${SENT}:`,
    ...groups.map((g, i) => `  Agent ${i + 1}: ${g.join(', ')}`),
    `Wait for all sub-agents, then output a combined summary.`,
  ].join('\n')
}

function extract(text: string) {
  let cR = 0, cW = 0, inp = 0, out = 0, cost: number | null = null, turns: number | null = null
  const consider = (o: any) => {
    const u = o?.usage
    if (u && typeof u === 'object') {
      inp += Number(u.input_tokens ?? 0); out += Number(u.output_tokens ?? 0)
      cR += Number(u.cache_read_input_tokens ?? 0); cW += Number(u.cache_creation_input_tokens ?? 0)
    }
    if (typeof o?.total_cost_usd === 'number') cost = o.total_cost_usd
    if (typeof o?.num_turns === 'number') turns = o.num_turns
  }
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') { consider(v); Object.values(v).forEach(walk) }
  }
  for (const line of text.split('\n')) { try { walk(JSON.parse(line.trim())) } catch {} }
  return { cR, cW, inp, out, cost, turns, sentinels: (text.match(new RegExp(SENT, 'g')) ?? []).length }
}

function run(label: string, extraEnv: Record<string, string>, prompt: string) {
  process.stdout.write(`▶ ${label} ... `)
  const t0 = performance.now()
  const res = spawnSync('claudindev', [
    '-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Read,Agent,Task,TaskCreate,TaskOutput,TaskList',
  ], {
    encoding: 'utf8', timeout: 300_000, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ANTHROPIC_MODEL: MODEL, ...extraEnv },
  })
  const ms = performance.now() - t0
  const u = extract((res.stdout ?? '') + '\n' + (res.stderr ?? ''))
  console.log(`done (${(ms / 1000).toFixed(1)}s, exit ${res.status})`)
  return { label, ...u, ms }
}

const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)

function main() {
  const { agents } = parseArgs(process.argv.slice(2))
  const prompt = buildPrompt(agents)
  console.log(`\nSubagent-cost bench — model=${MODEL}, ${agents} sub-agents, claudin only\n`)

  const a = run('FORK default (auto-background ON)', {}, prompt)
  const b = run('FORK OFF (CLAUDE_AUTO_BACKGROUND_TASKS=0)', { CLAUDE_AUTO_BACKGROUND_TASKS: '0' }, prompt)

  console.log('\n' + '─'.repeat(78))
  console.log(`  ${'regime'.padEnd(40)} ${'cR'.padStart(7)} ${'cW'.padStart(7)} ${'$'.padStart(9)} ${'turns'.padStart(6)} ${'subs'.padStart(5)}`)
  for (const r of [a, b]) {
    console.log(`  ${r.label.padEnd(40)} ${fmt(r.cR).padStart(7)} ${fmt(r.cW).padStart(7)} ${(r.cost != null ? '$' + r.cost.toFixed(4) : '?').padStart(9)} ${String(r.turns ?? '?').padStart(6)} ${String(r.sentinels).padStart(5)}`)
  }
  console.log('─'.repeat(78))
  if (a.cost != null && b.cost != null) {
    const cheaper = a.cost < b.cost ? 'FORK default' : 'FORK OFF'
    const pct = Math.abs(100 * (a.cost - b.cost) / Math.max(a.cost, b.cost)).toFixed(0)
    console.log(`  → ${cheaper} is cheaper by ~${pct}%  (fork ${a.cost < b.cost ? 'HELPED' : 'HURT'} subagent cost)`)
  }
  console.log(`  subs = ${SENT} sentinel count (confirms sub-agents actually ran & reported)\n`)
}

main()
