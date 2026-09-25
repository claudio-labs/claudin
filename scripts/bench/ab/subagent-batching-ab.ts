#!/usr/bin/env bun
// Sub-agent batching A/B: does one line in a fresh sub-agent's Notes cut the
// API calls it spends on work made of independent lookups?
//
// Sub-agents made 45% of the API calls in the 94 real sessions since
// 2026-09-14 (11.7k of 25.9k), and 9% of theirs were serial reads of targets
// already known. A fresh agent (`subagent_type: "Code"`) hears nothing about
// parallel calls — its prompt is the agent's own, the Notes and the env; only
// a fork inherits the parent's — so `CLAUDIN_SUBAGENT_BATCHING=1` adds one
// line to those Notes (lever S of the request-count round, 2026-09-24):
//
//   Independent tool calls go in ONE response: they share a single request,
//   while one call per response costs a request each. Read takes several
//   files at once with `file_paths`.
//
// Three arms, every arm of a rep at once, the reps in sequence:
//   base      no env                        (today's production)
//   batching  CLAUDIN_SUBAGENT_BATCHING=1
//   placebo   CLAUDIN_BENCH_PLACEBO=1       (read by nothing: run-to-run noise)
// Once the line is promoted to default-on, base needs CLAUDIN_SUBAGENT_BATCHING=0.
//
// The fixture, one per rep and the same repo for its three arms (pinned commit
// dates, so even the hashes match): src/mod1.ts … src/mod8.ts, each exporting
// 2–3 functions whose names are drawn per rep, and a history in which the
// eight files were touched 1…8 times, a per-rep permutation — commit k
// rewrites every file whose count is ≥ k, and no file's text gives its count
// away. The parent hands one Code agent the sixteen lookups (each file's
// exports, each file's `git log` count) and relays its report; the grade is
// every count and every name, on that file's line of the final text.
//
// Per child (forkBench.loadSession, parent ids removed): API calls; tool calls
// per call, mean and max, over the calls that made any (the final answer makes
// none, and a batch Read is one call); child cost; the grade. Reported as
// median [min–max] per arm, with the overlap of the child-call ranges,
// batching vs base and batching vs placebo.
//
// Gate, pre-registered for lever S (5 reps, so 15 sessions):
//   - batching's median child calls ≤ 70% of base's;
//   - batching's child-call range disjoint from placebo's;
//   - every answer correct, 15/15;
//   - batching's median child cost not above base's.
// A session whose parent spawned no Code child measures nothing: it stays out
// of the medians and fails the run.
//
// Traps stepped around, as delegation-steer-ab does: the host session's
// CLAUDECODE / CLAUDE_CODE_* / CLAUDIN_* are removed before an arm starts
// (runHeadless spreads process.env, and a host CLAUDIN_SUBAGENT_BATCHING=1
// would turn base into batching); Opus 5.5 is priced at its 4/20 tier, where
// forkBench.priceFor bills it as Opus 5; workspace paths stay within
// [A-Za-z0-9/-], all that loadSession maps to a project dir. Two of this
// bench's own: the workspaces sit under a neutral /tmp/ws-<stamp>/, because
// the child's env section prints its cwd and a path saying "batching" would
// prime every arm; and a paid run does not start while the bundle bin/claudin
// runs never reads CLAUDIN_SUBAGENT_BATCHING — batching would be a second
// placebo.
//
// Usage:
//   bun run scripts/bench/ab/subagent-batching-ab.ts --dry-run   # fixture vs git, grader; no tokens
//   bun run scripts/bench/ab/subagent-batching-ab.ts             # 3 arms × 5 reps, ~$6
//   bun run scripts/bench/ab/subagent-batching-ab.ts --replay=/tmp/subagent-batching-ab/<stamp>/results.json
// Flags: --reps (5), --model (claude-opus-5-5), --effort (medium), --bin (this
// checkout's bin/claudin), --timeout (ms per session, 900000).
//
// Not run yet.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.ts'
import { cost, loadSession, priceFor, range, rangesOverlap, type AgentCalls, type Call, type Price } from './forkBench.ts'
import { median, parseArgs, runHeadless, transcriptPath, type ProbeArgs } from './headlessProbe.ts'

// ---------------------------------------------------------------------------
// Arms, prompts, environment
// ---------------------------------------------------------------------------

