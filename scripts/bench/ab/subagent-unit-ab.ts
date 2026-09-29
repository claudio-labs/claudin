#!/usr/bin/env bun
// Sub-agent unit A/B: the context ceiling and the effort cap, measured on a
// real unit of the clean-base rewrite instead of a toy fixture.
//
// The 2026-09-26..28 census put 77% of three days' spend in one fan-out of
// fresh Code sub-agents (session 501d7261), each reading 400-700k on every one
// of 100-200 calls, at the project's pinned xhigh effort. Two experiments
// target it, both off by default:
//   CLAUDIN_SUBAGENT_RELIEF_TRIGGER  a lower relief trigger for sub-agents
//   CLAUDIN_SUBAGENT_EFFORT_CAP      a cap on the effort a sub-agent inherits
// A toy task never reaches 300k, so each arm re-runs one recorded unit —
// `sessions/indexingScan`, $24 and 115 calls when it ran — from the pristine
// sandbox copy the fan-out left (`<unit>.base`), through the recording proxy.
//
// Arms, all at once per rep: claude (Claude Code, the reference), base,
// placebo (base again, the noise floor), relief, effort. Every arm runs its
// parent at xhigh, as the project was pinned.
//
// Pre-registered gates for promoting an arm (decide before reading results):
//   1. quality: every rep delivers — the three suites exist and pass, the spec
//      and the probe spec exist, the probe runner ends "every probe turned at
//      least one test red", and the unit files are untouched;
//   2. cost: the arm's median is below base AND placebo, and its range does
//      not overlap base's;
//   3. mechanism: relief — at least one clip (a sub-agent request whose
//      context fell); effort — the sub-agent requests carry the capped
//      `output_config.effort` and fewer thinking tokens than base.
//
// Usage:
//   bun run scripts/bench/ab/subagent-unit-ab.ts [--reps=3] [--arms=claude,base,placebo,relief,effort] [--base=<unit .base dir>]
//   bun run scripts/bench/ab/subagent-unit-ab.ts --smoke --reps=1   (a one-minute task: checks the plumbing, grades nothing)
//   bun run scripts/bench/ab/subagent-unit-ab.ts --first-rep=2 --reps=2 --prior=<earlier run>/results.json
//     (continue a run whose process died: the earlier rows join the summary)

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.ts'
import { classifyRequests } from '../tokens/ttl-census.ts'
import { median, runHeadless } from './headlessProbe.ts'
import { range, rangesOverlap } from './forkBench.ts'
import { isMessagesPath, proxyEnv, readBody, readProxyRecords, startWireProxy, type WireProxy } from './wire-proxy.ts'

const DEFAULT_BASE =
  '/tmp/claude-1000/-home-viudes-projects-claudin/501d7261-30f0-41b2-a34d-34efd57fad16/scratchpad/sb/char-sessions-indexingScan.base'
