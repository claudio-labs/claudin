#!/usr/bin/env bun
// RunTests tool A/B over a 15-turn session: claudin WITH the RunTests tool
// (arm A) vs claudin WITHOUT it — Bash-only (arm B). One resumed conversation
// per arm; each turn re-runs the suite in a single fixture whose test file is
// rewritten to cycle the 6-scenario set (3 passing, 3 failing). We read each
// turn's `modelUsage` to accumulate the numbers the user asked for:
//   cache read · cache write (creation) · cost · total tokens.
//
// Why one fixture + rewrite-per-turn (not 6 dirs): the conversation is a single
// resumed session, so the prompt cache accumulates across turns. Keeping cwd
// fixed avoids the tool-result cache's cwd-invalidation, so cache reuse reflects
// the session, not a churning working dir; the scenario is varied by rewriting
// the one test file before each turn.
//
// Arms:
//   A (with-tool) : --allowedTools RunTests                       → model must use RunTests
//   B (no-tool)   : --allowedTools Bash --disallowedTools RunTests → model runs `bun test` via Bash
//
// Usage:
//   bun run scripts/bench/run-tests-turns-ab.ts               # 15 turns/arm, sonnet 5
//   bun run scripts/bench/run-tests-turns-ab.ts --turns=15
//   bun run scripts/bench/run-tests-turns-ab.ts --arm=A       # one arm only
//   bun run scripts/bench/run-tests-turns-ab.ts --model=claude-sonnet-5
//   bun run scripts/bench/run-tests-turns-ab.ts --json

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = process.env.CLAUDIN_BENCH_ENTRY ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')

// 6-scenario set cycled across the 15 turns: 3 passing, then 3 failing.
const SCENARIOS: Array<'pass' | 'fail'> = ['pass', 'pass', 'pass', 'fail', 'fail', 'fail']

type ArmId = 'A' | 'B'
interface ArmSpec {
  id: ArmId
  label: string
  allowed: string[]
  disallowed: string[]
  expectTool: 'RunTests' | 'Bash'
}
const ARMS: Record<ArmId, ArmSpec> = {
  A: { id: 'A', label: 'with-tool (RunTests)', allowed: ['RunTests'], disallowed: ['Bash'], expectTool: 'RunTests' },
  B: { id: 'B', label: 'no-tool (Bash)', allowed: ['Bash'], disallowed: ['RunTests'], expectTool: 'Bash' },
}

interface Args {
  turns: number
  model: string
  timeoutMs: number
  arms: ArmId[]
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { turns: 15, model: 'claude-sonnet-5', timeoutMs: 180_000, arms: ['A', 'B'], json: false }
  for (const a of argv) {
    if (a === '--json') args.json = true
    else if (a.startsWith('--turns=')) args.turns = Math.max(1, Number(a.slice(8)))
    else if (a.startsWith('--model=')) args.model = a.slice(8)
    else if (a.startsWith('--timeout=')) args.timeoutMs = Number(a.slice(10))
    else if (a === '--arm=A') args.arms = ['A']
    else if (a === '--arm=B') args.arms = ['B']
  }
  return args
}

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rt-turns-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'rt-turns', version: '0.0.0', private: true }, null, 2))
  writeFileSync(join(dir, 'bun.lock'), '') // pm=bun → `bun test`
  return dir
}

function writeScenario(dir: string, kind: 'pass' | 'fail'): void {
  const suite = [
    `import { test, expect } from 'bun:test'`,
    ``,
    `test('addition works', () => {`,
    `  expect(1 + 1).toBe(2)`,
    `})`,
    ``,
    `test('multiplication works', () => {`,
    `  expect(2 * 3).toBe(${kind === 'fail' ? '7' : '6'})`, // broken in 'fail'
    `})`,
    ``,
  ].join('\n')
  writeFileSync(join(dir, 'math.test.ts'), suite)
}

interface TurnUsage {
  turn: number
  scenario: 'pass' | 'fail'
  ok: boolean
  sessionId: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number
  durationMs: number
}

function parseFinal(stdout: string, exitCode: number, turn: number, scenario: 'pass' | 'fail'): TurnUsage {
  const base: TurnUsage = {
    turn, scenario, ok: false, sessionId: '',
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, durationMs: 0,
  }
  const last = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  let p: Record<string, unknown>
  try {
    p = JSON.parse(last) as Record<string, unknown>
  } catch {
    return base
  }
  base.sessionId = typeof p.session_id === 'string' ? p.session_id : ''
  base.ok = p.type === 'result' && p.subtype === 'success' && exitCode === 0
  base.costUsd = typeof p.total_cost_usd === 'number' ? p.total_cost_usd : 0
  base.durationMs = typeof p.duration_ms === 'number' ? p.duration_ms : 0
  const usageRec = (p.modelUsage ?? {}) as Record<string, Record<string, number>>
  const u = Object.values(usageRec)[0] ?? {}
  base.input = Number(u.inputTokens ?? 0)
  base.output = Number(u.outputTokens ?? 0)
  base.cacheRead = Number(u.cacheReadInputTokens ?? 0)
  base.cacheCreation = Number(u.cacheCreationInputTokens ?? 0)
  return base
}

