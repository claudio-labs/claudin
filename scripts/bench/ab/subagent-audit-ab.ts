#!/usr/bin/env bun
// Sub-agent audit A/B: what the request-count levers do to a sub-agent doing
// the audit work real sub-agents do — 60% of the API calls since 2026-09-24
// were a sub-agent's, a median of 64 calls per Code agent, 69% of them with a
// single tool (team memory `request-count-levers-2026-09-24`, round 4; plan
// .claudin/plans/harmonic-wobbling-clock.md, "Caso 3").
//
// The fixture and the key are in subagentAuditFixture.ts: a TypeScript project
// generated per rep, where the callers of a function are reached through
// aliases and through index.ts renames, so each answer takes a hop the search
// before it reveals. The parent hands one fresh Code agent the audit of ten
// functions and relays its report; the child's own report is graded, 30 points
// a session (definition, exact caller set, tested — per function).
//
// Arms, every arm of a rep at once, the reps in sequence:
//   base      no env                          (today's production)
//   placebo   CLAUDIN_BENCH_PLACEBO=1         (read by nothing: run-to-run noise)
//   batching  CLAUDIN_SUBAGENT_BATCHING=1     (the Notes line of round 1)
//   grepbody  CLAUDIN_GREP_BODIES=1           (Grep's `bodies`, round 4)
// --arms=base narrows the set; the validity smoke is `--reps=1 --arms=base`.
//
// Per child (forkBench.loadSession for usage, turnTaxonomy.sessionFromEntries
// for the tool calls): API calls; tool calls per call; the share of calls with
// one tool; Grep → Read-of-a-hit pairs (a call that only Reads files the Grep
// of the call before named, the read `bodies` folds in); Greps asking for
// bodies; child and session cost; the grade.
//
// Gates, pre-registered in the plan:
//   validity (the smoke, base only): ≥ 15 child calls, ≥ 50% of them with one
//     tool, ≥ 90% of the points — or the fixture does not serialize and the
//     reps would measure nothing;
//   grepbody: bodies used in ≥ 4/5 children; Grep → Read pairs ≤ 50% of base;
//     median child calls below base's and placebo's; median child cost ≤ base
//     +3%; median score ≥ base's;
//   batching: median child calls ≤ 70% of base's, range disjoint from placebo's.
//
// Traps stepped around, as subagent-batching-ab does: the host's CLAUDECODE /
// CLAUDE_CODE_* / CLAUDIN_* are removed before an arm starts; Opus 5.5 is
// priced at its 4/20 tier; workspaces sit under a neutral /tmp/ws-<stamp>/
// whose path names no arm; a paid run does not start while the bundle never
// reads a flag an arm sets.
//
// Usage:
//   bun run scripts/bench/ab/subagent-audit-ab.ts --dry-run          # key vs files, grader; no tokens
//   bun run scripts/bench/ab/subagent-audit-ab.ts --reps=1 --arms=base   # validity smoke, ~$3
//   bun run scripts/bench/ab/subagent-audit-ab.ts                    # 4 arms × 5 reps
//   bun run scripts/bench/ab/subagent-audit-ab.ts --replay=/tmp/subagent-audit-ab/<stamp>/results.json
// Flags: --reps (5), --arms (all), --model (claude-opus-5-5), --effort (medium),
// --bin (this checkout's bin/claudin), --timeout (ms per session, 1500000).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.ts'
import { parseJsonl } from './cliUsage'
import { cost, loadSession, priceFor, range, rangesOverlap, type AgentCalls, type Call, type Price } from './forkBench.ts'
import { configDir, median, parseArgs, runHeadless, transcriptPath, type ProbeArgs } from './headlessProbe.ts'
import { auditFixture, childPrompt, gradeAudit, observedTargets, referenceReply, TARGETS, type AuditGrade, type Target } from './subagentAuditFixture.ts'
import { sessionFromEntries, type Session as TaxSession } from './turnTaxonomy.ts'