export type Arm = 'base' | 'batching' | 'placebo'
const ARMS: readonly Arm[] = ['base', 'batching', 'placebo']
const FLAG = 'CLAUDIN_SUBAGENT_BATCHING'
const ARM_ENV: Record<Arm, Record<string, string>> = {
  base: {},
  batching: { [FLAG]: '1' },
  placebo: { CLAUDIN_BENCH_PLACEBO: '1' },
}

/**
 * Every arm, as in delegation-steer-ab: `-p` drains auto-backgrounded work
 * non-deterministically, and an orphaned child takes its calls with it.
 */
const COMMON_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
  DISABLE_AUTOUPDATER: '1',
}

/** The host session's own variables. CLAUDIN_CONFIG_DIR stays: loadSession reads the transcripts from it. */
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/

const MODULES = 8
const FILES = Array.from({ length: MODULES }, (_, i) => `src/mod${i + 1}.ts`)
const CHILD_PROMPT =
  `For each of these files — ${FILES.join(', ')} — report its exported function names and the number of commits ` +
  'that touched it (git log --oneline -- <file> | wc -l). Reply with one line per file: path, count, names.'
const PARENT_PROMPT =
  `Use the Agent tool with subagent_type "Code" and exactly this prompt: '${CHILD_PROMPT}' ` +
  "Then reply with the agent's report verbatim, nothing else."
const CODE_AGENT = 'Code'
const MAX_TURNS = 30
/** `--max-budget-usd` per session; one is expected near $0.4. */
const BUDGET_USD = 3
/** Batching's median child calls may be at most this percent of base's (integer math: 0.7 * 100 is 70.00000000000001). */
const CALLS_BAR_PCT = 70

const DEFAULT_MODEL = 'claude-opus-5-5'
const BENCH_ROOT = join(tmpdir(), 'subagent-batching-ab')
/** `loadSession` replaces only `/` to find a project dir; claudin replaces every non-alphanumeric. */
const SAFE_PATH_RE = /^[A-Za-z0-9/-]+$/
const WS_RE = /\s+/g
const STAMP_RE = /[-:]/g

/** forkBench.priceFor matches `/opus-5/` first and bills Opus 5.5 at 5/25; it is COST_TIER_4_20 (src/providers/usage/modelCost.ts). */
const OPUS_5_5_RE = /opus-5-5/
const OPUS_5_5: Price = { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }

function priceOf(model: string): { label: string; price: Price } {
  return OPUS_5_5_RE.test(model) ? { label: 'opus-5-5 (4/20, cache read 0.2, write 5/8)', price: OPUS_5_5 } : priceFor(model)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export type FileSpec = { path: string; count: number; names: string[] }

// Names are verb + Noun. No verb ends another verb and no noun starts another
// noun, and each name has one capital where the two meet — so no name
// contains another, and finding one cannot credit a different one.
const VERBS = ['load', 'parse', 'merge', 'split', 'score', 'flush', 'render', 'clamp', 'index', 'queue', 'trace', 'shift']
const NOUNS = ['Ledger', 'Cursor', 'Bucket', 'Frame', 'Packet', 'Token', 'Window', 'Schema', 'Record', 'Vector', 'Socket', 'Header']

/** xorshift32, seeded by the rep: a rep's fixture is the same for every arm and every rerun. */
function rng(seed: number): () => number {
  let x = Math.imul(seed, 0x9e3779b1) >>> 0 || 1
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 0x1_0000_0000
  }
}

function shuffle<T>(xs: readonly T[], next: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const t = a[i]!
    a[i] = a[j]!
    a[j] = t
  }
  return a
}

/** What a correct answer holds for `rep`: each file's commit count (1…8, once each) and exported names. */
export function fixtureSpec(rep: number): FileSpec[] {
  const next = rng(rep)
  const counts = shuffle(Array.from({ length: MODULES }, (_, i) => i + 1), next)
  const pool = shuffle(VERBS.flatMap(v => NOUNS.map(n => v + n)), next)
  let taken = 0
  return counts.map((count, i) => {
    const k = 2 + Math.floor(next() * 2)
    const names = pool.slice(taken, taken + k)
    taken += k
    return { path: FILES[i]!, count, names }
  })
}

/**
 * A file's text at one revision. Each multiplier moves by 5 (mod 89) per
 * revision, so every rewrite is a real change for git, and its per-file
 * offset keeps the last value from giving the count away.
 */
