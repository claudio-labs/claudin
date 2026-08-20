#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// plan-noop-narration-ab — why does Sonnet call `Bash(true)` in plan mode?
// ---------------------------------------------------------------------------
//
// Sonnet 5 emits `Bash({"command":"true","description":"noop"})` as a THINKING
// CONTINUATION: it reads a tool result, thinks, calls the no-op, gets
// "(No output)", thinks again, and only then issues the real Grep/Glob. Each
// one is a full model round-trip that re-reads the whole context. Measured over
// ~/.claudin/projects: 33 occurrences in 14 sessions, all claude-sonnet-5, zero
// on Opus; the worst session burned 1.03M cache-read tokens on no-op turns.
//
// The hypothesis is that our own prompt closes every cheaper alternative —
// ANTI_NARRATION forbids interstitial text, and plan mode forbids ending the
// turn — leaving a tool call as the only legal emission. This bench measures
// that, and then measures the fix.
//
//   --toggle=anti-narration   A CLAUDIN_ANTI_NARRATION=1   B =0
//     Diagnostic. If the no-op rate drops in B, our prompt is implicated. A null
//     means the no-op is native Sonnet behavior and the clause is a bet on the
//     behavior, not on the cause.
//
//   --toggle=plan-noop-guard  A CLAUDIN_PLAN_NOOP_GUARD=0  B =1
//     The fix. B carries the plan-mode clause that names the cost of a
//     placeholder command. Arm A is the world before it.
//
// ONE build, one killswitch, one pinned model in both arms. The build flag
// alone could not do this: `feature()` folds to a literal, so reaching both arms
// through it means building twice and comparing two bundles — the mistake that
// made the clip-pin A/B uncitable. Both arms set the variable EXPLICITLY;
// neither relies on unset, so a later default flip cannot silently turn this
// into a one-armed run.
//
// PRIMARY METRIC: no-ops per 100 tool turns. Not raw no-op count — a run that
// explores twice as long has twice the opportunity, and arm B changing the
// exploration length would otherwise read as a fix.
//
// READING THE RESULT. Medians alone cannot carry this: the base rate is ~5% of
// tool turns, so a median can sit at 0 in both arms while the arms genuinely
// differ. Every rep's raw no-op count is printed, and the acceptance bar
// requires the min-max RANGES to separate, not just the medians. Zero in both
// arms is an inconclusive run, not a win — the report says so in those words.
//
// Usage:
//   bun scripts/bench/ab/plan-noop-narration-ab.ts [--toggle=anti-narration]
//                                                  [--reps=N] [--dry-run]
//
// Environment:
//   ANTHROPIC_MODEL=claude-sonnet-5           (default — the bug is Sonnet-only)
//   CLAUDIN_BENCH_RUNS=5                      (reps per prompt per arm)
//   CLAUDIN_BENCH_TARGET_CWD=~/projects/legendarr
//   CLAUDIN_BENCH_MAX_TURNS=25
//   CLAUDIN_BENCH_TIMEOUT_MS=420000
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
const CHUNK_DIR = join(REPO_ROOT, 'dist', 'chunks')
const OUT_PATH = join(REPO_ROOT, 'scripts', 'bench', 'ab', 'plan-noop-narration-ab.json')

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5'
const RUNS_PER_PROMPT = Number(process.env.CLAUDIN_BENCH_RUNS ?? '5')
const TARGET_CWD = process.env.CLAUDIN_BENCH_TARGET_CWD ?? join(homedir(), 'projects', 'legendarr')
const MAX_TURNS = Number(process.env.CLAUDIN_BENCH_MAX_TURNS ?? '25')
const TIMEOUT_MS = Number(process.env.CLAUDIN_BENCH_TIMEOUT_MS ?? '420000')

/** `chunks/<module>-<generation>-<hash>.mjs`; group 1 is the generation tag. */
const CHUNK_REF_RE = /chunks\/[A-Za-z0-9._]+-([a-z0-9]{8})-[a-z0-9]+\.mjs/g
/** A resolver occurrence preceded by `function ` is its definition, not a call. */
const FUNCTION_PREFIX = 'function '