// ---------------------------------------------------------------------------
// Arms, prompts, environment
// ---------------------------------------------------------------------------

export type Arm = 'base' | 'placebo' | 'batching' | 'grepbody'
const ALL_ARMS: readonly Arm[] = ['base', 'placebo', 'batching', 'grepbody']
const ARM_ENV: Record<Arm, Record<string, string>> = {
  base: {},
  placebo: { CLAUDIN_BENCH_PLACEBO: '1' },
  batching: { CLAUDIN_SUBAGENT_BATCHING: '1' },
  grepbody: { CLAUDIN_GREP_BODIES: '1' },
}

const COMMON_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
  DISABLE_AUTOUPDATER: '1',
}
/** The host session's own variables. CLAUDIN_CONFIG_DIR stays: the transcripts are read from it. */
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/

const parentPrompt = (child: string): string =>
  `Use the Agent tool with subagent_type "Code" and exactly this prompt: '${child}' Then reply with the agent's report verbatim, nothing else.`
const CODE_AGENT = 'Code'
const MAX_TURNS = 20
const BUDGET_USD = 8

const DEFAULT_MODEL = 'claude-opus-5-5'
const BENCH_ROOT = join(tmpdir(), 'subagent-audit-ab')
const SAFE_PATH_RE = /^[A-Za-z0-9/-]+$/
const STAMP_RE = /[-:]/g

const OPUS_5_5_RE = /opus-5-5/
const OPUS_5_5: Price = { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }
function priceOf(model: string): { label: string; price: Price } {
  return OPUS_5_5_RE.test(model) ? { label: 'opus-5-5 (4/20, cache read 0.2, write 5/8)', price: OPUS_5_5 } : priceFor(model)
}

// ---------------------------------------------------------------------------
// Fixture on disk
// ---------------------------------------------------------------------------

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z',
}
const GIT_VAR_RE = /^GIT_/

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_VAR_RE.test(k)))
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...GIT_ENV } })
}

/** Writes rep's project into `dir` as one pinned commit and returns its key. */
export function makeFixture(dir: string, rep: number): Target[] {
  const { files, targets } = auditFixture(rep)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'storefront'])
  return targets
}

// ---------------------------------------------------------------------------
// The child, from its transcript
// ---------------------------------------------------------------------------