function moduleSource(f: FileSpec, file: number, rev: number, rep: number): string {
  return f.names
    .map((name, j) => {
      const salt = rep * 7 + file * 13 + j * 29
      return `export function ${name}(x: number): number {\n  return x * ${2 + ((salt + rev * 5) % 89)} + ${1 + (salt % 97)}\n}\n`
    })
    .join('\n')
}

/** None of the host's git config (hooks, signing, templates), and one author. */
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
}
/** Inherited GIT_* goes too: a GIT_DIR set by a hook would point these commits at another repo. */
const GIT_VAR_RE = /^GIT_/

function git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_VAR_RE.test(k)))
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...GIT_ENV, ...extra } })
}

/** Builds rep's fixture repo in `dir` and returns what a correct answer holds. */
export function makeFixture(dir: string, rep: number): FileSpec[] {
  const spec = fixtureSpec(rep)
  mkdirSync(join(dir, 'src'), { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  const revisions = Math.max(...spec.map(f => f.count))
  for (let rev = 1; rev <= revisions; rev++) {
    spec.forEach((f, i) => {
      if (f.count >= rev) writeFileSync(join(dir, f.path), moduleSource(f, i + 1, rev, rep))
    })
    const date = `2026-01-${String(rev).padStart(2, '0')}T12:00:00Z`
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', `revision ${rev}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  }
  return spec
}

const EXPORTED_FN_RE = /^export function (\w+)/gm

/** What git and the source say about each file — the check on a fixture's spec. */
export function observedFacts(dir: string, paths: readonly string[]): FileSpec[] {
  return paths.map(path => ({
    path,
    count: git(dir, ['log', '--oneline', '--', path]).split('\n').filter(Boolean).length,
    names: [...readFileSync(join(dir, path), 'utf8').matchAll(EXPORTED_FN_RE)].map(m => m[1]!),
  }))
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const MODULE_REF_RE = /\bmod\d+\.ts\b/g
/** A standalone integer: not glued to a word (`mod3`, `v2`) nor part of a decimal. */
const NUMBER_RE = /(?<![\w.])\d+(?!\w|\.\d)/
const WORD_CHAR_RE = /[\w$]/

type Grade = { correct: boolean; missing: string[] }

function hasWord(hay: string, word: string): boolean {
  for (let i = hay.indexOf(word); i >= 0; i = hay.indexOf(word, i + 1)) {
    if (!WORD_CHAR_RE.test(hay.charAt(i - 1)) && !WORD_CHAR_RE.test(hay.charAt(i + word.length))) return true
  }
  return false
}

function problemsIn(stretch: string, f: FileSpec): string[] {
  const first = NUMBER_RE.exec(stretch)?.[0]
  const problems = Number(first) === f.count ? [] : [`count ${f.count}, first number there ${first ?? 'none'}`]
  for (const name of f.names) if (!hasWord(stretch, name)) problems.push(`no ${name}`)
  return problems
}

/**
 * Every file needs a stretch of `text` — from a mention of its path to the
 * next path mentioned — whose first standalone number is its commit count (the
 * reply format is "path, count, names") and which names each of its exports.
 * Any mention can be that stretch, so a preamble listing the paths does not
 * hide the table below it.
 */
export function grade(text: string, expected: readonly FileSpec[]): Grade {
  const refs = [...text.matchAll(MODULE_REF_RE)].map(m => ({ file: m[0], start: m.index ?? 0 }))
  const missing: string[] = []
  for (const f of expected) {
    const file = f.path.slice(f.path.lastIndexOf('/') + 1)
    let best: string[] | null = null
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i]!
      if (r.file !== file) continue
      const problems = problemsIn(text.slice(r.start + r.file.length, refs[i + 1]?.start ?? text.length), f)
      if (best === null || problems.length < best.length) best = problems
      if (best.length === 0) break
    }
    if (best === null) missing.push(`${f.path}: not in the reply`)
    else if (best.length) missing.push(`${f.path}: ${best.join(', ')}`)
  }
  return { correct: missing.length === 0, missing }
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
  /** What a correct answer holds, as built for this rep. */
  expected: FileSpec[]
  /** The prompt the parent handed the Agent tool, and whether it was CHILD_PROMPT verbatim. */
  childPrompt: string | null
  verbatim: boolean
  parent: Call[]
  children: AgentCalls[]
}

export type Row = {
  arm: Arm
  rep: number
  /** The measured child's agentType; `none` when the parent spawned nothing. */
  childType: string
  /** A Code child made at least one call. Only these rows enter the medians. */
  delegated: boolean
  verbatim: boolean
  childCalls: number
  toolCalls: number
  /** Tool calls per call, over the child's calls that made any. */
  meanTools: number
  maxTools: number
  childCost: number
  /** Parent plus every child. */
  sessionCost: number
  correct: boolean
  missing: string[]
}

export function rowOf(r: RunRecord, price: Price): Row {
  const child = r.children.find(c => c.agentType === CODE_AGENT) ?? r.children[0]
  const calls = child?.calls ?? []
  const withTools = calls.filter(c => c.tools.length > 0)
  const toolCalls = withTools.reduce((s, c) => s + c.tools.length, 0)
  const g = grade(r.finalText, r.expected)
  return {
    arm: r.arm,
    rep: r.rep,
    childType: child?.agentType ?? 'none',
    delegated: child?.agentType === CODE_AGENT && calls.length > 0,
    verbatim: r.verbatim,
    childCalls: calls.length,
    toolCalls,
    meanTools: withTools.length ? toolCalls / withTools.length : 0,
    maxTools: Math.max(0, ...calls.map(c => c.tools.length)),
    childCost: cost(calls, price).total,
    sessionCost: [r.parent, ...r.children.map(c => c.calls)].reduce((s, cs) => s + cost(cs, price).total, 0),
    correct: g.correct,
    missing: g.missing,
  }
}

// ---------------------------------------------------------------------------
// Gate and report
// ---------------------------------------------------------------------------

type Gate = { key: 'calls' | 'ranges' | 'correct' | 'cost' | 'delegated'; name: string; ok: boolean; detail: string }

function measured(rows: readonly Row[], arm: Arm): Row[] {
  return rows.filter(r => r.arm === arm && r.delegated)
}

/** `median [min–max]`, or `–` for no data. */
function spread(xs: number[], digits: number): string {
  return xs.length ? `${median(xs).toFixed(digits)} [${range(xs, digits)}]` : '–'
}

export function gates(rows: readonly Row[]): Gate[] {
  const calls = (arm: Arm) => measured(rows, arm).map(r => r.childCalls)
  const costs = (arm: Arm) => measured(rows, arm).map(r => r.childCost)
  const [base, batching, placebo] = [calls('base'), calls('batching'), calls('placebo')]
  const [baseCost, batchingCost] = [costs('base'), costs('batching')]
  const correct = rows.filter(r => r.correct).length
  const delegated = rows.filter(r => r.delegated).length
  return [
    {
      key: 'calls',
      name: `child calls ≤ ${CALLS_BAR_PCT}% of base`,
      ok: base.length > 0 && batching.length > 0 && median(batching) * 100 <= CALLS_BAR_PCT * median(base),
      detail:
        base.length && batching.length
          ? `batching median ${median(batching)}, base ${median(base)} (bar ${((CALLS_BAR_PCT * median(base)) / 100).toFixed(1)})`
          : 'no data',
    },
    {
      key: 'ranges',
      name: 'child calls clear of placebo',
      ok: batching.length > 0 && placebo.length > 0 && !rangesOverlap(batching, placebo),
      detail: batching.length && placebo.length ? `batching ${range(batching, 0)}, placebo ${range(placebo, 0)}` : 'no data',
    },
    { key: 'correct', name: 'answers correct', ok: rows.length > 0 && correct === rows.length, detail: `${correct}/${rows.length} sessions` },
    {
      key: 'cost',
      name: 'child cost not above base',
      ok: baseCost.length > 0 && batchingCost.length > 0 && median(batchingCost) <= median(baseCost),
      detail: baseCost.length && batchingCost.length ? `batching median $${median(batchingCost).toFixed(4)}, base $${median(baseCost).toFixed(4)}` : 'no data',
    },
    { key: 'delegated', name: 'a Code child in every session', ok: rows.length > 0 && delegated === rows.length, detail: `${delegated}/${rows.length} sessions` },
  ]
}

function table(head: readonly string[], body: readonly string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(r => r[i]!.length)))
  const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(head), ...body.map(line)].join('\n')
}