function sessionPath(sessionId: string, cwd: string): string | null {
  const projectsDir = join(CONFIG_DIR, 'projects')
  const direct = join(projectsDir, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  try {
    for (const proj of readdirSync(projectsDir)) {
      const p = join(projectsDir, proj, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* no projects dir */
  }
  return null
}

// Cumulative tool-use counts over the whole session transcript.
function toolCountsFor(sessionId: string, cwd: string): Record<string, number> {
  const path = sessionId ? sessionPath(sessionId, cwd) : null
  if (!path) return {}
  const counts: Record<string, number> = {}
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    let obj: { message?: { content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.type === 'tool_use' && typeof b?.name === 'string') counts[b.name] = (counts[b.name] ?? 0) + 1
    }
  }
  return counts
}

const total = (t: TurnUsage) => t.input + t.output + t.cacheRead + t.cacheCreation
const fmt = (n: number) => n.toLocaleString('en-US')

function runArm(arm: ArmSpec, args: Args): { turns: TurnUsage[]; toolCounts: Record<string, number>; cwd: string } {
  const cwd = makeFixtureDir()
  const turns: TurnUsage[] = []
  let sessionId = ''
  console.log(`\n▸ Arm ${arm.id} — ${arm.label}`)
  console.log('  turn scen  cacheRead  cacheWrite     inTok    outTok   totalTok     cost   time')
  for (let t = 1; t <= args.turns; t++) {
    const scenario = SCENARIOS[(t - 1) % SCENARIOS.length]
    writeScenario(cwd, scenario)
    const prompt =
      t === 1
        ? "Run this project's test suite and tell me whether it passed or failed. If it failed, name the failing test and where it is."
        : 'Run the test suite again and report whether it passed or failed, naming any failing test.'
    const argv = [ENTRY, '-p', prompt, '--model', args.model, '--output-format', 'json', '--permission-mode', 'bypassPermissions']
    if (t > 1 && sessionId) argv.push('--resume', sessionId)
    if (arm.allowed.length) argv.push('--allowedTools', ...arm.allowed)
    if (arm.disallowed.length) argv.push('--disallowedTools', ...arm.disallowed)
    const res = spawnSync('node', argv, {
      cwd,
      encoding: 'utf8',
      timeout: args.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    })
    const u = parseFinal(res.stdout ?? '', res.status ?? -1, t, scenario)
    if (u.sessionId) sessionId = u.sessionId
    turns.push(u)
    console.log(
      `  ${String(t).padStart(4)} ${scenario === 'pass' ? 'PASS' : 'FAIL'}  ` +
        `${fmt(u.cacheRead).padStart(9)}  ${fmt(u.cacheCreation).padStart(9)}  ${fmt(u.input).padStart(8)}  ` +
        `${fmt(u.output).padStart(8)}  ${fmt(total(u)).padStart(9)}  $${u.costUsd.toFixed(4)}  ${(u.durationMs / 1000).toFixed(1)}s` +
        `${u.ok ? '' : '  ⚠FAILrun'}`,
    )
  }
  const toolCounts = toolCountsFor(sessionId, cwd)
  rmSync(cwd, { recursive: true, force: true })
  return { turns, toolCounts, cwd }
}

interface ArmTotals {
  arm: ArmId
  label: string
  turns: number
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
  totalTokens: number
  cost: number
  toolCounts: Record<string, number>
}

function sumArm(arm: ArmSpec, r: { turns: TurnUsage[]; toolCounts: Record<string, number> }): ArmTotals {
  const acc = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, totalTokens: 0, cost: 0 }
  for (const t of r.turns) {
    acc.cacheRead += t.cacheRead
    acc.cacheWrite += t.cacheCreation
    acc.input += t.input
    acc.output += t.output
    acc.totalTokens += total(t)
    acc.cost += t.costUsd
  }
  return { arm: arm.id, label: arm.label, turns: r.turns.length, ...acc, toolCounts: r.toolCounts }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(ENTRY)) {
    console.error(`✗ bundle not found at ${ENTRY} — run \`bun run build\` first.`)
    process.exit(1)
  }
  console.log(
    `RunTests turns A/B — model=${args.model}  turns=${args.turns}/arm  ` +
      `scenarios cycled: [${SCENARIOS.join(',')}]  (A=with RunTests, B=Bash-only)`,
  )

  const totals: ArmTotals[] = []
  for (const id of args.arms) {
    const arm = ARMS[id]
    const r = runArm(arm, args)
    totals.push(sumArm(arm, r))
  }

  console.log('\n══ Arm totals ══')
  console.log('  arm  label                  turns   cacheRead  cacheWrite   totalTok      cost   tools')
  for (const s of totals) {
    const tools = Object.entries(s.toolCounts).map(([k, v]) => `${k}×${v}`).join(' ') || '—'
    console.log(
      `  ${s.arm}    ${s.label.padEnd(20)}  ${String(s.turns).padStart(5)}   ` +
        `${fmt(s.cacheRead).padStart(9)}  ${fmt(s.cacheWrite).padStart(9)}  ${fmt(s.totalTokens).padStart(9)}  ` +
        `$${s.cost.toFixed(4)}   ${tools}`,
    )
  }

  const A = totals.find(t => t.arm === 'A')
  const B = totals.find(t => t.arm === 'B')
  if (A && B) {
    const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${(((a - b) / b) * 100).toFixed(1)}%`)
    console.log('\n══ A vs B (with-tool relative to Bash-only) ══')
    console.log(`  cache read : A ${fmt(A.cacheRead)}  vs  B ${fmt(B.cacheRead)}   (${pct(A.cacheRead, B.cacheRead)})`)
    console.log(`  cache write: A ${fmt(A.cacheWrite)}  vs  B ${fmt(B.cacheWrite)}   (${pct(A.cacheWrite, B.cacheWrite)})`)
    console.log(`  total tok  : A ${fmt(A.totalTokens)}  vs  B ${fmt(B.totalTokens)}   (${pct(A.totalTokens, B.totalTokens)})`)
    console.log(`  cost       : A $${A.cost.toFixed(4)}  vs  B $${B.cost.toFixed(4)}   (${pct(A.cost, B.cost)})`)
  }

  if (args.json) console.log('\n' + JSON.stringify(totals, null, 2))
}

main()