/** The Code child's transcript entries, sidechain flag cleared so sessionFromEntries reads them. */
function childSession(cwd: string, sessionId: string, agentId: string): TaxSession | null {
  const path = join(configDir(), 'projects', cwd.replace(/\//g, '-'), sessionId, 'subagents', `agent-${agentId}.jsonl`)
  if (!existsSync(path)) return null
  const entries = parseJsonl(readFileSync(path, 'utf8')).map(e => ({ ...e, isSidechain: false }))
  return sessionFromEntries(entries, cwd)
}

type ChildShape = { oneToolShare: number; grepReadPairs: number; bodiesGreps: number; report: string }

const pathOf = (input: Record<string, unknown>): string[] =>
  [input.file_path, ...(Array.isArray(input.file_paths) ? input.file_paths : [])].filter((p): p is string => typeof p === 'string')

/** What the child's calls did, beyond their count. */
export function childShape(s: TaxSession, cwd: string): ChildShape {
  const withTools = s.calls.filter(c => c.tools.length > 0)
  let grepReadPairs = 0
  let bodiesGreps = 0
  s.calls.forEach((c, i) => {
    bodiesGreps += c.tools.filter(t => t.name === 'Grep' && t.input.bodies === true).length
    const prev = s.calls[i - 1]
    const grepText = prev?.tools.filter(t => t.name === 'Grep').map(t => t.result).join('\n') ?? ''
    if (!grepText || !c.tools.length || !c.tools.every(t => t.name === 'Read')) return
    const reads = c.tools.flatMap(t => pathOf(t.input)).map(p => relative(cwd, p))
    if (reads.length && reads.every(p => grepText.includes(p))) grepReadPairs++
  })
  return {
    oneToolShare: withTools.length ? withTools.filter(c => c.tools.length === 1).length / withTools.length : 0,
    grepReadPairs,
    bodiesGreps,
    report: s.calls.at(-1)?.texts.join('\n') ?? '',
  }
}

// ---------------------------------------------------------------------------
// Sessions and rows
// ---------------------------------------------------------------------------

/** One session as saved in results.json: raw enough that --replay re-derives every row. */
export type RunRecord = {
  arm: Arm
  rep: number
  cwd: string
  sessionId: string
  exitCode: number | null
  finalText: string
  targets: Target[]
  parent: Call[]
  children: AgentCalls[]
  shape: ChildShape | null
}

export type Row = {
  arm: Arm
  rep: number
  childType: string
  delegated: boolean
  childCalls: number
  toolsPerCall: number
  oneToolShare: number
  grepReadPairs: number
  bodiesGreps: number
  childCost: number
  sessionCost: number
  grade: AuditGrade
}

export function rowOf(r: RunRecord, price: Price): Row {
  const child = r.children.find(c => c.agentType === CODE_AGENT) ?? r.children[0]
  const calls = child?.calls ?? []
  const withTools = calls.filter(c => c.tools.length > 0)
  // The child's report is what is graded; the parent's relay stands in when the child's transcript is gone.
  const report = r.shape?.report || r.finalText
  return {
    arm: r.arm,
    rep: r.rep,
    childType: child?.agentType ?? 'none',
    delegated: child?.agentType === CODE_AGENT && calls.length > 0,
    childCalls: calls.length,
    toolsPerCall: withTools.length ? withTools.reduce((s, c) => s + c.tools.length, 0) / withTools.length : 0,
    oneToolShare: r.shape?.oneToolShare ?? 0,
    grepReadPairs: r.shape?.grepReadPairs ?? 0,
    bodiesGreps: r.shape?.bodiesGreps ?? 0,
    childCost: cost(calls, price).total,
    sessionCost: [r.parent, ...r.children.map(c => c.calls)].reduce((s, cs) => s + cost(cs, price).total, 0),
    grade: gradeAudit(report, r.targets),
  }
}

// ---------------------------------------------------------------------------
// Gates and report
// ---------------------------------------------------------------------------

type Gate = { name: string; ok: boolean; detail: string }

const measured = (rows: readonly Row[], arm: Arm): Row[] => rows.filter(r => r.arm === arm && r.delegated)
const col = (rows: readonly Row[], arm: Arm, f: (r: Row) => number): number[] => measured(rows, arm).map(f)
const pct = (r: Row): number => r.grade.score / r.grade.max

export function gates(rows: readonly Row[], arms: readonly Arm[]): Gate[] {
  const out: Gate[] = []
  const calls = (arm: Arm) => col(rows, arm, r => r.childCalls)
  const has = (arm: Arm) => arms.includes(arm) && measured(rows, arm).length > 0
  if (has('base')) {
    const base = measured(rows, 'base')
    out.push({
      name: 'validity: the base child serializes and gets it right (≥ 15 calls, ≥ 50% one-tool, ≥ 90% of the points)',
      ok: median(calls('base')) >= 15 && median(base.map(r => r.oneToolShare)) >= 0.5 && median(base.map(pct)) >= 0.9,
      detail: `median calls ${median(calls('base'))}, one-tool ${(median(base.map(r => r.oneToolShare)) * 100).toFixed(0)}%, points ${(median(base.map(pct)) * 100).toFixed(0)}%`,
    })
  }
  if (has('grepbody') && has('base') && has('placebo')) {
    const [g, b, p] = [measured(rows, 'grepbody'), measured(rows, 'base'), measured(rows, 'placebo')]
    const all = rows.filter(r => r.arm === 'grepbody')
    out.push(
      { name: 'grepbody: bodies used in ≥ 4/5 children', ok: g.filter(r => r.bodiesGreps > 0).length * 5 >= 4 * all.length, detail: `${g.filter(r => r.bodiesGreps > 0).length}/${all.length}` },
      {
        name: 'grepbody: Grep → Read pairs ≤ 50% of base',
        ok: median(g.map(r => r.grepReadPairs)) * 2 <= median(b.map(r => r.grepReadPairs)),
        detail: `median ${median(g.map(r => r.grepReadPairs))} vs base ${median(b.map(r => r.grepReadPairs))}`,
      },
      {
        name: 'grepbody: child calls below base and placebo',
        ok: median(calls('grepbody')) < median(calls('base')) && median(calls('grepbody')) < median(calls('placebo')),
        detail: `median ${median(calls('grepbody'))} vs base ${median(calls('base'))}, placebo ${median(calls('placebo'))}`,
      },
      {
        name: 'grepbody: child cost ≤ base +3%',
        ok: median(g.map(r => r.childCost)) <= median(b.map(r => r.childCost)) * 1.03,
        detail: `$${median(g.map(r => r.childCost)).toFixed(3)} vs base $${median(b.map(r => r.childCost)).toFixed(3)}`,
      },
      { name: 'grepbody: score ≥ base', ok: median(g.map(pct)) >= median(b.map(pct)), detail: `${(median(g.map(pct)) * 100).toFixed(0)}% vs base ${(median(b.map(pct)) * 100).toFixed(0)}%` },
    )
    void p
  }
  if (has('batching') && has('base') && has('placebo')) {
    out.push(
      {
        name: 'batching: child calls ≤ 70% of base',
        ok: median(calls('batching')) * 100 <= 70 * median(calls('base')),
        detail: `median ${median(calls('batching'))} vs base ${median(calls('base'))}`,
      },
      {
        name: 'batching: child-call range clear of placebo',
        ok: !rangesOverlap(calls('batching'), calls('placebo')),
        detail: `batching ${range(calls('batching'), 0)}, placebo ${range(calls('placebo'), 0)}`,
      },
    )
  }
  return out
}

function spread(xs: number[], digits: number): string {
  return xs.length ? `${median(xs).toFixed(digits)} [${range(xs, digits)}]` : '–'
}

function table(head: readonly string[], body: readonly string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(r => r[i]!.length)))
  const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(head), ...body.map(line)].join('\n')
}