const COLUMNS = ['arm', 'measured', 'child calls', 'tools/call', 'max tools/call', 'child $', 'session $', 'correct', 'verbatim prompt']

function armCells(arm: Arm, rows: readonly Row[]): string[] {
  const all = rows.filter(r => r.arm === arm)
  const xs = measured(rows, arm)
  return [
    arm,
    `${xs.length}/${all.length}`,
    spread(xs.map(r => r.childCalls), 0),
    spread(xs.map(r => r.meanTools), 1),
    spread(xs.map(r => r.maxTools), 0),
    spread(xs.map(r => r.childCost), 4),
    spread(xs.map(r => r.sessionCost), 4),
    `${all.filter(r => r.correct).length}/${all.length}`,
    `${all.filter(r => r.verbatim).length}/${all.length}`,
  ]
}

function compareLine(other: Arm, rows: readonly Row[]): string {
  const xs = measured(rows, 'batching').map(r => r.childCalls)
  const ys = measured(rows, other).map(r => r.childCalls)
  const label = `child calls, batching vs ${other}:`
  if (!xs.length || !ys.length) return `${label} no data`
  const delta = median(ys) ? ((median(xs) - median(ys)) / median(ys)) * 100 : 0
  return `${label} median ${median(xs)} vs ${median(ys)} (${delta > 0 ? '+' : ''}${delta.toFixed(1)}%), ranges ${rangesOverlap(xs, ys) ? 'overlap' : 'disjoint'}`
}