/**
 * A no-op is a shell command that runs nothing and returns success. Matched on
 * the EXACT trimmed command: `true && ls` is a real command that happens to
 * start with the same word, and counting it would inflate the metric with
 * ordinary work.
 */
const NOOP_COMMANDS = new Set(['true', ':'])

type ToggleId = 'anti-narration' | 'plan-noop-guard'

type Toggle = {
  /** The env var both arms set explicitly. */
  envVar: string
  /** The resolver that reads it — proof the gate CALLS it, not just that it compiled in. */
  resolver: string
  /** Arm A value, arm B value. A is always the world we are comparing against. */
  armA: '0' | '1'
  armB: '0' | '1'
  /** What each arm means, for the report header. */
  describe: string
}

const TOGGLES: Record<ToggleId, Toggle> = {
  'anti-narration': {
    envVar: 'CLAUDIN_ANTI_NARRATION',
    resolver: 'isAntiNarrationEnabled(',
    armA: '1',
    armB: '0',
    describe: 'A = anti-narration ON (shipped), B = OFF (interstitial text allowed)',
  },
  'plan-noop-guard': {
    envVar: 'CLAUDIN_PLAN_NOOP_GUARD',
    resolver: 'isPlanNoopGuardEnabled(',
    armA: '0',
    armB: '1',
    describe: 'A = no clause (world before), B = plan-mode placeholder clause present',
  },
}

/**
 * Plan-mode requests over a Python backend, each spanning jobs, services and
 * tests so the model has to search repeatedly. The no-op appears BETWEEN a tool
 * result and the next Grep/Glob, so a prompt answerable from one file cannot
 * reproduce it however long the model thinks.
 */
const PROMPTS: { id: string; text: string }[] = [
  {
    id: 'retry-backoff',
    text: 'vamos planejar como adicionar backoff exponencial com jitter no retry de download de legenda, cobrindo os jobs, o scheduler e os testes',
  },
  {
    id: 'provider-timeout',
    text: 'vamos planejar como tornar o timeout do provider chain configuravel por provider, incluindo onde isso entra na config e nos testes',
  },
  {
    id: 'match-score-api',
    text: 'vamos planejar como expor o match_score de cada candidato na API de busca de legenda, do schema ate o router',
  },
  {
    id: 'proxy-health',
    text: 'vamos planejar como adicionar um health check periodico nos proxies de legenda, integrado ao scheduling existente',
  },
]

// ---------------------------------------------------------------------------
// bundle gate
// ---------------------------------------------------------------------------

/** Chunk filenames of the generation `dist/cli.mjs` actually references. */
function currentGenerationChunks(): { generation: string; files: string[] } {
  if (!existsSync(BUNDLE)) {
    throw new Error('dist/cli.mjs is missing — run `bun run build` first')
  }
  const entry = readFileSync(BUNDLE, 'utf8')
  const generations = new Set(
    [...entry.matchAll(CHUNK_REF_RE)].map(m => m[1]).filter((g): g is string => Boolean(g)),
  )
  if (generations.size !== 1) {
    throw new Error(
      `dist/cli.mjs references ${generations.size} chunk generations (${[...generations].join(', ') || 'none'}) — ` +
        'expected exactly one. Run `bun run build`.',
    )
  }
  const [generation] = [...generations] as [string]
  const files = existsSync(CHUNK_DIR)
    ? readdirSync(CHUNK_DIR)
        .filter(f => f.includes(`-${generation}-`) && f.endsWith('.mjs'))
        .map(f => join(CHUNK_DIR, f))
    : []
  return { generation, files }
}

/** True when the resolver appears somewhere other than its own definition. */
function hasCallSite(body: string, resolver: string): boolean {
  let i = body.indexOf(resolver)
  while (i !== -1) {
    const before = body.slice(Math.max(0, i - FUNCTION_PREFIX.length), i)
    if (before !== FUNCTION_PREFIX) return true
    i = body.indexOf(resolver, i + 1)
  }
  return false
}