const COLUMNS = ['arm', 'measured', 'child calls', 'tools/call', 'one-tool', 'Grep→Read', 'bodies', 'child $', 'session $', 'points']

function armCells(arm: Arm, rows: readonly Row[]): string[] {
  const all = rows.filter(r => r.arm === arm)
  const xs = measured(rows, arm)
  return [
    arm,
    `${xs.length}/${all.length}`,
    spread(xs.map(r => r.childCalls), 0),
    spread(xs.map(r => r.toolsPerCall), 1),
    spread(xs.map(r => r.oneToolShare * 100), 0) + '%',
    spread(xs.map(r => r.grepReadPairs), 0),
    spread(xs.map(r => r.bodiesGreps), 0),
    spread(xs.map(r => r.childCost), 3),
    spread(xs.map(r => r.sessionCost), 3),
    spread(xs.map(r => r.grade.score), 0) + `/${all[0]?.grade.max ?? TARGETS * 3}`,
  ]
}

export type Meta = { started: string; runDir: string; workspaces: string; model: string; effort: string; reps: number; arms: Arm[]; bin: string; version: string; hostEnvRemoved: string[] }

export function renderReport(rows: readonly Row[], meta: Meta): string {
  const verdict = gates(rows, meta.arms)
  const missed = rows.filter(r => !r.delegated || r.grade.score < r.grade.max)
  return [
    `=== SUB-AGENT AUDIT A/B  model=${meta.model} effort=${meta.effort} reps=${meta.reps} arms=${meta.arms.join(',')} ===`,
    `${meta.bin}: ${meta.version}`,
    `host variables removed: ${meta.hostEnvRemoved.join(', ') || 'none'}; prices: ${priceOf(meta.model).label}`,
    '',
    table(COLUMNS, meta.arms.map(arm => armCells(arm, rows))),
    '',
    'gates (pre-registered):',
    ...verdict.map(g => `  ${g.ok ? 'PASS' : 'FAIL'}  ${g.name}: ${g.detail}`),
    ...(missed.length
      ? ['', 'sessions short of full marks:', ...missed.map(r => `  ${r.arm} r${r.rep}: ${r.delegated ? missedItems(r.grade) : `no Code child (${r.childType})`}`)]
      : []),
  ].join('\n')
}