export type Meta = {
  started: string
  runDir: string
  workspaces: string
  model: string
  effort: string
  reps: number
  bin: string
  /** `--version` of the bin, with this checkout's HEAD. */
  version: string
  /** Whether the bundle the bin runs reads the flag; null when that could not be told. */
  bundleReadsFlag: boolean | null
  hostEnvRemoved: string[]
}

export function renderReport(rows: readonly Row[], meta: Meta): string {
  const verdict = gates(rows)
  const bundle = meta.bundleReadsFlag === null ? 'unknown' : meta.bundleReadsFlag ? 'yes' : 'NO — batching ran as a second placebo'
  const failed = rows.filter(r => !r.delegated || !r.correct)
  return [
    `=== SUB-AGENT BATCHING A/B  model=${meta.model} effort=${meta.effort} reps=${meta.reps} ===`,
    `${meta.bin}: ${meta.version}; the bundle reads ${FLAG}: ${bundle}`,
    `host variables removed: ${meta.hostEnvRemoved.join(', ') || 'none'}; prices: ${priceOf(meta.model).label}`,
    '',
    table(COLUMNS, ARMS.map(arm => armCells(arm, rows))),
    '',
    compareLine('base', rows),
    compareLine('placebo', rows),
    '',
    'gate (pre-registered):',
    ...verdict.map(g => `  ${g.ok ? 'PASS' : 'FAIL'}  ${g.name}: ${g.detail}`),
    `verdict: ${verdict.every(g => g.ok) ? 'PASS' : 'FAIL'}`,
    ...(failed.length ? ['', 'failed sessions:', ...failed.map(r => `  ${r.arm} r${r.rep}: ${failure(r)}`)] : []),
  ].join('\n')
}

function failure(r: Row): string {
  const answer = r.correct ? 'answer correct' : r.missing.join('; ') || 'answer wrong'
  return r.delegated ? answer : `no Code child (${r.childType}); ${answer}`
}

