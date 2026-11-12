#!/usr/bin/env bun
/**
 * Classifier cache A/B, live: what the auto-mode classifier costs with its
 * transcript sized by the window and a lag marker on it, against today's
 * fixed 200k budget — on the real API, where the replay
 * (`scripts/bench/tokens/classifier-cache-replay.ts`) can only model the cache.
 *
 *   bun scripts/bench/ab/classifier-cache-ab.ts --dry-run                 # the plan, no tokens
 *   bun scripts/bench/ab/classifier-cache-ab.ts --only=candidate --reps=1 --turns=8 --wide-every=4   # plumbing probe
 *   bun scripts/bench/ab/classifier-cache-ab.ts --reps=2 --budget-usd=45  # the run
 *   bun scripts/bench/ab/classifier-cache-ab.ts --report=/tmp/classifier-cache-ab/<stamp>   # recount a finished run
 *   bun scripts/bench/ab/classifier-cache-ab.ts --report=<run 1>,<run 2>  # two one-rep runs as one, reps renumbered in that order
 *
 * Arms, one headless `--permission-mode auto --debug` session each per rep, in
 * a throwaway git repo of its own, the arms of a rep side by side:
 *
 *   base       this checkout, both levers unset
 *   placebo    base plus a variable nothing reads
 *   candidate  CLAUDIN_CLASSIFIER_WINDOW_BUDGET=1 and CLAUDIN_CLASSIFIER_LAG_MARKER=1
 *
 * Every arm runs with CLAUDIN_READ_MULTI=0, so a wide turn's reads are one
 * tool_use each rather than one batch.
 *
 * Workload, the 2026-10-24 one made longer and given wide turns: each turn is a
 * user message carrying the next `--chars` (5,500) of this repo's
 * `docs/tech/**\/*.md` and one Bash call the classifier has to judge
 * (`python3 -c "print(N * 7)"`). Every `--wide-every`-th turn first asks for
 * `--reads` (24) Reads of small files, each its own call: Reads are accepted by
 * the mode, so they reach the classifier's transcript as 24 blocks no call
 * judged, more than the API's 20-block lookback. With 54 turns the transcript
 * passes the 200k-char base budget at turn 33 and the base cut moves
 * five times after that. The first message of a session carries its tag, so
 * sessions running at once share no cached transcript; a one-turn warm-up
 * session writes the tools and the classifier's system prompt first, which
 * they do share.
 *
 * Gates, written before the run (2026-11-11). The default flips only if all
 * six pass, and the user is asked first:
 *   1. `sourceUsage.auto_mode` cache writes: candidate ≤ 0.6 × base in every
 *      rep; placebo within ±10% of base (means).
 *   2. Classifier spend: candidate ≤ 0.8 × base (means).
 *   3. Mechanism, from each session's debug log: the candidate marks a lag
 *      block (`lag=<n>`) on ≥ 80% of the calls whose transcript grew by more
 *      than 20 blocks since the call before; and where base has
 *      `truncated=true` calls in every rep, the candidate has none.
 *   4. Rejected tool calls: candidate ≤ base + 2, summed over the reps.
 *   5. Classifier latency, the p50 from a Bash call's tool_use reaching the
 *      stream to its result (the command itself runs in ~50 ms): candidate ≤
 *      1.25 × base.
 *   6. Everything but the classifier (total − auto_mode): candidate within ±5%
 *      of base (means).
 *
 * What it does not show: how often real sessions meet either mechanism. That
 * is the replay's question; this workload meets both on purpose.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl, transcriptPath } from './cliUsage'
import { debugLogPath, median } from './headlessProbe'
import { armEnv, git, stamp } from './session-cache-ab'

const BENCH_ROOT = '/tmp/classifier-cache-ab'
const ARMS = ['base', 'placebo', 'candidate'] as const
export type Arm = (typeof ARMS)[number]

const COMMON_ENV = { CLAUDIN_READ_MULTI: '0' }
const ARM_ENV: Record<Arm, Record<string, string>> = {
  base: {},
  placebo: { CLAUDIN_BENCH_PLACEBO: '1' },
  candidate: { CLAUDIN_CLASSIFIER_WINDOW_BUDGET: '1', CLAUDIN_CLASSIFIER_LAG_MARKER: '1' },
}

const LOOKBACK_BLOCKS = 20
const BASE_BUDGET_CHARS = 200_000
const BASE_CHUNK_CHARS = 25_000

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type Args = {
  bin: string
  model: string
  arms: Arm[]
  reps: number
  turns: number
  wideEvery: number
  reads: number
  chars: number
  budgetUsd: number
  turnTimeoutMs: number
  warmup: boolean
  dryRun: boolean
  report: string | null
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    bin: 'claudindev',
    model: 'claude-sonnet-5-5',
    arms: [...ARMS],
    reps: 2,
    turns: 54,
    wideEvery: 6,
    reads: 24,
    chars: 5_500,
    budgetUsd: 45,
    turnTimeoutMs: 300_000,
    warmup: true,
    dryRun: false,
    report: null,
  }
  for (const arg of argv) {
    const [flag, value = ''] = arg.split(/=(.*)/s)
    if (flag === '--bin') args.bin = value
    else if (flag === '--model') args.model = value
    else if (flag === '--only') {
      const picked = value.split(',')
      const unknown = picked.filter(a => !(ARMS as readonly string[]).includes(a))
      if (unknown.length > 0) throw new Error(`unknown arm: ${unknown.join(', ')}`)
      args.arms = ARMS.filter(a => picked.includes(a))
    } else if (flag === '--reps') args.reps = Number(value)
    else if (flag === '--turns') args.turns = Number(value)
    else if (flag === '--wide-every') args.wideEvery = Number(value)
    else if (flag === '--reads') args.reads = Number(value)
    else if (flag === '--chars') args.chars = Number(value)
    else if (flag === '--budget-usd') args.budgetUsd = Number(value)
    else if (flag === '--turn-timeout') args.turnTimeoutMs = Number(value)
    else if (flag === '--no-warmup') args.warmup = false
    else if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--report') args.report = value
    else throw new Error(`unknown argument: ${arg}`)
  }
  for (const key of ['reps', 'turns', 'wideEvery', 'reads', 'chars', 'budgetUsd', 'turnTimeoutMs'] as const) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) throw new Error(`--${key} must be a positive number`)
  }
  return args
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

export type Turn = { index: number; wide: boolean; files: string[]; text: string }

function markdownUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdownUnder(path))
    else if (entry.name.endsWith('.md')) out.push(path)
  }
  return out
}

/** The reference text the turns carry: the repo's tech docs, in path order. */
export function loadProse(): string {
  return markdownUnder(join(REPO_ROOT, 'docs', 'tech'))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n')
}