function missedItems(g: AuditGrade): string {
  const misses = g.targets.flatMap(t => [!t.defined && `${t.name}:defined`, !t.callers && `${t.name}:callers`, !t.tested && `${t.name}:tested`].filter(Boolean))
  return `${g.score}/${g.max} — ${misses.slice(0, 4).join(', ')}${misses.length > 4 ? `, +${misses.length - 4}` : ''}`
}

function liveLine(r: Row): string {
  return (
    `${r.arm.padEnd(8)} r${r.rep} ${r.grade.score}/${r.grade.max} child=${r.childType} calls=${String(r.childCalls).padStart(3)} ` +
    `tools/call=${r.toolsPerCall.toFixed(1)} one-tool=${(r.oneToolShare * 100).toFixed(0)}% grep→read=${r.grepReadPairs} bodies=${r.bodiesGreps} ` +
    `child=$${r.childCost.toFixed(3)} session=$${r.sessionCost.toFixed(3)}`
  )
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const CHUNK_REF_RE = /"(\.\/[\w.\/-]+\.mjs)"/g
const BUNDLE_CONTROL = 'subagent_type'

/** Whether the bundle `bin` launches mentions `needle` (the walk subagent-batching-ab does). */
function bundleMentions(bin: string, needle: string): boolean | null {
  const found = bin.includes('/') ? bin : Bun.which(bin)
  if (!found || !existsSync(found)) return null
  const seen = new Set<string>()
  const queue = [join(dirname(dirname(realpathSync(found))), 'dist', 'cli.mjs')]
  let control = false
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    if (text.includes(needle)) return true
    control ||= text.includes(BUNDLE_CONTROL)
    for (const m of text.matchAll(CHUNK_REF_RE)) queue.push(join(dirname(file), m[1]!))
  }
  return control ? false : null
}

function scrubHostEnv(): string[] {
  const removed = Object.keys(process.env).filter(k => HOST_ENV_RE.test(k))
  for (const k of removed) delete process.env[k]
  return removed.sort()
}

type Args = ProbeArgs & { model: string; effort: string; dryRun: boolean; replay: string; arms: Arm[] }

async function runArm(arm: Arm, rep: number, cwd: string, args: Args): Promise<RunRecord> {
  const targets = makeFixture(cwd, rep)
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt: parentPrompt(childPrompt(targets)),
    env: { ...COMMON_ENV, ...ARM_ENV[arm] },
    timeoutMs: args.timeoutMs,
    extraArgs: ['--effort', args.effort, '--max-turns', String(MAX_TURNS), '--max-budget-usd', String(BUDGET_USD)],
  })
  const session = run.sessionId ? loadSession(cwd, run.sessionId) : { parent: [], children: [] }
  const child = session.children.find(c => c.agentType === CODE_AGENT) ?? session.children[0]
  const tax = child && run.sessionId ? childSession(cwd, run.sessionId, child.agentId) : null
  return {
    arm,
    rep,
    cwd,
    sessionId: run.sessionId,
    exitCode: run.exitCode,
    finalText: run.finalText,
    targets,
    parent: session.parent,
    children: session.children,
    shape: tax ? childShape(tax, cwd) : null,
  }
}

function stamp(): string {
  return new Date().toISOString().replace(STAMP_RE, '').replace('T', '-').slice(0, 15)
}