const MODEL = 'claude-opus-5-5'
const UNIT_FILES = [
  'src/sessions/indexing/boundaryScan.ts',
  'src/sessions/indexing/crossProject.ts',
  'src/sessions/indexing/agents.ts',
]
const SUITE_DIR = 'src/sessions/indexing'
const SUITE_RE = /^indexingScan\..*\.characterization\.test\.ts$/
const SPEC = 'docs/tech/rewrite/sessions/indexingScan.md'
const PROBE_SPEC = 'scripts/migrations/probes/rewrite-sessions-indexingScan.json'
// Opus 5.x, $/Mtok.
const PRICE = { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/

type Arm = { label: string; bin: string; env: Record<string, string>; agentHint: string }
const CLAUDIN = join(REPO_ROOT, 'bin', 'claudin')
const CODE_HINT = 'with subagent_type "Code"'
const ALL_ARMS: Arm[] = [
  { label: 'claude', bin: 'claude', env: {}, agentHint: 'with subagent_type "general-purpose"' },
  { label: 'base', bin: CLAUDIN, env: {}, agentHint: CODE_HINT },
  { label: 'placebo', bin: CLAUDIN, env: {}, agentHint: CODE_HINT },
  { label: 'relief', bin: CLAUDIN, env: { CLAUDIN_SUBAGENT_RELIEF_TRIGGER: '250000' }, agentHint: CODE_HINT },
  { label: 'effort', bin: CLAUDIN, env: { CLAUDIN_SUBAGENT_EFFORT_CAP: 'high' }, agentHint: CODE_HINT },
]

function brief(sandbox: string): string {
  return [
    `Characterize the unit \`sessions/indexingScan\` of the clean-base rewrite. Your sandbox is ${sandbox} (a copy of the repository without .git). Read \`docs/tech/rewrite/briefs/characterize.md\` inside it first and follow it exactly; \`docs/tech/rewrite/README.md\` explains the rewrite.`,
    '',
    'Unit files: `src/sessions/indexing/boundaryScan.ts`, `src/sessions/indexing/crossProject.ts`, `src/sessions/indexing/agents.ts`. Where the barrel `src/sessions/sessionStorage.ts` re-exports them, characterize through it. No inherited test to replace.',
    'Deliverables: suites `src/sessions/indexing/*.characterization.test.ts` (use names that do not collide with the `sessions/liteMetadata` unit, which another agent characterizes in the same directory: prefix yours `indexingScan.`), spec `docs/tech/rewrite/sessions/indexingScan.md`, probe spec `scripts/migrations/probes/rewrite-sessions-indexingScan.json`.',
    '',
    'Notes for this unit:',
    '- The boundary scan finds compact boundaries in large transcripts without parsing every line; the cross-project listing gathers sessions from every project directory; the agents module lists sub-agent transcripts. Pin results, limits and the behaviour on damaged files.',
    '- Build transcripts with the real writers of `src/sessions/sessionStorage.ts`, or as fixtures created from them, in temp directories with `CLAUDIN_CONFIG_DIR` pointed there. Place boundaries across read-chunk offsets, as the finished `sessions/storagePure` suite does for its own scanner.',
    '- Where code is unreachable in the shipped build, record it under Findings with the decision "remove as dead", and pin nothing of it.',
    '',
    'Report under 250 words, as the brief lists.',
  ].join('\n')
}

const SMOKE = process.argv.includes('--smoke')

function smokeBrief(sandbox: string): string {
  return `In ${sandbox}, run \`wc -l ${UNIT_FILES.join(' ')}\` and reply with the three line counts, nothing else.`
}

function parentPrompt(arm: Arm, sandbox: string): string {
  return (
    `Delegate the task between the markers to ONE sub-agent with your agent tool ${arm.agentHint}, in the foreground (not in the background), ` +
    `passing the text verbatim as its prompt. Do not do any of the work yourself. When it returns, reply with its report verbatim.\n<<<\n${SMOKE ? smokeBrief(sandbox) : brief(sandbox)}\n>>>`
  )
}

function makeSandbox(base: string, runDir: string, label: string, rep: number): string {
  const sandbox = join(runDir, 'sb', `${label}-r${rep}`)
  mkdirSync(join(runDir, 'sb'), { recursive: true })
  cpSync(base, sandbox, { recursive: true })
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(sandbox, 'node_modules'))
  return sandbox
}

type Gate = { suites: number; suitesPass: boolean; spec: boolean; probesRed: boolean; unitUntouched: boolean }