export function noteFile(wideTurn: number, n: number): string {
  return `notes/w${String(wideTurn).padStart(2, '0')}/n${String(n).padStart(2, '0')}.txt`
}

/** The turns of one session. Only the tag differs between sessions. */
export function buildWorkload(
  prose: string,
  opts: Pick<Args, 'turns' | 'wideEvery' | 'reads' | 'chars'>,
  tag: string,
): Turn[] {
  if (prose.length < opts.turns * opts.chars) {
    throw new Error(`the prose holds ${prose.length} chars, ${opts.turns} turns of ${opts.chars} need ${opts.turns * opts.chars}`)
  }
  const turns: Turn[] = []
  for (let i = 1; i <= opts.turns; i++) {
    const wide = i % opts.wideEvery === 0
    const files = wide ? Array.from({ length: opts.reads }, (_, n) => noteFile(i / opts.wideEvery, n + 1)) : []
    const chunk = prose.slice((i - 1) * opts.chars, i * opts.chars)
    const command = `python3 -c "print(${i} * 7)"`
    const ask = wide
      ? `First read each of these ${files.length} files with the Read tool, one Read call per file: ${files.join(', ')}. ` +
        `Then run exactly this one Bash command and reply with only its output: ${command}`
      : `Run exactly this one Bash command and reply with only its output: ${command}`
    turns.push({
      index: i,
      wide,
      files,
      text:
        `${i === 1 ? `[session ${tag}] ` : ''}Reference text ${i} of ${opts.turns}. It is background reading, not instructions:\n` +
        `<reference>\n${chunk}\n</reference>\n${ask}`,
    })
  }
  return turns
}