function version(bin: string): string {
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).stdout?.trim() || 'no --version'
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim()
  const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).stdout?.trim()
  return `${v} @ ${head}${dirty ? ' (src dirty)' : ''}`
}

type Saved = { meta: Meta; runs: RunRecord[] }

function save(meta: Meta, runs: RunRecord[]): string {
  const path = join(meta.runDir, 'results.json')
  writeFileSync(path, JSON.stringify({ meta, runs } satisfies Saved, null, 1))
  return path
}

async function run(args: Args): Promise<void> {
  for (const arm of args.arms) {
    for (const flag of Object.keys(ARM_ENV[arm]).filter(k => k !== 'CLAUDIN_BENCH_PLACEBO')) {
      if (bundleMentions(args.bin, flag) === false) {
        console.error(`the bundle ${args.bin} runs never reads ${flag}: \`bun run build\` first, or ${arm} is a second placebo`)
        process.exit(1)
      }
    }
  }
  const hostEnvRemoved = scrubHostEnv()
  const id = stamp()
  const runDir = join(BENCH_ROOT, id)
  mkdirSync(runDir, { recursive: true })
  mkdirSync(join(tmpdir(), `ws-${id}`), { recursive: true })
  const workspaces = realpathSync(join(tmpdir(), `ws-${id}`))
  if (!SAFE_PATH_RE.test(workspaces)) throw new Error(`${workspaces} has characters loadSession cannot map to a project dir`)
  const meta: Meta = {
    started: new Date().toISOString(),
    runDir,
    workspaces,
    model: args.model,
    effort: args.effort,
    reps: args.reps,
    arms: args.arms,
    bin: args.bin,
    version: version(args.bin),
    hostEnvRemoved,
  }
  const { price } = priceOf(args.model)
  console.log(`subagent-audit-ab → ${runDir}\n  workspaces ${workspaces}\n  ${args.bin}: ${meta.version}`)
  const runs: RunRecord[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    const recs = await Promise.all(args.arms.map((arm, i) => runArm(arm, rep, join(workspaces, `r${rep}-${i + 1}`), args)))
    for (const r of recs) console.log(liveLine(rowOf(r, price)))
    runs.push(...recs)
    save(meta, runs)
  }
  const rows = runs.map(r => rowOf(r, price))
  console.log(`\n${renderReport(rows, meta)}\n\nresults → ${save(meta, runs)}`)
}