/**
 * The bench drives the BUNDLE, not source, so a stale `dist/` would run both
 * arms on a binary that has never heard of the killswitch — two identical arms
 * reported as a clean null, with nothing in the numbers to give it away
 * afterwards. Refuse rather than measure that.
 *
 * Two separate proofs are required. The env literal alone only shows the
 * resolver was compiled in; a CALL to it that is not its own definition shows
 * the gate reaches it, which is what a careless revert to a bare `feature()`
 * ternary would quietly undo. `dist/chunks/` keeps three build generations, and
 * an old generation vouching for the current build is exactly the false green
 * this gate exists to prevent — so only the referenced generation is searched.
 */
function assertBundleHonorsToggle(toggle: Toggle): { generation: string; chunk: string } {
  const { generation, files } = currentGenerationChunks()
  const bodies = new Map<string, string>()
  for (const f of [BUNDLE, ...files]) bodies.set(f, readFileSync(f, 'utf8'))

  if (![...bodies.values()].some(b => b.includes(toggle.envVar))) {
    throw new Error(
      `dist/ predates the ${toggle.envVar} killswitch (searched the entry and ${files.length} chunks ` +
        `of generation ${generation}): both arms would run the same prompt and the run would read\n` +
        'as a clean null. Run `bun run build`.',
    )
  }
  const callSite = [...bodies.entries()].find(([, b]) => hasCallSite(b, toggle.resolver))
  if (!callSite) {
    throw new Error(
      `dist/ carries ${toggle.envVar} but never CALLS \`${toggle.resolver})\` — the gate compiled to a\n` +
        'constant, so the killswitch is inert and both arms are identical. Check the call site in\n' +
        'src/, then run `bun run build`.',
    )
  }
  return { generation, chunk: callSite[0] }
}

// ---------------------------------------------------------------------------
// transcript parsing
// ---------------------------------------------------------------------------

function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      out.push(JSON.parse(s) as Record<string, unknown>)
    } catch {
      /* partial line */
    }
  }
  return out
}

function projectDirForCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

function transcriptPath(sessionId: string, cwd: string): string | null {
  const p = join(homedir(), '.claudin', 'projects', projectDirForCwd(cwd), `${sessionId}.jsonl`)
  return existsSync(p) ? p : null
}

type Analysis = {
  /** Assistant messages carrying at least one tool_use — the metric's denominator. */
  toolTurns: number
  toolCalls: number
  noops: number
  /** Per-tool counts, so a run that simply never used Bash is visible. */
  toolMix: Record<string, number>
  /** cache_read on the messages that carried a no-op: what the detour cost. */
  noopCacheRead: number
  outputTokens: number
}

const EMPTY_ANALYSIS: Analysis = {
  toolTurns: 0,
  toolCalls: 0,
  noops: 0,
  toolMix: {},
  noopCacheRead: 0,
  outputTokens: 0,
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

function isNoopCall(block: Record<string, unknown>): boolean {
  if (block.name !== 'Bash') return false
  const input = asRecord(block.input)
  const command = input?.command
  return typeof command === 'string' && NOOP_COMMANDS.has(command.trim())
}

/**
 * The transcript writes one line per content block, all sharing message.id, and
 * output_tokens GROWS as the message streams. So turns are counted by distinct
 * message id and output tokens keep the max per id — summing every line would
 * multiply both.
 */
function analyzeTranscript(path: string): Analysis {
  const events = parseJsonl(readFileSync(path, 'utf8'))
  const turnsWithTools = new Set<string>()
  const noopTurns = new Set<string>()
  const cacheReadById = new Map<string, number>()
  const outputById = new Map<string, number>()
  const toolMix: Record<string, number> = {}
  const seenCallIds = new Set<string>()
  let toolCalls = 0
  let noops = 0
  let anon = 0

  for (const event of events) {
    const message = asRecord(event.message)
    if (!message) continue
    const id =
      typeof message.id === 'string'
        ? message.id
        : typeof event.uuid === 'string'
          ? event.uuid
          : `anon-${anon++}`

    const usage = asRecord(message.usage)
    if (usage) {
      const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      cacheReadById.set(id, cacheRead)
      outputById.set(id, Math.max(outputById.get(id) ?? 0, output))
    }

    const content = message.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const block = asRecord(raw)
      if (!block || block.type !== 'tool_use') continue
      // The transcript repeats a block across streamed lines; count each once.
      const callId = typeof block.id === 'string' ? block.id : `${id}:${toolCalls}`
      if (seenCallIds.has(callId)) continue
      seenCallIds.add(callId)

      const name = typeof block.name === 'string' ? block.name : 'unknown'
      toolMix[name] = (toolMix[name] ?? 0) + 1
      toolCalls++
      turnsWithTools.add(id)
      if (isNoopCall(block)) {
        noops++
        noopTurns.add(id)
      }
    }
  }

  let noopCacheRead = 0
  for (const id of noopTurns) noopCacheRead += cacheReadById.get(id) ?? 0
  let outputTokens = 0
  for (const v of outputById.values()) outputTokens += v

  return {
    toolTurns: turnsWithTools.size,
    toolCalls,
    noops,
    toolMix,
    noopCacheRead,
    outputTokens,
  }
}

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------