function liveLine(r: Row): string {
  return (
    `${r.arm.padEnd(8)} r${r.rep} ${r.correct ? 'PASS' : 'FAIL'} child=${r.childType} calls=${String(r.childCalls).padStart(2)} ` +
    `tools=${String(r.toolCalls).padStart(2)} tools/call=${r.meanTools.toFixed(1)} max=${r.maxTools} ` +
    `child=$${r.childCost.toFixed(4)} session=$${r.sessionCost.toFixed(4)}${r.verbatim ? '' : ' prompt-edited'}` +
    (r.missing.length ? `  ${r.missing.slice(0, 2).join('; ')}` : '')
  )
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const CHUNK_REF_RE = /"(\.\/[\w.\/-]+\.mjs)"/g
/** In every build: without it the walk missed the chunks, and "no" would be a guess. */
const BUNDLE_CONTROL = 'subagent_type'

/**
 * Whether the bundle `bin` launches mentions `needle`. It walks the chunks
 * reachable from dist/cli.mjs, because dist/chunks also keeps every older
 * build's chunks, so a grep of the directory can find the flag in a stale one.
 * null when the bin is not a checkout's launcher or the walk proves nothing.
 */
function bundleMentions(bin: string, needle: string): boolean | null {
  const found = bin.includes('/') ? bin : Bun.which(bin)
  if (!found || !existsSync(found)) return null
  const entry = join(dirname(dirname(realpathSync(found))), 'dist', 'cli.mjs')
  const seen = new Set<string>()
  const queue = [entry]
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

const normalize = (s: string): string => s.replace(WS_RE, ' ').trim()

/** The `prompt` of the parent's first Agent call, read from its transcript. */
function delegatedPrompt(cwd: string, sessionId: string): string | null {
  const path = transcriptPath(cwd, sessionId)
  if (!sessionId || !existsSync(path)) return null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue
    let v: Record<string, unknown>
    try {
      v = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // a line cut short by the process exiting
    }
    if (v.type !== 'assistant') continue
    const content = ((v.message ?? {}) as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type !== 'tool_use' || b.name !== 'Agent') continue
      const prompt = ((b.input ?? {}) as Record<string, unknown>).prompt
      return typeof prompt === 'string' ? prompt : null
    }
  }
  return null
}

type Args = ProbeArgs & { model: string; effort: string; dryRun: boolean; replay: string }

async function runArm(arm: Arm, rep: number, cwd: string, args: Args): Promise<RunRecord> {
  const expected = makeFixture(cwd, rep)
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt: PARENT_PROMPT,
    env: { ...COMMON_ENV, ...ARM_ENV[arm] },
    timeoutMs: args.timeoutMs,
    extraArgs: ['--effort', args.effort, '--max-turns', String(MAX_TURNS), '--max-budget-usd', String(BUDGET_USD)],
  })
  const session = run.sessionId ? loadSession(cwd, run.sessionId) : { parent: [], children: [] }
  const childPrompt = delegatedPrompt(cwd, run.sessionId)
  return {
    arm,
    rep,
    cwd,
    sessionId: run.sessionId,
    exitCode: run.exitCode,
    finalText: run.finalText,
    expected,
    childPrompt,
    verbatim: childPrompt !== null && normalize(childPrompt) === normalize(CHILD_PROMPT),
    parent: session.parent,
    children: session.children,
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
  const bundle = bundleMentions(args.bin, FLAG)
  if (bundle === false) {
    console.error(`the bundle ${args.bin} runs never reads ${FLAG}: \`bun run build\` first, or batching is a second placebo`)
    process.exit(1)
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
    bin: args.bin,
    version: version(args.bin),
    bundleReadsFlag: bundle,
    hostEnvRemoved,
  }
  const { price } = priceOf(args.model)
  console.log(`subagent-batching-ab → ${runDir}\n  workspaces ${workspaces}\n  ${args.bin}: ${meta.version}`)
  const runs: RunRecord[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    const recs = await Promise.all(ARMS.map((arm, i) => runArm(arm, rep, join(workspaces, `r${rep}-${i + 1}`), args)))
    for (const r of recs) console.log(liveLine(rowOf(r, price)))
    runs.push(...recs)
    save(meta, runs)
  }
  const rows = runs.map(r => rowOf(r, price))
  console.log(`\n${renderReport(rows, meta)}\n\nresults → ${save(meta, runs)}`)
  process.exit(rows.every(r => r.delegated && r.correct) ? 0 : 1)
}

function csv(spec: readonly FileSpec[]): string {
  return spec.map(f => `${f.path}, ${f.count}, ${f.names.join(', ')}`).join('\n')
}