function grade(sandbox: string, base: string): Gate {
  const suites = existsSync(join(sandbox, SUITE_DIR))
    ? readdirSync(join(sandbox, SUITE_DIR)).filter(f => SUITE_RE.test(f)).map(f => join(SUITE_DIR, f))
    : []
  const test = suites.length
    ? spawnSync('bun', ['test', ...suites], { cwd: sandbox, encoding: 'utf8', timeout: 600_000 })
    : null
  const probe = existsSync(join(sandbox, PROBE_SPEC))
    ? spawnSync('bun', ['run', 'scripts/migrations/break-probe.ts', PROBE_SPEC], { cwd: sandbox, encoding: 'utf8', timeout: 3_600_000 })
    : null
  const same = (f: string) => readFileSync(join(sandbox, f), 'utf8') === readFileSync(join(base, f), 'utf8')
  return {
    suites: suites.length,
    suitesPass: test?.status === 0,
    spec: existsSync(join(sandbox, SPEC)),
    probesRed: (probe?.stdout ?? '').includes('every probe turned at least one test red'),
    unitUntouched: UNIT_FILES.every(same),
  }
}

type Usage = Record<string, unknown>
function costOf(u: Usage | null): number {
  if (!u) return 0
  const cc = (u.cache_creation ?? {}) as Usage
  const n = (v: unknown) => Number(v ?? 0)
  return (
    (n(u.input_tokens) * PRICE.input +
      n(cc.ephemeral_5m_input_tokens) * PRICE.write5m +
      n(cc.ephemeral_1h_input_tokens) * PRICE.write1h +
      n(u.cache_read_input_tokens) * PRICE.read +
      n(u.output_tokens) * PRICE.output) /
    1e6
  )
}

type Metrics = {
  total: number
  sub: number
  subCalls: number
  subMaxCtx: number
  subThinking: number
  clips: number
  subEfforts: string[]
}

function metrics(proxy: WireProxy, label: string): Metrics {
  const records = readProxyRecords(proxy.logDir, label)
    .filter(r => r.reqFile && r.status < 400 && isMessagesPath(r.path))
    .sort((a, b) => a.n - b.n)
  const bodies = records.map(r => readBody(proxy.logDir, label, r.reqFile!))
  const groups = classifyRequests(bodies.map((body, i) => ({ body, usage: records[i]!.response?.usage ?? null })))
  const m: Metrics = { total: 0, sub: 0, subCalls: 0, subMaxCtx: 0, subThinking: 0, clips: 0, subEfforts: [] }
  let prevCtx = 0
  const efforts = new Set<string>()
  records.forEach((r, i) => {
    const u = (r.response?.usage ?? null) as Usage | null
    const cost = costOf(u)
    m.total += cost
    if (groups[i] !== 'sub-agent') return
    m.sub += cost
    m.subCalls++
    const ctx = Number(u?.input_tokens ?? 0) + Number(u?.cache_read_input_tokens ?? 0) + Number(u?.cache_creation_input_tokens ?? 0)
    if (prevCtx > 0 && ctx < prevCtx - 2_000) m.clips++
    prevCtx = ctx
    m.subMaxCtx = Math.max(m.subMaxCtx, ctx)
    m.subThinking += r.response?.thinkingTokens ?? 0
    const oc = bodies[i]!.output_config as Usage | undefined
    efforts.add(typeof oc?.effort === 'string' ? oc.effort : 'none')
  })
  m.subEfforts = [...efforts]
  return m
}

type Row = { arm: string; rep: number; wallMin: number; gate: Gate; ok: boolean } & Metrics

async function runArm(arm: Arm, rep: number, base: string, runDir: string, proxy: WireProxy): Promise<Row> {
  const sandbox = makeSandbox(base, runDir, arm.label, rep)
  const label = `${arm.label}-r${rep}`
  const started = Date.now()
  await runHeadless({
    bin: arm.bin,
    model: MODEL,
    cwd: sandbox,
    prompt: parentPrompt(arm, sandbox),
    env: { ...arm.env, ...proxyEnv(proxy.url(label)) },
    timeoutMs: 120 * 60_000,
    extraArgs: ['--effort', 'xhigh'],
  })
  const wallMin = (Date.now() - started) / 60_000
  const gate = SMOKE
    ? { suites: 0, suitesPass: false, spec: false, probesRed: false, unitUntouched: true }
    : grade(sandbox, base)
  const ok = gate.suites >= 3 && gate.suitesPass && gate.spec && gate.probesRed && gate.unitUntouched
  return { arm: arm.label, rep, wallMin, gate, ok, ...metrics(proxy, label) }
}