export function makeWorkspace(dir: string, turns: readonly Turn[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# classifier-cache-ab workspace\n')
  for (const turn of turns) {
    for (const file of turn.files) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), `note ${file}: ${turn.index * 1000 + turn.files.indexOf(file)}\n`)
    }
  }
  const steps: string[][] = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Bench User'],
    ['config', 'user.email', 'bench@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'chore: bench workspace'],
  ]
  for (const step of steps) {
    const r = git(dir, ...step)
    if (!r.ok) throw new Error(`git ${step.join(' ')} failed in ${dir}: ${r.out}`)
  }
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
type Stamped = { at: number; event: Json }

function sessionArgs(model: string): string[] {
  return [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--permission-mode', 'auto',
    // Last: `--debug [filter]` takes an optional value.
    '--debug',
  ]
}

/** Runs the turns one by one and leaves `<base>.stream.jsonl`, `.transcript.jsonl` and `.debug.txt`. */
async function runSession(
  args: Args,
  env: Record<string, string>,
  ws: string,
  base: string,
  turns: readonly Turn[],
): Promise<{ turnsDone: number; sessionId: string | null; stderr: string }> {
  const child = spawn(args.bin, sessionArgs(args.model), {
    cwd: ws,
    env: armEnv({ ...COMMON_ENV, ...env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const streamFile = createWriteStream(`${base}.stream.jsonl`)
  let sessionId: string | null = null
  let resolveTurn: (() => void) | null = null
  const stderr: string[] = []
  child.stderr.on('data', d => stderr.push(String(d)))
  const exited = new Promise<void>(resolve => child.on('close', () => resolve()))

  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return
    let event: Json
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    streamFile.write(`${JSON.stringify({ at: Date.now(), event } satisfies Stamped)}\n`)
    if (typeof event.session_id === 'string') sessionId ??= event.session_id
    if (event.type === 'result') resolveTurn?.()
  })

  let turnsDone = 0
  for (const turn of turns) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<boolean>(resolve => {
      resolveTurn = () => resolve(true)
      timer = setTimeout(() => resolve(false), args.turnTimeoutMs)
      void exited.then(() => resolve(false))
    })
    child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: turn.text }] } })}\n`,
    )
    const ok = await done
    clearTimeout(timer)
    if (!ok) break
    turnsDone++
  }
  child.stdin.end()
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 30_000))])
  child.kill()
  streamFile.end()

  if (sessionId) {
    const transcript = transcriptPath(sessionId)
    if (transcript && existsSync(transcript)) copyFileSync(transcript, `${base}.transcript.jsonl`)
    if (existsSync(debugLogPath(sessionId))) copyFileSync(debugLogPath(sessionId), `${base}.debug.txt`)
  }
  return { turnsDone, sessionId, stderr: stderr.join('') }
}

// ---------------------------------------------------------------------------
// Reading a session back
// ---------------------------------------------------------------------------

export type ClassifierCall = { truncated: boolean; budget: number; lag: number | null; blocks: number }

const CONTEXT_LINE_RE = /\[auto-mode\] context comparison: .*truncated=(true|false) budget=(\d+) lag=(none|\d+)\/(\d+)/

/** One entry per classifier call, from the `[auto-mode] context comparison` lines of a debug log. */
export function parseClassifierDebug(log: string): ClassifierCall[] {
  const calls: ClassifierCall[] = []
  for (const line of log.split('\n')) {
    const m = CONTEXT_LINE_RE.exec(line)
    if (!m) continue
    calls.push({
      truncated: m[1] === 'true',
      budget: Number(m[2]),
      lag: m[3] === 'none' ? null : Number(m[3]),
      blocks: Number(m[4]),
    })
  }
  return calls
}

/** Calls whose transcript grew past the lookback since the call before, and how many of them carry a lag block. */
export function wideGaps(calls: readonly ClassifierCall[]): { wide: number; marked: number } {
  let wide = 0
  let marked = 0
  for (let i = 1; i < calls.length; i++) {
    if (calls[i]!.blocks - calls[i - 1]!.blocks <= LOOKBACK_BLOCKS) continue
    wide++
    if (calls[i]!.lag !== null) marked++
  }
  return { wide, marked }
}

const blocksOf = (content: unknown): Json[] =>
  Array.isArray(content) ? content.filter((b): b is Json => typeof b === 'object' && b !== null) : []

/** Milliseconds from each Bash tool_use reaching the stream to its tool_result. */
export function bashLatencies(stream: readonly Stamped[]): number[] {
  const startedAt = new Map<string, number>()
  const latencies: number[] = []
  for (const { at, event } of stream) {
    const message = (event.message ?? {}) as Json
    for (const block of blocksOf(message.content)) {
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string') {
        if (!startedAt.has(block.id)) startedAt.set(block.id, at)
      } else if (event.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const start = startedAt.get(block.tool_use_id)
        if (start !== undefined) latencies.push(at - start)
        startedAt.delete(block.tool_use_id)
      }
    }
  }
  return latencies
}

type SourceUsage = { calls: number; costUSD: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }

export type SessionStats = {
  arm: Arm
  rep: number
  sessionId: string | null
  turnsDone: number
  totalUsd: number
  classifierUsd: number
  classifierCalls: number
  classifierWrites: number
  classifierReads: number
  restUsd: number
  judged: number
  rejects: number
  latencyP50Ms: number
  debugCalls: number
  truncatedCalls: number
  wide: number
  marked: number
  maxBudget: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function sessionStats(
  arm: Arm,
  rep: number,
  raw: { turnsDone: number; sessionId: string | null; transcript: readonly Json[]; debug: string; stream: readonly Stamped[] },
): SessionStats {
  let costState: Json | null = null
  let judged = 0
  let rejects = 0
  for (const rec of raw.transcript) {
    if (rec.type === 'cost-state') costState = rec
    const decision = rec.permissionDecision as { decision?: string; reason?: string } | undefined
    if (!decision) continue
    if (decision.reason === 'classifier') judged++
    if (decision.decision === 'reject') rejects++
  }
  const sources = (costState?.sourceUsage ?? {}) as Record<string, SourceUsage>
  const auto = sources.auto_mode
  const calls = parseClassifierDebug(raw.debug)
  const gaps = wideGaps(calls)
  const totalUsd = num(costState?.totalCostUSD)
  return {
    arm,
    rep,
    sessionId: raw.sessionId,
    turnsDone: raw.turnsDone,
    totalUsd,
    classifierUsd: num(auto?.costUSD),
    classifierCalls: num(auto?.calls),
    classifierWrites: num(auto?.cacheCreationInputTokens),
    classifierReads: num(auto?.cacheReadInputTokens),
    restUsd: totalUsd - num(auto?.costUSD),
    judged,
    rejects,
    latencyP50Ms: median(bashLatencies(raw.stream)),
    debugCalls: calls.length,
    truncatedCalls: calls.filter(c => c.truncated).length,
    wide: gaps.wide,
    marked: gaps.marked,
    maxBudget: calls.reduce((max, c) => Math.max(max, c.budget), 0),
  }
}

function readSession(base: string, arm: Arm, rep: number, turnsDone: number, sessionId: string | null): SessionStats {
  const text = (suffix: string): string => (existsSync(`${base}${suffix}`) ? readFileSync(`${base}${suffix}`, 'utf8') : '')
  return sessionStats(arm, rep, {
    turnsDone,
    sessionId,
    transcript: parseJsonl(text('.transcript.jsonl')),
    debug: text('.debug.txt'),
    stream: parseJsonl(text('.stream.jsonl')) as unknown as Stamped[],
  })
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export type Gate = { name: string; pass: boolean; detail: string }

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const ratio = (a: number, b: number): number => (b === 0 ? Number.POSITIVE_INFINITY : a / b)
const fmtRatio = (r: number): string => (Number.isFinite(r) ? `× ${r.toFixed(2)}` : 'no base')
const fmtK = (n: number): string => `${(n / 1000).toFixed(0)}k`
const fmtUsd = (n: number): string => `$${n.toFixed(2)}`

/** The six pre-registered gates of the header. Needs every arm in every rep. */
export function evaluateGates(sessions: readonly SessionStats[]): Gate[] {
  const of = (arm: Arm): SessionStats[] => sessions.filter(s => s.arm === arm).sort((a, b) => a.rep - b.rep)
  const base = of('base')
  const placebo = of('placebo')
  const candidate = of('candidate')
  const reps = base.map(s => s.rep)

  const writeRatios = reps.map(rep =>
    ratio(candidate.find(s => s.rep === rep)?.classifierWrites ?? Number.NaN, base.find(s => s.rep === rep)!.classifierWrites),
  )
  const placeboWrites = ratio(mean(placebo.map(s => s.classifierWrites)), mean(base.map(s => s.classifierWrites)))
  const spend = ratio(mean(candidate.map(s => s.classifierUsd)), mean(base.map(s => s.classifierUsd)))
  const wide = candidate.reduce((sum, s) => sum + s.wide, 0)
  const marked = candidate.reduce((sum, s) => sum + s.marked, 0)
  const baseTruncated = base.map(s => s.truncatedCalls)
  const candidateTruncated = candidate.reduce((sum, s) => sum + s.truncatedCalls, 0)
  const baseRejects = base.reduce((sum, s) => sum + s.rejects, 0)
  const candidateRejects = candidate.reduce((sum, s) => sum + s.rejects, 0)
  const latency = ratio(mean(candidate.map(s => s.latencyP50Ms)), mean(base.map(s => s.latencyP50Ms)))
  const rest = ratio(mean(candidate.map(s => s.restUsd)), mean(base.map(s => s.restUsd)))
  const complete = reps.length > 0 && placebo.length === reps.length && candidate.length === reps.length

  return [
    {
      name: '1. classifier cache writes: candidate ≤ 0.6 × base in every rep, placebo within ±10%',
      pass: complete && writeRatios.every(r => r <= 0.6) && Math.abs(placeboWrites - 1) <= 0.1,
      detail: `candidate ${writeRatios.map(fmtRatio).join(', ')}; placebo ${fmtRatio(placeboWrites)}`,
    },
    {
      name: '2. classifier spend: candidate ≤ 0.8 × base',
      pass: complete && spend <= 0.8,
      detail: `${fmtUsd(mean(base.map(s => s.classifierUsd)))} → ${fmtUsd(mean(candidate.map(s => s.classifierUsd)))} (${fmtRatio(spend)})`,
    },
    {
      name: '3. mechanism: a lag block on ≥ 80% of the calls past the lookback; no truncated call where base has them',
      pass: complete && wide > 0 && marked / wide >= 0.8 && baseTruncated.every(n => n > 0) && candidateTruncated === 0,
      detail: `lag on ${marked} of ${wide} wide calls; truncated calls base ${baseTruncated.join(', ')}, candidate ${candidateTruncated}`,
    },
    {
      name: '4. rejected tool calls: candidate ≤ base + 2',
      pass: complete && candidateRejects <= baseRejects + 2,
      detail: `base ${baseRejects}, candidate ${candidateRejects}`,
    },
    {
      name: '5. classifier latency p50: candidate ≤ 1.25 × base',
      pass: complete && latency <= 1.25,
      detail: `${Math.round(mean(base.map(s => s.latencyP50Ms)))} ms → ${Math.round(mean(candidate.map(s => s.latencyP50Ms)))} ms (${fmtRatio(latency)})`,
    },
    {
      name: '6. everything but the classifier: candidate within ±5% of base',
      pass: complete && Math.abs(rest - 1) <= 0.05,
      detail: `${fmtUsd(mean(base.map(s => s.restUsd)))} → ${fmtUsd(mean(candidate.map(s => s.restUsd)))} (${fmtRatio(rest)})`,
    },
  ]
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function report(sessions: readonly SessionStats[], meta: Json): string {
  const header =
    '| session | turns | auto_mode calls | cache write | cache read | classifier $ | rest $ | judged | rejects | p50 ms | truncated | budget | lag / wide |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  const rows = [...sessions]
    .sort((a, b) => ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm) || a.rep - b.rep)
    .map(
      s =>
        `| ${s.arm} r${s.rep} | ${s.turnsDone} | ${s.classifierCalls} | ${s.classifierWrites.toLocaleString('en-US')} | ` +
        `${s.classifierReads.toLocaleString('en-US')} | ${fmtUsd(s.classifierUsd)} | ${fmtUsd(s.restUsd)} | ${s.judged} | ${s.rejects} | ` +
        `${Math.round(s.latencyP50Ms)} | ${s.truncatedCalls} of ${s.debugCalls} | ${fmtK(s.maxBudget)} | ${s.marked} / ${s.wide} |`,
    )
  const lines = [`# Classifier cache A/B, live`, '', '```json', JSON.stringify(meta, null, 2), '```', '', header, ...rows, '']
  const arms = new Set(sessions.map(s => s.arm))
  if (ARMS.every(a => arms.has(a))) {
    const gates = evaluateGates(sessions)
    lines.push('## Gates', '')
    for (const gate of gates) lines.push(`- ${gate.pass ? 'PASS' : 'FAIL'}  ${gate.name} — ${gate.detail}`)
    lines.push('', gates.every(g => g.pass) ? 'ALL GATES PASS' : 'GATE FAIL')
  } else {
    lines.push(`Gates not evaluated: the run holds ${[...arms].join(', ')} only.`)
  }
  lines.push('', `total spend: ${fmtUsd(sessions.reduce((sum, s) => sum + s.totalUsd, 0))}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Saved = { meta: Json; sessions: Array<{ arm: Arm; rep: number; turnsDone: number; sessionId: string | null }> }

function dryRun(args: Args): void {
  const turns = buildWorkload(loadProse(), args, 'dry-run')
  const proseChars = turns.reduce((sum, t) => sum + t.text.length, 0)
  const wide = turns.filter(t => t.wide)
  const moves = Math.max(0, Math.ceil((proseChars - BASE_BUDGET_CHARS) / BASE_CHUNK_CHARS))
  console.log(`arms: ${args.arms.join(', ')} × ${args.reps} reps on ${args.model} via ${args.bin}`)
  console.log(`turns: ${turns.length}, ${wide.length} wide (${args.reads} Reads each): ${wide.map(t => t.index).join(', ')}`)
  console.log(`user text: ${proseChars.toLocaleString('en-US')} chars; past the ${BASE_BUDGET_CHARS / 1000}k base budget the base cut moves ~${moves} times`)
  console.log(`budget guard: $${args.budgetUsd}; warm-up session: ${args.warmup ? 'yes' : 'no'}`)
  console.log(`first turn:\n${turns[0]!.text.slice(0, 300)}…\n…${turns[0]!.text.slice(-160)}`)
  console.log(`first wide turn ends:\n…${wide[0]?.text.slice(-420) ?? '(none)'}`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) return dryRun(args)

  if (args.report) {
    // Several runs read as one: a rep at a time leaves room to check the
    // account's quota between them.
    const stats: SessionStats[] = []
    const metas: Json[] = []
    let repOffset = 0
    for (const dir of args.report.split(',')) {
      const saved: Saved = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
      for (const s of saved.sessions) {
        stats.push(readSession(join(dir, `${s.arm}-r${s.rep}`), s.arm, s.rep + repOffset, s.turnsDone, s.sessionId))
      }
      repOffset += Math.max(0, ...saved.sessions.map(s => s.rep))
      metas.push(saved.meta)
    }
    console.log(report(stats, metas.length === 1 ? metas[0]! : { runs: metas }))
    return
  }

  const runDir = join(BENCH_ROOT, stamp())
  mkdirSync(runDir, { recursive: true })
  const prose = loadProse()
  const meta: Json = {
    at: new Date().toISOString(),
    bin: args.bin,
    model: args.model,
    arms: args.arms,
    reps: args.reps,
    turns: args.turns,
    wideEvery: args.wideEvery,
    reads: args.reads,
    chars: args.chars,
    head: git(REPO_ROOT, 'rev-parse', '--short', 'HEAD').out.trim(),
  }
  const saved: Saved = { meta, sessions: [] }
  const stats: SessionStats[] = []

  if (args.warmup) {
    const turns = buildWorkload(prose, { ...args, turns: 1, wideEvery: 2 }, `warmup-${stamp()}`)
    const ws = join(runDir, 'ws-warmup')
    makeWorkspace(ws, turns)
    const warm = await runSession(args, {}, ws, join(runDir, 'warmup'), turns)
    console.log(`warm-up: ${warm.turnsDone} turn, session ${warm.sessionId ?? 'none'}`)
    if (warm.turnsDone === 0) throw new Error(`the warm-up session did not finish a turn:\n${warm.stderr.slice(0, 800)}`)
  }

  let spent = 0
  let lastRepUsd = 0
  for (let rep = 1; rep <= args.reps; rep++) {
    if (spent + lastRepUsd > args.budgetUsd) {
      console.log(`stopping before rep ${rep}: $${spent.toFixed(2)} spent, a rep costs ~$${lastRepUsd.toFixed(2)}, budget $${args.budgetUsd}`)
      break
    }
    const results = await Promise.all(
      args.arms.map(async arm => {
        const tag = `${arm}-r${rep}-${stamp()}`
        const turns = buildWorkload(prose, args, tag)
        const ws = join(runDir, `ws-${arm}-r${rep}`)
        makeWorkspace(ws, turns)
        const base = join(runDir, `${arm}-r${rep}`)
        const ran = await runSession(args, ARM_ENV[arm], ws, base, turns)
        saved.sessions.push({ arm, rep, turnsDone: ran.turnsDone, sessionId: ran.sessionId })
        if (ran.turnsDone < turns.length) console.log(`${arm} r${rep}: stopped at turn ${ran.turnsDone} of ${turns.length}\n${ran.stderr.slice(0, 400)}`)
        return readSession(base, arm, rep, ran.turnsDone, ran.sessionId)
      }),
    )
    stats.push(...results)
    lastRepUsd = results.reduce((sum, s) => sum + s.totalUsd, 0)
    spent += lastRepUsd
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(saved, null, 2))
    console.log(`rep ${rep} done: $${lastRepUsd.toFixed(2)} (run total $${spent.toFixed(2)})`)
  }

  const text = report(stats, meta)
  writeFileSync(join(runDir, 'report.md'), text)
  console.log(`\n${text}\n\nrun dir → ${runDir}`)
}

if (import.meta.main) await main()