/** One fixture checked against git, and the grader against it; spends no model tokens. */
function dryRun(args: Args): number {
  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  mkdirSync(dir, { recursive: true })
  const [a, b] = [join(realpathSync(dir), 'r1-1'), join(realpathSync(dir), 'r1-2')]
  const spec = makeFixture(a, 1)
  makeFixture(b, 1)
  const seen = observedFacts(a, FILES)
  const onDisk = readdirSync(join(a, 'src')).sort()
  const headOf = (d: string) => git(d, ['rev-parse', '--short', 'HEAD']).trim()
  const mismatches = (field: 'count' | 'names'): string[] =>
    spec.flatMap((f, i) => {
      const got = String(seen[i]![field])
      return got === String(f[field]) ? [] : [`${f.path}: git/source ${got}, spec ${String(f[field])}`]
    })
  const countOff = grade(csv(spec.map((f, i) => (i === 0 ? { ...f, count: f.count + 1 } : f))), spec)
  const nameDropped = grade(csv(spec.map((f, i) => (i === 1 ? { ...f, names: f.names.slice(1) } : f))), spec)
  const empty = grade('', spec)
  const checks: Array<[string, boolean, string]> = [
    ['eight modules under src/', onDisk.join(' ') === FILES.map(f => f.slice(4)).join(' '), onDisk.join(' ')],
    ['counts = git log --oneline -- <file> | wc -l', mismatches('count').length === 0, mismatches('count').join('; ') || spec.map(f => `${f.path.slice(4, -3)}=${f.count}`).join(' ')],
    ['names = the exported functions', mismatches('names').length === 0, mismatches('names').join('; ') || `${spec.flatMap(f => f.names).length} names, 2–3 per file`],
    ['counts are 1…8, once each', spec.map(f => f.count).sort((x, y) => x - y).join() === '1,2,3,4,5,6,7,8', 'distinct, so a count cannot be credited to the wrong file'],
    ['a second build of rep 1 has the same HEAD', headOf(a) === headOf(b), `${headOf(a)} / ${headOf(b)}: every arm of a rep gets one repo`],
    ["rep 2's answer is not rep 1's", JSON.stringify(fixtureSpec(2)) !== JSON.stringify(spec), 'names and counts are drawn per rep'],
    ['the workspace path is transcript-safe', SAFE_PATH_RE.test(a), a],
    ['grader passes the reference reply', grade(csv(spec), spec).correct, 'path, count, names — one line per file'],
    ['grader fails one count off', !countOff.correct, countOff.missing.join('; ')],
    ['grader fails one name dropped', !nameDropped.correct, nameDropped.missing.join('; ')],
    ['grader fails an empty reply', !empty.correct, `${empty.missing.length} files missing`],
  ]
  const bundle = bundleMentions(args.bin, FLAG)
  console.log(
    [
      `dry run in ${dir} — no model tokens`,
      '',
      table(['check', 'ok', 'detail'], checks.map(([c, ok, d]) => [c, ok ? 'yes' : 'NO', d])),
      '',
      'expected answers, rep 1 (checked against git above):',
      ...spec.map(f => `  ${f.path}  ${f.count}  ${f.names.join(', ')}`),
      '',
      `the bundle ${args.bin} runs reads ${FLAG}: ${bundle === null ? 'unknown' : bundle ? 'yes' : 'no — `bun run build` before a paid run, or batching is a second placebo'}`,
      `prices (${args.model}): ${priceOf(args.model).label}`,
      `parent prompt: ${PARENT_PROMPT}`,
    ].join('\n'),
  )
  return checks.every(([, ok]) => ok) ? 0 : 1
}

const ARG_RE = /^--(?:bin|reps|model|timeout|effort|replay)=.+$|^--dry-run$/

function parseBenchArgs(argv: string[]): Args {
  const unknown = argv.filter(a => !ARG_RE.test(a))
  if (unknown.length) {
    console.error(`unknown argument: ${unknown.join(' ')} (the flags are in this file's header)`)
    process.exit(2)
  }
  const probe = parseArgs(argv, { bin: join(REPO_ROOT, 'bin', 'claudin'), reps: 5, model: DEFAULT_MODEL, timeoutMs: 900_000 })
  const value = (k: string): string | undefined => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  return { ...probe, model: probe.model ?? DEFAULT_MODEL, effort: value('effort') ?? 'medium', dryRun: argv.includes('--dry-run'), replay: value('replay') ?? '' }
}

async function main(): Promise<void> {
  const args = parseBenchArgs(process.argv.slice(2))
  if (args.dryRun) process.exit(dryRun(args))
  if (args.replay) {
    const saved = JSON.parse(readFileSync(args.replay, 'utf8')) as Saved
    const { price } = priceOf(saved.meta.model)
    console.log(renderReport(saved.runs.map(r => rowOf(r, price)), saved.meta))
    return
  }
  await run(args)
}

if (import.meta.main) await main()