type RunResult = Analysis & {
  promptId: string
  arm: 'A' | 'B'
  repIdx: number
  envValue: string
  ok: boolean
  exitCode: number
  errorReason: string
  wallMs: number
  costUsd: number
  turns: number
  sessionId: string
  /** noops per 100 tool turns — the primary metric. */
  noopRate: number
}

function runOnce(
  arm: 'A' | 'B',
  toggle: Toggle,
  prompt: { id: string; text: string },
  repIdx: number,
): RunResult {
  const envValue = arm === 'A' ? toggle.armA : toggle.armB
  process.stdout.write(`  [${arm}] ${toggle.envVar}=${envValue} ${prompt.id} rep#${repIdx + 1} ... `)
  const t0 = performance.now()
  const res = spawnSync(
    'node',
    [
      BUNDLE,
      '-p',
      prompt.text,
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
      '--max-turns',
      String(MAX_TURNS),
      // MCP servers vary by machine and would change the tool registry between
      // arms. The built-in tool set is deliberately NOT narrowed with --tools:
      // the 33 observed events happened with the full registry, and dropping
      // Bash would make the no-op unobservable by construction.
      '--strict-mcp-config',
    ],
    {
      cwd: TARGET_CWD,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        ANTHROPIC_MODEL: MODEL,
        [toggle.envVar]: envValue,
        // Otherwise the second arm replays the first arm's tool results and
        // measures a different exploration than the one it paid for.
        CLAUDIN_DISABLE_TOOL_RESULT_CACHE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''

  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(lastLine) as Record<string, unknown>
  } catch {
    /* not JSON — handled below by the empty sessionId */
  }

  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : ''
  const costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0
  const turns = typeof parsed.num_turns === 'number' ? parsed.num_turns : 0
  const path = sessionId ? transcriptPath(sessionId, TARGET_CWD) : null
  const analysis = path ? analyzeTranscript(path) : EMPTY_ANALYSIS

  // Analyzable, not exit-success: `--max-turns` and a plan-mode run that ends on
  // ExitPlanMode both come back non-success while having produced exactly the
  // exploration this bench measures. Discarding them would drop the data.
  const ok = sessionId !== '' && analysis.toolTurns > 0
  const noopRate = analysis.toolTurns === 0 ? 0 : (analysis.noops / analysis.toolTurns) * 100
  process.stdout.write(
    ok
      ? `OK ${(wallMs / 1000).toFixed(0)}s noops=${analysis.noops}/${analysis.toolTurns} turns\n`
      : `UNUSABLE (exit=${res.status ?? -1})\n`,
  )

  return {
    ...analysis,
    promptId: prompt.id,
    arm,
    repIdx,
    envValue,
    ok,
    exitCode: res.status ?? -1,
    errorReason: ok ? '' : `exit=${res.status ?? -1} stderr=${stderr.slice(0, 300)}`,
    wallMs,
    costUsd,
    turns,
    sessionId,
    noopRate,
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function median(v: number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  // Never round here: an even count averages the two middle values, and
  // rounding sends every fractional metric to zero.
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function range(v: number[]): { min: number; max: number } {
  if (v.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...v), max: Math.max(...v) }
}

/** True when the two min-max ranges do not overlap at all. */
function rangesSeparate(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const ra = range(a)
  const rb = range(b)
  return ra.max < rb.min || rb.max < ra.min
}

type ArmSummary = {
  arm: 'A' | 'B'
  envValue: string
  n: number
  noopsRaw: number[]
  noopTotal: number
  noopRateMedian: number
  noopRateRange: { min: number; max: number }
  costMedian: number
  costRange: { min: number; max: number }
  turnsMedian: number
  toolTurnsMedian: number
  outputMedian: number
  wallMedianS: number
  noopCacheReadTotal: number
}

function summarize(results: RunResult[], arm: 'A' | 'B'): ArmSummary {
  const rs = results.filter(r => r.arm === arm && r.ok)
  const rates = rs.map(r => r.noopRate)
  const costs = rs.map(r => r.costUsd)
  return {
    arm,
    envValue: rs[0]?.envValue ?? '',
    n: rs.length,
    noopsRaw: rs.map(r => r.noops),
    noopTotal: rs.reduce((a, r) => a + r.noops, 0),
    noopRateMedian: median(rates),
    noopRateRange: range(rates),
    costMedian: median(costs),
    costRange: range(costs),
    turnsMedian: median(rs.map(r => r.turns)),
    toolTurnsMedian: median(rs.map(r => r.toolTurns)),
    outputMedian: median(rs.map(r => r.outputTokens)),
    wallMedianS: median(rs.map(r => r.wallMs / 1000)),
    noopCacheReadTotal: rs.reduce((a, r) => a + r.noopCacheRead, 0),
  }
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function verdictFor(a: ArmSummary, b: ArmSummary, rates: { a: number[]; b: number[] }): string {
  if (a.noopTotal === 0 && b.noopTotal === 0) {
    return 'INCONCLUSIVE — zero no-ops in BOTH arms. The base rate is ~5% of tool turns, so this is a bench that did not reproduce the behavior, not a fix. Raise --reps or lengthen the prompts.'
  }
  const separated = rangesSeparate(rates.a, rates.b)
  const drop = a.noopRateMedian === 0 ? 0 : ((a.noopRateMedian - b.noopRateMedian) / a.noopRateMedian) * 100
  const costRegressed = a.costMedian > 0 && b.costMedian > a.costMedian * 1.05
  if (drop >= 50 && separated && !costRegressed) return `SHIP — median rate ${drop.toFixed(0)}% lower in B, ranges separate, cost not regressed`
  if (drop >= 50 && !separated) return `INCONCLUSIVE — median rate ${drop.toFixed(0)}% lower in B but the min-max ranges OVERLAP; the bar is separation, not medians`
  if (costRegressed) return `REJECT — cost regressed in B (${b.costMedian.toFixed(4)} vs ${a.costMedian.toFixed(4)})`
  return `NULL — median rate moved ${drop.toFixed(0)}% (bar is -50% with separated ranges)`
}

function main(): void {
  const argv = process.argv.slice(2)
  const toggleArg = (argv.find(a => a.startsWith('--toggle='))?.split('=')[1] ?? 'anti-narration') as ToggleId
  const toggle = TOGGLES[toggleArg]
  if (!toggle) {
    console.error(`unknown --toggle=${toggleArg} (expected: ${Object.keys(TOGGLES).join(' | ')})`)
    process.exit(1)
  }
  const reps = Number(argv.find(a => a.startsWith('--reps='))?.split('=')[1] ?? RUNS_PER_PROMPT)
  const dryRun = argv.includes('--dry-run')

  if (!existsSync(TARGET_CWD)) {
    console.error(`target cwd not found: ${TARGET_CWD} (set CLAUDIN_BENCH_TARGET_CWD)`)
    process.exit(1)
  }
  const gate = assertBundleHonorsToggle(toggle)

  console.log(`plan-noop-narration-ab — toggle=${toggleArg}`)
  console.log(`  ${toggle.describe}`)
  console.log(`  bundle:     ${BUNDLE} (generation ${gate.generation})`)
  console.log(`  call site:  ${gate.chunk.replace(REPO_ROOT + '/', '')}`)
  console.log(`  model:      ${MODEL}`)
  console.log(`  target cwd: ${TARGET_CWD}`)
  console.log(`  plan:       ${PROMPTS.length} prompts x ${reps} reps x 2 arms = ${PROMPTS.length * reps * 2} runs`)
  console.log('')
  if (dryRun) {
    for (const p of PROMPTS) console.log(`  · ${p.id}: ${p.text}`)
    console.log('\n--dry-run: gates passed, nothing spent.')
    return
  }

  const results: RunResult[] = []
  for (let repIdx = 0; repIdx < reps; repIdx++) {
    for (const prompt of PROMPTS) {
      // Alternate the order between reps: a fixed A-then-B lets any drift over
      // the session (rate limits, cache warmth) land entirely on one arm.
      const order: ('A' | 'B')[] = repIdx % 2 === 0 ? ['A', 'B'] : ['B', 'A']
      for (const arm of order) results.push(runOnce(arm, toggle, prompt, repIdx))
    }
  }

  const a = summarize(results, 'A')
  const b = summarize(results, 'B')
  const rates = {
    a: results.filter(r => r.arm === 'A' && r.ok).map(r => r.noopRate),
    b: results.filter(r => r.arm === 'B' && r.ok).map(r => r.noopRate),
  }
  const verdict = verdictFor(a, b, rates)

  console.log('')
  console.log(`arm A (${toggle.envVar}=${toggle.armA})  n=${a.n}`)
  console.log(`  no-ops per run (raw): [${a.noopsRaw.join(', ')}]  total ${a.noopTotal}`)
  console.log(`  no-ops/100 tool turns: median ${a.noopRateMedian.toFixed(2)}  range ${a.noopRateRange.min.toFixed(2)}–${a.noopRateRange.max.toFixed(2)}`)
  console.log(`  cost $${a.costMedian.toFixed(4)} (range ${a.costRange.min.toFixed(4)}–${a.costRange.max.toFixed(4)})  turns ${a.turnsMedian}  toolTurns ${a.toolTurnsMedian}  out ${fmt(a.outputMedian)}  wall ${a.wallMedianS.toFixed(0)}s`)
  console.log(`  cache-read burned on no-op turns: ${fmt(a.noopCacheReadTotal)}`)
  console.log('')
  console.log(`arm B (${toggle.envVar}=${toggle.armB})  n=${b.n}`)
  console.log(`  no-ops per run (raw): [${b.noopsRaw.join(', ')}]  total ${b.noopTotal}`)
  console.log(`  no-ops/100 tool turns: median ${b.noopRateMedian.toFixed(2)}  range ${b.noopRateRange.min.toFixed(2)}–${b.noopRateRange.max.toFixed(2)}`)
  console.log(`  cost $${b.costMedian.toFixed(4)} (range ${b.costRange.min.toFixed(4)}–${b.costRange.max.toFixed(4)})  turns ${b.turnsMedian}  toolTurns ${b.toolTurnsMedian}  out ${fmt(b.outputMedian)}  wall ${b.wallMedianS.toFixed(0)}s`)
  console.log(`  cache-read burned on no-op turns: ${fmt(b.noopCacheReadTotal)}`)
  console.log('')
  console.log(`ranges separate: ${rangesSeparate(rates.a, rates.b) ? 'YES' : 'no'}`)
  console.log(`verdict: ${verdict}`)

  const unusable = results.filter(r => !r.ok)
  if (unusable.length > 0) {
    console.log(`\n${unusable.length}/${results.length} runs unusable:`)
    for (const r of unusable.slice(0, 6)) console.log(`  · ${r.arm}/${r.promptId}#${r.repIdx + 1}: ${r.errorReason.slice(0, 160)}`)
  }

  writeFileSync(
    OUT_PATH,
    `${JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        toggle: toggleArg,
        envVar: toggle.envVar,
        describe: toggle.describe,
        model: MODEL,
        targetCwd: TARGET_CWD,
        bundleGeneration: gate.generation,
        reps,
        prompts: PROMPTS.map(p => p.id),
        armA: a,
        armB: b,
        rangesSeparate: rangesSeparate(rates.a, rates.b),
        verdict,
        runs: results,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`\nresults: ${OUT_PATH.replace(REPO_ROOT + '/', '')}`)
}

main()