async function main(): Promise<void> {
  const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const reps = Number(arg('reps') ?? 3)
  const firstRep = Number(arg('first-rep') ?? 1)
  const prior = arg('prior')
  const base = arg('base') ?? DEFAULT_BASE
  const wanted = (arg('arms') ?? ALL_ARMS.map(a => a.label).join(',')).split(',')
  const arms = ALL_ARMS.filter(a => wanted.includes(a.label))
  if (!existsSync(base)) throw new Error(`no sandbox base at ${base}`)
  for (const k of Object.keys(process.env)) if (HOST_ENV_RE.test(k)) delete process.env[k]
  const runDir = join(tmpdir(), 'subagent-unit-ab', new Date().toISOString().replace(/[:.]/g, '-'))
  const proxy = await startWireProxy(join(runDir, 'proxy'))
  const rows: Row[] = prior ? (JSON.parse(readFileSync(prior, 'utf8')) as Row[]) : []
  console.log(`=== SUB-AGENT UNIT A/B model=${MODEL} reps=${reps} arms=${arms.map(a => a.label).join(',')} → ${runDir} ===`)
  if (prior) console.log(`(with ${rows.length} earlier rows from ${prior})`)
  try {
    for (let rep = firstRep; rep < firstRep + reps; rep++) {
      const done = await Promise.all(arms.map(arm => runArm(arm, rep, base, runDir, proxy)))
      for (const r of done) {
        rows.push(r)
        console.log(
          `${r.arm.padEnd(8)} rep=${rep} ${r.ok ? 'PASS' : 'FAIL'} total=$${r.total.toFixed(2)} sub=$${r.sub.toFixed(2)} calls=${r.subCalls} maxCtx=${Math.round(r.subMaxCtx / 1000)}k think=${r.subThinking} clips=${r.clips} effort=${r.subEfforts.join('/')} wall=${r.wallMin.toFixed(0)}m gate=${JSON.stringify(r.gate)}`,
        )
      }
      writeFileSync(join(runDir, 'results.json'), JSON.stringify(rows, null, 2))
    }
  } finally {
    await proxy.close()
  }
  console.log('\n=== summary (median [range]) ===')
  const col = (arm: string, pick: (r: Row) => number) => rows.filter(r => r.arm === arm).map(pick)
  for (const arm of arms) {
    const xs = rows.filter(r => r.arm === arm.label)
    console.log(
      `${arm.label.padEnd(8)} ok=${xs.filter(r => r.ok).length}/${xs.length} total=$${median(col(arm.label, r => r.total)).toFixed(2)} [${range(col(arm.label, r => r.total), 2)}] ` +
        `sub=$${median(col(arm.label, r => r.sub)).toFixed(2)} calls=${median(col(arm.label, r => r.subCalls))} maxCtx=${Math.round(median(col(arm.label, r => r.subMaxCtx)) / 1000)}k think=${median(col(arm.label, r => r.subThinking))} clips=${median(col(arm.label, r => r.clips))}`,
    )
  }
  for (const arm of ['relief', 'effort']) {
    if (!rows.some(r => r.arm === arm) || !rows.some(r => r.arm === 'base')) continue
    const a = col(arm, r => r.total)
    const b = col('base', r => r.total)
    const p = col('placebo', r => r.total)
    const d = ((median(a) - median(b)) / median(b)) * 100
    console.log(
      `${arm} vs base: ${d >= 0 ? '+' : ''}${d.toFixed(1)}% (ranges ${rangesOverlap(a, b) ? 'OVERLAP' : 'disjoint'}); below placebo median: ${p.length ? median(a) < median(p) : 'n/a'}`,
    )
  }
}

main()