/** Every rep's key checked against the files it built, and the grader against the key; spends no model tokens. */
function dryRun(): number {
  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  mkdirSync(dir, { recursive: true })
  const checks: Array<[string, boolean, string]> = []
  for (let rep = 1; rep <= 10; rep++) {
    const ws = join(realpathSync(dir), `r${rep}`)
    const targets = makeFixture(ws, rep)
    const seen = observedTargets(ws, targets.map(t => t.name))
    const diff = targets.filter((t, i) => JSON.stringify(t) !== JSON.stringify(seen[i]))
    checks.push([`rep ${rep}: the key = what the files say`, diff.length === 0, diff.length ? `${diff[0]!.name}: key ${JSON.stringify(diff[0])}, files ${JSON.stringify(seen[targets.indexOf(diff[0]!)])}` : `${targets.length} targets`])
  }
  const ws1 = join(realpathSync(dir), 'r1')
  const targets = auditFixture(1).targets
  const modules = readdirSync(join(ws1, 'src')).flatMap(a => readdirSync(join(ws1, 'src', a))).length
  const hopped = targets.filter(t => t.callers.some(c => !readFileSync(join(ws1, c.split(':')[0]!), 'utf8').split('\n')[Number(c.split(':')[1]) - 1]!.includes(`${t.name}(`)))
  const perfect = gradeAudit(referenceReply(targets), targets)
  const oneOff = gradeAudit(referenceReply(targets.map((t, i) => (i === 0 ? { ...t, defined: t.defined.replace(/:(\d+)$/, (_, n) => `:${Number(n) + 1}`) } : t))), targets)
  const callerDropped = gradeAudit(referenceReply(targets.map(t => (t.callers.length ? { ...t, callers: t.callers.slice(1) } : t))), targets)
  const empty = gradeAudit('', targets)
  const preamble = gradeAudit(`Audited ${targets.map(t => t.name).join(', ')}.\n\n${referenceReply(targets)}`, targets)
  checks.push(
    ['rep 1 has ~50 files under src/', modules >= 40, `${modules} (modules and index files)`],
    ['targets with callers ≥ 7, some only reachable through another name', targets.filter(t => t.callers.length).length >= 7 && hopped.length >= 3, `${targets.filter(t => t.callers.length).length} with callers, ${hopped.length} via an alias or a rename`],
    ['some targets tested, some not', targets.some(t => t.tested) && targets.some(t => !t.tested), `${targets.filter(t => t.tested).length}/${targets.length} tested`],
    ['a second build of rep 1 is byte-identical', JSON.stringify(auditFixture(1)) === JSON.stringify(auditFixture(1)), 'every arm of a rep gets one project'],
    ["rep 2's key is not rep 1's", JSON.stringify(auditFixture(2).targets) !== JSON.stringify(targets), 'drawn per rep'],
    ['grader: the reference reply scores 100%', perfect.score === perfect.max, `${perfect.score}/${perfect.max}`],
    ['grader: a preamble naming every target does not hide the blocks', preamble.score === preamble.max, `${preamble.score}/${preamble.max}`],
    ['grader: a definition one line off loses its point', oneOff.score === perfect.max - 1, `${oneOff.score}/${oneOff.max}`],
    ['grader: one caller dropped loses the callers point', callerDropped.score < perfect.max, `${callerDropped.score}/${callerDropped.max}`],
    ['grader: an empty reply scores 0', empty.score === 0, `${empty.score}/${empty.max}`],
  )
  console.log(
    [
      `dry run in ${dir} — no model tokens`,
      '',
      table(['check', 'ok', 'detail'], checks.map(([c, ok, d]) => [c, ok ? 'yes' : 'NO', d])),
      '',
      'rep 1 key:',
      referenceReply(targets),
      '',
      `child prompt: ${childPrompt(targets)}`,
    ].join('\n'),
  )
  return checks.every(([, ok]) => ok) ? 0 : 1
}

const ARG_RE = /^--(?:bin|reps|model|timeout|effort|replay|arms)=.+$|^--dry-run$/

function parseBenchArgs(argv: string[]): Args {
  const unknown = argv.filter(a => !ARG_RE.test(a))
  if (unknown.length) {
    console.error(`unknown argument: ${unknown.join(' ')} (the flags are in this file's header)`)
    process.exit(2)
  }
  const probe = parseArgs(argv, { bin: join(REPO_ROOT, 'bin', 'claudin'), reps: 5, model: DEFAULT_MODEL, timeoutMs: 1_500_000 })
  const value = (k: string): string | undefined => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const arms = (value('arms')?.split(',') ?? [...ALL_ARMS]) as Arm[]
  const bad = arms.filter(a => !ALL_ARMS.includes(a))
  if (bad.length) {
    console.error(`unknown arm ${bad.join(',')} — the arms are ${ALL_ARMS.join(',')}`)
    process.exit(2)
  }
  return { ...probe, model: probe.model ?? DEFAULT_MODEL, effort: value('effort') ?? 'medium', dryRun: argv.includes('--dry-run'), replay: value('replay') ?? '', arms }
}

async function main(): Promise<void> {
  const args = parseBenchArgs(process.argv.slice(2))
  if (args.dryRun) process.exit(dryRun())
  if (args.replay) {
    const saved = JSON.parse(readFileSync(args.replay, 'utf8')) as Saved
    const { price } = priceOf(saved.meta.model)
    console.log(renderReport(saved.runs.map(r => rowOf(r, price)), saved.meta))
    return
  }
  await run(args)
}

if (import.meta.main) await main()
